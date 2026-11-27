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

  it('ordena por incident_id dos incidencias del mismo instante y tipo', () => {
    const first = frame(
      candlesText(
        candleEcho(T, T + 60),
        [candle(T, '1', '1', '1', '1'), candle(T + 60, '2', '2', '2', '2')].join(','),
      ),
      iso(T + 3600),
    );
    // Repite las dos velas, con otros precios: dos candle_repeated con el mismo observed_at_utc.
    const again = frame(
      candlesText(
        candleEcho(T, T + 60),
        [candle(T, '3', '3', '3', '3'), candle(T + 60, '4', '4', '4', '4')].join(','),
      ),
      iso(T + 3601),
    );
    forbidAmbientEffects();
    const incidents = deriveBatchLog([first, again], config).incidents;
    const ids = incidents.map((incident) => incident.incident_id);
    expect(incidents).toHaveLength(2);
    expect(incidents.every((incident) => incident.incident_type === 'candle_repeated')).toBe(true);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(incidents.map((incident) => incident.observed_at_utc)).size).toBe(1);
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

// --- las velas que faltan dentro del horario -----------------------------------------------------

// Precisión del PR 5d1 de ADR-0021 §9: un minuto cuya vela pide una página respondida, ya terminado
// al recibirla y entero dentro del horario de su día entre los mismos eventos, sin vela, falta; cada
// tramo de minutos seguidos que faltan es un `candle_missing`. El horario es como el del oro el
// 2026-11-24: de 00:00 a 22:00 y de 23:00 al fin del día.
describe('las velas que faltan dentro del horario', () => {
  const DAY = '2026-11-24';
  const GOLD_OPEN = ['00:00:00', '23:00:00'];
  const GOLD_CLOSE = ['22:00:00', '23:59:59'];
  /** Las 22:00 del día de T, el cierre diario del oro. */
  const CLOSE = T + 10 * 3600;
  const sessionText = (
    open: string[],
    close: string[],
    symbols = ['SYNTH_GOLD'],
    date = DAY,
  ): string => {
    const entries = symbols
      .map(
        (symbol) =>
          `{"name":"x","times":{"close":${JSON.stringify(close)},"open":${JSON.stringify(open)}},"underlying_symbol":"${symbol}"}`,
      )
      .join(',');
    return `{"echo_req":{"req_id":1,"trading_times":"${date}"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[${entries}]}]}]}}`;
  };
  const page = (
    start: number,
    end: number,
    epochs: number[],
    received: number,
    symbol = 'SYNTH_GOLD',
  ) =>
    frame(
      candlesText(
        candleEcho(start, end, '', symbol),
        epochs.map((epoch) => candle(epoch, '1', '1', '1', '1')).join(','),
      ),
      iso(received),
    );
  const missingOf = (
    source: RawSourceFrame,
    from: number,
    to: number,
    sessions: RawSourceFrame[],
    symbol = 'SYNTH_GOLD',
  ) =>
    expected(source, {
      evidence: { from_open_time_utc: iso(from), to_open_time_utc: iso(to) },
      incident_type: 'candle_missing',
      related_refs: sessions.map((session) => session.observation_id).sort(),
      severity: 'error',
      symbol,
    });
  const missing = (events: SourceEvent[], at = config) =>
    deriveBatchLog(events, at).incidents.filter(
      (incident) => incident.incident_type === 'candle_missing',
    );

  it('da un candle_missing por tramo dentro del horario, y nada en el cierre ni en su borde', () => {
    const session = frame(sessionText(GOLD_OPEN, GOLD_CLOSE), iso(T + 3000));
    // Recibidas al día siguiente, con el día ya terminado, como las pide el paso de los lotes.
    const next = T + 12 * 3600 + 60;
    // Faltan las 12:02 y las 12:03, seguidas: un tramo.
    const gap = page(T, T + 299, [T, T + 60, T + 240], next);
    // De 22:00 a 22:59 el oro está cerrado, y Deriv no da velas.
    const closed = page(CLOSE, CLOSE + 3599, [], next + 1);
    // Las 21:58 y las 21:59 son del horario; las 22:00 y las 22:01, no.
    const edge = page(CLOSE - 120, CLOSE + 119, [CLOSE - 120, CLOSE - 60], next + 2);
    forbidAmbientEffects();
    expect(deriveBatchLog([session, gap, closed, edge], config).incidents).toEqual([
      missingOf(gap, T + 120, T + 180, [session]),
    ]);
  });

  it('pide desde el minuto de su start hasta el de su end, como acepta las velas la regla', () => {
    const session = frame(sessionText(GOLD_OPEN, GOLD_CLOSE), iso(T + 3000));
    const next = T + 12 * 3600 + 60;
    // Empieza a las 12:00:30 y acaba a las 12:02:30: pide las velas de las 12:00, 12:01 y 12:02.
    const page = frame(
      candlesText(candleEcho(T + 30, T + 150), candle(T + 60, '1', '1', '1', '1')),
      iso(next),
    );
    forbidAmbientEffects();
    expect(missing([session, page])).toEqual(
      [missingOf(page, T, T, [session]), missingOf(page, T + 120, T + 120, [session])].sort(
        (left, right) => (left.incident_id < right.incident_id ? -1 : 1),
      ),
    );
  });

  it('no espera el minuto que no había terminado al recibir la página', () => {
    const session = frame(sessionText(GOLD_OPEN, GOLD_CLOSE), iso(T + 3000));
    // Recibida a las 12:02:30: la vela de las 12:02 está en curso y queda fuera, sin faltar.
    const live = page(T, T + 299, [T, T + 60, T + 120], T + 150);
    forbidAmbientEffects();
    expect(missing([session, live])).toEqual([]);
  });

  it('sin horario de su día no comprueba nada, y con dos vale el último recibido', () => {
    const gap = page(T, T + 119, [T], T + 3600);
    const allDay = frame(sessionText(['00:00:00'], ['23:59:59']), iso(T + 3000));
    // Cerrado de 12:00 a 13:00.
    const halted = frame(
      sessionText(['00:00:00', '13:00:00'], ['12:00:00', '23:59:59']),
      iso(T + 3001),
    );
    const otherDay = frame(sessionText(['00:00:00'], ['23:59:59'], ['SYNTH_GOLD'], '2026-11-25'));
    forbidAmbientEffects();
    expect(missing([gap])).toEqual([]);
    expect(missing([otherDay, gap])).toEqual([]);
    // El último recibido, no el último del log: aquí el que dice cerrado.
    expect(missing([halted, allDay, gap])).toEqual([]);
    const allDayLate = frame(sessionText(['00:00:00'], ['23:59:59']), iso(T + 3002));
    expect(missing([halted, allDayLate, gap])).toEqual([
      missingOf(gap, T + 60, T + 60, [allDayLate]),
    ]);
  });

  it('un minuto que trae otra página no falta; uno que pidió una página con error, sí', () => {
    const session = frame(sessionText(GOLD_OPEN, GOLD_CLOSE), iso(T + 3000));
    const first = page(T, T + 119, [T], T + 3600);
    const second = page(T + 60, T + 119, [T + 60], T + 3601);
    const limited = frame(
      `{"echo_req":${candleEcho(T + 600, T + 719)},"error":{"code":"RateLimit","message":"x"},"msg_type":"ticks_history"}`,
      iso(T + 3602),
    );
    forbidAmbientEffects();
    // Las dos con el mismo instante: van por su tipo.
    expect(deriveBatchLog([session, first, second, limited], config).incidents).toEqual([
      missingOf(limited, T + 600, T + 660, [session]),
      invalidOf(limited, 'source_error_response', 'SYNTH_GOLD'),
    ]);
  });

  it('un tramo cruza páginas y lo firma la última que pidió su primer minuto; cada símbolo, el suyo', () => {
    const symbols = { ...config, trading_times_symbols: ['SYNTH_GOLD', 'SYNTH_SILVER'] };
    const session = frame(
      sessionText(['00:00:00'], ['23:59:59'], ['SYNTH_GOLD', 'SYNTH_SILVER']),
      iso(T + 3000),
    );
    // Faltan las 12:01, en la primera, y las 12:02, en la segunda: un tramo de las dos.
    const first = page(T, T + 119, [T], T + 3600);
    const second = page(T + 120, T + 239, [T + 180], T + 3601);
    // La tercera vuelve a pedir las 12:01, sin velas: es la última que la pidió.
    const again = page(T + 60, T + 119, [], T + 3602);
    // En la plata faltan las 12:01 y las 12:03, separadas: dos tramos.
    const silver = page(T, T + 239, [T, T + 120], T + 3603, 'SYNTH_SILVER');
    forbidAmbientEffects();
    const found = missing([session, first, second, again, silver], symbols);
    expect(found).toHaveLength(3);
    expect(found[0]).toEqual(missingOf(again, T + 60, T + 120, [session]));
    expect(found.slice(1)).toEqual(
      expect.arrayContaining([
        missingOf(silver, T + 60, T + 60, [session], 'SYNTH_SILVER'),
        missingOf(silver, T + 180, T + 180, [session], 'SYNTH_SILVER'),
      ]),
    );
    const ids = found.slice(1).map((incident) => incident.incident_id);
    expect(ids).toEqual([...ids].sort());
  });
});

// --- los tramos sin ticks de la historia dentro del horario --------------------------------------

// Precisión del PR 6b de ADR-0021 §9: con las reglas 4.1.0, un segundo que pide una página de ticks
// de la historia respondida, ya terminado al recibirla y entero dentro del horario de su día entre
// los mismos eventos, está comprobado. Dentro de los segundos comprobados seguidos, cada tramo sin
// ticks que dura al menos el umbral de su símbolo es un `tick_gap`: con 2 s, como R_100, dos ticks
// separados 3 s o más. El horario es como el del oro el 2026-11-24: de 00:00 a 22:00 y de 23:00 al
// fin del día.
describe('los tramos sin ticks de la historia dentro del horario', () => {
  const DAY = '2026-11-24';
  /** Las 22:00 del día de T, el cierre diario. */
  const CLOSE = T + 10 * 3600;
  const history: BatchLogConfig = {
    ...config,
    maximum_tick_gap_ms: { SYNTH_100: 2000 },
    quality_rule_version: '4.1.0',
    trading_times_symbols: ['SYNTH_100'],
  };
  const sessionText = (open: string[], close: string[], date = DAY): string =>
    `{"echo_req":{"req_id":1,"trading_times":"${date}"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":${JSON.stringify(close)},"open":${JSON.stringify(open)}},"underlying_symbol":"SYNTH_100"}]}]}]}}`;
  const goldHours = (received = T - 3600) =>
    frame(sessionText(['00:00:00', '23:00:00'], ['22:00:00', '23:59:59']), iso(received));
  const allDay = (received = T - 3600) =>
    frame(sessionText(['00:00:00'], ['23:59:59']), iso(received));
  /** Una página de `start` a `end` con ticks en `times`, recibida al día siguiente. */
  const page = (start: number, end: number, times: number[], received = T + 86_400) =>
    frame(
      historyText(
        ticksEcho(start, end),
        times,
        times.map(() => '1'),
      ),
      iso(received),
    );
  /** Cada 2 s desde `from` hasta `to`, sin los de `skip`. */
  const every2 = (from: number, to: number, skip: number[] = []) =>
    Array.from({ length: Math.floor((to - from) / 2) + 1 }, (_, index) => from + 2 * index).filter(
      (time) => !skip.includes(time),
    );
  const gapOf = (
    source: RawSourceFrame,
    from: number,
    to: number,
    sessions: RawSourceFrame[],
    maximum = 2000,
  ) => {
    const body = {
      evidence: {
        from_event_time_utc: iso(from),
        maximum_tick_gap_ms: maximum,
        to_event_time_utc: iso(to),
      },
      incident_type: 'tick_gap',
      observed_at_utc: source.received_at_utc,
      observed_ref: source.observation_id,
      quality_rule_version: '4.1.0',
      related_refs: sessions.map((session) => session.observation_id).sort(),
      schema_version: '3.1.0',
      severity: 'error',
      source: 'deriv_options',
      symbol: 'SYNTH_100',
    };
    return dataQualityIncidentSchema.parse({
      ...body,
      incident_id: deriveEventId(body),
    });
  };
  const gaps = (events: SourceEvent[], at = history) =>
    deriveBatchLog(events, at).incidents.filter(
      (incident) => incident.incident_type === 'tick_gap',
    );

  it('un tick que falta cada 2 s es un tramo; ticks regulares, y uno a 1 s del borde, no', () => {
    const session = allDay();
    // Falta el de T + 20: de T + 18 a T + 22 pasan 4 s, y T + 19, T + 20 y T + 21 no tienen ticks.
    const missing = page(T, T + 59, every2(T, T + 58, [T + 20]));
    // Un segundo sin ticks al principio de lo comprobado (T + 60), y ninguno al final.
    const regular = page(T + 60, T + 119, every2(T + 61, T + 119));
    forbidAmbientEffects();
    expect(gaps([session, missing])).toEqual([gapOf(missing, T + 19, T + 21, [session])]);
    expect(gaps([session, regular])).toEqual([]);
  });

  it('cuenta desde el principio y hasta el final de lo comprobado: 2 s sin ticks en un borde ya son un tramo', () => {
    const session = allDay();
    // Primer tick en T + 2: T y T + 1 sin ticks. Último en T + 57: T + 58 y T + 59 sin ticks.
    const edges = page(T, T + 59, [...every2(T + 2, T + 56), T + 57]);
    // Primer tick en T + 61 y último en T + 118: un segundo sin ticks en cada borde.
    const inner = page(T + 60, T + 119, [T + 61, ...every2(T + 62, T + 118)]);
    forbidAmbientEffects();
    // Las dos con el mismo instante y tipo: van por su incident_id.
    expect(gaps([session, edges])).toEqual(
      [gapOf(edges, T, T + 1, [session]), gapOf(edges, T + 58, T + 59, [session])].sort(
        (left, right) => (left.incident_id < right.incident_id ? -1 : 1),
      ),
    );
    expect(gaps([session, inner])).toEqual([]);
  });

  it('nada con el mercado cerrado ni en el cierre: solo se comprueban los segundos del horario', () => {
    const session = goldHours();
    // De 21:59:00 a 22:59:59: ticks hasta las 21:59:58 y ninguno con el mercado cerrado.
    const closing = page(CLOSE - 60, CLOSE + 3599, every2(CLOSE - 60, CLOSE - 2));
    // De 22:00 a 23:00 cerrado; desde las 23:00:00, otra vez ticks.
    const reopening = page(CLOSE + 3000, CLOSE + 3659, every2(CLOSE + 3600, CLOSE + 3658));
    // Cerrado todo el día.
    const closedDay = frame(sessionText(['--'], ['--']), iso(T - 3600));
    const silent = page(T, T + 59, []);
    forbidAmbientEffects();
    expect(gaps([session, closing, reopening])).toEqual([]);
    expect(gaps([closedDay, silent])).toEqual([]);
  });

  it('sin horario de su día no comprueba nada, y con dos vale el último recibido', () => {
    const silent = page(T, T + 59, []);
    const otherDay = frame(sessionText(['00:00:00'], ['23:59:59'], '2026-11-25'));
    // Cerrado de 12:00 a 13:00.
    const halted = frame(
      sessionText(['00:00:00', '13:00:00'], ['12:00:00', '23:59:59']),
      iso(T - 3599),
    );
    forbidAmbientEffects();
    expect(gaps([silent])).toEqual([]);
    expect(gaps([otherDay, silent])).toEqual([]);
    expect(gaps([halted, allDay(T - 3600), silent])).toEqual([]);
    const late = allDay(T - 3598);
    expect(gaps([halted, late, silent])).toEqual([gapOf(silent, T, T + 59, [late])]);
  });

  it('un segundo que trae otra página no falta; los de una página con error, sí', () => {
    const session = allDay();
    // La primera página no trae ticks; la segunda, del mismo tramo, sí.
    const empty = page(T, T + 59, [], T + 86_400);
    const full = page(T, T + 59, every2(T, T + 58), T + 86_401);
    const limited = frame(
      `{"echo_req":${ticksEcho(T + 600, T + 659)},"error":{"code":"RateLimit","message":"x"},"msg_type":"ticks_history"}`,
      iso(T + 86_402),
    );
    // Una página de velas con error no pide ticks.
    const candlesLimited = frame(
      `{"echo_req":${candleEcho(T + 1200, T + 1259, '', 'SYNTH_100')},"error":{"code":"RateLimit","message":"x"},"msg_type":"ticks_history"}`,
      iso(T + 86_403),
    );
    forbidAmbientEffects();
    expect(gaps([session, empty, full, limited, candlesLimited])).toEqual([
      gapOf(limited, T + 600, T + 659, [session]),
    ]);
  });

  it('un tramo cruza páginas seguidas y lo firma la última que pidió su primer segundo', () => {
    const session = allDay();
    // Sin ticks de T + 50 a T + 69, entre dos páginas seguidas.
    const first = page(T, T + 59, every2(T, T + 48), T + 86_400);
    const second = page(T + 60, T + 119, every2(T + 70, T + 118), T + 86_401);
    // Una tercera vuelve a pedir de T + 40 a T + 59, con los mismos ticks: es la última que pidió
    // T + 49, el primer segundo sin ticks.
    const again = page(T + 40, T + 59, every2(T + 40, T + 48), T + 86_402);
    forbidAmbientEffects();
    expect(gaps([session, first, second])).toEqual([gapOf(first, T + 49, T + 69, [session])]);
    expect(gaps([session, first, second, again])).toEqual([
      gapOf(again, T + 49, T + 69, [session]),
    ]);
  });

  it('un tramo que cruza la medianoche cita los horarios de los dos días', () => {
    const today = allDay();
    const tomorrow = frame(sessionText(['00:00:00'], ['23:59:59'], '2026-11-25'), iso(T - 3599));
    /** La medianoche del 2026-11-25. */
    const MIDNIGHT = T + 12 * 3600;
    // Sin ticks de 23:59:50 a 00:00:09.
    const crossing = page(MIDNIGHT - 60, MIDNIGHT + 59, [
      ...every2(MIDNIGHT - 60, MIDNIGHT - 12),
      ...every2(MIDNIGHT + 10, MIDNIGHT + 58),
    ]);
    // Sin ticks solo en el día siguiente, de 00:00:20 a 00:00:29: solo su horario.
    const after = page(MIDNIGHT, MIDNIGHT + 59, [
      ...every2(MIDNIGHT, MIDNIGHT + 18),
      ...every2(MIDNIGHT + 30, MIDNIGHT + 58),
    ]);
    forbidAmbientEffects();
    expect(gaps([today, tomorrow, crossing])).toEqual([
      gapOf(crossing, MIDNIGHT - 11, MIDNIGHT + 9, [today, tomorrow]),
    ]);
    expect(gaps([today, tomorrow, after])).toEqual([
      gapOf(after, MIDNIGHT + 19, MIDNIGHT + 29, [tomorrow]),
    ]);
  });

  it('un tramo que cruza el borde entre dos datasets se mide en cada uno hasta su borde', () => {
    const session = allDay();
    const gold = { ...history, maximum_tick_gap_ms: { SYNTH_100: 60_000 } };
    // Sin ticks de T + 141 a T + 219, 79 s, entre dos bloques: 39 s en el primero y 40 en el segundo.
    const first = page(T, T + 179, every2(T, T + 140));
    const second = page(T + 180, T + 359, every2(T + 220, T + 358), T + 86_401);
    forbidAmbientEffects();
    expect(gaps([session, first, second], gold)).toEqual([
      gapOf(first, T + 141, T + 219, [session], 60_000),
    ]);
    // Cada dataset se reproduce solo: ninguno de los dos trozos llega a 60 s.
    expect(gaps([session, first], gold)).toEqual([]);
    expect(gaps([session, second], gold)).toEqual([]);
  });

  it('no espera los segundos que no habían terminado al recibir la página', () => {
    const session = allDay();
    // Recibida a T + 30.5: comprueba hasta T + 29, que tiene su tick.
    const live = frame(
      historyText(
        ticksEcho(T, T + 59),
        every2(T, T + 28),
        every2(T, T + 28).map(() => '1'),
      ),
      new Date((T + 30) * 1000 + 500).toISOString(),
    );
    forbidAmbientEffects();
    expect(gaps([session, live])).toEqual([]);
  });

  it('con otro umbral, otros tramos; sin umbral o con las reglas 4.0.0, ninguno', () => {
    const session = allDay();
    // Un hueco de 5 s sin ticks (de T + 11 a T + 15) y otro de 2 s (T + 31 y T + 32).
    const source = page(T, T + 59, [
      ...every2(T, T + 10),
      ...every2(T + 16, T + 30),
      ...every2(T + 33, T + 59),
    ]);
    const loose = { ...history, maximum_tick_gap_ms: { SYNTH_100: 5000 } };
    forbidAmbientEffects();
    expect(gaps([session, source], loose)).toEqual([
      gapOf(source, T + 11, T + 15, [session], 5000),
    ]);
    expect(gaps([session, source], { ...history, maximum_tick_gap_ms: {} })).toEqual([]);
    expect(
      gaps([session, source], { ...history, maximum_tick_gap_ms: { SYNTH_GOLD: 2000 } }),
    ).toEqual([]);
    expect(gaps([session, source], { ...config, trading_times_symbols: ['SYNTH_100'] })).toEqual(
      [],
    );
  });

  it('con las reglas 4.1.0, todas las incidencias llevan el esquema 3.1.0; con las 4.0.0, el 3.0.0', () => {
    const session = allDay();
    const first = page(T, T + 3, [T, T + 2]);
    const repeated = page(T, T + 3, [T, T + 2], T + 86_401);
    forbidAmbientEffects();
    const before = deriveBatchLog([session, first, repeated], {
      ...config,
      trading_times_symbols: ['SYNTH_100'],
    });
    const after = deriveBatchLog([session, first, repeated], history);
    expect(before.ticks).toEqual(after.ticks);
    expect(before.incidents).toHaveLength(2);
    expect(after.incidents).toHaveLength(2);
    expect(before.incidents.map((incident) => incident.schema_version)).toEqual(['3.0.0', '3.0.0']);
    expect(after.incidents).toEqual(
      before.incidents
        .map((incident) => {
          const body: Record<string, unknown> = {
            ...incident,
            quality_rule_version: '4.1.0',
            schema_version: '3.1.0',
          };
          delete body['incident_id'];
          return dataQualityIncidentSchema.parse({
            ...body,
            incident_id: deriveEventId(body as Parameters<typeof deriveEventId>[0]),
          });
        })
        .sort((left, right) => (left.incident_id < right.incident_id ? -1 : 1)),
    );
  });

  it('rechaza un umbral con las reglas 4.0.0, uno que no es de segundos enteros y otras reglas', () => {
    const session = allDay();
    expect(() =>
      deriveBatchLog([session], { ...config, maximum_tick_gap_ms: { SYNTH_100: 2000 } }),
    ).toThrow(TypeError);
    expect(() =>
      deriveBatchLog([session], { ...history, maximum_tick_gap_ms: { SYNTH_100: 1500 } }),
    ).toThrow(TypeError);
    expect(() =>
      deriveBatchLog([session], { ...history, maximum_tick_gap_ms: { SYNTH_100: 0 } }),
    ).toThrow(TypeError);
    expect(() =>
      deriveBatchLog([session], {
        ...history,
        quality_rule_version: '3.0.0' as NonNullable<BatchLogConfig['quality_rule_version']>,
      }),
    ).toThrow(TypeError);
  });
});
