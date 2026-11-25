import { createHash } from 'node:crypto';

import { rawSourceFrameSchema, type RawSourceFrame } from '@buoh/contracts';
import {
  BATCH_RULE_SET,
  deriveContractOffer,
  deriveContractQuote,
  deriveMarketCandles,
  deriveTradingSessions,
} from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import {
  batchProfileBytes,
  DERIV_BATCH_CONNECTOR_VERSION,
  derivBatchLogProfileRow,
  derivCandlesProfile,
  derivQuotesProfile,
  derivSchedulesProfile,
} from '../src/deriv/batch-profile.js';
import {
  batchRequestBody,
  candleRequests,
  dayStartEpoch,
  encodeBatchRequest,
  EXPECTED_BATCH_MSG_TYPE,
  quoteRequests,
  scheduleRequests,
  type BatchRequest,
} from '../src/deriv/batch-requests.js';
import { openSchemaArchive } from '../src/deriv/schema-archive.js';
import { DERIV_BATCH_OPERATIONS } from '../src/deriv/schema-release.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';

// Los perfiles y las peticiones de los lotes del PR 5a de ADR-0021 §9 (§3). El oráculo de las listas
// es la medición del canal público de Deriv, sin cuenta, del 2026-11-25 (PR 4b y PR 5a), escrita
// aquí a mano. Sin red: los esquemas de petición son los sintéticos de `deriv-fixtures.ts`, con las
// formas de la release fijada, y las respuestas, sintéticas.

const SHA256 = /^[0-9a-f]{64}$/u;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Lo que aceptó `proposal` el 2026-11-25, por mercado: multiplicadores y duraciones de sube/baja. */
const MEASURED = {
  R_100: {
    durations: ['5t', '15s', '1m', '5m', '15m', '60m', '240m'],
    multipliers: [40, 100, 200, 300, 400],
  },
  cryBTCUSD: { durations: [], multipliers: [50, 100, 150, 200, 300] },
  cryETHUSD: { durations: [], multipliers: [50, 100, 150, 200] },
  frxEURUSD: { durations: ['15m', '60m', '240m'], multipliers: [50, 100, 150, 250, 500] },
  frxGBPUSD: { durations: ['15m', '60m', '240m'], multipliers: [50, 100, 150, 250, 500] },
  frxUSDJPY: { durations: ['15m', '60m', '240m'], multipliers: [50, 100, 150, 250, 500] },
  frxXAGUSD: { durations: ['5m', '15m', '60m', '240m'], multipliers: [50, 100, 150, 250, 500] },
  frxXAUUSD: { durations: ['5m', '15m', '60m', '240m'], multipliers: [50, 100, 150, 250, 500] },
} as const;

const REAL_MARKETS = [
  'cryBTCUSD',
  'cryETHUSD',
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'frxXAGUSD',
  'frxXAUUSD',
];

function batchSchemas() {
  const { archive, expected } = syntheticSchemaArchive({}, DERIV_BATCH_OPERATIONS);
  const result = openSchemaArchive(archive, expected, DERIV_BATCH_OPERATIONS);
  if (result.status !== 'loaded') {
    throw new TypeError(`Carga fallida: ${result.reason}`);
  }
  return result.schemas;
}

let sequence = 0;
/** Un frame durable de la respuesta, con su texto exacto. */
function frame(text: string): RawSourceFrame {
  sequence += 1;
  return rawSourceFrameSchema.parse({
    connection_id: '019b76da-a800-7000-8000-00000000c000',
    connector_version: DERIV_BATCH_CONNECTOR_VERSION,
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${String(sequence).padStart(12, '0')}`,
    payload_utf8: text,
    raw_payload_sha256: sha256(text),
    received_at_utc: '2026-11-26T12:00:00.250Z',
    schema_version: '1.0.0',
    source: 'deriv_options',
  });
}
const accept = { validate: () => true };

describe('perfiles de los lotes (ADR-0021 §3)', () => {
  it('cada perfil es de la fuente, con las reglas de los lotes 4.0.0 y su propio identificador', () => {
    const profiles = [derivSchedulesProfile(), derivQuotesProfile(), derivCandlesProfile()];
    expect(profiles.map((profile) => profile.profile_id)).toEqual([
      'deriv_options-lotes-v1-horarios',
      'deriv_options-lotes-v1-cotizaciones',
      'deriv_options-lotes-v1-velas',
    ]);
    for (const profile of profiles) {
      expect(profile.source).toBe('deriv_options');
      expect(profile.quality_rule_version).toBe('4.0.0');
    }
    expect(BATCH_RULE_SET.quality_rule_version).toBe('4.0.0');
    expect(DERIV_BATCH_CONNECTOR_VERSION).toBe('deriv-options-lotes-1.0.0');
  });

  it('las cotizaciones piden lo medido: 10 USD y, por mercado, sus multiplicadores y duraciones', () => {
    const profile = derivQuotesProfile();
    expect(profile).toMatchObject({ currency: 'USD', interval_minutes: 30, stake: '10' });
    const measured = Object.fromEntries(
      profile.markets.map((market) => [
        market.symbol,
        {
          durations: market.durations.map((d) => `${String(d.duration)}${d.duration_unit}`),
          multipliers: market.multipliers,
        },
      ]),
    );
    expect(measured).toEqual(MEASURED);
    // En orden de símbolo, en unidades UTF-16.
    expect(profile.markets.map((market) => market.symbol)).toEqual(Object.keys(MEASURED));
  });

  it('los horarios piden los ocho mercados de las cotizaciones y el día siguiente', () => {
    expect(derivSchedulesProfile()).toMatchObject({
      days_ahead: 1,
      symbols: Object.keys(MEASURED),
    });
  });

  it('las velas son de 1 minuto, de los siete mercados reales, en páginas de 12 horas', () => {
    expect(derivCandlesProfile()).toMatchObject({
      count: 1000,
      granularity_seconds: 60,
      page_seconds: 43_200,
      symbols: REAL_MARKETS,
    });
  });

  it('la fila de cada log lleva el SHA-256 del JCS de su perfil, que solo cambia con el perfil', () => {
    for (const kind of ['candles', 'quotes', 'schedules'] as const) {
      const row = derivBatchLogProfileRow(kind);
      const text = new TextDecoder().decode(batchProfileBytes(kind));
      expect(row.quality_profile_sha256).toMatch(SHA256);
      expect(row.quality_profile_sha256).toBe(sha256(text));
      // JCS: sin espacios y con las claves en orden.
      expect(text.startsWith('{"')).toBe(true);
      expect(text).not.toMatch(/\s/u);
    }
    expect(derivBatchLogProfileRow('quotes').profile_id).toBe(
      'deriv_options-lotes-v1-cotizaciones',
    );
    // Fijados: cambiar un perfil sin cambiar su `profile_id` haría fallar esta prueba.
    expect({
      candles: derivBatchLogProfileRow('candles').quality_profile_sha256,
      quotes: derivBatchLogProfileRow('quotes').quality_profile_sha256,
      schedules: derivBatchLogProfileRow('schedules').quality_profile_sha256,
    }).toMatchInlineSnapshot(`
      {
        "candles": "cfd28f452e86d54ec22e908a761ff6e53163bdbf1bcd14332941ce326dc3bbec",
        "quotes": "b678115c46608d9547349647cfdaca4a11f975bb68405a905ddd07237c8c71ad",
        "schedules": "ef33c15d14efdb75c86a14b77bd504bdb57b3bb358ca2e9f0b45003be37121c7",
      }
    `);
  });
});

describe('peticiones de los lotes', () => {
  const schemas = batchSchemas();

  it('una vuelta de cotizaciones son las 126 peticiones del perfil, en orden', () => {
    const requests = quoteRequests(derivQuotesProfile());
    expect(requests).toHaveLength(126);
    expect(requests.slice(0, 2)).toEqual([
      {
        contract_type: 'MULTUP',
        multiplier: 40,
        operation: 'proposal',
        stake: 10,
        symbol: 'R_100',
      },
      {
        contract_type: 'MULTUP',
        multiplier: 100,
        operation: 'proposal',
        stake: 10,
        symbol: 'R_100',
      },
    ]);
    expect(requests[10]).toEqual({
      contract_type: 'CALL',
      duration: { duration: 5, duration_unit: 't' },
      operation: 'proposal',
      stake: 10,
      symbol: 'R_100',
    });
    expect(requests.at(-1)).toEqual({
      contract_type: 'PUT',
      duration: { duration: 240, duration_unit: 'm' },
      operation: 'proposal',
      stake: 10,
      symbol: 'frxXAUUSD',
    });
    const perMarket = new Map<string, number>();
    for (const request of requests) {
      if (request.operation === 'proposal') {
        perMarket.set(request.symbol, (perMarket.get(request.symbol) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(perMarket)).toEqual({
      R_100: 24,
      cryBTCUSD: 10,
      cryETHUSD: 8,
      frxEURUSD: 16,
      frxGBPUSD: 16,
      frxUSDJPY: 16,
      frxXAGUSD: 18,
      frxXAUUSD: 18,
    });
  });

  it('rechaza una apuesta que no es un entero positivo o en otra moneda', () => {
    const profile = derivQuotesProfile();
    for (const stake of ['0', '10.5', '-10', '1e1', '010']) {
      expect(() => quoteRequests({ ...profile, stake }), stake).toThrow(TypeError);
    }
    expect(() => quoteRequests({ ...profile, currency: 'EUR' })).toThrow(TypeError);
  });

  it('los horarios de un día piden su trading_times y el del día siguiente, el catálogo y cada contracts_for', () => {
    const requests = scheduleRequests(derivSchedulesProfile(), '2026-11-30');
    expect(requests).toEqual([
      { date: '2026-11-30', operation: 'trading_times' },
      { date: '2026-12-01', operation: 'trading_times' },
      { operation: 'active_symbols' },
      ...Object.keys(MEASURED).map((symbol) => ({ operation: 'contracts_for', symbol })),
    ]);
    // El último día del año pasa al año siguiente.
    expect(scheduleRequests(derivSchedulesProfile(), '2026-12-31')[1]).toEqual({
      date: '2027-01-01',
      operation: 'trading_times',
    });
  });

  it('las velas de un día son dos páginas por mercado, contiguas, de las 00:00:00 a las 23:59:59', () => {
    const day = Date.UTC(2026, 10, 25) / 1000;
    const requests = candleRequests(derivCandlesProfile(), '2026-11-25');
    expect(requests).toHaveLength(14);
    expect(requests.slice(0, 2)).toEqual([
      {
        count: 1000,
        end: day + 43_199,
        granularity: 60,
        operation: 'ticks_history',
        start: day,
        symbol: 'cryBTCUSD',
      },
      {
        count: 1000,
        end: day + 86_399,
        granularity: 60,
        operation: 'ticks_history',
        start: day + 43_200,
        symbol: 'cryBTCUSD',
      },
    ]);
    expect(
      requests.map((request) => (request.operation === 'ticks_history' ? request.symbol : null)),
    ).toEqual(REAL_MARKETS.flatMap((symbol) => [symbol, symbol]));
  });

  it('rechaza velas que no son de 60 s, que las reglas 4.0.0 no reconocen', () => {
    const profile = derivCandlesProfile();
    for (const granularity_seconds of [120, 300]) {
      expect(() => candleRequests({ ...profile, granularity_seconds }, '2026-11-25')).toThrow(
        TypeError,
      );
    }
  });

  it('rechaza páginas que no parten el día en velas enteras o que no caben en una página', () => {
    const profile = derivCandlesProfile();
    // Cada una rompe una sola condición: no es positiva, no parte el día, no es de velas enteras o
    // no cabe en una página.
    for (const page_seconds of [-43_200, 36_000, 3_456, 86_400]) {
      expect(
        () => candleRequests({ ...profile, page_seconds }, '2026-11-25'),
        String(page_seconds),
      ).toThrow(TypeError);
    }
  });

  it('solo admite días UTC reales AAAA-MM-DD', () => {
    expect(dayStartEpoch('2026-11-25')).toBe(Date.UTC(2026, 10, 25) / 1000);
    expect(dayStartEpoch('2028-02-29')).toBe(Date.UTC(2028, 1, 29) / 1000);
    for (const date of [
      '2026-02-30',
      '2026-11-5',
      'today',
      '2026-13-01',
      '2026-11-25T00:00:00Z',
      '',
    ]) {
      expect(() => dayStartEpoch(date), date).toThrow(TypeError);
      expect(() => scheduleRequests(derivSchedulesProfile(), date), date).toThrow(TypeError);
    }
  });

  it('cada petición cumple su esquema de petición y espera su respuesta', () => {
    const requests: BatchRequest[] = [
      ...scheduleRequests(derivSchedulesProfile(), '2026-11-25'),
      ...quoteRequests(derivQuotesProfile()),
      ...candleRequests(derivCandlesProfile(), '2026-11-24'),
    ];
    expect(requests).toHaveLength(11 + 126 + 14);
    for (const [index, request] of requests.entries()) {
      const text = encodeBatchRequest(schemas, request, index + 1);
      expect(text, JSON.stringify(request)).not.toBeNull();
      expect(JSON.parse(text ?? 'null')).toEqual(batchRequestBody(request, index + 1));
    }
    expect(EXPECTED_BATCH_MSG_TYPE).toEqual({
      active_symbols: 'active_symbols',
      contracts_for: 'contracts_for',
      proposal: 'proposal',
      ticks_history: 'candles',
      trading_times: 'trading_times',
    });
  });

  it('una petición que su esquema rechaza no se envía', () => {
    const bad = encodeBatchRequest(schemas, { operation: 'contracts_for', symbol: 'no válido' }, 1);
    expect(bad).toBeNull();
  });

  it('los cuerpos son los que esperan las reglas, con los campos en el orden del JCS', () => {
    expect(batchRequestBody({ operation: 'trading_times', date: '2026-11-25' }, 1)).toEqual({
      req_id: 1,
      trading_times: '2026-11-25',
    });
    expect(
      batchRequestBody(
        {
          contract_type: 'MULTDOWN',
          multiplier: 50,
          operation: 'proposal',
          stake: 10,
          symbol: 'frxXAUUSD',
        },
        2,
      ),
    ).toEqual({
      amount: 10,
      basis: 'stake',
      contract_type: 'MULTDOWN',
      currency: 'USD',
      multiplier: 50,
      proposal: 1,
      req_id: 2,
      underlying_symbol: 'frxXAUUSD',
    });
  });
});

describe('las respuestas a estas peticiones dan sus registros con las reglas 4.0.0', () => {
  const SPOT = '1795694400';

  it('una cotización de cada clase es del paso de los lotes', () => {
    const [multiplier] = quoteRequests(derivQuotesProfile());
    const callput = quoteRequests(derivQuotesProfile()).find(
      (request) => request.operation === 'proposal' && 'duration' in request,
    );
    if (multiplier === undefined || callput === undefined) {
      throw new TypeError('faltan peticiones');
    }
    const fields = {
      multiplier: `"ask_price":10.00,"commission":0.20,"date_start":${SPOT},"id":"x","longcode":"x","multiplier":40,"payout":0,"spot":100.25,"spot_time":${SPOT}`,
      callput: `"ask_price":10.00,"date_expiry":1795694700,"date_start":${SPOT},"id":"x","longcode":"x","payout":18.50,"spot":100.25,"spot_time":${SPOT}`,
    };
    for (const [request, body] of [
      [multiplier, fields.multiplier],
      [callput, fields.callput],
    ] as const) {
      const echo = JSON.stringify(batchRequestBody(request, 3));
      const result = deriveContractQuote(
        frame(`{"echo_req":${echo},"msg_type":"proposal","proposal":{${body}},"req_id":3}`),
        accept,
      );
      expect(result.incidents, echo).toEqual([]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ stake_decimal: '10', symbol: 'R_100' });
    }
  });

  it('cada una de las 151 peticiones de un día da su registro, sin incidencias', () => {
    let records = 0;
    for (const request of quoteRequests(derivQuotesProfile())) {
      if (request.operation !== 'proposal') {
        throw new TypeError('se esperaba proposal');
      }
      const echo = JSON.stringify(batchRequestBody(request, 3));
      const body =
        'multiplier' in request
          ? `"ask_price":10.00,"commission":0.20,"date_start":${SPOT},"id":"x","longcode":"x","multiplier":${String(request.multiplier)},"payout":0,"spot":1.25,"spot_time":${SPOT}`
          : `"ask_price":10.00,"date_expiry":1795694700,"date_start":${SPOT},"id":"x","longcode":"x","payout":18.50,"spot":1.25,"spot_time":${SPOT}`;
      const result = deriveContractQuote(
        frame(`{"echo_req":${echo},"msg_type":"proposal","proposal":{${body}},"req_id":3}`),
        accept,
      );
      expect(result.incidents, echo).toEqual([]);
      expect(result.records, echo).toMatchObject([{ stake_decimal: '10', symbol: request.symbol }]);
      records += result.records.length;
    }
    for (const page of candleRequests(derivCandlesProfile(), '2026-11-24')) {
      if (page.operation !== 'ticks_history') {
        throw new TypeError('se esperaba ticks_history');
      }
      const echo = JSON.stringify(batchRequestBody(page, 7));
      const candles = [page.start, page.end - 59]
        .map(
          (epoch) => `{"close":2.50,"epoch":${String(epoch)},"high":2.75,"low":2.25,"open":2.40}`,
        )
        .join(',');
      const result = deriveMarketCandles(
        frame(
          `{"candles":[${candles}],"echo_req":${echo},"msg_type":"candles","pip_size":2,"req_id":7}`,
        ),
        accept,
      );
      expect(result.incidents, echo).toEqual([]);
      expect(result.records, echo).toHaveLength(2);
      records += 1;
    }
    for (const request of scheduleRequests(derivSchedulesProfile(), '2026-11-25')) {
      const echo = JSON.stringify(batchRequestBody(request, 1));
      if (request.operation === 'trading_times') {
        const result = deriveTradingSessions(
          frame(
            `{"echo_req":${echo},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":["21:00:00"],"open":["01:00:00"]},"underlying_symbol":"frxXAUUSD"}]}]}]}}`,
          ),
          accept,
          derivSchedulesProfile().symbols,
        );
        expect(result.incidents, echo).toEqual([]);
        expect(result.records, echo).toMatchObject([{ trading_date: request.date }]);
      } else if (request.operation === 'contracts_for') {
        const result = deriveContractOffer(
          frame(
            `{"contracts_for":{"available":[{"contract_category":"multiplier","contract_type":"MULTUP","expiry_type":"no_expiry","underlying_symbol":"${request.symbol}"}]},"echo_req":${echo},"msg_type":"contracts_for","req_id":1}`,
          ),
          accept,
        );
        expect(result.incidents, echo).toEqual([]);
        expect(result.records, echo).toMatchObject([{ symbol: request.symbol }]);
      } else {
        // `active_symbols`, el catálogo de los lotes, no da registro (reglas 4.0.0, «Un log»).
        expect(request).toEqual({ operation: 'active_symbols' });
      }
      records += 1;
    }
    expect(records).toBe(151);
  });

  it('el rechazo de un multiplicador pedido es contract_rejected', () => {
    const request = quoteRequests(derivQuotesProfile())[0];
    if (request === undefined) {
      throw new TypeError('falta la petición');
    }
    const echo = JSON.stringify(batchRequestBody(request, 4));
    const result = deriveContractQuote(
      frame(
        `{"echo_req":${echo},"error":{"code":"ContractBuyValidationError","details":{"field":"multiplier"},"message":"x"},"msg_type":"proposal","req_id":4}`,
      ),
      accept,
    );
    expect(result.records).toEqual([]);
    expect(result.incidents.map((incident) => incident.incident_type)).toEqual([
      'contract_rejected',
    ]);
  });

  it('una página de velas pedida da sus velas, y el horario y los contratos, su día y su símbolo', () => {
    const [page] = candleRequests(derivCandlesProfile(), '2026-11-24');
    if (page?.operation !== 'ticks_history') {
      throw new TypeError('falta la página');
    }
    const echo = JSON.stringify(batchRequestBody(page, 7));
    const candle = `{"close":2.50,"epoch":${String(page.start)},"high":2.75,"low":2.25,"open":2.40}`;
    const candles = deriveMarketCandles(
      frame(
        `{"candles":[${candle}],"echo_req":${echo},"msg_type":"candles","pip_size":2,"req_id":7}`,
      ),
      accept,
    );
    expect(candles.incidents).toEqual([]);
    expect(candles.records).toHaveLength(1);
    expect(candles.records[0]).toMatchObject({ symbol: 'cryBTCUSD' });

    const times = JSON.stringify(
      batchRequestBody({ date: '2026-11-26', operation: 'trading_times' }, 1),
    );
    const sessions = deriveTradingSessions(
      frame(
        `{"echo_req":${times},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":["21:00:00"],"open":["01:00:00"]},"underlying_symbol":"frxXAUUSD"}]}]}]}}`,
      ),
      accept,
      derivSchedulesProfile().symbols,
    );
    expect(sessions.incidents).toEqual([]);
    expect(sessions.records).toMatchObject([{ symbol: 'frxXAUUSD', trading_date: '2026-11-26' }]);

    const offerEcho = JSON.stringify(
      batchRequestBody({ operation: 'contracts_for', symbol: 'cryETHUSD' }, 2),
    );
    const offer = deriveContractOffer(
      frame(
        `{"contracts_for":{"available":[{"contract_category":"multiplier","contract_type":"MULTUP","expiry_type":"no_expiry","underlying_symbol":"cryETHUSD"}]},"echo_req":${offerEcho},"msg_type":"contracts_for","req_id":2}`,
      ),
      accept,
    );
    expect(offer.incidents).toEqual([]);
    expect(offer.records).toMatchObject([{ symbol: 'cryETHUSD' }]);
  });
});
