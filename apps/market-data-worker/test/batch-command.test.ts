import type { SourceEvent } from '@buoh/contracts';
import { BATCH_SEGMENT_POLICY } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import { BATCH_DEADLINE_MS, BATCH_PACING_MS, batchCommand } from '../src/batch/command.js';
import { derivBatchLogProfileRow } from '../src/deriv/batch-profile.js';
import { batchProfileKindOf } from '../src/deriv/batch-rounds.js';
import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { DERIV_BATCH_OPERATIONS } from '../src/deriv/schema-release.js';
import {
  BATCH_CANDLES_SEQUENCE,
  BATCH_QUOTES_SEQUENCE,
  BATCH_SCHEDULES_SEQUENCE,
  logLocation,
  MAX_LOG_NUMBER,
  SourceEventLog,
  type LogLocation,
  type LogSequence,
} from '../src/index.js';
import type { LogReadiness } from '../src/log-cut.js';
import { answer, AnsweringSocket, BATCH_FIXTURE, type Respond } from './support/batch-fixtures.js';
import { uuid } from './support/connection-harness.js';
import { catalogEntry, ManualClock, syntheticSchemaArchive } from './support/deriv-fixtures.js';
import { MemoryObjectStore, MemorySourceLogStore } from './support/memory-stores.js';

// El comando de los lotes (ADR-0021 §3; precisión del PR 5c1 de su §9) sin servicios: los almacenes
// en memoria, un socket que responde solo y un reloj manual. Los vectores salen de §3: lo que toca a
// cada secuencia, raw primero, la política de segmentos 2.0.0, el corte al empezar, el perfil del log,
// el bloqueo y el límite de peticiones que para el paso. La prueba contra PostgreSQL y el
// almacenamiento, con `buoh_lotes`, está en integration/operations.test.ts.

const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_DB: 'buoh',
  BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
  BUOH_POSTGRES_PASSWORD: 'lotes-sintetica-0123456789',
  BUOH_POSTGRES_PORT: '5432',
  BUOH_POSTGRES_SSLMODE: 'require',
  BUOH_POSTGRES_USER: 'buoh_lotes',
  BUOH_S3_ACCESS_KEY_ID: 'clave-lotes-sintetica',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
  BUOH_S3_REGION: 'auto',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-lotes-sintetico',
};

interface LogState {
  /** El número del log activo; por defecto, 1. */
  active: number;
  first: string | null;
  nextReadiness: LogReadiness;
  pending: readonly string[];
  profile: { profile_id: string; quality_profile_sha256: string } | null;
}

/** Los logs, los almacenes y el bloqueo de cada secuencia, en memoria. */
function world(
  options: {
    readonly busy?: readonly LogSequence[];
    /** Las secuencias cuyo bloqueo no responde, o cuyo log no se abre. */
    readonly broken?: Partial<Record<string, 'lock' | 'open' | 'reads'>>;
    /** Lo que salta el reloj de pared cuando se abre un log, como una apertura lenta. */
    readonly jumpOnOpenMs?: number;
    /** El socket de cada conexión; por defecto, `AnsweringSocket`. */
    readonly socket?: typeof AnsweringSocket;
    readonly fixture?: typeof BATCH_FIXTURE;
    readonly logs?: Partial<Record<string, Partial<LogState> | null>>;
    readonly respond?: Respond;
    readonly start?: string;
  } = {},
) {
  const stores = new Map<string, { objects: MemoryObjectStore; store: MemorySourceLogStore }>();
  const storesOf = (log: LogLocation) => {
    let found = stores.get(log.schema);
    if (found === undefined) {
      found = { objects: new MemoryObjectStore(), store: new MemorySourceLogStore() };
      stores.set(log.schema, found);
    }
    return found;
  };
  const sockets: AnsweringSocket[] = [];
  const index = { value: 0 };
  const released: string[] = [];
  const stateOf = (sequence: LogSequence): LogState | null => {
    const given = options.logs?.[sequence.name];
    if (given === null) {
      return null;
    }
    return {
      active: 1,
      first: null,
      nextReadiness: 'not_prepared',
      pending: [],
      profile: derivBatchLogProfileRow(batchProfileKindOf(sequence)),
      ...given,
    };
  };
  let id = 0;
  const clock = new ManualClock(options.start ?? '2026-11-26T00:01:00.000Z');
  const deps: Parameters<typeof batchCommand>[2] = {
    acquireLock: (_config, sequence) =>
      options.broken?.[sequence.name] === 'lock'
        ? Promise.reject(Object.assign(new Error('secreto'), { code: 'ECONNREFUSED' }))
        : Promise.resolve(
            options.busy?.includes(sequence) === true
              ? null
              : {
                  held: true,
                  release: () => {
                    released.push(sequence.name);
                    return Promise.resolve();
                  },
                },
          ),
    connect: (input) => {
      const Socket = options.socket ?? AnsweringSocket;
      const socket = new Socket(input, options.respond ?? answer, index);
      sockets.push(socket);
      return socket;
    },
    expected: (options.fixture ?? BATCH_FIXTURE).expected,
    fetch: () =>
      Promise.resolve(new Response((options.fixture ?? BATCH_FIXTURE).archive, { status: 200 })),
    nextId: () => uuid((id += 1)),
    now: clock.now,
    openLog: async (_config, _lock, log) => {
      if (options.jumpOnOpenMs !== undefined) {
        clock.jumpWallClock(options.jumpOnOpenMs);
      }
      if (
        Object.entries(options.broken ?? {}).some(
          ([name, what]) => what === 'open' && log.schema.includes(name),
        )
      ) {
        throw Object.assign(new Error('secreto'), { name: 'LogIntegrityError' });
      }
      const { objects, store } = storesOf(log);
      return {
        close: () => Promise.resolve(),
        log: await SourceEventLog.open({
          objects,
          policy: BATCH_SEGMENT_POLICY,
          source: DERIV_SOURCE,
          store,
          zlibVersion: process.versions.zlib,
        }),
      };
    },
    openReads: (_config, sequence) => {
      const state = stateOf(sequence);
      return {
        close: () => Promise.resolve(),
        firstWrite: () => Promise.resolve(state?.first ?? null),
        locateLog: () =>
          options.broken?.[sequence.name] === 'reads'
            ? Promise.reject(Object.assign(new Error('secreto'), { code: '57P01' }))
            : Promise.resolve(state === null ? null : logLocation(state.active, sequence)),
        logProfile: () => Promise.resolve(state?.profile ?? null),
        pendingMigrations: () => Promise.resolve(state?.pending ?? []),
        readiness: () => Promise.resolve(state?.nextReadiness ?? 'not_prepared'),
      };
    },
    scheduler: clock.scheduler,
  };
  /** Corre el comando hasta que termina, avanzando el reloj medio segundo cada vez. */
  const run = async (argv: readonly string[] = ['--json'], env: Record<string, string> = ENV) => {
    const done = { value: false };
    const result = batchCommand(argv, env, deps).finally(() => {
      done.value = true;
    });
    for (let step = 0; step < 1_000 && !done.value; step += 1) {
      await clock.advance(500);
    }
    const settled = await result;
    return {
      ...settled,
      line:
        settled.stdout === null ? null : (JSON.parse(settled.stdout) as Record<string, unknown>),
    };
  };
  return { clock, deps, released, run, sockets, storesOf };
}

const sequencesOf = (line: Record<string, unknown> | null) =>
  (line?.['sequences'] ?? []) as Record<string, unknown>[];

describe('batchCommand: lo que toca a cada secuencia, en su log', () => {
  it('la primera ejecución del día pide los 11 horarios, las 21 primeras cotizaciones y las 14 páginas de velas, cada secuencia en su log y por su conexión', async () => {
    const env = world();
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(0);
    expect(line?.['status']).toBe('completed');
    expect(line?.['schemas']).toEqual({
      archive_sha256: BATCH_FIXTURE.expected.archive_sha256,
      release: BATCH_FIXTURE.expected.release,
    });
    expect(
      sequencesOf(line).map((item) => [
        item['sequence'],
        item['status'],
        item['sent'],
        item['answered'],
        item['log'],
      ]),
    ).toEqual([
      ['lotes_horarios', 'completed', 11, 11, 1],
      ['lotes_cotizaciones', 'completed', 21, 21, 1],
      ['lotes_velas', 'completed', 14, 14, 1],
    ]);
    expect(line?.['state']).toEqual({
      lotes_cotizaciones: { next: 21, round: '2026-11-26T00:00:00.000Z' },
      lotes_horarios: { next: 11, round: '2026-11-26' },
      lotes_velas: { next: 14, round: '2026-11-25' },
    });
    expect(env.sockets).toHaveLength(3);
    expect(env.released).toEqual(['lotes_horarios', 'lotes_cotizaciones', 'lotes_velas']);
    // Una petición cada 1,5 s como mucho, también entre conexiones: 46 envíos en 67,5 s.
    expect(BATCH_PACING_MS).toBe(1_500);
    expect(
      Date.parse(env.clock.now()) - Date.parse('2026-11-26T00:01:00.000Z'),
    ).toBeGreaterThanOrEqual(45 * BATCH_PACING_MS);
    expect(env.sockets[0]?.requests()[0]).toEqual({ req_id: 1, trading_times: '2026-11-26' });
  });

  it('cada log tiene la apertura, una respuesta raw por petición y el cierre, en segmentos de la política 2.0.0 cerrados a las 15 respuestas y al terminar', async () => {
    const env = world();
    await env.run();
    const quotes = env.storesOf(logLocation(1, BATCH_QUOTES_SEQUENCE)).store;
    expect(quotes.rows.map((row) => row.kind)).toEqual([
      'connection_opened',
      ...Array<string>(21).fill('raw_source_frame'),
      'connection_closed',
    ]);
    expect(
      quotes.closed.map((segment) => [
        segment.segment_index,
        segment.raw_frame_count,
        segment.event_count,
        segment.close_reason,
        segment.segment_policy_version,
      ]),
    ).toEqual([
      [0, 15, 16, 'raw_frames', '2.0.0'],
      [1, 6, 7, 'requested', '2.0.0'],
    ]);
    // Nada queda abierto entre ejecuciones.
    const state = await quotes.readLogState(DERIV_SOURCE);
    expect(state.openRows).toEqual([]);
    const schedules = env.storesOf(logLocation(1, BATCH_SCHEDULES_SEQUENCE)).store;
    expect(
      schedules.closed.map((segment) => [segment.raw_frame_count, segment.close_reason]),
    ).toEqual([[11, 'requested']]);
  });

  it('con el estado de esa ejecución, la siguiente de la misma media hora no tiene nada que pedir y no abre nada', async () => {
    const first = world();
    const { line } = await first.run();
    const second = world({ start: '2026-11-26T00:04:00.000Z' });
    const again = await second.run(['--json', '--state', JSON.stringify(line?.['state'])]);
    expect(again.exitCode).toBe(0);
    expect(sequencesOf(again.line).map((item) => item['status'])).toEqual(['idle', 'idle', 'idle']);
    expect(second.sockets).toEqual([]);
    expect(second.released).toEqual([]);
    expect(again.line?.['state']).toEqual(line?.['state']);
  });

  it('cuenta las respuestas con error de Deriv por código y las que no cumplen su esquema, por operación', async () => {
    const env = world({
      respond: (request, index) => {
        const valid = answer(request, index);
        if ('contracts_for' in request && request['contracts_for'] === 'R_100') {
          return { ...valid, contracts_for: {} };
        }
        if ('proposal' in request && index % 10 === 0) {
          return {
            ...valid,
            error: { code: 'ContractBuyValidationError', message: 'no' },
            proposal: undefined,
          };
        }
        return valid;
      },
    });
    const { line } = await env.run();
    const [schedules, quotes] = sequencesOf(line);
    expect(schedules).toMatchObject({
      errors: {},
      schema_failures: { contracts_for: 1 },
      unexpected: 0,
    });
    expect(quotes?.['errors']).toEqual({ proposal: { ContractBuyValidationError: 2 } });
  });
});

describe('batchCommand: lo que para el paso', () => {
  it('un límite de peticiones en las cotizaciones las para donde quedaron y deja las velas para la ejecución siguiente', async () => {
    const env = world({
      respond: (request, index) =>
        'proposal' in request && index === 15
          ? {
              echo_req: request,
              error: { code: 'RateLimit', message: 'x' },
              msg_type: 'proposal',
              req_id: request['req_id'],
            }
          : answer(request, index),
    });
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(0);
    expect(sequencesOf(line).map((item) => [item['status'], item['reason'], item['next']])).toEqual(
      [
        ['completed', null, 11],
        ['stopped', 'rate_limit', 4],
        ['skipped', 'rate_limit', 0],
      ],
    );
    expect(line?.['state']).toMatchObject({
      lotes_cotizaciones: { next: 4, round: '2026-11-26T00:00:00.000Z' },
      lotes_velas: { next: 0, round: '2026-11-25' },
    });
    // La respuesta del límite también es raw: se guardó.
    const quotes = env.storesOf(logLocation(1, BATCH_QUOTES_SEQUENCE)).store;
    expect(quotes.rows.filter((row) => row.kind === 'raw_source_frame')).toHaveLength(5);
    expect(env.sockets).toHaveLength(2);
  });

  it('el plazo para de enviar, y la secuencia siguiente ni empieza: lo que queda, en la ejecución siguiente', async () => {
    // A las 00:26, las cotizaciones de la media hora están enteras por pedir: 126.
    const env = world({ start: '2026-11-26T00:26:00.000Z' });
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(0);
    expect(BATCH_DEADLINE_MS).toBe(70_000);
    const [schedules, quotes, candles] = sequencesOf(line);
    expect(schedules).toMatchObject({ next: 11, status: 'completed' });
    // 70 s dan para 47 envíos como mucho a una cada 1,5 s: 11 de los horarios y hasta 36 cotizaciones,
    // menos lo que tarda en abrirse cada conexión. Lo respondido es lo que ya no hay que pedir.
    expect(quotes).toMatchObject({ reason: 'deadline', status: 'stopped' });
    expect(quotes?.['sent']).toBeGreaterThan(30);
    expect(quotes?.['sent']).toBeLessThanOrEqual(36);
    expect(quotes?.['next']).toBe(quotes?.['sent']);
    expect(quotes?.['answered']).toBe(quotes?.['sent']);
    expect(candles).toMatchObject({ next: 0, reason: 'deadline', sent: 0, status: 'skipped' });
    expect(env.sockets).toHaveLength(2);
  });

  it('una respuesta que no llega para esa secuencia, y la siguiente lo intenta', async () => {
    const env = world({
      respond: (request, index) => (index === 11 ? null : answer(request, index)),
    });
    const { line } = await env.run();
    expect(sequencesOf(line).map((item) => [item['status'], item['reason'], item['next']])).toEqual(
      [
        ['completed', null, 11],
        ['stopped', 'request_timeout', 0],
        ['completed', null, 14],
      ],
    );
  });
});

describe('batchCommand: el log de cada secuencia', () => {
  it('pasada su hora de corte, escribe en el log siguiente si está preparado; si no, sigue en el activo y lo dice', async () => {
    const env = world({
      logs: {
        lotes_cotizaciones: { first: '2026-11-20T10:00:00.000Z', nextReadiness: 'not_prepared' },
        lotes_horarios: { first: '2026-11-20T10:00:00.000Z', nextReadiness: 'ready' },
        // Su hora de corte, el lunes 2026-11-30, todavía no llegó.
        lotes_velas: { first: '2026-11-25T00:01:00.000Z', nextReadiness: 'ready' },
      },
    });
    const { line } = await env.run();
    expect(
      sequencesOf(line).map((item) => [item['log'], item['cut'], item['cut_blocked']]),
    ).toEqual([
      [2, { from: 1, to: 2 }, null],
      [1, null, 'next_log_not_prepared'],
      [1, null, null],
    ]);
    expect(env.storesOf(logLocation(2, BATCH_SCHEDULES_SEQUENCE)).store.rows).toHaveLength(13);
  });

  it('sin log, sin el perfil de su secuencia o con el bloqueo tomado no pide nada en esa secuencia, y sigue con las demás', async () => {
    const env = world({
      busy: [BATCH_CANDLES_SEQUENCE],
      logs: {
        lotes_cotizaciones: { profile: derivBatchLogProfileRow('candles') },
        lotes_horarios: null,
      },
    });
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(1);
    expect(line?.['status']).toBe('failed');
    expect(
      sequencesOf(line).map((item) => [
        item['status'],
        item['reason'],
        item['detail'],
        item['sent'],
      ]),
    ).toEqual([
      ['failed', 'log_not_prepared', null, 0],
      ['failed', 'log_not_derivable', 'profile_mismatch', 0],
      ['skipped', 'lock_busy', null, 0],
    ]);
    expect(env.sockets).toEqual([]);
    expect(env.released).toEqual(['lotes_horarios', 'lotes_cotizaciones']);
    // Sin pedir nada, cada cursor queda en su vuelta, desde 0.
    expect(line?.['state']).toEqual({
      lotes_cotizaciones: { next: 0, round: '2026-11-26T00:00:00.000Z' },
      lotes_horarios: { next: 0, round: '2026-11-26' },
      lotes_velas: { next: 0, round: '2026-11-25' },
    });
  });
});

describe('batchCommand: el uso, la configuración y los esquemas', () => {
  it('sin --json, con un estado que no vale, fuera de production o con BUOH_POSTGRES_SCHEMA: salida 2, sin abrir nada', async () => {
    const env = world();
    for (const [argv, environment, code] of [
      [[], ENV, 'UsageError'],
      [['--json', '--state', '{'], ENV, 'UsageError'],
      [['--json', '--state', '{"R_100":{"next":0,"round":"2026-11-26"}}'], ENV, 'UsageError'],
      [
        ['--json', '--state', '{"lotes_velas":{"next":-1,"round":"2026-11-26"}}'],
        ENV,
        'UsageError',
      ],
      [['--json'], { ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: 'development' }, 'ConfigError'],
      [['--json'], { ...ENV, BUOH_POSTGRES_SCHEMA: 'buoh_lotes_velas_log_000001' }, 'ConfigError'],
    ] as const) {
      const result = await env.run(argv, environment);
      expect(result.exitCode, JSON.stringify(argv)).toBe(2);
      expect(result.stdout).toBeNull();
      expect(JSON.parse(result.stderr ?? '{}')).toMatchObject({ code, status: 'failed' });
    }
    expect(env.sockets).toEqual([]);
  });

  it('si no carga los esquemas, no pide nada: salida 1, con el motivo y el mismo estado', async () => {
    const env = world();
    const state = { lotes_velas: { next: 3, round: '2026-11-25' } };
    const result = await batchCommand(['--json', '--state', JSON.stringify(state)], ENV, {
      ...env.deps,
      fetch: () => Promise.resolve(new Response('no', { status: 404 })),
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? '{}')).toEqual({
      detail: '404',
      reason: 'download_status',
      schemas: null,
      sequences: [],
      state,
      status: 'failed',
    });
    expect(env.sockets).toEqual([]);
  });
});

describe('batchCommand: lo que revisó la revisión semántica del PR #145', () => {
  it('cuenta los fallos de esquema con los esquemas que usarán las reglas: active_symbols sin underlying_symbol_type y contracts_for con growth_rate_barrier_offsets valen', async () => {
    const env = world({
      respond: (request, index) => {
        const valid = answer(request, index);
        if (valid !== null && 'active_symbols' in request) {
          const entry: Record<string, unknown> = { ...catalogEntry('R_100', 'Volatility 100') };
          delete entry['underlying_symbol_type'];
          return { ...valid, active_symbols: [entry] };
        }
        if (valid !== null && 'contracts_for' in request) {
          const extra = request['contracts_for'] === 'cryBTCUSD' ? { otro: 1 } : {};
          return {
            ...valid,
            contracts_for: {
              available: [{ contract_type: 'ACCU', growth_rate_barrier_offsets: [], ...extra }],
            },
          };
        }
        return valid;
      },
    });
    const { line } = await env.run();
    // Solo la de Bitcoin, con un campo que la release no describe.
    expect(sequencesOf(line)[0]?.['schema_failures']).toEqual({ contracts_for: 1 });
  });

  it('un RateLimit para las secuencias siguientes también si después falla una escritura, que da su etapa y su motivo', async () => {
    const env = world({
      respond: (request, index) =>
        'proposal' in request && index === 13
          ? {
              echo_req: request,
              error: { code: 'RateLimit', message: 'x' },
              msg_type: 'proposal',
              req_id: request['req_id'],
            }
          : answer(request, index),
    });
    env.storesOf(logLocation(1, BATCH_QUOTES_SEQUENCE)).store.failIndex = (row) =>
      row.kind === 'connection_closed';
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(1);
    expect(
      sequencesOf(line).map((item) => [
        item['status'],
        item['reason'],
        item['detail'],
        item['next'],
      ]),
    ).toEqual([
      ['completed', null, null, 11],
      ['failed', 'persistence_failed', 'source_event_index:synthetic_index_failure', 2],
      ['skipped', 'rate_limit', null, 0],
    ]);
  });

  it('un segmento que dejó abierto una ejecución anterior se cierra antes de escribir, y no mezcla dos ejecuciones', async () => {
    const env = world();
    const location = logLocation(1, BATCH_SCHEDULES_SEQUENCE);
    const { objects, store } = env.storesOf(location);
    const previous = await SourceEventLog.open({
      objects,
      policy: BATCH_SEGMENT_POLICY,
      source: DERIV_SOURCE,
      store,
      zlibVersion: process.versions.zlib,
    });
    await previous.append({
      connection_id: uuid(900),
      event_id: uuid(901),
      kind: 'connection_opened',
      occurred_at_utc: '2026-11-26T00:00:30.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    });
    await env.run();
    expect(
      store.closed.map((segment) => [
        segment.segment_index,
        segment.event_count,
        segment.close_reason,
      ]),
    ).toEqual([
      [0, 1, 'requested'],
      [1, 13, 'requested'],
    ]);
  });

  it('sin perfil, con migraciones pendientes, con el log siguiente sin migrar, sin bloqueo que responda o con un log que no se abre: cada uno con su motivo', async () => {
    const env = world({
      broken: { lotes_velas: 'open' },
      logs: {
        lotes_cotizaciones: { pending: ['0007_perfil_del_log.sql'] },
        lotes_horarios: { profile: null },
      },
    });
    const { line } = await env.run();
    expect(
      sequencesOf(line).map((item) => [item['status'], item['reason'], item['detail']]),
    ).toEqual([
      ['failed', 'log_not_derivable', 'profile_missing'],
      ['failed', 'migrations_pending', null],
      ['failed', 'log_open_failed', 'LogIntegrityError'],
    ]);
    const other = world({
      broken: { lotes_horarios: 'lock' },
      logs: {
        lotes_cotizaciones: {
          first: '2026-11-20T10:00:00.000Z',
          nextReadiness: 'migrations_pending',
        },
      },
    });
    const second = await other.run();
    expect(
      sequencesOf(second.line).map((item) => [
        item['status'],
        item['reason'],
        item['detail'],
        item['cut_blocked'],
      ]),
    ).toEqual([
      ['failed', 'lock_unavailable', 'ECONNREFUSED', null],
      ['completed', null, null, 'next_log_migrations_pending'],
      ['completed', null, null, null],
    ]);
    expect(second.stdout).not.toContain('secreto');
    expect(line).not.toBeNull();
    expect(JSON.stringify(line)).not.toContain('secreto');
  });

  it('una petición que no cumple su esquema de la release no abre nada: request_invalid', async () => {
    const strict = syntheticSchemaArchive(
      {
        'trading_times_request.schema.json': {
          $schema: 'http://json-schema.org/draft-04/schema#',
          additionalProperties: false,
          properties: {
            req_id: { type: 'integer' },
            trading_times: { pattern: '^today$', type: 'string' },
          },
          required: ['trading_times'],
          type: 'object',
        },
      },
      DERIV_BATCH_OPERATIONS,
    );
    const env = world({ fixture: strict, start: '2026-11-26T00:04:00.000Z' });
    const { line } = await env.run([
      '--json',
      '--state',
      JSON.stringify({
        lotes_cotizaciones: { next: 21, round: '2026-11-26T00:00:00.000Z' },
        lotes_velas: { next: 14, round: '2026-11-25' },
      }),
    ]);
    expect(
      sequencesOf(line).map((item) => [item['status'], item['reason'], item['detail']]),
    ).toEqual([
      ['failed', 'request_invalid', 'trading_times'],
      ['idle', null, null],
      ['idle', null, null],
    ]);
    expect(env.sockets).toEqual([]);
    expect(env.released).toEqual([]);
  });
});

describe('batchCommand: lo que revisó la segunda revisión semántica del PR #145', () => {
  /** Deja en el log un segmento abierto, como una ejecución que falló al escribir. */
  const leaveOpen = async (env: ReturnType<typeof world>, location: LogLocation) => {
    const { objects, store } = env.storesOf(location);
    const previous = await SourceEventLog.open({
      objects,
      policy: BATCH_SEGMENT_POLICY,
      source: DERIV_SOURCE,
      store,
      zlibVersion: process.versions.zlib,
    });
    const opened: SourceEvent = {
      connection_id: uuid(900),
      event_id: uuid(901),
      kind: 'connection_opened',
      occurred_at_utc: '2026-11-20T10:00:00.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    };
    await previous.append(opened);
    return store;
  };

  it('con un corte, cierra antes el segmento que quedó abierto en el log que deja de escribirse', async () => {
    const env = world({
      logs: { lotes_horarios: { first: '2026-11-20T10:00:00.000Z', nextReadiness: 'ready' } },
    });
    const left = await leaveOpen(env, logLocation(1, BATCH_SCHEDULES_SEQUENCE));
    const { line } = await env.run();
    expect(sequencesOf(line)[0]).toMatchObject({
      cut: { from: 1, to: 2 },
      log: 2,
      status: 'completed',
    });
    expect(left.closed.map((segment) => [segment.event_count, segment.close_reason])).toEqual([
      [1, 'requested'],
    ]);
    expect((await left.readLogState(DERIV_SOURCE)).openRows).toEqual([]);
    expect(env.storesOf(logLocation(2, BATCH_SCHEDULES_SEQUENCE)).store.rows).toHaveLength(13);
  });

  it('si no puede cerrar el segmento que quedó abierto, no pide nada en esa secuencia', async () => {
    const env = world();
    const left = await leaveOpen(env, logLocation(1, BATCH_SCHEDULES_SEQUENCE));
    left.failClose = true;
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(1);
    expect(sequencesOf(line)[0]).toMatchObject({
      reason: 'persistence_failed',
      sent: 0,
      status: 'failed',
    });
    expect(env.sockets).toHaveLength(2);
  });

  it('un RateLimit que se escribe después de un corte de la conexión para también las secuencias siguientes', async () => {
    class ClosingSocket extends AnsweringSocket {
      override text(payload: string): void {
        super.text(payload);
        if (payload.includes('RateLimit')) {
          // El corte llega antes de que el frame del límite sea durable.
          this.emit({ code: 1006, kind: 'closed' });
        }
      }
    }
    const env = world({
      respond: (request, index) =>
        'proposal' in request && index === 12
          ? {
              echo_req: request,
              error: { code: 'RateLimit', message: 'x' },
              msg_type: 'proposal',
              req_id: request['req_id'],
            }
          : answer(request, index),
      socket: ClosingSocket,
    });
    const { line } = await env.run();
    expect(sequencesOf(line).map((item) => [item['status'], item['reason'], item['next']])).toEqual(
      [
        ['completed', null, 11],
        ['stopped', 'disconnected', 1],
        ['skipped', 'rate_limit', 0],
      ],
    );
  });

  it('sin lecturas que respondan, log_unavailable con el código; y lo abandonado de la vuelta anterior y el log 999 999 se dicen', async () => {
    const env = world({
      broken: { lotes_horarios: 'reads' },
      logs: {
        lotes_velas: {
          active: MAX_LOG_NUMBER,
          first: '2026-11-20T10:00:00.000Z',
          nextReadiness: 'ready',
        },
      },
    });
    const { line } = await env.run([
      '--json',
      '--state',
      JSON.stringify({ lotes_cotizaciones: { next: 100, round: '2026-11-25T23:30:00.000Z' } }),
    ]);
    const [schedules, quotes, candles] = sequencesOf(line);
    expect(schedules).toMatchObject({
      detail: '57P01',
      reason: 'log_unavailable',
      status: 'failed',
    });
    expect(quotes).toMatchObject({
      abandoned: { remaining: 26, round: '2026-11-25T23:30:00.000Z' },
      from: 0,
      next: 21,
      status: 'completed',
    });
    expect(candles).toMatchObject({
      cut: null,
      cut_blocked: 'log_number_exhausted',
      log: MAX_LOG_NUMBER,
      status: 'completed',
    });
  });
});

describe('batchCommand: el plazo antes de conectar', () => {
  it('si al abrir el log ya pasó el plazo, no conecta, y las secuencias siguientes no empiezan', async () => {
    const env = world({ jumpOnOpenMs: 80_000 });
    const { exitCode, line } = await env.run();
    expect(exitCode).toBe(0);
    expect(sequencesOf(line).map((item) => [item['status'], item['reason'], item['sent']])).toEqual(
      [
        ['stopped', 'deadline', 0],
        ['skipped', 'deadline', 0],
        ['skipped', 'deadline', 0],
      ],
    );
    expect(env.sockets).toEqual([]);
  });
});
