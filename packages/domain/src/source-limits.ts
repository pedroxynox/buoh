import { type ServiceHealth } from '@buoh/contracts';

/** Límites de recursos versionados de Fase 1 (ADR-0004 §7). */
export const SOURCE_LIMITS = {
  websocket_frame: {
    action: 'reject_frame_and_close_input',
    health: 'paused',
    maximum: 1_048_576,
    unit: 'bytes',
  },
  in_memory_queue_events: {
    action: 'stop_accepting_and_close_input',
    health: 'paused',
    maximum: 1000,
    unit: 'events',
  },
  in_memory_queue_bytes: {
    action: 'stop_accepting_and_close_input',
    health: 'paused',
    maximum: 33_554_432,
    unit: 'bytes',
  },
  schema_archive: {
    action: 'abort_schema_load',
    health: 'failed',
    maximum: 5_242_880,
    unit: 'bytes',
  },
  schema_entry: {
    action: 'abort_schema_load',
    health: 'failed',
    maximum: 10_485_760,
    unit: 'bytes',
  },
  schema_entries: { action: 'abort_schema_load', health: 'failed', maximum: 1000, unit: 'entries' },
  schema_expanded: {
    action: 'abort_schema_load',
    health: 'failed',
    maximum: 52_428_800,
    unit: 'bytes',
  },
} as const satisfies Record<
  string,
  { action: string; health: ServiceHealth; maximum: number; unit: 'bytes' | 'entries' | 'events' }
>;

export type SourceResource = keyof typeof SOURCE_LIMITS;

export interface SourceLimitViolation {
  readonly action: (typeof SOURCE_LIMITS)[SourceResource]['action'];
  /** Evidencia exacta de `source_limit_exceeded`. */
  readonly evidence: {
    maximum_value: number;
    observed_value: number;
    resource: SourceResource;
    unit: (typeof SOURCE_LIMITS)[SourceResource]['unit'];
  };
  readonly service_health: ServiceHealth;
}

/**
 * Evalúa un recurso contra su límite antes de reservar o parsear contenido. Devuelve `null` si
 * está dentro del límite; nunca trunca ni acepta parcialmente.
 */
export function evaluateSourceLimit(
  resource: SourceResource,
  observedValue: number,
): SourceLimitViolation | null {
  if (!Number.isSafeInteger(observedValue) || observedValue < 0) {
    throw new TypeError('observed_value debe ser un entero seguro no negativo.');
  }
  const limit = SOURCE_LIMITS[resource];
  if (observedValue <= limit.maximum) {
    return null;
  }
  return {
    action: limit.action,
    evidence: {
      maximum_value: limit.maximum,
      observed_value: observedValue,
      resource,
      unit: limit.unit,
    },
    service_health: limit.health,
  };
}
