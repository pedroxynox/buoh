import { parseArgs } from 'node:util';

import type { JsonValue, SourceEvent } from '@buoh/contracts';
import { z } from 'zod';

import {
  loadBatchSchemas,
  responseValidators,
  runSequence,
  type BatchDependencies,
  type RunContext,
  type SequenceOutcome,
} from '../batch/command.js';
import { ConfigError, type WorkerConfig } from '../config.js';
import { historyProfileOf, isHistoryProfileKind } from '../deriv/batch-profile.js';
import { historyRequestsFrom } from '../deriv/batch-requests.js';
import { batchProfileKindOf } from '../deriv/batch-rounds.js';
import {
  blockOfRequest,
  historyAnswersIn,
  historyPlan,
  historyResumeIndex,
  type HistoryAnswer,
  type HistoryPlan,
} from '../deriv/history-pages.js';
import type { SessionLock } from '../deriv/session.js';
import type { RunChild } from '../operations/child.js';
import { UsageError } from '../replay-args.js';
import type { ClosedSourceSegment } from '../source-log/ports.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  HISTORY_SEQUENCES,
  logLocation,
  type LogLocation,
  type LogSequence,
} from '../successive-logs.js';
import { loadHistoryConfig, type HistoryConfig } from './config.js';

/**
 * El comando de la historia (precisión del PR 6c de ADR-0021 §9), para el proceso temporal que la
 * descarga y la publica (decisiones vigentes, «Proceso temporal de la historia»). En `production`,
 * con el bloqueo de las dos historias durante todo el proceso:
 *
 * 1. sigue cada historia desde su log (`historyResumeIndex`): después de la última petición
 *    respondida que guarda, sin volver a pedir ninguna; sin ninguna, desde el primer bloque que
 *    Deriv todavía guarda (`historyRequestsFrom`);
 * 2. pide un bloque cada vez, el más antiguo de las dos, porque Deriv borra primero lo más antiguo,
 *    al ritmo que permite Deriv, una petición cada `HISTORY_PACING_MS`, con lo mismo que el comando
 *    de los lotes (`runSequence`): su log, su corte, su esquema de fuente, raw primero, y el
 *    segmento cerrado al terminar. Un bloque que empieza lo pide desde el primer bloque que Deriv
 *    todavía guarda, y uno que sigue a medias, sin cortar el log, para que cada bloque vaya entero en
 *    un log;
 * 3. publica cada bloque terminado sin esperar turnos: lanza `datasets:publish --sequence` en un
 *    proceso aparte, con `buoh_publicacion` y el token `operaciones`, uno cada vez y mientras sigue
 *    pidiendo, hasta que no queda nada que publicar (`planHistoryDataset`: un bloque por dataset);
 * 4. termina cuando las dos historias están pedidas y publicadas.
 *
 * Un `RateLimit` espera `HISTORY_RATE_LIMIT_WAIT_MS` y sigue. Un bloque que falla espera
 * `HISTORY_RETRY_WAIT_MS` y lo vuelve a intentar, y a los `HISTORY_MAX_FAILURES` fallos seguidos el
 * proceso para. Una publicación que falla se repite después del bloque siguiente; un log cuya
 * publicación no cambia al repetirla (`STOPPING_PUBLICATION_REASONS`) se deja (`--skip`), como en el
 * paso 6, y el proceso termina con `logs_skipped`. Escribe en stdout una línea JSON por bloque, por
 * publicación y al empezar y al terminar, solo con códigos, nombres y números.
 */

/** Una petición cada 2,1 s: a ese ritmo, Deriv no respondió `RateLimit` a ninguna de 56 seguidas. */
export const HISTORY_PACING_MS = 2_100;
/** El plazo de un bloque: sus 17 peticiones como mucho, a su ritmo, caben de sobra. */
export const HISTORY_BLOCK_DEADLINE_MS = 10 * 60_000;
/** Lo que espera después de un `RateLimit`. */
export const HISTORY_RATE_LIMIT_WAIT_MS = 60_000;
/** Lo que espera después de un bloque que falla. */
export const HISTORY_RETRY_WAIT_MS = 60_000;
/** Los fallos seguidos de los bloques, o de la última publicación, con los que el proceso para. */
export const HISTORY_MAX_FAILURES = 10;

export const HISTORY_USAGE = 'Uso: history';

/**
 * Las publicaciones que repetir no cambia: el log se deja, como un log detenido del paso 6 de
 * `buoh-operaciones`.
 */
const STOPPING_PUBLICATION_REASONS = new Set([
  'publication_conflict',
  'publication_limit_exceeded',
  'publication_not_derivable',
  'publication_segment_too_large',
]);

/** Las filas de los segmentos cerrados de un log y sus source events, verificados. */
export interface HistorySegments {
  close(): Promise<void>;
  closed(from: number): Promise<readonly ClosedSourceSegment[]>;
  read(index: number): Promise<readonly SourceEvent[]>;
}

export interface HistoryDependencies extends Omit<BatchDependencies, 'deadlineMs' | 'pacingMs'> {
  /** Las lecturas de los segmentos cerrados de un log, con la configuración de la descarga. */
  readonly openSegments: (config: WorkerConfig, log: LogLocation) => HistorySegments;
  /** Corre `datasets:publish` en un proceso aparte (`runWorkerChild`). */
  readonly runChild: RunChild;
  /** Espera esos milisegundos. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Escribe una línea JSON en stdout. */
  readonly write: (line: Record<string, JsonValue>) => void;
}

/** Lo que el comando lleva de cada historia. */
interface HistoryState {
  /** Fallos seguidos de sus bloques. */
  failures: number;
  /** La primera petición que falta pedir. */
  next: number;
  readonly plan: HistoryPlan;
  readonly sequence: LogSequence;
}

function parseHistoryArgs(argv: readonly string[]): void {
  try {
    parseArgs({
      allowPositionals: false,
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      options: {},
      strict: true,
    });
  } catch {
    throw new UsageError(HISTORY_USAGE);
  }
}

/** El plan de la historia de una secuencia. */
function planOf(sequence: LogSequence): HistoryPlan {
  const kind = batchProfileKindOf(sequence);
  if (!isHistoryProfileKind(kind)) {
    throw new TypeError(`La secuencia ${sequence.name} no es una historia.`);
  }
  return historyPlan(historyProfileOf(kind));
}

/**
 * La primera petición que falta pedir de una historia, desde su log, o `null` si su log no tiene
 * ningún tramo respondido. Antes de leer cada log, cierra el segmento que pudo dejar abierto un
 * proceso anterior, como `runSequence`, para leer también lo que escribió. Lee los logs del activo
 * hacia atrás, y en cada uno los segmentos desde el último, hasta el primero con un tramo
 * respondido; las respuestas que siguen, de ese log o de otro posterior, también cuentan, como el
 * horario del bloque siguiente.
 */
async function resumeIndex(
  context: RunContext,
  deps: HistoryDependencies,
  state: HistoryState,
  lock: SessionLock,
): Promise<
  { readonly next: number | null } | { readonly detail: string; readonly reason: string }
> {
  const { config } = context;
  const reads = deps.openReads(config, state.sequence);
  try {
    const active = await reads.locateLog();
    if (active === null) {
      return { detail: 'none', reason: 'log_not_prepared' };
    }
    let later: HistoryAnswer[] = [];
    for (let number = active.number; number >= 1; number -= 1) {
      const location = logLocation(number, state.sequence);
      if ((await reads.firstWrite(location)) === null) {
        continue;
      }
      const handle = await deps.openLog(config, lock, location);
      try {
        await handle.log.close('requested');
      } finally {
        await handle.close().catch(() => undefined);
      }
      const segments = deps.openSegments(config, location);
      try {
        const rows = await segments.closed(0);
        const tail: HistoryAnswer[] = [];
        for (const row of [...rows].reverse()) {
          const answers = historyAnswersIn(
            await segments.read(row.segment_index),
            state.plan.profile,
          );
          tail.unshift(...answers);
          if (answers.some((answer) => answer.kind === 'tranche')) {
            break;
          }
        }
        later = [...tail, ...later];
        const next = historyResumeIndex(state.plan, later);
        if (next !== null) {
          return { next };
        }
      } finally {
        await segments.close().catch(() => undefined);
      }
    }
    return { next: null };
  } catch (error) {
    return { detail: failureReason(error), reason: 'log_unavailable' };
  } finally {
    await reads.close().catch(() => undefined);
  }
}

const publicationLineSchema = z.looseObject({
  dataset_id: z.string().max(128).optional(),
  duration_ms: z.number().int().min(0).optional(),
  first_segment: z.number().int().min(0).optional(),
  last_segment: z.number().int().min(0).optional(),
  log: z.number().int().min(1).nullable().optional(),
  max_rss_bytes: z.number().int().min(0).optional(),
  reason: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/u)
    .optional(),
  status: z.enum(['already_published', 'failed', 'nothing_due', 'published']),
});

/**
 * Las publicaciones de las historias: `datasets:publish --sequence` en un proceso aparte, una cada
 * vez, mientras alguna tiene un bloque terminado que publicar (`request`).
 */
class HistoryPublisher {
  readonly #deps: HistoryDependencies;
  readonly #env: Readonly<Record<string, string>>;
  readonly #pending = new Set<LogSequence>();
  readonly #skip = new Map<LogSequence, Set<number>>();
  #running: Promise<void> | null = null;
  /** Las publicaciones seguidas que fallaron, para el final. */
  failures = 0;
  /** Si la última vuelta de cada secuencia terminó sin nada que publicar. */
  readonly settled = new Set<LogSequence>();

  constructor(deps: HistoryDependencies, env: Readonly<Record<string, string>>) {
    this.#deps = deps;
    this.#env = env;
  }

  /** Pide publicar lo que tenga la secuencia. */
  request(sequence: LogSequence): void {
    this.#pending.add(sequence);
    this.settled.delete(sequence);
    this.#running ??= this.#loop().finally(() => {
      this.#running = null;
    });
  }

  /** Espera a que no quede ninguna publicación pedida. */
  async idle(): Promise<void> {
    while (this.#running !== null) {
      await this.#running;
    }
  }

  /** Los logs que se dejaron de cada secuencia. */
  skipped(sequence: LogSequence): readonly number[] {
    return [...(this.#skip.get(sequence) ?? [])].sort((left, right) => left - right);
  }

  async #loop(): Promise<void> {
    for (;;) {
      const sequence = this.#pending.values().next().value;
      if (sequence === undefined) {
        return;
      }
      const skip = this.skipped(sequence);
      const args = [
        '--sequence',
        sequence.name,
        ...(skip.length > 0 ? ['--skip', skip.join(',')] : []),
      ];
      let line: z.infer<typeof publicationLineSchema> | null = null;
      let reason: string | null = null;
      try {
        const result = await this.#deps.runChild('publish', args, this.#env);
        const parsed = publicationLineSchema.safeParse(lastLine(result.stdout));
        if (parsed.success) {
          line = parsed.data;
        } else {
          reason = result.timedOut
            ? 'child_timeout'
            : result.exitCode === null
              ? 'child_killed'
              : 'publish_output_invalid';
        }
      } catch (error) {
        reason = failureReason(error);
      }
      const status = line?.status ?? 'failed';
      this.#deps.write({
        event: 'history_publication',
        sequence: sequence.name,
        status,
        ...(line === null
          ? { reason }
          : {
              ...pick(line, [
                'dataset_id',
                'duration_ms',
                'first_segment',
                'last_segment',
                'log',
                'max_rss_bytes',
                'reason',
              ]),
            }),
      });
      if (status === 'published' || status === 'already_published') {
        this.failures = 0;
        continue;
      }
      this.#pending.delete(sequence);
      if (status === 'nothing_due') {
        this.failures = 0;
        this.settled.add(sequence);
        continue;
      }
      this.failures += 1;
      const log = line?.log;
      if (line?.reason !== undefined && STOPPING_PUBLICATION_REASONS.has(line.reason) && log) {
        // Como el paso 6: ese log no se puede publicar con este código, y los demás siguen.
        const set = this.#skip.get(sequence) ?? new Set<number>();
        set.add(log);
        this.#skip.set(sequence, set);
        this.#pending.add(sequence);
      }
    }
  }
}

/** La última línea no vacía de stdout, como JSON, o `null`. */
function lastLine(stdout: string): unknown {
  const line = stdout
    .split('\n')
    .filter((item) => item.trim().length > 0)
    .at(-1);
  if (line === undefined) {
    return null;
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function pick(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, JsonValue> {
  const picked: Record<string, JsonValue> = {};
  for (const key of keys) {
    const item = value[key];
    if (item !== undefined) {
      picked[key] = item as JsonValue;
    }
  }
  return picked;
}

/** La historia que toca: la que tiene pendiente el bloque más antiguo. */
function nextState(states: readonly HistoryState[]): HistoryState | null {
  let chosen: HistoryState | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const state of states) {
    if (state.next >= state.plan.requests.length) {
      continue;
    }
    const start = state.plan.blocks[blockOfRequest(state.plan, state.next)]?.start ?? 0;
    if (start < oldest) {
      oldest = start;
      chosen = state;
    }
  }
  return chosen;
}

function outcomeLine(outcome: SequenceOutcome): Record<string, JsonValue> {
  return { event: 'history_block', ...(outcome as unknown as Record<string, JsonValue>) };
}

/**
 * `history`: el proceso temporal de la historia. Devuelve 0 cuando las dos historias están pedidas
 * y publicadas; 1 si para por sus fallos, sin los esquemas o sin el bloqueo; 2 con un error de uso o
 * de configuración, con su línea en stderr.
 */
export async function historyCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: HistoryDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly stderr: string | null }> {
  let config: HistoryConfig;
  try {
    parseHistoryArgs(argv);
    config = loadHistoryConfig(env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      return {
        exitCode: 2,
        stderr: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
      };
    }
    throw error;
  }
  const finish = (status: 'completed' | 'failed', rest: Record<string, JsonValue> = {}) => {
    deps.write({ event: 'history_finished', status, ...rest });
    return { exitCode: status === 'completed' ? (0 as const) : (1 as const), stderr: null };
  };
  const loaded = await loadBatchSchemas(deps);
  if (loaded.status === 'failed') {
    return finish('failed', { detail: loaded.detail, reason: loaded.reason });
  }

  const locks = new Map<LogSequence, SessionLock>();
  const release = async () => {
    for (const lock of locks.values()) {
      await lock.release();
    }
  };
  try {
    for (const sequence of HISTORY_SEQUENCES) {
      let lock: SessionLock | null;
      try {
        lock = await deps.acquireLock(config.download, sequence);
      } catch (error) {
        return finish('failed', {
          detail: failureReason(error),
          reason: 'lock_unavailable',
          sequence: sequence.name,
        });
      }
      if (lock === null) {
        return finish('failed', { reason: 'lock_busy', sequence: sequence.name });
      }
      locks.set(sequence, lock);
    }
    const held = (sequence: LogSequence): SessionLock => {
      const lock = locks.get(sequence);
      if (lock === undefined) {
        throw new TypeError(`Sin el bloqueo de ${sequence.name}.`);
      }
      return lock;
    };
    const context: RunContext = {
      config: config.download,
      deadlineUtc: deps.now(),
      deps: {
        ...deps,
        // El bloqueo de cada historia es de todo el proceso (`keepLock`).
        acquireLock: (_config, sequence) => Promise.resolve(held(sequence)),
        pacingMs: HISTORY_PACING_MS,
      },
      halt: null,
      lastSentUtc: null,
      schemas: loaded.schemas,
      validators: responseValidators(loaded.schemas),
    };

    const states: HistoryState[] = [];
    for (const sequence of HISTORY_SEQUENCES) {
      const state: HistoryState = { failures: 0, next: 0, plan: planOf(sequence), sequence };
      let failures = 0;
      for (;;) {
        const resumed = await resumeIndex(context, deps, state, held(sequence));
        if ('next' in resumed) {
          state.next =
            resumed.next ?? historyRequestsFrom(state.plan.blocks, Date.parse(deps.now()));
          break;
        }
        failures += 1;
        deps.write({ event: 'history_resume_failed', sequence: sequence.name, ...resumed });
        if (failures >= HISTORY_MAX_FAILURES) {
          return finish('failed', { reason: resumed.reason, sequence: sequence.name });
        }
        await deps.sleep(HISTORY_RETRY_WAIT_MS);
      }
      states.push(state);
    }
    deps.write({
      event: 'history_started',
      sequences: states.map((state) => ({
        next: state.next,
        requests: state.plan.requests.length,
        sequence: state.sequence.name,
      })),
    });

    const publisher = new HistoryPublisher(deps, config.publish);
    // Lo que dejó terminado un proceso anterior, sin publicar.
    for (const state of states) {
      publisher.request(state.sequence);
    }

    for (let state = nextState(states); state !== null; state = nextState(states)) {
      const { plan } = state;
      if (!held(state.sequence).held) {
        // Sin el bloqueo, otro proceso pudo escribir: el proceso para, y el siguiente sigue desde
        // el log.
        await publisher.idle();
        return finish('failed', { reason: 'source_lock_lost', sequence: state.sequence.name });
      }
      let block = blockOfRequest(plan, state.next);
      const first = plan.firsts[block] ?? 0;
      if (state.next === first) {
        // Un bloque que empieza: el primero que Deriv todavía guarda, si este ya no.
        state.next = Math.max(state.next, historyRequestsFrom(plan.blocks, Date.parse(deps.now())));
        if (state.next >= plan.requests.length) {
          continue;
        }
        block = blockOfRequest(plan, state.next);
      }
      const startsBlock = state.next === plan.firsts[block];
      const until = plan.firsts[block + 1] ?? plan.requests.length;
      context.deadlineUtc = new Date(
        Date.parse(deps.now()) + HISTORY_BLOCK_DEADLINE_MS,
      ).toISOString();
      context.halt = null;
      const outcome = await runSequence(
        context,
        state.sequence,
        {
          abandoned: null,
          from: state.next,
          requests: plan.requests,
          round: new Date((plan.blocks[block]?.start ?? 0) * 1000).toISOString(),
          until,
        },
        null,
        { allowCut: startsBlock, keepLock: true },
      );
      deps.write(outcomeLine(outcome));
      state.next = outcome.next;
      if (outcome.status === 'completed') {
        state.failures = 0;
        publisher.request(state.sequence);
        continue;
      }
      if (outcome.reason === 'rate_limit') {
        await deps.sleep(HISTORY_RATE_LIMIT_WAIT_MS);
        continue;
      }
      state.failures += 1;
      if (state.failures >= HISTORY_MAX_FAILURES) {
        await publisher.idle();
        return finish('failed', {
          reason: outcome.reason ?? 'block_failed',
          sequence: state.sequence.name,
        });
      }
      await deps.sleep(HISTORY_RETRY_WAIT_MS);
    }

    // Todo pedido: publica lo que quede, y repite lo que falló.
    for (;;) {
      await publisher.idle();
      const pending = states.filter((state) => !publisher.settled.has(state.sequence));
      if (pending.length === 0) {
        break;
      }
      if (publisher.failures >= HISTORY_MAX_FAILURES) {
        return finish('failed', { reason: 'publication_failed' });
      }
      await deps.sleep(HISTORY_RETRY_WAIT_MS);
      for (const state of pending) {
        publisher.request(state.sequence);
      }
    }
    const skipped = states.flatMap((state) =>
      publisher.skipped(state.sequence).map((log) => ({ log, sequence: state.sequence.name })),
    );
    return skipped.length === 0
      ? finish('completed')
      : finish('failed', { reason: 'logs_skipped', skipped });
  } finally {
    await release();
  }
}
