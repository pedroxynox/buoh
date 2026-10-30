import { type Pool } from 'pg';

import {
  type ClosedSourceSegment,
  type LiveCheckpointCandidate,
  type LiveCheckpointInsert,
  type SourceEventIndexRow,
  type SourceLogState,
  type SourceLogStore,
  type StoredLiveCheckpoint,
} from '../source-log/ports.js';

interface IndexRecord {
  byte_length: number;
  event_id: string;
  event_time_utc: string;
  kind: SourceEventIndexRow['kind'];
  object_sha256: string;
  position: number;
  segment_index: number;
  source: string;
}

interface ClosedRecord extends Omit<ClosedSourceSegment, 'byte_count' | 'object_size_bytes'> {
  byte_count: string;
  object_size_bytes: string;
}

const CLOSED_COLUMNS = `source, segment_index, event_count, raw_frame_count, byte_count,
  logical_content_sha256, object_bytes_sha256, object_size_bytes, compression, writer_name,
  writer_version, close_reason, segment_policy_version, first_event_time_utc, last_event_time_utc`;

function closedFromRecord(record: ClosedRecord): ClosedSourceSegment {
  return {
    ...record,
    byte_count: Number(record.byte_count),
    object_size_bytes: Number(record.object_size_bytes),
  };
}

/** Una fila de `live_derivation_checkpoints`: `pg` da los `bigint` como texto. */
interface CheckpointRecord extends Omit<
  StoredLiveCheckpoint,
  'event_count' | 'raw_frame_count' | 'segment_index'
> {
  event_count: string;
  raw_frame_count: string;
  segment_index: string;
}

const CHECKPOINT_COLUMNS = `source, symbol, segment_index, schema_version,
  segment_logical_content_sha256, event_count, raw_frame_count, connector_version,
  live_state_version, quality_profile_sha256, quality_rule_version, segment_policy_version,
  source_event_schema_version, source_schema_sha256, versions_sha256, checkpoint_jcs,
  checkpoint_sha256, written_at_utc`;

/**
 * Un UUID como lo da `event_id::text`: en minúsculas y con guiones. Solo con esa forma `event_id =
 * $2::uuid` compara lo mismo que el texto, como el índice en memoria: PostgreSQL también acepta un
 * UUID en mayúsculas, entre llaves o sin guiones.
 */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function checkpointFromRecord(record: CheckpointRecord): StoredLiveCheckpoint {
  return {
    ...record,
    event_count: Number(record.event_count),
    raw_frame_count: Number(record.raw_frame_count),
    segment_index: Number(record.segment_index),
  };
}

/**
 * Log raw-first sobre PostgreSQL estándar (migración `0002_log_raw_first`) y los puntos de control de
 * su estado vivo (migración `0005`).
 */
export class PostgresSourceLogStore implements SourceLogStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async readLogState(source: string): Promise<SourceLogState> {
    const client = await this.#pool.connect();
    try {
      // Una instantánea coherente de todas las lecturas.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const closed = await client.query<ClosedRecord>(
        `SELECT ${CLOSED_COLUMNS} FROM closed_source_segments
          WHERE source = $1 ORDER BY segment_index DESC LIMIT 1`,
        [source],
      );
      const lastClosed = closed.rows[0] === undefined ? null : closedFromRecord(closed.rows[0]);
      const openIndex = lastClosed === null ? 0 : lastClosed.segment_index + 1;
      const open = await client.query<IndexRecord>(
        `SELECT source, segment_index, position, event_id::text AS event_id, kind, event_time_utc,
                object_sha256, byte_length
           FROM source_event_index
          WHERE source = $1 AND segment_index = $2
          ORDER BY position`,
        [source, openIndex],
      );
      const first = await client.query<{ event_time_utc: string }>(
        `SELECT event_time_utc FROM source_event_index
          WHERE source = $1 ORDER BY segment_index, position LIMIT 1`,
        [source],
      );
      const last = await client.query<{ event_id: string }>(
        `SELECT event_id::text AS event_id FROM source_event_index
          WHERE source = $1 ORDER BY segment_index DESC, position DESC LIMIT 1`,
        [source],
      );
      const lastRaw = await client.query<{ event_id: string }>(
        `SELECT event_id::text AS event_id FROM source_event_index
          WHERE source = $1 AND kind = 'raw_source_frame'
          ORDER BY segment_index DESC, position DESC LIMIT 1`,
        [source],
      );
      const total = await client.query<{ count: string }>(
        'SELECT count(*) FROM source_event_index WHERE source = $1',
        [source],
      );
      await client.query('COMMIT');
      return {
        firstEventTimeUtc: first.rows[0]?.event_time_utc ?? null,
        lastClosed,
        lastEventId: last.rows[0]?.event_id ?? null,
        lastRawObservationId: lastRaw.rows[0]?.event_id ?? null,
        openRows: open.rows,
        totalEventCount: Number(total.rows[0]?.count ?? 0),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertIndexRow(row: SourceEventIndexRow): Promise<void> {
    await this.#pool.query(
      `INSERT INTO source_event_index
         (source, segment_index, position, event_id, kind, event_time_utc, object_sha256, byte_length)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.source,
        row.segment_index,
        row.position,
        row.event_id,
        row.kind,
        row.event_time_utc,
        row.object_sha256,
        row.byte_length,
      ],
    );
  }

  async insertClosedSegment(segment: ClosedSourceSegment): Promise<void> {
    await this.#pool.query(
      `INSERT INTO closed_source_segments (${CLOSED_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        segment.source,
        segment.segment_index,
        segment.event_count,
        segment.raw_frame_count,
        segment.byte_count,
        segment.logical_content_sha256,
        segment.object_bytes_sha256,
        segment.object_size_bytes,
        segment.compression,
        segment.writer_name,
        segment.writer_version,
        segment.close_reason,
        segment.segment_policy_version,
        segment.first_event_time_utc,
        segment.last_event_time_utc,
      ],
    );
  }

  async listClosedSegments(
    source: string,
    from: number,
    to: number,
  ): Promise<ClosedSourceSegment[]> {
    const { rows } = await this.#pool.query<ClosedRecord>(
      `SELECT ${CLOSED_COLUMNS} FROM closed_source_segments
        WHERE source = $1 AND segment_index BETWEEN $2 AND $3
        ORDER BY segment_index`,
      [source, from, to],
    );
    return rows.map(closedFromRecord);
  }

  /**
   * Con el índice único de `event_id`, sin recorrer las filas de la fuente. Un ID con otra forma que
   * la de `event_id::text` no está en el índice: da `false` sin consultar, en lugar del error del
   * cast o de encontrar el mismo UUID escrito de otra forma.
   */
  async hasSourceEvent(source: string, eventId: string): Promise<boolean> {
    if (!UUID_TEXT.test(eventId)) {
      return false;
    }
    const { rows } = await this.#pool.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM source_event_index WHERE source = $1 AND event_id = $2::uuid
       ) AS found`,
      [source, eventId],
    );
    return rows[0]?.found === true;
  }

  /**
   * `ON CONFLICT DO NOTHING` y, si la clave ya tenía fila, la lee para comparar su
   * `checkpoint_sha256`: como la tabla es append-only, esa fila no puede cambiar entre las dos
   * consultas.
   */
  async insertLiveCheckpoint(row: StoredLiveCheckpoint): Promise<LiveCheckpointInsert> {
    const inserted = await this.#pool.query(
      `INSERT INTO live_derivation_checkpoints (${CHECKPOINT_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (source, segment_index, versions_sha256) DO NOTHING`,
      [
        row.source,
        row.symbol,
        row.segment_index,
        row.schema_version,
        row.segment_logical_content_sha256,
        row.event_count,
        row.raw_frame_count,
        row.connector_version,
        row.live_state_version,
        row.quality_profile_sha256,
        row.quality_rule_version,
        row.segment_policy_version,
        row.source_event_schema_version,
        row.source_schema_sha256,
        row.versions_sha256,
        row.checkpoint_jcs,
        row.checkpoint_sha256,
        row.written_at_utc,
      ],
    );
    if (inserted.rowCount === 1) {
      return 'inserted';
    }
    const { rows } = await this.#pool.query<{ checkpoint_sha256: string }>(
      `SELECT checkpoint_sha256 FROM live_derivation_checkpoints
        WHERE source = $1 AND segment_index = $2 AND versions_sha256 = $3`,
      [row.source, row.segment_index, row.versions_sha256],
    );
    const stored = rows[0];
    if (stored === undefined) {
      throw new TypeError('El punto de control de esa clave no se insertó ni existe.');
    }
    return stored.checkpoint_sha256 === row.checkpoint_sha256 ? 'exists' : 'conflict';
  }

  async readLiveCheckpoint(
    source: string,
    versionsSha256: string,
    below: number | null,
  ): Promise<LiveCheckpointCandidate | null> {
    const client = await this.#pool.connect();
    try {
      // La fila y su enlace en una misma instantánea (ADR-0017 §4 y §6).
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const candidate = await client.query<CheckpointRecord>(
        `SELECT ${CHECKPOINT_COLUMNS} FROM live_derivation_checkpoints
          WHERE source = $1 AND versions_sha256 = $2
            AND ($3::bigint IS NULL OR segment_index < $3::bigint)
          ORDER BY segment_index DESC LIMIT 1`,
        [source, versionsSha256, below],
      );
      const record = candidate.rows[0];
      if (record === undefined) {
        await client.query('COMMIT');
        return null;
      }
      const row = checkpointFromRecord(record);
      const binding = await client.query<{
        event_count: string;
        logical_content_sha256: string | null;
        raw_frame_count: string;
      }>(
        `SELECT coalesce(sum(event_count), 0)::text AS event_count,
                coalesce(sum(raw_frame_count), 0)::text AS raw_frame_count,
                max(logical_content_sha256) FILTER (WHERE segment_index = $2::bigint)
                  AS logical_content_sha256
           FROM closed_source_segments
          WHERE source = $1 AND segment_index <= $2::bigint`,
        [source, row.segment_index],
      );
      await client.query('COMMIT');
      const facts = binding.rows[0];
      return {
        binding: {
          event_count: Number(facts?.event_count ?? 0),
          logical_content_sha256: facts?.logical_content_sha256 ?? null,
          raw_frame_count: Number(facts?.raw_frame_count ?? 0),
        },
        row,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
