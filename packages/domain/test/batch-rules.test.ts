import { createHash } from 'node:crypto';

import {
  canonicalJson,
  dataQualityIncidentSchema,
  deriveEventId,
  rawSourceFrameSchema,
  type RawSourceFrame,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendSegmentStats,
  BATCH_RULE_SET,
  BATCH_SEGMENT_POLICY,
  compareBatchRecords,
  deriveContractOffer,
  deriveContractQuote,
  deriveTradingSessions,
  EMPTY_SEGMENT_STATS,
  evaluateSegmentRotation,
  SEGMENT_POLICY,
  type SegmentStats,
} from '../src/index.js';

// Vector sintético de las reglas de los lotes 4.0.0 (ADR-0021 §3 y §4; ADR-0024 §4; contratos de
// dominio, «Semántica ejecutable de las reglas de los lotes 4.0.0»): horarios, contratos y
// cotizaciones, y la política de segmentos 2.0.0. Las formas de las respuestas son las medidas el
// 2026-11-25 en el canal público de Deriv; los precios y los importes son sintéticos, y el símbolo
// `SYNTH_GOLD` no existe. Las expectativas salen de las reglas, escritas a mano.

const CONNECTION = '019b76da-a800-7000-8000-00000000b000';
const CONNECTOR = 'deriv-options-lotes-1.0.0';
let sequence = 0;

/** Un frame durable con su payload exacto y su hash. */
function frame(payload: unknown, received = '2026-11-25T12:00:00.250Z'): RawSourceFrame {
  sequence += 1;
  const text = JSON.stringify(payload);
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: CONNECTOR,
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${String(sequence).padStart(12, '0')}`,
    payload_utf8: text,
    raw_payload_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    received_at_utc: received,
    schema_version: '1.0.0',
    source: 'deriv_options',
  });
}

const accept = { validate: () => true };
const reject = { validate: () => false };

/** La incidencia que esperan las reglas 4.0.0, armada aquí con su ID, sin el código del dominio. */
function expectedIncident(
  source: RawSourceFrame,
  incident: {
    incident_type: string;
    severity: string;
    symbol: string | null;
    evidence: Record<string, string>;
  },
) {
  const body = {
    ...incident,
    observed_at_utc: source.received_at_utc,
    observed_ref: source.observation_id,
    quality_rule_version: '4.0.0',
    related_refs: [],
    schema_version: '3.0.0',
    source: 'deriv_options',
  };
  return dataQualityIncidentSchema.parse({ ...body, incident_id: deriveEventId(body) });
}

const invalidOf = (source: RawSourceFrame, reason: string, symbol: string | null) =>
  expectedIncident(source, {
    evidence: { raw_payload_sha256: source.raw_payload_sha256, reason },
    incident_type: 'invalid_source_frame',
    severity: 'error',
    symbol,
  });

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

// Las guardas se ponen después de armar los frames de cada prueba: `rawSourceFrameSchema` no usa
// reloj ni azar, pero así nada de la preparación las esquiva.
beforeEach(() => {
  sequence = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conjunto de reglas de los lotes', () => {
  it('es el 4.0.0, con el esquema de incidencias 3.0.0', () => {
    expect(BATCH_RULE_SET).toEqual({
      incident_schema_version: '3.0.0',
      quality_rule_version: '4.0.0',
    });
  });
});

// --- trading_times -----------------------------------------------------------------------------

const symbolEntry = (symbol: string, open: string[], close: string[]) => ({
  name: symbol,
  times: { close, open, settlement: '23:59:59' },
  trading_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  underlying_symbol: symbol,
});

const tradingTimes = (date: string, symbols: object[]) => ({
  echo_req: { req_id: 1, trading_times: date },
  msg_type: 'trading_times',
  req_id: 1,
  trading_times: { markets: [{ name: 'Synthetic', submarkets: [{ name: 'All', symbols }] }] },
});

const day = (time: string) => `2026-11-25T${time}.000Z`;
const NEXT_DAY = '2026-11-26T00:00:00.000Z';

describe('trading_times', () => {
  it('da un horario por símbolo pedido, con el cierre 23:59:59 como fin del día', () => {
    const source = frame(
      tradingTimes('2026-11-25', [
        symbolEntry('SYNTH_GOLD', ['00:00:00', '23:00:00'], ['22:00:00', '23:59:59']),
        symbolEntry('SYNTH_100', ['00:00:00'], ['23:59:59']),
        symbolEntry('SYNTH_EARLY', ['00:00:00'], ['16:30:00']),
        symbolEntry('SYNTH_OTHER', ['00:00:00'], ['23:59:59']),
      ]),
    );
    forbidAmbientEffects();
    const result = deriveTradingSessions(source, accept, [
      'SYNTH_GOLD',
      'SYNTH_EARLY',
      'SYNTH_100',
      'SYNTH_GOLD',
    ]);
    const common = {
      connector_version: CONNECTOR,
      observation_id: source.observation_id,
      raw_payload_sha256: source.raw_payload_sha256,
      received_at_utc: source.received_at_utc,
      schema_version: '1.0.0',
      source: 'deriv_options',
      trading_date: '2026-11-25',
    };
    expect(result.incidents).toEqual([]);
    expect(result.records).toEqual([
      {
        ...common,
        intervals: [{ closes_at_utc: NEXT_DAY, opens_at_utc: day('00:00:00') }],
        symbol: 'SYNTH_100',
      },
      {
        ...common,
        intervals: [{ closes_at_utc: day('16:30:00'), opens_at_utc: day('00:00:00') }],
        symbol: 'SYNTH_EARLY',
      },
      {
        ...common,
        intervals: [
          { closes_at_utc: day('22:00:00'), opens_at_utc: day('00:00:00') },
          { closes_at_utc: NEXT_DAY, opens_at_utc: day('23:00:00') },
        ],
        symbol: 'SYNTH_GOLD',
      },
    ]);
  });

  it('da un día sin intervalos con -- y une dos intervalos que se tocan', () => {
    const source = frame(
      tradingTimes('2026-11-28', [
        symbolEntry('SYNTH_GOLD', ['--'], ['--']),
        symbolEntry('SYNTH_SPLIT', ['00:00:00', '12:00:00'], ['12:00:00', '23:59:59']),
      ]),
    );
    forbidAmbientEffects();
    const result = deriveTradingSessions(source, accept, ['SYNTH_GOLD', 'SYNTH_SPLIT']);
    expect(result.records.map((record) => [record.symbol, record.intervals])).toEqual([
      ['SYNTH_GOLD', []],
      [
        'SYNTH_SPLIT',
        [{ closes_at_utc: '2026-11-29T00:00:00.000Z', opens_at_utc: '2026-11-28T00:00:00.000Z' }],
      ],
    ]);
  });

  it('no da registro ni incidencia para un símbolo que Deriv no trae', () => {
    const source = frame(
      tradingTimes('2026-11-25', [symbolEntry('SYNTH_100', ['00:00:00'], ['23:59:59'])]),
    );
    forbidAmbientEffects();
    const result = deriveTradingSessions(source, accept, ['SYNTH_100', 'SYNTH_GOLD']);
    expect(result.records.map((record) => record.symbol)).toEqual(['SYNTH_100']);
    expect(result.incidents).toEqual([]);
  });

  it('da trading_times_inconsistent por símbolo y sigue con los demás', () => {
    const cases: [string, object][] = [
      ['SYNTH_HOUR', symbolEntry('SYNTH_HOUR', ['00:00:00'], ['24:00:00'])],
      ['SYNTH_LENGTH', symbolEntry('SYNTH_LENGTH', ['00:00:00', '23:00:00'], ['22:00:00'])],
      [
        'SYNTH_ORDER',
        symbolEntry('SYNTH_ORDER', ['23:00:00', '00:00:00'], ['23:59:59', '22:00:00']),
      ],
      [
        'SYNTH_OVERLAP',
        symbolEntry('SYNTH_OVERLAP', ['00:00:00', '21:00:00'], ['22:00:00', '23:59:59']),
      ],
      ['SYNTH_EMPTY', symbolEntry('SYNTH_EMPTY', ['10:00:00'], ['10:00:00'])],
      // Un intervalo vacío detrás de otro que termina a su hora no se pierde al unirlos.
      [
        'SYNTH_DEGENERATE',
        symbolEntry('SYNTH_DEGENERATE', ['00:00:00', '10:00:00'], ['10:00:00', '10:00:00']),
      ],
      ['SYNTH_EXTRA', symbolEntry('SYNTH_EXTRA', ['00:00:00'], ['22:00:00', '23:59:59'])],
      ['SYNTH_HALF', symbolEntry('SYNTH_HALF', ['--'], ['23:59:59'])],
      ['SYNTH_DASHES', symbolEntry('SYNTH_DASHES', ['--', '--'], ['--', '--'])],
      // Unas listas vacías no son un día cerrado: borrarían un horario bueno del mismo día.
      ['SYNTH_NONE', symbolEntry('SYNTH_NONE', [], [])],
      ['SYNTH_NOTIMES', { name: 'x', underlying_symbol: 'SYNTH_NOTIMES' }],
    ];
    const good = symbolEntry('SYNTH_100', ['00:00:00'], ['23:59:59']);
    const twice = symbolEntry('SYNTH_TWICE', ['00:00:00'], ['23:59:59']);
    const source = frame(
      tradingTimes('2026-11-25', [good, twice, twice, ...cases.map(([, entry]) => entry)]),
    );
    const symbols = ['SYNTH_100', 'SYNTH_TWICE', ...cases.map(([symbol]) => symbol)];
    forbidAmbientEffects();
    const result = deriveTradingSessions(source, accept, symbols);
    expect(result.records.map((record) => record.symbol)).toEqual(['SYNTH_100']);
    const inconsistent = [...cases.map(([symbol]) => symbol), 'SYNTH_TWICE'].sort();
    expect(result.incidents).toEqual(
      inconsistent.map((symbol) => invalidOf(source, 'trading_times_inconsistent', symbol)),
    );
  });

  it('da una sola incidencia sin símbolo con un error, el esquema o un día que no es una fecha', () => {
    const error = frame({
      echo_req: { req_id: 1, trading_times: '2026-13-01' },
      error: { code: 'InvalidDateFormat', message: 'synthetic' },
      msg_type: 'trading_times',
      req_id: 1,
    });
    const schema = frame(tradingTimes('2026-11-25', []));
    const today = frame(
      tradingTimes('today', [symbolEntry('SYNTH_100', ['00:00:00'], ['23:59:59'])]),
    );
    const shortDate = frame(tradingTimes('2026-1-5', []));
    const impossible = frame(tradingTimes('2026-02-30', []));
    forbidAmbientEffects();
    expect(deriveTradingSessions(error, accept, ['SYNTH_100'])).toEqual({
      incidents: [invalidOf(error, 'source_error_response', null)],
      records: [],
    });
    expect(deriveTradingSessions(schema, reject, ['SYNTH_100']).incidents).toEqual([
      invalidOf(schema, 'schema_validation_failed', null),
    ]);
    expect(deriveTradingSessions(today, accept, ['SYNTH_100']).incidents).toEqual([
      invalidOf(today, 'trading_date_unknown', null),
    ]);
    expect(deriveTradingSessions(shortDate, accept, ['SYNTH_100']).incidents).toEqual([
      invalidOf(shortDate, 'trading_date_unknown', null),
    ]);
    expect(deriveTradingSessions(impossible, accept, ['SYNTH_100']).incidents).toEqual([
      invalidOf(impossible, 'trading_date_unknown', null),
    ]);
  });

  it('lanza con un frame que no es JSON o que responde a otra operación', () => {
    const notJson = rawSourceFrameSchema.parse({
      ...frame({}),
      payload_utf8: '{',
      raw_payload_sha256: createHash('sha256').update('{', 'utf8').digest('hex'),
    });
    const other = frame({ echo_req: { proposal: 1 }, msg_type: 'proposal' });
    expect(() => deriveTradingSessions(notJson, accept, [])).toThrow(TypeError);
    expect(() => deriveTradingSessions(other, accept, [])).toThrow(TypeError);
  });
});

// --- contracts_for -----------------------------------------------------------------------------

const entry = (
  contract_type: string,
  contract_category: string,
  expiry_type: string,
  min: string,
  max: string,
) => ({
  barrier: expiry_type === 'no_expiry' ? undefined : '+0.00',
  barriers: expiry_type === 'no_expiry' ? 0 : 1,
  contract_category,
  contract_type,
  expiry_type,
  market: 'synthetic_index',
  max_contract_duration: max,
  min_contract_duration: min,
  sentiment: 'up',
  submarket: 'random_index',
  underlying_symbol: 'SYNTH_100',
});
const contractsFor = (available: object[], symbol = 'SYNTH_100') => ({
  contracts_for: { available, hit_count: available.length },
  echo_req: { contracts_for: symbol, req_id: 2 },
  msg_type: 'contracts_for',
  req_id: 2,
});
const R100_ENTRIES = [
  entry('CALL', 'callput', 'daily', '1d', '365d'),
  entry('PUT', 'callput', 'daily', '1d', '365d'),
  entry('CALL', 'callput', 'intraday', '15s', '1d'),
  entry('PUT', 'callput', 'intraday', '15s', '1d'),
  entry('CALL', 'callput', 'tick', '1t', '10t'),
  entry('PUT', 'callput', 'tick', '1t', '10t'),
  { ...entry('MULTUP', 'multiplier', 'no_expiry', '0', '0'), multiplier_range: [40, 100] },
  { ...entry('MULTDOWN', 'multiplier', 'no_expiry', '0', '0'), multiplier_range: [40, 100] },
  entry('ACCU', 'accumulator', 'tick', '1t', '10t'),
  entry('DIGITDIFF', 'digits', 'tick', '1t', '10t'),
  entry('HIGHER', 'callput', 'intraday', '15s', '1d'),
];

describe('contracts_for', () => {
  it('da los cuatro tipos de buoh en orden, con sus duraciones y sin multiplicadores', () => {
    const source = frame(contractsFor(R100_ENTRIES));
    forbidAmbientEffects();
    const result = deriveContractOffer(source, accept);
    const span = (min: [number, string], max: [number, string]) => ({
      max_contract_duration: { duration: max[0], duration_unit: max[1] },
      min_contract_duration: { duration: min[0], duration_unit: min[1] },
    });
    expect(result.incidents).toEqual([]);
    expect(result.records).toEqual([
      {
        connector_version: CONNECTOR,
        observation_id: source.observation_id,
        offers: [
          {
            contract_category: 'callput',
            contract_type: 'CALL',
            expiry_type: 'daily',
            ...span([1, 'd'], [365, 'd']),
          },
          {
            contract_category: 'callput',
            contract_type: 'CALL',
            expiry_type: 'intraday',
            ...span([15, 's'], [1, 'd']),
          },
          {
            contract_category: 'callput',
            contract_type: 'CALL',
            expiry_type: 'tick',
            ...span([1, 't'], [10, 't']),
          },
          { contract_category: 'multiplier', contract_type: 'MULTDOWN', expiry_type: 'no_expiry' },
          { contract_category: 'multiplier', contract_type: 'MULTUP', expiry_type: 'no_expiry' },
          {
            contract_category: 'callput',
            contract_type: 'PUT',
            expiry_type: 'daily',
            ...span([1, 'd'], [365, 'd']),
          },
          {
            contract_category: 'callput',
            contract_type: 'PUT',
            expiry_type: 'intraday',
            ...span([15, 's'], [1, 'd']),
          },
          {
            contract_category: 'callput',
            contract_type: 'PUT',
            expiry_type: 'tick',
            ...span([1, 't'], [10, 't']),
          },
        ],
        raw_payload_sha256: source.raw_payload_sha256,
        received_at_utc: source.received_at_utc,
        schema_version: '1.0.0',
        source: 'deriv_options',
        symbol: 'SYNTH_100',
      },
    ]);
  });

  it('da offers vacía si el mercado no ofrece ninguno de los cuatro', () => {
    const source = frame(contractsFor([entry('ACCU', 'accumulator', 'tick', '1t', '10t')]));
    forbidAmbientEffects();
    expect(deriveContractOffer(source, accept).records.map((record) => record.offers)).toEqual([
      [],
    ]);
  });

  it('no da registro con una pareja repetida o una entrada incoherente de los cuatro', () => {
    const duplicate = frame(
      contractsFor([...R100_ENTRIES, entry('CALL', 'callput', 'intraday', '5m', '1d')]),
    );
    const incoherent = [
      entry('CALL', 'callput', 'intraday', '5x', '1d'),
      entry('CALL', 'multiplier', 'intraday', '15s', '1d'),
      entry('MULTUP', 'multiplier', 'intraday', '0', '0'),
      entry('CALL', 'callput', 'no_expiry', '15s', '1d'),
      entry('CALL', 'callput', 'intraday', '1d', '15s'),
      entry('CALL', 'callput', 'tick', '1s', '10s'),
      { ...entry('CALL', 'callput', 'intraday', '15s', '1d'), underlying_symbol: 'SYNTH_GOLD' },
    ].map((bad) => frame(contractsFor([R100_ENTRIES[0] as object, bad])));
    const missing = frame({ ...contractsFor([]), contracts_for: { hit_count: 0 } });
    forbidAmbientEffects();
    expect(deriveContractOffer(duplicate, accept)).toEqual({
      incidents: [invalidOf(duplicate, 'contracts_for_duplicate_entry', 'SYNTH_100')],
      records: [],
    });
    for (const source of [...incoherent, missing]) {
      expect(deriveContractOffer(source, accept)).toEqual({
        incidents: [invalidOf(source, 'contracts_for_inconsistent', 'SYNTH_100')],
        records: [],
      });
    }
  });

  it('da el error y el esquema con el símbolo pedido', () => {
    const error = frame({
      echo_req: { contracts_for: 'SYNTH_100', req_id: 2 },
      error: { code: 'InvalidSymbol', message: 'synthetic' },
      msg_type: 'contracts_for',
      req_id: 2,
    });
    const schema = frame(contractsFor(R100_ENTRIES));
    forbidAmbientEffects();
    expect(deriveContractOffer(error, accept).incidents).toEqual([
      invalidOf(error, 'source_error_response', 'SYNTH_100'),
    ]);
    expect(deriveContractOffer(schema, reject).incidents).toEqual([
      invalidOf(schema, 'schema_validation_failed', 'SYNTH_100'),
    ]);
  });
});

// --- proposal ----------------------------------------------------------------------------------

const callRequest = {
  amount: 10,
  basis: 'stake',
  contract_type: 'CALL',
  currency: 'USD',
  duration: 15,
  duration_unit: 'm',
  proposal: 1,
  req_id: 3,
  underlying_symbol: 'SYNTH_GOLD',
};
const multRequest = {
  amount: 10,
  basis: 'stake',
  contract_type: 'MULTUP',
  currency: 'USD',
  multiplier: 100,
  proposal: 1,
  req_id: 4,
  underlying_symbol: 'SYNTH_GOLD',
};
/** 2026-11-25T12:00:00Z en segundos. */
const SPOT_TIME = '1795608000';

/** Una respuesta con los números como lexemas exactos: `JSON.stringify` perdería `10.00`. */
function proposalText(request: object, fields: string): string {
  return `{"echo_req":${JSON.stringify(request)},"msg_type":"proposal","proposal":{${fields}},"req_id":3}`;
}
function textFrame(text: string): RawSourceFrame {
  sequence += 1;
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: CONNECTOR,
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${String(sequence).padStart(12, '0')}`,
    payload_utf8: text,
    raw_payload_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    received_at_utc: '2026-11-25T12:00:00.250Z',
    schema_version: '1.0.0',
    source: 'deriv_options',
  });
}
const CALL_FIELDS = `"ask_price":10.00,"date_expiry":1795608900,"date_start":${SPOT_TIME},"id":"x","longcode":"x","payout":18.50,"spot":100.25,"spot_time":${SPOT_TIME}`;
const MULT_FIELDS = `"ask_price":10.00,"commission":0.20,"date_start":${SPOT_TIME},"id":"x","longcode":"x","multiplier":100,"payout":0,"spot":100.25,"spot_time":${SPOT_TIME}`;

const rejection = (request: object, code: string, field?: string) =>
  frame({
    echo_req: request,
    error: { code, details: field === undefined ? undefined : { field }, message: 'synthetic' },
    msg_type: 'proposal',
    req_id: 4,
  });

describe('proposal', () => {
  it('da la cotización de un sube/baja y la de un multiplicador, con los lexemas exactos', () => {
    const call = textFrame(proposalText(callRequest, CALL_FIELDS));
    const mult = textFrame(proposalText(multRequest, MULT_FIELDS));
    forbidAmbientEffects();
    const common = (source: RawSourceFrame) => ({
      ask_price_decimal: '10.00',
      connector_version: CONNECTOR,
      currency: 'USD',
      observation_id: source.observation_id,
      quoted_at_utc: '2026-11-25T12:00:00.000Z',
      raw_payload_sha256: source.raw_payload_sha256,
      received_at_utc: source.received_at_utc,
      schema_version: '1.0.0',
      source: 'deriv_options',
      stake_decimal: '10',
      symbol: 'SYNTH_GOLD',
    });
    expect(deriveContractQuote(call, accept)).toEqual({
      incidents: [],
      records: [
        {
          ...common(call),
          contract_category: 'callput',
          contract_type: 'CALL',
          duration: { duration: 15, duration_unit: 'm' },
          payout_decimal: '18.50',
        },
      ],
    });
    expect(deriveContractQuote(mult, accept)).toEqual({
      incidents: [],
      records: [
        {
          ...common(mult),
          commission_decimal: '0.20',
          contract_category: 'multiplier',
          contract_type: 'MULTUP',
          multiplier_decimal: '100',
        },
      ],
    });
  });

  it('da contract_rejected con el contrato pedido solo cuando Deriv rechaza el multiplicador', () => {
    const rejected = rejection(
      { ...multRequest, multiplier: 200 },
      'ContractBuyValidationError',
      'multiplier',
    );
    forbidAmbientEffects();
    expect(deriveContractQuote(rejected, accept)).toEqual({
      incidents: [
        expectedIncident(rejected, {
          evidence: {
            contract_type: 'MULTUP',
            error_code: 'ContractBuyValidationError',
            multiplier_decimal: '200',
            raw_payload_sha256: rejected.raw_payload_sha256,
          },
          incident_type: 'contract_rejected',
          severity: 'info',
          symbol: 'SYNTH_GOLD',
        }),
      ],
      records: [],
    });
  });

  it('da source_error_response a los demás errores, que no son un rechazo', () => {
    const errors = [
      rejection(multRequest, 'RateLimit'),
      rejection(multRequest, 'MarketIsClosed'),
      rejection(multRequest, 'ContractBuyValidationError', 'amount'),
      rejection(callRequest, 'TradingDurationNotAllowed'),
      rejection(callRequest, 'ContractBuyValidationError', 'multiplier'),
      rejection({ ...multRequest, barrier: '+1' }, 'ContractBuyValidationError', 'multiplier'),
    ];
    forbidAmbientEffects();
    for (const source of errors) {
      expect(deriveContractQuote(source, accept)).toEqual({
        incidents: [invalidOf(source, 'source_error_response', 'SYNTH_GOLD')],
        records: [],
      });
    }
  });

  it('da proposal_request_unsupported con un contrato que no pide el paso de los lotes', () => {
    const withoutUnit: Record<string, unknown> = { ...callRequest };
    delete withoutUnit['duration_unit'];
    const requests = [
      { ...callRequest, barrier: '+1' },
      { ...callRequest, basis: 'payout' },
      { ...callRequest, currency: 'EUR' },
      { ...callRequest, contract_type: 'HIGHER' },
      { ...callRequest, duration: 0 },
      { ...callRequest, duration: 1.5 },
      { ...callRequest, duration_unit: 'w' },
      { ...callRequest, multiplier: 100 },
      withoutUnit,
      { ...multRequest, duration: 5, duration_unit: 'm' },
      { ...multRequest, multiplier: 0 },
      { ...multRequest, amount: 0 },
    ];
    const sources = requests.map((request) => textFrame(proposalText(request, CALL_FIELDS)));
    forbidAmbientEffects();
    for (const source of sources) {
      expect(deriveContractQuote(source, accept)).toEqual({
        incidents: [invalidOf(source, 'proposal_request_unsupported', 'SYNTH_GOLD')],
        records: [],
      });
    }
  });

  it('da proposal_inconsistent sin comisión, con un exponente o un importe negativo', () => {
    const sources = [
      textFrame(
        proposalText(multRequest, MULT_FIELDS.replace('"commission":0.20', '"commission":null')),
      ),
      textFrame(proposalText(multRequest, MULT_FIELDS.replace('"commission":0.20,', ''))),
      textFrame(
        proposalText(callRequest, CALL_FIELDS.replace('"ask_price":10.00', '"ask_price":1e1')),
      ),
      textFrame(
        proposalText(callRequest, CALL_FIELDS.replace('"payout":18.50', '"payout":-18.50')),
      ),
      textFrame(
        proposalText(
          callRequest,
          CALL_FIELDS.replace(`"spot_time":${SPOT_TIME}`, '"spot_time":1.5'),
        ),
      ),
    ];
    forbidAmbientEffects();
    for (const source of sources) {
      expect(deriveContractQuote(source, accept)).toEqual({
        incidents: [invalidOf(source, 'proposal_inconsistent', 'SYNTH_GOLD')],
        records: [],
      });
    }
  });

  it('no toma por suyo un contrato pedido con un exponente', () => {
    const exponentStake = textFrame(
      proposalText(callRequest, CALL_FIELDS).replace('"amount":10', '"amount":1e1'),
    );
    const exponentRejection = textFrame(
      `{"echo_req":${JSON.stringify(multRequest).replace('"multiplier":100', '"multiplier":1e2')},"error":{"code":"ContractBuyValidationError","details":{"field":"multiplier"},"message":"synthetic"},"msg_type":"proposal","req_id":4}`,
    );
    forbidAmbientEffects();
    expect(deriveContractQuote(exponentStake, accept).incidents).toEqual([
      invalidOf(exponentStake, 'proposal_request_unsupported', 'SYNTH_GOLD'),
    ]);
    expect(deriveContractQuote(exponentRejection, accept).incidents).toEqual([
      invalidOf(exponentRejection, 'source_error_response', 'SYNTH_GOLD'),
    ]);
  });

  it('da schema_validation_failed con el esquema de la release', () => {
    const source = textFrame(proposalText(callRequest, CALL_FIELDS));
    forbidAmbientEffects();
    expect(deriveContractQuote(source, reject).incidents).toEqual([
      invalidOf(source, 'schema_validation_failed', 'SYNTH_GOLD'),
    ]);
  });
});

// --- orden y segmentos -------------------------------------------------------------------------

describe('orden canónico de los registros', () => {
  it('ordena por recepción, observación y símbolo', () => {
    const at = (received: string, observation: string, symbol: string) => ({
      observation_id: observation,
      received_at_utc: received,
      symbol,
    });
    const records = [
      at('2026-11-25T12:00:01.000Z', 'b', 'SYNTH_100'),
      at('2026-11-25T12:00:00.000Z', 'b', 'SYNTH_GOLD'),
      at('2026-11-25T12:00:00.000Z', 'b', 'SYNTH_100'),
      at('2026-11-25T12:00:00.000Z', 'a', 'SYNTH_GOLD'),
      // Recibido antes, aunque su observación vaya después en el orden de texto.
      at('2026-11-25T11:59:59.000Z', 'c', 'SYNTH_100'),
    ];
    expect([...records].sort(compareBatchRecords)).toEqual([
      records[4],
      records[3],
      records[2],
      records[1],
      records[0],
    ]);
  });
});

describe('política de segmentos 2.0.0 de los lotes', () => {
  const raw = (index: number) =>
    frame(
      { echo_req: {}, msg_type: 'proposal', req_id: index },
      `2026-11-25T12:00:${String(index).padStart(2, '0')}.000Z`,
    );

  function statsAfter(count: number): SegmentStats {
    let stats = EMPTY_SEGMENT_STATS;
    for (let index = 0; index < count; index += 1) {
      stats = appendSegmentStats(stats, raw(index));
    }
    return stats;
  }

  it('cierra el segmento a las 15 respuestas, con la ventana y los bytes de la de vivo', () => {
    expect(BATCH_SEGMENT_POLICY).toEqual({
      maximum_bytes: SEGMENT_POLICY.maximum_bytes,
      maximum_raw_frames: 15,
      version: '2.0.0',
      window_ms: SEGMENT_POLICY.window_ms,
    });
    expect(evaluateSegmentRotation(statsAfter(14), raw(14), BATCH_SEGMENT_POLICY)).toBeNull();
    expect(evaluateSegmentRotation(statsAfter(15), raw(15), BATCH_SEGMENT_POLICY)).toBe(
      'raw_frames',
    );
  });

  it('no cuenta los eventos que no son respuestas, y la de vivo sigue en 10 000', () => {
    const closed = {
      closure_type: 'requested',
      connection_id: CONNECTION,
      event_id: '019b76da-a800-7000-8000-0000000000ff',
      kind: 'connection_closed',
      occurred_at_utc: '2026-11-25T12:00:20.000Z',
      reason: 'synthetic',
      schema_version: '1.0.0',
      source: 'deriv_options',
    } as unknown as Parameters<typeof evaluateSegmentRotation>[1];
    expect(evaluateSegmentRotation(statsAfter(15), closed, BATCH_SEGMENT_POLICY)).toBeNull();
    expect(evaluateSegmentRotation(statsAfter(15), raw(15))).toBeNull();
  });

  it('cierra por ventana a los 5 minutos de la primera respuesta', () => {
    const late = frame(
      { echo_req: {}, msg_type: 'proposal', req_id: 99 },
      '2026-11-25T12:05:00.000Z',
    );
    expect(evaluateSegmentRotation(statsAfter(3), late, BATCH_SEGMENT_POLICY)).toBe('window');
  });
});

describe('determinismo', () => {
  it('da los mismos registros e incidencias al repetir la conversión', () => {
    const source = frame(
      tradingTimes('2026-11-25', [
        symbolEntry('SYNTH_GOLD', ['00:00:00', '23:00:00'], ['22:00:00', '23:59:59']),
      ]),
    );
    forbidAmbientEffects();
    const first = canonicalJson(deriveTradingSessions(source, accept, ['SYNTH_GOLD']) as never);
    expect(canonicalJson(deriveTradingSessions(source, accept, ['SYNTH_GOLD']) as never)).toBe(
      first,
    );
  });
});
