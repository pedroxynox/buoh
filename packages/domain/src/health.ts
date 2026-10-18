import {
  healthReportSchema,
  sourceEventSchema,
  type HealthReport,
  type ServiceHealth,
} from '@buoh/contracts';

import { CONTRACT_SCHEMA_VERSION } from './profile.js';
import { type DerivedMarketData } from './quality.js';
import { evaluateSourceLimit } from './source-limits.js';

/** Salud mínima impuesta por cada condición abierta (runbook de ingesta y ADR-0004 §7/§12). */
export const CONDITION_HEALTH = {
  connection_lost: 'recovering',
  event_gap_unresolved: 'degraded',
  persistence_unavailable: 'paused',
  source_limit_exceeded: 'paused',
} as const satisfies Record<string, ServiceHealth>;

const SEVERITY_RANK: Record<ServiceHealth, number> = {
  starting: 0,
  healthy: 1,
  degraded: 2,
  recovering: 3,
  paused: 4,
  failed: 5,
};

export interface HealthInput {
  readonly backlog_bytes: number;
  readonly backlog_count: number;
  readonly derived: DerivedMarketData;
  readonly last_published_dataset_id: string | null;
  readonly source: string;
  /** Source events durables en orden de observación. */
  readonly sourceEvents: readonly unknown[];
}

/**
 * Deriva el `HealthReport` del estado durable: conexión según el último evento de ciclo de vida,
 * último raw durable, último tiempo de evento normalizado y condiciones cuya última acción es
 * `opened`. Nunca reporta `healthy` sin raw durable, conexión activa, continuidad demostrada,
 * backlog bajo límites y cero condiciones abiertas. F1.2 solo recibe condiciones derivables del
 * dataset; las operativas (`persistence_unavailable`, `source_limit_exceeded`) llegan con F1.3/F1.5.
 */
export function deriveHealthReport(input: HealthInput): HealthReport {
  const events = input.sourceEvents.map((event) => sourceEventSchema.parse(event));
  let connected = false;
  for (const event of events) {
    if (event.kind === 'connection_closed') {
      connected = false;
    } else if (event.kind === 'connection_opened' || event.kind === 'raw_source_frame') {
      connected = true;
    }
  }

  const lastRaw = events.filter((event) => event.kind === 'raw_source_frame').at(-1);
  const openTypes = input.derived.openConditionTypes as (keyof typeof CONDITION_HEALTH)[];

  // Cada causa impone una salud mínima; gana la más severa.
  const minimums: ServiceHealth[] = openTypes.map((type) => CONDITION_HEALTH[type]);
  if (input.derived.pendingContinuitySymbols.length > 0) {
    minimums.push('recovering');
  }
  if (
    evaluateSourceLimit('in_memory_queue_events', input.backlog_count) !== null ||
    evaluateSourceLimit('in_memory_queue_bytes', input.backlog_bytes) !== null
  ) {
    minimums.push('paused');
  }

  let health: ServiceHealth;
  if (minimums.length > 0) {
    health = minimums.reduce((worst, candidate) =>
      SEVERITY_RANK[candidate] > SEVERITY_RANK[worst] ? candidate : worst,
    );
  } else if (lastRaw === undefined) {
    health = 'starting';
  } else if (!connected) {
    // Cierre solicitado sin reapertura: no se procesa entrada, pero no hay incidencia abierta.
    health = 'paused';
  } else {
    health = 'healthy';
  }

  return healthReportSchema.parse({
    backlog_bytes: input.backlog_bytes,
    backlog_count: input.backlog_count,
    connection_state: connected ? 'connected' : 'disconnected',
    execution_mode: 'disabled',
    last_event_time_utc: input.derived.ticks.at(-1)?.event_time_utc ?? null,
    last_observation_id: lastRaw?.observation_id ?? null,
    last_published_dataset_id: input.last_published_dataset_id,
    last_received_at_utc: lastRaw?.received_at_utc ?? null,
    open_condition_types: openTypes,
    schema_version: CONTRACT_SCHEMA_VERSION,
    service_health: health,
    source: input.source,
  });
}
