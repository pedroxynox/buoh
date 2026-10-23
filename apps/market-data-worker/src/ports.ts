import {
  type DataQualityIncident,
  type DatasetManifestCore,
  type DeploymentEnvironment,
  type PublishedManifestRecord,
} from '@buoh/contracts';

/**
 * Puerto de almacenamiento de objetos S3-compatible (plan F1, §4). Las claves finales son
 * content-addressed, así que una escritura nunca sustituye contenido distinto bajo la misma clave.
 */
export interface ObjectStore {
  /** Bucket configurado; toda URI `s3://<bucket>/<key>` leída debe pertenecerle. */
  readonly bucket: string;
  /** Escribe solo si la clave no existe. `exists` indica que ya había un objeto bajo esa clave. */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'>;
  /** Lee el objeto completo. Rechaza si no existe o si supera `maxBytes`, sin cargar el exceso. */
  get(key: string, maxBytes: number): Promise<Uint8Array>;
}

export interface CommitPublicationInput {
  readonly core: DatasetManifestCore;
  readonly environment: DeploymentEnvironment;
  /** Incidencias derivables del dataset; se registran append-only junto al commit. */
  readonly incidents: readonly DataQualityIncident[];
  readonly record: PublishedManifestRecord;
}

/** Repositorio de metadatos PostgreSQL (plan F1, §4). */
export interface MetadataStore {
  /** `PublishedManifestRecord` activo del dataset en el entorno, o `null` si no es visible. */
  findActivePublication(
    datasetId: string,
    environment: DeploymentEnvironment,
  ): Promise<PublishedManifestRecord | null>;
  /**
   * ADR-0004 §8 paso 7: en una única transacción, hace visible el dataset como `published` y su
   * record como `active`. Lanza `PublicationConflictError` si ya hay un record activo.
   */
  commitPublication(input: CommitPublicationInput): Promise<void>;
}
