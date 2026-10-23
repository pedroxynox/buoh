import { sha256Hex, type DeploymentEnvironment } from '@buoh/contracts';
import {
  buildDatasetPublication,
  type DatasetPublication,
  type PipelineProfile,
} from '@buoh/domain';

import { createStorageEncoder, storageContentType } from './encoding.js';
import { PublicationConflictError, PublicationError } from './errors.js';
import { contentKey, keyFromUri, manifestKey, objectUri } from './object-keys.js';
import { type MetadataStore, type ObjectStore } from './ports.js';

export interface PublishDatasetInput {
  readonly environment: DeploymentEnvironment;
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
  step: 'manifest_write' | 'object_write',
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
 * Publicación atómica de ADR-0004 §8. Construye artefactos, `DatasetManifestCore`, `dataset_id`,
 * objetos y documento con `packages/domain`; escribe y verifica objetos content-addressed y el
 * documento; solo entonces hace el commit transaccional. Cualquier fallo anterior al commit deja el
 * dataset invisible y los objetos como huérfanos.
 */
export async function publishDataset(input: PublishDatasetInput): Promise<DatasetPublication> {
  const { bucket } = input.objects;
  const publication = buildDatasetPublication({
    encodeObject: createStorageEncoder(input.zlibVersion),
    locateManifest: (ids) => objectUri(bucket, manifestKey(ids)),
    locateObject: (_artifactId, object) =>
      objectUri(bucket, contentKey(object.object_bytes_sha256)),
    profile: input.profile,
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
    segments: input.segments,
  });

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
    throw new PublicationConflictError(publication.dataset_id);
  }

  // Paso 3: objetos físicos en claves content-addressed, verificados por lectura.
  for (const object of publication.manifest.storage_objects) {
    const bytes = publication.objects.get(object.artifact_id);
    const key = keyFromUri(object.uri, bucket);
    if (bytes === undefined || key === null) {
      throw new PublicationError(
        'object_write',
        `Objeto sin bytes o ubicación: ${object.artifact_id}`,
      );
    }
    await writeVerified(input.objects, key, bytes, storageContentType(object), 'object_write');
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
    throw new PublicationError('commit', 'El commit de la publicación no se confirmó.', {
      cause: error,
    });
  }
  return publication;
}
