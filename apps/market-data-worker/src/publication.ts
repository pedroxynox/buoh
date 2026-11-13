import { sha256Hex, type DeploymentEnvironment } from '@buoh/contracts';
import {
  buildDatasetPublication,
  type DatasetPublication,
  type PipelineProfile,
} from '@buoh/domain';

import { createStorageEncoder, storageContentType } from './encoding.js';
import { PublicationConflictError, PublicationError, PublicationLimitError } from './errors.js';
import { contentKey, keyFromUri, manifestKey, objectUri } from './object-keys.js';
import type { MetadataStore, ObjectStore } from './ports.js';
import { REPLAY_READ_LIMITS, type ReplayReadLimits } from './replay.js';

export interface PublishDatasetInput {
  /**
   * `gzip` para guardar también los roles derivados en gzip, como los datasets vivos (ADR-0020 §7).
   * Por defecto, `none`: solo los segmentos van en gzip, como en F1.3.
   */
  readonly derivedCompression?: 'gzip' | 'none';
  readonly environment: DeploymentEnvironment;
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
  const { bucket } = input.objects;
  const encode = createStorageEncoder(input.zlibVersion, {
    derived: input.derivedCompression ?? 'none',
  });
  const logicalSizes = new Map<string, number>();
  const publication = buildDatasetPublication({
    encodeObject: (object) => {
      logicalSizes.set(object.artifact_id, object.logical_bytes.byteLength);
      return encode(object);
    },
    locateManifest: (ids) => objectUri(bucket, manifestKey(ids)),
    locateObject: (_artifactId, object) =>
      objectUri(bucket, contentKey(object.object_bytes_sha256)),
    profile: input.profile,
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
    segments: input.segments,
  });

  // Nunca se publica lo que el replay rechazaría (ADR-0020 §7): antes de consultar ni escribir nada.
  checkReadLimits(publication, logicalSizes, input.limits ?? REPLAY_READ_LIMITS);

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

  // Paso 3: objetos físicos en claves content-addressed, verificados por lectura.
  for (const object of publication.manifest.storage_objects) {
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
