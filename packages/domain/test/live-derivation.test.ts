import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalJson,
  LIVE_STATE_VERSION,
  liveDerivationCheckpointSchema,
  sha256Hex,
  sourceEventSchema,
  type DataQualityIncident,
  type OperationalConditionEvent,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLiveDerivationCheckpoint,
  createPipelineProfile,
  deriveMarketData,
  emptyLiveDerivationState,
  foldLiveDerivation,
  ingestSyntheticStimuli,
  liveCheckpointDigests,
  liveCheckpointVersions,
  liveDerivationView,
  ndjsonBytes,
  type LiveDerivationView,
  type PipelineProfile,
} from '../src/index.js';

// Derivación en pliegue del estado vivo (ADR-0017 §2 a §4, §6 y §9). En cada límite entre eventos,
// que incluye cada límite de segmento, el pliegue desde el estado de ese límite más el resto del log
// da la misma vista que `deriveMarketData` sobre el log entero, fallos incluidos: en el vector v1, en
// un corpus escrito a mano y en logs aleatorios con semilla. Un vector fija el punto de control de
// cada límite de segmento.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const sourceSchema = readFileSync(resolve(vectorRoot, 'source-schema.json'));

/**
 * SHA-256 de las líneas de cada log del vector de puntos de control, por versión del formato del
 * estado vivo (ADR-0017 §6). Un cambio de lo que el pliegue produce sube `LIVE_STATE_VERSION` y
 * añade los digests de la versión nueva; los de una versión anterior no cambian. Un log nuevo del
 * corpus solo añade su digest. Para regenerar el vector:
 * `pnpm --filter @buoh/domain exec vitest run test/live-derivation.test.ts -u`.
 */
const VECTOR_SHA256_BY_VERSION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1.0.0': {
    v1: 'a0c86447e7b3c89102b05f113b700a5eeb22b75af4e50e1b39ff25213c693153',
    'v1/zero-valid-ticks': 'd197bea6b1a562ff908a1184e0d62ceb666dd5c0a51d1d3c05582a590a6fd21e',
    'reconexión con hueco pendiente':
      'ad4e08483709f483e12116d60bc24805c2ff814f55a3da6b1c4f662ea8dfb521',
    'la separación demuestra la continuidad':
      '5f5d39537a6337b3b4701029507ec21752fe2b5c0a80d8e523fd72ab838b227b',
    'historia completa que cubre el hueco':
      '22157ed7ed1b3d87b4a44b2fd88aa2002e9766582363a087703b486807046717',
    'historia parcial y después completa del mismo rango':
      'f42ac9753f8f9348289b4d81ba21a6bbbb1a9e24007613807effc5ff8bcab9f0',
    'historia no disponible con el hueco abierto':
      '539fdce8dba0cfd701a7b8ee0785a11ba386a307469692e030362517d7b40c86',
    'la separación supera el umbral y la historia no está disponible':
      'b4ca5f54983aa41cc295b36cb986cba9d1cd2c6de676220e0ac52ddd4796dc44',
    'cierre pedido con el hueco pendiente y su fin ya conocido':
      'c9b9640c30623e47f441b291ce6fec314b27a913860fe4b1f42ef09fdb8bbd61',
    'cierre reparado al arrancar (close_not_recorded) e historia completa':
      '1e798d72c35eee4661a5d4fba729640865f574aead957dbb8818e667b22304df',
    'dos cierres seguidos conservan el inicio del hueco':
      'fea9350d26ae232ba7b36768ee0f5bc6fa3d04fe1aa14ce9064313c3e01ba3a6',
    'duplicados, conflictos y ticks fuera de orden en los extremos del hueco':
      'b0145a7e62c36e4c13221fbe5e073b2202f44aa536024948d0229ca4058fcfdb',
    'cierre pedido, cierre sin ticks, ping y símbolo no permitido':
      '036e4b1351f20bdf21798f4797b027e2faa5188b97bc43e13f296d4018240488',
  },
};

/**
 * Guardas de determinismo, como en los vectores del pipeline: el pliegue no puede leer reloj real,
 * aleatoriedad ni red.
 */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en el pliegue.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en el pliegue.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en el pliegue.');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function profileFrom(quality: Record<string, unknown>, connector = 'fixture-v1'): PipelineProfile {
  return createPipelineProfile({
    connector_version: connector,
    quality_profile_bytes: Buffer.from(JSON.stringify(quality)),
    source_schema_bytes: sourceSchema,
    source_schema_release: 'synthetic-v1',
  });
}

const baseProfile = {
  allowed_symbols: ['SYNTH_100'],
  gap_detection: 'after_reconnection',
  non_tick_msg_types: ['ping'],
  quality_rule_version: '2.0.0',
  source: 'synthetic',
};
const publication = profileFrom({
  ...baseProfile,
  maximum_delivery_delay_ms: 2000,
  maximum_event_gap_ms: 2000,
  profile_id: 'synthetic-v2-publication',
});
const measurement = profileFrom({
  ...baseProfile,
  profile_id: 'synthetic-v2-measurement',
  purpose: 'measurement',
});

const A = '019b76da-a800-7000-8000-00000000a000';
const B = '019b76da-a800-7000-8000-00000000b000';
const C = '019b76da-a800-7000-8000-00000000c000';
/** 2026-01-01T00:00:00.000Z en segundos, como las horas de la fuente. */
const T0 = 1767225600;

function id(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function at(seconds: number, milliseconds = 0): string {
  return new Date(seconds * 1000 + milliseconds).toISOString();
}

function frame(sequence: number, connection: string, payload: string, receivedAt: string) {
  return {
    connection_id: connection,
    fixture_sequence: sequence,
    kind: 'source_frame',
    observation_id: id(sequence),
    payload_utf8: payload,
    received_at_utc: receivedAt,
  };
}

/** Tick recibido `delayMs` después de su hora de fuente, con la cotización y el símbolo dados. */
function tick(
  sequence: number,
  connection: string,
  epoch: number,
  options: { delayMs?: number; quote?: string; symbol?: string } = {},
) {
  const { delayMs = 100, quote = '100.125', symbol = 'SYNTH_100' } = options;
  return frame(
    sequence,
    connection,
    `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":${quote},"symbol":"${symbol}"}}`,
    at(epoch, delayMs),
  );
}

function ping(sequence: number, connection: string, receivedAt: string) {
  return frame(sequence, connection, '{"msg_type":"ping","ping":"pong"}', receivedAt);
}

/** Tipo y motivo de cada cierre: pedido, por timeout o reparado al arrancar (ADR-0015 §3). */
const CLOSURES = {
  repaired: ['transport_error', 'close_not_recorded'],
  requested: ['requested', 'operator_shutdown'],
  timeout: ['timeout', 'ping_timeout'],
} as const;

function close(
  sequence: number,
  connection: string,
  occurredAt: string,
  closure: keyof typeof CLOSURES = 'timeout',
) {
  const [closureType, reason] = CLOSURES[closure];
  return {
    affected_symbols: ['SYNTH_100'],
    closure_type: closureType,
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_closed',
    occurred_at_utc: occurredAt,
    reason,
  };
}

function open(sequence: number, connection: string, supersedes: string | null, occurredAt: string) {
  return {
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_opened',
    occurred_at_utc: occurredAt,
    supersedes_connection_id: supersedes,
  };
}

function recovery(
  sequence: number,
  range: { readonly from: string; readonly to: string },
  result:
    | { readonly recovered_event_count: number; readonly status: 'complete' }
    | {
        readonly reason: string;
        readonly recovered_event_count: number;
        readonly status: 'partial';
      }
    | { readonly reason: string; readonly status: 'unavailable' },
  occurredAt = at(T0 + 60),
  connection = B,
) {
  return {
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    from_event_time_utc: range.from,
    kind: 'history_recovery_result',
    occurred_at_utc: occurredAt,
    symbol: 'SYNTH_100',
    to_event_time_utc: range.to,
    ...result,
  };
}

function eventsOf(stimuli: readonly unknown[], profile: PipelineProfile): SourceEvent[] {
  const result = ingestSyntheticStimuli([...stimuli], profile);
  if (result.status !== 'persisted') {
    throw new TypeError('Se esperaba persistencia completa.');
  }
  return result.segments.flat().map((event) => sourceEventSchema.parse(event));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * La vista viva calculada como hoy: con `deriveMarketData` sobre el log entero y recorriendo sus
 * eventos, como hacen `checkLog`, `gapState`, `previousConnection`, `lastConnectionEventTime` y
 * `deriveHealthReport`.
 */
function referenceView(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
): LiveDerivationView {
  const derived = deriveMarketData([events], profile);
  const quoteAt = (symbol: string, instant: string) =>
    derived.ticks.find((item) => item.symbol === symbol && item.event_time_utc === instant)
      ?.quote_decimal ?? null;
  const shift = (instant: string, ms: number) => new Date(Date.parse(instant) + ms).toISOString();

  const latest = new Map<string, OperationalConditionEvent>();
  for (const condition of derived.conditions) {
    latest.set(condition.condition_key, condition);
  }
  const incidents = new Map<string, DataQualityIncident>(
    derived.incidents.map((incident) => [incident.incident_id, incident]),
  );
  const openConditions = [...latest.values()]
    .filter((condition) => condition.action === 'opened')
    .sort((left, right) => compareStrings(left.condition_key, right.condition_key))
    .map((condition) => {
      const incident = condition.cause_refs
        .map((reference) => incidents.get(reference))
        .find((item) => item?.incident_type === condition.condition_type);
      if (incident === undefined) {
        throw new TypeError('Apertura sin incidencia causal.');
      }
      return { condition, incident };
    });

  // Como `previousConnection` del worker: la última apertura y su cierre, si lo hubo.
  let previousId: string | null = null;
  let previousClosedAt: string | null = null;
  let lastConnectionEvent: string | null = null;
  let connected = false;
  let lastRaw: { observation_id: string; received_at_utc: string } | null = null;
  for (const event of events) {
    if (event.kind === 'connection_opened') {
      previousId = event.connection_id;
      previousClosedAt = null;
      lastConnectionEvent = event.occurred_at_utc;
      connected = true;
    } else if (event.kind === 'connection_closed') {
      if (event.connection_id === previousId) {
        previousClosedAt = event.occurred_at_utc;
      }
      lastConnectionEvent = event.occurred_at_utc;
      connected = false;
    } else if (event.kind === 'raw_source_frame') {
      lastRaw = { observation_id: event.observation_id, received_at_utc: event.received_at_utc };
      connected = true;
    }
  }

  const symbols = [...new Set(derived.ticks.map((item) => item.symbol))].sort();
  return {
    connectedInLog: connected,
    gapQuotes: derived.pendingGaps.map((gap) => ({
      end_quote:
        gap.to_event_time_utc === null
          ? null
          : quoteAt(gap.symbol, shift(gap.to_event_time_utc, 1)),
      start_quote: quoteAt(gap.symbol, shift(gap.from_event_time_utc, -1)),
      symbol: gap.symbol,
    })),
    lastConnectionEventTimeUtc: lastConnectionEvent,
    lastEventConnectionId: events.at(-1)?.connection_id ?? null,
    lastEventTimeUtc: derived.ticks.at(-1)?.event_time_utc ?? null,
    lastRaw,
    openConditions,
    openConditionTypes: derived.openConditionTypes,
    pendingContinuitySymbols: derived.pendingContinuitySymbols,
    pendingGaps: derived.pendingGaps,
    previousConnection:
      previousId === null ? null : { closed_at_utc: previousClosedAt, connection_id: previousId },
    symbolNotAllowedSeen: derived.incidents.some(
      (incident) =>
        incident.incident_type === 'invalid_source_frame' &&
        incident.evidence.reason === 'symbol_not_allowed',
    ),
    // Los ticks van en orden canónico, por tiempo de evento primero.
    watermarks: symbols.map((symbol) => {
      const last = derived.ticks.filter((item) => item.symbol === symbol).at(-1);
      if (last === undefined) {
        throw new TypeError(`Símbolo sin ticks: ${symbol}.`);
      }
      return { event_time_utc: last.event_time_utc, symbol };
    }),
  };
}

/** El estado vivo pasa por su contrato y por JSON, como al guardarse y leerse. */
function roundTrip(state: ReturnType<typeof emptyLiveDerivationState>, profile: PipelineProfile) {
  const checkpoint = buildLiveDerivationCheckpoint({
    event_count: 1,
    profile,
    raw_frame_count: 0,
    segment_index: 0,
    segment_logical_content_sha256: 'a'.repeat(64),
    state,
    symbol: 'SYNTH_100',
  });
  return liveDerivationCheckpointSchema.parse(JSON.parse(JSON.stringify(checkpoint))).state;
}

/** En cada límite *i*: el pliegue de todo, y el del estado de *i* más el resto, dan la referencia. */
function expectEquivalentAtEveryBoundary(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
  label = 'log',
) {
  const expected = referenceView(events, profile);
  const whole = foldLiveDerivation(emptyLiveDerivationState(), events, profile);
  expect(liveDerivationView(whole), label).toEqual(expected);
  for (let boundary = 0; boundary <= events.length; boundary += 1) {
    const prefix = foldLiveDerivation(
      emptyLiveDerivationState(),
      events.slice(0, boundary),
      profile,
    );
    expect(liveDerivationView(prefix), `${label}, prefijo ${String(boundary)}`).toEqual(
      referenceView(events.slice(0, boundary), profile),
    );
    const resumed = foldLiveDerivation(roundTrip(prefix, profile), events.slice(boundary), profile);
    expect(resumed, `${label}, límite ${String(boundary)}`).toEqual(whole);
  }
}

/** Generador con semilla (mulberry32), sin `Math.random`: los logs aleatorios son siempre los mismos. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function connectionId(index: number): string {
  return `019b76da-a800-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`;
}

/**
 * Un log aleatorio del dominio de ADR-0017 §3, escrito como lo haría la sesión: cada conexión se
 * cierra una vez y la siguiente la supera, y cada historia cubre exactamente el hueco pendiente, ya
 * con su fin, o resuelve un hueco abierto. Mezcla ticks en orden, repetidos, en conflicto, fuera de
 * orden y en los instantes de los extremos del hueco, pings, símbolos no permitidos, cierres pedidos,
 * por timeout y reparados, e historias `complete`, `partial` y `unavailable`.
 */
function randomStimuli(seed: number, profile: PipelineProfile): unknown[] {
  const random = seededRandom(seed);
  const choose = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new TypeError('Nada que elegir.');
    }
    return item;
  };
  const length = 6 + Math.floor(random() * 24);
  let connectionIndex = 0;
  let connection = connectionId(connectionIndex);
  let connected = true;
  let clock = T0 * 1000 + 100;
  let watermark = T0;
  /** Ticks del símbolo en la conexión actual: sin ellos, la sesión puede cerrar sin símbolos. */
  let ticksOnConnection = 1;
  const stimuli: unknown[] = [tick(1, connection, T0)];
  /** Huecos abiertos por un `partial` o `unavailable`, que solo puede resolver un `complete`. */
  const openGaps: { from: string; to: string }[] = [];
  const tickAt = (epoch: number, options: { quote?: string; symbol?: string }) =>
    tick(stimuli.length + 1, connection, epoch, { ...options, delayMs: clock - epoch * 1000 });

  while (stimuli.length < length) {
    clock += 50 + Math.floor(random() * 1500);
    const sequence = stimuli.length + 1;
    const now = new Date(clock).toISOString();
    if (!connected) {
      connectionIndex += 1;
      const next = connectionId(connectionIndex);
      stimuli.push(open(sequence, next, connection, now));
      connection = next;
      connected = true;
      ticksOnConnection = 0;
      continue;
    }
    const [gap] = deriveMarketData([eventsOf(stimuli, profile)], profile).pendingGaps;
    const roll = random();
    if (roll < 0.5) {
      const instants = [watermark + 1 + Math.floor(random() * 3), watermark, watermark - 1];
      if (gap !== undefined) {
        instants.push((Date.parse(gap.from_event_time_utc) - 1) / 1000);
        if (gap.to_event_time_utc !== null) {
          instants.push((Date.parse(gap.to_event_time_utc) + 1) / 1000);
        }
      }
      const epoch = choose(instants);
      clock = Math.max(clock, epoch * 1000 + 50);
      watermark = Math.max(watermark, epoch);
      ticksOnConnection += 1;
      stimuli.push(tickAt(epoch, { quote: choose(['100.124', '100.125', '100.126']) }));
    } else if (roll < 0.56) {
      stimuli.push(ping(sequence, connection, now));
    } else if (roll < 0.6) {
      stimuli.push(tickAt(watermark + 1, { symbol: 'SYNTH_050' }));
    } else if (roll < 0.78) {
      const closed = close(sequence, connection, now, choose(['repaired', 'requested', 'timeout']));
      // Una conexión que no llegó a suscribirse se cierra sin símbolos afectados.
      stimuli.push(
        ticksOnConnection === 0 && random() < 0.5 ? { ...closed, affected_symbols: [] } : closed,
      );
      connected = false;
    } else if (gap !== undefined && gap.to_event_time_utc !== null) {
      const range = { from: gap.from_event_time_utc, to: gap.to_event_time_utc };
      const status = choose(['complete', 'partial', 'unavailable'] as const);
      if (status !== 'complete') {
        openGaps.push(range);
      }
      const result =
        status === 'complete'
          ? { recovered_event_count: 0, status }
          : status === 'partial'
            ? { reason: 'history_page_limit', recovered_event_count: 0, status }
            : { reason: 'history_timeout', status };
      stimuli.push(recovery(sequence, range, result, now, connection));
    } else if (openGaps.length > 0) {
      const range = choose(openGaps);
      openGaps.splice(openGaps.indexOf(range), 1);
      stimuli.push(
        recovery(
          sequence,
          range,
          { recovered_event_count: 0, status: 'complete' },
          now,
          connection,
        ),
      );
    }
  }
  return stimuli;
}

/** Los segmentos persistidos de cada escenario del vector v1, en orden. */
const VECTOR_SCENARIOS = [
  ['v1', ['expected-source-events-000000.ndjson', 'expected-source-events-000001.ndjson']],
  ['v1/zero-valid-ticks', ['zero-valid-ticks/expected-source-events.ndjson']],
] as const;

function vectorSegments(files: readonly string[]): SourceEvent[][] {
  return files.map((name) =>
    readFileSync(resolve(vectorRoot, name), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => sourceEventSchema.parse(JSON.parse(line))),
  );
}

function vectorProfile(): PipelineProfile {
  const manifest = JSON.parse(readFileSync(resolve(vectorRoot, 'manifest.json'), 'utf8')) as {
    profile: { connector_version: string; source_schema_release: string };
  };
  return createPipelineProfile({
    connector_version: manifest.profile.connector_version,
    quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
    source_schema_bytes: sourceSchema,
    source_schema_release: manifest.profile.source_schema_release,
  });
}

/** Cierre no pedido de A, apertura de B que lo supera y primer tick de B un segundo después. */
const RECONNECTION = [
  tick(1, A, T0),
  close(2, A, at(T0, 500)),
  open(3, B, A, at(T0, 600)),
  tick(4, B, T0 + 1),
];
const GAP = { from: at(T0, 1), to: at(T0, 999) };

const corpus: readonly (readonly [string, readonly unknown[], PipelineProfile])[] = [
  ['reconexión con hueco pendiente', RECONNECTION, measurement],
  ['la separación demuestra la continuidad', RECONNECTION, publication],
  [
    'historia completa que cubre el hueco',
    [...RECONNECTION, recovery(5, GAP, { recovered_event_count: 0, status: 'complete' })],
    measurement,
  ],
  [
    'historia parcial y después completa del mismo rango',
    [
      ...RECONNECTION,
      recovery(5, GAP, {
        reason: 'history_page_limit',
        recovered_event_count: 0,
        status: 'partial',
      }),
      tick(6, B, T0 + 3),
      recovery(7, GAP, { recovered_event_count: 0, status: 'complete' }, at(T0 + 61)),
    ],
    measurement,
  ],
  [
    'historia no disponible con el hueco abierto',
    [
      ...RECONNECTION,
      tick(5, B, T0 + 2),
      recovery(6, GAP, { reason: 'history_timeout', status: 'unavailable' }),
    ],
    measurement,
  ],
  [
    'la separación supera el umbral y la historia no está disponible',
    [
      tick(1, A, T0),
      close(2, A, at(T0, 500)),
      open(3, B, A, at(T0, 600)),
      tick(4, B, T0 + 5),
      recovery(
        5,
        { from: at(T0, 1), to: at(T0 + 4, 999) },
        { reason: 'history_timeout', status: 'unavailable' },
      ),
    ],
    publication,
  ],
  [
    'cierre pedido con el hueco pendiente y su fin ya conocido',
    [
      ...RECONNECTION,
      close(5, B, at(T0 + 1, 500), 'requested'),
      open(6, C, B, at(T0 + 2)),
      tick(7, C, T0 + 3),
      recovery(8, GAP, { reason: 'history_timeout', status: 'unavailable' }),
    ],
    measurement,
  ],
  [
    'cierre reparado al arrancar (close_not_recorded) e historia completa',
    [
      tick(1, A, T0),
      tick(2, A, T0 + 1),
      close(3, A, at(T0 + 30), 'repaired'),
      open(4, B, A, at(T0 + 30, 100)),
      tick(5, B, T0 + 31),
      recovery(
        6,
        { from: at(T0 + 1, 1), to: at(T0 + 30, 999) },
        { recovered_event_count: 0, status: 'complete' },
      ),
    ],
    measurement,
  ],
  [
    'dos cierres seguidos conservan el inicio del hueco',
    [
      ...RECONNECTION,
      close(5, B, at(T0 + 1, 500)),
      open(6, C, B, at(T0 + 1, 600)),
      tick(7, C, T0 + 5),
      recovery(
        8,
        { from: at(T0, 1), to: at(T0 + 4, 999) },
        {
          reason: 'history_page_limit',
          recovered_event_count: 0,
          status: 'partial',
        },
      ),
    ],
    measurement,
  ],
  [
    'duplicados, conflictos y ticks fuera de orden en los extremos del hueco',
    [
      tick(1, A, T0),
      tick(2, A, T0, { quote: '100.124' }),
      close(3, A, at(T0, 500)),
      open(4, B, A, at(T0, 600)),
      tick(5, B, T0, { delayMs: 900 }),
      tick(6, B, T0, { delayMs: 950, quote: '100.126' }),
      tick(7, B, T0 + 2),
      tick(8, B, T0 + 2, { delayMs: 300, quote: '100.127' }),
      tick(9, B, T0 - 1, { delayMs: 3000 }),
      tick(10, B, T0 + 3),
      recovery(
        11,
        { from: at(T0, 1), to: at(T0 + 1, 999) },
        {
          reason: 'history_boundary_mismatch',
          recovered_event_count: 0,
          status: 'partial',
        },
      ),
    ],
    measurement,
  ],
  [
    'cierre pedido, cierre sin ticks, ping y símbolo no permitido',
    [
      close(1, A, at(T0, 100)),
      open(2, B, A, at(T0, 200)),
      ping(3, B, at(T0, 300)),
      tick(4, B, T0 + 1, { symbol: 'SYNTH_050' }),
      tick(5, B, T0 + 2),
      close(6, B, at(T0 + 2, 500), 'requested'),
      open(7, C, B, at(T0 + 3)),
      tick(8, C, T0 + 4),
    ],
    measurement,
  ],
];

/**
 * Un log sintético en segmentos que cierran después de cada evento de conexión o de historia, para
 * que el vector tenga un límite en cada transición del estado vivo.
 */
function segmentsAtTransitions(events: readonly SourceEvent[]): SourceEvent[][] {
  const segments: SourceEvent[][] = [];
  let current: SourceEvent[] = [];
  for (const event of events) {
    current.push(event);
    if (event.kind !== 'raw_source_frame') {
      segments.push(current);
      current = [];
    }
  }
  return current.length === 0 ? segments : [...segments, current];
}

/**
 * Las líneas del vector de un log: en cada límite de segmento, el punto de control que `ingest`
 * escribe desde el anterior y los eventos del segmento (ADR-0017 §5), en JCS con sus SHA-256.
 */
function vectorLines(
  log: string,
  segments: readonly (readonly SourceEvent[])[],
  profile: PipelineProfile,
): string[] {
  let state = emptyLiveDerivationState();
  let eventCount = 0;
  let rawFrameCount = 0;
  return segments.map((segment, index) => {
    eventCount += segment.length;
    rawFrameCount += segment.filter((event) => event.kind === 'raw_source_frame').length;
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: eventCount,
      profile,
      raw_frame_count: rawFrameCount,
      segment_index: index,
      segment_logical_content_sha256: sha256Hex(ndjsonBytes(segment)),
      state: foldLiveDerivation(state, segment, profile),
      symbol: 'SYNTH_100',
    });
    state = checkpoint.state;
    return canonicalJson({ checkpoint, log, ...liveCheckpointDigests(checkpoint) });
  });
}

describe('derivación en pliegue del estado vivo (ADR-0017)', () => {
  it.each(corpus)('%s: igual en cada límite', (_name, stimuli, profile) => {
    expectEquivalentAtEveryBoundary(eventsOf(stimuli, profile), profile);
  });

  it.each(VECTOR_SCENARIOS)('el vector %s: igual en cada límite', (_name, files) => {
    expectEquivalentAtEveryBoundary(vectorSegments(files).flat(), vectorProfile());
  });

  it(
    '300 logs aleatorios del dominio de §3, con los dos perfiles: igual en cada límite',
    {
      timeout: 60_000,
    },
    () => {
      // Semillas distintas por perfil, para que los 300 logs sean distintos.
      const profiles = [
        ['medición', measurement, 0],
        ['publicación', publication, 1000],
      ] as const;
      for (const [name, profile, first] of profiles) {
        for (let seed = first + 1; seed <= first + 150; seed += 1) {
          expectEquivalentAtEveryBoundary(
            eventsOf(randomStimuli(seed, profile), profile),
            profile,
            `semilla ${String(seed)} (${name})`,
          );
        }
      }
    },
  );

  it('el vector fija el punto de control de cada límite de segmento (§6)', async () => {
    const logs: (readonly [string, string[]])[] = VECTOR_SCENARIOS.map(([name, files]) => {
      const segments = vectorSegments(files);
      // El enlace usa el `logical_content_sha256` de cada segmento persistido.
      segments.forEach((segment, index) => {
        expect(sha256Hex(ndjsonBytes(segment))).toBe(
          sha256Hex(readFileSync(resolve(vectorRoot, files[index] ?? ''))),
        );
      });
      return [name, vectorLines(name, segments, vectorProfile())] as const;
    });
    for (const [name, stimuli, profile] of corpus) {
      logs.push([
        name,
        vectorLines(name, segmentsAtTransitions(eventsOf(stimuli, profile)), profile),
      ]);
    }
    const content = `${logs.flatMap(([, lines]) => lines).join('\n')}\n`;

    await expect(content).toMatchFileSnapshot('./fixtures/live-checkpoints.ndjson');
    expect(
      Object.fromEntries(logs.map(([name, lines]) => [name, sha256Hex(`${lines.join('\n')}\n`)])),
      `Un log del vector cambió sin subir LIVE_STATE_VERSION (${LIVE_STATE_VERSION}), o le falta su digest.`,
    ).toEqual(VECTOR_SHA256_BY_VERSION[LIVE_STATE_VERSION]);
  });

  it('con apertura y resolución en el mismo instante, falla donde falla la completa', () => {
    const throws = (run: () => unknown) => {
      try {
        run();
        return false;
      } catch {
        return true;
      }
    };
    const outcomes = {
      connection_lost: new Set<boolean>(),
      event_gap_unresolved: new Set<boolean>(),
    };
    // Cada variante cambia el ID del evento que resuelve, y con él el `condition_event_id` que
    // decide el empate (ADR-0017 §3).
    for (let variant = 0; variant < 16; variant += 1) {
      const cases = [
        [
          'connection_lost',
          [
            tick(1, A, T0),
            close(2, A, at(T0, 500)),
            { ...open(3, B, A, at(T0, 500)), event_id: id(100 + variant) },
            tick(4, B, T0 + 1),
          ],
        ],
        [
          'event_gap_unresolved',
          [
            ...RECONNECTION,
            recovery(5, GAP, {
              reason: 'history_page_limit',
              recovered_event_count: 0,
              status: 'partial',
            }),
            {
              ...recovery(6, GAP, { recovered_event_count: 0, status: 'complete' }),
              event_id: id(200 + variant),
            },
          ],
        ],
      ] as const;
      for (const [type, stimuli] of cases) {
        const events = eventsOf(stimuli, measurement);
        const full = throws(() => deriveMarketData([events], measurement));
        expect(
          throws(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)),
          `${type}, variante ${String(variant)}`,
        ).toBe(full);
        outcomes[type].add(full);
      }
    }
    // Las variantes recorren los dos órdenes del empate.
    expect([...outcomes.connection_lost].sort()).toEqual([false, true]);
    expect([...outcomes.event_gap_unresolved].sort()).toEqual([false, true]);
  });

  it('falla donde falla la derivación completa', () => {
    const closedTwice = eventsOf(
      [tick(1, A, T0), close(2, A, at(T0, 500)), close(3, A, at(T0, 600))],
      measurement,
    );
    const resolvedBeforeOpening = eventsOf(
      [tick(1, A, T0), close(2, A, at(T0, 500)), open(3, B, A, at(T0, 400))],
      measurement,
    );
    for (const events of [closedTwice, resolvedBeforeOpening]) {
      expect(() => deriveMarketData([events], measurement)).toThrow();
      expect(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)).toThrow();
      const prefix = foldLiveDerivation(
        emptyLiveDerivationState(),
        events.slice(0, 2),
        measurement,
      );
      expect(() => foldLiveDerivation(prefix, events.slice(2), measurement)).toThrow();
    }
  });

  it('rechaza un resultado partial o unavailable sin fin de hueco o con otro rango (§3)', () => {
    const withoutEnd = eventsOf(
      [
        tick(1, A, T0),
        close(2, A, at(T0, 500)),
        open(3, B, A, at(T0, 600)),
        recovery(4, GAP, { reason: 'history_timeout', status: 'unavailable' }),
      ],
      measurement,
    );
    const otherRanges = [
      { from: GAP.from, to: at(T0, 500) },
      { from: at(T0, 2), to: GAP.to },
    ].map((range) =>
      eventsOf(
        [
          ...RECONNECTION,
          recovery(5, range, {
            reason: 'history_page_limit',
            recovered_event_count: 0,
            status: 'partial',
          }),
        ],
        measurement,
      ),
    );
    for (const events of [withoutEnd, ...otherRanges]) {
      expect(() => deriveMarketData([events], measurement)).not.toThrow();
      expect(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)).toThrow(
        /hueco pendiente/u,
      );
    }
  });

  it('el punto de control se identifica por su contenido y sus versiones', () => {
    const events = eventsOf(RECONNECTION, measurement);
    const state = foldLiveDerivation(emptyLiveDerivationState(), events, measurement);
    const input = {
      event_count: events.length,
      profile: measurement,
      raw_frame_count: 2,
      segment_index: 3,
      segment_logical_content_sha256: 'b'.repeat(64),
      state,
      symbol: 'SYNTH_100',
    };
    const checkpoint = buildLiveDerivationCheckpoint(input);
    expect(liveDerivationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(checkpoint.versions).toEqual(liveCheckpointVersions(measurement));
    expect(liveCheckpointDigests(buildLiveDerivationCheckpoint(input))).toEqual(
      liveCheckpointDigests(checkpoint),
    );

    const other = liveCheckpointDigests(
      buildLiveDerivationCheckpoint({ ...input, profile: publication }),
    );
    expect(other.versions_sha256).not.toBe(liveCheckpointDigests(checkpoint).versions_sha256);
    expect(other.checkpoint_sha256).not.toBe(liveCheckpointDigests(checkpoint).checkpoint_sha256);
  });
});
