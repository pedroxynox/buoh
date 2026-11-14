import type { DeploymentEnvironment, PublishedManifestRecord } from '@buoh/contracts';
import type { DatasetPublication, PipelineProfile } from '@buoh/domain';

import {
  CommitOutcomeUnknownError,
  PublicationConflictError,
  PublicationError,
} from '../errors.js';
import type { OperationalRegistry } from '../operational/registry.js';
import type { DatasetLogRange, DatasetStore, ObjectStore } from '../ports.js';
import { preparePublication, writePublication } from '../publication.js';
import type { ReplayReadLimits } from '../replay.js';
import { failureReason } from '../source-log/source-event-log.js';
import { DATASETS_PREFIX } from './location.js';
import type { DatasetPlan } from './plan.js';

// La publicación de un dataset vivo en `buoh_datasets` (ADR-0020 §5, §7 y §9): la del plan que da
// `planDataset`, con sus derivados en gzip, su fila de rango en el mismo commit y el registro
// operativo de la publicación. Decide qué segmentos y con qué perfil quien la llama.

/** Los objetos de un dataset que se escriben a la vez, como el borrado de la retención (ADR-0020 §8). */
export const DATASET_WRITE_CONCURRENCY = 8;

export interface PublishLiveDatasetInput {
  readonly environment: DeploymentEnvironment;
  /**
   * El prefijo de las claves de sus objetos y de su documento en el bucket, que llevan también sus
   * URI: por defecto, `datasets/` (ADR-0020 §5). `objects` escribe en el bucket sin prefijo.
   */
  readonly keyPrefix?: string;
  /** Los límites de lectura del replay; por defecto, los suyos. */
  readonly limits?: ReplayReadLimits;
  /** El número del log de los segmentos del plan. */
  readonly logNumber: number;
  /** Reloj UTC inyectado, para la hora de una incidencia. */
  readonly now: () => string;
  /** Los objetos del bucket, sin prefijo: las claves ya llevan el de `keyPrefix`. */
  readonly objects: ObjectStore;
  /** El dataset que decidió `planDataset`. */
  readonly plan: Extract<DatasetPlan, { status: 'due' }>;
  /** El perfil de publicación del log. */
  readonly profile: PipelineProfile;
  /** UUIDv7 inyectado del intento (ADR-0004 §8, paso 4). */
  readonly publication_id: string;
  /** Reloj UTC inyectado del intento. */
  readonly published_at_utc: string;
  /** El registro operativo de la publicación, sobre las tablas de `buoh_datasets`. */
  readonly registry: OperationalRegistry;
  readonly store: DatasetStore;
  /** Versión de zlib del writer gzip (`process.versions.zlib` en runtime). */
  readonly zlibVersion: string;
}

export type PublishLiveOutcome =
  /** Publicado ahora, con este intento. */
  | {
      readonly publication: DatasetPublication;
      readonly range: DatasetLogRange;
      readonly status: 'published';
    }
  /**
   * Ya estaba publicado, con su fila de rango, por un intento anterior cuyo `COMMIT` fue ambiguo
   * (`commit_outcome_unknown`): cuenta como publicado, y no resuelve nada en el registro, porque su
   * hora es anterior a la apertura (ADR-0020 §9).
   */
  | {
      readonly range: DatasetLogRange;
      readonly record: PublishedManifestRecord;
      readonly status: 'already_published';
    };

function canonical(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameRange(left: DatasetLogRange, right: DatasetLogRange): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    left.log_number === right.log_number &&
    left.first_segment === right.first_segment &&
    left.last_segment === right.last_segment &&
    left.clean === right.clean &&
    same(left.open.open_condition_types, right.open.open_condition_types) &&
    same(left.open.pending_continuity_symbols, right.open.pending_continuity_symbols)
  );
}

/** Una consulta previa: su fallo es una lectura, que no entra en el registro (ADR-0020 §9). */
async function precondition<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new PublicationError('precondition', 'No se pudo consultar buoh_datasets.', {
      cause: error,
    });
  }
}

/**
 * Una escritura de la publicación que falló (`normalized_object_write`, `manifest_write` o
 * `manifest_commit`): abre `persistence_unavailable`. Un conflicto no: repetir no lo cambia.
 */
function persistenceFailure(error: unknown): PublicationError | null {
  if (
    error instanceof PublicationError &&
    error.step !== 'precondition' &&
    !(error instanceof PublicationConflictError)
  ) {
    return error;
  }
  return null;
}

/**
 * Publica el dataset del plan en `buoh_datasets` (ADR-0020 §9):
 *
 * 1. Construye la publicación con los derivados en gzip y comprueba los límites del replay, antes de
 *    consultar ni escribir nada (`PublicationLimitError`).
 * 2. Comprueba si el dataset ya está publicado, como tras un `COMMIT` ambiguo: con su publicación
 *    activa y su fila de rango igual a la del plan, cuenta como publicado (`already_published`); con
 *    una publicación activa sin fila de rango o con otro rango, es un error de programación
 *    (`PublicationConflictError`, `publication_conflict`).
 * 3. Escribe los objetos, el documento y, en un solo `COMMIT`, el dataset, sus incidencias, su
 *    record activo y su fila de rango. Un `COMMIT` ambiguo falla con `CommitOutcomeUnknownError`.
 * 4. Una escritura que falla abre `persistence_unavailable` con su etapa en el registro: el intento
 *    como `observed_ref` y la última publicación confirmada como `related_refs`. Una publicación
 *    nueva confirmada resuelve las abiertas antes de su hora.
 *
 * Los fallos de las consultas previas (`precondition`) y los conflictos no entran en el registro.
 * Lanza el error de la publicación, para que quien la llama informe su etapa.
 */
export async function publishLiveDataset(
  input: PublishLiveDatasetInput,
): Promise<PublishLiveOutcome> {
  const { plan } = input;
  const range: DatasetLogRange = {
    clean: plan.clean,
    first_segment: plan.from,
    last_segment: plan.to,
    log_number: input.logNumber,
    // Únicos y ordenados, para que la fila y su comparación no dependan del orden en que llegan.
    open: {
      open_condition_types: canonical(plan.open.open_condition_types),
      pending_continuity_symbols: canonical(plan.open.pending_continuity_symbols),
    },
  };
  const publication = preparePublication({
    derivedCompression: 'gzip',
    environment: input.environment,
    keyPrefix: input.keyPrefix ?? DATASETS_PREFIX,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    objects: input.objects,
    profile: input.profile,
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
    segments: plan.segments,
    zlibVersion: input.zlibVersion,
  });

  const existing = await precondition(() =>
    input.store.findPublishedDataset(publication.dataset_id, input.environment),
  );
  if (existing !== null) {
    // Su fila de rango tiene que ser la de su publicación activa, y la del plan.
    if (
      existing.range !== null &&
      existing.range.publication_id === existing.record.publication_id &&
      sameRange(existing.range.range, range)
    ) {
      return { range: existing.range.range, record: existing.record, status: 'already_published' };
    }
    throw new PublicationConflictError(publication.dataset_id, {
      kind: 'log_range',
      message: `El dataset ${publication.dataset_id} ya tiene una publicación activa sin su rango o con otro.`,
      step: 'precondition',
    });
  }
  const previous = await precondition(() =>
    input.store.lastConfirmedPublication(input.environment),
  );

  try {
    await writePublication(publication, {
      concurrency: DATASET_WRITE_CONCURRENCY,
      environment: input.environment,
      logRange: range,
      metadata: input.store,
      objects: input.objects,
    });
  } catch (error) {
    const failure = persistenceFailure(error);
    if (failure !== null) {
      await input.registry.recordPersistenceUnavailable({
        observed_at_utc: input.now(),
        observed_ref: input.publication_id,
        reason:
          failure instanceof CommitOutcomeUnknownError
            ? failure.reason
            : failureReason(failure.cause ?? failure),
        related_refs: previous === null ? [] : [previous.publication_id],
        stage: failure.step as 'manifest_commit' | 'manifest_write' | 'normalized_object_write',
      });
    }
    throw error;
  }
  await input.registry.resolveWithPublication({
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
  });
  return { publication, range, status: 'published' };
}
