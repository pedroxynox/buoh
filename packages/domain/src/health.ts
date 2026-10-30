import {
  healthReportSchema,
  sourceEventSchema,
  type ConditionType,
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
} as const satisfies Record<ConditionType, ServiceHealth>;

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
  /**
   * Estado de la conexión observado fuera del log, por ejemplo en el latido de la ingesta
   * (ADR-0015 §8). Sin él, sale del último evento de conexión del log. Una conexión que no es
   * `connected` nunca deja la salud en `healthy`: con raw durable y el log conectado es una causa
   * más, de mínimo `recovering`, porque la ingesta está reconectando; sin raw durable la salud
   * sigue en `starting`, y tras un cierre pedido, en `paused`.
   */
  readonly connection_state?: HealthReport['connection_state'];
  readonly derived: DerivedMarketData;
  readonly last_published_dataset_id: string | null;
  /**
   * Salud mínima que impone quien observa al escritor, por ejemplo `paused` sin escritor vivo o con
   * un latido vencido (ADR-0015 §8). Solo cuenta si es más severa que `healthy`.
   */
  readonly minimum_health?: ServiceHealth;
  /** Tipos abiertos del registro operativo (`persistence_unavailable`, `source_limit_exceeded`). */
  readonly operational_condition_types?: readonly ConditionType[];
  readonly source: string;
  /** Source events durables en orden de observación. */
  readonly sourceEvents: readonly unknown[];
}

/**
 * Lo que el informe toma del log durable: si el log sigue conectado según su último evento de ciclo
 * de vida, el último raw durable, el último tiempo de evento, el mayor, y lo derivable que sigue
 * abierto. Lo da la derivación del log entero (`deriveHealthReport`) o la vista de su estado vivo
 * (`LiveDerivationView`, ADR-0017 §4), con los mismos nombres.
 */
export interface HealthLogFacts {
  readonly connectedInLog: boolean;
  readonly lastEventTimeUtc: string | null;
  readonly lastRaw: { readonly observation_id: string; readonly received_at_utc: string } | null;
  readonly openConditionTypes: readonly string[];
  readonly pendingContinuitySymbols: readonly string[];
}

/** Las entradas de `deriveLiveHealthReport`: las de `deriveHealthReport`, con el log en su vista. */
export type LiveHealthInput = Omit<HealthInput, 'derived' | 'sourceEvents'> & {
  readonly view: HealthLogFacts;
};

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/**
 * Deriva el `HealthReport` del estado durable: conexión según el último evento de ciclo de vida,
 * último raw durable, último tiempo de evento normalizado y condiciones cuya última acción es
 * `opened`. Nunca reporta `healthy` sin raw durable, conexión activa, continuidad demostrada,
 * backlog bajo límites y cero condiciones abiertas.
 *
 * Las condiciones derivables salen de `derived`; las del registro operativo, la conexión observada y
 * la salud mínima, de quien observa la ingesta desde fuera (`data:health`, ADR-0015 §8). Sin esas
 * entradas, el resultado es el de siempre, así que los vectores no cambian.
 */
export function deriveHealthReport(input: HealthInput): HealthReport {
  const events = input.sourceEvents.map((event) => sourceEventSchema.parse(event));
  let connectedInLog = false;
  for (const event of events) {
    if (event.kind === 'connection_closed') {
      connectedInLog = false;
    } else if (event.kind === 'connection_opened' || event.kind === 'raw_source_frame') {
      connectedInLog = true;
    }
  }
  const lastRaw = events.filter((event) => event.kind === 'raw_source_frame').at(-1);
  return healthReportOf(
    {
      connectedInLog,
      lastEventTimeUtc: input.derived.ticks.at(-1)?.event_time_utc ?? null,
      lastRaw:
        lastRaw === undefined
          ? null
          : { observation_id: lastRaw.observation_id, received_at_utc: lastRaw.received_at_utc },
      openConditionTypes: input.derived.openConditionTypes,
      pendingContinuitySymbols: input.derived.pendingContinuitySymbols,
    },
    input,
  );
}

/**
 * El `HealthReport` de `deriveHealthReport` desde la vista del estado vivo del log (ADR-0017 §4),
 * sin derivar el log entero: lo que usa `data:health` desde el último punto de control válido.
 */
export function deriveLiveHealthReport(input: LiveHealthInput): HealthReport {
  return healthReportOf(input.view, input);
}

/** El informe con lo que da el log y lo que observa quien mira la ingesta desde fuera. */
function healthReportOf(
  log: HealthLogFacts,
  input: Omit<HealthInput, 'derived' | 'sourceEvents'>,
): HealthReport {
  const { connectedInLog, lastRaw } = log;
  const connectionState = input.connection_state ?? (connectedInLog ? 'connected' : 'disconnected');

  const openTypes = sortedUnique([
    ...(log.openConditionTypes as ConditionType[]),
    ...(input.operational_condition_types ?? []),
  ]);

  // Cada causa impone una salud mínima; gana la más severa.
  const minimums: ServiceHealth[] = openTypes.map((type) => CONDITION_HEALTH[type]);
  if (log.pendingContinuitySymbols.length > 0) {
    minimums.push('recovering');
  }
  if (
    evaluateSourceLimit('in_memory_queue_events', input.backlog_count) !== null ||
    evaluateSourceLimit('in_memory_queue_bytes', input.backlog_bytes) !== null
  ) {
    minimums.push('paused');
  }
  if (
    input.minimum_health !== undefined &&
    SEVERITY_RANK[input.minimum_health] > SEVERITY_RANK.healthy
  ) {
    minimums.push(input.minimum_health);
  }
  if (lastRaw !== null && connectedInLog && connectionState !== 'connected') {
    // El log sigue conectado, pero quien observa la ingesta ya la ve reconectando (ADR-0015 §8,
    // regla 5): es una causa más, así que un hueco antiguo sin resolver no la tapa.
    minimums.push('recovering');
  }

  let health: ServiceHealth;
  if (minimums.length > 0) {
    health = minimums.reduce((worst, candidate) =>
      SEVERITY_RANK[candidate] > SEVERITY_RANK[worst] ? candidate : worst,
    );
  } else if (lastRaw === null) {
    health = 'starting';
  } else if (!connectedInLog) {
    // Cierre solicitado sin reapertura: no se procesa entrada, pero no hay incidencia abierta.
    health = 'paused';
  } else {
    health = 'healthy';
  }

  return healthReportSchema.parse({
    backlog_bytes: input.backlog_bytes,
    backlog_count: input.backlog_count,
    connection_state: connectionState,
    execution_mode: 'disabled',
    last_event_time_utc: log.lastEventTimeUtc,
    last_observation_id: lastRaw?.observation_id ?? null,
    last_published_dataset_id: input.last_published_dataset_id,
    last_received_at_utc: lastRaw?.received_at_utc ?? null,
    open_condition_types: openTypes,
    schema_version: CONTRACT_SCHEMA_VERSION,
    service_health: health,
    source: input.source,
  });
}

/**
 * Informe sin observación fiable (ADR-0015 §8, reglas 2 y 3): `failed` cuando lo que se observa es
 * incompatible y `paused` cuando el almacenamiento no responde. Sin conexión, backlog 0 y campos
 * `null`, como fija la regla 3; la regla 2 no fija esos campos y usa los mismos, porque nada de lo
 * observado es fiable. El motivo va aparte, saneado, por quien lo emite.
 */
export function unobservedHealthReport(input: {
  readonly service_health: 'failed' | 'paused';
  readonly source: string;
}): HealthReport {
  return healthReportSchema.parse({
    backlog_bytes: 0,
    backlog_count: 0,
    connection_state: 'disconnected',
    execution_mode: 'disabled',
    last_event_time_utc: null,
    last_observation_id: null,
    last_published_dataset_id: null,
    last_received_at_utc: null,
    open_condition_types: [],
    schema_version: CONTRACT_SCHEMA_VERSION,
    service_health: input.service_health,
    source: input.source,
  });
}
