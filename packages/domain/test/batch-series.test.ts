import { createHash } from 'node:crypto';

import {
  dataQualityIncidentSchema,
  deriveEventId,
  rawSourceFrameSchema,
  type RawSourceFrame,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveBatchLog,
  deriveHistoryDownloadTicks,
  deriveMarketCandles,
  type BatchLogConfig,
} from '../src/index.js';

// Vector sintético de las reglas de los lotes 4.0.0 para las velas, los ticks de la historia y la
// clasificación de un log (ADR-0021 §3 y §4, PR 4d de su §9; contratos de dominio, «Semántica
// ejecutable de las reglas de los lotes 4.0.0»). Las formas de las respuestas son las medidas el
// 2026-11-25 en el canal público de Deriv; los precios y los símbolos (`SYNTH_GOLD`, `SYNTH_100`)
// son sintéticos. Las expectativas, con sus huellas y sus IDs, se arman aquí a mano.

const CONNECTION = '019b76da-a800-7000-8000-00000000c000';
const CONNECTOR = 'deriv-options-lotes-1.0.0';
/** 2026-11-24T12:00:00Z en segundos. */
const T = 1795521600;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let sequence = 0;

/** Un frame durable con el texto exacto, para conservar lexemas como `100.10` o `2.0`. */
function frame(text: string, received = iso(T + 3600)): RawSourceFrame {
  sequence += 1;
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: CONNECTOR,
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${String(sequence).padStart(12, '0')}`,
    payload_utf8: text,
    raw_payload_sha256: sha256(text),
    received_at_utc: received,
    schema_version: '1.0.0',
    source: 'deriv_options',
  });
}

const accept = { validate: () => true };
const reject = { validate: () => false };

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en las reglas.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en las reglas.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en las reglas.');
  });
}

beforeEach(() => {
  sequence = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** La incidencia esperada, con su ID calculado aquí. */
function expected(
  source: RawSourceFrame,
  incident: {
    evidence: Record<string, unknown>;
    incident_type: string;
    related_refs?: string[];
    severity: string;
    symbol: string | null;
  },
) {
  const body = {
    related_refs: [],
    ...incident,
    observed_at_utc: source.received_at_utc,
    observed_ref: source.observation_id,
    quality_rule_version: '4.0.0',
    schema_version: '3.0.0',
    source: 'deriv_options',
  };
  return dataQualityIncidentSchema.parse({
    ...body,
    incident_id: deriveEventId(body as Parameters<typeof deriveEventId>[0]),
  });
}
const invalidOf = (source: RawSourceFrame, reason: string, symbol: string | null) =>
  expected(source, {
    evidence: { raw_payload_sha256: source.raw_payload_sha256, reason },
    incident_type: 'invalid_source_frame',
    severity: 'error',
    symbol,
  });

// --- velas -------------------------------------------------------------------------------------

const candleEcho = (start: number, end: number, extra = '', symbol = 'SYNTH_GOLD') =>
  `{"end":"${String(end)}","granularity":60,"req_id":7,"start":${String(start)},"style":"candles","ticks_history":"${symbol}"${extra}}`;
const candlesText = (echo: string, candles: string, pip = '2') =>
  `{"candles":[${candles}],"echo_req":${echo},"msg_type":"candles","pip_size":${pip},"req_id":7}`;
const candle = (epoch: number, open: string, high: string, low: string, close: string) =>
  `{"close":${close},"epoch":${String(epoch)},"high":${high},"low":${low},"open":${open}}`;

/** La vela esperada, con su huella del JCS escrito a mano (claves en orden, sin espacios). */
function expectedCandle(
  source: RawSourceFrame,
  epoch: number,
  [open, high, low, close]: [string, string, string, string],
  symbol = 'SYNTH_GOLD',
) {
  const identity = `{"close_decimal":"${close}","granularity_seconds":60,"high_decimal":"${high}","low_decimal":"${low}","open_decimal":"${open}","open_time_utc":"${iso(epoch)}","pip_size":2,"source":"deriv_options","symbol":"${symbol}"}`;
  return {
    candle_fingerprint_sha256: sha256(identity),
    close_decimal: close,
    connector_version: CONNECTOR,
    granularity_seconds: 60,
    high_decimal: high,
    low_decimal: low,
    observation_id: source.observation_id,
    open_decimal: open,
    open_time_utc: iso(epoch),
    pip_size: 2,
    quality_flags: [],
    raw_payload_sha256: source.raw_payload_sha256,
    received_at_utc: source.received_at_utc,
    schema_version: '1.0.0',
    source: 'deriv_options',
    symbol,
  };
}

describe('velas', () => {
  it('da las velas de la página, con pip_size decimales y su huella', () => {
    const source = frame(
      candlesText(
        candleEcho(T, T + 120),
        [
          candle(T, '100.1', '100.4', '99.9', '100.25'),
          candle(T + 60, '100', '100.5', '100', '100.5'),
          candle(T + 120, '100.5', '100.5', '100.5', '100.5'),
        ].join(','),
      ),
    );
    forbidAmbientEffects();
    expect(deriveMarketCandles(source, accept)).toEqual({
      incidents: [],
      records: [
        expectedCandle(source, T, ['100.10', '100.40', '99.90', '100.25']),
        expectedCandle(source, T + 60, ['100.00', '100.50', '100.00', '100.50']),
        expectedCandle(source, T + 120, ['100.50', '100.50', '100.50', '100.50']),
      ],
    });
  });

  it('deja fuera la última vela si su minuto no había terminado, sin incidencia', () => {
    const page = candlesText(
      candleEcho(T, T + 60),
      [candle(T, '1', '1', '1', '1'), candle(T + 60, '1', '1', '1', '1')].join(','),
    );
    const inProgress = frame(page, iso(T + 119).replace('.000Z', '.999Z'));
    const finished = frame(page, iso(T + 120));
    forbidAmbientEffects();
    expect(
      deriveMarketCandles(inProgress, accept).records.map((record) => record.open_time_utc),
    ).toEqual([iso(T)]);
    expect(deriveMarketCandles(inProgress, accept).incidents).toEqual([]);
    expect(deriveMarketCandles(finished, accept).records).toHaveLength(2);
  });

  it('acepta la vela del principio del minuto de un start a mitad de minuto, y no la anterior', () => {
    const fromMinute = frame(
      candlesText(candleEcho(T + 30, T + 60), candle(T, '1', '1', '1', '1')),
    );
    const before = frame(
      candlesText(candleEcho(T + 30, T + 60), candle(T - 60, '1', '1', '1', '1')),
    );
    forbidAmbientEffects();
    expect(deriveMarketCandles(fromMinute, accept).records).toEqual([
      expectedCandle(fromMinute, T, ['1.00', '1.00', '1.00', '1.00']),
    ]);
    expect(deriveMarketCandles(before, accept).incidents).toEqual([
      invalidOf(before, 'candles_inconsistent', 'SYNTH_GOLD'),
    ]);
  });

  it('no da velas ni incidencia con el mercado cerrado', () => {
    const source = frame(candlesText(candleEcho(T, T + 600), ''));
    forbidAmbientEffects();
    expect(deriveMarketCandles(source, accept)).toEqual({ incidents: [], records: [] });
  });

  it('da candles_inconsistent a la página entera con una vela incoherente', () => {
    const good = candle(T, '1', '1', '1', '1');
    const pages = [
      candlesText(candleEcho(T, T + 60), [good, good].join(',')),
      candlesText(candleEcho(T, T + 60), [candle(T + 60, '1', '1', '1', '1'), good].join(',')),
      candlesText(candleEcho(T, T + 60), [good, candle(T + 120, '1', '1', '1', '1')].join(',')),
      candlesText(candleEcho(T + 60, T + 120), candle(T, '1', '1', '1', '1')),
      candlesText(candleEcho(T, T + 60), candle(T + 30, '1', '1', '1', '1')),
      candlesText(candleEcho(T, T + 60), candle(T, '1e2', '1', '1', '1')),
      candlesText(candleEcho(T, T + 60), candle(T, '1.234', '1', '1', '1')),
      candlesText(candleEcho(T, T + 60), candle(T, '2', '1', '1', '1')),
      candlesText(candleEcho(T, T + 60), candle(T, '1', '1', '2', '1')),
      candlesText(candleEcho(T, T + 60), good, '2.5'),
      candlesText(candleEcho(T, T + 60), '{"close":1,"epoch":1795521600,"high":1,"open":1}'),
      `{"echo_req":${candleEcho(T, T + 60)},"msg_type":"candles","pip_size":2,"req_id":7}`,
      // Una vela en curso que no es la última de la página.
      candlesText(
        candleEcho(T, T + 7200),
        [good, candle(T + 3600, '1', '1', '1', '1'), candle(T + 3660, '1', '1', '1', '1')].join(
          ',',
        ),
      ),
    ];
    const sources = pages.map((text) => frame(text));
    forbidAmbientEffects();
    for (const source of sources) {
      expect(deriveMarketCandles(source, accept)).toEqual({
        incidents: [invalidOf(source, 'candles_inconsistent', 'SYNTH_GOLD')],
        records: [],
      });
    }
  });

  it('da history_request_unsupported con una petición que no es de los lotes', () => {
    const good = candle(T, '1', '1', '1', '1');
    const echoes = [
      `{"end":"latest","granularity":60,"start":${String(T)},"style":"candles","ticks_history":"SYNTH_GOLD"}`,
      `{"end":"${String(T + 60)}","granularity":120,"start":${String(T)},"style":"candles","ticks_history":"SYNTH_GOLD"}`,
      `{"end":"${String(T + 60)}","granularity":60,"start":${String(T)},"ticks_history":"SYNTH_GOLD"}`,
      `{"end":"${String(T + 60)}","granularity":60,"style":"candles","ticks_history":"SYNTH_GOLD"}`,
      candleEcho(T + 60, T),
      candleEcho(T, T + 60, ',"adjust_start_time":1'),
    ];
    const sources = echoes.map((echo) => frame(candlesText(echo, good)));
    forbidAmbientEffects();
    for (const source of sources) {
      expect(deriveMarketCandles(source, accept).incidents).toEqual([
        invalidOf(source, 'history_request_unsupported', 'SYNTH_GOLD'),
      ]);
    }
  });

  it('da source_error_response y schema_validation_failed con el símbolo pedido', () => {
    const error = frame(
      `{"echo_req":${candleEcho(T, T + 60)},"error":{"code":"InvalidSymbol","message":"synthetic"},"msg_type":"candles","req_id":7}`,
    );
    const schema = frame(candlesText(candleEcho(T, T + 60), candle(T, '1', '1', '1', '1')));
    forbidAmbientEffects();
    expect(deriveMarketCandles(error, accept).incidents).toEqual([
      invalidOf(error, 'source_error_response', 'SYNTH_GOLD'),
    ]);
    expect(deriveMarketCandles(schema, reject).incidents).toEqual([
      invalidOf(schema, 'schema_validation_failed', 'SYNTH_GOLD'),
    ]);
  });
});

// --- ticks de la historia ----------------------------------------------------------------------

const ticksEcho = (start: number, end: number, extra = '') =>
  `{"end":"${String(end)}","req_id":8,"start":${String(start)},"style":"ticks","ticks_history":"SYNTH_100"${extra}}`;
const historyText = (echo: string, times: number[], prices: string[], pip = '2.0') =>
  `{"echo_req":${echo},"history":{"prices":[${prices.join(',')}],"times":[${times.map(String).join(',')}]},"msg_type":"history","pip_size":${pip},"req_id":8}`;

function expectedTick(source: RawSourceFrame, time: number, quote: string) {
  const identity = `{"event_time_utc":"${iso(time)}","pip_size":2,"quote_decimal":"${quote}","source":"deriv_options","symbol":"SYNTH_100"}`;
  return {
    connector_version: CONNECTOR,
    event_time_utc: iso(time),
    observation_id: source.observation_id,
    origin: 'history_download',
    pip_size: 2,
    quality_flags: [],
    quote_decimal: quote,
    raw_payload_sha256: source.raw_payload_sha256,
    received_at_utc: source.received_at_utc,
    schema_version: '1.1.0',
    source: 'deriv_options',
    symbol: 'SYNTH_100',
    tick_fingerprint_sha256: sha256(identity),
  };
}

describe('ticks de la historia', () => {
  it('da MarketTick 1.1.0 con el origen history_download y la procedencia del frame', () => {
    const source = frame(
      historyText(ticksEcho(T, T + 10), [T, T + 2, T + 10], ['100.5', '101', '99.99']),
    );
    const withoutStyle = frame(
      historyText(
        `{"end":"${String(T + 10)}","start":${String(T)},"ticks_history":"SYNTH_100"}`,
        [T],
        ['1'],
      ),
    );
    forbidAmbientEffects();
    expect(deriveHistoryDownloadTicks(source, accept)).toEqual({
      incidents: [],
      records: [
        expectedTick(source, T, '100.50'),
        expectedTick(source, T + 2, '101.00'),
        expectedTick(source, T + 10, '99.99'),
      ],
    });
    expect(deriveHistoryDownloadTicks(withoutStyle, accept).records).toEqual([
      expectedTick(withoutStyle, T, '1.00'),
    ]);
  });

  it('da history_inconsistent a la página entera y history_request_unsupported a una petición ajena', () => {
    const inconsistent = [
      historyText(ticksEcho(T, T + 10), [T + 11], ['1']),
      historyText(ticksEcho(T, T + 10), [T - 1], ['1']),
      historyText(ticksEcho(T, T + 10), [T + 2, T + 2], ['1', '1']),
      historyText(ticksEcho(T, T + 10), [T, T + 1], ['1']),
      historyText(ticksEcho(T, T + 10), [T], ['1.234']),
    ].map((text) => frame(text));
    const unsupported = [
      `{"end":"latest","start":${String(T)},"ticks_history":"SYNTH_100"}`,
      `{"end":"${String(T + 10)}","ticks_history":"SYNTH_100"}`,
      ticksEcho(T, T + 10, ',"adjust_start_time":1'),
      ticksEcho(T, T + 10, ',"granularity":60'),
      `{"end":"${String(T + 10)}","start":${String(T)},"style":"candles","ticks_history":"SYNTH_100"}`,
    ].map((echo) => frame(historyText(echo, [T], ['1'])));
    forbidAmbientEffects();
    for (const source of inconsistent) {
      expect(deriveHistoryDownloadTicks(source, accept)).toEqual({
        incidents: [invalidOf(source, 'history_inconsistent', 'SYNTH_100')],
        records: [],
      });
    }
    for (const source of unsupported) {
      expect(deriveHistoryDownloadTicks(source, accept).incidents).toEqual([
        invalidOf(source, 'history_request_unsupported', 'SYNTH_100'),
      ]);
    }
  });
});

// --- el log ------------------------------------------------------------------------------------

const config: BatchLogConfig = {
  schemas: {
    active_symbols: { release: 'synthetic-v1', sha256: 'f'.repeat(64), validate: () => true },
    contracts_for: accept,
    proposal: accept,
    ticks_history: accept,
    trading_times: accept,
  },
  trading_times_symbols: ['SYNTH_GOLD'],
};

describe('un log de los lotes', () => {
  it('clasifica cada respuesta, quita las repetidas y ordena cada clase', () => {
    const at = (offset: number) => iso(T + 3600 + offset);
    const opened = {
      connection_id: CONNECTION,
      event_id: '019b76da-a800-7000-8000-0000000000ff',
      kind: 'connection_opened',
      occurred_at_utc: at(0),
      schema_version: '1.0.0',
      source: 'deriv_options',
    } as unknown as SourceEvent;
    const pageA = frame(
      candlesText(
        candleEcho(T, T + 60),
        [candle(T, '1', '2', '1', '2'), candle(T + 60, '2', '2', '2', '2')].join(','),
      ),
      at(1),
    );
    // La segunda página repite el minuto T + 60 igual y trae T + 120 con otros precios que la tercera.
    const pageB = frame(
      candlesText(
        candleEcho(T + 60, T + 120),
        [candle(T + 60, '2', '2', '2', '2'), candle(T + 120, '3', '3', '3', '3')].join(','),
      ),
      at(2),
    );
    const pageC = frame(
      candlesText(candleEcho(T + 120, T + 120), candle(T + 120, '4', '4', '4', '4')),
      at(3),
    );
    const ticksA = frame(
      historyText(ticksEcho(T, T + 4), [T, T + 2, T + 4], ['1', '2', '3']),
      at(4),
    );
    const ticksB = frame(historyText(ticksEcho(T + 4, T + 6), [T + 4, T + 6], ['9', '4']), at(5));
    const ticksC = frame(historyText(ticksEcho(T, T + 2), [T + 2], ['2']), at(6));
    // Llegan después en el log, pero van antes en su orden canónico.
    const pageD = frame(
      candlesText(candleEcho(T, T, '', 'SYNTH_SILVER'), candle(T, '5', '5', '5', '5')),
      at(6),
    );
    const ticksD = frame(historyText(ticksEcho(T, T + 3), [T + 1, T + 3], ['7', '8']), at(6));
    const sessions = frame(
      `{"echo_req":{"req_id":1,"trading_times":"2026-11-25"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":["23:59:59"],"open":["00:00:00"]},"underlying_symbol":"SYNTH_GOLD"}]}]}]}}`,
      at(7),
    );
    const catalogOk = frame(
      `{"active_symbols":[{"exchange_is_open":1,"is_trading_suspended":0,"market":"x","pip_size":0.01,"subgroup":"x","submarket":"x","underlying_symbol":"SYNTH_GOLD","underlying_symbol_name":"x"}],"echo_req":{"active_symbols":"brief"},"msg_type":"active_symbols"}`,
      at(8),
    );
    const catalogEmpty = frame(
      `{"active_symbols":[],"echo_req":{"active_symbols":"brief"},"msg_type":"active_symbols"}`,
      // Recibido antes que todo, aunque va más abajo en el log: su incidencia va la primera.
      at(0),
    );
    const notJson = frame('{', at(10));
    const ping = frame('{"echo_req":{"ping":1},"msg_type":"ping","ping":"pong"}', at(11));
    const historyError = frame(
      `{"echo_req":${ticksEcho(T, T + 2)},"error":{"code":"RateLimit","message":"synthetic"},"msg_type":"ticks_history"}`,
      at(12),
    );
    const noError = frame(`{"echo_req":${ticksEcho(T, T + 2)},"msg_type":"ticks_history"}`, at(13));
    // Mismo instante que la vela repetida de pageC: las dos incidencias se ordenan por su tipo.
    const lateError = frame('{"echo_req":{"time":1},"msg_type":"time","time":1}', at(3));
    // Una tercera copia del tick de ticksB, que no contó: otro conflicto contra el de ticksA.
    const ticksE = frame(historyText(ticksEcho(T + 4, T + 4), [T + 4], ['9']), at(6));
    const offerText = (symbol: string) =>
      `{"contracts_for":{"available":[{"barriers":0,"contract_category":"multiplier","contract_type":"MULTUP","expiry_type":"no_expiry","market":"x","max_contract_duration":"0","min_contract_duration":"0","sentiment":"up","submarket":"x","underlying_symbol":"${symbol}"}],"hit_count":1},"echo_req":{"contracts_for":"${symbol}","req_id":2},"msg_type":"contracts_for","req_id":2}`;
    const quoteText = (symbol: string) =>
      `{"echo_req":{"amount":10,"basis":"stake","contract_type":"MULTUP","currency":"USD","multiplier":100,"proposal":1,"req_id":4,"underlying_symbol":"${symbol}"},"msg_type":"proposal","proposal":{"ask_price":10.00,"commission":0.20,"date_start":${String(T)},"id":"x","longcode":"x","multiplier":100,"payout":0,"spot":1,"spot_time":${String(T)}},"req_id":4}`;
    const offerGold = frame(offerText('SYNTH_GOLD'), at(14));
    const quoteGold = frame(quoteText('SYNTH_GOLD'), at(15));
    // Recibidos antes, aunque van después en el log.
    const offerEarly = frame(offerText('SYNTH_100'), at(0));
    const quoteEarly = frame(quoteText('SYNTH_100'), at(0));
    const events = [
      opened,
      pageA,
      pageB,
      lateError,
      pageC,
      ticksA,
      ticksB,
      ticksE,
      ticksC,
      pageD,
      ticksD,
      sessions,
      catalogOk,
      catalogEmpty,
      notJson,
      ping,
      historyError,
      noError,
      offerGold,
      quoteGold,
      offerEarly,
      quoteEarly,
    ];
    forbidAmbientEffects();
    const derived = deriveBatchLog(events, config);

    expect(derived.candles).toEqual([
      expectedCandle(pageA, T, ['1.00', '2.00', '1.00', '2.00']),
      expectedCandle(pageD, T, ['5.00', '5.00', '5.00', '5.00'], 'SYNTH_SILVER'),
      expectedCandle(pageA, T + 60, ['2.00', '2.00', '2.00', '2.00']),
      expectedCandle(pageB, T + 120, ['3.00', '3.00', '3.00', '3.00']),
    ]);
    expect(derived.ticks).toEqual([
      expectedTick(ticksA, T, '1.00'),
      expectedTick(ticksD, T + 1, '7.00'),
      expectedTick(ticksA, T + 2, '2.00'),
      expectedTick(ticksD, T + 3, '8.00'),
      expectedTick(ticksA, T + 4, '3.00'),
      expectedTick(ticksB, T + 6, '4.00'),
    ]);
    expect(derived.sessions.map((record) => [record.symbol, record.observation_id])).toEqual([
      ['SYNTH_GOLD', sessions.observation_id],
    ]);
    expect(derived.offers.map((record) => [record.symbol, record.observation_id])).toEqual([
      ['SYNTH_100', offerEarly.observation_id],
      ['SYNTH_GOLD', offerGold.observation_id],
    ]);
    expect(
      derived.quotes.map((record) => [record.symbol, record.observation_id, record.contract_type]),
    ).toEqual([
      ['SYNTH_100', quoteEarly.observation_id, 'MULTUP'],
      ['SYNTH_GOLD', quoteGold.observation_id, 'MULTUP'],
    ]);

    const repeatedCandle = expectedCandle(pageA, T + 60, [
      '2.00',
      '2.00',
      '2.00',
      '2.00',
    ]).candle_fingerprint_sha256;
    const firstThree = expectedCandle(pageB, T + 120, [
      '3.00',
      '3.00',
      '3.00',
      '3.00',
    ]).candle_fingerprint_sha256;
    const otherThree = expectedCandle(pageC, T + 120, [
      '4.00',
      '4.00',
      '4.00',
      '4.00',
    ]).candle_fingerprint_sha256;
    const tickThree = expectedTick(ticksA, T + 4, '3.00').tick_fingerprint_sha256;
    const tickNine = expectedTick(ticksB, T + 4, '9.00').tick_fingerprint_sha256;
    const tickTwo = expectedTick(ticksA, T + 2, '2.00').tick_fingerprint_sha256;
    expect(derived.incidents).toEqual([
      invalidOf(catalogEmpty, 'catalog_empty', null),
      expected(pageB, {
        evidence: {
          candle_fingerprint_sha256: repeatedCandle,
          first_candle_fingerprint_sha256: repeatedCandle,
          open_time_utc: iso(T + 60),
        },
        incident_type: 'candle_repeated',
        related_refs: [pageA.observation_id],
        severity: 'warning',
        symbol: 'SYNTH_GOLD',
      }),
      expected(pageC, {
        evidence: {
          candle_fingerprint_sha256: otherThree,
          first_candle_fingerprint_sha256: firstThree,
          open_time_utc: iso(T + 120),
        },
        incident_type: 'candle_repeated',
        related_refs: [pageB.observation_id],
        severity: 'error',
        symbol: 'SYNTH_GOLD',
      }),
      invalidOf(lateError, 'unexpected_msg_type', null),
      expected(ticksB, {
        evidence: { event_time_utc: iso(T + 4), tick_fingerprints: [tickThree, tickNine].sort() },
        incident_type: 'source_time_conflict',
        related_refs: [ticksA.observation_id],
        severity: 'error',
        symbol: 'SYNTH_100',
      }),
      expected(ticksC, {
        evidence: { tick_fingerprint_sha256: tickTwo },
        incident_type: 'duplicate_exact',
        related_refs: [ticksA.observation_id],
        severity: 'warning',
        symbol: 'SYNTH_100',
      }),
      expected(ticksE, {
        evidence: { event_time_utc: iso(T + 4), tick_fingerprints: [tickThree, tickNine].sort() },
        incident_type: 'source_time_conflict',
        related_refs: [ticksA.observation_id],
        severity: 'error',
        symbol: 'SYNTH_100',
      }),
      invalidOf(notJson, 'payload_not_json', null),
      invalidOf(ping, 'unexpected_msg_type', null),
      invalidOf(historyError, 'source_error_response', 'SYNTH_100'),
      invalidOf(noError, 'unexpected_msg_type', null),
    ]);
  });

  it('da lo mismo al repetirlo, y nada con un log sin respuestas', () => {
    const page = frame(candlesText(candleEcho(T, T + 60), candle(T, '1', '1', '1', '1')));
    forbidAmbientEffects();
    expect(deriveBatchLog([page], config)).toEqual(deriveBatchLog([page], config));
    expect(deriveBatchLog([], config)).toEqual({
      candles: [],
      incidents: [],
      offers: [],
      quotes: [],
      sessions: [],
      ticks: [],
    });
  });
});
