import { canonicalJson, type SourceEvent } from '@buoh/contracts';

import { SEGMENT_POLICY_VERSION } from './profile.js';
import { utf8 } from './serialization.js';

/**
 * Política de segmentación `segment_policy_version = 1.0.0` (ADR-0004 §7, ADR-0005 §5). Rota por
 * bytes, frames o ventana, lo que ocurra primero. Rotar no crea incidencia ni cambia salud.
 */
export const SEGMENT_POLICY = {
  maximum_bytes: 67_108_864,
  maximum_raw_frames: 10_000,
  version: SEGMENT_POLICY_VERSION,
  window_ms: 300_000,
} as const;

/** Motivo de cierre de un segmento. `requested`: drenaje, apagado o rotación del harness. */
export type SegmentCloseReason = 'bytes' | 'raw_frames' | 'requested' | 'window';

export interface SegmentStats {
  /** Bytes NDJSON lógicos acumulados: cada línea JCS más `\n`. */
  readonly byte_count: number;
  readonly event_count: number;
  /** Tiempo del primer evento del segmento, o `null` si está vacío. */
  readonly first_event_time_utc: string | null;
  readonly raw_frame_count: number;
}

export const EMPTY_SEGMENT_STATS: SegmentStats = {
  byte_count: 0,
  event_count: 0,
  first_event_time_utc: null,
  raw_frame_count: 0,
};

/** Tiempo que mide la ventana: recepción para raw, ocurrencia para el resto. */
export function sourceEventTime(event: SourceEvent): string {
  return event.kind === 'raw_source_frame' ? event.received_at_utc : event.occurred_at_utc;
}

/** Línea lógica del evento en su segmento: JCS sin newline (el newline se suma al medir). */
export function sourceEventLine(event: SourceEvent): Uint8Array {
  return utf8(canonicalJson(event));
}

/**
 * Decide, antes de añadir `event`, si el segmento actual debe cerrarse. Un segmento vacío nunca rota.
 * Si varios umbrales se cumplen a la vez, el motivo sigue el orden bytes, frames, ventana.
 */
export function evaluateSegmentRotation(
  stats: SegmentStats,
  event: SourceEvent,
): Exclude<SegmentCloseReason, 'requested'> | null {
  const lineBytes = sourceEventLine(event).byteLength + 1;
  if (stats.event_count === 0) {
    if (lineBytes > SEGMENT_POLICY.maximum_bytes) {
      throw new TypeError('Un source event no cabe en un segmento vacío.');
    }
    return null;
  }
  if (stats.byte_count + lineBytes > SEGMENT_POLICY.maximum_bytes) {
    return 'bytes';
  }
  if (
    event.kind === 'raw_source_frame' &&
    stats.raw_frame_count >= SEGMENT_POLICY.maximum_raw_frames
  ) {
    return 'raw_frames';
  }
  const first = stats.first_event_time_utc;
  if (
    first !== null &&
    Date.parse(sourceEventTime(event)) - Date.parse(first) >= SEGMENT_POLICY.window_ms
  ) {
    return 'window';
  }
  return null;
}

/** Estadísticas tras añadir `event` al segmento. */
export function appendSegmentStats(stats: SegmentStats, event: SourceEvent): SegmentStats {
  return {
    byte_count: stats.byte_count + sourceEventLine(event).byteLength + 1,
    event_count: stats.event_count + 1,
    first_event_time_utc: stats.first_event_time_utc ?? sourceEventTime(event),
    raw_frame_count: stats.raw_frame_count + (event.kind === 'raw_source_frame' ? 1 : 0),
  };
}
