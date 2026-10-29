import { type Pool } from 'pg';

import {
  type ClosedSourceSegment,
  type SourceEventIndexRow,
  type SourceLogState,
  type SourceLogStore,
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

/** Log raw-first sobre PostgreSQL estándar (migración `0002_log_raw_first`). */
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
}
