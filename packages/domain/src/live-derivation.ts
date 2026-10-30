/**
 * Derivación en pliegue del estado vivo (ADR-0017 §2 a §4): parte de un estado vivo, aplica los
 * source events en el orden del log con las reglas de `derivation-rules.ts`, las mismas de
 * `deriveMarketData`, y devuelve el estado vivo nuevo. El estado queda acotado: una entrada por
 * símbolo, por hueco pendiente o por condición abierta. No reproduce las incidencias de duplicado,
 * conflicto, fuera de orden y retraso, las marcas de los ticks ni la lista de ticks, porque ningún
 * lector en vivo las usa.
 */
import {
  canonicalJson,
  LIVE_STATE_VERSION,
  liveDerivationCheckpointSchema,
  sha256Hex,
  sourceEventSchema,
  type DataQualityIncident,
  type HistoryRecoveryResult,
  type LiveCheckpointVersions,
  type LiveDerivationCheckpoint,
  type LiveDerivationState,
  type OperationalConditionEvent,
} from '@buoh/contracts';

import {
  applyConnectionClosed,
  applyConnectionOpened,
  applyHistoryRecovery,
  applyTickContinuity,
  applyTickWatermark,
  assertProvenance,
  emptyRuleState,
  pendingGapOf,
  pendingGapsOf,
  sourceEventKey,
  type ContinuityEntry,
  type GapBoundaries,
  type PendingGap,
  type RuleSink,
  type RuleState,
} from './derivation-rules.js';
import { normalizeRawFrame, type UnflaggedTick } from './normalizer.js';
import {
  CONTRACT_SCHEMA_VERSION,
  derivationThresholds,
  SEGMENT_POLICY_VERSION,
  type PipelineProfile,
} from './profile.js';

const CHECKPOINT_SCHEMA_VERSION = '1.0.0';

type CanonicalTick = LiveDerivationState['watermarks'][number]['canonical_tick'];
type GapTracking = Omit<
  LiveDerivationState['pending_continuity'][number],
  'close_watermark_utc' | 'end_utc' | 'exceeded' | 'symbol' | 'watermark_utc'
>;
type OpenCondition = LiveDerivationState['open_conditions'][number];

/** Lo que usan los lectores en vivo (ADR-0017 §4), calculado del estado vivo. */
export interface LiveDerivationView {
  /** `connectedInLog` de `deriveHealthReport`. */
  readonly connectedInLog: boolean;
  /** Cotización canónica de los extremos de cada hueco pendiente, como las lee `gapState`. */
  readonly gapQuotes: readonly {
    readonly end_quote: string | null;
    readonly start_quote: string | null;
    readonly symbol: string;
  }[];
  readonly lastConnectionEventTimeUtc: string | null;
  readonly lastEventConnectionId: string | null;
  /** El `last_event_time_utc` de `HealthReport`: el mayor high-watermark. */
  readonly lastEventTimeUtc: string | null;
  readonly lastRaw: { readonly observation_id: string; readonly received_at_utc: string } | null;
  /** Aperturas sin resolver, con su incidencia causal, en orden de `condition_key`. */
  readonly openConditions: readonly {
    readonly condition: OperationalConditionEvent;
    readonly incident: DataQualityIncident;
  }[];
  readonly openConditionTypes: readonly string[];
  readonly pendingContinuitySymbols: readonly string[];
  readonly pendingGaps: readonly PendingGap[];
  /** `PreviousConnection` de la reparación de cierres. */
  readonly previousConnection: {
    readonly closed_at_utc: string | null;
    readonly connection_id: string;
  } | null;
  /** Si algún frame se rechazó con `symbol_not_allowed` (`isOtherSymbol`). */
  readonly symbolNotAllowedSeen: boolean;
  /** El high-watermark de cada símbolo, en orden. */
  readonly watermarks: readonly { readonly event_time_utc: string; readonly symbol: string }[];
}

/** El estado vivo de un log vacío. */
export function emptyLiveDerivationState(): LiveDerivationState {
  return {
    connected_in_log: false,
    last_connection_event_time_utc: null,
    last_event_connection_id: null,
    last_raw: null,
    open_conditions: [],
    pending_continuity: [],
    previous_connection: null,
    symbol_not_allowed_seen: false,
    watermarks: [],
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** El primero de dos ticks del mismo instante en orden canónico. */
function canonicalFirst(current: CanonicalTick | null, candidate: CanonicalTick): CanonicalTick {
  if (current === null) {
    return candidate;
  }
  const order =
    compareStrings(candidate.tick_fingerprint_sha256, current.tick_fingerprint_sha256) ||
    compareStrings(candidate.observation_id, current.observation_id);
  return order < 0 ? candidate : current;
}

function shift(instantUtc: string, ms: number): string {
  return new Date(Date.parse(instantUtc) + ms).toISOString();
}

function canonicalOf(tick: UnflaggedTick): CanonicalTick {
  return {
    observation_id: tick.observation_id,
    quote_decimal: tick.quote_decimal,
    tick_fingerprint_sha256: tick.tick_fingerprint_sha256,
  };
}

/** El estado vivo en estructuras de trabajo, para aplicar eventos. */
class WorkingState {
  readonly rules: RuleState = emptyRuleState();
  readonly watermarkCanonical = new Map<string, CanonicalTick>();
  readonly gaps = new Map<string, GapTracking>();
  /** Incidencia causal de cada apertura sin resolver, por `condition_event_id`. */
  readonly openIncidents = new Map<string, DataQualityIncident>();
  connectedInLog = false;
  lastConnectionEventTime: string | null = null;
  lastEventConnectionId: string | null = null;
  lastRaw: { observation_id: string; received_at_utc: string } | null = null;
  previousConnection: { closed_at_utc: string | null; connection_id: string } | null = null;
  symbolNotAllowedSeen = false;

  constructor(state: LiveDerivationState) {
    for (const item of state.watermarks) {
      this.rules.highWatermark.set(item.symbol, {
        eventTime: item.event_time_utc,
        observationId: item.observation_id,
      });
      this.watermarkCanonical.set(item.symbol, item.canonical_tick);
    }
    for (const item of state.pending_continuity) {
      this.rules.pendingContinuity.set(item.symbol, {
        closeWatermark: item.close_watermark_utc,
        ...(item.end_utc === null ? {} : { end: item.end_utc }),
        exceeded: item.exceeded,
        watermark: item.watermark_utc,
      });
      this.gaps.set(item.symbol, {
        after_tick: item.after_tick,
        end_canonical_tick: item.end_canonical_tick,
        start_canonical_tick: item.start_canonical_tick,
        watermark_observation_id: item.watermark_observation_id,
      });
    }
    for (const { closed_connection_id, condition, incident } of state.open_conditions) {
      if (closed_connection_id === null) {
        this.rules.openGap.set(condition.condition_key, condition);
      } else {
        this.rules.openConnection.set(closed_connection_id, condition);
      }
      this.openIncidents.set(condition.condition_event_id, incident);
    }
    this.connectedInLog = state.connected_in_log;
    this.lastConnectionEventTime = state.last_connection_event_time_utc;
    this.lastEventConnectionId = state.last_event_connection_id;
    this.lastRaw = state.last_raw;
    this.previousConnection = state.previous_connection;
    this.symbolNotAllowedSeen = state.symbol_not_allowed_seen;
  }

  toState(): LiveDerivationState {
    const watermarks = [...this.rules.highWatermark.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([symbol, entry]) => {
        const canonical = this.watermarkCanonical.get(symbol);
        if (canonical === undefined) {
          throw new TypeError(`High-watermark sin tick canónico para ${symbol}.`);
        }
        return {
          canonical_tick: canonical,
          event_time_utc: entry.eventTime,
          observation_id: entry.observationId,
          symbol,
        };
      });
    const pending = [...this.rules.pendingContinuity.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([symbol, entry]) => {
        const tracking = this.gaps.get(symbol);
        if (tracking === undefined) {
          throw new TypeError(`Continuidad pendiente sin extremos para ${symbol}.`);
        }
        return {
          after_tick: tracking.after_tick,
          close_watermark_utc: entry.closeWatermark,
          end_canonical_tick: tracking.end_canonical_tick,
          end_utc: entry.end ?? null,
          exceeded: entry.exceeded,
          start_canonical_tick: tracking.start_canonical_tick,
          symbol,
          watermark_observation_id: tracking.watermark_observation_id,
          watermark_utc: entry.watermark,
        };
      });
    // `openConnection` va por la `connection_id` cerrada de cada `connection_lost` abierto.
    const openings: OpenCondition[] = [
      ...[...this.rules.openConnection.entries()].map(([closedConnectionId, condition]) => ({
        closed_connection_id: closedConnectionId,
        condition,
      })),
      ...[...this.rules.openGap.values()].map((condition) => ({
        closed_connection_id: null,
        condition,
      })),
    ]
      .map(({ closed_connection_id, condition }) => {
        const incident = this.openIncidents.get(condition.condition_event_id);
        if (incident === undefined) {
          throw new TypeError(`Apertura sin incidencia causal: ${condition.condition_key}.`);
        }
        return { closed_connection_id, condition, incident };
      })
      .sort((left, right) =>
        compareStrings(left.condition.condition_key, right.condition.condition_key),
      );
    return {
      connected_in_log: this.connectedInLog,
      last_connection_event_time_utc: this.lastConnectionEventTime,
      last_event_connection_id: this.lastEventConnectionId,
      last_raw: this.lastRaw,
      open_conditions: openings,
      pending_continuity: pending,
      previous_connection: this.previousConnection,
      symbol_not_allowed_seen: this.symbolNotAllowedSeen,
      watermarks,
    };
  }
}

/** El fin del rango pendiente (`to_event_time_utc`) de una continuidad con fin. */
function rangeEnd(symbol: string, pending: ContinuityEntry): string {
  const gap = pendingGapOf(symbol, pending);
  if (gap.to_event_time_utc === null) {
    throw new TypeError(`Hueco pendiente sin fin para ${symbol}.`);
  }
  return gap.to_event_time_utc;
}

/**
 * Aplica los source events, en el orden del log, sobre un estado vivo y devuelve el nuevo. Falla
 * igual que `deriveMarketData` donde ella falla, y además con un resultado `partial` o
 * `unavailable` que no cubre exactamente el hueco pendiente de su símbolo (ADR-0017 §3, «Dominio de
 * la equivalencia»).
 */
export function foldLiveDerivation(
  state: LiveDerivationState,
  events: readonly unknown[],
  profile: PipelineProfile,
): LiveDerivationState {
  const { maximum_event_gap_ms: maximumGap } = derivationThresholds(profile);
  const working = new WorkingState(state);
  /** Las aperturas vistas, por su ID, para comprobar que su resolución va después (ADR-0017 §3). */
  const openings = new Map<string, OperationalConditionEvent>(
    [...working.rules.openConnection.values(), ...working.rules.openGap.values()].map(
      (condition) => [condition.condition_event_id, condition],
    ),
  );
  let lastIncident: DataQualityIncident | null = null;
  const sink: RuleSink = {
    condition: (condition) => {
      if (condition.action === 'opened') {
        if (lastIncident === null || !condition.cause_refs.includes(lastIncident.incident_id)) {
          throw new TypeError(`Apertura sin incidencia causal: ${condition.condition_key}.`);
        }
        openings.set(condition.condition_event_id, condition);
        working.openIncidents.set(condition.condition_event_id, lastIncident);
        return;
      }
      const opening = condition.cause_refs
        .map((reference) => openings.get(reference))
        .find((item) => item !== undefined);
      if (opening === undefined) {
        throw new TypeError(`Resolución sin apertura: ${condition.condition_key}.`);
      }
      // `validateConditionCausality` ordena por `occurred_at_utc` y después por
      // `condition_event_id`: una resolución que quedaría antes que su apertura no la supera.
      const order =
        compareStrings(opening.occurred_at_utc, condition.occurred_at_utc) ||
        compareStrings(opening.condition_event_id, condition.condition_event_id);
      if (order >= 0) {
        throw new TypeError(
          `La resolución quedaría antes que su apertura: ${condition.condition_key}.`,
        );
      }
      openings.delete(opening.condition_event_id);
      working.openIncidents.delete(opening.condition_event_id);
    },
    incident: (incident) => {
      lastIncident = incident;
    },
  };

  const onTick = (tick: UnflaggedTick) => {
    const { symbol } = tick;
    const reference = canonicalOf(tick);
    const watermark = working.rules.highWatermark.get(symbol);
    if (watermark === undefined || tick.event_time_utc > watermark.eventTime) {
      working.watermarkCanonical.set(symbol, reference);
    } else if (tick.event_time_utc === watermark.eventTime) {
      working.watermarkCanonical.set(
        symbol,
        canonicalFirst(working.watermarkCanonical.get(symbol) ?? null, reference),
      );
    }
    applyTickWatermark(working.rules, tick);

    const before = working.rules.pendingContinuity.get(symbol);
    const tracking = working.gaps.get(symbol);
    if (before !== undefined && tracking !== undefined) {
      if (tick.event_time_utc === before.watermark) {
        tracking.start_canonical_tick = canonicalFirst(tracking.start_canonical_tick, reference);
      }
      if (before.end !== undefined) {
        const to = rangeEnd(symbol, before);
        if (
          tick.event_time_utc > to &&
          (tracking.after_tick === null || tick.event_time_utc < tracking.after_tick.event_time_utc)
        ) {
          tracking.after_tick = {
            event_time_utc: tick.event_time_utc,
            observation_id: tick.observation_id,
          };
        }
        if (tick.event_time_utc === shift(to, 1)) {
          tracking.end_canonical_tick = canonicalFirst(tracking.end_canonical_tick, reference);
        }
      }
    }

    applyTickContinuity(working.rules, tick, maximumGap);
    const after = working.rules.pendingContinuity.get(symbol);
    if (after === undefined) {
      working.gaps.delete(symbol);
    } else if (before?.end === undefined && after.end !== undefined && tracking !== undefined) {
      // Este tick fijó el fin del hueco.
      const to = rangeEnd(symbol, after);
      tracking.after_tick =
        tick.event_time_utc > to
          ? { event_time_utc: tick.event_time_utc, observation_id: tick.observation_id }
          : null;
      tracking.end_canonical_tick = tick.event_time_utc === shift(to, 1) ? reference : null;
    }
  };

  const boundariesFor =
    (event: HistoryRecoveryResult) =>
    (pending: ContinuityEntry | undefined): GapBoundaries => {
      const tracking = working.gaps.get(event.symbol);
      if (
        pending?.end === undefined ||
        tracking === undefined ||
        event.from_event_time_utc !== pendingGapOf(event.symbol, pending).from_event_time_utc ||
        event.to_event_time_utc !== rangeEnd(event.symbol, pending)
      ) {
        throw new TypeError(
          `El resultado ${event.event_id} no cubre exactamente el hueco pendiente de ${event.symbol} (ADR-0017 §3).`,
        );
      }
      return {
        ...(tracking.after_tick === null ? {} : { after: tracking.after_tick.observation_id }),
        before: tracking.watermark_observation_id,
      };
    };

  const seenIds = new Set<string>();
  for (const value of events) {
    const event = sourceEventSchema.parse(value);
    assertProvenance(event, profile);
    const id = sourceEventKey(event);
    if (seenIds.has(id)) {
      throw new TypeError(`ID de source event repetido: ${id}`);
    }
    seenIds.add(id);
    lastIncident = null;

    switch (event.kind) {
      case 'raw_source_frame': {
        working.lastRaw = {
          observation_id: event.observation_id,
          received_at_utc: event.received_at_utc,
        };
        working.connectedInLog = true;
        const result = normalizeRawFrame(event, profile);
        if (result.ok) {
          onTick(result.tick);
        } else if (result.reason === 'symbol_not_allowed') {
          working.symbolNotAllowedSeen = true;
        }
        break;
      }
      case 'connection_closed': {
        working.lastConnectionEventTime = event.occurred_at_utc;
        working.connectedInLog = false;
        if (working.previousConnection?.connection_id === event.connection_id) {
          working.previousConnection = {
            ...working.previousConnection,
            closed_at_utc: event.occurred_at_utc,
          };
        }
        const pendingBefore = new Map(working.rules.pendingContinuity);
        applyConnectionClosed(working.rules, event, profile, sink);
        for (const symbol of event.affected_symbols) {
          const previous = pendingBefore.get(symbol);
          const current = working.rules.pendingContinuity.get(symbol);
          const watermark = working.rules.highWatermark.get(symbol);
          const canonical = working.watermarkCanonical.get(symbol);
          if (
            previous === undefined &&
            current !== undefined &&
            watermark !== undefined &&
            canonical !== undefined
          ) {
            working.gaps.set(symbol, {
              after_tick: null,
              end_canonical_tick: null,
              start_canonical_tick: canonical,
              watermark_observation_id: watermark.observationId,
            });
          } else if (previous !== undefined && current !== undefined) {
            const tracking = working.gaps.get(symbol);
            if (tracking !== undefined) {
              tracking.after_tick = null;
              tracking.end_canonical_tick = null;
            }
          }
        }
        break;
      }
      case 'connection_opened':
        working.previousConnection = { closed_at_utc: null, connection_id: event.connection_id };
        working.lastConnectionEventTime = event.occurred_at_utc;
        working.connectedInLog = true;
        applyConnectionOpened(working.rules, event, profile, sink);
        break;
      case 'history_recovery_result':
        applyHistoryRecovery(working.rules, event, profile, sink, boundariesFor(event));
        if (!working.rules.pendingContinuity.has(event.symbol)) {
          working.gaps.delete(event.symbol);
        }
        break;
    }
    working.lastEventConnectionId = event.connection_id;
  }
  return working.toState();
}

/** La vista viva (ADR-0017 §4) de un estado vivo. */
export function liveDerivationView(state: LiveDerivationState): LiveDerivationView {
  const pendingContinuity = new Map<string, ContinuityEntry>(
    state.pending_continuity.map((item) => [
      item.symbol,
      {
        closeWatermark: item.close_watermark_utc,
        ...(item.end_utc === null ? {} : { end: item.end_utc }),
        exceeded: item.exceeded,
        watermark: item.watermark_utc,
      },
    ]),
  );
  const { pendingGaps, pendingSymbols } = pendingGapsOf(pendingContinuity);
  const tracked = new Map(state.pending_continuity.map((item) => [item.symbol, item]));
  const lastEventTimeUtc = state.watermarks.reduce<string | null>(
    (latest, item) =>
      latest === null || item.event_time_utc > latest ? item.event_time_utc : latest,
    null,
  );
  return {
    connectedInLog: state.connected_in_log,
    gapQuotes: pendingGaps.map((gap) => {
      const item = tracked.get(gap.symbol);
      return {
        end_quote:
          gap.to_event_time_utc === null ? null : (item?.end_canonical_tick?.quote_decimal ?? null),
        start_quote: item?.start_canonical_tick.quote_decimal ?? null,
        symbol: gap.symbol,
      };
    }),
    lastConnectionEventTimeUtc: state.last_connection_event_time_utc,
    lastEventConnectionId: state.last_event_connection_id,
    lastEventTimeUtc,
    lastRaw: state.last_raw,
    openConditions: state.open_conditions.map(({ condition, incident }) => ({
      condition,
      incident,
    })),
    openConditionTypes: [
      ...new Set(state.open_conditions.map((item) => item.condition.condition_type)),
    ].sort(),
    pendingContinuitySymbols: pendingSymbols,
    pendingGaps,
    previousConnection: state.previous_connection,
    symbolNotAllowedSeen: state.symbol_not_allowed_seen,
    watermarks: state.watermarks.map((item) => ({
      event_time_utc: item.event_time_utc,
      symbol: item.symbol,
    })),
  };
}

/** Las versiones de ADR-0017 §6 con las que se deriva con este perfil. */
export function liveCheckpointVersions(profile: PipelineProfile): LiveCheckpointVersions {
  return {
    connector_version: profile.connector_version,
    live_state_version: LIVE_STATE_VERSION,
    quality_profile_sha256: profile.quality_profile_sha256,
    quality_rule_version: profile.rules.quality_rule_version,
    segment_policy_version: SEGMENT_POLICY_VERSION,
    source_event_schema_version: CONTRACT_SCHEMA_VERSION,
    source_schema_sha256: profile.source_schema_sha256,
  };
}

/** El punto de control del estado vivo al final de un segmento cerrado (ADR-0017 §5). */
export function buildLiveDerivationCheckpoint(input: {
  readonly event_count: number;
  readonly profile: PipelineProfile;
  readonly raw_frame_count: number;
  readonly segment_index: number;
  readonly segment_logical_content_sha256: string;
  readonly state: LiveDerivationState;
  readonly symbol: string;
}): LiveDerivationCheckpoint {
  return liveDerivationCheckpointSchema.parse({
    event_count: input.event_count,
    raw_frame_count: input.raw_frame_count,
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    segment_index: input.segment_index,
    segment_logical_content_sha256: input.segment_logical_content_sha256,
    source: input.profile.source,
    state: input.state,
    symbol: input.symbol,
    versions: liveCheckpointVersions(input.profile),
  });
}

/**
 * Los SHA-256 de un punto de control: el de su JCS completo y el de sus versiones, que entra en la
 * clave de la tabla (ADR-0017 §5 y §6).
 */
export function liveCheckpointDigests(checkpoint: LiveDerivationCheckpoint): {
  readonly checkpoint_sha256: string;
  readonly versions_sha256: string;
} {
  return {
    checkpoint_sha256: sha256Hex(canonicalJson(checkpoint)),
    versions_sha256: sha256Hex(canonicalJson(checkpoint.versions)),
  };
}
