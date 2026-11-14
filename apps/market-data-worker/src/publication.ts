import { sha256Hex, type DeploymentEnvironment } from '@buoh/contracts';
import {
  buildDatasetPublication,
  type DatasetPublication,
  type PipelineProfile,
} from '@buoh/domain';

import { createStorageEncoder, storageContentType } from './encoding.js';
import { PublicationConflictError, PublicationError, PublicationLimitError } from './errors.js';
import { contentKey, KEY_PREFIX, keyFromUri, manifestKey, objectUri } from './object-keys.js';
import type { DatasetLogRange, MetadataStore, ObjectStore } from './ports.js';
import { REPLAY_READ_LIMITS, type ReplayReadLimits } from './replay.js';

export interface PublishDatasetInput {
  /**
   * `gzip` para guardar también los roles derivados en gzip, como los datasets vivos (ADR-0020 §7).
   * Por defecto, `none`: solo los segmentos van en gzip, como en F1.3.
   */
  readonly derivedCompression?: 'gzip' | 'none';
  readonly environment: DeploymentEnvironment;
  /**
   * El prefijo de las claves de los objetos y del documento en el bucket, que también llevan sus URI:
   * `datasets/` en los datasets vivos (ADR-0020 §5). Vacío por defecto, como en F1.3. Son segmentos
   * de minúsculas, cifras, `_` y `-`, cada uno con su barra.
   */
  readonly keyPrefix?: string;
  /** Los límites de lectura del replay que se comprueban antes de escribir; por defecto, los suyos. */
  readonly limits?: ReplayReadLimits;
  readonly metadata: MetadataStore;
  readonly objects: ObjectStore;
  readonly profile: PipelineProfile;
  /** UUIDv7 inyectado (ADR-0004 §8 paso 4). */
  readonly publication_id: string;
  /** Reloj UTC inyectado. */
  readonly published_at_utc: string;
  /** Segmentos `source_events` cerrados, en orden de observación. */
  readonly segments: readonly (readonly unknown[])[];
  /** Versión de zlib del writer gzip (`process.versions.zlib` en runtime). */
  readonly zlibVersion: string;
}

async function writeVerified(
  objects: ObjectStore,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  step: 'manifest_write' | 'normalized_object_write',
): Promise<void> {
  try {
    await objects.putIfAbsent(key, bytes, contentType);
  } catch (error) {
    throw new PublicationError(step, `No se pudo escribir ${key}.`, { cause: error });
  }
  // Verificar lectura: una escritura sin confirmar nunca se considera durable.
  let stored: Uint8Array;
  try {
    stored = await objects.get(key, bytes.byteLength);
  } catch (error) {
    throw new PublicationError(step, `No se pudo verificar ${key}.`, { cause: error });
  }
  if (stored.byteLength !== bytes.byteLength || sha256Hex(stored) !== sha256Hex(bytes)) {
    throw new PublicationError(step, `El objeto almacenado no coincide con su hash: ${key}.`);
  }
}

/**
 * Comprueba los límites de lectura del replay sobre lo que se va a escribir: cada objeto físico, los
 * bytes lógicos de cada objeto en gzip (`logicalSizes`, por `artifact_id`) y el documento del
 * manifiesto. Lanza `PublicationLimitError` con el primero que pasa.
 */
function checkReadLimits(
  publication: DatasetPublication,
  logicalSizes: ReadonlyMap<string, number>,
  limits: ReplayReadLimits,
): void {
  for (const object of publication.manifest.storage_objects) {
    if (object.size_bytes > limits.object_bytes) {
      throw new PublicationLimitError(
        'object_bytes',
        `${object.artifact_id} ocupa ${String(object.size_bytes)} bytes, más que el límite del replay.`,
      );
    }
    const logical = logicalSizes.get(object.artifact_id);
    if (
      object.compression === 'gzip' &&
      (logical === undefined || logical > limits.gzip_logical_bytes)
    ) {
      throw new PublicationLimitError(
        'gzip_logical_bytes',
        `${object.artifact_id} descomprimido ocupa ${String(logical)} bytes, más que el límite del replay.`,
      );
    }
  }
  if (publication.manifest_bytes.byteLength > limits.manifest_document_bytes) {
    throw new PublicationLimitError(
      'manifest_document_bytes',
      `El documento del manifiesto ocupa ${String(publication.manifest_bytes.byteLength)} bytes, más que el límite del replay.`,
    );
  }
}

/**
 * Publicación atómica de ADR-0004 §8. Construye artefactos, `DatasetManifestCore`, `dataset_id`,
 * objetos y documento con `packages/domain`; escribe y verifica objetos content-addressed y el
 * documento; solo entonces hace el commit transaccional. Cualquier fallo anterior al commit deja el
 * dataset invisible y los objetos como huérfanos.
 */
export async function publishDataset(input: PublishDatasetInput): Promise<DatasetPublication> {
  return writePublication(preparePublication(input), input);
}

/**
 * Lo que publica `publishDataset` antes de consultar ni escribir nada: construye la publicación y
 * comprueba los límites del replay (ADR-0020 §7). Lanza `PublicationLimitError` si pasa uno.
 */
export function preparePublication(
  input: Omit<PublishDatasetInput, 'metadata'>,
): DatasetPublication {
  const { bucket } = input.objects;
  const prefix = input.keyPrefix ?? '';
  if (!KEY_PREFIX.test(prefix)) {
    throw new TypeError(
      'El prefijo de las claves son segmentos de minúsculas, cifras, _ y -, cada uno con su /.',
    );
  }
  const encode = createStorageEncoder(input.zlibVersion, {
    derived: input.derivedCompression ?? 'none',
  });
  const logicalSizes = new Map<string, number>();
  const publication = buildDatasetPublication({
    encodeObject: (object) => {
      logicalSizes.set(object.artifact_id, object.logical_bytes.byteLength);
      return encode(object);
    },
    locateManifest: (ids) => objectUri(bucket, prefix + manifestKey(ids)),
    locateObject: (_artifactId, object) =>
      objectUri(bucket, prefix + contentKey(object.object_bytes_sha256)),
    profile: input.profile,
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
    segments: input.segments,
  });

  // Nunca se publica lo que el replay rechazaría (ADR-0020 §7): antes de consultar ni escribir nada.
  checkReadLimits(publication, logicalSizes, input.limits ?? REPLAY_READ_LIMITS);
  return publication;
}

/**
 * Escribe una publicación preparada (`preparePublication`): la consulta previa, los objetos, el
 * documento y el commit, con la fila de rango de `buoh_datasets` si la lleva (ADR-0020 §9).
 */
export async function writePublication(
  publication: DatasetPublication,
  input: Pick<PublishDatasetInput, 'environment' | 'metadata' | 'objects'> & {
    /** Los objetos que se escriben a la vez; por defecto, de uno en uno. */
    readonly concurrency?: number;
    readonly logRange?: DatasetLogRange;
  },
): Promise<DatasetPublication> {
  const { bucket } = input.objects;
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency tiene que ser un entero positivo.');
  }
  let active;
  try {
    active = await input.metadata.findActivePublication(publication.dataset_id, input.environment);
  } catch (error) {
    throw new PublicationError('precondition', 'No se pudo consultar el registro de metadatos.', {
      cause: error,
    });
  }
  if (active !== null) {
    // Reubicar o recodificar (nuevo record `active` y el anterior `superseded`) no forma parte de F1.3.
    throw new PublicationConflictError(publication.dataset_id, { step: 'precondition' });
  }

  // Paso 3: objetos físicos en claves content-addressed, verificados por lectura, `concurrency` a la
  // vez. Tras el primer fallo no empieza ninguno más, espera a los que van y lanza ese fallo.
  const pending = [...publication.manifest.storage_objects];
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    for (let object = pending.shift(); object !== undefined; object = pending.shift()) {
      if (failures.length > 0) {
        return;
      }
      try {
        const bytes = publication.objects.get(object.artifact_id);
        const key = keyFromUri(object.uri, bucket);
        if (bytes === undefined || key === null) {
          throw new PublicationError(
            'normalized_object_write',
            `Objeto sin bytes o ubicación: ${object.artifact_id}`,
          );
        }
        await writeVerified(
          input.objects,
          key,
          bytes,
          storageContentType(object),
          'normalized_object_write',
        );
      } catch (error) {
        failures.push(error);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failures.length > 0) {
    throw failures[0];
  }

  // Pasos 5-6: documento JCS sin newline y verificación de sus bytes.
  const documentKey = keyFromUri(publication.record.manifest_object_uri, bucket);
  if (documentKey === null) {
    throw new PublicationError('manifest_write', 'URI de manifiesto fuera del bucket configurado.');
  }
  await writeVerified(
    input.objects,
    documentKey,
    publication.manifest_bytes,
    'application/json',
    'manifest_write',
  );

  // Paso 7: transacción PostgreSQL.
  try {
    await input.metadata.commitPublication({
      core: publication.core,
      environment: input.environment,
      incidents: publication.derived.incidents,
      ...(input.logRange === undefined ? {} : { logRange: input.logRange }),
      record: publication.record,
    });
  } catch (error) {
    if (error instanceof PublicationError) {
      throw error;
    }
    throw new PublicationError('manifest_commit', 'El commit de la publicación no se confirmó.', {
      cause: error,
    });
  }
  return publication;
}
