import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BATCH_MANIFEST_CORE_SCHEMA_VERSION,
  ContractContextError,
  datasetManifestCoreSchema,
  datasetManifestSchema,
  EMPTY_SEQUENCE_SHA256,
  isBatchManifestCore,
  validateDatasetConsistency,
  type DatasetConsistencyInput,
  type DatasetManifestCore,
  type MarketCandle,
  type SourceEvent,
} from '../src/index.js';

// El core de un dataset de los lotes (precisión del PR 5d1 de ADR-0021 §9): `schema_version` 1.1.0,
// con sus cuatro roles y sus diez campos propios; un core 1.0.0, el de la captura, no los tiene.

type Artifact = Record<string, unknown> & { role: string };
type Core = Record<string, unknown> & { logical_artifacts: Artifact[] };

function liveCore(): Core {
  const manifest = datasetManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../test-vectors/market-data/v1/expected-dataset.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  return JSON.parse(JSON.stringify(manifest.manifest_core)) as Core;
}

const BATCH_ROLES = ['market_candles', 'trading_sessions', 'contract_offers', 'contract_quotes'];

const empty = (role: string) => ({
  artifact_id: `${role}:000000`,
  logical_content_sha256: EMPTY_SEQUENCE_SHA256,
  record_count: 0,
  role,
  segment_index: 0,
});

/** El core del vector v1 como uno de los lotes: sus roles vacíos, en su orden canónico. */
function batchCore(): Core {
  const core = liveCore();
  const artifacts = core.logical_artifacts;
  const firstIncident = artifacts.findIndex((artifact) => artifact.role === 'quality_incidents');
  return {
    ...core,
    candle_time_from_utc: null,
    candle_time_to_utc: null,
    contract_offer_count: 0,
    contract_offer_schema_version: '1.0.0',
    contract_quote_count: 0,
    contract_quote_schema_version: '1.0.0',
    logical_artifacts: [
      ...artifacts.slice(0, firstIncident),
      ...BATCH_ROLES.map(empty),
      ...artifacts.slice(firstIncident),
    ],
    market_candle_count: 0,
    market_candle_schema_version: '1.0.0',
    schema_version: BATCH_MANIFEST_CORE_SCHEMA_VERSION,
    trading_session_count: 0,
    trading_session_schema_version: '1.0.0',
  };
}

const valid = (core: unknown) => datasetManifestCoreSchema.safeParse(core).success;

describe('DatasetManifestCore 1.1.0, el de los lotes', () => {
  it('acepta el core de los lotes con sus cuatro roles, y el 1.0.0 sigue sin ellos', () => {
    expect(valid(liveCore())).toBe(true);
    expect(valid(batchCore())).toBe(true);
    expect(isBatchManifestCore(batchCore() as unknown as DatasetManifestCore)).toBe(true);
    expect(isBatchManifestCore(liveCore() as unknown as DatasetManifestCore)).toBe(false);
  });

  it.each([
    'market_candle_schema_version',
    'trading_session_schema_version',
    'contract_offer_schema_version',
    'contract_quote_schema_version',
    'candle_time_from_utc',
    'candle_time_to_utc',
    'market_candle_count',
    'trading_session_count',
    'contract_offer_count',
    'contract_quote_count',
  ])('%s va exactamente en un core 1.1.0', (field) => {
    const batch = Object.fromEntries(Object.entries(batchCore()).filter(([key]) => key !== field));
    expect(valid(batch)).toBe(false);
    expect(valid({ ...liveCore(), [field]: batchCore()[field] })).toBe(false);
  });

  it.each(BATCH_ROLES)('el rol %s falta en un core 1.1.0 o sobra en uno 1.0.0', (role) => {
    const batch = batchCore();
    expect(
      valid({
        ...batch,
        logical_artifacts: batch.logical_artifacts.filter((artifact) => artifact.role !== role),
      }),
    ).toBe(false);
    const live = liveCore();
    const firstIncident = live.logical_artifacts.findIndex(
      (artifact) => artifact.role === 'quality_incidents',
    );
    live.logical_artifacts.splice(firstIncident, 0, empty(role));
    expect(valid(live)).toBe(false);
  });

  it('los roles de los lotes van entre los ticks y las incidencias, y cuentan con su campo', () => {
    const batch = batchCore();
    const misplaced = [...batch.logical_artifacts];
    const [candles] = misplaced.splice(
      misplaced.findIndex((artifact) => artifact.role === 'market_candles'),
      1,
    );
    expect(valid({ ...batch, logical_artifacts: [...misplaced, candles] })).toBe(false);
    expect(valid({ ...batch, market_candle_count: 1 })).toBe(false);
  });

  it('el rango de velas es null exactamente sin velas, y no se invierte', () => {
    expect(valid({ ...batchCore(), candle_time_from_utc: '2026-11-21T00:00:00.000Z' })).toBe(false);
    const withCandles = (from: string, to: string) => {
      const batch = batchCore();
      return {
        ...batch,
        candle_time_from_utc: from,
        candle_time_to_utc: to,
        logical_artifacts: batch.logical_artifacts.map((artifact) =>
          artifact.role === 'market_candles'
            ? { ...artifact, logical_content_sha256: 'a'.repeat(64), record_count: 2 }
            : artifact,
        ),
        market_candle_count: 2,
      };
    };
    expect(valid(withCandles('2026-11-21T00:00:00.000Z', '2026-11-21T00:01:00.000Z'))).toBe(true);
    expect(valid(withCandles('2026-11-21T00:01:00.000Z', '2026-11-21T00:00:00.000Z'))).toBe(false);
    // Con velas, los dos extremos; sin ellas, ninguno.
    const halfOpen = { ...withCandles('2026-11-21T00:00:00.000Z', ''), candle_time_to_utc: null };
    expect(valid(halfOpen)).toBe(false);
  });
});

describe('validateDatasetConsistency con registros de los lotes', () => {
  const RAW = 'a'.repeat(64);
  const frame = (observation: string, received: string): SourceEvent =>
    ({
      connector_version: 'deriv-options-lotes-1.0.0',
      kind: 'raw_source_frame',
      observation_id: observation,
      payload_utf8: '{}',
      raw_payload_sha256: RAW,
      received_at_utc: received,
      schema_version: '1.0.0',
      source: 'deriv_options',
    }) as unknown as SourceEvent;
  const candle = (observation: string, received: string, open: string): MarketCandle =>
    ({
      connector_version: 'deriv-options-lotes-1.0.0',
      observation_id: observation,
      open_time_utc: open,
      raw_payload_sha256: RAW,
      received_at_utc: received,
      schema_version: '1.0.0',
      source: 'deriv_options',
      symbol: 'SYNTH_GOLD',
    }) as unknown as MarketCandle;
  const A = '019abc00-0000-7000-8000-00000000000a';
  const RECEIVED = '2026-11-22T00:00:01.000Z';
  const core = (candles: number, from: string | null, to: string | null) =>
    ({
      candle_time_from_utc: from,
      candle_time_to_utc: to,
      condition_event_count: 0,
      condition_event_schema_version: '1.0.0',
      connector_version: 'deriv-options-lotes-1.0.0',
      contract_offer_count: 0,
      contract_quote_count: 0,
      event_time_from_utc: null,
      event_time_to_utc: null,
      incident_count: 0,
      incident_schema_version: '3.0.0',
      market_candle_count: candles,
      market_candle_schema_version: '1.0.0',
      market_tick_schema_version: '1.1.0',
      normalized_tick_count: 0,
      quality_rule_version: '4.0.0',
      raw_frame_count: 1,
      schema_version: '1.1.0',
      source: 'deriv_options',
      source_event_count: 1,
      source_event_schema_version: '1.0.0',
      symbols: ['SYNTH_GOLD'],
      trading_session_count: 0,
      trading_session_schema_version: '1.0.0',
    }) as unknown as DatasetManifestCore;
  const input = (
    candles: MarketCandle[],
    declared = core(2, '2026-11-21T00:00:00.000Z', '2026-11-21T00:01:00.000Z'),
  ) => ({
    candles,
    conditions: [],
    core: declared,
    incidents: [],
    sourceEvents: [frame(A, RECEIVED)],
    ticks: [],
  });
  const codeOf = (value: DatasetConsistencyInput) => {
    try {
      validateDatasetConsistency(value);
    } catch (error) {
      return error instanceof ContractContextError ? error.code : 'other';
    }
    return null;
  };
  const first = candle(A, RECEIVED, '2026-11-21T00:00:00.000Z');
  const second = candle(A, RECEIVED, '2026-11-21T00:01:00.000Z');

  it('acepta velas de un frame del dataset, en su orden, con sus extremos en el core', () => {
    expect(codeOf(input([first, second]))).toBeNull();
  });

  it('rechaza una vela sin su frame, fuera de orden, con otros extremos o en un core 1.0.0', () => {
    const other = '019abc00-0000-7000-8000-00000000000b';
    const late = '2026-11-22T00:00:02.000Z';
    expect(codeOf(input([first, { ...second, observation_id: other }]))).toBe(
      'DATASET_REFERENCE_UNKNOWN',
    );
    expect(codeOf(input([first, { ...second, received_at_utc: late }]))).toBe(
      'DATASET_REFERENCE_UNKNOWN',
    );
    expect(codeOf(input([second, first]))).toBe('DATASET_ORDER_INVALID');
    const wider = core(2, '2026-11-21T00:00:00.000Z', '2026-11-21T00:02:00.000Z');
    expect(codeOf(input([first, second], wider))).toBe('DATASET_RANGE_MISMATCH');
    const live = { ...core(0, null, null), schema_version: '1.0.0' } as DatasetManifestCore;
    expect(codeOf(input([first], live))).toBe('DATASET_COUNT_MISMATCH');
  });
});
