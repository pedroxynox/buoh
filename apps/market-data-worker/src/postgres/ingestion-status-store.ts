import { canonicalJson, type IngestionCursor } from '@buoh/contracts';
import { type Pool } from 'pg';

import {
  ingestionHeartbeatSchema,
  parseIngestionCursor,
  type IngestionCursorVersion,
  type IngestionHeartbeat,
  type IngestionStatusStore,
} from '../ingestion/status.js';

/** Fila de `ingestion_cursors`: los `bigint` llegan como texto. */
interface CursorRow {
  active_segment_index: string;
  connection_id: string;
  cursor_jcs: string;
  high_watermark_event_time_utc: string | null;
  last_durable_observation_id: string | null;
  last_durable_source_event_id: string;
  schema_version: string;
  source: string;
  source_event_count: string;
  symbol: string;
  updated_at_utc: string;
  version: number;
}

/** Fila de `ingestion_heartbeats`: los `bigint` llegan como texto. */
interface HeartbeatRow extends Omit<IngestionHeartbeat, 'backlog_bytes' | 'backlog_count'> {
  backlog_bytes: string;
  backlog_count: string;
}

/**
 * Cursor y latido sobre PostgreSQL (migración `0004_cursor_y_latido`; ADR-0015 §6), en tablas
 * append-only. `ingestion_cursors` numera las versiones de cada fuente y símbolo desde 1, y su
 * trigger rechaza una versión que no siga a la última; `ingestion_heartbeats` guarda cada latido con
 * su orden de escritura. Los dos validan lo que guardan y lo que leen, como `InMemoryIngestionStatusStore`.
 */
export class PostgresIngestionStatusStore implements IngestionStatusStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * La versión siguiente sale de la misma sentencia que inserta. Si otro escritor guarda a la vez la
   * misma versión, la clave primaria o el trigger rechazan una de las dos.
   */
  async appendCursor(input: IngestionCursor): Promise<IngestionCursorVersion> {
    const cursor = parseIngestionCursor(input);
    const { rows } = await this.#pool.query<{ version: number }>(
      `INSERT INTO ingestion_cursors
         (source, symbol, version, schema_version, connection_id, active_segment_index,
          source_event_count, last_durable_source_event_id, last_durable_observation_id,
          high_watermark_event_time_utc, updated_at_utc, cursor_jcs)
       VALUES ($1, $2,
               (SELECT coalesce(max(version), 0) + 1 FROM ingestion_cursors
                 WHERE source = $1 AND symbol = $2),
               $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING version`,
      [
        cursor.source,
        cursor.symbol,
        cursor.schema_version,
        cursor.connection_id,
        cursor.active_segment_index,
        cursor.source_event_count,
        cursor.last_durable_source_event_id,
        cursor.last_durable_observation_id,
        cursor.high_watermark_event_time_utc,
        cursor.updated_at_utc,
        canonicalJson(cursor),
      ],
    );
    const version = rows[0]?.version;
    if (version === undefined) {
      throw new TypeError('El cursor no devolvió su versión.');
    }
    return { cursor, version };
  }

  /**
   * Última versión, comprobada contra su fila: las columnas tienen que formar un `IngestionCursor`
   * 1.0.0 válido y `cursor_jcs` tiene que ser exactamente su JCS.
   */
  async latestCursor(source: string, symbol: string): Promise<IngestionCursorVersion | null> {
    const { rows } = await this.#pool.query<CursorRow>(
      `SELECT version, schema_version, source, symbol, connection_id::text AS connection_id,
              active_segment_index::text AS active_segment_index,
              source_event_count::text AS source_event_count,
              last_durable_source_event_id::text AS last_durable_source_event_id,
              last_durable_observation_id::text AS last_durable_observation_id,
              high_watermark_event_time_utc, updated_at_utc, cursor_jcs
         FROM ingestion_cursors
        WHERE source = $1 AND symbol = $2
        ORDER BY version DESC
        LIMIT 1`,
      [source, symbol],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const { cursor_jcs: jcs, version, ...columns } = row;
    const cursor = parseIngestionCursor({
      ...columns,
      active_segment_index: Number(columns.active_segment_index),
      source_event_count: Number(columns.source_event_count),
    });
    if (canonicalJson(cursor) !== jcs) {
      throw new TypeError(
        `La versión ${String(version)} del cursor de ${source} y ${symbol} no corresponde a su fila.`,
      );
    }
    return { cursor, version };
  }

  async appendHeartbeat(input: IngestionHeartbeat): Promise<void> {
    const heartbeat = ingestionHeartbeatSchema.parse(input);
    await this.#pool.query(
      `INSERT INTO ingestion_heartbeats
         (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
          backlog_count, backlog_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        heartbeat.heartbeat_id,
        heartbeat.source,
        heartbeat.run_id,
        heartbeat.observed_at_utc,
        heartbeat.pg_backend_pid,
        heartbeat.connection_state,
        heartbeat.backlog_count,
        heartbeat.backlog_bytes,
      ],
    );
  }

  /** El último latido escrito, validado como al guardarlo. */
  async latestHeartbeat(source: string): Promise<IngestionHeartbeat | null> {
    const { rows } = await this.#pool.query<HeartbeatRow>(
      `SELECT heartbeat_id::text AS heartbeat_id, source, run_id::text AS run_id, observed_at_utc,
              pg_backend_pid, connection_state, backlog_count::text AS backlog_count,
              backlog_bytes::text AS backlog_bytes
         FROM ingestion_heartbeats
        WHERE source = $1
        ORDER BY write_order DESC
        LIMIT 1`,
      [source],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return ingestionHeartbeatSchema.parse({
      ...row,
      backlog_bytes: Number(row.backlog_bytes),
      backlog_count: Number(row.backlog_count),
    });
  }
}
