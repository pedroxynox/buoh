import {
  marketTickSchema,
  sourceEventSchema,
  validateConditionCausality,
  type DataQualityIncident,
  type MarketTick,
  type OperationalConditionEvent,
  type SourceEvent,
} from '@buoh/contracts';

import {
  applyConnectionClosed,
  applyConnectionOpened,
  applyHistoryRecovery,
  applyTickContinuity,
  applyTickWatermark,
  assertProvenance,
  buildIncident,
  emptyRuleState,
  pendingGapsOf,
  sourceEventKey,
  type IncidentBody,
  type PendingGap,
  type RuleSink,
} from './derivation-rules.js';
import { normalizeRawFrame, type UnflaggedTick } from './normalizer.js';
import { derivationThresholds, type PipelineProfile } from './profile.js';

export {
  DERIVABLE_INCIDENT_SEVERITY,
  RESOLUTION_REASONS,
  type PendingGap,
} from './derivation-rules.js';

type IncidentType = DataQualityIncident['incident_type'];

export interface DerivedMarketData {
  /** Condiciones en orden de reducer: `occurred_at_utc`, `condition_event_id`. */
  readonly conditions: OperationalConditionEvent[];
  /** Incidencias en orden canónico: `observed_at_utc`, `incident_type`, `incident_id`. */
  readonly incidents: DataQualityIncident[];
  /** Tipos cuya última acción es `opened`, únicos y ordenados. */
  readonly openConditionTypes: string[];
  /** Huecos pendientes, uno por símbolo de `pendingContinuitySymbols`, en el mismo orden. */
  readonly pendingGaps: PendingGap[];
  /**
   * Símbolos cuya continuidad tras una pérdida de conexión aún no está demostrada: ni la separación
   * respecto del high-watermark quedó dentro de `maximum_event_gap_ms` (un perfil de medición no lo
   * tiene) ni existe todavía un `HistoryRecoveryResult` que la decida. No produce incidencia; impide
   * reportar `healthy`.
   */
  readonly pendingContinuitySymbols: string[];
  /** Ticks en orden canónico: `event_time_utc`, `tick_fingerprint_sha256`, `observation_id`. */
  readonly ticks: MarketTick[];
}

interface ObservedTick {
  readonly order: number;
  readonly tick: UnflaggedTick;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// Orden canónico de ticks, incidencias y condiciones del dataset. contracts lo vuelve a comprobar
// con sus propios comparadores: dataset-consistency.ts para ticks e incidencias y conditions.ts para
// condiciones. Deben coincidir con estos (estado-del-codigo D-06 y D-13).
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTicks(left: MarketTick, right: MarketTick): number {
  return (
    compareStrings(left.event_time_utc, right.event_time_utc) ||
    compareStrings(left.tick_fingerprint_sha256, right.tick_fingerprint_sha256) ||
    compareStrings(left.observation_id, right.observation_id)
  );
}

function compareIncidents(left: DataQualityIncident, right: DataQualityIncident): number {
  return (
    compareStrings(left.observed_at_utc, right.observed_at_utc) ||
    compareStrings(left.incident_type, right.incident_type) ||
    compareStrings(left.incident_id, right.incident_id)
  );
}

function compareConditions(
  left: OperationalConditionEvent,
  right: OperationalConditionEvent,
): number {
  return (
    compareStrings(left.occurred_at_utc, right.occurred_at_utc) ||
    compareStrings(left.condition_event_id, right.condition_event_id)
  );
}

/**
 * Motor puro de normalización y calidad (reglas 1.0.0 y 2.0.0).
 *
 * Recorre los source events en orden de observación persistido y produce ticks, incidencias
 * derivables y eventos de condición. Solo usa source events, esquema, perfil y versiones; no lee
 * reloj, red, aleatoriedad ni artefactos derivados previos, por lo que replay recompone lo mismo.
 * Las reglas del high-watermark, la continuidad, las conexiones y los huecos son las de
 * `derivation-rules.ts`, que comparte con la derivación en pliegue del estado vivo (ADR-0017 §3).
 *
 * Con un perfil de medición deriva el estado vivo sin umbrales (ADR-0015 §2): sin `delivery_delayed`,
 * y con la continuidad tras un cierre no pedido pendiente hasta que la decide la historia. Publicar
 * con él sigue prohibido (`buildDatasetPublication`).
 */
export function deriveMarketData(
  segments: readonly (readonly unknown[])[],
  profile: PipelineProfile,
): DerivedMarketData {
  const { maximum_delivery_delay_ms: maximumDelay, maximum_event_gap_ms: maximumGap } =
    derivationThresholds(profile);
  const events: SourceEvent[] = segments.flat().map((event) => sourceEventSchema.parse(event));

  const incidents: DataQualityIncident[] = [];
  const conditions: OperationalConditionEvent[] = [];
  const flags = new Map<string, Set<IncidentType>>();
  const observedTicks: ObservedTick[] = [];
  const firstByFingerprint = new Map<string, string>();
  const firstByEventTime = new Map<string, { fingerprint: string; observationId: string }>();
  const state = emptyRuleState();
  const sink: RuleSink = {
    condition: (condition) => conditions.push(condition),
    incident: (incident) => incidents.push(incident),
  };

  const addFlag = (observationId: string, type: IncidentType) => {
    const set = flags.get(observationId) ?? new Set<IncidentType>();
    set.add(type);
    flags.set(observationId, set);
  };

  const emitIncident = (body: IncidentBody) => {
    incidents.push(buildIncident(profile, body));
  };

  const onRawFrame = (event: Extract<SourceEvent, { kind: 'raw_source_frame' }>, order: number) => {
    const result = normalizeRawFrame(event, profile);
    if (!result.ok && result.reason === 'non_tick') {
      // Reglas 2.0.0: mensaje que no es tick; queda en el log raw sin tick ni incidencia.
      return;
    }
    if (!result.ok) {
      emitIncident({
        evidence: { raw_payload_sha256: event.raw_payload_sha256, reason: result.reason },
        incident_type: 'invalid_source_frame',
        observed_at_utc: event.received_at_utc,
        observed_ref: event.observation_id,
        related_refs: [],
        symbol: result.symbol,
      });
      return;
    }

    const { tick } = result;
    const observationId = tick.observation_id;
    const fingerprint = tick.tick_fingerprint_sha256;
    observedTicks.push({ order, tick });

    const common = {
      observed_at_utc: tick.received_at_utc,
      observed_ref: observationId,
      symbol: tick.symbol,
    };

    // duplicate_exact: fingerprint igual a una observación previa del dataset.
    const firstWithFingerprint = firstByFingerprint.get(fingerprint);
    if (firstWithFingerprint === undefined) {
      firstByFingerprint.set(fingerprint, observationId);
    } else {
      emitIncident({
        ...common,
        evidence: { tick_fingerprint_sha256: fingerprint },
        incident_type: 'duplicate_exact',
        related_refs: [firstWithFingerprint],
      });
      addFlag(observationId, 'duplicate_exact');
    }

    // source_time_conflict: misma fuente+símbolo+tiempo con fingerprint distinto de la primera
    // observación de ese instante.
    const timeKey = JSON.stringify([tick.source, tick.symbol, tick.event_time_utc]);
    const reference = firstByEventTime.get(timeKey);
    if (reference === undefined) {
      firstByEventTime.set(timeKey, { fingerprint, observationId });
    } else if (reference.fingerprint !== fingerprint) {
      emitIncident({
        ...common,
        evidence: {
          event_time_utc: tick.event_time_utc,
          tick_fingerprints: sortedUnique([fingerprint, reference.fingerprint]),
        },
        incident_type: 'source_time_conflict',
        related_refs: [reference.observationId],
      });
      addFlag(observationId, 'source_time_conflict');
    }

    // out_of_order: evento estrictamente anterior al high-watermark del símbolo.
    const watermark = applyTickWatermark(state, tick);
    if (watermark !== undefined) {
      emitIncident({
        ...common,
        evidence: { event_time_utc: tick.event_time_utc, high_watermark_utc: watermark.eventTime },
        incident_type: 'out_of_order',
        related_refs: [watermark.observationId],
      });
      addFlag(observationId, 'out_of_order');
    }

    applyTickContinuity(state, tick, maximumGap);

    // delivery_delayed: recepción menos evento supera el perfil. Sin umbral no se evalúa.
    const delay = Date.parse(tick.received_at_utc) - Date.parse(tick.event_time_utc);
    if (maximumDelay !== null && delay > maximumDelay) {
      emitIncident({
        ...common,
        evidence: { delay_ms: delay, maximum_delivery_delay_ms: maximumDelay },
        incident_type: 'delivery_delayed',
        related_refs: [],
      });
      addFlag(observationId, 'delivery_delayed');
    }
  };

  /**
   * Observaciones que delimitan el hueco entre las ya registradas: la de mayor tiempo anterior a
   * `from` y la de menor tiempo posterior a `to` (empates: la primera observada).
   */
  const gapBoundaries = (event: {
    from_event_time_utc: string;
    symbol: string;
    to_event_time_utc: string;
  }) => {
    let before: ObservedTick | undefined;
    let after: ObservedTick | undefined;
    for (const candidate of observedTicks) {
      const { tick } = candidate;
      if (tick.symbol !== event.symbol) {
        continue;
      }
      if (
        tick.event_time_utc < event.from_event_time_utc &&
        (before === undefined || tick.event_time_utc > before.tick.event_time_utc)
      ) {
        before = candidate;
      }
      if (
        tick.event_time_utc > event.to_event_time_utc &&
        (after === undefined || tick.event_time_utc < after.tick.event_time_utc)
      ) {
        after = candidate;
      }
    }
    return {
      ...(after === undefined ? {} : { after: after.tick.observation_id }),
      ...(before === undefined ? {} : { before: before.tick.observation_id }),
    };
  };

  const seenIds = new Set<string>();
  events.forEach((event, order) => {
    assertProvenance(event, profile);
    const id = sourceEventKey(event);
    if (seenIds.has(id)) {
      throw new TypeError(`ID de source event repetido: ${id}`);
    }
    seenIds.add(id);
    switch (event.kind) {
      case 'raw_source_frame':
        onRawFrame(event, order);
        break;
      case 'connection_closed':
        applyConnectionClosed(state, event, profile, sink);
        break;
      case 'connection_opened':
        applyConnectionOpened(state, event, profile, sink);
        break;
      case 'history_recovery_result': {
        const extremes = applyHistoryRecovery(state, event, profile, sink, () =>
          gapBoundaries(event),
        );
        if (extremes?.after !== undefined) {
          addFlag(extremes.after, 'event_gap_unresolved');
        }
        break;
      }
    }
  });

  const ticks = observedTicks
    .map(({ tick }) =>
      marketTickSchema.parse({
        ...tick,
        quality_flags: [...(flags.get(tick.observation_id) ?? [])].sort(),
      }),
    )
    .sort(compareTicks);
  const orderedIncidents = incidents.toSorted(compareIncidents);
  const causality = validateConditionCausality({
    conditions: conditions.toSorted(compareConditions),
    incidents: orderedIncidents,
    sourceEvents: events,
  });
  const { pendingGaps, pendingSymbols } = pendingGapsOf(state.pendingContinuity);

  return {
    conditions: causality.conditions,
    incidents: orderedIncidents,
    openConditionTypes: causality.openConditionTypes,
    pendingContinuitySymbols: pendingSymbols,
    pendingGaps,
    ticks,
  };
}
