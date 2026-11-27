import { parseArgs } from 'node:util';

import type { SourceEvent } from '@buoh/contracts';
import { createBatchLogConfig } from '@buoh/domain';

import { ConfigError, loadConfig, type WorkerConfig } from '../config.js';
import {
  batchLogConfigOptions,
  batchProfileBytes,
  DERIV_BATCH_CONNECTOR_VERSION,
  derivBatchLogProfileRow,
  historyProfileOf,
  isHistoryProfileKind,
  type BatchProfileKind,
} from '../deriv/batch-profile.js';
import { historyPlan } from '../deriv/history-pages.js';
import { batchProfileKindOf } from '../deriv/batch-rounds.js';
import type { LogQualityProfileRow } from '../deriv/log-profile.js';
import { createDerivPublicationProfileFromSourceSchema, DERIV_SOURCE } from '../deriv/profile.js';
import type { ExpectedSchemaArchive } from '../deriv/schema-release.js';
import {
  readStoredBatchSourceSchema,
  readStoredSourceSchema,
  type StoredSourceSchema,
} from '../deriv/stored-source-schema.js';
import {
  CommitOutcomeUnknownError,
  PublicationConflictError,
  PublicationError,
  PublicationLimitError,
} from '../errors.js';
import {
  OperationalRegistry,
  type OperationalAlert,
  type OperationalStore,
} from '../operational/registry.js';
import type { DatasetStore, ObjectStore } from '../ports.js';
import type { ClosedSourceSegment, SourceLogStore } from '../source-log/ports.js';
import {
  failureReason,
  LogIntegrityError,
  LogReadError,
  SourceEventLog,
} from '../source-log/source-event-log.js';
import {
  BATCH_SEQUENCES,
  isLogExpired,
  LOG_RETENTION_MS,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  R_100_SEQUENCE,
  type CaptureLog,
  type LogLocation,
  type LogSequence,
} from '../successive-logs.js';
import { batchElementsOf, planBatchDataset, planHistoryDataset } from './batch-plan.js';
import { DATASETS_SCHEMA } from './location.js';
import { planDataset, type DatasetPlan } from './plan.js';
import { publishLiveDataset, type PublishLiveDatasetInput } from './publish-live.js';

// `datasets:publish` (ADR-0020 §7 y §8, paso 6 de `buoh-operaciones`): publica como mucho un dataset
// vivo por ejecución, desde los segmentos cerrados de los logs sucesivos, en `buoh_datasets` y bajo
// el prefijo `datasets/` del bucket de la captura, y escribe una línea JSON. Los logs detenidos los
// lleva `buoh-operaciones` en sus informes y se los pasa con `--skip`. Con `--sequence`, los de una
// secuencia por lotes (precisión del PR 5d2 de ADR-0021 §9).

export const PUBLISH_USAGE =
  'Uso: pnpm --filter @buoh/market-data-worker run datasets:publish -- [--skip <n>[,<n>...]] [--symbol R_100 | --sequence <secuencia por lotes>]';

/** Lo que le queda a un log para vencer por debajo de lo cual la publicación va atrasada (§8). */
export const PUBLICATION_BEHIND_MS = 3 * 24 * 3_600_000;

/** El mayor índice de segmento que cabe en la columna `integer` de `closed_source_segments`. */
const MAX_SEGMENT_INDEX = 2_147_483_647;

export class PublishUsageError extends Error {
  constructor(message: string) {
    super(`${message} ${PUBLISH_USAGE}`);
    this.name = 'UsageError';
  }
}

/** Lo que la publicación lee de un log: sus segmentos cerrados, su perfil y su esquema de fuente. */
export interface PublicationLogReader {
  /** El esquema de fuente que guardó el comando de los lotes (`readStoredBatchSourceSchema`). */
  batchSourceSchema(): Promise<StoredSourceSchema>;
  /** Las filas de sus segmentos cerrados desde `from`, en orden. */
  closedSegments(from: number): Promise<readonly ClosedSourceSegment[]>;
  /** La fila de `log_quality_profile` del log, o `null` (`readLogQualityProfile`). */
  profile(): Promise<LogQualityProfileRow | null>;
  /** Los source events de un segmento cerrado, verificados (`LogReadError`, `LogIntegrityError`). */
  readSegment(index: number): Promise<readonly SourceEvent[]>;
  /** El esquema de fuente que guardó `ingest` en el log (`readStoredSourceSchema`). */
  sourceSchema(): Promise<StoredSourceSchema>;
}

/** Los almacenes de la publicación: `buoh_datasets`, su registro, el bucket y los logs. */
export interface PublicationStores {
  readonly datasetObjects: ObjectStore;
  readonly datasets: DatasetStore;
  readonly operational: OperationalStore;
  /** Los logs de una secuencia que existen, en orden, con su última escritura (`listCaptureLogs`). */
  listLogs(sequence: LogSequence): Promise<CaptureLog[]>;
  log(location: LogLocation): PublicationLogReader;
  close(): Promise<void>;
}

export interface PublishCommandDependencies {
  readonly alert?: OperationalAlert;
  /** El techo de elementos de un dataset; por defecto, el de `planDataset`. Solo para pruebas. */
  readonly ceiling?: number;
  /** Los milisegundos desde que empezó el proceso. */
  readonly elapsedMs: () => number;
  /** El máximo de memoria residente del proceso, en bytes (`process.resourceUsage().maxRSS`). */
  readonly maxRssBytes: () => number;
  /** UUIDv7 de cada intento de publicación. */
  readonly nextId: () => string;
  /**
   * Recibe `{ event: 'publication_attempt', log, first_segment }` antes de leer los segmentos del
   * dataset de un log: si el proceso muere después, por su plazo o sin memoria, sin escribir su
   * línea, `buoh-operaciones` sabe con este aviso qué dataset intentaba (ADR-0020 §8). En stderr.
   */
  readonly progress?: (event: {
    readonly event: 'publication_attempt';
    readonly first_segment: number;
    readonly log: number;
  }) => void;
  readonly now: () => string;
  /** Abre los almacenes con la configuración de `buoh_datasets`. */
  readonly open: (config: WorkerConfig) => PublicationStores;
  /** La release fijada de los esquemas de Deriv, con la que se lee el esquema de fuente. */
  readonly schemas: ExpectedSchemaArchive;
  /** Versión de zlib del writer gzip (`process.versions.zlib` en runtime). */
  readonly zlibVersion: string;
}

/**
 * Los segmentos cerrados, el perfil y el esquema de fuente de un log, sobre su almacén y sus
 * objetos. Si un almacén no responde, rechaza con `LogReadError`.
 */
export function logReader(input: {
  readonly objects: ObjectStore;
  /** La fila del perfil del log (`readLogQualityProfile` con su esquema). */
  readonly profile: () => Promise<LogQualityProfileRow | null>;
  readonly schemas: ExpectedSchemaArchive;
  readonly source: string;
  readonly store: SourceLogStore;
}): PublicationLogReader {
  const reader = SourceEventLog.closedSegmentReader({
    objects: input.objects,
    source: input.source,
    store: input.store,
    zlibVersion: 'solo-lectura',
  });
  const read = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new LogReadError(failureReason(error), { cause: error });
    }
  };
  return {
    batchSourceSchema: () => read(() => readStoredBatchSourceSchema(input.objects, input.schemas)),
    closedSegments: (from) =>
      read(() => input.store.listClosedSegments(input.source, from, MAX_SEGMENT_INDEX)),
    profile: () => read(input.profile),
    readSegment: async (index) => (await reader.readClosedSegment(index)).events,
    sourceSchema: () => read(() => readStoredSourceSchema(input.objects, input.schemas)),
  };
}

/** Una consulta de `buoh_datasets` o de la lista de logs: si falla, un almacén no respondió. */
class StorageError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('Un almacén no respondió.', { cause });
    this.name = 'StorageError';
    this.reason = failureReason(cause);
  }
}

async function storage<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new StorageError(error);
  }
}

/** El log no se puede derivar: no se reintenta con ese contenido (`publication_not_derivable`). */
class NotDerivableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`El log no se puede derivar: ${detail}.`);
    this.name = 'NotDerivableError';
    this.detail = detail;
  }
}

export type PublicationFailureReason =
  | 'commit_outcome_unknown'
  | 'publication_conflict'
  | 'publication_limit_exceeded'
  | 'publication_not_derivable'
  | 'publication_segment_too_large'
  | 'storage_unavailable'
  | 'unexpected';

/**
 * Un fallo de la publicación, saneado (ADR-0020 §8): su etapa, su motivo y un detalle que es un
 * código o un nombre, nunca un mensaje. Las etapas son las de `PublicationStep` y `plan`, el plan del
 * dataset y su lectura, o `unknown`. Repetir no cambia `publication_conflict`,
 * `publication_limit_exceeded`, `publication_not_derivable` ni `publication_segment_too_large`, que
 * detienen el log; `storage_unavailable` y `commit_outcome_unknown` se repiten en la ejecución
 * siguiente, y `unexpected` hasta tres veces. Un error que no es de la publicación ni del log durante
 * el plan (`stage`), como una derivación que aborta, es `publication_not_derivable`.
 */
export function publicationFailure(
  error: unknown,
  stage?: 'plan',
): { readonly detail: string; readonly reason: PublicationFailureReason; readonly stage: string } {
  if (error instanceof PublicationLimitError) {
    return { detail: error.limit, reason: 'publication_limit_exceeded', stage: error.step };
  }
  if (error instanceof PublicationConflictError) {
    return { detail: error.kind, reason: 'publication_conflict', stage: error.step };
  }
  if (error instanceof CommitOutcomeUnknownError) {
    return {
      detail: failureReason(error.cause ?? error),
      reason: 'commit_outcome_unknown',
      stage: error.step,
    };
  }
  if (error instanceof PublicationError) {
    return {
      detail: failureReason(error.cause ?? error),
      reason: 'storage_unavailable',
      stage: error.step,
    };
  }
  if (error instanceof StorageError) {
    return { detail: error.reason, reason: 'storage_unavailable', stage: 'precondition' };
  }
  if (error instanceof LogReadError) {
    return { detail: error.reason, reason: 'storage_unavailable', stage: 'plan' };
  }
  if (error instanceof NotDerivableError) {
    return { detail: error.detail, reason: 'publication_not_derivable', stage: 'plan' };
  }
  if (error instanceof LogIntegrityError) {
    return { detail: error.name, reason: 'publication_not_derivable', stage: 'plan' };
  }
  const detail = failureReason(error);
  return stage === 'plan'
    ? { detail, reason: 'publication_not_derivable', stage }
    : { detail, reason: 'unexpected', stage: 'unknown' };
}

type PublishArgs = {
  /** La secuencia de los logs que publica (ADR-0021 §1). */
  readonly sequence: LogSequence;
  readonly skip: ReadonlySet<number>;
} & (
  | {
      /** Un símbolo en vivo, con `--symbol`. */
      readonly kind: 'live';
      readonly symbol: string;
    }
  | {
      /** Una secuencia por lotes, con `--sequence`, y la clase de su perfil. */
      readonly kind: 'batch';
      readonly profile: BatchProfileKind;
    }
);

/** Las secuencias por lotes que se publican: las que tienen perfil (`batchProfileKindOf`). */
function batchSequenceOf(
  name: string,
): { profile: BatchProfileKind; sequence: LogSequence } | null {
  const sequence = BATCH_SEQUENCES.find((item) => item.name === name);
  if (sequence === undefined) {
    return null;
  }
  try {
    return { profile: batchProfileKindOf(sequence), sequence };
  } catch {
    return null;
  }
}

function parsePublishArgs(argv: readonly string[]): PublishArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { sequence?: string; skip?: string; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        sequence: { type: 'string' },
        skip: { type: 'string' },
        symbol: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new PublishUsageError(error instanceof Error ? error.message : 'Argumentos inválidos.');
  }
  const skip = new Set<number>();
  if (values.skip !== undefined) {
    for (const part of values.skip.split(',')) {
      const number = /^[1-9][0-9]{0,5}$/u.test(part) ? Number(part) : Number.NaN;
      if (!(number >= 1 && number <= MAX_LOG_NUMBER)) {
        throw new PublishUsageError('--skip es una lista de números de log, separados por comas.');
      }
      skip.add(number);
    }
  }
  if (values.sequence !== undefined) {
    if (values.symbol !== undefined) {
      throw new PublishUsageError('--symbol y --sequence no van juntos.');
    }
    const batch = batchSequenceOf(values.sequence);
    if (batch === null) {
      throw new PublishUsageError(
        `--sequence es una secuencia por lotes con perfil: ${BATCH_SEQUENCES.filter(
          (item) => batchSequenceOf(item.name) !== null,
        )
          .map((item) => item.name)
          .join(', ')}.`,
      );
    }
    return { kind: 'batch', ...batch, skip };
  }
  const symbol = values.symbol ?? 'R_100';
  if (symbol !== 'R_100') {
    // Solo R_100 tiene umbrales medidos (ADR-0020 §1).
    throw new PublishUsageError(
      '--symbol solo admite R_100, el único símbolo con umbrales medidos.',
    );
  }
  return { kind: 'live', sequence: R_100_SEQUENCE, skip, symbol };
}

/** Cómo se planea y se publica un log: el perfil en vivo o lo de los lotes. */
interface LogDerivation {
  plan(input: {
    readonly ceiling: number | undefined;
    readonly closedSegments: readonly ClosedSourceSegment[];
    readonly from: number;
    readonly logTerminated: boolean;
    readonly readSegment: (index: number) => Promise<readonly SourceEvent[]>;
  }): Promise<DatasetPlan>;
  readonly source: PublishLiveDatasetInput['source'];
}

/**
 * Lo que necesita la publicación de un log, leído de él: en vivo, su esquema de fuente, con el que
 * se arma el perfil de publicación del símbolo; en los lotes, la fila de su perfil, que tiene que ser
 * la de su secuencia, y su esquema de fuente (precisión del PR 5d2 de ADR-0021 §9). Sin ellos, el log
 * no se puede derivar (`NotDerivableError`).
 */
async function logDerivation(
  reader: PublicationLogReader,
  args: PublishArgs,
  schemas: ExpectedSchemaArchive,
): Promise<LogDerivation> {
  if (args.kind === 'live') {
    const schema = await reader.sourceSchema();
    if (schema.status !== 'found') {
      throw new NotDerivableError(`source_schema_${schema.status}`);
    }
    const profile = createDerivPublicationProfileFromSourceSchema({
      source_schema_bytes: schema.bytes,
      source_schema_release: schemas.release,
      symbol: args.symbol,
    });
    return { plan: (input) => planDataset({ ...input, profile }), source: { profile } };
  }
  const row = await reader.profile();
  const expected = derivBatchLogProfileRow(args.profile);
  if (row === null) {
    throw new NotDerivableError('profile_missing');
  }
  if (
    row.profile_id !== expected.profile_id ||
    row.quality_profile_sha256 !== expected.quality_profile_sha256
  ) {
    throw new NotDerivableError('profile_mismatch');
  }
  const schema = await reader.batchSourceSchema();
  if (schema.status !== 'found') {
    throw new NotDerivableError(`source_schema_${schema.status}`);
  }
  const config = createBatchLogConfig({
    ...batchLogConfigOptions(args.profile),
    source_schema_bytes: schema.bytes,
    source_schema_release: schemas.release,
  });
  const kind = args.profile;
  const elementsOf = (events: readonly SourceEvent[]) => batchElementsOf(events, config);
  let plan: LogDerivation['plan'];
  if (isHistoryProfileKind(kind)) {
    // Una historia, un bloque por dataset (precisión del PR 6c de ADR-0021 §9).
    const history = historyPlan(historyProfileOf(kind));
    plan = (input) => planHistoryDataset({ ...input, elementsOf, plan: history });
  } else {
    plan = (input) => planBatchDataset({ ...input, elementsOf, kind });
  }
  return {
    plan,
    source: {
      batch: {
        connector_version: DERIV_BATCH_CONNECTOR_VERSION,
        quality_profile_bytes: batchProfileBytes(args.profile),
        source_schema_bytes: schema.bytes,
        source_schema_release: schemas.release,
      },
    },
  };
}

/**
 * La configuración de `datasets:publish`: la de `loadConfig`, sin `BUOH_POSTGRES_SCHEMA`, porque
 * trabaja siempre sobre `buoh_datasets` y los logs sucesivos, y con el bucket sin prefijo, porque las
 * claves de los datasets llevan el suyo. Lanza un solo `ConfigError` con todas las variables.
 */
function loadPublishConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const rejected = new Set<string>(productionLogConfigErrors(env));
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
  if (config === null || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
  }
  return {
    ...config,
    postgres: { ...config.postgres, schema: DATASETS_SCHEMA },
    s3: { ...config.s3, keyPrefix: '' },
  };
}

/** La hora UTC en que vence un log, o `null` sin escrituras (ADR-0018 §7). */
function expiresAt(log: CaptureLog): string | null {
  return log.lastWriteUtc === null
    ? null
    : new Date(Date.parse(log.lastWriteUtc) + LOG_RETENTION_MS).toISOString();
}

/**
 * El primer segmento del dataset siguiente del log `log` de `sequence`: el que sigue al último
 * publicado, o el 0.
 */
async function nextFirstSegment(
  stores: PublicationStores,
  sequence: LogSequence,
  log: number,
): Promise<number> {
  const last = await storage(() => stores.datasets.lastLogRange(sequence.name, log));
  return last === null ? 0 : last.last_segment + 1;
}

/**
 * `datasets:publish` completo (ADR-0020 §8, paso 6): interpreta los argumentos, carga la
 * configuración, abre los almacenes y publica como mucho un dataset, el siguiente de §7 del log de
 * menor número que no venció, se puede leer, tiene uno pendiente y no está en `--skip`. Con
 * `--sequence`, el de una secuencia por lotes, con su plan (`planBatchDataset`), el perfil de su
 * secuencia y el esquema de fuente que guarda cada log (precisión del PR 5d2 de ADR-0021 §9); un log
 * sin ellos, o con otro perfil, no se puede derivar. Devuelve la línea JSON y el código de salida:
 *
 * - `published` (salida 0): el `dataset_id`, la publicación, el log, sus segmentos, cómo terminó, sus
 *   conteos, su duración y su memoria máxima. `already_published`, también con salida 0, si estaba
 *   publicado por un intento cuyo `COMMIT` fue ambiguo;
 * - `nothing_due` (salida 0): ningún log tiene un dataset pendiente;
 * - `failed` (salida 1): el log, si se sabe, el primer segmento del dataset, la etapa, el motivo y su
 *   detalle saneado (`publicationFailure`);
 * - un error de uso o de configuración (salida 2), sin abrir nada.
 *
 * Las líneas que no son de uso llevan `behind`: el log más viejo que no venció, con segmentos
 * cerrados sin publicar y menos de 3 días para vencer, o `null` (`publication_behind`). Un `failed` de
 * antes de saberlo, como uno sin la lista de los logs, no lo lleva.
 */
export async function publishDatasetCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: PublishCommandDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let args: PublishArgs;
  let config: WorkerConfig;
  try {
    args = parsePublishArgs(argv);
    config = loadPublishConfig(env);
  } catch (error) {
    if (error instanceof PublishUsageError || error instanceof ConfigError) {
      return {
        exitCode: 2,
        line: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
      };
    }
    throw error;
  }
  const measured = () => ({
    duration_ms: dependencies.elapsedMs(),
    max_rss_bytes: dependencies.maxRssBytes(),
  });
  // `behind` es `undefined` mientras no se sabe: un `failed` de antes no lo lleva.
  const context: { behind: unknown; first: number | null; log: number | null } = {
    behind: undefined,
    first: null,
    log: null,
  };
  let stage: 'plan' | undefined;
  let stores: PublicationStores | null = null;
  try {
    stores = dependencies.open(config);
    const opened = stores;
    const now = dependencies.now();
    const logs = await storage(() => opened.listLogs(args.sequence));
    const live = logs
      .filter((log) => log.readable && !isLogExpired(log, now))
      .sort((left, right) => left.location.number - right.location.number);

    // El log más viejo con segmentos cerrados sin publicar y menos de 3 días para vencer.
    let behind: unknown = null;
    for (const log of live) {
      const expires = expiresAt(log);
      if (expires === null || Date.parse(expires) - Date.parse(now) >= PUBLICATION_BEHIND_MS) {
        continue;
      }
      const first = await nextFirstSegment(opened, args.sequence, log.location.number);
      stage = 'plan';
      const pending = await opened.log(log.location).closedSegments(first);
      stage = undefined;
      if (pending.length > 0) {
        behind = { expires_at_utc: expires, log: log.location.number };
        break;
      }
    }
    context.behind = behind;

    for (const log of live) {
      const number = log.location.number;
      if (args.skip.has(number)) {
        continue;
      }
      context.log = number;
      context.first = null;
      const first = await nextFirstSegment(opened, args.sequence, number);
      context.first = first;
      stage = 'plan';
      const reader = opened.log(log.location);
      const rows = await reader.closedSegments(first);
      // Un log terminado: su sucesor ya tiene escrituras (ADR-0018 §6).
      const terminated = logs.some(
        (other) => other.location.number > number && other.lastWriteUtc !== null,
      );
      if (rows.length === 0) {
        // Nada cerrado sin publicar: un log terminado ya está entero, y el activo espera.
        stage = undefined;
        continue;
      }
      dependencies.progress?.({ event: 'publication_attempt', first_segment: first, log: number });
      const derivation = await logDerivation(reader, args, dependencies.schemas);
      const plan = await derivation.plan({
        ceiling: dependencies.ceiling,
        closedSegments: rows,
        from: first,
        logTerminated: terminated,
        readSegment: (index) => reader.readSegment(index),
      });
      if (plan.status === 'segment_too_large') {
        return {
          exitCode: 1,
          line: JSON.stringify({
            behind: context.behind,
            detail: String(plan.elements),
            first_segment: first,
            log: number,
            reason: 'publication_segment_too_large',
            sequence: args.sequence.name,
            stage: 'plan',
            status: 'failed',
            ...measured(),
          }),
        };
      }
      if (plan.status !== 'due') {
        stage = undefined;
        continue;
      }
      stage = undefined;
      const registry = await storage(() =>
        OperationalRegistry.open({
          ...(dependencies.alert === undefined ? {} : { alert: dependencies.alert }),
          source: DERIV_SOURCE,
          store: opened.operational,
        }),
      );
      const publicationId = dependencies.nextId();
      const outcome = await publishLiveDataset({
        environment: config.environment,
        logNumber: number,
        now: dependencies.now,
        objects: opened.datasetObjects,
        plan,
        publication_id: publicationId,
        published_at_utc: dependencies.now(),
        registry,
        sequence: args.sequence.name,
        source: derivation.source,
        store: opened.datasets,
        zlibVersion: dependencies.zlibVersion,
      });
      const range = outcome.range;
      const common = {
        behind: context.behind,
        clean: range.clean,
        elements: plan.elements,
        first_segment: range.first_segment,
        last_segment: range.last_segment,
        log: number,
        open_condition_types: range.open.open_condition_types,
        pending_continuity_symbols: range.open.pending_continuity_symbols,
        sequence: range.sequence,
      };
      if (outcome.status === 'already_published') {
        return {
          exitCode: 0,
          line: JSON.stringify({
            ...common,
            dataset_id: outcome.record.dataset_id,
            publication_id: outcome.record.publication_id,
            status: 'already_published',
            ...measured(),
          }),
        };
      }
      const { publication } = outcome;
      return {
        exitCode: 0,
        line: JSON.stringify({
          ...common,
          dataset_id: publication.dataset_id,
          incident_count: publication.derived.incidents.length,
          normalized_tick_count: publication.core.normalized_tick_count,
          publication_id: publication.record.publication_id,
          source_event_count: publication.core.source_event_count,
          status: 'published',
          ...measured(),
        }),
      };
    }
    return {
      exitCode: 0,
      line: JSON.stringify({
        behind: context.behind,
        sequence: args.sequence.name,
        status: 'nothing_due',
        ...measured(),
      }),
    };
  } catch (error) {
    const failure = publicationFailure(error, stage);
    return {
      exitCode: 1,
      line: JSON.stringify({
        behind: context.behind,
        detail: failure.detail,
        ...(context.first === null ? {} : { first_segment: context.first }),
        log: context.log,
        reason: failure.reason,
        sequence: args.sequence.name,
        stage: failure.stage,
        status: 'failed',
        ...measured(),
      }),
    };
  } finally {
    await stores?.close().catch(() => undefined);
  }
}
