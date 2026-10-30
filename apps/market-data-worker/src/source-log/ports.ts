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

/**
 * Fila de `live_derivation_checkpoints` (migración `0005`, ADR-0017 §5): un
 * `LiveDerivationCheckpoint` con cada campo de su enlace y de sus versiones en su columna, el
 * SHA-256 del JCS de sus versiones, que entra en la clave, el punto de control entero en JCS, el
 * SHA-256 de ese JCS y la hora de escritura, que no entra en ningún hash.
 */
export interface StoredLiveCheckpoint {
  readonly checkpoint_jcs: string;
  readonly checkpoint_sha256: string;
  readonly connector_version: string;
  /** Los eventos de los segmentos 0 a `segment_index`. */
  readonly event_count: number;
  readonly live_state_version: string;
  readonly quality_profile_sha256: string;
  readonly quality_rule_version: string;
  /** Los raw frames de los segmentos 0 a `segment_index`. */
  readonly raw_frame_count: number;
  readonly schema_version: string;
  readonly segment_index: number;
  readonly segment_logical_content_sha256: string;
  readonly segment_policy_version: string;
  readonly source: string;
  readonly source_event_schema_version: string;
  readonly source_schema_sha256: string;
  readonly symbol: string;
  readonly versions_sha256: string;
  readonly written_at_utc: string;
}

/**
 * Lo que `closed_source_segments` dice de los segmentos 0 a *k* de un punto de control, leído en la
 * misma instantánea que su fila (ADR-0017 §6, «Enlace con el log»).
 */
export interface LiveCheckpointBinding {
  /** La suma de `event_count` de los segmentos cerrados 0 a *k*. */
  readonly event_count: number;
  /** El `logical_content_sha256` del segmento *k*, o `null` si no está cerrado. */
  readonly logical_content_sha256: string | null;
  /** La suma de `raw_frame_count` de los segmentos cerrados 0 a *k*. */
  readonly raw_frame_count: number;
}

/** Un punto de control guardado y su enlace con el log, todavía sin comprobar. */
export interface LiveCheckpointCandidate {
  readonly binding: LiveCheckpointBinding;
  readonly row: StoredLiveCheckpoint;
}

/**
 * Lo que da insertar un punto de control: `inserted`; `exists` si su clave ya tenía uno con el mismo
 * `checkpoint_sha256`, como al reintentar una inserción ambigua; o `conflict` si lo tenía con otro
 * (ADR-0017 §5, «Conflicto»), y entonces la fila guardada no cambia.
 */
export type LiveCheckpointInsert = 'conflict' | 'exists' | 'inserted';

/**
 * Puerto PostgreSQL del log raw-first (migración `0002_log_raw_first`) y de los puntos de control de
 * su estado vivo (migración `0005`).
 */
export interface SourceLogStore {
  readLogState(source: string): Promise<SourceLogState>;
  insertIndexRow(row: SourceEventIndexRow): Promise<void>;
  insertClosedSegment(segment: ClosedSourceSegment): Promise<void>;
  /** Segmentos cerrados con índice en `[from, to]`, en orden. */
  listClosedSegments(source: string, from: number, to: number): Promise<ClosedSourceSegment[]>;
  /**
   * ¿El índice de la fuente tiene el source event `eventId` (`source_event_index.event_id`: el
   * `observation_id` de un frame y el `event_id` de los demás)? Con ella el arranque comprueba
   * `cursor_ahead_of_log` sin recorrer el log (ADR-0017 §4).
   */
  hasSourceEvent(source: string, eventId: string): Promise<boolean>;
  /**
   * Inserta un punto de control (ADR-0017 §5). Su clave es la fuente, el segmento y
   * `versions_sha256`, y nunca reemplaza una fila.
   */
  insertLiveCheckpoint(row: StoredLiveCheckpoint): Promise<LiveCheckpointInsert>;
  /**
   * El punto de control de la fuente con esas versiones (`versions_sha256`) y el mayor segmento, por
   * debajo de `below` si no es `null`, con su enlace con el log, o `null` si no hay ninguno. Nunca da
   * uno de otras versiones (ADR-0017 §6).
   */
  readLiveCheckpoint(
    source: string,
    versionsSha256: string,
    below: number | null,
  ): Promise<LiveCheckpointCandidate | null>;
}
