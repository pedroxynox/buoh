/**
 * La vista de cada instante (ADR-0024 §2, versión `data-view-1.0.0`): aplica los source events de
 * un log de uno en uno, en el orden del log y desde su segmento 0, con el pliegue de ADR-0017
 * (`LiveFolder`), y después de cada uno da lo que se sabía en ese instante: cada tick que se puede
 * usar, con las marcas que `deriveMarketData` le da con el log hasta el source event que lo trajo
 * (sin `event_gap_unresolved`) más `after_unrecorded`, y la salud del log cada vez que cambia.
 *
 * Su memoria no crece con el log: guarda el estado vivo, las huellas de los ticks con la hora del
 * high-watermark de cada símbolo y, mientras la continuidad está pendiente, hasta
 * `DATA_VIEW_RETENTION_LIMIT` ticks del flujo, con la huella y la hora de cada uno. No lee reloj,
 * red ni aleatoriedad. Falla donde falla el pliegue (ADR-0017 §3): un log que no se deriva.
 */
import {
  type HealthReport,
  type LiveDerivationState,
  type MarketTick,
  type RawSourceFrame,
  type SourceEvent,
} from '@buoh/contracts';

import { type ContinuityEntry } from './derivation-rules.js';
import { deriveLiveHealthReport } from './health.js';
import { historyFrameOf, historyTicksOf, type HistoryFrame } from './history-ticks.js';
import { emptyLiveDerivationState, LiveFolder } from './live-derivation.js';
import { type UnflaggedTick } from './normalizer.js';
import { derivationThresholds, type PipelineProfile } from './profile.js';
import { resolvesExactly } from './quality.js';

export const DATA_VIEW_VERSION = 'data-view-1.0.0';

/** Los ticks del flujo que la vista retiene como mucho con la continuidad pendiente (ADR-0024 §2). */
export const DATA_VIEW_RETENTION_LIMIT = 16_000;

/** Las marcas que dejan un tick sin usar, en el orden en que se cuentan (ADR-0024 §2). */
export const DATA_VIEW_UNUSED_FLAGS = [
  'out_of_order',
  'duplicate_exact',
  'source_time_conflict',
] as const;

export type DataViewUnusedFlag = (typeof DATA_VIEW_UNUSED_FLAGS)[number];

/** Las marcas de un tick de la vista: la de la derivación que puede tener uno usado y la propia. */
export type DataViewTickFlag = 'after_unrecorded' | 'delivery_delayed';

/** Dónde está un source event en el log: el dataset y el segmento. */
export interface DataViewPlace {
  readonly dataset_id: string;
  readonly segment_index: number;
}

/** Un tick que se puede usar, con su lugar en el log. */
export interface DataViewTick extends DataViewPlace {
  readonly event_time_utc: string;
  /** El instante en que la vista lo da (ADR-0024 §3). */
  readonly instant_utc: string;
  readonly kind: 'tick';
  readonly observation_id: string;
  readonly origin: MarketTick['origin'];
  /** Ordenadas. */
  readonly quality_flags: readonly DataViewTickFlag[];
  readonly quote_decimal: string;
  readonly symbol: string;
  readonly tick_fingerprint_sha256: string;
  /**
   * Solo con `after_unrecorded`: la hora de la fuente del último tick usado antes, del mismo símbolo
   * y del mismo log, o `null` si es el primero del log.
   */
  readonly unrecorded_since_utc?: string | null;
}

/** La salud del log y lo que la impone, cada vez que cambian (ADR-0024 §2). */
export interface DataViewHealth extends DataViewPlace {
  readonly connected_in_log: boolean;
  readonly instant_utc: string;
  readonly kind: 'health';
  /** Las condiciones abiertas, en orden de `condition_key`. */
  readonly open_conditions: readonly {
    readonly condition_key: string;
    readonly condition_type: string;
    readonly symbol: string | null;
  }[];
  readonly pending_continuity_symbols: readonly string[];
  /** `deriveLiveHealthReport` de los hechos del log, sin lo que solo ve quien ingiere. */
  readonly report: HealthReport;
  /** El `observation_id` o el `event_id` del source event que la cambió. */
  readonly source_event_id: string;
}

export type DataViewEvent = DataViewHealth | DataViewTick;

/** Un tick usable que todavía no se dio. */
interface HeldTick extends DataViewPlace {
  readonly after_unrecorded: boolean;
  readonly delivery_delayed: boolean;
  readonly event_time_utc: string;
  readonly observation_id: string;
  readonly origin: MarketTick['origin'];
  readonly quote_decimal: string;
  readonly symbol: string;
  readonly tick_fingerprint_sha256: string;
}

/** Lo que la vista guarda de un símbolo con la continuidad pendiente. */
export interface DataViewRetention {
  /** Ticks del flujo llegados con la continuidad pendiente, usables o no, hasta el techo. */
  readonly arrived: number;
  /** La hora y la huella de cada uno, en orden de llegada. */
  readonly identities: readonly {
    readonly event_time_utc: string;
    readonly tick_fingerprint_sha256: string;
  }[];
  /** Si llegó al techo: entonces ya dio los retenidos y no usará la historia de este hueco. */
  readonly overflowed: boolean;
  /** Los usables retenidos, en orden de llegada. */
  readonly retained: readonly HeldTick[];
}

export interface DataViewSymbolState {
  /** El próximo tick usado lleva `after_unrecorded`. */
  readonly after_unrecorded: boolean;
  readonly last_used_event_time_utc: string | null;
  readonly retention: DataViewRetention | null;
  readonly symbol: string;
  /** Las huellas de los ticks con la hora del high-watermark, en orden de llegada. */
  readonly watermark_fingerprints: readonly string[];
}

/** El estado de la vista, en JSON, para seguir después de un reinicio (ADR-0024 §2). */
export interface DataViewState {
  readonly finished: boolean;
  readonly health_key: string | null;
  /** Las respuestas `history` de cada conexión desde su último resultado, con su lugar. */
  readonly history_frames: readonly {
    readonly connection_id: string;
    readonly frames: readonly (DataViewPlace & { readonly frame: RawSourceFrame })[];
  }[];
  readonly last_instant_utc: string | null;
  readonly live: LiveDerivationState;
  /** Por símbolo, en orden. */
  readonly symbols: readonly DataViewSymbolState[];
  /** Los ticks que no dio, por la primera de sus marcas. */
  readonly unused_ticks: Readonly<Record<DataViewUnusedFlag, number>>;
  readonly version: typeof DATA_VIEW_VERSION;
}

interface MutableRetention {
  arrived: number;
  identities: { event_time_utc: string; tick_fingerprint_sha256: string }[];
  overflowed: boolean;
  retained: HeldTick[];
}

interface MutableSymbol {
  afterUnrecorded: boolean;
  lastUsed: string | null;
  retention: MutableRetention | null;
  watermarkFingerprints: string[];
}

interface StoredFrame extends DataViewPlace {
  readonly frame: RawSourceFrame;
  readonly parsed: HistoryFrame;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** El estado de una vista que todavía no aplicó ningún evento. */
export function emptyDataViewState(): DataViewState {
  return {
    finished: false,
    health_key: null,
    history_frames: [],
    last_instant_utc: null,
    live: emptyLiveDerivationState(),
    symbols: [],
    unused_ticks: { duplicate_exact: 0, out_of_order: 0, source_time_conflict: 0 },
    version: DATA_VIEW_VERSION,
  };
}

/** La vista de un log, evento a evento. */
export class DataView {
  private readonly folder: LiveFolder;
  private readonly maximumDelay: number | null;
  private readonly symbols = new Map<string, MutableSymbol>();
  private readonly historyFrames = new Map<string, StoredFrame[]>();
  private readonly unused: Record<DataViewUnusedFlag, number>;
  private finished: boolean;
  private healthKey: string | null;
  private lastInstant: string | null;

  constructor(
    private readonly profile: PipelineProfile,
    state: DataViewState = emptyDataViewState(),
  ) {
    if ((state.version as string) !== DATA_VIEW_VERSION) {
      throw new TypeError(`Versión de la vista no soportada: ${state.version}.`);
    }
    this.folder = new LiveFolder(state.live, profile);
    this.maximumDelay = derivationThresholds(profile).maximum_delivery_delay_ms;
    this.unused = { ...state.unused_ticks };
    this.finished = state.finished;
    this.healthKey = state.health_key;
    this.lastInstant = state.last_instant_utc;
    for (const item of state.symbols) {
      this.symbols.set(item.symbol, {
        afterUnrecorded: item.after_unrecorded,
        lastUsed: item.last_used_event_time_utc,
        retention:
          item.retention === null
            ? null
            : {
                arrived: item.retention.arrived,
                identities: item.retention.identities.map((entry) => ({ ...entry })),
                overflowed: item.retention.overflowed,
                retained: [...item.retention.retained],
              },
        watermarkFingerprints: [...item.watermark_fingerprints],
      });
    }
    for (const { connection_id, frames } of state.history_frames) {
      this.historyFrames.set(
        connection_id,
        frames.map((item) => ({ ...item, parsed: historyFrameOf(item.frame) })),
      );
    }
  }

  /** El estado actual, en JSON. */
  state(): DataViewState {
    return {
      finished: this.finished,
      health_key: this.healthKey,
      history_frames: [...this.historyFrames.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([connection_id, frames]) => ({
          connection_id,
          frames: frames.map(({ dataset_id, frame, segment_index }) => ({
            dataset_id,
            frame,
            segment_index,
          })),
        })),
      last_instant_utc: this.lastInstant,
      live: this.folder.state(),
      symbols: [...this.symbols.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([symbol, item]) => ({
          after_unrecorded: item.afterUnrecorded,
          last_used_event_time_utc: item.lastUsed,
          retention:
            item.retention === null
              ? null
              : {
                  arrived: item.retention.arrived,
                  identities: item.retention.identities.map((entry) => ({ ...entry })),
                  overflowed: item.retention.overflowed,
                  retained: [...item.retention.retained],
                },
          symbol,
          watermark_fingerprints: [...item.watermarkFingerprints],
        })),
      unused_ticks: { ...this.unused },
      version: DATA_VIEW_VERSION,
    };
  }

  /**
   * Aplica el siguiente source event del log, que está en `place`, y da lo que se supo con él: con
   * un frame, primero el cambio de salud y después su tick, que ya era durable con ella; con los
   * demás, primero los ticks y después el cambio de salud (ADR-0024 §2).
   */
  apply(value: unknown, place: DataViewPlace): DataViewEvent[] {
    if (this.finished) {
      throw new TypeError('La vista ya terminó su log.');
    }
    const { event, normalized, pendingBefore } = this.folder.apply(value);
    const instant = this.instantOf(
      event.kind === 'raw_source_frame' ? event.received_at_utc : event.occurred_at_utc,
    );
    const ticks: DataViewTick[] = [];
    switch (event.kind) {
      case 'raw_source_frame':
        if (normalized?.ok === true) {
          this.onTick(normalized.tick, place, instant, ticks);
        } else if (
          normalized?.ok === false &&
          normalized.reason === 'non_tick' &&
          normalized.msg_type === 'history' &&
          this.profile.rules.history_ticks
        ) {
          const list = this.historyFrames.get(event.connection_id) ?? [];
          list.push({ ...place, frame: event, parsed: historyFrameOf(event) });
          this.historyFrames.set(event.connection_id, list);
        }
        break;
      case 'connection_closed':
        this.onClosed(event);
        break;
      case 'connection_opened':
        break;
      case 'history_recovery_result':
        this.onHistoryResult(event, pendingBefore, instant, ticks);
        break;
    }
    const health = this.healthChange(event, place, instant);
    if (health === null) {
      return ticks;
    }
    return event.kind === 'raw_source_frame' ? [health, ...ticks] : [...ticks, health];
  }

  /**
   * El fin del log: con la continuidad pendiente, da los retenidos con `instantUtc`, el del primer
   * evento del log siguiente, el primero con `after_unrecorded`, porque la historia ya no decide su
   * hueco (ADR-0024 §2). Después la vista no acepta más eventos.
   */
  finish(instantUtc: string): DataViewTick[] {
    if (this.finished) {
      throw new TypeError('La vista ya terminó su log.');
    }
    this.finished = true;
    const instant = this.instantOf(instantUtc);
    const ticks: DataViewTick[] = [];
    for (const symbol of [...this.symbols.keys()].sort()) {
      const item = this.symbolOf(symbol);
      const retention = item.retention;
      if (retention === null) {
        continue;
      }
      item.retention = null;
      if (!retention.overflowed) {
        item.afterUnrecorded = true;
        this.emitBatch(item, retention.retained, instant, ticks);
      }
    }
    return ticks;
  }

  /** El instante de un evento: su hora, o la del evento previo si es anterior (ADR-0024 §3). */
  private instantOf(own: string): string {
    const instant = this.lastInstant !== null && own < this.lastInstant ? this.lastInstant : own;
    this.lastInstant = instant;
    return instant;
  }

  private symbolOf(symbol: string): MutableSymbol {
    let item = this.symbols.get(symbol);
    if (item === undefined) {
      // El primer tick de cada log lleva `after_unrecorded`.
      item = { afterUnrecorded: true, lastUsed: null, retention: null, watermarkFingerprints: [] };
      this.symbols.set(symbol, item);
    }
    return item;
  }

  private onTick(
    tick: UnflaggedTick,
    place: DataViewPlace,
    instant: string,
    out: DataViewTick[],
  ): void {
    const item = this.symbolOf(tick.symbol);
    const fingerprint = tick.tick_fingerprint_sha256;
    const watermark = this.folder.watermarkOf(tick.symbol);
    // El pliegue ya aplicó el tick: si subió el high-watermark, es suyo.
    let unused: DataViewUnusedFlag | null = null;
    if (watermark?.observationId === tick.observation_id) {
      item.watermarkFingerprints = [fingerprint];
    } else if (watermark?.eventTime === tick.event_time_utc) {
      // Con la hora del high-watermark: los ticks anteriores con esa hora son los de esta lista.
      if (item.watermarkFingerprints.includes(fingerprint)) {
        unused = 'duplicate_exact';
      } else {
        unused = 'source_time_conflict';
        item.watermarkFingerprints.push(fingerprint);
      }
    } else {
      unused = 'out_of_order';
    }

    const retention = item.retention;
    const retaining = retention !== null && !retention.overflowed;
    if (retaining) {
      retention.arrived += 1;
      retention.identities.push({
        event_time_utc: tick.event_time_utc,
        tick_fingerprint_sha256: fingerprint,
      });
    }
    const pending = this.folder.pendingOf(tick.symbol);
    if (unused !== null) {
      this.unused[unused] += 1;
    }
    const held: HeldTick | null =
      unused === null
        ? {
            after_unrecorded: false,
            dataset_id: place.dataset_id,
            delivery_delayed:
              this.maximumDelay !== null &&
              Date.parse(tick.received_at_utc) - Date.parse(tick.event_time_utc) >
                this.maximumDelay,
            event_time_utc: tick.event_time_utc,
            observation_id: tick.observation_id,
            origin: tick.origin,
            quote_decimal: tick.quote_decimal,
            segment_index: place.segment_index,
            symbol: tick.symbol,
            tick_fingerprint_sha256: fingerprint,
          }
        : null;

    if (!retaining) {
      if (pending === undefined) {
        item.retention = null;
      }
      if (held !== null) {
        this.emitBatch(item, [held], instant, out);
      }
      return;
    }
    if (pending === undefined) {
      // La separación demostró la continuidad: da lo retenido y este tick, sin marca.
      item.retention = null;
      this.emitBatch(
        item,
        held === null ? retention.retained : [...retention.retained, held],
        instant,
        out,
      );
      return;
    }
    if (held !== null) {
      if (item.afterUnrecorded) {
        // Un cierre pedido con el fin del hueco ya conocido: su intervalo no lo cubre la historia.
        item.afterUnrecorded = false;
        retention.retained.push({ ...held, after_unrecorded: true });
      } else {
        retention.retained.push(held);
      }
    }
    if (retention.arrived >= DATA_VIEW_RETENTION_LIMIT) {
      // El techo: da los retenidos, el primero con la marca, y el hueco cuenta como no recuperado.
      const retained = retention.retained;
      item.retention = {
        arrived: retention.arrived,
        identities: [],
        overflowed: true,
        retained: [],
      };
      item.afterUnrecorded = true;
      this.emitBatch(item, retained, instant, out);
    }
  }

  private onClosed(event: Extract<SourceEvent, { kind: 'connection_closed' }>): void {
    // Una conexión cerrada ya no deja resultados de historia (ADR-0015 §4).
    this.historyFrames.delete(event.connection_id);
    for (const symbol of event.affected_symbols) {
      const pending = this.folder.pendingOf(symbol);
      const item = this.symbols.get(symbol);
      if (item === undefined) {
        // Sin ticks en el log: el primero ya llevará la marca.
        continue;
      }
      if (event.closure_type === 'requested') {
        // Un cierre pedido deja un intervalo sin datos, salvo dentro de un hueco cuyo fin todavía no
        // se conoce: ese intervalo lo decide la historia del hueco.
        if (!(
          pending !== undefined &&
          pending.end === undefined &&
          item.retention !== null &&
          !item.retention.overflowed
        )) {
          item.afterUnrecorded = true;
        }
        continue;
      }
      if (pending === undefined) {
        continue;
      }
      if (item.retention === null) {
        // Un hueco nuevo: la historia decide todo lo posterior a su inicio, el último tick usado.
        item.retention = { arrived: 0, identities: [], overflowed: false, retained: [] };
        if (item.lastUsed === pending.watermark) {
          item.afterUnrecorded = false;
        }
      } else if (item.retention.overflowed) {
        // Pasado el techo, la historia de este hueco no se usa: este cierre deja otro intervalo.
        item.afterUnrecorded = true;
      }
    }
  }

  private onHistoryResult(
    event: Extract<SourceEvent, { kind: 'history_recovery_result' }>,
    pendingBefore: ContinuityEntry | undefined,
    instant: string,
    out: DataViewTick[],
  ): void {
    const frames = this.historyFrames.get(event.connection_id) ?? [];
    this.historyFrames.delete(event.connection_id);
    const item = this.symbols.get(event.symbol);
    const retention = item?.retention ?? null;
    if (
      item === undefined ||
      retention === null ||
      this.folder.pendingOf(event.symbol) !== undefined
    ) {
      // El resultado no decidió la continuidad pendiente de su símbolo.
      return;
    }
    item.retention = null;
    if (retention.overflowed) {
      return;
    }
    const batch = [...retention.retained];
    let recovered: boolean;
    if (event.status !== 'complete') {
      recovered = false;
    } else if (this.profile.rules.history_ticks && resolvesExactly(event, pendingBefore)) {
      batch.push(...this.historyHeld(event, frames, retention));
      recovered = true;
    } else {
      // Sin los ticks de la historia, la vista no tiene los que recuperó.
      recovered = event.recovered_event_count === 0;
    }
    if (!recovered) {
      item.afterUnrecorded = true;
    }
    this.emitBatch(
      item,
      batch.sort((left, right) => compareStrings(left.event_time_utc, right.event_time_utc)),
      instant,
      out,
    );
  }

  /**
   * Los ticks usables que trae la historia: `duplicate_exact` y `source_time_conflict` contra los
   * del flujo llegados con la continuidad pendiente, los únicos que pueden tener su hora, y contra
   * los de su misma historia, como `deriveMarketData`.
   */
  private historyHeld(
    event: Extract<SourceEvent, { kind: 'history_recovery_result'; status: 'complete' }>,
    frames: readonly StoredFrame[],
    retention: MutableRetention,
  ): HeldTick[] {
    const fingerprints = new Set<string>();
    const firstByTime = new Map<string, string>();
    for (const identity of retention.identities) {
      fingerprints.add(identity.tick_fingerprint_sha256);
      if (!firstByTime.has(identity.event_time_utc)) {
        firstByTime.set(identity.event_time_utc, identity.tick_fingerprint_sha256);
      }
    }
    const places = new Map(frames.map((item) => [item.frame.observation_id, item]));
    const held: HeldTick[] = [];
    for (const tick of historyTicksOf(
      event,
      frames.map((item) => item.parsed),
    )) {
      const fingerprint = tick.tick_fingerprint_sha256;
      let unused: DataViewUnusedFlag | null = null;
      if (fingerprints.has(fingerprint)) {
        unused = 'duplicate_exact';
      } else {
        fingerprints.add(fingerprint);
      }
      const first = firstByTime.get(tick.event_time_utc);
      if (first === undefined) {
        firstByTime.set(tick.event_time_utc, fingerprint);
      } else if (first !== fingerprint) {
        unused ??= 'source_time_conflict';
      }
      if (unused !== null) {
        this.unused[unused] += 1;
        continue;
      }
      const place = places.get(tick.observation_id);
      if (place === undefined) {
        throw new TypeError(`Tick de historia sin su página: ${tick.observation_id}.`);
      }
      held.push({
        after_unrecorded: false,
        dataset_id: place.dataset_id,
        delivery_delayed: false,
        event_time_utc: tick.event_time_utc,
        observation_id: tick.observation_id,
        origin: tick.origin,
        quote_decimal: tick.quote_decimal,
        segment_index: place.segment_index,
        symbol: tick.symbol,
        tick_fingerprint_sha256: fingerprint,
      });
    }
    return held;
  }

  /** Da unos ticks usables en su orden, con el instante y la marca de cada uno. */
  private emitBatch(
    item: MutableSymbol,
    batch: readonly HeldTick[],
    instant: string,
    out: DataViewTick[],
  ): void {
    for (const held of batch) {
      const flagged = held.after_unrecorded || item.afterUnrecorded;
      item.afterUnrecorded = false;
      const flags: DataViewTickFlag[] = [];
      if (flagged) {
        flags.push('after_unrecorded');
      }
      if (held.delivery_delayed) {
        flags.push('delivery_delayed');
      }
      out.push({
        dataset_id: held.dataset_id,
        event_time_utc: held.event_time_utc,
        instant_utc: instant,
        kind: 'tick',
        observation_id: held.observation_id,
        origin: held.origin,
        quality_flags: flags,
        quote_decimal: held.quote_decimal,
        segment_index: held.segment_index,
        symbol: held.symbol,
        tick_fingerprint_sha256: held.tick_fingerprint_sha256,
        ...(flagged ? { unrecorded_since_utc: item.lastUsed } : {}),
      });
      item.lastUsed = held.event_time_utc;
    }
  }

  /** La salud, si cambió ella o lo que la impone. */
  private healthChange(
    event: SourceEvent,
    place: DataViewPlace,
    instant: string,
  ): DataViewHealth | null {
    const facts = this.folder.facts();
    const openConditions = facts.openConditions.map((condition) => ({
      condition_key: condition.condition_key,
      condition_type: condition.condition_type,
      symbol: condition.symbol,
    }));
    const key = JSON.stringify([
      facts.connectedInLog,
      facts.lastRaw !== null,
      openConditions.map((condition) => condition.condition_key),
      facts.pendingContinuitySymbols,
    ]);
    if (key === this.healthKey) {
      return null;
    }
    this.healthKey = key;
    return {
      connected_in_log: facts.connectedInLog,
      dataset_id: place.dataset_id,
      instant_utc: instant,
      kind: 'health',
      open_conditions: openConditions,
      pending_continuity_symbols: facts.pendingContinuitySymbols,
      report: deriveLiveHealthReport({
        backlog_bytes: 0,
        backlog_count: 0,
        last_published_dataset_id: null,
        source: this.profile.source,
        view: facts,
      }),
      segment_index: place.segment_index,
      source_event_id: event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
    };
  }
}
