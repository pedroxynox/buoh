import {
  dataQualityIncidentSchema,
  deriveConnectionConditionKey,
  deriveEventId,
  deriveGapConditionKey,
  marketTickSchema,
  sourceEventSchema,
  validateConditionCausality,
  type ConnectionClosed,
  type ConnectionOpened,
  type DataQualityIncident,
  type HistoryRecoveryResult,
  type JsonValue,
  type MarketTick,
  type OperationalConditionEvent,
  type SourceEvent,
} from '@buoh/contracts';

import { normalizeRawFrame, type UnflaggedTick } from './normalizer.js';
import { CONTRACT_SCHEMA_VERSION, type PipelineProfile } from './profile.js';

type IncidentType = DataQualityIncident['incident_type'];
type Severity = DataQualityIncident['severity'];

/** Severidad fija por tipo en reglas de calidad 1.0.0 (incidencias derivables del dataset). */
export const DERIVABLE_INCIDENT_SEVERITY = {
  connection_lost: 'warning',
  delivery_delayed: 'warning',
  duplicate_exact: 'warning',
  event_gap_unresolved: 'error',
  invalid_source_frame: 'error',
  out_of_order: 'warning',
  source_time_conflict: 'error',
} as const satisfies Partial<Record<IncidentType, Severity>>;

export const RESOLUTION_REASONS = {
  connection_lost: 'connection_reestablished',
  event_gap_unresolved: 'history_recovered',
} as const;

export interface DerivedMarketData {
  /** Condiciones en orden de reducer: `occurred_at_utc`, `condition_event_id`. */
  readonly conditions: OperationalConditionEvent[];
  /** Incidencias en orden canónico: `observed_at_utc`, `incident_type`, `incident_id`. */
  readonly incidents: DataQualityIncident[];
  /** Tipos cuya última acción es `opened`, únicos y ordenados. */
  readonly openConditionTypes: string[];
  /**
   * Símbolos cuya continuidad tras una pérdida de conexión aún no está demostrada: ni la separación
   * respecto del high-watermark quedó dentro de `maximum_event_gap_ms` ni existe todavía un
   * `HistoryRecoveryResult`. No produce incidencia; impide reportar `healthy`.
   */
  readonly pendingContinuitySymbols: string[];
  /** Ticks en orden canónico: `event_time_utc`, `tick_fingerprint_sha256`, `observation_id`. */
  readonly ticks: MarketTick[];
}

type ConditionBody = {
  cause_refs: readonly string[];
  condition_key: string;
  condition_type: keyof typeof RESOLUTION_REASONS;
  occurred_at_utc: string;
  symbol: string | null;
} & ({ action: 'opened' } | { action: 'resolved'; resolution_reason: string });

interface ObservedTick {
  readonly order: number;
  readonly tick: UnflaggedTick;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// Orden canónico de ticks e incidencias del dataset. packages/contracts/src/dataset-consistency.ts
// lo valida con sus propios comparadores, que deben coincidir con estos (estado-del-codigo D-06).
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

function withDerivedId<K extends string>(key: K, body: Record<string, unknown>) {
  return { ...body, [key]: deriveEventId(body as JsonValue) } as Record<string, unknown> &
    Record<K, `sha256:${string}`>;
}

/**
 * Motor puro de normalización y calidad (reglas 1.0.0).
 *
 * Recorre los source events en orden de observación persistido y produce ticks, incidencias
 * derivables y eventos de condición. Solo usa source events, esquema, perfil y versiones; no lee
 * reloj, red, aleatoriedad ni artefactos derivados previos, por lo que replay recompone lo mismo.
 */
export function deriveMarketData(
  segments: readonly (readonly unknown[])[],
  profile: PipelineProfile,
): DerivedMarketData {
  const events: SourceEvent[] = segments.flat().map((event) => sourceEventSchema.parse(event));
  const source = profile.source;
  const maximumDelay = profile.quality_profile.maximum_delivery_delay_ms;
  const maximumGap = profile.quality_profile.maximum_event_gap_ms;

  const incidents: DataQualityIncident[] = [];
  const conditions: OperationalConditionEvent[] = [];
  const flags = new Map<string, Set<IncidentType>>();
  const observedTicks: ObservedTick[] = [];
  const firstByFingerprint = new Map<string, string>();
  const firstByEventTime = new Map<string, { fingerprint: string; observationId: string }>();
  const highWatermark = new Map<string, { eventTime: string; observationId: string }>();
  const openConnection = new Map<string, OperationalConditionEvent>();
  const openGap = new Map<string, OperationalConditionEvent>();
  /**
   * Continuidad pendiente por símbolo:
   * - `watermark`: high-watermark en el primer cierre no solicitado (inicio del hueco);
   * - `closeWatermark`: high-watermark en el último cierre; solo decide un tick posterior a él;
   * - `exceeded`: ya se supo que el hueco supera el umbral; solo una recuperación lo decide;
   * - `end`: tiempo del primer tick posterior al último cierre (fin del hueco a cubrir).
   */
  const pendingContinuity = new Map<
    string,
    { closeWatermark: string; end?: string; exceeded: boolean; watermark: string }
  >();

  const addFlag = (observationId: string, type: IncidentType) => {
    const set = flags.get(observationId) ?? new Set<IncidentType>();
    set.add(type);
    flags.set(observationId, set);
  };

  const emitIncident = (body: {
    evidence: Record<string, unknown>;
    incident_type: keyof typeof DERIVABLE_INCIDENT_SEVERITY;
    observed_at_utc: string;
    observed_ref: string;
    related_refs: readonly string[];
    symbol: string | null;
  }): DataQualityIncident => {
    const incident = dataQualityIncidentSchema.parse(
      withDerivedId('incident_id', {
        ...body,
        quality_rule_version: profile.rules.quality_rule_version,
        related_refs: sortedUnique(body.related_refs),
        schema_version: profile.rules.incident_schema_version,
        severity: DERIVABLE_INCIDENT_SEVERITY[body.incident_type],
        source,
      }),
    );
    incidents.push(incident);
    return incident;
  };

  const emitCondition = (body: ConditionBody): OperationalConditionEvent => {
    const condition = withDerivedId('condition_event_id', {
      ...body,
      cause_refs: sortedUnique(body.cause_refs),
      schema_version: CONTRACT_SCHEMA_VERSION,
      source,
    }) as unknown as OperationalConditionEvent;
    conditions.push(condition);
    return condition;
  };

  const assertProvenance = (event: SourceEvent) => {
    if (event.schema_version !== CONTRACT_SCHEMA_VERSION) {
      throw new TypeError(
        `schema_version ${event.schema_version} de source event no soportada; se esperaba ${CONTRACT_SCHEMA_VERSION}.`,
      );
    }
    if (event.source !== source) {
      throw new TypeError(`Source event de otra fuente: ${event.source}; se esperaba ${source}.`);
    }
    if (
      event.kind === 'raw_source_frame' &&
      event.connector_version !== profile.connector_version
    ) {
      throw new TypeError(
        `connector_version ${event.connector_version} no coincide con el perfil ${profile.connector_version}.`,
      );
    }
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
    const watermark = highWatermark.get(tick.symbol);
    if (watermark !== undefined && tick.event_time_utc < watermark.eventTime) {
      emitIncident({
        ...common,
        evidence: { event_time_utc: tick.event_time_utc, high_watermark_utc: watermark.eventTime },
        incident_type: 'out_of_order',
        related_refs: [watermark.observationId],
      });
      addFlag(observationId, 'out_of_order');
    } else if (watermark === undefined || tick.event_time_utc > watermark.eventTime) {
      highWatermark.set(tick.symbol, { eventTime: tick.event_time_utc, observationId });
    }

    // gap_detection = after_reconnection: decide solo el primer tick estrictamente posterior al
    // high-watermark del último cierre (uno igual o anterior no informa sobre el intervalo). Si el
    // hueco no estaba excedido y la separación desde su inicio no supera el perfil, demuestra
    // continuidad; si no, fija el fin del hueco y solo un HistoryRecoveryResult lo decide.
    const pending = pendingContinuity.get(tick.symbol);
    if (
      pending !== undefined &&
      pending.end === undefined &&
      tick.event_time_utc > pending.closeWatermark
    ) {
      if (
        !pending.exceeded &&
        Date.parse(tick.event_time_utc) - Date.parse(pending.watermark) <= maximumGap
      ) {
        pendingContinuity.delete(tick.symbol);
      } else {
        pendingContinuity.set(tick.symbol, {
          ...pending,
          end: tick.event_time_utc,
          exceeded: true,
        });
      }
    }

    // delivery_delayed: recepción menos evento supera el perfil.
    const delay = Date.parse(tick.received_at_utc) - Date.parse(tick.event_time_utc);
    if (delay > maximumDelay) {
      emitIncident({
        ...common,
        evidence: { delay_ms: delay, maximum_delivery_delay_ms: maximumDelay },
        incident_type: 'delivery_delayed',
        related_refs: [],
      });
      addFlag(observationId, 'delivery_delayed');
    }
  };

  const onConnectionClosed = (event: ConnectionClosed) => {
    if (event.closure_type === 'requested') {
      return;
    }
    for (const symbol of event.affected_symbols) {
      const watermark = highWatermark.get(symbol);
      const pending = pendingContinuity.get(symbol);
      if (pending !== undefined) {
        // Ya pendiente: conserva el inicio y lo ya sabido del hueco; el siguiente tick posterior al
        // high-watermark actual fija el nuevo fin, así una recuperación debe cubrir todos los huecos.
        pendingContinuity.set(symbol, {
          closeWatermark: watermark?.eventTime ?? pending.closeWatermark,
          exceeded: pending.exceeded,
          watermark: pending.watermark,
        });
      } else if (watermark !== undefined) {
        pendingContinuity.set(symbol, {
          closeWatermark: watermark.eventTime,
          exceeded: false,
          watermark: watermark.eventTime,
        });
      }
    }
    const incident = emitIncident({
      evidence: {
        affected_symbols: event.affected_symbols,
        closure_type: event.closure_type,
        reason: event.reason,
      },
      incident_type: 'connection_lost',
      observed_at_utc: event.occurred_at_utc,
      observed_ref: event.event_id,
      related_refs: [],
      symbol: null,
    });
    if (openConnection.has(event.connection_id)) {
      throw new TypeError(`La conexión ${event.connection_id} se cerró dos veces.`);
    }
    openConnection.set(
      event.connection_id,
      emitCondition({
        action: 'opened',
        cause_refs: [incident.incident_id],
        condition_key: deriveConnectionConditionKey(source, event.connection_id),
        condition_type: 'connection_lost',
        occurred_at_utc: event.occurred_at_utc,
        symbol: null,
      }),
    );
  };

  const onConnectionOpened = (event: ConnectionOpened) => {
    if (event.supersedes_connection_id === null) {
      return;
    }
    const opening = openConnection.get(event.supersedes_connection_id);
    if (opening === undefined) {
      return;
    }
    openConnection.delete(event.supersedes_connection_id);
    emitCondition({
      action: 'resolved',
      cause_refs: [event.event_id, opening.condition_event_id],
      condition_key: opening.condition_key,
      condition_type: 'connection_lost',
      occurred_at_utc: event.occurred_at_utc,
      resolution_reason: RESOLUTION_REASONS.connection_lost,
      symbol: null,
    });
  };

  /**
   * Observaciones que delimitan el hueco entre las ya registradas: la de mayor tiempo anterior a
   * `from` y la de menor tiempo posterior a `to` (empates: la primera observada).
   */
  const gapBoundaries = (event: HistoryRecoveryResult) => {
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
    return { after, before };
  };

  const onHistoryRecovery = (event: HistoryRecoveryResult) => {
    // Un resultado que cubre el hueco pendiente lo decide: complete demuestra continuidad;
    // partial/unavailable la convierten en un hueco explícito. Un rango que no lo cubre no decide.
    const pending = pendingContinuity.get(event.symbol);
    if (
      pending?.end !== undefined &&
      Date.parse(event.from_event_time_utc) <= Date.parse(pending.watermark) + 1 &&
      Date.parse(event.to_event_time_utc) >= Date.parse(pending.end) - 1
    ) {
      pendingContinuity.delete(event.symbol);
    }
    const conditionKey = deriveGapConditionKey({
      from_event_time_utc: event.from_event_time_utc,
      source,
      symbol: event.symbol,
      to_event_time_utc: event.to_event_time_utc,
    });

    if (event.status === 'complete') {
      const opening = openGap.get(conditionKey);
      if (opening !== undefined) {
        openGap.delete(conditionKey);
        emitCondition({
          action: 'resolved',
          cause_refs: [event.event_id, opening.condition_event_id],
          condition_key: conditionKey,
          condition_type: 'event_gap_unresolved',
          occurred_at_utc: event.occurred_at_utc,
          resolution_reason: RESOLUTION_REASONS.event_gap_unresolved,
          symbol: event.symbol,
        });
      }
      return;
    }

    // `partial` y `unavailable` no demuestran continuidad.
    const { after, before } = gapBoundaries(event);
    const incident = emitIncident({
      evidence: {
        from_event_time_utc: event.from_event_time_utc,
        reason: event.reason,
        to_event_time_utc: event.to_event_time_utc,
      },
      incident_type: 'event_gap_unresolved',
      observed_at_utc: event.occurred_at_utc,
      observed_ref: event.event_id,
      related_refs: [before, after]
        .filter((item): item is ObservedTick => item !== undefined)
        .map((item) => item.tick.observation_id),
      symbol: event.symbol,
    });
    if (after !== undefined) {
      addFlag(after.tick.observation_id, 'event_gap_unresolved');
    }
    if (!openGap.has(conditionKey)) {
      openGap.set(
        conditionKey,
        emitCondition({
          action: 'opened',
          cause_refs: [incident.incident_id],
          condition_key: conditionKey,
          condition_type: 'event_gap_unresolved',
          occurred_at_utc: event.occurred_at_utc,
          symbol: event.symbol,
        }),
      );
    }
  };

  const seenIds = new Set<string>();
  events.forEach((event, order) => {
    assertProvenance(event);
    const id = event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;
    if (seenIds.has(id)) {
      throw new TypeError(`ID de source event repetido: ${id}`);
    }
    seenIds.add(id);
    switch (event.kind) {
      case 'raw_source_frame':
        onRawFrame(event, order);
        break;
      case 'connection_closed':
        onConnectionClosed(event);
        break;
      case 'connection_opened':
        onConnectionOpened(event);
        break;
      case 'history_recovery_result':
        onHistoryRecovery(event);
        break;
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

  return {
    conditions: causality.conditions,
    incidents: orderedIncidents,
    openConditionTypes: causality.openConditionTypes,
    pendingContinuitySymbols: [...pendingContinuity.keys()].sort(),
    ticks,
  };
}
