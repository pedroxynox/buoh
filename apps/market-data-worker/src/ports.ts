import type {
  ConfirmedPublication,
  DataQualityIncident,
  DatasetManifestCore,
  DeploymentEnvironment,
  PublishedManifestRecord,
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

/**
 * El log y los segmentos de un dataset vivo, y cómo terminó (ADR-0020 §5 y §7): la fila de
 * `dataset_log_ranges`. `clean` es que su derivación terminó sin continuidad pendiente ni
 * `connection_lost` abierta; si no, `open` dice qué dejó abierto.
 */
export interface DatasetLogRange {
  readonly clean: boolean;
  readonly first_segment: number;
  readonly last_segment: number;
  readonly log_number: number;
  readonly open: {
    readonly open_condition_types: readonly string[];
    readonly pending_continuity_symbols: readonly string[];
  };
}

export interface CommitPublicationInput {
  readonly core: DatasetManifestCore;
  readonly environment: DeploymentEnvironment;
  /** Incidencias derivables del dataset; se registran append-only junto al commit. */
  readonly incidents: readonly DataQualityIncident[];
  /**
   * Solo en `buoh_datasets` (ADR-0020 §9): la fila de rango que el mismo `COMMIT` inserta, con la
   * publicación que hace visible el dataset. Las tablas de publicación de un log no la tienen.
   */
  readonly logRange?: DatasetLogRange;
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
   * record como `active`. Lanza `PublicationConflictError` si ya hay un record activo, y
   * `CommitOutcomeUnknownError` si el `COMMIT` falla sin que se sepa si se confirmó.
   */
  commitPublication(input: CommitPublicationInput): Promise<void>;
}

/** Un dataset con su publicación activa en un entorno y su fila de rango, si la tiene. */
export interface PublishedDataset {
  readonly range: DatasetLogRange | null;
  readonly record: PublishedManifestRecord;
}

/**
 * Los metadatos de `buoh_datasets` (ADR-0020 §5 y §9): los de la publicación, con su fila de rango
 * en el mismo `COMMIT`, y las consultas previas de la publicación de un dataset vivo.
 */
export interface DatasetStore extends MetadataStore {
  /** El dataset con su publicación activa en el entorno y su fila de rango, o `null`. */
  findPublishedDataset(
    datasetId: string,
    environment: DeploymentEnvironment,
  ): Promise<PublishedDataset | null>;
  /**
   * La última publicación confirmada en el entorno, la de `published_at_utc` más tardía, o `null`:
   * la que citan las incidencias del registro de la publicación (`related_refs`).
   */
  lastConfirmedPublication(
    environment: DeploymentEnvironment,
  ): Promise<ConfirmedPublication | null>;
  /** La fila de rango del último dataset de un log, la de mayor `last_segment`, o `null`. */
  lastLogRange(logNumber: number): Promise<DatasetLogRange | null>;
}
