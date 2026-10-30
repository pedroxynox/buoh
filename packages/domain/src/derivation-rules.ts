/**
 * Reglas que comparten la derivación completa (`deriveMarketData`) y la derivación en pliegue del
 * estado vivo (`foldLiveDerivation`, ADR-0017 §3): el high-watermark, la continuidad tras un cierre
 * no pedido, las condiciones de conexión y los huecos, y los constructores de sus incidencias y
 * condiciones, con los mismos cuerpos e IDs derivados (ADR-0004 §4).
 */
import {
  dataQualityIncidentSchema,
  deriveConnectionConditionKey,
  deriveEventId,
  deriveGapConditionKey,
  type ConnectionClosed,
  type ConnectionOpened,
  type DataQualityIncident,
  type HistoryRecoveryResult,
  type JsonValue,
  type OperationalConditionEvent,
  type SourceEvent,
} from '@buoh/contracts';

import { type UnflaggedTick } from './normalizer.js';
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

/**
 * Hueco de un símbolo cuya continuidad está pendiente (ADR-0015 §2): el rango que tiene que cubrir
 * un `HistoryRecoveryResult` para decidirlo. `to_event_time_utc` es `null` mientras no llegue el
 * primer tick posterior al último cierre, que fija el fin del hueco.
 */
export interface PendingGap {
  /** High-watermark del inicio del hueco + 1 ms. */
  readonly from_event_time_utc: string;
  readonly symbol: string;
  /** Primer tick posterior al último cierre − 1 ms, nunca antes de `from_event_time_utc`. */
  readonly to_event_time_utc: string | null;
}

/** High-watermark de un símbolo: el mayor tiempo de evento y la observación que lo fijó. */
export interface WatermarkEntry {
  readonly eventTime: string;
  readonly observationId: string;
}

/**
 * Continuidad pendiente de un símbolo:
 * - `watermark`: high-watermark en el primer cierre no solicitado (inicio del hueco);
 * - `closeWatermark`: high-watermark en el último cierre; solo decide un tick posterior a él;
 * - `exceeded`: ya se supo que el hueco supera el umbral; solo una recuperación lo decide;
 * - `end`: tiempo del primer tick posterior al último cierre (fin del hueco a cubrir).
 */
export interface ContinuityEntry {
  readonly closeWatermark: string;
  readonly end?: string;
  readonly exceeded: boolean;
  readonly watermark: string;
}

/** El estado que las reglas compartidas leen y cambian. */
export interface RuleState {
  readonly highWatermark: Map<string, WatermarkEntry>;
  readonly openConnection: Map<string, OperationalConditionEvent>;
  readonly openGap: Map<string, OperationalConditionEvent>;
  readonly pendingContinuity: Map<string, ContinuityEntry>;
}

export function emptyRuleState(): RuleState {
  return {
    highWatermark: new Map(),
    openConnection: new Map(),
    openGap: new Map(),
    pendingContinuity: new Map(),
  };
}

/** Recibe cada incidencia y cada condición que las reglas emiten, en el orden en que las emiten. */
export interface RuleSink {
  readonly condition: (condition: OperationalConditionEvent) => void;
  readonly incident: (incident: DataQualityIncident) => void;
}

export interface IncidentBody {
  evidence: Record<string, unknown>;
  incident_type: keyof typeof DERIVABLE_INCIDENT_SEVERITY;
  observed_at_utc: string;
  observed_ref: string;
  related_refs: readonly string[];
  symbol: string | null;
}

export type ConditionBody = {
  cause_refs: readonly string[];
  condition_key: string;
  condition_type: keyof typeof RESOLUTION_REASONS;
  occurred_at_utc: string;
  symbol: string | null;
} & ({ action: 'opened' } | { action: 'resolved'; resolution_reason: string });

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function withDerivedId<K extends string>(key: K, body: Record<string, unknown>) {
  return { ...body, [key]: deriveEventId(body as JsonValue) } as Record<string, unknown> &
    Record<K, `sha256:${string}`>;
}

/** Incidencia derivable con su ID derivado, las versiones del perfil y su severidad fija. */
export function buildIncident(profile: PipelineProfile, body: IncidentBody): DataQualityIncident {
  return dataQualityIncidentSchema.parse(
    withDerivedId('incident_id', {
      ...body,
      quality_rule_version: profile.rules.quality_rule_version,
      related_refs: sortedUnique(body.related_refs),
      schema_version: profile.rules.incident_schema_version,
      severity: DERIVABLE_INCIDENT_SEVERITY[body.incident_type],
      source: profile.source,
    }),
  );
}

/** Evento de condición con su ID derivado. */
export function buildCondition(source: string, body: ConditionBody): OperationalConditionEvent {
  return withDerivedId('condition_event_id', {
    ...body,
    cause_refs: sortedUnique(body.cause_refs),
    schema_version: CONTRACT_SCHEMA_VERSION,
    source,
  }) as unknown as OperationalConditionEvent;
}

/** Procedencia de un source event: versión del contrato, fuente y conector del perfil. */
export function assertProvenance(event: SourceEvent, profile: PipelineProfile): void {
  if (event.schema_version !== CONTRACT_SCHEMA_VERSION) {
    throw new TypeError(
      `schema_version ${event.schema_version} de source event no soportada; se esperaba ${CONTRACT_SCHEMA_VERSION}.`,
    );
  }
  if (event.source !== profile.source) {
    throw new TypeError(
      `Source event de otra fuente: ${event.source}; se esperaba ${profile.source}.`,
    );
  }
  if (event.kind === 'raw_source_frame' && event.connector_version !== profile.connector_version) {
    throw new TypeError(
      `connector_version ${event.connector_version} no coincide con el perfil ${profile.connector_version}.`,
    );
  }
}

/** El ID de un source event: `observation_id` en un raw frame y `event_id` en los demás. */
export function sourceEventKey(event: SourceEvent): string {
  return event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;
}

/**
 * Sube el high-watermark del símbolo con un tick posterior. Si el tick es estrictamente anterior,
 * es `out_of_order` y devuelve el high-watermark contra el que lo es; si no, `undefined`.
 */
export function applyTickWatermark(
  state: RuleState,
  tick: UnflaggedTick,
): WatermarkEntry | undefined {
  const watermark = state.highWatermark.get(tick.symbol);
  if (watermark !== undefined && tick.event_time_utc < watermark.eventTime) {
    return watermark;
  }
  if (watermark === undefined || tick.event_time_utc > watermark.eventTime) {
    state.highWatermark.set(tick.symbol, {
      eventTime: tick.event_time_utc,
      observationId: tick.observation_id,
    });
  }
  return undefined;
}

/**
 * `gap_detection = after_reconnection`: decide solo el primer tick estrictamente posterior al
 * high-watermark del último cierre (uno igual o anterior no informa sobre el intervalo). Si el hueco
 * no estaba excedido y la separación desde su inicio no supera el perfil, demuestra continuidad; si
 * no, fija el fin del hueco y solo un `HistoryRecoveryResult` lo decide. Sin umbral (perfil de
 * medición), la separación nunca la demuestra.
 */
export function applyTickContinuity(
  state: RuleState,
  tick: UnflaggedTick,
  maximumGap: number | null,
): void {
  const pending = state.pendingContinuity.get(tick.symbol);
  if (
    pending === undefined ||
    pending.end !== undefined ||
    !(tick.event_time_utc > pending.closeWatermark)
  ) {
    return;
  }
  if (
    !pending.exceeded &&
    maximumGap !== null &&
    Date.parse(tick.event_time_utc) - Date.parse(pending.watermark) <= maximumGap
  ) {
    state.pendingContinuity.delete(tick.symbol);
  } else {
    state.pendingContinuity.set(tick.symbol, {
      ...pending,
      end: tick.event_time_utc,
      exceeded: true,
    });
  }
}

/** Un cierre no pedido deja pendiente la continuidad y abre `connection_lost`. */
export function applyConnectionClosed(
  state: RuleState,
  event: ConnectionClosed,
  profile: PipelineProfile,
  sink: RuleSink,
): void {
  if (event.closure_type === 'requested') {
    return;
  }
  for (const symbol of event.affected_symbols) {
    const watermark = state.highWatermark.get(symbol);
    const pending = state.pendingContinuity.get(symbol);
    if (pending !== undefined) {
      // Ya pendiente: conserva el inicio y lo ya sabido del hueco; el siguiente tick posterior al
      // high-watermark actual fija el nuevo fin, así una recuperación debe cubrir todos los huecos.
      state.pendingContinuity.set(symbol, {
        closeWatermark: watermark?.eventTime ?? pending.closeWatermark,
        exceeded: pending.exceeded,
        watermark: pending.watermark,
      });
    } else if (watermark !== undefined) {
      state.pendingContinuity.set(symbol, {
        closeWatermark: watermark.eventTime,
        exceeded: false,
        watermark: watermark.eventTime,
      });
    }
  }
  const incident = buildIncident(profile, {
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
  sink.incident(incident);
  if (state.openConnection.has(event.connection_id)) {
    throw new TypeError(`La conexión ${event.connection_id} se cerró dos veces.`);
  }
  const opening = buildCondition(profile.source, {
    action: 'opened',
    cause_refs: [incident.incident_id],
    condition_key: deriveConnectionConditionKey(profile.source, event.connection_id),
    condition_type: 'connection_lost',
    occurred_at_utc: event.occurred_at_utc,
    symbol: null,
  });
  sink.condition(opening);
  state.openConnection.set(event.connection_id, opening);
}

/** Una apertura que supera una conexión con `connection_lost` abierta lo resuelve. */
export function applyConnectionOpened(
  state: RuleState,
  event: ConnectionOpened,
  profile: PipelineProfile,
  sink: RuleSink,
): void {
  if (event.supersedes_connection_id === null) {
    return;
  }
  const opening = state.openConnection.get(event.supersedes_connection_id);
  if (opening === undefined) {
    return;
  }
  state.openConnection.delete(event.supersedes_connection_id);
  sink.condition(
    buildCondition(profile.source, {
      action: 'resolved',
      cause_refs: [event.event_id, opening.condition_event_id],
      condition_key: opening.condition_key,
      condition_type: 'connection_lost',
      occurred_at_utc: event.occurred_at_utc,
      resolution_reason: RESOLUTION_REASONS.connection_lost,
      symbol: null,
    }),
  );
}

/** Las observaciones que delimitan un hueco no resuelto: la anterior a su inicio y la posterior a su fin. */
export interface GapBoundaries {
  readonly after?: string;
  readonly before?: string;
}

/**
 * Un resultado que cubre el hueco pendiente lo decide: `complete` demuestra continuidad;
 * `partial` y `unavailable` lo convierten en un hueco explícito, con su incidencia y su condición.
 * Un rango que no lo cubre no decide la continuidad. `boundaries` recibe la continuidad pendiente
 * del símbolo antes del resultado y da los extremos de un hueco no resuelto. Devuelve esos extremos,
 * o `null` con un resultado `complete`.
 */
export function applyHistoryRecovery(
  state: RuleState,
  event: HistoryRecoveryResult,
  profile: PipelineProfile,
  sink: RuleSink,
  boundaries: (pendingBefore: ContinuityEntry | undefined) => GapBoundaries,
): GapBoundaries | null {
  const pending = state.pendingContinuity.get(event.symbol);
  if (
    pending?.end !== undefined &&
    Date.parse(event.from_event_time_utc) <= Date.parse(pending.watermark) + 1 &&
    Date.parse(event.to_event_time_utc) >= Date.parse(pending.end) - 1
  ) {
    state.pendingContinuity.delete(event.symbol);
  }
  const conditionKey = deriveGapConditionKey({
    from_event_time_utc: event.from_event_time_utc,
    source: profile.source,
    symbol: event.symbol,
    to_event_time_utc: event.to_event_time_utc,
  });

  if (event.status === 'complete') {
    const opening = state.openGap.get(conditionKey);
    if (opening !== undefined) {
      state.openGap.delete(conditionKey);
      sink.condition(
        buildCondition(profile.source, {
          action: 'resolved',
          cause_refs: [event.event_id, opening.condition_event_id],
          condition_key: conditionKey,
          condition_type: 'event_gap_unresolved',
          occurred_at_utc: event.occurred_at_utc,
          resolution_reason: RESOLUTION_REASONS.event_gap_unresolved,
          symbol: event.symbol,
        }),
      );
    }
    return null;
  }

  // `partial` y `unavailable` no demuestran continuidad.
  const extremes = boundaries(pending);
  const incident = buildIncident(profile, {
    evidence: {
      from_event_time_utc: event.from_event_time_utc,
      reason: event.reason,
      to_event_time_utc: event.to_event_time_utc,
    },
    incident_type: 'event_gap_unresolved',
    observed_at_utc: event.occurred_at_utc,
    observed_ref: event.event_id,
    related_refs: [extremes.before, extremes.after].filter(
      (item): item is string => item !== undefined,
    ),
    symbol: event.symbol,
  });
  sink.incident(incident);
  if (!state.openGap.has(conditionKey)) {
    const opening = buildCondition(profile.source, {
      action: 'opened',
      cause_refs: [incident.incident_id],
      condition_key: conditionKey,
      condition_type: 'event_gap_unresolved',
      occurred_at_utc: event.occurred_at_utc,
      symbol: event.symbol,
    });
    sink.condition(opening);
    state.openGap.set(conditionKey, opening);
  }
  return extremes;
}

/** El rango del hueco pendiente que acepta `applyHistoryRecovery`: inicio + 1 ms y fin − 1 ms. */
export function pendingGapOf(symbol: string, pending: ContinuityEntry): PendingGap {
  const from = Date.parse(pending.watermark) + 1;
  return {
    from_event_time_utc: new Date(from).toISOString(),
    symbol,
    to_event_time_utc:
      pending.end === undefined
        ? null
        : new Date(Math.max(Date.parse(pending.end) - 1, from)).toISOString(),
  };
}

/** Los símbolos con continuidad pendiente, en orden, y sus huecos, en el mismo orden. */
export function pendingGapsOf(pendingContinuity: ReadonlyMap<string, ContinuityEntry>): {
  readonly pendingGaps: PendingGap[];
  readonly pendingSymbols: string[];
} {
  const pendingSymbols = [...pendingContinuity.keys()].sort();
  const pendingGaps = pendingSymbols.map((symbol) => {
    const pending = pendingContinuity.get(symbol);
    if (pending === undefined) {
      throw new TypeError(`Continuidad pendiente sin estado para ${symbol}.`);
    }
    return pendingGapOf(symbol, pending);
  });
  return { pendingGaps, pendingSymbols };
}
