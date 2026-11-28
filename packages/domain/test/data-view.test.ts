import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BACKTEST_VERSIONS,
  canonicalJson,
  connectionClosedSchema,
  dataViewEventSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  rawSourceFrameSchema,
  sha256Hex,
  sourceEventSchema,
  type HealthReport,
  type JsonValue,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPipelineProfile,
  DATA_VIEW_RETENTION_LIMIT,
  DATA_VIEW_VERSION,
  DATA_VIEW_UNUSED_FLAGS,
  DataView,
  deriveLiveHealthReport,
  deriveMarketData,
  emptyLiveDerivationState,
  foldLiveDerivation,
  ingestSyntheticStimuli,
  liveDerivationView,
  type DataViewEvent,
  type DataViewHealth,
  type DataViewPlace,
  type DataViewState,
  type DataViewTick,
  type DerivedMarketData,
  type PipelineProfile,
} from '../src/index.js';
import { liveCorpus, VECTOR_SCENARIOS, vectorSegments } from './support/live-corpus.js';

// La vista de cada instante (ADR-0024 §2 y §11). En cada evento del vector v1, de los logs escritos
// a mano y de logs aleatorios con semilla, a través de varios datasets de un log: los ticks que da y
// sus marcas son los de `deriveMarketData` con el log hasta el source event que los trajo, sin
// `event_gap_unresolved`; los que no da son los que esa derivación marca `out_of_order`,
// `duplicate_exact` o `source_time_conflict`, contados por la primera; y su salud es la de
// `deriveLiveHealthReport` con el pliegue. Los casos escritos a mano fijan además, con lo que
// esperan escrito desde la ADR, los retenidos, `after_unrecorded`, el techo y el fin del log. Fuente
// `synthetic` y símbolo `SYNTH_100`; ningún precio es de mercado.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en la vista.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en la vista.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en la vista.');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const sourceSchema = readFileSync(resolve(vectorRoot, 'source-schema.json'));
const SYMBOL = 'SYNTH_100';
/** 2026-01-01T00:00:00.000Z en segundos, como las horas de la fuente. */
const T0 = 1767225600;
const END_OF_LOG = '2026-02-01T00:00:00.000Z';

function profileFor(rules: '2.0.0' | '3.0.0', extra: Record<string, unknown> = {}) {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(
      JSON.stringify({
        allowed_symbols: [SYMBOL],
        gap_detection: 'after_reconnection',
        maximum_delivery_delay_ms: 3000,
        maximum_event_gap_ms: 2000,
        non_tick_msg_types: ['history', 'ping'],
        profile_id: `synthetic-view-${rules}`,
        quality_rule_version: rules,
        source: 'synthetic',
        ...extra,
      }),
    ),
    source_schema_bytes: sourceSchema,
    source_schema_release: 'synthetic-v1',
  });
}

const v3 = profileFor('3.0.0');
const v2 = profileFor('2.0.0');

const connection = (index: number) =>
  `019b76da-a800-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`;

/** La hora UTC del segundo `second` desde T0, corrida `milliseconds`. */
function at(second: number, milliseconds = 0): string {
  return new Date((T0 + second) * 1000 + milliseconds).toISOString();
}

/** Escribe un log sintético, evento a evento, con IDs seguidos. */
class Log {
  readonly events: SourceEvent[] = [];
  private reqId = 0;

  private id(): string {
    return `019b76da-a800-7000-8000-${(this.events.length + 1).toString().padStart(12, '0')}`;
  }

  raw(conn: string, payload: string, receivedAt: string): this {
    this.events.push(
      rawSourceFrameSchema.parse({
        connection_id: conn,
        connector_version: 'fixture-v1',
        kind: 'raw_source_frame',
        observation_id: this.id(),
        payload_utf8: payload,
        raw_payload_sha256: sha256Hex(payload),
        received_at_utc: receivedAt,
        schema_version: '1.0.0',
        source: 'synthetic',
      }),
    );
    return this;
  }

  /** El tick del segundo `second`, recibido `delayMs` después. */
  tick(conn: string, second: number, quote = '100.125', delayMs = 100): this {
    return this.raw(
      conn,
      `{"msg_type":"tick","tick":{"epoch":${String(T0 + second)},"pip_size":3,"quote":${quote},"symbol":"${SYMBOL}"}}`,
      at(second, delayMs),
    );
  }

  /** Una página de `ticks_history` del último intento, de `start` a `end` (segundos). */
  page(
    conn: string,
    start: number,
    end: number,
    ticks: readonly (readonly [number, string])[],
    receivedAt: string,
  ): this {
    this.reqId += 1;
    const times = ticks.map(([second]) => String(T0 + second)).join(',');
    const prices = ticks.map(([, quote]) => quote).join(',');
    return this.raw(
      conn,
      `{"echo_req":{"count":1000,"end":"${String(T0 + end)}","req_id":${String(this.reqId)},"start":${String(T0 + start)},"style":"ticks","ticks_history":"${SYMBOL}"},"history":{"prices":[${prices}],"times":[${times}]},"msg_type":"history","pip_size":3,"req_id":${String(this.reqId)}}`,
      receivedAt,
    );
  }

  opened(conn: string, supersedes: string | null, occurredAt: string): this {
    this.events.push(
      connectionOpenedSchema.parse({
        connection_id: conn,
        event_id: this.id(),
        kind: 'connection_opened',
        occurred_at_utc: occurredAt,
        schema_version: '1.0.0',
        source: 'synthetic',
        supersedes_connection_id: supersedes,
      }),
    );
    return this;
  }

  closed(conn: string, occurredAt: string, requested = false): this {
    this.events.push(
      connectionClosedSchema.parse({
        affected_symbols: [SYMBOL],
        closure_type: requested ? 'requested' : 'timeout',
        connection_id: conn,
        event_id: this.id(),
        kind: 'connection_closed',
        occurred_at_utc: occurredAt,
        reason: requested ? 'operator_shutdown' : 'ping_timeout',
        schema_version: '1.0.0',
        source: 'synthetic',
      }),
    );
    return this;
  }

  /** El resultado de la historia del hueco entre los segundos `from` y `to`, sin incluirlos. */
  result(
    conn: string,
    range: { readonly from: number; readonly to: number },
    outcome:
      | { readonly recovered_event_count: number; readonly status: 'complete' }
      | {
          readonly reason: string;
          readonly recovered_event_count: number;
          readonly status: 'partial';
        }
      | { readonly reason: string; readonly status: 'unavailable' },
    occurredAt: string,
  ): this {
    this.events.push(
      historyRecoveryResultSchema.parse({
        connection_id: conn,
        event_id: this.id(),
        from_event_time_utc: at(range.from, 1),
        kind: 'history_recovery_result',
        occurred_at_utc: occurredAt,
        schema_version: '1.0.0',
        source: 'synthetic',
        symbol: SYMBOL,
        to_event_time_utc: at(range.to, -1),
        ...outcome,
      }),
    );
    return this;
  }
}

/** Cuatro eventos por segmento y tres segmentos por dataset: el log cruza varios datasets. */
function placeOf(index: number): DataViewPlace {
  const segment = Math.floor(index / 4);
  const dataset = `dataset-${String(Math.floor(segment / 3))}`;
  return { dataset_id: `sha256:${sha256Hex(dataset)}`, segment_index: segment };
}

function run(events: readonly SourceEvent[], profile: PipelineProfile) {
  const view = new DataView(profile);
  const perEvent = events.map((event, index) => view.apply(event, placeOf(index)));
  const tail = view.finish(END_OF_LOG);
  return { perEvent, state: view.state(), tail };
}

const UNUSED: readonly string[] = DATA_VIEW_UNUSED_FLAGS;

function isTick(event: DataViewEvent): event is DataViewTick {
  return event.kind === 'tick';
}

function liveReport(events: readonly SourceEvent[], profile: PipelineProfile): HealthReport {
  return deriveLiveHealthReport({
    backlog_bytes: 0,
    backlog_count: 0,
    last_published_dataset_id: null,
    source: profile.source,
    view: liveDerivationView(foldLiveDerivation(emptyLiveDerivationState(), events, profile)),
  });
}

/** Lo que impone la salud del log, para saber cuándo cambia. */
function causeOf(events: readonly SourceEvent[], profile: PipelineProfile): string {
  const view = liveDerivationView(foldLiveDerivation(emptyLiveDerivationState(), events, profile));
  const report = liveReport(events, profile);
  return JSON.stringify([
    report.service_health,
    report.connection_state,
    view.openConditionTypes,
    view.pendingContinuitySymbols,
  ]);
}

/** La equivalencia de ADR-0024 §11 en un log, y que seguir desde el estado en JSON da lo mismo. */
function expectEquivalent(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
  label: string,
): ReturnType<typeof run> {
  const { perEvent, state, tail } = run(events, profile);
  const indexOf = new Map(
    events.map((event, index) => [
      event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
      index,
    ]),
  );
  const derived = new Map<number, DerivedMarketData>();
  const derivedAt = (index: number) => {
    let value = derived.get(index);
    if (value === undefined) {
      value = deriveMarketData([events.slice(0, index + 1)], profile);
      derived.set(index, value);
    }
    return value;
  };

  const given: { readonly at: number; readonly tick: DataViewTick }[] = [];
  perEvent.forEach((emitted, index) => {
    const kinds = emitted.map((item) => item.kind);
    const health = kinds.indexOf('health');
    expect(kinds.filter((kind) => kind === 'health').length, `${label}, ${String(index)}`).toBe(
      health === -1 ? 0 : 1,
    );
    if (health !== -1) {
      // Con un frame, la salud va antes que su tick; con los demás, después de los ticks.
      expect(health, `${label}, ${String(index)}`).toBe(
        events[index]?.kind === 'raw_source_frame' ? 0 : kinds.length - 1,
      );
    }
    for (const item of emitted.filter(isTick)) {
      given.push({ at: index, tick: item });
    }
  });
  for (const item of tail) {
    given.push({ at: events.length, tick: item });
  }

  // Cada evento cumple el contrato `DataViewEvent` 1.0.0, con sus reglas entre campos.
  for (const item of [...perEvent.flat(), ...tail]) {
    const parsed = dataViewEventSchema.safeParse(item);
    expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  }

  // Cada tick, con las marcas de la derivación hasta el source event que lo trajo.
  for (const { at: emittedAt, tick } of given) {
    const brought =
      tick.origin === 'history_recovery' ? emittedAt : indexOf.get(tick.observation_id);
    expect(brought, label).toBeDefined();
    expect(brought ?? Infinity, label).toBeLessThanOrEqual(emittedAt);
    const reference = derivedAt(brought ?? 0).ticks.find(
      (item) =>
        item.observation_id === tick.observation_id && item.event_time_utc === tick.event_time_utc,
    );
    expect(reference, `${label}: ${tick.event_time_utc}`).toBeDefined();
    expect(
      {
        flags: tick.quality_flags.filter((flag) => flag !== 'after_unrecorded'),
        origin: tick.origin,
        quote: tick.quote_decimal,
        symbol: tick.symbol,
        tick_fingerprint_sha256: tick.tick_fingerprint_sha256,
      },
      `${label}: ${tick.event_time_utc}`,
    ).toEqual({
      flags: reference?.quality_flags.filter((flag) => flag !== 'event_gap_unresolved'),
      origin: reference?.origin,
      quote: reference?.quote_decimal,
      symbol: reference?.symbol,
      tick_fingerprint_sha256: reference?.tick_fingerprint_sha256,
    });
  }

  // Da todos los que se usan y cuenta los demás por su primera marca.
  const full = deriveMarketData([events], profile);
  const key = (tick: { observation_id: string; event_time_utc: string }) =>
    `${tick.observation_id} ${tick.event_time_utc}`;
  expect(given.map(({ tick }) => key(tick)).sort(), label).toEqual(
    full.ticks
      .filter((tick) => !tick.quality_flags.some((flag) => UNUSED.includes(flag)))
      .map(key)
      .sort(),
  );
  const counts = Object.fromEntries(DATA_VIEW_UNUSED_FLAGS.map((flag) => [flag, 0]));
  for (const tick of full.ticks) {
    const first = DATA_VIEW_UNUSED_FLAGS.find((flag) =>
      (tick.quality_flags as readonly string[]).includes(flag),
    );
    if (first !== undefined) {
      counts[first] = (counts[first] ?? 0) + 1;
    }
  }
  expect(state.unused_ticks, label).toEqual(counts);

  // Por símbolo, las horas de la fuente crecen; los instantes nunca retroceden; y la marca propia
  // lleva la hora del tick usado antes.
  const lastBySymbol = new Map<string, string>();
  let lastInstant = '';
  for (const { tick } of given) {
    const previous = lastBySymbol.get(tick.symbol);
    if (previous !== undefined) {
      expect(tick.event_time_utc > previous, label).toBe(true);
    } else {
      expect(tick.quality_flags, label).toContain('after_unrecorded');
    }
    if (tick.quality_flags.includes('after_unrecorded')) {
      expect(tick.unrecorded_since_utc, label).toBe(previous ?? null);
    } else {
      expect(tick.unrecorded_since_utc, label).toBeUndefined();
    }
    lastBySymbol.set(tick.symbol, tick.event_time_utc);
    expect(tick.instant_utc >= lastInstant, label).toBe(true);
    lastInstant = tick.instant_utc;
  }

  // La salud, la del pliegue, cada vez que cambia.
  let latest: DataViewHealth | undefined;
  let previousCause: string | null = null;
  perEvent.forEach((emitted, index) => {
    const prefix = events.slice(0, index + 1);
    const report = liveReport(prefix, profile);
    const view = liveDerivationView(
      foldLiveDerivation(emptyLiveDerivationState(), prefix, profile),
    );
    const health = emitted.find((item): item is DataViewHealth => item.kind === 'health');
    const cause = causeOf(prefix, profile);
    if (cause !== previousCause) {
      expect(health, `${label}, ${String(index)}`).toBeDefined();
    }
    previousCause = cause;
    if (health !== undefined) {
      expect(health.report, `${label}, ${String(index)}`).toEqual(report);
      expect(
        {
          connected: health.connected_in_log,
          pending: health.pending_continuity_symbols,
          types: [...new Set(health.open_conditions.map((item) => item.condition_type))].sort(),
        },
        `${label}, ${String(index)}`,
      ).toEqual({
        connected: view.connectedInLog,
        pending: view.pendingContinuitySymbols,
        types: view.openConditionTypes,
      });
      expect(health.dataset_id, label).toBe(placeOf(index).dataset_id);
      latest = health;
    }
    expect(latest?.report.service_health, `${label}, ${String(index)}`).toBe(report.service_health);
  });

  // Seguir desde el estado en JSON canónico, en cada límite, da lo mismo.
  for (let boundary = 0; boundary <= events.length; boundary += 1) {
    const first = new DataView(profile);
    events.slice(0, boundary).forEach((event, index) => first.apply(event, placeOf(index)));
    const saved = JSON.parse(canonicalJson(first.state() as unknown as JsonValue)) as DataViewState;
    const resumed = new DataView(profile, saved);
    const rest = events
      .slice(boundary)
      .map((event, offset) => resumed.apply(event, placeOf(boundary + offset)));
    expect(rest, `${label}, límite ${String(boundary)}`).toEqual(perEvent.slice(boundary));
    expect(resumed.finish(END_OF_LOG), label).toEqual(tail);
    expect(resumed.state(), label).toEqual(state);
  }
  return { perEvent, state, tail };
}

/** Los ticks dados, como `[segundo, marcas, instante]`. */
function ticksOf(emitted: readonly DataViewEvent[]) {
  return emitted
    .filter(isTick)
    .map((tick) => [
      Date.parse(tick.event_time_utc) / 1000 - T0,
      tick.quality_flags,
      tick.instant_utc,
    ]);
}

function healthOf(emitted: readonly DataViewEvent[]) {
  return emitted.find((item): item is DataViewHealth => item.kind === 'health')?.report
    .service_health;
}

const A = connection(0);
const B = connection(1);
const C = connection(2);

/** Un tick, una reconexión y dos ticks con el hueco pendiente: el 5 fija su fin. */
function reconnection(log = new Log()): Log {
  return log
    .opened(A, null, at(-1))
    .tick(A, 0, '100.100')
    .closed(A, at(0, 500))
    .opened(B, A, at(0, 600))
    .tick(B, 5, '100.105')
    .tick(B, 6, '100.106');
}

describe('la vista de cada instante (ADR-0024 §2)', () => {
  it('es la versión que nombra BacktestSpec', () => {
    expect(DATA_VIEW_VERSION).toBe(BACKTEST_VERSIONS.data_view);
  });

  it('con un complete, da los ticks de la historia y los retenidos juntos, en orden', () => {
    const log = reconnection()
      .page(
        B,
        0,
        5,
        [
          [2, '100.102'],
          [3, '100.103'],
        ],
        at(7),
      )
      .result(B, { from: 0, to: 5 }, { recovered_event_count: 2, status: 'complete' }, at(7, 500))
      .tick(B, 7, '100.107');
    const { perEvent } = run(log.events, v3);
    expect(healthOf(perEvent[0] ?? [])).toBe('starting');
    // El primer tick del log: la salud ya es `healthy` y la marca no tiene tick anterior.
    expect(perEvent[1]?.map((item) => item.kind)).toEqual(['health', 'tick']);
    expect(ticksOf(perEvent[1] ?? [])).toEqual([[0, ['after_unrecorded'], at(0, 100)]]);
    expect(healthOf(perEvent[2] ?? [])).toBe('recovering');
    // Retenidos: nada hasta el resultado.
    expect(perEvent[4]).toEqual([]);
    expect(perEvent[5]).toEqual([]);
    expect(perEvent[6]).toEqual([]);
    expect(ticksOf(perEvent[7] ?? [])).toEqual([
      [2, [], at(7, 500)],
      [3, [], at(7, 500)],
      [5, [], at(7, 500)],
      [6, [], at(7, 500)],
    ]);
    expect(perEvent[7]?.at(-1)?.kind).toBe('health');
    expect(healthOf(perEvent[7] ?? [])).toBe('healthy');
    // El tick 7 se recibe a las 7,1 s, antes que el resultado: su instante es el del resultado.
    expect(ticksOf(perEvent[8] ?? [])).toEqual([[7, [], at(7, 500)]]);
    expectEquivalent(log.events, v3, 'complete');
  });

  it.each([
    [
      'partial',
      { reason: 'history_page_limit', recovered_event_count: 0, status: 'partial' } as const,
    ],
    ['unavailable', { reason: 'history_timeout', status: 'unavailable' } as const],
  ])('con un %s, da solo los retenidos, el primero con after_unrecorded', (_name, outcome) => {
    const log = reconnection().result(B, { from: 0, to: 5 }, outcome, at(8)).tick(B, 8, '100.108');
    const { perEvent } = run(log.events, v3);
    const emitted = perEvent[6] ?? [];
    expect(ticksOf(emitted)).toEqual([
      [5, ['after_unrecorded'], at(8)],
      [6, [], at(8)],
    ]);
    expect(emitted.find(isTick)?.unrecorded_since_utc).toBe(at(0));
    expect(healthOf(emitted)).toBe('degraded');
    expect(ticksOf(perEvent[7] ?? [])).toEqual([[8, [], at(8, 100)]]);
    expectEquivalent(log.events, v3, _name);
  });

  it('un tick de la historia que repite uno out_of_order del hueco no se usa', () => {
    const log = new Log()
      .opened(A, null, at(-1))
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 5, '100.105')
      .tick(B, 3, '100.103', 2500)
      .tick(B, 4, '100.104', 1700)
      .page(
        B,
        0,
        5,
        [
          [2, '100.102'],
          [3, '100.103'],
          [4, '100.999'],
        ],
        at(7),
      )
      .result(B, { from: 0, to: 5 }, { recovered_event_count: 3, status: 'complete' }, at(7, 500));
    const { perEvent, state } = run(log.events, v3);
    expect(ticksOf(perEvent[8] ?? []).map(([second]) => second)).toEqual([2, 5]);
    expect(state.unused_ticks).toEqual({
      duplicate_exact: 1,
      out_of_order: 2,
      source_time_conflict: 1,
    });
    expectEquivalent(log.events, v3, 'historia contra out_of_order');
  });

  it('si la separación demuestra la continuidad, el tick que la decide no lleva la marca', () => {
    const log = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 2, '100.102');
    const { perEvent } = run(log.events, v3);
    expect(perEvent[3]?.map((item) => item.kind)).toEqual(['health', 'tick']);
    expect(healthOf(perEvent[3] ?? [])).toBe('healthy');
    expect(ticksOf(perEvent[3] ?? [])).toEqual([[2, [], at(2, 100)]]);
    expectEquivalent(log.events, v3, 'separación');
  });

  it('un tick con la hora del high-watermark es un duplicado o un conflicto', () => {
    const log = new Log()
      .tick(A, 0, '100.100')
      .tick(A, 0, '100.100', 200)
      .tick(A, 0, '100.101', 300)
      .tick(A, 0, '100.101', 400)
      .tick(A, 1, '100.101');
    const { perEvent, state } = run(log.events, v3);
    expect(perEvent.slice(1, 4)).toEqual([[], [], []]);
    expect(ticksOf(perEvent[4] ?? [])).toEqual([[1, [], at(1, 100)]]);
    expect(state.unused_ticks).toEqual({
      duplicate_exact: 2,
      out_of_order: 0,
      source_time_conflict: 1,
    });
    expectEquivalent(log.events, v3, 'high-watermark');
  });

  it('una conexión que cae durante la recuperación no deja sus páginas', () => {
    const log = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 5, '100.105')
      .page(B, 0, 5, [[2, '100.102']], at(7))
      .closed(B, at(7, 500))
      .opened(C, B, at(8))
      .tick(C, 9, '100.109')
      .page(
        C,
        0,
        9,
        [
          [2, '100.102'],
          [7, '100.107'],
        ],
        at(11),
      )
      .result(C, { from: 0, to: 9 }, { recovered_event_count: 2, status: 'complete' }, at(11, 500));
    const { perEvent } = run(log.events, v3);
    expect(ticksOf(perEvent[9] ?? [])).toEqual([
      [2, [], at(11, 500)],
      [5, [], at(11, 500)],
      [7, [], at(11, 500)],
      [9, [], at(11, 500)],
    ]);
    expect(healthOf(perEvent[9] ?? [])).toBe('healthy');
    expectEquivalent(log.events, v3, 'conexión que cae');

    // Sin recuperar el hueco, cada desconexión deja su intervalo sin datos: el primer tick después
    // de cada una lleva la marca. Con un partial, con un complete de las reglas 2.0.0 y al terminar
    // el log.
    const dropped = (profile: PipelineProfile) =>
      new Log()
        .tick(A, 0, '100.100')
        .closed(A, at(0, 500))
        .opened(B, A, at(0, 600))
        .tick(B, 5, '100.105')
        .tick(B, 6, '100.106')
        .closed(B, at(7, 500))
        .opened(C, B, at(8))
        .tick(C, 9, '100.109')
        .result(
          C,
          { from: 0, to: 9 },
          profile === v2
            ? { recovered_event_count: 3, status: 'complete' }
            : { reason: 'history_page_limit', recovered_event_count: 0, status: 'partial' },
          at(11, 500),
        );
    const expected = (instant: string) => [
      [5, ['after_unrecorded'], instant],
      [6, [], instant],
      [9, ['after_unrecorded'], instant],
    ];
    for (const profile of [v3, v2]) {
      const events = dropped(profile).events;
      const result = run(events, profile).perEvent[8] ?? [];
      expect(ticksOf(result)).toEqual(expected(at(11, 500)));
      expect(result.filter(isTick).map((tick) => tick.unrecorded_since_utc)).toEqual([
        at(0),
        undefined,
        at(6),
      ]);
      expectEquivalent(
        events,
        profile,
        `conexión que cae sin recuperar (${profile.rules.quality_rule_version})`,
      );
    }
    const unfinished = dropped(v3).events.slice(0, -1);
    expect(ticksOf(run(unfinished, v3).tail)).toEqual(expected(END_OF_LOG));
    expectEquivalent(unfinished, v3, 'conexión que cae y fin del log');
  });

  it('after_unrecorded tras un cierre pedido, salvo dentro de un hueco cuyo fin no se conoce', () => {
    const withoutEnd = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .closed(B, at(1), true)
      .opened(C, B, at(4))
      .tick(C, 5, '100.105')
      .page(C, 0, 5, [[2, '100.102']], at(6))
      .result(C, { from: 0, to: 5 }, { recovered_event_count: 1, status: 'complete' }, at(6, 500));
    expect(ticksOf(run(withoutEnd.events, v3).perEvent[7] ?? [])).toEqual([
      [2, [], at(6, 500)],
      [5, [], at(6, 500)],
    ]);
    expectEquivalent(withoutEnd.events, v3, 'cierre pedido sin el fin');

    const withEnd = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 5, '100.105')
      .closed(B, at(5, 500), true)
      .opened(C, B, at(7))
      .tick(C, 8, '100.108')
      .page(C, 0, 5, [[2, '100.102']], at(9))
      .result(C, { from: 0, to: 5 }, { recovered_event_count: 1, status: 'complete' }, at(9, 500));
    const emitted = run(withEnd.events, v3).perEvent[8] ?? [];
    expect(ticksOf(emitted)).toEqual([
      [2, [], at(9, 500)],
      [5, [], at(9, 500)],
      [8, ['after_unrecorded'], at(9, 500)],
    ]);
    expect(emitted.filter(isTick)[2]?.unrecorded_since_utc).toBe(at(5));
    expectEquivalent(withEnd.events, v3, 'cierre pedido con el fin');

    // Un cierre pedido con el fin conocido y el resultado antes del siguiente tick nuevo: la marca es
    // del primer tick del flujo posterior al cierre, no del lote del resultado.
    for (const [status, atResult] of [
      [
        'complete',
        [
          [2, [], at(7)],
          [5, [], at(7)],
        ],
      ],
      ['partial', [[5, ['after_unrecorded'], at(7)]]],
    ] as const) {
      const log = new Log()
        .tick(A, 0, '100.100')
        .closed(A, at(0, 500))
        .opened(B, A, at(0, 600))
        .tick(B, 5, '100.105')
        .closed(B, at(5, 500), true)
        .opened(C, B, at(6))
        .tick(C, 5, '100.105', 1100);
      if (status === 'complete') {
        log
          .page(C, 0, 5, [[2, '100.102']], at(6, 500))
          .result(C, { from: 0, to: 5 }, { recovered_event_count: 1, status }, at(7));
      } else {
        log
          .raw(C, '{"msg_type":"ping","ping":"pong"}', at(6, 500))
          .result(
            C,
            { from: 0, to: 5 },
            { reason: 'history_page_limit', recovered_event_count: 0, status },
            at(7),
          );
      }
      log.tick(C, 8, '100.108').tick(C, 10, '100.110');
      const { perEvent } = run(log.events, v3);
      expect(ticksOf(perEvent[8] ?? []), status).toEqual(atResult);
      const next = perEvent[9] ?? [];
      expect(ticksOf(next), status).toEqual([[8, ['after_unrecorded'], at(8, 100)]]);
      expect(next.find(isTick)?.unrecorded_since_utc, status).toBe(at(5));
      expectEquivalent(log.events, v3, `cierre pedido y resultado antes del tick, ${status}`);
    }

    // Un cierre no pedido del mismo hueco después del pedido: el rango de la historia crece y
    // cubre también el intervalo del pedido, sin ticks entre los dos cierres o con uno.
    const D = connection(3);
    const noTickBetween = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 5, '100.105')
      .closed(B, at(5, 500), true)
      .opened(C, B, at(6))
      .closed(C, at(6, 500))
      .opened(D, C, at(6, 600))
      .tick(D, 9, '100.109')
      .page(
        D,
        0,
        9,
        [
          [2, '100.102'],
          [5, '100.105'],
          [7, '100.107'],
        ],
        at(10),
      )
      .result(D, { from: 0, to: 9 }, { recovered_event_count: 3, status: 'complete' }, at(10, 500));
    expect(ticksOf(run(noTickBetween.events, v3).perEvent[10] ?? [])).toEqual([
      [2, [], at(10, 500)],
      [5, [], at(10, 500)],
      [7, [], at(10, 500)],
      [9, [], at(10, 500)],
    ]);
    expectEquivalent(noTickBetween.events, v3, 'dos cierres sin ticks entre ellos');

    const widened = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500))
      .opened(B, A, at(0, 600))
      .tick(B, 5, '100.105')
      .closed(B, at(5, 500), true)
      .opened(C, B, at(6))
      .tick(C, 8, '100.108')
      .closed(C, at(8, 500))
      .opened(D, C, at(8, 600))
      .tick(D, 12, '100.112')
      .page(
        D,
        0,
        12,
        [
          [2, '100.102'],
          [5, '100.105'],
          [7, '100.107'],
          [8, '100.108'],
        ],
        at(13),
      )
      .result(
        D,
        { from: 0, to: 12 },
        { recovered_event_count: 4, status: 'complete' },
        at(13, 500),
      );
    const widenedRun = run(widened.events, v3);
    expect(ticksOf(widenedRun.perEvent[11] ?? [])).toEqual([
      [2, [], at(13, 500)],
      [5, [], at(13, 500)],
      [7, [], at(13, 500)],
      [8, [], at(13, 500)],
      [12, [], at(13, 500)],
    ]);
    expect(widenedRun.state.unused_ticks.duplicate_exact).toBe(2);
    expectEquivalent(widened.events, v3, 'cierre no pedido después del pedido');
    // Si la historia no lo recupera, los tres intervalos del hueco quedan sin datos.
    const widenedPartial = [
      ...widened.events.slice(0, 10),
      sourceEventSchema.parse({
        ...widened.events[11],
        reason: 'history_page_limit',
        recovered_event_count: 0,
        status: 'partial',
      }),
    ];
    const partialAtResult = run(widenedPartial, v3).perEvent[10] ?? [];
    expect(ticksOf(partialAtResult)).toEqual([
      [5, ['after_unrecorded'], at(13, 500)],
      [8, ['after_unrecorded'], at(13, 500)],
      [12, ['after_unrecorded'], at(13, 500)],
    ]);
    expect(partialAtResult.filter(isTick).map((tick) => tick.unrecorded_since_utc)).toEqual([
      at(0),
      at(5),
      at(8),
    ]);
    expectEquivalent(widenedPartial, v3, 'cierre no pedido después del pedido, partial');

    // Un cierre no pedido después de uno pedido, sin ticks entre los dos: la historia del hueco
    // cubre también el intervalo del pedido.
    const before = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500), true)
      .opened(B, A, at(1))
      .closed(B, at(1, 500))
      .opened(C, B, at(4))
      .tick(C, 5, '100.105')
      .page(C, 0, 5, [[2, '100.102']], at(6))
      .result(C, { from: 0, to: 5 }, { recovered_event_count: 1, status: 'complete' }, at(6, 500));
    expect(ticksOf(run(before.events, v3).perEvent[7] ?? [])).toEqual([
      [2, [], at(6, 500)],
      [5, [], at(6, 500)],
    ]);
    expectEquivalent(before.events, v3, 'cierre pedido y después uno no pedido');

    const plain = new Log()
      .tick(A, 0, '100.100')
      .closed(A, at(0, 500), true)
      .opened(B, A, at(9))
      .tick(B, 10, '100.110');
    const { perEvent } = run(plain.events, v3);
    expect(healthOf(perEvent[1] ?? [])).toBe('paused');
    expect(ticksOf(perEvent[3] ?? [])).toEqual([[10, ['after_unrecorded'], at(10, 100)]]);
    expectEquivalent(plain.events, v3, 'cierre pedido');
  });

  it('un complete sin los ticks de la historia (reglas 2.0.0) deja la marca si recuperó alguno', () => {
    for (const [count, flags] of [
      [3, ['after_unrecorded']],
      [0, []],
    ] as const) {
      const log = reconnection().result(
        B,
        { from: 0, to: 5 },
        { recovered_event_count: count, status: 'complete' },
        at(8),
      );
      expect(ticksOf(run(log.events, v2).perEvent[6] ?? [])).toEqual([
        [5, flags, at(8)],
        [6, [], at(8)],
      ]);
      expectEquivalent(log.events, v2, `reglas 2.0.0, ${String(count)}`);
    }
  });

  it('un tick que llega tarde lleva delivery_delayed', () => {
    const log = new Log()
      .tick(A, 0, '100.100')
      .tick(A, 1, '100.101', 3001)
      .tick(A, 2, '100.102', 1000);
    const { perEvent } = run(log.events, v3);
    expect(ticksOf(perEvent[1] ?? [])).toEqual([[1, ['delivery_delayed'], at(1, 3001)]]);
    // El instante no retrocede: el tick 2 se recibe a las 3 s, antes que el 1.
    expect(ticksOf(perEvent[2] ?? [])).toEqual([[2, [], at(1, 3001)]]);
    expectEquivalent(log.events, v3, 'retraso');
  });

  it('al terminar el log con la continuidad pendiente, da los retenidos con el instante dado', () => {
    const log = reconnection();
    const { perEvent, tail } = run(log.events, v3);
    expect(perEvent[5]).toEqual([]);
    expect(ticksOf(tail)).toEqual([
      [5, ['after_unrecorded'], END_OF_LOG],
      [6, [], END_OF_LOG],
    ]);
    expectEquivalent(log.events, v3, 'fin del log');
  });

  it(`el techo: retiene ${String(DATA_VIEW_RETENTION_LIMIT)} ticks y no usa la historia del hueco`, () => {
    const log = new Log().tick(A, 0, '100.100').closed(A, at(0, 500)).opened(B, A, at(0, 600));
    for (let second = 5; second < 5 + DATA_VIEW_RETENTION_LIMIT + 1; second += 1) {
      log.tick(B, second, '100.100');
    }
    // Pasado el techo, otro cierre no pedido del mismo hueco: el tick siguiente lleva la marca.
    const last = 5 + DATA_VIEW_RETENTION_LIMIT;
    log
      .closed(B, at(last, 500))
      .opened(C, B, at(last, 600))
      .tick(C, last + 5, '100.100')
      .page(C, 0, last + 5, [[2, '100.102']], at(20_000))
      .result(
        C,
        { from: 0, to: last + 5 },
        { recovered_event_count: 1, status: 'complete' },
        at(20_000, 500),
      );
    const view = new DataView(v3);
    const emitted = log.events.map((event, index) => view.apply(event, placeOf(index)));
    const limitAt = 3 + DATA_VIEW_RETENTION_LIMIT - 1;
    expect(emitted.slice(3, limitAt).every((item) => item.length === 0)).toBe(true);
    const flushed = emitted[limitAt]?.filter(isTick) ?? [];
    expect(flushed).toHaveLength(DATA_VIEW_RETENTION_LIMIT);
    expect(flushed[0]?.quality_flags).toEqual(['after_unrecorded']);
    expect(flushed[0]?.unrecorded_since_utc).toBe(at(0));
    expect(
      flushed.every((tick) => tick.instant_utc === at(5 + DATA_VIEW_RETENTION_LIMIT - 1, 100)),
    ).toBe(true);
    expect(flushed.slice(1).every((tick) => tick.quality_flags.length === 0)).toBe(true);
    // Pasado el techo, cada tick se da al llegar, y la historia no se usa.
    expect(ticksOf(emitted[limitAt + 1] ?? [])).toEqual([[last, [], at(last, 100)]]);
    const afterClose = emitted[limitAt + 4] ?? [];
    expect(ticksOf(afterClose)).toEqual([[last + 5, ['after_unrecorded'], at(last + 5, 100)]]);
    expect(afterClose.find(isTick)?.unrecorded_since_utc).toBe(at(last));
    const atResult = emitted.at(-1) ?? [];
    expect(atResult.map((item) => item.kind)).toEqual(['health']);
    expect(healthOf(atResult)).toBe('healthy');
    // La salud siguió la del log: `recovering` hasta el resultado, sin cambiar con el techo.
    expect(
      emitted
        .slice(3, limitAt + 2)
        .flat()
        .filter((item) => item.kind === 'health'),
    ).toHaveLength(0);
    expect(
      emitted
        .slice(limitAt + 2, -1)
        .flat()
        .filter((item): item is DataViewHealth => item.kind === 'health')
        .map((item) => item.report.service_health),
    ).toEqual(['recovering', 'recovering']);
  });

  it('rechaza un estado de otra versión y un log que no se deriva', () => {
    expect(
      () => new DataView(v3, { ...new DataView(v3).state(), version: 'data-view-0.9.0' as never }),
    ).toThrow(/Versión de la vista/u);
    const log = new Log().tick(A, 0).closed(A, at(0, 500)).closed(A, at(0, 600));
    const view = new DataView(v3);
    view.apply(log.events[0], placeOf(0));
    view.apply(log.events[1], placeOf(1));
    expect(() => view.apply(log.events[2], placeOf(2))).toThrow();
    const ended = new DataView(v3);
    ended.finish(END_OF_LOG);
    expect(() => ended.apply(log.events[0], placeOf(0))).toThrow(/terminó/u);
  });
});

describe('la equivalencia de la vista (ADR-0024 §11)', () => {
  const {
    corpus,
    eventsOf,
    measurement,
    publication,
    publicationV3,
    randomStimuli,
    vectorProfile,
  } = liveCorpus({ createPipelineProfile, deriveMarketData, ingestSyntheticStimuli });

  it.each(VECTOR_SCENARIOS)('el vector %s', (name, files) => {
    expectEquivalent(vectorSegments(files).flat(), vectorProfile(), name);
  });

  it.each(corpus)('%s', (name, stimuli, profile) => {
    expectEquivalent(eventsOf(stimuli, profile), profile, name);
  });

  it('300 logs aleatorios del pliegue, con los tres perfiles', { timeout: 120_000 }, () => {
    const profiles = [
      ['medición', measurement, 0],
      ['publicación', publication, 1000],
      ['publicación con las reglas 3.0.0', publicationV3, 2000],
    ] as const;
    for (const [name, profile, first] of profiles) {
      for (let seed = first + 1; seed <= first + 100; seed += 1) {
        expectEquivalent(
          eventsOf(randomStimuli(seed, profile), profile),
          profile,
          `semilla ${String(seed)} (${name})`,
        );
      }
    }
  });

  it(
    '100 logs aleatorios con páginas de historia, con las reglas 3.0.0',
    { timeout: 120_000 },
    () => {
      const seen = { batches: 0, history: 0, recovered: 0, tail: 0, unrecovered: 0, unused: 0 };
      for (let seed = 1; seed <= 100; seed += 1) {
        const events = randomHistoryLog(seed, v3);
        const { perEvent, state, tail } = expectEquivalent(events, v3, `semilla ${String(seed)}`);
        const ticks = [...perEvent.flat(), ...tail].filter(isTick);
        seen.history += ticks.filter((tick) => tick.origin === 'history_recovery').length;
        seen.batches += perEvent.filter((emitted) => emitted.filter(isTick).length > 1).length;
        seen.tail += tail.length;
        seen.unused +=
          state.unused_ticks.duplicate_exact > 0 && state.unused_ticks.source_time_conflict > 0
            ? 1
            : 0;
        for (const event of events) {
          if (event.kind === 'history_recovery_result') {
            seen[event.status === 'complete' ? 'recovered' : 'unrecovered'] += 1;
          }
        }
      }
      // El corpus recorre lo que prueba: historias de los dos tipos, ticks de la historia dados,
      // retenidos dados juntos, el fin del log con la continuidad pendiente y duplicados y conflictos.
      expect(
        Object.values(seen).every((count) => count > 0),
        JSON.stringify(seen),
      ).toBe(true);
    },
  );
});

describe('la memoria de la vista (ADR-0024 §2)', () => {
  it('el estado no crece con el log', () => {
    const sizes = [1, 7].map((hours) => {
      const log = new Log();
      let second = 0;
      for (let hour = 0; hour < hours; hour += 1) {
        const conn = connection(hour);
        log.opened(conn, hour === 0 ? null : connection(hour - 1), at(second, 600));
        for (let index = 0; index < 600; index += 1) {
          second += 2;
          log.tick(conn, second, index % 2 === 0 ? '100.100' : '100.102');
        }
        log.closed(conn, at(second, 500));
      }
      const view = new DataView(v3);
      log.events.forEach((event, index) => view.apply(event, placeOf(index)));
      return JSON.stringify(view.state()).length;
    });
    const [hour, sevenHours] = sizes as [number, number];
    expect(sevenHours).toBeLessThanOrEqual(hour * 1.1);
  });
});

/** Generador con semilla (mulberry32), sin `Math.random`. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Un log aleatorio del dominio de ADR-0017 §3 con las reglas 3.0.0: ticks en orden, repetidos, en
 * conflicto y fuera de orden, también dentro del hueco; cierres pedidos y no pedidos; y, con el fin
 * del hueco conocido, páginas `history` del último intento con ticks del hueco, algunos iguales o en
 * conflicto con los del flujo, y su resultado `complete`, `partial` o `unavailable`.
 */
function randomHistoryLog(seed: number, profile: PipelineProfile): SourceEvent[] {
  const random = seededRandom(seed);
  const choose = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new TypeError('Nada que elegir.');
    }
    return item;
  };
  const quotes = ['100.124', '100.125', '100.126'];
  const log = new Log();
  let index = 0;
  let conn = connection(index);
  let connected = true;
  let clock = 1000;
  let watermark = 0;
  log.opened(conn, null, at(0)).tick(conn, 0, '100.125');
  const length = 10 + Math.floor(random() * 30);
  while (log.events.length < length) {
    clock += 200 + Math.floor(random() * 3000);
    if (!connected) {
      index += 1;
      const next = connection(index);
      log.opened(next, conn, at(0, clock));
      conn = next;
      connected = true;
      continue;
    }
    const [gap] = deriveMarketData([log.events], profile).pendingGaps;
    const roll = random();
    if (roll < 0.55) {
      const instants = [watermark + 1 + Math.floor(random() * 4), watermark, watermark - 1];
      if (gap !== undefined) {
        const from = (Date.parse(gap.from_event_time_utc) - 1) / 1000 - T0;
        instants.push(from + 1, from + 2);
      }
      const second = choose(instants);
      clock = Math.max(clock, (second + 0.05) * 1000);
      watermark = Math.max(watermark, second);
      log.tick(conn, second, choose(quotes), clock - second * 1000);
    } else if (roll < 0.75) {
      log.closed(conn, at(0, clock), random() < 0.3);
      connected = false;
    } else if (gap !== undefined && gap.to_event_time_utc !== null) {
      const from = (Date.parse(gap.from_event_time_utc) - 1) / 1000 - T0;
      const to = (Date.parse(gap.to_event_time_utc) + 1) / 1000 - T0;
      const status = choose(['complete', 'complete', 'partial', 'unavailable'] as const);
      if (status === 'complete') {
        const ticks: (readonly [number, string])[] = [];
        for (let second = from + 1; second < to; second += 1) {
          if (random() < 0.6) {
            ticks.push([second, choose(quotes)]);
          }
        }
        // El último intento: la primera página termina en E y la segunda, si la hay, en `middle`.
        // Las dos pueden traer el tick de `middle`, que entonces sale repetido.
        const middle = from + Math.floor(random() * (to - from + 1));
        const upper = ticks.filter(([second]) => second >= middle);
        const lower = random() < 0.6 ? ticks.filter(([second]) => second <= middle) : [];
        log.page(conn, middle, to, upper, at(0, clock));
        if (lower.length > 0) {
          log.page(conn, from, middle, lower, at(0, clock + 10));
        }
        const times = new Set([...upper, ...lower].map(([second]) => second));
        log.result(
          conn,
          { from, to },
          { recovered_event_count: times.size, status: 'complete' },
          at(0, clock + 20),
        );
      } else {
        log.result(
          conn,
          { from, to },
          status === 'partial'
            ? { reason: 'history_page_limit', recovered_event_count: 0, status }
            : { reason: 'history_timeout', status },
          at(0, clock + 20),
        );
      }
    }
  }
  return log.events.map((event) => sourceEventSchema.parse(event));
}
