// Registros de los lotes (contratos de dominio, «Registros de los lotes»; ADR-0021 §4 y ADR-0024
// §4) y `MarketTick` 1.1.0. Los valores son sintéticos: ningún precio de Deriv. Las huellas
// esperadas se calculan aquí con `node:crypto` sobre el JCS escrito a mano, sin las funciones del
// paquete.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import canonicalizeJson from 'canonicalize';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import * as publicContracts from '../src/index.js';
import {
  contractOfferSchema,
  contractQuoteSchema,
  marketCandleSchema,
  marketTickSchema,
  tradingSessionSchema,
} from '../src/index.js';

const OBSERVATION = '019abc00-0000-7000-8000-000000000001';
const OTHER_OBSERVATION = '019abc00-0000-7000-8000-000000000002';
const RAW = 'a'.repeat(64);
const provenance = {
  observation_id: OBSERVATION,
  source: 'deriv_options',
  connector_version: 'deriv-options-lotes-1.0.0',
  received_at_utc: '2026-11-24T12:01:00.500Z',
  raw_payload_sha256: RAW,
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// JCS de la identidad de la vela, escrito a mano: claves en orden, sin espacios.
const CANDLE_IDENTITY =
  '{"close_decimal":"100.25","granularity_seconds":60,"high_decimal":"100.40",' +
  '"low_decimal":"99.90","open_decimal":"100.00","open_time_utc":"2026-11-24T12:00:00.000Z",' +
  '"pip_size":2,"source":"deriv_options","symbol":"frxXAUUSD"}';

const candle = {
  schema_version: '1.0.0',
  ...provenance,
  symbol: 'frxXAUUSD',
  open_time_utc: '2026-11-24T12:00:00.000Z',
  granularity_seconds: 60,
  open_decimal: '100.00',
  high_decimal: '100.40',
  low_decimal: '99.90',
  close_decimal: '100.25',
  pip_size: 2,
  candle_fingerprint_sha256: sha256(CANDLE_IDENTITY),
  quality_flags: [],
};

/** Una vela con otros precios, con su huella recalculada para que solo falle lo que se prueba. */
function withPrices(
  prices: Partial<Record<'open' | 'high' | 'low' | 'close', string>>,
  pipSize = 2,
) {
  return withCandle({
    open_decimal: prices.open ?? candle.open_decimal,
    high_decimal: prices.high ?? candle.high_decimal,
    low_decimal: prices.low ?? candle.low_decimal,
    close_decimal: prices.close ?? candle.close_decimal,
    pip_size: pipSize,
  });
}

/** La vela con otros campos y su huella recalculada (JCS de claves ordenadas, sin espacios). */
function withCandle(overrides: Partial<typeof candle>) {
  const next = { ...candle, ...overrides };
  const identity = JSON.stringify({
    close_decimal: next.close_decimal,
    granularity_seconds: 60,
    high_decimal: next.high_decimal,
    low_decimal: next.low_decimal,
    open_decimal: next.open_decimal,
    open_time_utc: next.open_time_utc,
    pip_size: next.pip_size,
    source: next.source,
    symbol: next.symbol,
  });
  return { ...next, candle_fingerprint_sha256: sha256(identity) };
}

describe('MarketCandle', () => {
  it('acepta una vela cerrada de 1 minuto con su huella sin observación ni recepción', () => {
    expect(marketCandleSchema.parse(candle).candle_fingerprint_sha256).toBe(
      sha256(CANDLE_IDENTITY),
    );
    const sameCandleLater = {
      ...candle,
      observation_id: OTHER_OBSERVATION,
      received_at_utc: '2026-11-25T08:00:00.000Z',
      raw_payload_sha256: 'b'.repeat(64),
    };
    expect(marketCandleSchema.safeParse(sameCandleLater).success).toBe(true);
    expect(
      marketCandleSchema.safeParse({ ...candle, candle_fingerprint_sha256: RAW }).success,
    ).toBe(false);
  });

  it('rechaza la vela del minuto en curso y acepta la que termina justo al recibirse', () => {
    expect(
      marketCandleSchema.safeParse({ ...candle, received_at_utc: '2026-11-24T12:00:59.999Z' })
        .success,
    ).toBe(false);
    expect(
      marketCandleSchema.safeParse({ ...candle, received_at_utc: '2026-11-24T12:01:00.000Z' })
        .success,
    ).toBe(true);
  });

  it('exige el principio de un minuto UTC y solo 60 s de granularidad', () => {
    // Cerrada y con su huella: solo falla por no empezar en un minuto.
    const shifted = withCandle({
      open_time_utc: '2026-11-24T12:00:30.000Z',
      received_at_utc: '2026-11-24T12:05:00.000Z',
    });
    expect(marketCandleSchema.safeParse(shifted).success).toBe(false);
    const aligned = withCandle({ open_time_utc: '2026-11-24T11:59:00.000Z' });
    expect(marketCandleSchema.safeParse(aligned).success).toBe(true);
    expect(marketCandleSchema.safeParse({ ...candle, granularity_seconds: 120 }).success).toBe(
      false,
    );
  });

  it('exige pip_size decimales en los cuatro precios', () => {
    expect(marketCandleSchema.safeParse(withPrices({ close: '100.2' })).success).toBe(false);
    expect(marketCandleSchema.safeParse(withPrices({ open: '100.000' })).success).toBe(false);
    expect(marketCandleSchema.safeParse(withPrices({ low: '1e2' })).success).toBe(false);
  });

  it('exige que el máximo y el mínimo encierren la apertura y el cierre', () => {
    expect(marketCandleSchema.safeParse(withPrices({ high: '100.10' })).success).toBe(false);
    expect(marketCandleSchema.safeParse(withPrices({ low: '100.05' })).success).toBe(false);
    const flat = withPrices({ open: '100.00', high: '100.00', low: '100.00', close: '100.00' });
    expect(marketCandleSchema.safeParse(flat).success).toBe(true);
  });

  it('compara los precios exactos, sin coma flotante', () => {
    // En coma flotante, los cuatro valen lo mismo; en decimal, el máximo es menor que la apertura.
    const prices = {
      open: '0.100000000000000002',
      high: '0.100000000000000001',
      low: '0.100000000000000000',
      close: '0.100000000000000001',
    };
    const tight = withPrices(prices, 18);
    expect(new Set(Object.values(prices).map(Number)).size).toBe(1);
    expect(marketCandleSchema.safeParse(tight).success).toBe(false);
    expect(
      marketCandleSchema.safeParse(withPrices({ ...prices, open: '0.100000000000000001' }, 18))
        .success,
    ).toBe(true);
  });

  it('rechaza marcas desordenadas y campos ajenos', () => {
    expect(
      marketCandleSchema.safeParse({
        ...candle,
        quality_flags: ['source_time_conflict', 'duplicate_exact'],
      }).success,
    ).toBe(false);
    expect(marketCandleSchema.safeParse({ ...candle, epoch: 1795521600 }).success).toBe(false);
  });
});

const goldWeekday = {
  schema_version: '1.0.0',
  ...provenance,
  symbol: 'frxXAUUSD',
  trading_date: '2026-11-25',
  intervals: [
    { opens_at_utc: '2026-11-25T00:00:00.000Z', closes_at_utc: '2026-11-25T22:00:00.000Z' },
    { opens_at_utc: '2026-11-25T23:00:00.000Z', closes_at_utc: '2026-11-26T00:00:00.000Z' },
  ],
};

describe('TradingSession', () => {
  it('acepta un día con cierre diario, un día entero y un día sin cotización', () => {
    expect(tradingSessionSchema.safeParse(goldWeekday).success).toBe(true);
    const fullDay = {
      ...goldWeekday,
      symbol: 'R_100',
      intervals: [
        { opens_at_utc: '2026-11-25T00:00:00.000Z', closes_at_utc: '2026-11-26T00:00:00.000Z' },
      ],
    };
    expect(tradingSessionSchema.safeParse(fullDay).success).toBe(true);
    expect(tradingSessionSchema.safeParse({ ...goldWeekday, intervals: [] }).success).toBe(true);
  });

  it('rechaza intervalos fuera de su día', () => {
    const [first, second] = goldWeekday.intervals;
    const late = { ...second, closes_at_utc: '2026-11-26T00:00:01.000Z' };
    const early = { ...first, opens_at_utc: '2026-11-24T23:59:59.000Z' };
    expect(
      tradingSessionSchema.safeParse({ ...goldWeekday, intervals: [first, late] }).success,
    ).toBe(false);
    expect(
      tradingSessionSchema.safeParse({ ...goldWeekday, intervals: [early, second] }).success,
    ).toBe(false);
  });

  it('rechaza intervalos vacíos, solapados, que se tocan o desordenados', () => {
    const [first, second] = goldWeekday.intervals;
    const empty = {
      opens_at_utc: '2026-11-25T10:00:00.000Z',
      closes_at_utc: '2026-11-25T10:00:00.000Z',
    };
    const touching = { ...second, opens_at_utc: '2026-11-25T22:00:00.000Z' };
    const overlapping = { ...second, opens_at_utc: '2026-11-25T21:00:00.000Z' };
    for (const intervals of [[empty], [first, touching], [first, overlapping], [second, first]]) {
      expect(tradingSessionSchema.safeParse({ ...goldWeekday, intervals }).success).toBe(false);
    }
  });

  it('exige un día UTC real', () => {
    expect(
      tradingSessionSchema.safeParse({ ...goldWeekday, trading_date: '2026-02-30', intervals: [] })
        .success,
    ).toBe(false);
    expect(
      tradingSessionSchema.safeParse({ ...goldWeekday, trading_date: 'today', intervals: [] })
        .success,
    ).toBe(false);
  });
});

const days = (duration: number) => ({ duration, duration_unit: 'd' });
const offerFor = (offers: unknown[]) => ({
  schema_version: '1.0.0',
  ...provenance,
  symbol: 'R_100',
  offers,
});
const ticksCall = {
  contract_category: 'callput',
  contract_type: 'CALL',
  expiry_type: 'tick',
  min_contract_duration: { duration: 1, duration_unit: 't' },
  max_contract_duration: { duration: 10, duration_unit: 't' },
};
const intradayCall = {
  contract_category: 'callput',
  contract_type: 'CALL',
  expiry_type: 'intraday',
  min_contract_duration: { duration: 15, duration_unit: 's' },
  max_contract_duration: days(1),
};
const dailyCall = {
  contract_category: 'callput',
  contract_type: 'CALL',
  expiry_type: 'daily',
  min_contract_duration: days(1),
  max_contract_duration: days(365),
};
const multDown = {
  contract_category: 'multiplier',
  contract_type: 'MULTDOWN',
  expiry_type: 'no_expiry',
};
const multUp = {
  contract_category: 'multiplier',
  contract_type: 'MULTUP',
  expiry_type: 'no_expiry',
};
const intradayPut = { ...intradayCall, contract_type: 'PUT' };

describe('ContractOffer', () => {
  it('acepta los cuatro tipos en orden, y un mercado sin ninguno', () => {
    const offer = offerFor([dailyCall, intradayCall, ticksCall, multDown, multUp, intradayPut]);
    expect(contractOfferSchema.safeParse(offer).success).toBe(true);
    expect(contractOfferSchema.safeParse(offerFor([])).success).toBe(true);
  });

  it('rechaza un orden distinto o una pareja repetida', () => {
    expect(contractOfferSchema.safeParse(offerFor([intradayCall, dailyCall])).success).toBe(false);
    expect(contractOfferSchema.safeParse(offerFor([multUp, multDown])).success).toBe(false);
    expect(contractOfferSchema.safeParse(offerFor([multUp, multUp])).success).toBe(false);
  });

  it('no guarda los multiplicadores que publica contracts_for', () => {
    const withRange = { ...multUp, multiplier_range: ['100', '200'] };
    expect(contractOfferSchema.safeParse(offerFor([withRange])).success).toBe(false);
  });

  it('mide el vencimiento tick en ticks y los demás en tiempo', () => {
    const tickInSeconds = {
      ...ticksCall,
      max_contract_duration: { duration: 10, duration_unit: 's' },
    };
    const intradayInTicks = {
      ...intradayCall,
      min_contract_duration: { duration: 5, duration_unit: 't' },
    };
    expect(contractOfferSchema.safeParse(offerFor([tickInSeconds])).success).toBe(false);
    expect(contractOfferSchema.safeParse(offerFor([intradayInTicks])).success).toBe(false);
  });

  it('compara la mínima y la máxima en la misma escala', () => {
    const equal = {
      ...intradayCall,
      min_contract_duration: { duration: 60, duration_unit: 's' },
      max_contract_duration: { duration: 1, duration_unit: 'm' },
    };
    const inverted = {
      ...intradayCall,
      min_contract_duration: { duration: 2, duration_unit: 'm' },
      max_contract_duration: { duration: 61, duration_unit: 's' },
    };
    expect(contractOfferSchema.safeParse(offerFor([equal])).success).toBe(true);
    expect(contractOfferSchema.safeParse(offerFor([inverted])).success).toBe(false);
  });

  it('liga cada tipo a su categoría y a su vencimiento', () => {
    expect(
      contractOfferSchema.safeParse(offerFor([{ ...dailyCall, contract_type: 'MULTUP' }])).success,
    ).toBe(false);
    expect(
      contractOfferSchema.safeParse(offerFor([{ ...multUp, expiry_type: 'intraday' }])).success,
    ).toBe(false);
    expect(
      contractOfferSchema.safeParse(offerFor([{ ...multUp, contract_type: 'CALL' }])).success,
    ).toBe(false);
  });
});

const quoteCommon = {
  schema_version: '1.0.0',
  ...provenance,
  symbol: 'frxXAUUSD',
  currency: 'USD',
  stake_decimal: '10',
  quoted_at_utc: '2026-11-24T12:01:00.000Z',
  ask_price_decimal: '10.00',
};
const callQuote = {
  ...quoteCommon,
  contract_category: 'callput',
  contract_type: 'CALL',
  duration: { duration: 15, duration_unit: 'm' },
  payout_decimal: '18.50',
};
const multiplierQuote = {
  ...quoteCommon,
  contract_category: 'multiplier',
  contract_type: 'MULTUP',
  multiplier_decimal: '100',
  commission_decimal: '0.20',
};

describe('ContractQuote', () => {
  it('acepta un sube/baja con su pago y un multiplicador con su comisión', () => {
    expect(contractQuoteSchema.safeParse(callQuote).success).toBe(true);
    expect(contractQuoteSchema.safeParse(multiplierQuote).success).toBe(true);
    expect(contractQuoteSchema.safeParse({ ...callQuote, ask_price_decimal: '0.00' }).success).toBe(
      true,
    );
  });

  it('no mezcla los campos de las dos categorías', () => {
    expect(
      contractQuoteSchema.safeParse({ ...callQuote, commission_decimal: '0.20' }).success,
    ).toBe(false);
    expect(
      contractQuoteSchema.safeParse({
        ...multiplierQuote,
        duration: { duration: 15, duration_unit: 'm' },
      }).success,
    ).toBe(false);
    const withoutCommission: Record<string, unknown> = { ...multiplierQuote };
    delete withoutCommission['commission_decimal'];
    expect(contractQuoteSchema.safeParse(withoutCommission).success).toBe(false);
    expect(contractQuoteSchema.safeParse({ ...callQuote, contract_type: 'MULTUP' }).success).toBe(
      false,
    );
  });

  it('rechaza importes negativos, una apuesta o un multiplicador de cero y otra moneda', () => {
    for (const quote of [
      { ...callQuote, payout_decimal: '-1.00' },
      { ...multiplierQuote, commission_decimal: '-0.20' },
      { ...callQuote, ask_price_decimal: '-10.00' },
      { ...callQuote, stake_decimal: '0.00' },
      { ...multiplierQuote, multiplier_decimal: '0' },
      { ...callQuote, currency: 'EUR' },
      { ...callQuote, payout_decimal: '1.85e1' },
      { ...callQuote, duration: { duration: 0, duration_unit: 'm' } },
      { ...callQuote, duration: { duration: 15, duration_unit: 'w' } },
    ]) {
      expect(contractQuoteSchema.safeParse(quote).success).toBe(false);
    }
  });
});

const vectorTick = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../test-vectors/market-data/v1/expected-ticks.ndjson'),
    'utf8',
  ).split('\n')[0] ?? '',
) as Record<string, unknown>;

describe('MarketTick 1.1.0', () => {
  it('sigue aceptando el tick 1.0.0 del vector', () => {
    expect(vectorTick['schema_version']).toBe('1.0.0');
    expect(marketTickSchema.safeParse(vectorTick).success).toBe(true);
  });

  it('admite history_download solo con la 1.1.0', () => {
    // El origen no entra en la huella, así que el tick del vector sirve tal cual.
    const downloaded = {
      ...vectorTick,
      schema_version: '1.1.0',
      origin: 'history_download',
      quality_flags: [],
    };
    expect(marketTickSchema.safeParse(downloaded).success).toBe(true);
    expect(marketTickSchema.safeParse({ ...downloaded, schema_version: '1.0.0' }).success).toBe(
      false,
    );
    expect(
      marketTickSchema.safeParse({ ...vectorTick, schema_version: '1.1.0', origin: 'stream' })
        .success,
    ).toBe(true);
  });

  it('no deja a un tick history_download con retraso de entrega', () => {
    const delayed = {
      ...vectorTick,
      schema_version: '1.1.0',
      origin: 'history_download',
      quality_flags: ['delivery_delayed'],
    };
    expect(marketTickSchema.safeParse(delayed).success).toBe(false);
    expect(marketTickSchema.safeParse({ ...delayed, origin: 'history_recovery' }).success).toBe(
      true,
    );
  });
});

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function exportedValidator(name: string) {
  const url = import.meta.resolve(`@buoh/contracts/json-schema/${name}`);
  return ajv.compile(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as object);
}

describe('JSON Schema de los registros de los lotes', () => {
  it('no expone los esquemas estructurales', () => {
    for (const name of [
      'marketCandleStructuralSchema',
      'tradingSessionStructuralSchema',
      'contractOfferStructuralSchema',
      'contractQuoteStructuralSchema',
    ]) {
      expect(name in publicContracts).toBe(false);
    }
  });

  it('describe la forma y deja huellas, orden y relaciones al runtime', () => {
    const cases: [string, object, object, object, (value: unknown) => boolean][] = [
      [
        'market-candle',
        candle,
        { ...candle, epoch: 1 },
        { ...candle, candle_fingerprint_sha256: RAW },
        (value) => marketCandleSchema.safeParse(value).success,
      ],
      [
        'trading-session',
        goldWeekday,
        { ...goldWeekday, events: [] },
        { ...goldWeekday, intervals: [...goldWeekday.intervals].reverse() },
        (value) => tradingSessionSchema.safeParse(value).success,
      ],
      [
        'contract-offer',
        offerFor([intradayCall, multUp]),
        offerFor([{ ...multUp, multiplier_range: [] }]),
        offerFor([multUp, intradayCall]),
        (value) => contractOfferSchema.safeParse(value).success,
      ],
      [
        'contract-quote',
        callQuote,
        { ...callQuote, spot: 1 },
        { ...callQuote, payout_decimal: '-1.00' },
        (value) => contractQuoteSchema.safeParse(value).success,
      ],
    ];
    for (const [name, valid, extraField, runtimeOnly, runtime] of cases) {
      const validate = exportedValidator(name);
      expect(validate(valid), name).toBe(true);
      expect(runtime(valid), name).toBe(true);
      expect(validate(extraField), name).toBe(false);
      expect(validate(runtimeOnly), name).toBe(true);
      expect(runtime(runtimeOnly), name).toBe(false);
    }
  });
});

describe('DataQualityIncident 3.0.0 y contract_rejected', () => {
  const rejectedBody = {
    evidence: {
      contract_type: 'MULTUP',
      error_code: 'ContractBuyValidationError',
      multiplier_decimal: '200',
      raw_payload_sha256: RAW,
    },
    incident_type: 'contract_rejected',
    observed_at_utc: '2026-11-25T12:00:00.250Z',
    observed_ref: OBSERVATION,
    quality_rule_version: '4.0.0',
    related_refs: [],
    schema_version: '3.0.0',
    severity: 'info',
    source: 'deriv_options',
    symbol: 'SYNTH_GOLD',
  };
  const withId = (body: Record<string, unknown>) => ({
    ...body,
    incident_id: `sha256:${sha256(canonicalizeJson(body) ?? '')}`,
  });

  it('acepta un rechazo de multiplicador con su ID y solo con el esquema 3.0.0', () => {
    expect(publicContracts.dataQualityIncidentSchema.safeParse(withId(rejectedBody)).success).toBe(
      true,
    );
    for (const version of ['1.0.0', '2.0.0']) {
      const body = { ...rejectedBody, schema_version: version };
      expect(publicContracts.dataQualityIncidentSchema.safeParse(withId(body)).success).toBe(false);
    }
  });

  it('exige un multiplicador mayor que cero y un multiplicador, no un sube/baja', () => {
    for (const evidence of [
      { ...rejectedBody.evidence, multiplier_decimal: '0' },
      { ...rejectedBody.evidence, multiplier_decimal: '-100' },
      { ...rejectedBody.evidence, contract_type: 'CALL' },
    ]) {
      const body = { ...rejectedBody, evidence };
      expect(publicContracts.dataQualityIncidentSchema.safeParse(withId(body)).success).toBe(false);
    }
  });

  it('admite invalid_source_frame sin símbolo con 2.0.0 y 3.0.0, y no con 1.0.0', () => {
    const invalid = {
      evidence: { raw_payload_sha256: RAW, reason: 'source_error_response' },
      incident_type: 'invalid_source_frame',
      observed_at_utc: '2026-11-25T12:00:00.250Z',
      observed_ref: OBSERVATION,
      quality_rule_version: '4.0.0',
      related_refs: [],
      severity: 'error',
      source: 'deriv_options',
      symbol: null,
    };
    const accepts = (version: string) =>
      publicContracts.dataQualityIncidentSchema.safeParse(
        withId({ ...invalid, schema_version: version }),
      ).success;
    expect([accepts('1.0.0'), accepts('2.0.0'), accepts('3.0.0'), accepts('4.0.0')]).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});
