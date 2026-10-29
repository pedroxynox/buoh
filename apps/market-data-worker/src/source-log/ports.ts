import { type SegmentCloseReason } from '@buoh/domain';

/** Fila de `source_event_index`: un source event durable y la clave de su objeto. */
export interface SourceEventIndexRow {
  readonly byte_length: number;
  readonly event_id: string;
  readonly event_time_utc: string;
  readonly kind:
    'connection_closed' | 'connection_opened' | 'history_recovery_result' | 'raw_source_frame';
  /** SHA-256 de la línea JCS; el objeto vive en `sha256/<object_sha256>`. */
  readonly object_sha256: string;
  readonly position: number;
  readonly segment_index: number;
  readonly source: string;
}

/** Fila de `closed_source_segments`. */
export interface ClosedSourceSegment {
  readonly byte_count: number;
  readonly close_reason: SegmentCloseReason;
  readonly compression: 'gzip' | 'none';
  readonly event_count: number;
  readonly first_event_time_utc: string;
  readonly last_event_time_utc: string;
  readonly logical_content_sha256: string;
  readonly object_bytes_sha256: string;
  readonly object_size_bytes: number;
  readonly raw_frame_count: number;
  readonly segment_index: number;
  readonly segment_policy_version: string;
  readonly source: string;
  readonly writer_name: string | null;
  readonly writer_version: string | null;
}

/** Estado durable del log de una fuente, para continuar tras un reinicio. */
export interface SourceLogState {
  /**
   * Hora (`event_time_utc`) del primer source event durable de la fuente, el más antiguo (segmento
   * 0, posición 0), o `null` si no tiene ninguno.
   */
  readonly firstEventTimeUtc: string | null;
  /** Último segmento cerrado, o `null` si ninguno. */
  readonly lastClosed: ClosedSourceSegment | null;
  /** Último source event durable de la fuente (cualquier segmento). */
  readonly lastEventId: string | null;
  /** Último `raw_source_frame` durable de la fuente. */
  readonly lastRawObservationId: string | null;
  /** Filas del segmento abierto, en orden de posición. */
  readonly openRows: readonly SourceEventIndexRow[];
  readonly totalEventCount: number;
}

/** Puerto PostgreSQL del log raw-first (migración `0002_log_raw_first`). */
export interface SourceLogStore {
  readLogState(source: string): Promise<SourceLogState>;
  insertIndexRow(row: SourceEventIndexRow): Promise<void>;
  insertClosedSegment(segment: ClosedSourceSegment): Promise<void>;
  /** Segmentos cerrados con índice en `[from, to]`, en orden. */
  listClosedSegments(source: string, from: number, to: number): Promise<ClosedSourceSegment[]>;
}
