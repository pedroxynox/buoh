import { describe, expect, it } from 'vitest';

import {
  BATCH_CANDLES_SEQUENCE,
  BATCH_QUOTES_SEQUENCE,
  BATCH_SCHEDULES_SEQUENCE,
  BATCH_SEQUENCES,
  findActiveLog,
  firstWriteOf,
  GOLD_SEQUENCE,
  HISTORY_GOLD_SEQUENCE,
  HISTORY_R_100_SEQUENCE,
  HISTORY_SEQUENCES,
  isLogExpired,
  isLogPrefix,
  listCaptureLogs,
  liveSequenceOf,
  loadConfig,
  LOG_RETENTION_MS,
  LIVE_SEQUENCES,
  LOG_SEQUENCES,
  logLocation,
  logNumberOf,
  logOfSchema,
  logSchemaPattern,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  R_100_SEQUENCE,
  ROUND_BATCH_SEQUENCES,
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

/** El log `number`, legible, con su última escritura o sin ninguna. */
const log = (number: number, lastWriteUtc: string | null = null): CaptureLog => ({
  lastWriteUtc,
  location: logLocation(number),
  readable: true,
});

/** El log `number` mientras se prepara: sin las tablas o sin los privilegios del rol. */
const unreadable = (number: number): CaptureLog => ({
  lastWriteUtc: null,
  location: logLocation(number),
  readable: false,
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

describe('las secuencias de logs (ADR-0021 §1)', () => {
  it('R_100 conserva sus nombres: buoh_log_<n> y logs/<n>/, también sin nombrar la secuencia', () => {
    expect(R_100_SEQUENCE.name).toBe('R_100');
    expect(logLocation(7, R_100_SEQUENCE)).toEqual(logLocation(7));
    expect(logLocation(7, R_100_SEQUENCE)).toEqual({
      number: 7,
      prefix: 'logs/000007/',
      schema: 'buoh_log_000007',
    });
    expect(logNumberOf('buoh_log_000007', R_100_SEQUENCE)).toBe(7);
    expect(liveSequenceOf('R_100')).toBe(R_100_SEQUENCE);
  });

  it('el oro lleva su nombre en minúsculas en el esquema y en el prefijo, bajo logs/', () => {
    expect(GOLD_SEQUENCE.name).toBe('frxXAUUSD');
    expect(logLocation(1, GOLD_SEQUENCE)).toEqual({
      number: 1,
      prefix: 'logs/frxxauusd/000001/',
      schema: 'buoh_frxxauusd_log_000001',
    });
    expect(logNumberOf('buoh_frxxauusd_log_000001', GOLD_SEQUENCE)).toBe(1);
    expect(liveSequenceOf('frxXAUUSD')).toBe(GOLD_SEQUENCE);
  });

  it('las secuencias por lotes (precisión del PR 5b de ADR-0021 §9): su nombre en el esquema y en el prefijo, bajo logs/, y ninguna es la de un símbolo', () => {
    expect(BATCH_SEQUENCES.map((sequence) => logLocation(1, sequence))).toEqual([
      {
        number: 1,
        prefix: 'logs/lotes_horarios/000001/',
        schema: 'buoh_lotes_horarios_log_000001',
      },
      {
        number: 1,
        prefix: 'logs/lotes_cotizaciones/000001/',
        schema: 'buoh_lotes_cotizaciones_log_000001',
      },
      { number: 1, prefix: 'logs/lotes_velas/000001/', schema: 'buoh_lotes_velas_log_000001' },
      {
        number: 1,
        prefix: 'logs/lotes_historia_r_100/000001/',
        schema: 'buoh_lotes_historia_r_100_log_000001',
      },
      {
        number: 1,
        prefix: 'logs/lotes_historia_frxxauusd/000001/',
        schema: 'buoh_lotes_historia_frxxauusd_log_000001',
      },
    ]);
    expect(BATCH_SEQUENCES).toEqual([
      BATCH_SCHEDULES_SEQUENCE,
      BATCH_QUOTES_SEQUENCE,
      BATCH_CANDLES_SEQUENCE,
      HISTORY_R_100_SEQUENCE,
      HISTORY_GOLD_SEQUENCE,
    ]);
    // Las historias (precisión del PR 6c) no van por vueltas: las demás, sí.
    expect(HISTORY_SEQUENCES).toEqual([HISTORY_R_100_SEQUENCE, HISTORY_GOLD_SEQUENCE]);
    expect(ROUND_BATCH_SEQUENCES).toEqual([
      BATCH_SCHEDULES_SEQUENCE,
      BATCH_QUOTES_SEQUENCE,
      BATCH_CANDLES_SEQUENCE,
    ]);
    expect(LIVE_SEQUENCES).toEqual([R_100_SEQUENCE, GOLD_SEQUENCE]);
    // Las dos listas reparten la tabla entera, en su orden.
    expect([...LIVE_SEQUENCES, ...BATCH_SEQUENCES]).toEqual(LOG_SEQUENCES);
    for (const sequence of BATCH_SEQUENCES) {
      expect(sequence.kind).toBe('batch');
      expect(liveSequenceOf(sequence.name)).toBeNull();
      // El nombre que guarda buoh_datasets en cada rango (`dataset_log_ranges.sequence`).
      expect(sequence.name).toMatch(/^[A-Za-z0-9_]{1,64}$/u);
      expect(logOfSchema(logLocation(3, sequence).schema)).toEqual({ number: 3, sequence });
    }
  });

  it('un esquema de una secuencia nunca es un log de otra', () => {
    for (const sequence of LOG_SEQUENCES) {
      for (const other of LOG_SEQUENCES) {
        if (other === sequence) continue;
        for (const number of [1, 42, MAX_LOG_NUMBER]) {
          expect(logNumberOf(logLocation(number, sequence).schema, other)).toBeNull();
        }
      }
    }
    expect(logNumberOf('buoh_log_000001', GOLD_SEQUENCE)).toBeNull();
    expect(logNumberOf('buoh_frxxauusd_log_000001')).toBeNull();
  });

  it('ninguna comparte nombre, esquema ni prefijo, y ningún prefijo de un log cae dentro del de otro', () => {
    const names = LOG_SEQUENCES.map((sequence) => sequence.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    const prefixes = LOG_SEQUENCES.flatMap((sequence) =>
      [1, 2, MAX_LOG_NUMBER].map((number) => logLocation(number, sequence).prefix),
    );
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      expect(prefix).toMatch(/^logs\/(?:[a-z0-9_]+\/)?[0-9]{6}\/$/u);
      for (const other of prefixes) {
        if (other !== prefix) expect(other.startsWith(prefix)).toBe(false);
      }
    }
    const schemas = LOG_SEQUENCES.map((sequence) => logLocation(1, sequence).schema);
    expect(new Set(schemas).size).toBe(schemas.length);
    for (const schema of schemas) {
      expect(schema).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
    }
  });

  it('una secuencia que no está en la tabla no da nombres ni lee logs', async () => {
    const outside = {
      kind: 'live',
      name: 'X',
      prefixStem: 'logs/x/',
      schemaStem: 'buoh_x_log_',
    } as const;
    expect(() => logLocation(1, outside)).toThrow(TypeError);
    expect(() => logNumberOf('buoh_x_log_000001', outside)).toThrow(TypeError);
    const { pool } = fakePool(() => ({ rows: [] }));
    await expect(listCaptureLogs(pool, 'deriv_options', outside)).rejects.toThrow(TypeError);
  });

  it('un símbolo sin secuencia no tiene ninguna, tampoco en otras mayúsculas', () => {
    for (const symbol of ['r_100', 'FRXXAUUSD', 'frxxauusd', 'SYNTH_100', '']) {
      expect(liveSequenceOf(symbol)).toBeNull();
    }
  });

  it('logOfSchema da el log y la secuencia de un esquema de cualquiera, y logSchemaPattern el patrón de cada una (precisión del PR 2b)', () => {
    expect(logOfSchema('buoh_log_000007')).toEqual({ number: 7, sequence: R_100_SEQUENCE });
    expect(logOfSchema('buoh_frxxauusd_log_000002')).toEqual({
      number: 2,
      sequence: GOLD_SEQUENCE,
    });
    for (const schema of ['buoh_log_000000', 'buoh_log_1', 'buoh_x_log_000001', 'public']) {
      expect(logOfSchema(schema)).toBeNull();
    }
    expect(logSchemaPattern(R_100_SEQUENCE)).toBe('^buoh_log_[0-9]{6}$');
    expect(logSchemaPattern(GOLD_SEQUENCE)).toBe('^buoh_frxxauusd_log_[0-9]{6}$');
  });

  it('isLogPrefix: el prefijo de un log de cualquier secuencia, y nada más', () => {
    for (const sequence of LOG_SEQUENCES) {
      for (const number of [1, 42, MAX_LOG_NUMBER]) {
        expect(isLogPrefix(logLocation(number, sequence).prefix)).toBe(true);
      }
    }
    for (const prefix of [
      '',
      'logs/',
      'logs/frxxauusd/',
      'logs/frxxauusd/1/',
      'logs/frxXAUUSD/000001/',
      'logs/otra/000001/',
      'logs/000001',
      'logs/000001/sha256/',
      'datasets/000001/',
    ]) {
      expect(isLogPrefix(prefix)).toBe(false);
    }
  });

  it('el log activo conserva la secuencia de sus logs', () => {
    const gold = (number: number, lastWriteUtc: string | null = null): CaptureLog => ({
      lastWriteUtc,
      location: logLocation(number, GOLD_SEQUENCE),
      readable: true,
    });
    expect(selectActiveLog([gold(1, before(DAY)), gold(2, before(1000))], NOW)).toEqual(
      logLocation(2, GOLD_SEQUENCE),
    );
    expect(selectActiveLog([gold(3), gold(2)], NOW)).toEqual(logLocation(2, GOLD_SEQUENCE));
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

  it('un log que todavía se prepara, sin tablas o sin privilegios, no es el preparado: sin otro, no hay log activo', () => {
    expect(selectActiveLog([unreadable(1)], NOW)).toBeNull();
    expect(selectActiveLog([log(1, before(31 * DAY)), unreadable(2)], NOW)).toBeNull();
    expect(selectActiveLog([unreadable(2), log(3)], NOW)?.number).toBe(3);
    // Con un log escrito, el que se prepara detrás no cambia nada.
    expect(selectActiveLog([log(1, before(DAY)), unreadable(2)], NOW)?.number).toBe(1);
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
      { lastWriteUtc: '2026-03-01T10:00:15.000Z', location: logLocation(1), readable: true },
      { lastWriteUtc: '2026-03-08T10:00:20.000Z', location: logLocation(2), readable: true },
      { lastWriteUtc: null, location: logLocation(3), readable: true },
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

  it('lee solo los logs de su secuencia: el oro, con su propio patrón de esquema', async () => {
    const { pool, queries } = fakePool((text) =>
      text.includes('pg_namespace')
        ? {
            rows: ['buoh_frxxauusd_log_000002', 'buoh_log_000001', 'buoh_frxxauusd_log_000001'].map(
              (name) => ({ name }),
            ),
          }
        : { rows: [{ event: null, heartbeat: null }] },
    );
    expect(await listCaptureLogs(pool, 'deriv_options', GOLD_SEQUENCE)).toEqual([
      { lastWriteUtc: null, location: logLocation(1, GOLD_SEQUENCE), readable: true },
      { lastWriteUtc: null, location: logLocation(2, GOLD_SEQUENCE), readable: true },
    ]);
    expect(queries[0]?.values).toEqual(['^buoh_frxxauusd_log_[0-9]{6}$']);
    expect(queries[1]?.text).toContain('FROM buoh_frxxauusd_log_000001.source_event_index');
    const r100 = fakePool((text) =>
      text.includes('pg_namespace') ? { rows: [] } : { rows: [{ event: null, heartbeat: null }] },
    );
    await listCaptureLogs(r100.pool, 'deriv_options');
    expect(r100.queries[0]?.values).toEqual(['^buoh_log_[0-9]{6}$']);
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

  it('un esquema sin tablas (42P01) o que el rol todavía no puede leer (42501) es un log no legible, sin escrituras; otro error rechaza la lectura', async () => {
    for (const code of ['42P01', '42501']) {
      const { pool } = fakePool((text) =>
        text.includes('pg_namespace') ? { rows: [{ name: 'buoh_log_000004' }] } : coded(code),
      );
      expect(await listCaptureLogs(pool, 'deriv_options')).toEqual([
        { lastWriteUtc: null, location: logLocation(4), readable: false },
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

describe('firstWriteOf (ADR-0018 §6, «Hora de corte»)', () => {
  it('la escritura más temprana de la fuente en el log: el primer evento por su posición o el primer latido por su orden de escritura', async () => {
    const { pool, queries } = fakePool(() => ({
      rows: [{ event: '2026-11-01T00:06:06.704Z', heartbeat: '2026-11-01T00:06:06.087Z' }],
    }));
    expect(await firstWriteOf(pool, logLocation(1), 'deriv_options')).toBe(
      '2026-11-01T00:06:06.087Z',
    );
    const [query] = queries;
    expect(query?.values).toEqual(['deriv_options']);
    expect(query?.text).toContain('FROM buoh_log_000001.source_event_index WHERE source = $1');
    expect(query?.text).toContain('ORDER BY segment_index, position LIMIT 1');
    expect(query?.text).toContain('FROM buoh_log_000001.ingestion_heartbeats WHERE source = $1');
    expect(query?.text).toContain('ORDER BY write_order LIMIT 1');

    const eventFirst = fakePool(() => ({
      rows: [{ event: '2026-03-02T10:00:00.000Z', heartbeat: '2026-03-02T10:00:00.500Z' }],
    }));
    expect(await firstWriteOf(eventFirst.pool, logLocation(2), 'deriv_options')).toBe(
      '2026-03-02T10:00:00.000Z',
    );
  });

  it('con solo eventos o solo latidos, esa; sin ninguno, null; y rechaza si el log no se puede leer', async () => {
    const onlyHeartbeat = fakePool(() => ({
      rows: [{ event: null, heartbeat: '2026-03-02T10:00:00.000Z' }],
    }));
    expect(await firstWriteOf(onlyHeartbeat.pool, logLocation(1), 'deriv_options')).toBe(
      '2026-03-02T10:00:00.000Z',
    );
    const onlyEvent = fakePool(() => ({
      rows: [{ event: '2026-03-02T10:00:01.000Z', heartbeat: null }],
    }));
    expect(await firstWriteOf(onlyEvent.pool, logLocation(1), 'deriv_options')).toBe(
      '2026-03-02T10:00:01.000Z',
    );
    const empty = fakePool(() => ({ rows: [{ event: null, heartbeat: null }] }));
    expect(await firstWriteOf(empty.pool, logLocation(1), 'deriv_options')).toBeNull();
    const failing = fakePool(() => coded('42P01'));
    await expect(firstWriteOf(failing.pool, logLocation(1), 'deriv_options')).rejects.toMatchObject(
      { code: '42P01' },
    );
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
