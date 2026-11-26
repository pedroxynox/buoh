import { parseArgs } from 'node:util';

import type { JsonValue } from '@buoh/contracts';
import {
  CONTRACT_SCHEMA_VERSION,
  compileSourceSchema,
  createCatalogResponseSchema,
  relaxContractsForResponseSchema,
} from '@buoh/domain';
import { z } from 'zod';

import { ConfigError, loadConfig, type WorkerConfig } from '../config.js';
import { DERIV_BATCH_CONNECTOR_VERSION, derivBatchLogProfileRow } from '../deriv/batch-profile.js';
import {
  runBatchExchange,
  writeFailureOf,
  type BatchExchangeRequest,
  type BatchStop,
} from '../deriv/batch-client.js';
import { encodeBatchRequest } from '../deriv/batch-requests.js';
import { batchProfileKindOf, batchRound, type BatchCursor } from '../deriv/batch-rounds.js';
import { REQUEST_TIMEOUT_MS } from '../deriv/connection.js';
import type { Scheduler } from '../deriv/ports.js';
import { DERIV_PUBLIC_ENDPOINT, DERIV_SOURCE } from '../deriv/profile.js';
import {
  downloadSchemaArchive,
  openSchemaArchive,
  SCHEMA_DOWNLOAD_TIMEOUT_MS,
  type DerivSchemaSet,
} from '../deriv/schema-archive.js';
import {
  DERIV_BATCH_OPERATIONS,
  DERIV_SCHEMA_RELEASE,
  type BatchOperation,
  type ExpectedSchemaArchive,
} from '../deriv/schema-release.js';
import type { SessionLock } from '../deriv/session.js';
import { CONNECT_TIMEOUT_MS, type SocketFactory } from '../deriv/socket.js';
import { buildRawSourceFrame } from '../ingestion/raw-first-ingestor.js';
import type { StartupReads } from '../ingest-startup.js';
import { cutTimeOf } from '../log-cut.js';
import { UsageError } from '../replay-args.js';
import { failureReason, type SourceEventLog } from '../source-log/source-event-log.js';
import {
  BATCH_SEQUENCES,
  logLocation,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  type LogLocation,
  type LogSequence,
} from '../successive-logs.js';

/**
 * El comando de los lotes (ADR-0021 §3; precisión del PR 5c1 de su §9): en `production`, pide a
 * Deriv lo que le toca a cada secuencia por lotes (`batchRound`) y lo guarda en su log activo, raw
 * primero, con la política de segmentos 2.0.0. Lo lanza `buoh-operaciones` en un proceso aparte,
 * con `buoh_lotes` y el token `lotes`, y le pasa lo que ya pidió cada secuencia (`--state`); el
 * comando no guarda ese estado: lo escribe en su línea, y lo guarda quien lo lanza.
 *
 * Las secuencias van de una en una, en el orden de `BATCH_SEQUENCES`, cada una con su bloqueo, su
 * log y su conexión, y el ritmo de Deriv vale para todas: una petición cada `BATCH_PACING_MS` como
 * mucho. En cada una:
 *
 * 1. si no le toca nada, no abre nada (`idle`);
 * 2. toma su bloqueo, o lo deja si lo tiene otro (`skipped` con `lock_busy`);
 * 3. busca su log activo (`log_not_prepared` si no hay ninguno). Si su hora de corte, el primer lunes
 *    a las 00:00 UTC después de su primera escritura (`cutTimeOf`), ya pasó, escribe en el log
 *    siguiente si está preparado (`cut`), sin esperar un momento limpio, porque no hay conexión
 *    continua; si no lo está, sigue en el activo y lo dice (`cut_blocked`). El log en que escribe no
 *    puede tener migraciones pendientes (`migrations_pending`) y tiene que tener la fila del perfil
 *    de su secuencia (`log_not_derivable`; ADR-0020 §4);
 * 4. cierra el segmento que una ejecución anterior pudo dejar abierto, al fallar al escribir o al
 *    cortarse, en el log en que escribe y, con un corte, también en el que deja, para que ningún
 *    segmento mezcle dos ejecuciones; si un fallo es del log que deja, la línea da ese log y no hay
 *    corte. Si para entonces ya pasó el plazo, no conecta (`deadline`). Si no, abre una conexión,
 *    escribe su apertura, pide lo que le toca y escribe su cierre (`runBatchExchange`), y cierra el
 *    segmento abierto (`requested`), salvo si una escritura falló.
 *
 * Un límite de peticiones de Deriv (`rate_limit`) o el plazo (`deadline`) paran también las
 * secuencias siguientes (`skipped`); lo que no se pidió lo pide la ejecución siguiente.
 */

/** La separación mínima entre dos envíos (ADR-0021 §3: a una cada 1,5 s, 69 seguidas sin límite). */
export const BATCH_PACING_MS = 1_500;
/** Desde el arranque del comando, después de esto no envía ninguna petición más ni conecta. */
export const BATCH_DEADLINE_MS = 70_000;
/** Lo que espera el aviso de cierre de una conexión antes de cortarla. */
export const BATCH_CLOSE_TIMEOUT_MS = 5_000;

export const BATCH_USAGE = 'Uso: batch -- --json [--state <json>]';

/** La identidad de los frames de los lotes: la fuente y su conector (ADR-0021 §3). */
const BATCH_IDENTITY = {
  connector_version: DERIV_BATCH_CONNECTOR_VERSION,
  source: DERIV_SOURCE,
} as const;

/** El log de los lotes abierto con su bloqueo y sus almacenes. */
export interface BatchLogHandle {
  /** Libera sus almacenes. */
  close(): Promise<void>;
  readonly log: SourceEventLog;
}

export interface BatchDependencies {
  /** El bloqueo de la secuencia, o `null` si lo tiene otro proceso (`SourceLock.acquire`). */
  readonly acquireLock: (
    config: WorkerConfig,
    sequence: LogSequence,
  ) => Promise<SessionLock | null>;
  readonly connect: SocketFactory;
  /**
   * Desde el arranque, después de esto no envía ni conecta; por defecto, `BATCH_DEADLINE_MS`.
   */
  readonly deadlineMs?: number;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  /** UUIDv7 de cada conexión y de cada evento. */
  readonly nextId: () => string;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  /**
   * Abre el log con el bloqueo y la política `BATCH_SEGMENT_POLICY`: en el comando,
   * `openLockedSourceLog` sobre `openStores` del log (`withLog`).
   */
  readonly openLog: (
    config: WorkerConfig,
    lock: SessionLock,
    log: LogLocation,
  ) => Promise<BatchLogHandle>;
  /** Las lecturas del log activo y del corte de la secuencia: `openStartupReads`. */
  readonly openReads: (config: WorkerConfig, sequence: LogSequence) => StartupReads;
  /** La separación mínima entre envíos; por defecto, `BATCH_PACING_MS`. */
  readonly pacingMs?: number;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
}

export interface BatchCommandResult {
  /** 0 si ninguna secuencia falló; 1 si alguna falló o no se cargaron los esquemas; 2, uso o configuración. */
  readonly exitCode: 0 | 1 | 2;
  /** La línea del error de uso o de configuración, o `null`. */
  readonly stderr: string | null;
  /** La línea del resultado, o `null` con un error de uso o de configuración. */
  readonly stdout: string | null;
}

/** Cuántas respuestas de cada operación trajeron un error de Deriv, por código, y cuántas fallaron su esquema. */
interface ResponseCounts {
  readonly errors: Partial<Record<BatchOperation, Record<string, number>>>;
  readonly schema_failures: Partial<Record<BatchOperation, number>>;
  unexpected: number;
}

/** Cómo terminó el comando en una secuencia. */
export const BATCH_SEQUENCE_STATUSES = [
  'completed',
  'failed',
  'idle',
  'skipped',
  'stopped',
] as const;
type SequenceStatus = (typeof BATCH_SEQUENCE_STATUSES)[number];

/** Lo que hizo el comando en una secuencia. */
interface SequenceOutcome {
  readonly abandoned: { readonly remaining: number; readonly round: string } | null;
  readonly answered: number;
  readonly cut: { readonly from: number; readonly to: number } | null;
  readonly cut_blocked: string | null;
  readonly detail: string | null;
  readonly errors: ResponseCounts['errors'];
  readonly from: number;
  readonly log: number | null;
  readonly next: number;
  readonly reason: string | null;
  readonly round: string;
  readonly schema_failures: ResponseCounts['schema_failures'];
  readonly sent: number;
  readonly sequence: string;
  readonly status: SequenceStatus;
  readonly unexpected: number;
  readonly until: number;
}

/**
 * El estado que recibe y que devuelve: el cursor de cada secuencia por lotes que ya pidió algo. Lo
 * guarda `buoh-operaciones` (precisión del PR 5c2 de ADR-0021 §9).
 */
export const batchStateSchema = z.partialRecord(
  z.enum(BATCH_SEQUENCES.map((sequence) => sequence.name) as [string, ...string[]]),
  z.strictObject({
    next: z.number().int().min(0).max(100_000),
    round: z
      .string()
      .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)?$/u),
  }),
);
type BatchState = Partial<Record<string, BatchCursor>>;

function parseBatchArgs(argv: readonly string[]): { readonly state: BatchState } {
  let values: { json?: boolean; state?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      options: { json: { type: 'boolean' }, state: { type: 'string' } },
      strict: true,
    }));
  } catch {
    throw new UsageError(BATCH_USAGE);
  }
  if (values.json !== true) {
    throw new UsageError(`--json es obligatorio. ${BATCH_USAGE}`);
  }
  if (values.state === undefined) {
    return { state: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(values.state);
  } catch {
    throw new UsageError(`--state no es JSON. ${BATCH_USAGE}`);
  }
  const state = batchStateSchema.safeParse(parsed);
  if (!state.success) {
    throw new UsageError(`--state no es el estado de los lotes. ${BATCH_USAGE}`);
  }
  return { state: state.data };
}

/** La configuración: solo en `production`, donde están las secuencias por lotes, y sin esquema. */
function loadBatchConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const rejected = new Set<string>();
  let config: WorkerConfig | null = null;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    for (const variable of error.variables) {
      rejected.add(variable);
    }
  }
  if (env['BUOH_DEPLOYMENT_ENVIRONMENT'] !== 'production') {
    rejected.add('BUOH_DEPLOYMENT_ENVIRONMENT');
  }
  for (const variable of productionLogConfigErrors(env)) {
    rejected.add(variable);
  }
  if (config === null || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
  }
  return config;
}

/** Los esquemas de respuesta con que se cuentan los fallos de esquema (relevo del PR 5a). */
type ResponseValidators = Readonly<Record<BatchOperation, (value: unknown) => boolean>>;

/**
 * Los validadores de respuesta de los lotes: los de la release, salvo `active_symbols`, con
 * `relaxCatalogResponseSchema` (`createCatalogResponseSchema`), y `contracts_for`, con
 * `relaxContractsForResponseSchema` (precisión del PR 5a de ADR-0012 §2), como los aplicarán las
 * reglas de los lotes.
 */
function responseValidators(schemas: DerivSchemaSet<BatchOperation>): ResponseValidators {
  const catalog = createCatalogResponseSchema({
    source_schema_bytes: schemas.schema('active_symbols', 'response').bytes,
    source_schema_release: schemas.release,
  });
  // Los bytes de la release ya pasaron su SHA-256 y su compilación al abrir el archivo.
  const contractsFor = compileSourceSchema(
    relaxContractsForResponseSchema(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          schemas.schema('contracts_for', 'response').bytes,
        ),
      ) as JsonValue,
    ),
  );
  return {
    active_symbols: catalog.validate,
    contracts_for: contractsFor,
    proposal: schemas.schema('proposal', 'response').validate,
    ticks_history: schemas.schema('ticks_history', 'response').validate,
    trading_times: schemas.schema('trading_times', 'response').validate,
  };
}

/** La operación de cada `msg_type` que responde a una petición de los lotes. */
const OPERATION_OF_MSG_TYPE: Readonly<Record<string, BatchOperation>> = {
  active_symbols: 'active_symbols',
  candles: 'ticks_history',
  contracts_for: 'contracts_for',
  proposal: 'proposal',
  ticks_history: 'ticks_history',
  trading_times: 'trading_times',
};

const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Cuenta una respuesta ya durable: su error de Deriv, por código, o si falla su esquema. */
function countResponse(text: string, validators: ResponseValidators, counts: ResponseCounts): void {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    counts.unexpected += 1;
    return;
  }
  const record =
    typeof root === 'object' && root !== null && !Array.isArray(root)
      ? (root as Record<string, JsonValue>)
      : null;
  const msgType = record?.['msg_type'];
  const operation = typeof msgType === 'string' ? OPERATION_OF_MSG_TYPE[msgType] : undefined;
  if (record === null || operation === undefined) {
    counts.unexpected += 1;
    return;
  }
  const error = record['error'];
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const code =
      typeof error['code'] === 'string' && CODE.test(error['code']) ? error['code'] : 'unknown';
    const byCode = (counts.errors[operation] ??= {});
    byCode[code] = (byCode[code] ?? 0) + 1;
    return;
  }
  if (!validators[operation](root)) {
    counts.schema_failures[operation] = (counts.schema_failures[operation] ?? 0) + 1;
  }
}

/** Dónde escribe la secuencia: el log activo o, pasada su hora de corte, el siguiente preparado. */
async function targetLog(
  reads: StartupReads,
  sequence: LogSequence,
  nowUtc: string,
): Promise<
  | {
      readonly cut: SequenceOutcome['cut'];
      readonly cutBlocked: string | null;
      readonly log: LogLocation;
      /** Con un corte, el log activo, que deja de escribirse. */
      readonly previous: LogLocation | null;
    }
  | { readonly reason: string }
> {
  const active = await reads.locateLog();
  if (active === null) {
    return { reason: 'log_not_prepared' };
  }
  const first = await reads.firstWrite(active);
  if (first === null || Date.parse(nowUtc) < Date.parse(cutTimeOf(first))) {
    return { cut: null, cutBlocked: null, log: active, previous: null };
  }
  if (active.number >= MAX_LOG_NUMBER) {
    return { cut: null, cutBlocked: 'log_number_exhausted', log: active, previous: null };
  }
  const next = logLocation(active.number + 1, sequence);
  const readiness = await reads.readiness(next);
  return readiness === 'ready'
    ? {
        cut: { from: active.number, to: next.number },
        cutBlocked: null,
        log: next,
        previous: active,
      }
    : { cut: null, cutBlocked: `next_log_${readiness}`, log: active, previous: null };
}

interface RunContext {
  readonly config: WorkerConfig;
  readonly deadlineUtc: string;
  readonly deps: BatchDependencies;
  /**
   * `rate_limit` desde que una respuesta durable fue un `RateLimit`, o `deadline` desde que una
   * secuencia paró por el plazo: las secuencias siguientes ya no empiezan.
   */
  halt: string | null;
  lastSentUtc: string | null;
  readonly schemas: DerivSchemaSet<BatchOperation>;
  readonly validators: ResponseValidators;
}

/** Una secuencia: su vuelta, su bloqueo, su log y su conexión. */
async function runSequence(
  context: RunContext,
  sequence: LogSequence,
  cursor: BatchCursor | null,
  skip: string | null,
): Promise<SequenceOutcome> {
  const { config, deps } = context;
  const due = batchRound(sequence, deps.now(), cursor);
  const counts: ResponseCounts = { errors: {}, schema_failures: {}, unexpected: 0 };
  let log: number | null = null;
  let cut: SequenceOutcome['cut'] = null;
  let cutBlocked: string | null = null;
  const outcome = (
    status: SequenceStatus,
    rest: { answered?: number; detail?: string | null; reason?: string | null; sent?: number } = {},
  ): SequenceOutcome => ({
    abandoned: due.abandoned,
    answered: rest.answered ?? 0,
    cut,
    cut_blocked: cutBlocked,
    detail: rest.detail ?? null,
    errors: counts.errors,
    from: due.from,
    log,
    next: due.from + (rest.answered ?? 0),
    reason: rest.reason ?? null,
    round: due.round,
    schema_failures: counts.schema_failures,
    sent: rest.sent ?? 0,
    sequence: sequence.name,
    status,
    unexpected: counts.unexpected,
    until: due.until,
  });
  if (due.from >= due.until) {
    return outcome('idle');
  }
  if (skip !== null) {
    return outcome('skipped', { reason: skip });
  }
  const requests: BatchExchangeRequest[] = [];
  for (const [index, request] of due.requests.slice(due.from, due.until).entries()) {
    const reqId = index + 1;
    const text = encodeBatchRequest(context.schemas, request, reqId);
    if (text === null) {
      return outcome('failed', { detail: request.operation, reason: 'request_invalid' });
    }
    requests.push({ operation: request.operation, reqId, text });
  }
  const expectedProfile = derivBatchLogProfileRow(batchProfileKindOf(sequence));

  let lock: SessionLock | null;
  try {
    lock = await deps.acquireLock(config, sequence);
  } catch (error) {
    return outcome('failed', { detail: failureReason(error), reason: 'lock_unavailable' });
  }
  if (lock === null) {
    return outcome('skipped', { reason: 'lock_busy' });
  }
  const reads = deps.openReads(config, sequence);
  let handle: BatchLogHandle | null = null;
  try {
    let target: LogLocation;
    let previous: LogLocation | null;
    try {
      const found = await targetLog(reads, sequence, deps.now());
      if ('reason' in found) {
        return outcome('failed', { reason: found.reason });
      }
      ({ cut, previous } = found);
      cutBlocked = found.cutBlocked;
      target = found.log;
      log = target.number;
      if ((await reads.pendingMigrations(target)).length > 0) {
        return outcome('failed', { reason: 'migrations_pending' });
      }
      const profile = await reads.logProfile(target);
      if (profile === null) {
        return outcome('failed', { detail: 'profile_missing', reason: 'log_not_derivable' });
      }
      if (
        profile.profile_id !== expectedProfile.profile_id ||
        profile.quality_profile_sha256 !== expectedProfile.quality_profile_sha256
      ) {
        return outcome('failed', { detail: 'profile_mismatch', reason: 'log_not_derivable' });
      }
    } catch (error) {
      return outcome('failed', { detail: failureReason(error), reason: 'log_unavailable' });
    }
    // Un segmento que dejó abierto una ejecución anterior, porque falló al escribir o la cortaron,
    // se cierra antes de seguir: ningún segmento mezcla dos ejecuciones. Con un corte, el del log
    // que deja de escribirse, que nadie volverá a abrir para escribir.
    for (const location of previous === null ? [target] : [previous, target]) {
      // Un fallo en el log que se deja es de ese log, y el corte no llega a hacerse.
      const failedIn = () => {
        if (location !== target) {
          log = location.number;
          cut = null;
        }
      };
      let current: BatchLogHandle;
      try {
        current = await deps.openLog(config, lock, location);
      } catch (error) {
        failedIn();
        return outcome('failed', { detail: failureReason(error), reason: 'log_open_failed' });
      }
      try {
        await current.log.close('requested');
      } catch (error) {
        await current.close().catch(() => undefined);
        failedIn();
        return outcome('failed', { detail: writeFailureOf(error), reason: 'persistence_failed' });
      }
      if (location === target) {
        handle = current;
      } else {
        await current.close().catch(() => undefined);
      }
    }
    if (handle === null) {
      throw new TypeError('El log de la secuencia no se abrió.');
    }
    if (Date.parse(deps.now()) >= Date.parse(context.deadlineUtc)) {
      // Sin conectar: lo que tardó en abrirse el log ya pasó del plazo.
      context.halt ??= 'deadline';
      return outcome('stopped', { reason: 'deadline' });
    }
    const opened = handle.log;
    const result = await runBatchExchange({
      closeTimeoutMs: BATCH_CLOSE_TIMEOUT_MS,
      closed: async (input) => {
        await opened.append({
          affected_symbols: [],
          closure_type: input.closure_type,
          connection_id: input.connection_id,
          event_id: deps.nextId(),
          kind: 'connection_closed',
          occurred_at_utc: input.at_utc,
          reason: input.reason,
          schema_version: CONTRACT_SCHEMA_VERSION,
          source: DERIV_SOURCE,
        });
      },
      connect: deps.connect,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      deadlineUtc: context.deadlineUtc,
      endpoint: DERIV_PUBLIC_ENDPOINT,
      frame: async (frame) => {
        await opened.append(buildRawSourceFrame(frame, BATCH_IDENTITY));
        countResponse(frame.payload_utf8, context.validators, counts);
      },
      nextId: deps.nextId,
      now: deps.now,
      opened: async (input) => {
        await opened.append({
          connection_id: input.connection_id,
          event_id: deps.nextId(),
          kind: 'connection_opened',
          occurred_at_utc: input.at_utc,
          schema_version: CONTRACT_SCHEMA_VERSION,
          source: DERIV_SOURCE,
          supersedes_connection_id: null,
        });
      },
      pacingMs: deps.pacingMs ?? BATCH_PACING_MS,
      previousSentUtc: context.lastSentUtc,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      requests,
      scheduler: deps.scheduler,
    });
    context.lastSentUtc = result.last_sent_utc;
    if (result.rate_limited) {
      // También si después falló una escritura, o si el RateLimit llegó con otra parada.
      context.halt ??= 'rate_limit';
    } else if (result.stopped?.reason === 'deadline') {
      context.halt ??= 'deadline';
    }
    const done = { answered: result.answered, sent: result.sent };
    if (result.write_failure !== null) {
      return outcome('failed', {
        ...done,
        detail: result.write_failure,
        reason: 'persistence_failed',
      });
    }
    try {
      // Al terminar, el segmento se cierra: la ejecución siguiente no tiene que releerlo.
      await opened.close('requested');
    } catch (error) {
      return outcome('failed', {
        ...done,
        detail: writeFailureOf(error),
        reason: 'persistence_failed',
      });
    }
    return result.stopped === null
      ? outcome(result.answered === requests.length ? 'completed' : 'stopped', done)
      : outcome('stopped', { ...done, ...stopFields(result.stopped) });
  } finally {
    await handle?.close().catch(() => undefined);
    await reads.close().catch(() => undefined);
    await lock.release();
  }
}

const stopFields = (stop: BatchStop) => ({ detail: stop.detail, reason: stop.reason });

/** Descarga y abre la release fijada con las operaciones de los lotes, con su plazo. */
async function loadBatchSchemas(
  deps: BatchDependencies,
): Promise<
  | { readonly schemas: DerivSchemaSet<BatchOperation>; readonly status: 'loaded' }
  | { readonly detail: string | null; readonly reason: string; readonly status: 'failed' }
> {
  const controller = new AbortController();
  const cancel = deps.scheduler.schedule(SCHEMA_DOWNLOAD_TIMEOUT_MS, () => {
    controller.abort();
  });
  try {
    const download = await downloadSchemaArchive({
      fetch: deps.fetch,
      signal: controller.signal,
      url: deps.schemaUrl ?? DERIV_SCHEMA_RELEASE.archive_url,
    });
    const result = download.ok
      ? openSchemaArchive(
          download.bytes,
          deps.expected ?? DERIV_SCHEMA_RELEASE,
          DERIV_BATCH_OPERATIONS,
        )
      : download.failure;
    return result.status === 'loaded'
      ? { schemas: result.schemas, status: 'loaded' }
      : { detail: result.detail, reason: result.reason, status: 'failed' };
  } finally {
    cancel();
  }
}

/**
 * `batch -- --json [--state <json>]`: una línea JSON con lo que hizo en cada secuencia por lotes y
 * su estado nuevo. Salida 0 si ninguna falló; 1 si alguna falló o no se cargaron los esquemas; 2,
 * con la línea del error en stderr, si el uso o la configuración no valen.
 */
export async function batchCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: BatchDependencies,
): Promise<BatchCommandResult> {
  let state: BatchState;
  let config: WorkerConfig;
  try {
    ({ state } = parseBatchArgs(argv));
    config = loadBatchConfig(env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      return {
        exitCode: 2,
        stderr: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
        stdout: null,
      };
    }
    throw error;
  }
  const startedMs = Date.parse(deps.now());
  const loaded = await loadBatchSchemas(deps);
  if (loaded.status === 'failed') {
    return {
      exitCode: 1,
      stderr: null,
      stdout: JSON.stringify({
        detail: loaded.detail,
        reason: loaded.reason,
        schemas: null,
        sequences: [],
        state,
        status: 'failed',
      }),
    };
  }
  const context: RunContext = {
    config,
    deadlineUtc: new Date(startedMs + (deps.deadlineMs ?? BATCH_DEADLINE_MS)).toISOString(),
    deps,
    halt: null,
    lastSentUtc: null,
    schemas: loaded.schemas,
    validators: responseValidators(loaded.schemas),
  };
  const sequences: SequenceOutcome[] = [];
  const next: BatchState = { ...state };
  let skip: string | null = null;
  for (const sequence of BATCH_SEQUENCES) {
    if (skip === null && Date.parse(deps.now()) >= Date.parse(context.deadlineUtc)) {
      skip = 'deadline';
    }
    const done = await runSequence(context, sequence, state[sequence.name] ?? null, skip);
    sequences.push(done);
    // Lo respondido ya es durable, también si después algo falló; una vuelta nueva empieza en 0
    // aunque todavía no se pida nada, y la anterior queda en `abandoned`.
    next[sequence.name] = { next: done.next, round: done.round };
    skip ??= context.halt;
  }
  const failed = sequences.some((item) => item.status === 'failed');
  return {
    exitCode: failed ? 1 : 0,
    stderr: null,
    stdout: JSON.stringify({
      schemas: { archive_sha256: loaded.schemas.archive_sha256, release: loaded.schemas.release },
      sequences,
      state: next,
      status: failed ? 'failed' : 'completed',
    }),
  };
}
