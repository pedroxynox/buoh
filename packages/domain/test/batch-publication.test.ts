import { createHash } from 'node:crypto';

import {
  canonicalJson,
  datasetManifestSchema,
  EMPTY_SEQUENCE_SHA256,
  rawSourceFrameSchema,
  validateDatasetConsistency,
  type JsonValue,
  type RawSourceFrame,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BATCH_SOURCE_SCHEMA_OPERATIONS,
  batchSourceSchemaBytes,
  buildBatchDatasetPublication,
  type BatchPublicationInput,
} from '../src/index.js';

// La publicación de un dataset de los lotes (precisión del PR 5d1 de ADR-0021 §9): un core 1.1.0
// con los registros de las reglas 4.0.0 por rol, el perfil de su secuencia y los esquemas de
// respuesta de la release como esquema de fuente. Datos sintéticos (`SYNTH_GOLD`), sin red, reloj
// ni azar; las expectativas se escriben a mano.

const CONNECTION = '019b76da-a800-7000-8000-00000000c000';
const CONNECTOR = 'deriv-options-lotes-1.0.0';
/** 2026-11-24T12:00:00Z en segundos. */
const T = 1795521600;
/** El día siguiente, ya terminado el de las velas. */
const NEXT = T + 12 * 3600 + 60;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);
let sequence = 0;

function frame(text: string, received: number): RawSourceFrame {
  sequence += 1;
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: CONNECTOR,
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${String(sequence).padStart(12, '0')}`,
    payload_utf8: text,
    raw_payload_sha256: sha256(text),
    received_at_utc: iso(received),
    schema_version: '1.0.0',
    source: 'deriv_options',
  });
}

const OPEN_SCHEMA = '{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}';
const schemas = (overrides: Partial<Record<string, string>> = {}) =>
  Object.fromEntries(
    BATCH_SOURCE_SCHEMA_OPERATIONS.map((operation) => [
      operation,
      utf8(overrides[operation] ?? OPEN_SCHEMA),
    ]),
  ) as Parameters<typeof batchSourceSchemaBytes>[0];

const PROFILE = {
  count: 1000,
  granularity_seconds: 60,
  page_seconds: 43_200,
  profile_id: 'deriv_options-lotes-v1-velas',
  quality_rule_version: '4.0.0',
  source: 'deriv_options',
  symbols: ['SYNTH_GOLD'],
};
const profileBytes = (profile: Record<string, unknown> = PROFILE) =>
  utf8(canonicalJson(profile as JsonValue));

const sessionText = `{"echo_req":{"req_id":1,"trading_times":"2026-11-24"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":["23:59:59"],"open":["00:00:00"]},"underlying_symbol":"SYNTH_GOLD"}]}]}]}}`;
const pageText = (start: number, end: number, epochs: number[], pip = ',"pip_size":2') =>
  `{"candles":[${epochs
    .map((epoch) => `{"close":1,"epoch":${String(epoch)},"high":1,"low":1,"open":1}`)
    .join(
      ',',
    )}],"echo_req":{"end":"${String(end)}","granularity":60,"req_id":7,"start":${String(start)},"style":"candles","ticks_history":"SYNTH_GOLD"},"msg_type":"candles"${pip},"req_id":7}`;

function input(
  segments: RawSourceFrame[][],
  overrides: Partial<BatchPublicationInput> = {},
): BatchPublicationInput {
  return {
    connector_version: CONNECTOR,
    locateManifest: ({ manifest_document_sha256 }) =>
      `s3://synthetic/manifests/${manifest_document_sha256}.json`,
    locateObject: (_id, { object_bytes_sha256 }) => `s3://synthetic/sha256/${object_bytes_sha256}`,
    publication_id: '019b76da-a800-7000-8000-0000000000aa',
    published_at_utc: '2026-11-25T00:10:00.000Z',
    quality_profile_bytes: profileBytes(),
    segments,
    source_schema_bytes: batchSourceSchemaBytes(schemas()),
    source_schema_release: 'synthetic-v1',
    ...overrides,
  };
}

beforeEach(() => {
  sequence = 0;
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en la publicación.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en la publicación.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en la publicación.');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildBatchDatasetPublication', () => {
  it('publica un core 1.1.0 con los roles de los lotes en su orden y los vacíos de cero bytes', () => {
    const session = frame(sessionText, NEXT);
    // Falta la vela de las 12:01: un candle_missing.
    const page = frame(pageText(T, T + 179, [T, T + 120]), NEXT + 1);
    const later = frame(pageText(T + 180, T + 239, [T + 180]), NEXT + 2);
    const publication = buildBatchDatasetPublication(input([[session, page], [later]]));
    const { core } = publication;

    expect(core).toMatchObject({
      candle_time_from_utc: iso(T),
      candle_time_to_utc: iso(T + 180),
      condition_event_count: 0,
      condition_event_schema_version: '1.0.0',
      connector_version: CONNECTOR,
      contract_offer_count: 0,
      contract_offer_schema_version: '1.0.0',
      contract_quote_count: 0,
      contract_quote_schema_version: '1.0.0',
      event_time_from_utc: null,
      event_time_to_utc: null,
      incident_count: 1,
      incident_schema_version: '3.0.0',
      market_candle_count: 3,
      market_candle_schema_version: '1.0.0',
      market_tick_schema_version: '1.1.0',
      normalized_tick_count: 0,
      normalizer_version: '4.0.0',
      quality_profile_id: 'deriv_options-lotes-v1-velas',
      quality_profile_sha256: sha256(canonicalJson(PROFILE)),
      quality_rule_version: '4.0.0',
      raw_frame_count: 3,
      schema_version: '1.1.0',
      segment_policy_version: '2.0.0',
      source: 'deriv_options',
      source_event_count: 3,
      source_event_schema_version: '1.0.0',
      source_schema_release: 'synthetic-v1',
      source_schema_sha256: sha256(new TextDecoder().decode(batchSourceSchemaBytes(schemas()))),
      symbols: ['SYNTH_GOLD'],
      trading_session_count: 1,
      trading_session_schema_version: '1.0.0',
    });
    expect(
      core.logical_artifacts.map((artifact) => [
        artifact.artifact_id,
        artifact.record_count,
        artifact.record_count === 0
          ? artifact.logical_content_sha256 === EMPTY_SEQUENCE_SHA256
          : true,
      ]),
    ).toEqual([
      ['source_events:000000', 2, true],
      ['source_events:000001', 1, true],
      ['normalized_ticks:000000', 0, true],
      ['market_candles:000000', 3, true],
      ['trading_sessions:000000', 1, true],
      ['contract_offers:000000', 0, true],
      ['contract_quotes:000000', 0, true],
      ['quality_incidents:000000', 1, true],
      ['operational_conditions:000000', 0, true],
    ]);
    expect(publication.derived.incidents.map((incident) => incident.incident_type)).toEqual([
      'candle_missing',
    ]);
    expect(datasetManifestSchema.safeParse(publication.manifest).success).toBe(true);
    // El dominio y los contratos ordenan los registros igual.
    expect(() => {
      validateDatasetConsistency({
        candles: publication.derived.candles,
        conditions: [],
        core,
        incidents: publication.derived.incidents,
        offers: publication.derived.offers,
        quotes: publication.derived.quotes,
        sessions: publication.derived.sessions,
        sourceEvents: [session, page, later],
        ticks: publication.derived.ticks,
      });
    }).not.toThrow();
  });

  it('da el mismo dataset_id con otra publicación, y otro con otros segmentos', () => {
    const session = frame(sessionText, NEXT);
    const page = frame(pageText(T, T + 119, [T, T + 60]), NEXT + 1);
    const first = buildBatchDatasetPublication(input([[session, page]]));
    const again = buildBatchDatasetPublication(
      input([[session, page]], { publication_id: '019b76da-a800-7000-8000-0000000000bb' }),
    );
    const split = buildBatchDatasetPublication(input([[session], [page]]));
    expect(again.dataset_id).toBe(first.dataset_id);
    expect(again.record.publication_id).not.toBe(first.record.publication_id);
    expect(split.dataset_id).not.toBe(first.dataset_id);
  });

  it('parte cada rol derivado en partes de 5000 registros', () => {
    const day = T - 12 * 3600;
    const pages = Array.from({ length: 6 }, (_, index) => {
      const start = day + index * 60_000;
      return frame(
        pageText(
          start,
          start + 59_999,
          Array.from({ length: 1000 }, (__, minute) => start + minute * 60),
        ),
        day + 400 * 86_400,
      );
    });
    const publication = buildBatchDatasetPublication(input([pages]));
    expect(
      publication.core.logical_artifacts
        .filter((artifact) => artifact.role === 'market_candles')
        .map((artifact) => [artifact.artifact_id, artifact.record_count]),
    ).toEqual([
      ['market_candles:000000', 5000],
      ['market_candles:000001', 1000],
    ]);
  });

  it('aplica los esquemas del esquema de fuente, y busca en trading_times los símbolos del perfil', () => {
    const strict = batchSourceSchemaBytes(
      schemas({
        ticks_history:
          '{"$schema":"http://json-schema.org/draft-04/schema#","properties":{"pip_size":{}},"required":["pip_size"],"type":"object"}',
      }),
    );
    const page = frame(pageText(T, T + 59, [T], ''), NEXT);
    const session = frame(sessionText, NEXT + 1);
    const strictPublication = buildBatchDatasetPublication(
      input([[page, session]], { source_schema_bytes: strict }),
    );
    expect(strictPublication.derived.candles).toEqual([]);
    expect(
      strictPublication.derived.incidents.map((incident) =>
        'reason' in incident.evidence ? incident.evidence.reason : incident.incident_type,
      ),
      // Del mismo frame, por su tipo: `candle_missing` antes que `invalid_source_frame`.
    ).toEqual(['candle_missing', 'schema_validation_failed']);
    // El perfil de las cotizaciones no tiene `symbols`: no busca horarios.
    const quotes = Object.fromEntries(Object.entries(PROFILE).filter(([key]) => key !== 'symbols'));
    const withoutSymbols = buildBatchDatasetPublication(
      input([[frame(pageText(T, T + 59, [T]), NEXT), frame(sessionText, NEXT + 1)]], {
        quality_profile_bytes: profileBytes({ ...quotes, profile_id: 'deriv_options-lotes-v1-x' }),
      }),
    );
    expect(withoutSymbols.derived.sessions).toEqual([]);
  });

  it('rechaza otro conjunto de reglas, un esquema de fuente incompleto y un dataset sin símbolos', () => {
    const page = frame(pageText(T, T + 59, [T]), NEXT);
    expect(() =>
      buildBatchDatasetPublication(
        input([[page]], {
          quality_profile_bytes: profileBytes({ ...PROFILE, quality_rule_version: '3.0.0' }),
        }),
      ),
    ).toThrow();
    const partial = Object.fromEntries(
      BATCH_SOURCE_SCHEMA_OPERATIONS.filter((operation) => operation !== 'proposal').map(
        (operation) => [operation, JSON.parse(OPEN_SCHEMA) as JsonValue],
      ),
    );
    expect(() =>
      buildBatchDatasetPublication(
        input([[page]], { source_schema_bytes: utf8(canonicalJson(partial as JsonValue)) }),
      ),
    ).toThrow(/un esquema por operación/u);
    expect(() => buildBatchDatasetPublication(input([[frame('{', NEXT)]]))).toThrow(
      /no es publicable/u,
    );
    expect(() => buildBatchDatasetPublication(input([]))).toThrow();
  });
});
