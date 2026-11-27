import { BATCH_SEGMENT_POLICY } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import { derivBatchLogProfileRow, derivHistoryProfile } from '../src/deriv/batch-profile.js';
import { historyPlan } from '../src/deriv/history-pages.js';
import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  HISTORY_BLOCK_DEADLINE_MS,
  HISTORY_MAX_FAILURES,
  HISTORY_PACING_MS,
  HISTORY_RATE_LIMIT_WAIT_MS,
  HISTORY_RETRY_WAIT_MS,
  historyCommand,
  type HistoryDependencies,
} from '../src/history/command.js';
import {
  HISTORY_GOLD_SEQUENCE,
  HISTORY_R_100_SEQUENCE,
  logLocation,
  SourceEventLog,
  type LogLocation,
  type LogSequence,
} from '../src/index.js';
import type { LogReadiness } from '../src/log-cut.js';
import type { ChildResult } from '../src/operations/child.js';
import { answer, AnsweringSocket, BATCH_FIXTURE, type Respond } from './support/batch-fixtures.js';
import { historyPageText, sessionText, writeBatchLog } from './support/batch-frames.js';
import { uuid } from './support/connection-harness.js';
import { ManualClock } from './support/deriv-fixtures.js';
import { MemoryObjectStore, MemorySourceLogStore } from './support/memory-stores.js';

// El comando de la historia (precisión del PR 6c de ADR-0021 §9) sin servicios: los logs en memoria,
// un socket que responde solo, un reloj manual y `datasets:publish` falso. Los vectores salen de la
// precisión: el bloque más antiguo de las dos historias primero, una petición cada 2,1 s, la historia
// desde su log sin pedir nada dos veces, un bloque a medias sin cortar el log, cada bloque publicado
// en cuanto termina, y el final cuando las dos están pedidas y publicadas.

const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_HISTORIA_POSTGRES_DB: 'buoh',
  BUOH_HISTORIA_POSTGRES_HOST: 'pg-sintetico.invalid',
  BUOH_HISTORIA_POSTGRES_PORT: '5432',
  BUOH_HISTORIA_POSTGRES_SSLMODE: 'verify-full',
  BUOH_LOTES_POSTGRES_PASSWORD: 'lotes-sintetica-0123456789',
  BUOH_LOTES_S3_ACCESS_KEY_ID: 'clave-lotes-sintetica',
  BUOH_LOTES_S3_BUCKET: 'buoh-captura',
  BUOH_LOTES_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
  BUOH_LOTES_S3_REGION: 'auto',
  BUOH_LOTES_S3_SECRET_ACCESS_KEY: 'secreto-lotes-sintetico',
  BUOH_PUBLICACION_POSTGRES_PASSWORD: 'publicacion-sintetica-0123',
  BUOH_OPERACIONES_S3_ACCESS_KEY_ID: 'clave-operaciones-sintetica',
  BUOH_OPERACIONES_S3_BUCKET: 'buoh-captura',
  BUOH_OPERACIONES_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
  BUOH_OPERACIONES_S3_REGION: 'auto',
  BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY: 'secreto-operaciones-sintetico',
};

const R_100 = historyPlan(derivHistoryProfile('R_100'));
const GOLD = historyPlan(derivHistoryProfile('frxXAUUSD'));
const GOLD_LAST = GOLD.firsts.at(-1) ?? 0;
const R_100_LAST = R_100.firsts.at(-1) ?? 0;
const R_100_PREVIOUS = R_100.firsts.at(-2) ?? 0;

/**
 * 2027-10-31T16:00Z: el borde de los 365 días es el 2026-10-31T16:00Z, y el primer bloque de R_100
 * que empieza una hora después, el de las 18:00, el penúltimo.
 */
const START = '2027-10-31T16:00:00.000Z';

interface LogState {
  /** El número del log activo; por defecto, 1. */
  active: number;
  first: string | null;
  nextReadiness: LogReadiness;
}

function world(
  options: {
    readonly busy?: boolean;
    /**
     * Lo que responde `datasets:publish` a una secuencia sin `--skip`, en lugar de publicar; con
     * `times`, solo esas veces.
     */
    readonly failPublication?: {
      readonly reason: string;
      readonly sequence: string;
      readonly times?: number;
    };
    /** Pierde los bloqueos al terminar el primer bloque. */
    readonly loseLock?: boolean;
    /** Las migraciones pendientes de los logs de cada secuencia. */
    readonly pending?: Partial<Record<string, readonly string[]>>;
    readonly logs?: Partial<Record<string, Partial<LogState> | null>>;
    readonly respond?: Respond;
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
  const stateOf = (sequence: LogSequence): LogState | null => {
    const given = options.logs?.[sequence.name];
    return given === null
      ? null
      : { active: 1, first: null, nextReadiness: 'not_prepared', ...given };
  };
  const clock = new ManualClock(START);
  const sent: { at: string; request: Record<string, unknown> }[] = [];
  const respond = options.respond ?? historyAnswer;
  const lines: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const publishes: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const published = new Map<string, number>();
  const index = { value: 0 };
  const locks: { held: boolean }[] = [];
  let failures = 0;
  let id = 0;
  const deps: HistoryDependencies = {
    // Como un `SourceLock`: soltarlo lo pierde.
    acquireLock: () => {
      if (options.busy === true) {
        return Promise.resolve(null);
      }
      const lock = {
        held: true,
        release: () => {
          lock.held = false;
          return Promise.resolve();
        },
      };
      locks.push(lock);
      return Promise.resolve(lock);
    },
    connect: (input) =>
      new AnsweringSocket(
        input,
        (request, at) => {
          sent.push({ at: clock.now(), request });
          return respond(request, at);
        },
        index,
      ),
    expected: BATCH_FIXTURE.expected,
    fetch: () => Promise.resolve(new Response(BATCH_FIXTURE.archive, { status: 200 })),
    nextId: () => uuid((id += 1)),
    now: clock.now,
    openLog: async (_config, _lock, log) => {
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
        objects,
      };
    },
    openReads: (_config, sequence) => {
      const state = stateOf(sequence);
      return {
        close: () => Promise.resolve(),
        firstWrite: async (log) => {
          const written = (await storesOf(log).store.readLogState(DERIV_SOURCE)).firstEventTimeUtc;
          return log.number === 1 ? (state?.first ?? written) : written;
        },
        locateLog: () =>
          Promise.resolve(state === null ? null : logLocation(state.active, sequence)),
        logProfile: () =>
          Promise.resolve(
            derivBatchLogProfileRow(
              sequence === HISTORY_R_100_SEQUENCE ? 'history_r_100' : 'history_frxxauusd',
            ),
          ),
        pendingMigrations: () => Promise.resolve(options.pending?.[sequence.name] ?? []),
        readiness: () => Promise.resolve(state?.nextReadiness ?? 'not_prepared'),
      };
    },
    openSegments: (_config, log) => {
      const { objects, store } = storesOf(log);
      const reader = SourceEventLog.closedSegmentReader({
        objects,
        source: DERIV_SOURCE,
        store,
        zlibVersion: 'solo-lectura',
      });
      return {
        close: () => Promise.resolve(),
        closed: (from) => store.listClosedSegments(DERIV_SOURCE, from, 1_000_000),
        read: async (segment) => (await reader.readClosedSegment(segment)).events,
      };
    },
    runChild: (_child, args, env): Promise<ChildResult> => {
      publishes.push({ args, env });
      // Publica un dataset por cada bloque terminado que todavía no publicó.
      const sequence = args[1] ?? '';
      const fail = options.failPublication;
      if (
        fail?.sequence === sequence &&
        !args.includes('--skip') &&
        (fail.times === undefined || failures < fail.times)
      ) {
        failures += 1;
        return Promise.resolve({
          exitCode: 1,
          stderr: '',
          stdout: `${JSON.stringify({ log: 1, reason: fail.reason, sequence, status: 'failed' })}\n`,
          timedOut: false,
        });
      }
      const done = lines.filter(
        (line) =>
          line['event'] === 'history_block' &&
          line['sequence'] === sequence &&
          line['status'] === 'completed',
      ).length;
      const count = published.get(sequence) ?? 0;
      const status = done > count ? 'published' : 'nothing_due';
      if (status === 'published') {
        published.set(sequence, count + 1);
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: `${JSON.stringify({ duration_ms: 1500, log: 1, sequence, status })}\n`,
        timedOut: false,
      });
    },
    scheduler: clock.scheduler,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise((resolve) => {
        clock.scheduler.schedule(ms, resolve);
      });
    },
    write: (line) => {
      lines.push(line);
      if (options.loseLock === true && line['event'] === 'history_block') {
        for (const lock of locks) {
          lock.held = false;
        }
      }
    },
  };
  const run = async (env: Record<string, string> = ENV) => {
    const done = { value: false };
    const result = historyCommand([], env, deps).finally(() => {
      done.value = true;
    });
    for (let step = 0; step < 20_000 && !done.value; step += 1) {
      await clock.advance(500);
    }
    return result;
  };
  return { lines, published, publishes, run, sent, sleeps, storesOf };
}

/** Las respuestas de la historia: los horarios, y las páginas de ticks, con un tick en su inicio. */
const historyAnswer: Respond = (request, at) => {
  if (request['style'] === 'ticks') {
    const { req_id: reqId, ...echo } = request;
    const start = Number(request['start']);
    return {
      echo_req: { ...echo, req_id: reqId },
      history: { prices: [1], times: [start] },
      msg_type: 'history',
      pip_size: 2,
      req_id: reqId,
    };
  }
  return answer(request, at);
};

/** El log 1 del oro de un proceso anterior: el horario de su último bloque y sus dos primeros tramos. */
async function seedGold(env: ReturnType<typeof world>): Promise<void> {
  const tranche = (index: number) => {
    const request = GOLD.requests[index];
    if (request?.operation !== 'ticks_history') throw new TypeError('no es un tramo');
    return historyPageText('frxXAUUSD', request.start, request.end, [request.start]);
  };
  const date = GOLD.requests[GOLD_LAST];
  if (date?.operation !== 'trading_times') throw new TypeError('no es un horario');
  await writeBatchLog({
    ...env.storesOf(logLocation(1, HISTORY_GOLD_SEQUENCE)),
    runs: [
      {
        atUtc: '2027-10-31T15:00:00.000Z',
        texts: [sessionText(date.date), tranche(GOLD_LAST + 1), tranche(GOLD_LAST + 2)],
      },
    ],
  });
}

const sequenceOf = (request: Record<string, unknown>) =>
  request['ticks_history'] ?? `trading_times:${String(request['trading_times'])}`;

describe('historyCommand: las dos historias, bloque a bloque', () => {
  it('sigue cada historia desde su log o desde el borde de Deriv, el bloque más antiguo primero, a una petición cada 2,1 s, y publica cada bloque en cuanto termina', async () => {
    const env = world({
      logs: {
        // El oro pasó su hora de corte y tiene el log 2 preparado; sigue un bloque a medias.
        lotes_historia_frxxauusd: { first: '2026-11-20T00:00:00.000Z', nextReadiness: 'ready' },
      },
    });
    await seedGold(env);

    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.lines[0]).toEqual({
      event: 'history_started',
      sequences: [
        { next: R_100_PREVIOUS, requests: R_100.requests.length, sequence: 'lotes_historia_r_100' },
        {
          next: GOLD_LAST + 3,
          requests: GOLD.requests.length,
          sequence: 'lotes_historia_frxxauusd',
        },
      ],
    });
    // Los dos bloques de R_100, más antiguos, y después lo que le falta al oro, sin su horario.
    expect(env.sent.map(({ request }) => sequenceOf(request))).toEqual([
      'trading_times:2026-10-31',
      ...Array.from({ length: 12 }, () => 'R_100'),
      'trading_times:2026-11-01',
      'R_100',
      ...Array.from({ length: GOLD.requests.length - GOLD_LAST - 3 }, () => 'frxXAUUSD'),
    ]);
    expect(R_100.requests.length - R_100_PREVIOUS).toBe(15);
    expect(R_100_LAST - R_100_PREVIOUS).toBe(13);
    // Una petición cada 2,1 s como poco, también entre bloques y entre historias.
    const times = env.sent.map(({ at }) => Date.parse(at));
    for (let item = 1; item < times.length; item += 1) {
      expect((times[item] ?? 0) - (times[item - 1] ?? 0)).toBeGreaterThanOrEqual(HISTORY_PACING_MS);
    }
    // Un bloque a medias no corta el log: el oro sigue en su log 1.
    const blocks = env.lines.filter((line) => line['event'] === 'history_block');
    expect(
      blocks.map((line) => [line['sequence'], line['status'], line['log'], line['cut']]),
    ).toEqual([
      ['lotes_historia_r_100', 'completed', 1, null],
      ['lotes_historia_r_100', 'completed', 1, null],
      ['lotes_historia_frxxauusd', 'completed', 1, null],
    ]);
    // Una página de ticks responde con `history`: se cuenta y se valida, no es `unexpected`.
    for (const line of blocks) {
      expect(line).toMatchObject({ errors: {}, schema_failures: {}, unexpected: 0 });
    }
    expect(
      (await env.storesOf(logLocation(2, HISTORY_GOLD_SEQUENCE)).store.readLogState(DERIV_SOURCE))
        .totalEventCount,
    ).toBe(0);
    // Cada bloque, publicado con buoh_publicacion y el token operaciones.
    expect(Object.fromEntries(env.published)).toEqual({
      lotes_historia_frxxauusd: 1,
      lotes_historia_r_100: 2,
    });
    for (const { args, env: childEnv } of env.publishes) {
      expect(args.slice(0, 1)).toEqual(['--sequence']);
      expect(childEnv).toMatchObject({
        BUOH_POSTGRES_USER: 'buoh_publicacion',
        BUOH_POSTGRES_PASSWORD: ENV.BUOH_PUBLICACION_POSTGRES_PASSWORD,
        BUOH_S3_ACCESS_KEY_ID: ENV.BUOH_OPERACIONES_S3_ACCESS_KEY_ID,
      });
      expect(Object.values(childEnv)).not.toContain(ENV.BUOH_LOTES_POSTGRES_PASSWORD);
    }
    expect(env.lines.at(-1)).toEqual({ event: 'history_finished', status: 'completed' });
    expect(env.sleeps).toEqual([]);

    // Otro proceso después: nada que pedir ni que publicar.
    const before = env.sent.length;
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.sent.length).toBe(before);
    expect(env.lines.findLast((line) => line['event'] === 'history_started')).toMatchObject({
      sequences: [{ next: R_100.requests.length }, { next: GOLD.requests.length }],
    });
  });

  it('un bloque que empieza, si Deriv ya no lo guarda, salta al primero que todavía guarda', async () => {
    const env = world();
    await seedGold(env);
    // R_100 terminó un bloque de dos días antes del borde de Deriv.
    const old = R_100.firsts[R_100.firsts.length - 10] ?? 0;
    const last = R_100.requests[old - 1];
    if (last?.operation !== 'ticks_history') throw new TypeError('no es un tramo');
    await writeBatchLog({
      ...env.storesOf(logLocation(1, HISTORY_R_100_SEQUENCE)),
      runs: [
        {
          atUtc: '2027-10-29T00:00:00.000Z',
          texts: [historyPageText('R_100', last.start, last.end, [last.start])],
        },
      ],
    });
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.lines[0]).toMatchObject({ sequences: [{ next: old }, { next: GOLD_LAST + 3 }] });
    expect(sequenceOf(env.sent[0]?.request ?? {})).toBe('trading_times:2026-10-31');
    expect(env.sent.filter(({ request }) => request['ticks_history'] === 'R_100')).toHaveLength(13);
  });

  it('el horario que siguió al último tramo, en otro segmento o en el log siguiente, no se pide otra vez', async () => {
    const last = R_100.requests[R_100_PREVIOUS - 1];
    const date = R_100.requests[R_100_PREVIOUS];
    if (last?.operation !== 'ticks_history' || date?.operation !== 'trading_times') {
      throw new TypeError('no es un tramo y su horario');
    }
    const page = {
      atUtc: '2027-10-31T15:00:00.000Z',
      texts: [historyPageText('R_100', last.start, last.end, [last.start])],
    };
    const schedule = { atUtc: '2027-10-31T15:01:00.000Z', texts: [sessionText(date.date)] };
    for (const where of ['segment', 'log'] as const) {
      const env = world(where === 'log' ? { logs: { lotes_historia_r_100: { active: 2 } } } : {});
      await seedGold(env);
      const r100 = (number: number) => env.storesOf(logLocation(number, HISTORY_R_100_SEQUENCE));
      if (where === 'segment') {
        await writeBatchLog({ ...r100(1), runs: [page, schedule] });
      } else {
        await writeBatchLog({ ...r100(1), runs: [page] });
        await writeBatchLog({ ...r100(2), runs: [schedule] });
      }
      expect(await env.run(), where).toEqual({ exitCode: 0, stderr: null });
      expect(env.lines[0], where).toMatchObject({
        sequences: [{ next: R_100_PREVIOUS + 1 }, { next: GOLD_LAST + 3 }],
      });
      expect(
        env.sent.filter(({ request }) => request['trading_times'] === date.date),
        where,
      ).toEqual([]);
    }
  });

  it('un RateLimit espera y vuelve a pedir esa página; sin el log de una historia, lo busca otra vez a los 60 s, y a la décima vez el proceso para', async () => {
    let limited = false;
    const env = world({
      respond: (request, at) => {
        if (!limited && request['style'] === 'ticks') {
          limited = true;
          const { req_id: reqId, ...echo } = request;
          return {
            echo_req: { ...echo, req_id: reqId },
            error: { code: 'RateLimit', message: 'x' },
            msg_type: 'ticks_history',
            req_id: reqId,
          };
        }
        return historyAnswer(request, at);
      },
    });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.sleeps).toEqual([HISTORY_RATE_LIMIT_WAIT_MS]);
    const first = env.sent.findIndex(({ request }) => request['style'] === 'ticks');
    expect(env.sent[first + 1]?.request['start']).toBe(env.sent[first]?.request['start']);

    // Sin el log de la historia del oro, que prepara buoh-operaciones, no sigue.
    const missing = world({ logs: { lotes_historia_frxxauusd: null } });
    expect(await missing.run()).toEqual({ exitCode: 1, stderr: null });
    expect(missing.sleeps).toEqual(
      Array.from({ length: HISTORY_MAX_FAILURES - 1 }, () => HISTORY_RETRY_WAIT_MS),
    );
    expect(missing.lines.at(-1)).toEqual({
      event: 'history_finished',
      reason: 'log_not_prepared',
      sequence: 'lotes_historia_frxxauusd',
      status: 'failed',
    });
    expect(missing.sent).toEqual([]);
  });

  it('un log cuya publicación no cambia al repetirla se deja con --skip, como en el paso 6, y el proceso termina con logs_skipped', async () => {
    const env = world({
      failPublication: {
        reason: 'publication_not_derivable',
        sequence: 'lotes_historia_frxxauusd',
      },
    });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 1, stderr: null });
    expect(
      env.publishes
        .filter(({ args }) => args[1] === 'lotes_historia_frxxauusd')
        .map(({ args }) => args.slice(2)),
    ).toContainEqual(['--skip', '1']);
    expect(env.lines.at(-1)).toEqual({
      event: 'history_finished',
      reason: 'logs_skipped',
      skipped: [{ log: 1, sequence: 'lotes_historia_frxxauusd' }],
      status: 'failed',
    });
    expect(env.published.get('lotes_historia_r_100')).toBe(2);
  });

  it('con el bloqueo de otro proceso no pide nada, y la configuración no admite variables BUOH_POSTGRES_* ni BUOH_S3_*', async () => {
    const busy = world({ busy: true });
    expect(await busy.run()).toEqual({ exitCode: 1, stderr: null });
    expect(busy.lines.at(-1)).toMatchObject({ reason: 'lock_busy', status: 'failed' });
    expect(busy.sent).toEqual([]);

    const env = world();
    const rest = Object.fromEntries(
      Object.entries(ENV).filter(([name]) => name !== 'BUOH_LOTES_POSTGRES_PASSWORD'),
    );
    const result = await env.run({ ...rest, BUOH_POSTGRES_USER: 'buoh_lotes' });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr ?? '{}')).toMatchObject({ code: 'ConfigError' });
    expect(result.stderr).toContain('BUOH_LOTES_POSTGRES_PASSWORD');
    expect(result.stderr).toContain('BUOH_POSTGRES_USER');
    expect(result.stderr).not.toContain(ENV.BUOH_PUBLICACION_POSTGRES_PASSWORD);
    expect(HISTORY_BLOCK_DEADLINE_MS).toBeGreaterThan(17 * HISTORY_PACING_MS + 15_000);
  });
});

describe('historyCommand: lo que para, lo que se repite y el corte', () => {
  it('las esperas y los límites son los medidos y los de la precisión del PR 6c', () => {
    expect(HISTORY_PACING_MS).toBe(2_100);
    expect(HISTORY_RATE_LIMIT_WAIT_MS).toBe(60_000);
    expect(HISTORY_RETRY_WAIT_MS).toBe(60_000);
    expect(HISTORY_MAX_FAILURES).toBe(10);
  });

  it('un proceso que murió con un segmento abierto: lo cierra antes de leerlo y sigue sin pedir otra vez sus páginas', async () => {
    const env = world();
    const page = (index: number) => {
      const request = GOLD.requests[index];
      if (request?.operation !== 'ticks_history') throw new TypeError('no es un tramo');
      return historyPageText('frxXAUUSD', request.start, request.end, [request.start]);
    };
    const date = GOLD.requests[GOLD_LAST];
    if (date?.operation !== 'trading_times') throw new TypeError('no es un horario');
    await writeBatchLog({
      ...env.storesOf(logLocation(1, HISTORY_GOLD_SEQUENCE)),
      leaveOpen: true,
      runs: [
        {
          atUtc: '2027-10-31T15:00:00.000Z',
          texts: [sessionText(date.date), page(GOLD_LAST + 1), page(GOLD_LAST + 2)],
        },
      ],
    });
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.lines[0]).toMatchObject({ sequences: [{}, { next: GOLD_LAST + 3 }] });
    expect(env.sent.filter(({ request }) => request['ticks_history'] === 'frxXAUUSD')).toHaveLength(
      GOLD.requests.length - GOLD_LAST - 3,
    );
  });

  it('un bloque que falla espera 60 s y se repite, y a los diez fallos seguidos el proceso para', async () => {
    const env = world({ pending: { lotes_historia_r_100: ['0003_pendiente'] } });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 1, stderr: null });
    const blocks = env.lines.filter((line) => line['event'] === 'history_block');
    expect(blocks).toHaveLength(HISTORY_MAX_FAILURES);
    for (const line of blocks) {
      expect(line).toMatchObject({ reason: 'migrations_pending', status: 'failed' });
    }
    expect(env.sleeps).toEqual(
      Array.from({ length: HISTORY_MAX_FAILURES - 1 }, () => HISTORY_RETRY_WAIT_MS),
    );
    expect(env.lines.at(-1)).toEqual({
      event: 'history_finished',
      reason: 'migrations_pending',
      sequence: 'lotes_historia_r_100',
      status: 'failed',
    });
  });

  it('sin el bloqueo, otro proceso pudo escribir: para antes del bloque siguiente', async () => {
    const env = world({ loseLock: true });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 1, stderr: null });
    expect(env.lines.filter((line) => line['event'] === 'history_block')).toHaveLength(1);
    expect(env.lines.at(-1)).toEqual({
      event: 'history_finished',
      reason: 'source_lock_lost',
      sequence: 'lotes_historia_r_100',
      status: 'failed',
    });
  });

  it('una publicación que falla se repite; un log que repetir no cambia se deja, por cualquiera de sus cuatro motivos', async () => {
    const env = world({
      failPublication: {
        reason: 'storage_unavailable',
        sequence: 'lotes_historia_r_100',
        times: 3,
      },
    });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    expect(env.published.get('lotes_historia_r_100')).toBe(2);
    expect(
      env.lines.filter(
        (line) => line['event'] === 'history_publication' && line['status'] === 'failed',
      ),
    ).toHaveLength(3);
    // El proceso de publicación recibe solo buoh_publicacion y el token operaciones.
    expect(env.publishes[0]?.env).toEqual({
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
      BUOH_POSTGRES_PASSWORD: ENV.BUOH_PUBLICACION_POSTGRES_PASSWORD,
      BUOH_POSTGRES_PORT: '5432',
      BUOH_POSTGRES_SSLMODE: 'verify-full',
      BUOH_POSTGRES_USER: 'buoh_publicacion',
      BUOH_S3_ACCESS_KEY_ID: ENV.BUOH_OPERACIONES_S3_ACCESS_KEY_ID,
      BUOH_S3_BUCKET: ENV.BUOH_OPERACIONES_S3_BUCKET,
      BUOH_S3_ENDPOINT: ENV.BUOH_OPERACIONES_S3_ENDPOINT,
      BUOH_S3_REGION: ENV.BUOH_OPERACIONES_S3_REGION,
      BUOH_S3_SECRET_ACCESS_KEY: ENV.BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY,
    });

    // Una que falla siempre: a los diez fallos seguidos, después de pedirlo todo, el proceso para.
    const failing = world({
      failPublication: { reason: 'storage_unavailable', sequence: 'lotes_historia_r_100' },
    });
    await seedGold(failing);
    expect(await failing.run()).toEqual({ exitCode: 1, stderr: null });
    expect(failing.lines.at(-1)).toEqual({
      event: 'history_finished',
      reason: 'publication_failed',
      status: 'failed',
    });

    for (const reason of [
      'publication_conflict',
      'publication_limit_exceeded',
      'publication_not_derivable',
      'publication_segment_too_large',
    ]) {
      const stopped = world({ failPublication: { reason, sequence: 'lotes_historia_r_100' } });
      await seedGold(stopped);
      expect(await stopped.run(), reason).toEqual({ exitCode: 1, stderr: null });
      expect(stopped.lines.at(-1), reason).toMatchObject({
        reason: 'logs_skipped',
        skipped: [{ log: 1, sequence: 'lotes_historia_r_100' }],
      });
    }
  });

  it('un bloque que empieza después de la hora de corte pasa al log siguiente, salvo si el log no termina con un bloque', async () => {
    const due = { first: '2027-10-20T00:00:00.000Z', nextReadiness: 'ready' as const };
    const env = world({ logs: { lotes_historia_r_100: due } });
    await seedGold(env);
    expect(await env.run()).toEqual({ exitCode: 0, stderr: null });
    const r100 = (lines: readonly Record<string, unknown>[]) =>
      lines
        .filter(
          (line) =>
            line['event'] === 'history_block' && line['sequence'] === 'lotes_historia_r_100',
        )
        .map((line) => [line['log'], line['cut']]);
    expect(r100(env.lines)).toEqual([
      [2, { from: 1, to: 2 }],
      [2, { from: 1, to: 2 }],
    ]);

    // El log 1 termina con una conexión sin respuestas, de un intento que no terminó: el bloque
    // sigue en él, y el siguiente ya pasa al log 2.
    const junk = world({ logs: { lotes_historia_r_100: due } });
    await seedGold(junk);
    await writeBatchLog({
      ...junk.storesOf(logLocation(1, HISTORY_R_100_SEQUENCE)),
      runs: [{ atUtc: '2027-10-31T15:00:00.000Z', texts: [] }],
    });
    expect(await junk.run()).toEqual({ exitCode: 0, stderr: null });
    expect(r100(junk.lines)).toEqual([
      [1, null],
      [2, { from: 1, to: 2 }],
    ]);
  });

  it('la configuración no admite la credencial dueña', async () => {
    const env = world();
    const result = await env.run({ ...ENV, BUOH_DUENO_POSTGRES_PASSWORD: 'duena-sintetica-01234' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('BUOH_DUENO_POSTGRES_PASSWORD');
    expect(result.stderr).not.toContain('duena-sintetica-01234');
  });
});
