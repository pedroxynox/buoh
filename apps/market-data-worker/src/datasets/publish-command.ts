import { parseArgs } from 'node:util';

import type { SourceEvent } from '@buoh/contracts';

import { ConfigError, loadConfig, type WorkerConfig } from '../config.js';
import { createDerivPublicationProfileFromSourceSchema, DERIV_SOURCE } from '../deriv/profile.js';
import type { ExpectedSchemaArchive } from '../deriv/schema-release.js';
import { readStoredSourceSchema, type StoredSourceSchema } from '../deriv/stored-source-schema.js';
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
  isLogExpired,
  LOG_RETENTION_MS,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  type CaptureLog,
  type LogLocation,
} from '../successive-logs.js';
import { DATASETS_SCHEMA } from './location.js';
import { planDataset } from './plan.js';
import { publishLiveDataset } from './publish-live.js';

// `datasets:publish` (ADR-0020 §7 y §8, paso 6 de `buoh-operaciones`): publica como mucho un dataset
// vivo por ejecución, desde los segmentos cerrados de los logs sucesivos, en `buoh_datasets` y bajo
// el prefijo `datasets/` del bucket de la captura, y escribe una línea JSON. Los logs detenidos los
// lleva `buoh-operaciones` en sus informes y se los pasa con `--skip`.

export const PUBLISH_USAGE =
  'Uso: pnpm --filter @buoh/market-data-worker run datasets:publish -- [--skip <n>[,<n>...]] [--symbol R_100]';

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

/** Lo que la publicación lee de un log: sus segmentos cerrados y su esquema de fuente. */
export interface PublicationLogReader {
  /** Las filas de sus segmentos cerrados desde `from`, en orden. */
  closedSegments(from: number): Promise<readonly ClosedSourceSegment[]>;
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
  /** Los logs que existen, con su última escritura (`listCaptureLogs`). */
  listLogs(): Promise<CaptureLog[]>;
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
  readonly now: () => string;
  /** Abre los almacenes con la configuración de `buoh_datasets`. */
  readonly open: (config: WorkerConfig) => PublicationStores;
  /** La release fijada de los esquemas de Deriv, con la que se lee el esquema de fuente. */
  readonly schemas: ExpectedSchemaArchive;
  /** Versión de zlib del writer gzip (`process.versions.zlib` en runtime). */
  readonly zlibVersion: string;
}

/** Los segmentos cerrados y el esquema de fuente de un log, sobre su almacén y sus objetos. */
export function logReader(input: {
  readonly objects: ObjectStore;
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
  return {
    closedSegments: async (from) => {
      try {
        return await input.store.listClosedSegments(input.source, from, MAX_SEGMENT_INDEX);
      } catch (error) {
        throw new LogReadError(failureReason(error), { cause: error });
      }
    },
    readSegment: async (index) => (await reader.readClosedSegment(index)).events,
    sourceSchema: async () => {
      try {
        return await readStoredSourceSchema(input.objects, input.schemas);
      } catch (error) {
        throw new LogReadError(failureReason(error), { cause: error });
      }
    },
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

interface PublishArgs {
  readonly skip: ReadonlySet<number>;
  readonly symbol: string;
}

function parsePublishArgs(argv: readonly string[]): PublishArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { skip?: string; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: { skip: { type: 'string' }, symbol: { type: 'string' } },
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
  const symbol = values.symbol ?? 'R_100';
  if (symbol !== 'R_100') {
    // Solo R_100 tiene umbrales medidos (ADR-0020 §1).
    throw new PublishUsageError(
      '--symbol solo admite R_100, el único símbolo con umbrales medidos.',
    );
  }
  return { skip, symbol };
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

/** El primer segmento del dataset siguiente de un log: el que sigue al último publicado, o el 0. */
async function nextFirstSegment(stores: PublicationStores, log: number): Promise<number> {
  const last = await storage(() => stores.datasets.lastLogRange(log));
  return last === null ? 0 : last.last_segment + 1;
}

/**
 * `datasets:publish` completo (ADR-0020 §8, paso 6): interpreta los argumentos, carga la
 * configuración, abre los almacenes y publica como mucho un dataset, el siguiente de §7 del log de
 * menor número que no venció, se puede leer, tiene uno pendiente y no está en `--skip`. Devuelve la
 * línea JSON y el código de salida:
 *
 * - `published` (salida 0): el `dataset_id`, la publicación, el log, sus segmentos, cómo terminó, sus
 *   conteos, su duración y su memoria máxima. `already_published`, también con salida 0, si estaba
 *   publicado por un intento cuyo `COMMIT` fue ambiguo;
 * - `nothing_due` (salida 0): ningún log tiene un dataset pendiente;
 * - `failed` (salida 1): el log, si se sabe, el primer segmento del dataset, la etapa, el motivo y su
 *   detalle saneado (`publicationFailure`);
 * - un error de uso o de configuración (salida 2), sin abrir nada.
 *
 * Todas las líneas que no son de uso llevan `behind`: el log más viejo que no venció, con segmentos
 * cerrados sin publicar y menos de 3 días para vencer, o `null` (`publication_behind`).
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
  const context: { behind: unknown; first: number | null; log: number | null } = {
    behind: null,
    first: null,
    log: null,
  };
  let stage: 'plan' | undefined;
  let stores: PublicationStores | null = null;
  try {
    stores = dependencies.open(config);
    const opened = stores;
    const now = dependencies.now();
    const logs = await storage(() => opened.listLogs());
    const live = logs
      .filter((log) => log.readable && !isLogExpired(log, now))
      .sort((left, right) => left.location.number - right.location.number);

    // El log más viejo con segmentos cerrados sin publicar y menos de 3 días para vencer.
    for (const log of live) {
      const expires = expiresAt(log);
      if (expires === null || Date.parse(expires) - Date.parse(now) >= PUBLICATION_BEHIND_MS) {
        continue;
      }
      const first = await nextFirstSegment(opened, log.location.number);
      stage = 'plan';
      const pending = await opened.log(log.location).closedSegments(first);
      stage = undefined;
      if (pending.length > 0) {
        context.behind = { expires_at_utc: expires, log: log.location.number };
        break;
      }
    }

    for (const log of live) {
      const number = log.location.number;
      if (args.skip.has(number)) {
        continue;
      }
      context.log = number;
      const first = await nextFirstSegment(opened, number);
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
      const schema = await reader.sourceSchema();
      if (schema.status !== 'found') {
        throw new NotDerivableError(`source_schema_${schema.status}`);
      }
      const profile = createDerivPublicationProfileFromSourceSchema({
        source_schema_bytes: schema.bytes,
        source_schema_release: dependencies.schemas.release,
        symbol: args.symbol,
      });
      const plan = await planDataset({
        ceiling: dependencies.ceiling,
        closedSegments: rows,
        from: first,
        logTerminated: terminated,
        profile,
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
        profile,
        publication_id: publicationId,
        published_at_utc: dependencies.now(),
        registry,
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
      line: JSON.stringify({ behind: context.behind, status: 'nothing_due', ...measured() }),
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
        stage: failure.stage,
        status: 'failed',
        ...measured(),
      }),
    };
  } finally {
    await stores?.close().catch(() => undefined);
  }
}
