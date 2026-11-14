import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  connectionClosedSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  liveDerivationCheckpointSchema,
  rawSourceFrameSchema,
  sha256Hex,
  validateDatasetConsistency,
  type MarketTick,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDatasetPublication,
  buildLiveDerivationCheckpoint,
  createPipelineProfile,
  deriveMarketData,
  emptyLiveDerivationState,
  foldLiveDerivation,
  liveDerivationView,
  ndjsonBytes,
  parseJsonPreservingNumbers,
  readHistoryTicks,
  RULE_SETS,
  type PipelineProfile,
} from '../src/index.js';

// Vector sintético de las reglas de calidad 3.0.0 (ADR-0020 §2, §3 y §7; contratos de dominio,
// «Semántica ejecutable de reglas 3.0.0»): los ticks que trae la historia pasan a `MarketTick`, y
// los artefactos derivados se dividen en partes de 5000 registros. Las expectativas salen de las
// reglas de la ADR, escritas a mano. Fuente `synthetic`, conector `fixture-v1` y símbolo
// `SYNTH_100`; ningún precio es de mercado.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const sourceSchema = readFileSync(resolve(vectorRoot, 'source-schema.json'));

/** 2026-01-01T00:00:00.000Z en segundos, como las horas de la fuente. */
const T0 = 1767225600;
const SYMBOL = 'SYNTH_100';

function profileFor(ruleVersion: '2.0.0' | '3.0.0', extra: Record<string, unknown> = {}) {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(
      JSON.stringify({
        allowed_symbols: [SYMBOL],
        gap_detection: 'after_reconnection',
        maximum_delivery_delay_ms: 3000,
        maximum_event_gap_ms: 2000,
        non_tick_msg_types: ['history', 'ping'],
        profile_id: `synthetic-publication-${ruleVersion}`,
        quality_rule_version: ruleVersion,
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

const connection = (letter: string) => `019b76da-a800-7000-8000-00000000${letter}000`;
const [A, B, C, D, E, F, G] = ['a', 'b', 'c', 'd', 'e', 'f', '1'].map(connection) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

function id(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

/** La hora UTC del segundo `second` desde T0, corrida `milliseconds`. */
function at(second: number, milliseconds = 0): string {
  return new Date((T0 + second) * 1000 + milliseconds).toISOString();
}

function raw(sequence: number, conn: string, payload: string, receivedAt: string): SourceEvent {
  return rawSourceFrameSchema.parse({
    connection_id: conn,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: id(sequence),
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: receivedAt,
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

/** Tick del flujo del segundo `second`, recibido 100 ms después. */
function tick(sequence: number, conn: string, second: number, quote: string): SourceEvent {
  return raw(
    sequence,
    conn,
    `{"msg_type":"tick","tick":{"epoch":${String(T0 + second)},"pip_size":3,"quote":${quote},"symbol":"${SYMBOL}"}}`,
    at(second, 100),
  );
}

/** Una página de `ticks_history`, como la manda Deriv: la petición en `echo_req`, con `end` en texto. */
function page(
  sequence: number,
  conn: string,
  input: {
    readonly end: number;
    readonly pipSize?: string;
    readonly prices: readonly string[];
    readonly receivedAt: string;
    readonly reqId: number;
    readonly start: number;
    readonly times: readonly number[];
  },
): SourceEvent {
  const times = input.times.map((second) => String(T0 + second)).join(',');
  return raw(
    sequence,
    conn,
    `{"echo_req":{"count":1000,"end":"${String(T0 + input.end)}","req_id":${String(input.reqId)},"start":${String(T0 + input.start)},"style":"ticks","ticks_history":"${SYMBOL}"},"history":{"prices":[${input.prices.join(',')}],"times":[${times}]},"msg_type":"history","pip_size":${input.pipSize ?? '3'},"req_id":${String(input.reqId)}}`,
    input.receivedAt,
  );
}

function opened(sequence: number, conn: string, supersedes: string | null, occurredAt: string) {
  return connectionOpenedSchema.parse({
    connection_id: conn,
    event_id: id(sequence),
    kind: 'connection_opened',
    occurred_at_utc: occurredAt,
    schema_version: '1.0.0',
    source: 'synthetic',
    supersedes_connection_id: supersedes,
  });
}

function closed(sequence: number, conn: string, occurredAt: string) {
  return connectionClosedSchema.parse({
    affected_symbols: [SYMBOL],
    closure_type: 'transport_error',
    connection_id: conn,
    event_id: id(sequence),
    kind: 'connection_closed',
    occurred_at_utc: occurredAt,
    reason: 'close_code_1006',
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

/** Resultado de la historia del hueco entre los segundos `from` y `to`, sin incluirlos. */
function recovered(
  sequence: number,
  conn: string,
  range: { readonly from: number; readonly to: number },
  result:
    | { readonly recovered_event_count: number; readonly status: 'complete' }
    | {
        readonly reason: string;
        readonly recovered_event_count: number;
        readonly status: 'partial';
      },
  occurredAt: string,
) {
  return historyRecoveryResultSchema.parse({
    connection_id: conn,
    event_id: id(sequence),
    from_event_time_utc: at(range.from, 1),
    kind: 'history_recovery_result',
    occurred_at_utc: occurredAt,
    schema_version: '1.0.0',
    source: 'synthetic',
    symbol: SYMBOL,
    to_event_time_utc: at(range.to, -1),
    ...result,
  });
}

// El log del vector, en cinco segmentos. Cada caso es una reconexión de §3 de la ADR.
// 1. Una página: el hueco de 4 a 10 s, con un ping en medio, que no es tick.
const CASE_ONE_BEFORE = [
  opened(1, A, null, at(-1)),
  tick(2, A, 0, '100.125'),
  tick(3, A, 2, '100.250'),
  tick(4, A, 4, '100.375'),
  closed(5, A, at(5, 300)),
];
const CASE_ONE_AFTER = [
  opened(6, B, A, at(7)),
  raw(7, B, '{"msg_type":"ping","ping":"pong"}', at(8)),
  tick(8, B, 10, '100.875'),
  page(9, B, {
    end: 10,
    prices: ['100.375', '100.5', '100.625', '100.875'],
    receivedAt: at(12, 200),
    reqId: 3,
    start: 4,
    times: [4, 6, 8, 10],
  }),
  recovered(
    10,
    B,
    { from: 4, to: 10 },
    { recovered_event_count: 2, status: 'complete' },
    at(12, 300),
  ),
];
// 2. Dos páginas y un reintento: el primer intento (req_id 5) dejó una página y su segunda página
//    (req_id 6) venció; su respuesta llega tarde, con otra cotización, cuando ya empezó el segundo
//    intento (req_id 7 y 8). Solo cuentan las páginas del último intento, y solo las de su símbolo:
//    la de otro símbolo (req_id 9) no cuenta.
const CASE_TWO = [
  tick(11, B, 12, '100.000'),
  closed(12, B, at(13, 100)),
  opened(13, C, B, at(29)),
  tick(14, C, 30, '101.000'),
  page(15, C, {
    end: 30,
    prices: ['100.375', '100.500', '100.625', '100.750', '101.000'],
    receivedAt: at(33),
    reqId: 5,
    start: 12,
    times: [22, 24, 26, 28, 30],
  }),
  page(16, C, {
    end: 30,
    prices: ['100.375', '100.500', '100.625', '100.750', '101.000'],
    receivedAt: at(65),
    reqId: 7,
    start: 12,
    times: [22, 24, 26, 28, 30],
  }),
  page(17, C, {
    end: 21,
    prices: ['100.000', '100.125', '99.999', '100.250', '100.300'],
    receivedAt: at(66),
    reqId: 6,
    start: 12,
    times: [12, 14, 16, 18, 20],
  }),
  page(18, C, {
    end: 21,
    prices: ['100.000', '100.125', '100.200', '100.250', '100.300'],
    receivedAt: at(67),
    reqId: 8,
    start: 12,
    times: [12, 14, 16, 18, 20],
  }),
  raw(
    42,
    C,
    `{"echo_req":{"count":1000,"end":"${String(T0 + 30)}","req_id":9,"start":${String(T0 + 12)},"style":"ticks","ticks_history":"SYNTH_200"},"history":{"prices":[1.5],"times":[${String(T0 + 20)}]},"msg_type":"history","pip_size":1,"req_id":9}`,
    at(67, 500),
  ),
  recovered(19, C, { from: 12, to: 30 }, { recovered_event_count: 8, status: 'complete' }, at(68)),
];
// 3. Dos cierres seguidos con ticks entre ellos. La conexión intermedia pidió la historia y se cerró
//    antes del resultado: su página (req_id 3) queda en el log y no cuenta para la de la conexión
//    siguiente, que también empieza en req_id 3. La historia del hueco entero repite el tick del flujo
//    de 36 s, que sale como duplicado, y trae otra cotización para el de 38 s, que sale en conflicto.
const CASE_THREE = [
  tick(20, C, 32, '101.250'),
  closed(21, C, at(33)),
  opened(22, D, C, at(35)),
  tick(23, D, 36, '101.500'),
  tick(24, D, 38, '101.750'),
  page(43, D, {
    end: 36,
    prices: ['101.250', '101.375', '101.500'],
    receivedAt: at(38, 500),
    reqId: 3,
    start: 32,
    times: [32, 34, 36],
  }),
  closed(25, D, at(39)),
  opened(26, E, D, at(41)),
  tick(27, E, 42, '102.000'),
  page(28, E, {
    end: 42,
    prices: ['101.250', '101.375', '101.5', '101.8', '101.875', '102.000'],
    receivedAt: at(44, 300),
    reqId: 3,
    start: 32,
    times: [32, 34, 36, 38, 40, 42],
  }),
  recovered(29, E, { from: 32, to: 42 }, { recovered_event_count: 4, status: 'complete' }, at(45)),
];
// 4. Un resultado `partial`: el hueco queda sin resolver y su página no da ticks. Cada página llega
//    después de los 2000 ms que espera la sesión antes de pedirla (ADR-0015 §4).
// 7. Una reconexión de 2000 ms: la separación demuestra la continuidad, y la historia que llega
//    después no resuelve nada.
const CASES_FOUR_AND_SEVEN = [
  tick(30, E, 46, '102.125'),
  closed(31, E, at(47)),
  opened(32, F, E, at(49)),
  tick(33, F, 52, '102.500'),
  page(34, F, {
    end: 52,
    prices: ['102.125', '102.250', '102.375', '102.999'],
    receivedAt: at(54, 300),
    reqId: 3,
    start: 46,
    times: [46, 48, 50, 52],
  }),
  recovered(
    35,
    F,
    { from: 46, to: 52 },
    { reason: 'history_boundary_mismatch', recovered_event_count: 2, status: 'partial' },
    at(54, 400),
  ),
  tick(36, F, 56, '102.625'),
  closed(37, F, at(56, 500)),
  opened(38, G, F, at(57)),
  tick(39, G, 58, '102.750'),
  page(40, G, {
    end: 58,
    prices: ['102.625', '102.750'],
    receivedAt: at(60, 300),
    reqId: 3,
    start: 56,
    times: [56, 58],
  }),
  recovered(
    41,
    G,
    { from: 56, to: 58 },
    { recovered_event_count: 0, status: 'complete' },
    at(60, 400),
  ),
];
const SEGMENTS = [CASE_ONE_BEFORE, CASE_ONE_AFTER, CASE_TWO, CASE_THREE, CASES_FOUR_AND_SEVEN];

/** Lo que importa de un tick para el vector: hora, cotización, origen, frame y marcas. */
function summary(tick: MarketTick) {
  return [
    tick.event_time_utc,
    tick.quote_decimal,
    tick.origin,
    tick.observation_id,
    tick.quality_flags,
  ] as const;
}

/**
 * Guardas de determinismo del vector, como las de los vectores v1: el pipeline no puede leer reloj
 * real, aleatoriedad ni red.
 */
function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en el pipeline.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en el pipeline.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en el pipeline.');
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conjunto de reglas 3.0.0', () => {
  it('fija normalizador 3.0.0, esquema de incidencias 2.0.0, los ticks de la historia y las partes', () => {
    expect(v3.rules).toEqual(RULE_SETS['3.0.0']);
    expect(RULE_SETS['3.0.0']).toEqual({
      classifies_msg_type: true,
      derived_part_records: 5000,
      history_ticks: true,
      incident_schema_version: '2.0.0',
      normalizer_version: '3.0.0',
      quality_rule_version: '3.0.0',
    });
    // Las reglas anteriores siguen con un artefacto por rol y sin ticks de la historia.
    for (const version of ['1.0.0', '2.0.0'] as const) {
      expect(RULE_SETS[version]).toMatchObject({
        derived_part_records: null,
        history_ticks: false,
      });
    }
  });

  it('exige declarar las respuestas que no son ticks', () => {
    expect(() =>
      createPipelineProfile({
        connector_version: 'fixture-v1',
        quality_profile_bytes: Buffer.from(
          JSON.stringify({
            allowed_symbols: [SYMBOL],
            gap_detection: 'after_reconnection',
            maximum_delivery_delay_ms: 3000,
            maximum_event_gap_ms: 2000,
            profile_id: 'sin-respuestas',
            quality_rule_version: '3.0.0',
            source: 'synthetic',
          }),
        ),
        source_schema_bytes: sourceSchema,
        source_schema_release: 'synthetic-v1',
      }),
    ).toThrow(/non_tick_msg_types es obligatorio con reglas 2\.0\.0 y 3\.0\.0/u);
  });

  it('exige que las respuestas que no son ticks incluyan history', () => {
    expect(() => profileFor('3.0.0', { non_tick_msg_types: ['ping'] })).toThrow(
      /reglas 3\.0\.0 exigen history/u,
    );
    // Las 2.0.0 no lo exigen.
    expect(profileFor('2.0.0', { non_tick_msg_types: ['ping'] }).rules).toEqual(RULE_SETS['2.0.0']);
  });

  it('un perfil de medición no puede usar las reglas 3.0.0: el de medición no cambia', () => {
    expect(() =>
      profileFor('3.0.0', {
        maximum_delivery_delay_ms: undefined,
        maximum_event_gap_ms: undefined,
        purpose: 'measurement',
      }),
    ).toThrow(/perfil de medición usa las reglas 2\.0\.0/u);
  });
});

describe('las páginas de la historia (readHistoryTicks, ADR-0015 §4)', () => {
  const T = T0;
  const range = { end: T + 10, start: T + 4 };
  const read = (payload: string, pageRange = range) =>
    readHistoryTicks(parseJsonPreservingNumbers(payload), pageRange);
  const body = (history: string, pipSize = '3') =>
    `{"history":${history},"msg_type":"history","pip_size":${pipSize}}`;

  it('da cada tiempo con su cotización canónica y el pip_size de la página', () => {
    expect(
      read(body(`{"prices":[100.5,100.625],"times":[${String(T + 6)},${String(T + 8)}]}`)),
    ).toEqual({
      pip_size: 3,
      ticks: [
        { quote: '100.500', time: T + 6 },
        { quote: '100.625', time: T + 8 },
      ],
    });
  });

  it('acepta pip_size escrito con una fracción de ceros, como lo manda la historia real', () => {
    expect(read(body(`{"prices":[100.5],"times":[${String(T + 6)}]}`, '2.0'))).toEqual({
      pip_size: 2,
      ticks: [{ quote: '100.50', time: T + 6 }],
    });
  });

  it.each([
    ['listas de distinta longitud', body(`{"prices":[100.5,1],"times":[${String(T + 6)}]}`)],
    [
      'tiempos que no crecen',
      body(`{"prices":[100.5,100.6],"times":[${String(T + 8)},${String(T + 6)}]}`),
    ],
    [
      'tiempos repetidos',
      body(`{"prices":[100.5,100.6],"times":[${String(T + 6)},${String(T + 6)}]}`),
    ],
    ['un tiempo fuera de lo pedido', body(`{"prices":[100.5],"times":[${String(T + 11)}]}`)],
    ['un tiempo que no es entero', body(`{"prices":[100.5],"times":[${String(T + 6)}.5]}`)],
    ['un precio con exponente', body(`{"prices":[1e2],"times":[${String(T + 6)}]}`)],
    [
      'un precio con más decimales que pip_size',
      body(`{"prices":[100.1234],"times":[${String(T + 6)}]}`),
    ],
    ['un precio que no es número', body(`{"prices":["100.5"],"times":[${String(T + 6)}]}`)],
    [
      'sin pip_size',
      `{"history":{"prices":[100.5],"times":[${String(T + 6)}]},"msg_type":"history"}`,
    ],
    ['un pip_size que no es entero', body(`{"prices":[100.5],"times":[${String(T + 6)}]}`, '2.5')],
    ['sin history', '{"msg_type":"history","pip_size":3}'],
    ['sin times', body('{"prices":[100.5]}')],
  ])('rechaza una página incoherente: %s', (_label, payload) => {
    expect(read(payload)).toBeNull();
  });
});

describe('vector sintético de las reglas 3.0.0 (ADR-0020 §3)', () => {
  const ids = (...sequences: number[]) => sequences.map(id);

  it('convierte en MarketTick los ticks del último intento de cada historia que resuelve su hueco', () => {
    forbidAmbientEffects();
    const derived = deriveMarketData(SEGMENTS, v3);
    const history = derived.ticks.filter((item) => item.origin === 'history_recovery');
    expect(history.map(summary)).toEqual([
      // 1. La página del hueco de 4 a 10 s, sin sus extremos.
      [at(6), '100.500', 'history_recovery', id(9), []],
      [at(8), '100.625', 'history_recovery', id(9), []],
      // 2. Las del segundo intento (req_id 7 y 8); ni la del primero ni la que llegó tarde.
      [at(14), '100.125', 'history_recovery', id(18), []],
      [at(16), '100.200', 'history_recovery', id(18), []],
      [at(18), '100.250', 'history_recovery', id(18), []],
      [at(20), '100.300', 'history_recovery', id(18), []],
      [at(22), '100.375', 'history_recovery', id(16), []],
      [at(24), '100.500', 'history_recovery', id(16), []],
      [at(26), '100.625', 'history_recovery', id(16), []],
      [at(28), '100.750', 'history_recovery', id(16), []],
      // 3. El hueco entero de 32 a 42 s: los de 36 y 38 repiten ticks del flujo.
      [at(34), '101.375', 'history_recovery', id(28), []],
      [at(36), '101.500', 'history_recovery', id(28), ['duplicate_exact']],
      [at(38), '101.800', 'history_recovery', id(28), ['source_time_conflict']],
      [at(40), '101.875', 'history_recovery', id(28), []],
    ]);
  });

  it('cada tick de la historia lleva la procedencia de su frame', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    const frame = CASE_ONE_AFTER[3];
    if (frame?.kind !== 'raw_source_frame') {
      throw new TypeError('El caso 1 tiene su página en la cuarta posición.');
    }
    const fromFrame = derived.ticks.filter((item) => item.observation_id === frame.observation_id);
    expect(fromFrame).toHaveLength(2);
    for (const item of fromFrame) {
      expect(item).toMatchObject({
        connector_version: frame.connector_version,
        origin: 'history_recovery',
        pip_size: 3,
        raw_payload_sha256: frame.raw_payload_sha256,
        received_at_utc: frame.received_at_utc,
        source: frame.source,
        symbol: SYMBOL,
      });
    }
  });

  it('los ticks de la historia no se evalúan con out_of_order ni delivery_delayed', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    const types = derived.incidents.map((incident) => incident.incident_type);
    expect(types).not.toContain('out_of_order');
    expect(types).not.toContain('delivery_delayed');
    // El tick de 6 s llegó 6,2 s tarde, por encima de los 3000 ms del perfil.
    const late = derived.ticks.find((item) => item.event_time_utc === at(6));
    expect(Date.parse(late?.received_at_utc ?? '') - Date.parse(at(6))).toBeGreaterThan(3000);
  });

  it('sus duplicados y conflictos citan el frame y el tick del flujo, cada uno con su marca', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    const duplicates = derived.incidents.filter(
      (incident) => incident.incident_type === 'duplicate_exact',
    );
    expect(duplicates.map((incident) => [incident.observed_ref, incident.related_refs])).toEqual([
      [id(28), ids(23)],
    ]);
    const conflicts = derived.incidents.filter(
      (incident) => incident.incident_type === 'source_time_conflict',
    );
    const fingerprintsAt38 = derived.ticks
      .filter((item) => item.event_time_utc === at(38))
      .map((item) => item.tick_fingerprint_sha256)
      .sort();
    expect(
      conflicts.map((incident) => [
        incident.observed_ref,
        incident.related_refs,
        incident.evidence,
      ]),
    ).toEqual([[id(28), ids(24), { event_time_utc: at(38), tick_fingerprints: fingerprintsAt38 }]]);
    // Los del flujo que se repiten no llevan marca: solo el duplicado.
    const stream = derived.ticks.filter((item) => item.origin === 'stream');
    expect(stream.filter((item) => item.quality_flags.length > 0).map(summary)).toEqual([
      [at(52), '102.500', 'stream', id(33), ['event_gap_unresolved']],
    ]);
  });

  it('un resultado partial deja el hueco sin resolver, con los extremos del flujo, y no da ticks', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    const gaps = derived.incidents.filter(
      (incident) => incident.incident_type === 'event_gap_unresolved',
    );
    expect(gaps.map((incident) => [incident.observed_ref, incident.related_refs])).toEqual([
      [id(35), ids(30, 33)],
    ]);
    expect(derived.ticks.filter((item) => item.observation_id === id(34))).toEqual([]);
    expect(derived.openConditionTypes).toEqual(['event_gap_unresolved']);
  });

  it('una reconexión de 2000 ms queda demostrada sin historia', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    expect(derived.pendingContinuitySymbols).toEqual([]);
    expect(derived.ticks.filter((item) => item.observation_id === id(40))).toEqual([]);
  });

  it('con las demás entradas da lo mismo que las reglas 2.0.0', () => {
    const after = deriveMarketData(SEGMENTS, v3);
    const before = deriveMarketData(SEGMENTS, v2);
    expect(after.ticks.filter((item) => item.origin === 'stream')).toEqual(before.ticks);
    const strip = (items: readonly object[], fields: string[]) =>
      items.map((item) =>
        Object.fromEntries(Object.entries(item).filter(([key]) => !fields.includes(key))),
      );
    const incidentFields = ['incident_id', 'quality_rule_version'];
    const fromHistory = new Set(ids(28));
    expect(
      strip(
        after.incidents.filter((incident) => !fromHistory.has(incident.observed_ref)),
        incidentFields,
      ),
    ).toEqual(strip(before.incidents, incidentFields));
    const conditionFields = ['cause_refs', 'condition_event_id'];
    expect(strip(after.conditions, conditionFields)).toEqual(
      strip(before.conditions, conditionFields),
    );
    expect(after.pendingGaps).toEqual(before.pendingGaps);
  });

  it('el pliegue del estado vivo da los mismos huecos y condiciones abiertas', () => {
    const derived = deriveMarketData(SEGMENTS, v3);
    const view = liveDerivationView(
      foldLiveDerivation(emptyLiveDerivationState(), SEGMENTS.flat(), v3),
    );
    expect(view.pendingGaps).toEqual(derived.pendingGaps);
    expect(view.openConditionTypes).toEqual(derived.openConditionTypes);
    const open = derived.conditions.filter((item) =>
      view.openConditions.some(
        ({ condition }) => condition.condition_event_id === item.condition_event_id,
      ),
    );
    expect(open.map((item) => item.condition_type)).toEqual(['event_gap_unresolved']);
  });

  it('en cada límite de segmento, el pliegue da los huecos y las condiciones de la derivación completa; en cada evento, retomado desde su punto de control, da el del log entero (ADR-0020 §12)', () => {
    const events = SEGMENTS.flat();
    const whole = liveDerivationView(foldLiveDerivation(emptyLiveDerivationState(), events, v3));
    // El vector trae ticks de la historia: los que las reglas 3.0.0 convierten en MarketTick.
    expect(
      deriveMarketData(SEGMENTS, v3).ticks.filter((item) => item.origin === 'history_recovery')
        .length,
    ).toBeGreaterThan(0);
    for (let boundary = 0; boundary <= SEGMENTS.length; boundary += 1) {
      const before = SEGMENTS.slice(0, boundary);
      const view = liveDerivationView(
        foldLiveDerivation(emptyLiveDerivationState(), before.flat(), v3),
      );
      const derived = deriveMarketData(before, v3);
      const label = `límite de segmento ${String(boundary)}`;
      expect(view.pendingGaps, label).toEqual(derived.pendingGaps);
      expect(view.openConditionTypes, label).toEqual(derived.openConditionTypes);
      expect(view.pendingContinuitySymbols, label).toEqual(derived.pendingContinuitySymbols);
    }
    for (let at = 0; at <= events.length; at += 1) {
      const state = foldLiveDerivation(emptyLiveDerivationState(), events.slice(0, at), v3);
      // El estado pasa por su contrato y por JSON, como al guardarse y leerse (ADR-0017 §5).
      const stored = liveDerivationCheckpointSchema.parse(
        JSON.parse(
          JSON.stringify(
            buildLiveDerivationCheckpoint({
              event_count: Math.max(at, 1),
              profile: v3,
              raw_frame_count: 0,
              segment_index: 0,
              segment_logical_content_sha256: 'a'.repeat(64),
              state,
              symbol: 'SYNTH_100',
            }),
          ),
        ),
      ).state;
      expect(
        liveDerivationView(foldLiveDerivation(stored, events.slice(at), v3)),
        `evento ${String(at)}`,
      ).toEqual(whole);
    }
  });

  it('los ticks de la historia llevan el pip_size de su página, y los posteriores se comparan con ellos', () => {
    // Todo con pip_size 2, como Deriv; la página lo escribe 2.0, como la historia real. Los dos últimos
    // ticks del flujo llegan tarde, con la hora de uno recuperado: uno lo repite y el otro no.
    const tick2 = (
      sequence: number,
      conn: string,
      second: number,
      quote: string,
      receivedAt = at(second, 100),
    ) =>
      raw(
        sequence,
        conn,
        `{"msg_type":"tick","tick":{"epoch":${String(T0 + second)},"pip_size":2,"quote":${quote},"symbol":"${SYMBOL}"}}`,
        receivedAt,
      );
    const events = [
      opened(1, A, null, at(-1)),
      tick2(2, A, 0, '100.12'),
      tick2(3, A, 2, '100.25'),
      closed(4, A, at(3)),
      opened(5, B, A, at(5)),
      tick2(6, B, 6, '100.50'),
      page(7, B, {
        end: 6,
        pipSize: '2.0',
        prices: ['100.25', '100.37', '100.5'],
        receivedAt: at(8, 300),
        reqId: 3,
        start: 2,
        times: [2, 4, 6],
      }),
      recovered(
        8,
        B,
        { from: 2, to: 6 },
        { recovered_event_count: 1, status: 'complete' },
        at(8, 400),
      ),
      tick2(9, B, 4, '100.37', at(9)),
      tick2(10, B, 4, '100.38', at(9, 500)),
    ];
    const derived = deriveMarketData([events], v3);
    expect(
      derived.ticks
        .filter((item) => item.origin === 'history_recovery')
        .map((item) => [item.event_time_utc, item.pip_size, item.quote_decimal]),
    ).toEqual([[at(4), 2, '100.37']]);
    const duplicate = derived.incidents.find(
      (incident) => incident.incident_type === 'duplicate_exact',
    );
    expect([duplicate?.observed_ref, duplicate?.related_refs]).toEqual([id(9), ids(7)]);
    const conflict = derived.incidents.find(
      (incident) => incident.incident_type === 'source_time_conflict',
    );
    expect([conflict?.observed_ref, conflict?.related_refs]).toEqual([id(10), ids(7)]);
    expect(derived.ticks.find((item) => item.observation_id === id(10))?.quality_flags).toEqual([
      'delivery_delayed',
      'out_of_order',
      'source_time_conflict',
    ]);
  });

  it('una respuesta con req_id en texto no es una página: la sesión solo correlaciona números', () => {
    const textReqId = raw(
      44,
      B,
      `{"echo_req":{"count":1000,"end":"${String(T0 + 10)}","req_id":"4","start":${String(T0 + 4)},"style":"ticks","ticks_history":"${SYMBOL}"},"history":{"prices":[100.375,99.0,99.1,100.875],"times":[${[4, 6, 8, 10].map((second) => String(T0 + second)).join(',')}]},"msg_type":"history","pip_size":3,"req_id":"4"}`,
      at(12, 250),
    );
    const later = [...CASE_ONE_AFTER.slice(0, 4), textReqId, ...CASE_ONE_AFTER.slice(4)];
    const derived = deriveMarketData([CASE_ONE_BEFORE, later], v3);
    expect(derived.ticks.filter((item) => item.origin === 'history_recovery').map(summary)).toEqual(
      [
        [at(6), '100.500', 'history_recovery', id(9), []],
        [at(8), '100.625', 'history_recovery', id(9), []],
      ],
    );
  });

  it('un complete sin continuidad pendiente al principio de un dataset no da ticks ni falla', () => {
    // El dataset empieza después del cierre del caso 1, que quedó en el anterior.
    const derived = deriveMarketData([CASE_ONE_AFTER], v3);
    expect(derived.ticks.map(summary)).toEqual([[at(10), '100.875', 'stream', id(8), []]]);
  });

  it('un complete con un rango mayor que el hueco de su derivación no da ticks ni falla', () => {
    // El dataset empieza en el tick de 38 s: su hueco va de 38 a 42 s, y la historia, de 32 a 42.
    const derived = deriveMarketData([CASE_THREE.slice(4)], v3);
    expect(derived.ticks.every((item) => item.origin === 'stream')).toBe(true);
    expect(derived.pendingContinuitySymbols).toEqual([]);
  });

  it('un complete cuyo rango acaba después del fin del hueco no da ticks', () => {
    // El hueco de su derivación va de 4 a 10 s, y el resultado, de 4 a 12.
    const later = [
      opened(6, B, A, at(7)),
      tick(8, B, 10, '100.875'),
      page(9, B, {
        end: 12,
        prices: ['100.375', '100.500', '100.625', '100.875', '101.000'],
        receivedAt: at(14),
        reqId: 3,
        start: 4,
        times: [4, 6, 8, 10, 12],
      }),
      recovered(
        10,
        B,
        { from: 4, to: 12 },
        { recovered_event_count: 3, status: 'complete' },
        at(14, 100),
      ),
    ];
    const derived = deriveMarketData([CASE_ONE_BEFORE, later], v3);
    expect(derived.ticks.every((item) => item.origin === 'stream')).toBe(true);
    expect(derived.pendingContinuitySymbols).toEqual([]);
  });

  it('un partial sin continuidad pendiente al principio de un dataset tampoco falla', () => {
    const derived = deriveMarketData([CASES_FOUR_AND_SEVEN.slice(2, 6)], v3);
    expect(derived.incidents.map((incident) => incident.incident_type)).toEqual([
      'event_gap_unresolved',
    ]);
  });

  it('aborta si los tiempos del último intento no suman recovered_event_count', () => {
    const wrong = [
      ...CASE_ONE_AFTER.slice(0, 4),
      recovered(
        10,
        B,
        { from: 4, to: 10 },
        { recovered_event_count: 3, status: 'complete' },
        at(12, 300),
      ),
    ];
    expect(() => deriveMarketData([CASE_ONE_BEFORE, wrong], v3)).toThrow(/recovered_event_count/u);
  });

  it('aborta si una página del último intento no pasa las comprobaciones de ADR-0015 §4', () => {
    const broken = [
      ...CASE_ONE_AFTER.slice(0, 3),
      page(9, B, {
        end: 10,
        prices: ['100.375', '100.625', '100.5', '100.875'],
        receivedAt: at(12, 200),
        reqId: 3,
        start: 4,
        times: [4, 8, 6, 10],
      }),
      CASE_ONE_AFTER[4],
    ];
    expect(() => deriveMarketData([CASE_ONE_BEFORE, broken], v3)).toThrow(/página/u);
  });

  it('el dataset del vector es coherente y su identidad queda fijada', () => {
    forbidAmbientEffects();
    const publication = buildDatasetPublication({
      locateManifest: () => 's3://buoh-test/manifest',
      locateObject: () => 's3://buoh-test/object',
      profile: v3,
      publication_id: '019b76da-cb28-7003-8000-0000000000a1',
      published_at_utc: '2026-01-01T00:01:00.000Z',
      segments: SEGMENTS,
    });
    expect(publication.core).toMatchObject({
      event_time_from_utc: at(0),
      event_time_to_utc: at(58),
      incident_count: 9,
      incident_schema_version: '2.0.0',
      normalized_tick_count: 28,
      normalizer_version: '3.0.0',
      quality_rule_version: '3.0.0',
    });
    validateDatasetConsistency({
      conditions: publication.derived.conditions,
      core: publication.core,
      incidents: publication.derived.incidents,
      sourceEvents: SEGMENTS.flat(),
      ticks: publication.derived.ticks,
    });
    expect(publication.dataset_id).toBe(VECTOR_DATASET_ID);
  });
});

/**
 * La identidad del dataset del vector. Fija los bytes de todos sus artefactos: si cambia, cambió lo
 * que derivan las reglas 3.0.0, y eso necesita otra versión.
 */
const VECTOR_DATASET_ID = 'sha256:1bbd9e7513d0e01ba8fd84282378aa07b1a061bcaef086bd71c6c8552cc3298a';

describe('artefactos derivados por partes (ADR-0020 §7)', { timeout: 60_000 }, () => {
  /** Un dataset de una conexión con `count` ticks distintos, cada uno repetido `repeats` veces. */
  function bigSegment(count: number, repeats = 1): SourceEvent[] {
    const events: SourceEvent[] = [opened(1, A, null, at(-1))];
    let sequence = 2;
    for (let index = 0; index < count; index += 1) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        events.push(tick(sequence, A, index * 2, '100.125'));
        sequence += 1;
      }
    }
    return events;
  }

  function publish(segment: SourceEvent[], profile: PipelineProfile) {
    return buildDatasetPublication({
      locateManifest: () => 's3://buoh-test/manifest',
      locateObject: () => 's3://buoh-test/object',
      profile,
      publication_id: '019b76da-cb28-7003-8000-0000000000a1',
      published_at_utc: '2026-01-01T00:01:00.000Z',
      segments: [segment],
    });
  }

  const roleParts = (publication: ReturnType<typeof publish>, role: string) =>
    publication.core.logical_artifacts
      .filter((artifact) => artifact.role === role)
      .map((artifact) => [artifact.artifact_id, artifact.segment_index, artifact.record_count]);

  it('divide en partes de 5000 registros, en su orden canónico, cada una con su hash', () => {
    // 5001 ticks distintos, cada uno dos veces: 10 002 ticks y 5001 duplicados.
    const publication = publish(bigSegment(5001, 2), v3);
    expect(roleParts(publication, 'normalized_ticks')).toEqual([
      ['normalized_ticks:000000', 0, 5000],
      ['normalized_ticks:000001', 1, 5000],
      ['normalized_ticks:000002', 2, 2],
    ]);
    expect(roleParts(publication, 'quality_incidents')).toEqual([
      ['quality_incidents:000000', 0, 5000],
      ['quality_incidents:000001', 1, 1],
    ]);
    expect(roleParts(publication, 'operational_conditions')).toEqual([
      ['operational_conditions:000000', 0, 0],
    ]);
    const { ticks } = publication.derived;
    const hashes = publication.core.logical_artifacts
      .filter((artifact) => artifact.role === 'normalized_ticks')
      .map((artifact) => artifact.logical_content_sha256);
    expect(hashes).toEqual([
      sha256Hex(ndjsonBytes(ticks.slice(0, 5000))),
      sha256Hex(ndjsonBytes(ticks.slice(5000, 10_000))),
      sha256Hex(ndjsonBytes(ticks.slice(10_000))),
    ]);
    // Cada parte tiene su objeto físico.
    expect(publication.objects.has('normalized_ticks:000002')).toBe(true);
  });

  it('con 5000 registros justos queda una sola parte, y con 5001, dos', () => {
    expect(roleParts(publish(bigSegment(5000), v3), 'normalized_ticks')).toEqual([
      ['normalized_ticks:000000', 0, 5000],
    ]);
    expect(roleParts(publish(bigSegment(5001), v3), 'normalized_ticks')).toEqual([
      ['normalized_ticks:000000', 0, 5000],
      ['normalized_ticks:000001', 1, 1],
    ]);
  });

  it('las reglas 2.0.0 conservan un artefacto por rol', () => {
    expect(roleParts(publish(bigSegment(5001, 2), v2), 'normalized_ticks')).toEqual([
      ['normalized_ticks:000000', 0, 10_002],
    ]);
  });
});
