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

/** Los umbrales de una política de segmentos: bytes, frames raw y ventana. */
export interface SegmentPolicy {
  readonly maximum_bytes: number;
  readonly maximum_raw_frames: number;
  readonly version: string;
  readonly window_ms: number;
}

/**
 * Política de segmentos de los lotes, `segment_policy_version = 2.0.0` (ADR-0021 §3; contratos de
 * dominio, «Semántica ejecutable de las reglas de los lotes 4.0.0»). La de las secuencias en vivo,
 * con el segmento cerrado además a las 15 respuestas: una página de historia o de velas trae hasta
 * unos 1000 elementos, así que ningún segmento de los lotes pasa de unos 15 000. Cada respuesta es
 * un frame raw, así que el motivo de ese cierre es `raw_frames`.
 */
export const BATCH_SEGMENT_POLICY = {
  maximum_bytes: SEGMENT_POLICY.maximum_bytes,
  maximum_raw_frames: 15,
  version: '2.0.0',
  window_ms: SEGMENT_POLICY.window_ms,
} as const satisfies SegmentPolicy;

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
 * Si varios umbrales se cumplen a la vez, el motivo sigue el orden bytes, frames, ventana. Sin
 * `policy`, la de las secuencias en vivo (`SEGMENT_POLICY`).
 */
export function evaluateSegmentRotation(
  stats: SegmentStats,
  event: SourceEvent,
  policy: SegmentPolicy = SEGMENT_POLICY,
): Exclude<SegmentCloseReason, 'requested'> | null {
  const lineBytes = sourceEventLine(event).byteLength + 1;
  if (stats.event_count === 0) {
    if (lineBytes > policy.maximum_bytes) {
      throw new TypeError('Un source event no cabe en un segmento vacío.');
    }
    return null;
  }
  if (stats.byte_count + lineBytes > policy.maximum_bytes) {
    return 'bytes';
  }
  if (event.kind === 'raw_source_frame' && stats.raw_frame_count >= policy.maximum_raw_frames) {
    return 'raw_frames';
  }
  const first = stats.first_event_time_utc;
  if (
    first !== null &&
    Date.parse(sourceEventTime(event)) - Date.parse(first) >= policy.window_ms
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
