import {
  canonicalJson,
  dataQualityIncidentSchema,
  derivedEventIdSchema,
  operationalConditionEventSchema,
  publishedManifestRecordSchema,
  sha256HexSchema,
  utcTimestampMsSchema,
  type DataQualityIncident,
  type DeploymentEnvironment,
  type JsonValue,
  type OperationalConditionEvent,
  type PublishedManifestRecord,
} from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import type { z } from 'zod';

import { SANITIZED } from '../operations/sanitized.js';
import type { LogLocation } from '../successive-logs.js';

// Los eventos de datos de un log para la sección Auditoría (ADR-0019 §5 y §8): las versiones del
// catálogo, las publicaciones, las incidencias y las condiciones que guardan sus tablas append-only
// (migraciones `0001` a `0003`). Lo escriben `ingest` y la publicación; aquí solo se lee, con el
// esquema del log en cada consulta, para un pool cuyas sesiones no lo tienen en el `search_path`,
// como el de la API. Cada fila se comprueba contra su contrato antes de devolverla, y sus motivos
// tienen que ser códigos saneados, como los escribe el worker: la Auditoría nunca muestra un mensaje.

/** Una versión del catálogo, con las columnas de su fila en `source_catalog_versions`. */
export interface StoredCatalogVersion {
  readonly source: string;
  readonly version: number;
  readonly snapshotId: string;
  readonly contentSha256: string;
  readonly entryCount: number;
  readonly receivedAtUtc: string;
}

/** Una publicación: su `PublishedManifestRecord` y la fuente de su dataset. */
export interface StoredPublication {
  readonly source: string;
  readonly record: PublishedManifestRecord;
}

type IncidentOf<T extends DataQualityIncident['incident_type']> = Extract<
  DataQualityIncident,
  { incident_type: T }
>;

/**
 * Una incidencia guardada en el log: las del registro operativo (`operational_incidents`) y las de
 * las respuestas pedidas (`requested_response_incidents`, siempre `invalid_source_frame`).
 */
export type StoredDataIncident =
  | IncidentOf<'persistence_unavailable'>
  | IncidentOf<'source_limit_exceeded'>
  | IncidentOf<'invalid_source_frame'>;

/** Los eventos de datos de un log, cada lista de la más nueva a la más vieja. */
export interface LogDataEvents {
  readonly catalogVersions: readonly StoredCatalogVersion[];
  readonly publications: readonly StoredPublication[];
  readonly incidents: readonly StoredDataIncident[];
  readonly conditions: readonly OperationalConditionEvent[];
}

export interface ReadLogDataEventsInput {
  readonly source: string;
  /** Solo las publicaciones de este entorno (`published_manifest_records.deployment_environment`). */
  readonly environment: DeploymentEnvironment;
  /** Cuántas filas lee como mucho de cada clase de evento: las más recientes. */
  readonly limit: number;
}

/**
 * Una fila de un evento de datos que no pasa sus comprobaciones: un documento que no es JSON, que
 * no cumple su contrato o no está en JCS, unas columnas que no son las de su documento o que no
 * tienen sus formatos, o un motivo que no es un código saneado. No repite nada de su contenido.
 */
export class DataEventIntegrityError extends TypeError {
  constructor() {
    super('Un evento de datos guardado no pasa sus comprobaciones.');
    this.name = 'DataEventIntegrityError';
  }
}

interface CatalogRow {
  source: string;
  version: number;
  snapshot_id: string;
  content_sha256: string;
  entry_count: number;
  received_at_utc: string;
}

interface PublicationRow {
  source: string;
  schema_version: string;
  publication_id: string;
  dataset_id: string;
  manifest_document_sha256: string;
  manifest_object_uri: string;
  manifest_object_bytes_sha256: string;
  published_at_utc: string;
  state: string;
}

interface OperationalIncidentRow {
  incident_id: string;
  incident_type: string;
  severity: string;
  source: string;
  symbol: string | null;
  observed_at_utc: string;
  incident_jcs: string;
}

interface RequestedIncidentRow {
  incident_id: string;
  incident_type: string;
  source: string;
  observed_ref: string;
  observed_at_utc: string;
  reason: string;
  incident_jcs: string;
}

interface ConditionRow {
  condition_event_id: string;
  condition_key: string;
  condition_type: string;
  action: string;
  source: string;
  symbol: string | null;
  occurred_at_utc: string;
  condition_jcs: string;
}

/** El documento de una fila, validado con su contrato y exactamente en JCS. */
function storedDocument<T>(schema: z.ZodType<T>, jcs: string): T {
  let stored: unknown;
  try {
    stored = JSON.parse(jcs);
  } catch {
    throw new DataEventIntegrityError();
  }
  const parsed = schema.safeParse(stored);
  if (!parsed.success || canonicalJson(parsed.data as JsonValue) !== jcs) {
    throw new DataEventIntegrityError();
  }
  return parsed.data;
}

function check(condition: boolean): void {
  if (!condition) {
    throw new DataEventIntegrityError();
  }
}

const isCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/**
 * Una versión del catálogo, con sus columnas: la tabla no guarda su documento, que vive en el
 * almacenamiento de objetos, así que se comprueban sus formatos, los del contrato.
 */
function catalogVersionOf(row: CatalogRow): StoredCatalogVersion {
  check(
    row.source.length > 0 &&
      isCount(row.version) &&
      derivedEventIdSchema.safeParse(row.snapshot_id).success &&
      sha256HexSchema.safeParse(row.content_sha256).success &&
      isCount(row.entry_count) &&
      utcTimestampMsSchema.safeParse(row.received_at_utc).success,
  );
  return {
    source: row.source,
    version: row.version,
    snapshotId: row.snapshot_id,
    contentSha256: row.content_sha256,
    entryCount: row.entry_count,
    receivedAtUtc: row.received_at_utc,
  };
}

function publicationOf(row: PublicationRow): StoredPublication {
  const { source, ...columns } = row;
  const parsed = publishedManifestRecordSchema.safeParse(columns);
  if (!parsed.success) {
    throw new DataEventIntegrityError();
  }
  return { source, record: parsed.data };
}

function operationalIncidentOf(row: OperationalIncidentRow): StoredDataIncident {
  const incident = storedDocument(dataQualityIncidentSchema, row.incident_jcs);
  check(
    (incident.incident_type === 'persistence_unavailable' ||
      incident.incident_type === 'source_limit_exceeded') &&
      incident.incident_id === row.incident_id &&
      incident.incident_type === row.incident_type &&
      incident.severity === row.severity &&
      incident.source === row.source &&
      incident.symbol === row.symbol &&
      incident.observed_at_utc === row.observed_at_utc,
  );
  check(
    incident.incident_type !== 'persistence_unavailable' ||
      SANITIZED.test(incident.evidence.reason),
  );
  return incident as StoredDataIncident;
}

function requestedIncidentOf(row: RequestedIncidentRow): StoredDataIncident {
  const incident = storedDocument(dataQualityIncidentSchema, row.incident_jcs);
  check(
    incident.incident_type === 'invalid_source_frame' &&
      incident.incident_id === row.incident_id &&
      incident.source === row.source &&
      incident.observed_ref === row.observed_ref &&
      incident.observed_at_utc === row.observed_at_utc &&
      incident.evidence.reason === row.reason &&
      SANITIZED.test(incident.evidence.reason),
  );
  return incident as StoredDataIncident;
}

function conditionOf(row: ConditionRow): OperationalConditionEvent {
  const condition = storedDocument(operationalConditionEventSchema, row.condition_jcs);
  check(
    condition.condition_event_id === row.condition_event_id &&
      condition.condition_key === row.condition_key &&
      condition.condition_type === row.condition_type &&
      condition.action === row.action &&
      condition.source === row.source &&
      condition.symbol === row.symbol &&
      condition.occurred_at_utc === row.occurred_at_utc &&
      (condition.action === 'opened' || SANITIZED.test(condition.resolution_reason)),
  );
  return condition;
}

/** De la más nueva a la más vieja, y con la misma hora, por identificador, de mayor a menor. */
function newestIncidentFirst(a: StoredDataIncident, b: StoredDataIncident): number {
  if (a.observed_at_utc !== b.observed_at_utc) {
    return a.observed_at_utc < b.observed_at_utc ? 1 : -1;
  }
  return a.incident_id < b.incident_id ? 1 : a.incident_id > b.incident_id ? -1 : 0;
}

/**
 * Los eventos de datos del log (ADR-0019 §5 y §8): de cada clase, las `limit` filas más recientes de
 * `source`, cada una comprobada contra su contrato, con su documento en JCS y sus columnas iguales a
 * las de su documento. Las publicaciones son solo las de `environment`. Lanza
 * `DataEventIntegrityError` si una fila no pasa esas comprobaciones. No escribe nada.
 */
export async function readLogDataEvents(
  pool: Pick<Pool, 'query'>,
  log: LogLocation,
  input: ReadLogDataEventsInput,
): Promise<LogDataEvents> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new TypeError('El límite de eventos es un entero positivo.');
  }
  const schema = pg.escapeIdentifier(log.schema);
  const catalog = await pool.query<CatalogRow>(
    `SELECT source, version, snapshot_id, content_sha256, entry_count, received_at_utc
       FROM ${schema}.source_catalog_versions
      WHERE source = $1
      ORDER BY version DESC
      LIMIT $2`,
    [input.source, input.limit],
  );
  const publications = await pool.query<PublicationRow>(
    `SELECT d.source, r.schema_version, r.publication_id::text AS publication_id, r.dataset_id,
            r.manifest_document_sha256, r.manifest_object_uri, r.manifest_object_bytes_sha256,
            r.published_at_utc, r.state
       FROM ${schema}.published_manifest_records r
       JOIN ${schema}.datasets d USING (dataset_id)
      WHERE d.source = $1 AND r.deployment_environment = $2
      ORDER BY r.published_at_utc DESC, r.publication_id DESC
      LIMIT $3`,
    [input.source, input.environment, input.limit],
  );
  const operational = await pool.query<OperationalIncidentRow>(
    `SELECT incident_id, incident_type, severity, source, symbol, observed_at_utc, incident_jcs
       FROM ${schema}.operational_incidents
      WHERE source = $1
      ORDER BY observed_at_utc DESC, incident_id DESC
      LIMIT $2`,
    [input.source, input.limit],
  );
  const requested = await pool.query<RequestedIncidentRow>(
    `SELECT incident_id, incident_type, source, observed_ref::text AS observed_ref,
            observed_at_utc, reason, incident_jcs
       FROM ${schema}.requested_response_incidents
      WHERE source = $1
      ORDER BY observed_at_utc DESC, incident_id DESC
      LIMIT $2`,
    [input.source, input.limit],
  );
  const conditions = await pool.query<ConditionRow>(
    `SELECT condition_event_id, condition_key, condition_type, action, source, symbol,
            occurred_at_utc, condition_jcs
       FROM ${schema}.operational_conditions
      WHERE source = $1
      ORDER BY occurred_at_utc DESC, condition_event_id DESC
      LIMIT $2`,
    [input.source, input.limit],
  );
  const incidents = [
    ...operational.rows.map(operationalIncidentOf),
    ...requested.rows.map(requestedIncidentOf),
  ]
    .sort(newestIncidentFirst)
    .slice(0, input.limit);
  return {
    catalogVersions: catalog.rows.map(catalogVersionOf),
    publications: publications.rows.map(publicationOf),
    incidents,
    conditions: conditions.rows.map(conditionOf),
  };
}
