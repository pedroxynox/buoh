import {
  canonicalJson,
  publishedManifestRecordSchema,
  type DeploymentEnvironment,
  type JsonValue,
  type PublishedManifestRecord,
} from '@buoh/contracts';
import pg from 'pg';

import { PublicationConflictError, PublicationError } from '../errors.js';
import { type CommitPublicationInput, type MetadataStore } from '../ports.js';
import { type WorkerConfig } from '../config.js';

const UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_INDEX = 'published_manifest_records_one_active';

interface RecordRow {
  dataset_id: string;
  manifest_document_sha256: string;
  manifest_object_bytes_sha256: string;
  manifest_object_uri: string;
  publication_id: string;
  published_at_utc: string;
  schema_version: string;
  state: string;
}

/**
 * Los plazos de un pool, en milisegundos, con los nombres de `pg`: el de cada conexión y el de cada
 * consulta. Sin ellos ninguna tiene plazo, como en los pools de `ingest`, `data:replay` y
 * `fixture:publish`; `data:health` los pide (`openHealthStores`).
 */
export interface PoolTimeouts {
  readonly connectionTimeoutMillis: number;
  readonly query_timeout: number;
}

export function createPool(config: WorkerConfig['postgres'], timeouts?: PoolTimeouts): pg.Pool {
  return new pg.Pool({
    ...timeouts,
    database: config.database,
    host: config.host,
    max: 4,
    options: `-c search_path=${config.schema}`,
    password: config.password,
    port: config.port,
    user: config.user,
  });
}

/** Violación del índice que admite un único record activo por dataset y entorno. */
function isActiveConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ONE_ACTIVE_INDEX;
}

/** Repositorio de metadatos sobre PostgreSQL estándar (migración `0001_publicaciones`). */
export class PostgresMetadataStore implements MetadataStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async findActivePublication(
    datasetId: string,
    environment: DeploymentEnvironment,
  ): Promise<PublishedManifestRecord | null> {
    const { rows } = await this.#pool.query<RecordRow>(
      `SELECT publication_id::text AS publication_id, dataset_id, schema_version,
              manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
              published_at_utc, state
         FROM published_manifest_records
        WHERE dataset_id = $1 AND deployment_environment = $2 AND state = 'active'`,
      [datasetId, environment],
    );
    const [row, ...rest] = rows;
    if (row === undefined) {
      return null;
    }
    if (rest.length > 0) {
      throw new TypeError(`Más de un record activo para ${datasetId}.`);
    }
    return publishedManifestRecordSchema.parse(row);
  }

  /**
   * El `dataset_id` del último dataset activo de la fuente en el entorno, o `null` si no tiene
   * ninguno: el de su record `active` con la hora de publicación más tardía, y a la misma hora, el de
   * `publication_id` mayor (un UUIDv7, que crece con el tiempo). Lo lee `data:health` (ADR-0015 §8,
   * «Entradas»). Solo lee. `published_at_utc` es el texto UTC canónico del contrato, con
   * milisegundos, así que su orden de texto es el del tiempo.
   */
  async lastActiveDatasetId(
    source: string,
    environment: DeploymentEnvironment,
  ): Promise<string | null> {
    const { rows } = await this.#pool.query<{ dataset_id: string }>(
      `SELECT records.dataset_id
         FROM published_manifest_records AS records
         JOIN datasets ON datasets.dataset_id = records.dataset_id
        WHERE datasets.source = $1 AND records.deployment_environment = $2
          AND records.state = 'active'
        ORDER BY records.published_at_utc DESC, records.publication_id DESC
        LIMIT 1`,
      [source, environment],
    );
    return rows[0]?.dataset_id ?? null;
  }

  async commitPublication(input: CommitPublicationInput): Promise<void> {
    const { core, environment, incidents, record } = input;
    const coreJcs = canonicalJson(core);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ($1, 'published', $2, $3)
         ON CONFLICT (dataset_id) DO NOTHING`,
        [record.dataset_id, core.source, coreJcs],
      );
      const stored = await client.query<{ manifest_core_jcs: string }>(
        'SELECT manifest_core_jcs FROM datasets WHERE dataset_id = $1',
        [record.dataset_id],
      );
      if (stored.rows[0]?.manifest_core_jcs !== coreJcs) {
        throw new PublicationError('commit', 'El dataset existente tiene otro core.');
      }
      if (incidents.length > 0) {
        await client.query(
          `INSERT INTO dataset_quality_incidents
             (dataset_id, incident_id, incident_type, severity, symbol, observed_at_utc, incident_jcs)
           SELECT $1, *
             FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           ON CONFLICT (dataset_id, incident_id) DO NOTHING`,
          [
            record.dataset_id,
            incidents.map((incident) => incident.incident_id),
            incidents.map((incident) => incident.incident_type),
            incidents.map((incident) => incident.severity),
            incidents.map((incident) => incident.symbol),
            incidents.map((incident) => incident.observed_at_utc),
            incidents.map((incident) => canonicalJson(incident as JsonValue)),
          ],
        );
      }
      await client.query(
        `INSERT INTO published_manifest_records
           (publication_id, deployment_environment, dataset_id, schema_version,
            manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
            published_at_utc, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.publication_id,
          environment,
          record.dataset_id,
          record.schema_version,
          record.manifest_document_sha256,
          record.manifest_object_uri,
          record.manifest_object_bytes_sha256,
          record.published_at_utc,
          record.state,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isActiveConflict(error)) {
        throw new PublicationConflictError(record.dataset_id, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
