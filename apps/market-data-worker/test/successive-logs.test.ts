import { describe, expect, it } from 'vitest';

import {
  findActiveLog,
  isLogExpired,
  listCaptureLogs,
  loadConfig,
  LOG_RETENTION_MS,
  logLocation,
  logNumberOf,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  selectActiveLog,
  withLog,
  type CaptureLog,
} from '../src/index.js';

// Los logs sucesivos de producción (ADR-0018 §6 y §7) sin PostgreSQL: los nombres, la regla del
// log activo y la retención con vectores sacados de la ADR, y la lectura con un pool falso. La
// lectura contra PostgreSQL está en integration/successive-logs.test.ts.

const NOW = '2026-04-01T00:00:00.000Z';
/** Una hora `ms` milisegundos antes de `NOW`. */
const before = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** El log `number`, con su última escritura o sin ninguna. */
const log = (number: number, lastWriteUtc: string | null = null): CaptureLog => ({
  lastWriteUtc,
  location: logLocation(number),
});

describe('logLocation y logNumberOf (ADR-0018 §6, «Nombres»)', () => {
  it('el log n tiene el esquema buoh_log_<n> y el prefijo logs/<n>/, con n en seis cifras', () => {
    expect(logLocation(1)).toEqual({
      number: 1,
      prefix: 'logs/000001/',
      schema: 'buoh_log_000001',
    });
    expect(logLocation(42)).toEqual({
      number: 42,
      prefix: 'logs/000042/',
      schema: 'buoh_log_000042',
    });
    expect(logLocation(MAX_LOG_NUMBER)).toEqual({
      number: 999_999,
      prefix: 'logs/999999/',
      schema: 'buoh_log_999999',
    });
  });

  it('rechaza un número que no es un entero de 1 a 999 999', () => {
    for (const number of [0, -1, 1.5, MAX_LOG_NUMBER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => logLocation(number)).toThrow(TypeError);
    }
  });

  it('da el número de un esquema de log, y null con cualquier otro nombre', () => {
    expect(logNumberOf('buoh_log_000001')).toBe(1);
    expect(logNumberOf('buoh_log_999999')).toBe(999_999);
    for (const name of [
      'buoh_log_000000',
      'buoh_log_1',
      'buoh_log_0000001',
      'buoh_log_00000a',
      'xbuoh_log_000001',
      'buoh_log_000001x',
      'BUOH_LOG_000001',
      'buoh_logs_000001',
      'public',
    ]) {
      expect(logNumberOf(name)).toBeNull();
    }
  });
});

describe('isLogExpired (ADR-0018 §7)', () => {
  it('un log vence cuando su última escritura tiene 30 días o más; uno sin escrituras nunca vence', () => {
    expect(LOG_RETENTION_MS).toBe(30 * DAY);
    expect(isLogExpired(log(1, before(30 * DAY)), NOW)).toBe(true);
    expect(isLogExpired(log(1, before(45 * DAY)), NOW)).toBe(true);
    expect(isLogExpired(log(1, before(30 * DAY - 1)), NOW)).toBe(false);
    expect(isLogExpired(log(1, before(0)), NOW)).toBe(false);
    // Con el reloj por detrás de la escritura, no vence.
    expect(isLogExpired(log(1, '2026-04-02T00:00:00.000Z'), NOW)).toBe(false);
    expect(isLogExpired(log(1), NOW)).toBe(false);
  });
});

describe('selectActiveLog (ADR-0018 §6, «Log activo»)', () => {
  it('sin logs, o solo con vencidos, no hay log activo', () => {
    expect(selectActiveLog([], NOW)).toBeNull();
    expect(selectActiveLog([log(1, before(31 * DAY))], NOW)).toBeNull();
  });

  it('el de mayor número con alguna escritura, sin contar los vencidos', () => {
    expect(selectActiveLog([log(1, before(DAY)), log(2)], NOW)?.number).toBe(1);
    expect(
      selectActiveLog([log(1, before(8 * DAY)), log(2, before(DAY)), log(3)], NOW)?.number,
    ).toBe(2);
    expect(
      selectActiveLog([log(1, before(40 * DAY)), log(2, before(DAY)), log(3)], NOW)?.number,
    ).toBe(2);
  });

  it('si ninguno sin vencer tiene escrituras, el preparado de menor número: también el log 1, y el siguiente de una captura detenida', () => {
    expect(selectActiveLog([log(1)], NOW)?.number).toBe(1);
    expect(selectActiveLog([log(3), log(2)], NOW)?.number).toBe(2);
    expect(selectActiveLog([log(1, before(30 * DAY)), log(2)], NOW)?.number).toBe(2);
  });

  it('el límite de 30 días decide entre el log escrito y el preparado', () => {
    expect(selectActiveLog([log(1, before(30 * DAY - 1)), log(2)], NOW)?.number).toBe(1);
    expect(selectActiveLog([log(1, before(30 * DAY)), log(2)], NOW)?.number).toBe(2);
  });

  it('no depende del orden de la lista y da el esquema y el prefijo del log', () => {
    expect(selectActiveLog([log(3), log(2, before(DAY)), log(1, before(9 * DAY))], NOW)).toEqual(
      logLocation(2),
    );
  });
});

/** Un pool falso que responde a cada consulta con `answer` y anota su texto y sus valores. */
function fakePool(answer: (text: string) => unknown) {
  const queries: { text: string; values: unknown }[] = [];
  return {
    pool: {
      query: (text: string, values?: unknown) => {
        queries.push({ text, values });
        const result = answer(text);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    } as never,
    queries,
  };
}

const coded = (code: string) => Object.assign(new Error(`error sintético ${code}`), { code });

describe('listCaptureLogs (ADR-0018 §6)', () => {
  it('lee los esquemas de log de pg_namespace, en orden, y de cada uno la escritura más tardía de la fuente: el último evento o el último latido', async () => {
    const { pool, queries } = fakePool((text) => {
      if (text.includes('pg_namespace')) {
        return {
          rows: ['buoh_log_000002', 'buoh_log_000000', 'buoh_log_000001', 'buoh_log_000003'].map(
            (name) => ({ name }),
          ),
        };
      }
      if (text.includes('buoh_log_000001.')) {
        return {
          rows: [{ event: '2026-03-01T10:00:00.000Z', heartbeat: '2026-03-01T10:00:15.000Z' }],
        };
      }
      if (text.includes('buoh_log_000002.')) {
        return {
          rows: [{ event: '2026-03-08T10:00:20.000Z', heartbeat: '2026-03-08T10:00:15.000Z' }],
        };
      }
      return { rows: [{ event: null, heartbeat: null }] };
    });
    expect(await listCaptureLogs(pool, 'deriv_options')).toEqual([
      { lastWriteUtc: '2026-03-01T10:00:15.000Z', location: logLocation(1) },
      { lastWriteUtc: '2026-03-08T10:00:20.000Z', location: logLocation(2) },
      { lastWriteUtc: null, location: logLocation(3) },
    ]);
    const reads = queries.slice(1);
    expect(reads.map((query) => query.values)).toEqual([
      ['deriv_options'],
      ['deriv_options'],
      ['deriv_options'],
    ]);
    for (const [index, query] of reads.entries()) {
      const schema = logLocation(index + 1).schema;
      expect(query.text).toContain(`FROM ${schema}.source_event_index WHERE source = $1`);
      expect(query.text).toContain(`FROM ${schema}.ingestion_heartbeats WHERE source = $1`);
      expect(query.text).toContain('ORDER BY segment_index DESC, position DESC LIMIT 1');
      expect(query.text).toContain('ORDER BY write_order DESC LIMIT 1');
    }
  });

  it('con solo eventos o solo latidos, esa es la última escritura', async () => {
    const { pool } = fakePool((text) =>
      text.includes('pg_namespace')
        ? { rows: [{ name: 'buoh_log_000001' }, { name: 'buoh_log_000002' }] }
        : text.includes('buoh_log_000001.')
          ? { rows: [{ event: '2026-03-01T10:00:00.000Z', heartbeat: null }] }
          : { rows: [{ event: null, heartbeat: '2026-03-02T10:00:00.000Z' }] },
    );
    expect((await listCaptureLogs(pool, 'deriv_options')).map((item) => item.lastWriteUtc)).toEqual(
      ['2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z'],
    );
  });

  it('un esquema sin tablas (42P01) o que el rol todavía no puede leer (42501) es un log sin escrituras; otro error rechaza la lectura', async () => {
    for (const code of ['42P01', '42501']) {
      const { pool } = fakePool((text) =>
        text.includes('pg_namespace') ? { rows: [{ name: 'buoh_log_000004' }] } : coded(code),
      );
      expect(await listCaptureLogs(pool, 'deriv_options')).toEqual([
        { lastWriteUtc: null, location: logLocation(4) },
      ]);
    }
    for (const code of ['ECONNREFUSED', '57P01']) {
      const { pool } = fakePool((text) =>
        text.includes('pg_namespace') ? { rows: [{ name: 'buoh_log_000004' }] } : coded(code),
      );
      await expect(listCaptureLogs(pool, 'deriv_options')).rejects.toMatchObject({ code });
    }
  });

  it('findActiveLog lee los logs y después toma la hora', async () => {
    const order: string[] = [];
    const { pool } = fakePool((text) => {
      order.push(text.includes('pg_namespace') ? 'namespaces' : 'log');
      return text.includes('pg_namespace')
        ? { rows: [{ name: 'buoh_log_000001' }, { name: 'buoh_log_000002' }] }
        : text.includes('buoh_log_000001.')
          ? { rows: [{ event: before(30 * DAY), heartbeat: null }] }
          : { rows: [{ event: null, heartbeat: null }] };
    });
    const log = await findActiveLog(pool, {
      now: () => {
        order.push('now');
        return NOW;
      },
      source: 'deriv_options',
    });
    expect(log).toEqual(logLocation(2));
    expect(order).toEqual(['namespaces', 'log', 'log', 'now']);
  });
});

describe('withLog y productionLogConfigErrors', () => {
  const config = loadConfig({
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
    BUOH_POSTGRES_SSLMODE: 'require',
    BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
    BUOH_S3_BUCKET: 'buoh-captura',
    BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
  });

  it('la configuración de un log lleva su esquema y el prefijo de sus objetos, y nada más cambia', () => {
    expect(config.s3.keyPrefix).toBe('');
    const located = withLog(config, logLocation(7));
    expect(located.postgres.schema).toBe('buoh_log_000007');
    expect(located.s3.keyPrefix).toBe('logs/000007/');
    expect({
      ...located,
      postgres: { ...located.postgres, schema: config.postgres.schema },
      s3: { ...located.s3, keyPrefix: '' },
    }).toEqual(config);
  });

  it('en production, un comando sobre el log activo no admite BUOH_POSTGRES_SCHEMA', () => {
    expect(productionLogConfigErrors({})).toEqual([]);
    expect(productionLogConfigErrors({ BUOH_POSTGRES_SCHEMA: 'buoh_log_000001' })).toEqual([
      'BUOH_POSTGRES_SCHEMA',
    ]);
  });
});
