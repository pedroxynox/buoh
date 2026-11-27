import { createHash } from 'node:crypto';

import {
  datasetManifestCoreSchema,
  datasetManifestSchema,
  deriveDatasetId,
  rawSourceFrameSchema,
  sha256Hex,
  validatePublicationRecord,
  type DatasetManifestCore,
  type JsonValue,
  type RawSourceFrame,
  type StorageObjectRef,
} from '@buoh/contracts';
import {
  BATCH_SOURCE_SCHEMA_OPERATIONS,
  batchSourceSchemaBytes,
  canonicalJsonBytes,
  type BatchDatasetPublication,
} from '@buoh/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  batchProfileBytes,
  derivHistoryProfile,
  type BatchProfileKind,
} from '../src/deriv/batch-profile.js';
import {
  contentKey,
  keyFromUri,
  manifestKey,
  objectUri,
  prepareBatchPublication,
  replayDataset,
  ReplayError,
  writePublication,
  type ReplayMode,
} from '../src/index.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// `data:replay` de un dataset de cada clase de los lotes en los dos modos (ADR-0021 §8; precisión
// del PR 5d1 de su §9), y las versiones que ata a sus reglas, las 4.0.0 (relevo del PR #139). Las
// respuestas tienen las formas medidas en Deriv; los precios y los esquemas son sintéticos.

const CONNECTION = '019b76da-a800-7000-8000-00000000c000';
const CONNECTOR = 'deriv-options-lotes-1.0.0';
/** 2026-11-24T12:00:00Z en segundos. */
const T = 1795521600;
const NEXT = T + 12 * 3600 + 60;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
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

const OPEN = '{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}';
const sourceSchema = (ticksHistory = OPEN) =>
  batchSourceSchemaBytes(
    Object.fromEntries(
      BATCH_SOURCE_SCHEMA_OPERATIONS.map((operation) => [
        operation,
        new TextEncoder().encode(operation === 'ticks_history' ? ticksHistory : OPEN),
      ]),
    ) as Parameters<typeof batchSourceSchemaBytes>[0],
  );
const SOURCE_SCHEMA = sourceSchema();

const sessionText = `{"echo_req":{"req_id":1,"trading_times":"2026-11-24"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[{"name":"x","times":{"close":["22:00:00","23:59:59"],"open":["00:00:00","23:00:00"]},"underlying_symbol":"frxXAUUSD"}]}]}]}}`;
const offerText = `{"contracts_for":{"available":[{"barriers":0,"contract_category":"multiplier","contract_type":"MULTUP","expiry_type":"no_expiry","market":"x","max_contract_duration":"0","min_contract_duration":"0","sentiment":"up","submarket":"x","underlying_symbol":"frxXAUUSD"}],"hit_count":1},"echo_req":{"contracts_for":"frxXAUUSD","req_id":2},"msg_type":"contracts_for","req_id":2}`;
const catalogText = `{"active_symbols":[{"exchange_is_open":1,"is_trading_suspended":0,"market":"x","pip_size":0.01,"subgroup":"x","submarket":"x","underlying_symbol":"frxXAUUSD","underlying_symbol_name":"x"}],"echo_req":{"active_symbols":"brief"},"msg_type":"active_symbols"}`;
const quoteText = (multiplier: number) =>
  `{"echo_req":{"amount":10,"basis":"stake","contract_type":"MULTUP","currency":"USD","multiplier":${String(multiplier)},"proposal":1,"req_id":4,"underlying_symbol":"frxXAUUSD"},"msg_type":"proposal","proposal":{"ask_price":10.00,"commission":0.20,"date_start":${String(T)},"id":"x","longcode":"x","multiplier":${String(multiplier)},"payout":0,"spot":1,"spot_time":${String(T)}},"req_id":4}`;
const pageText = (start: number, end: number, epochs: number[]) =>
  `{"candles":[${epochs
    .map((epoch) => `{"close":1,"epoch":${String(epoch)},"high":1,"low":1,"open":1}`)
    .join(
      ',',
    )}],"echo_req":{"end":"${String(end)}","granularity":60,"req_id":7,"start":${String(start)},"style":"candles","ticks_history":"frxXAUUSD"},"msg_type":"candles","pip_size":2,"req_id":7}`;

/** Los segmentos de un log de cada clase, como los escribe el paso de los lotes. */
function segmentsOf(kind: BatchProfileKind): RawSourceFrame[][] {
  switch (kind) {
    case 'schedules':
      return [[frame(sessionText, T), frame(catalogText, T + 2)], [frame(offerText, T + 4)]];
    case 'quotes':
      return [[frame(quoteText(100), T), frame(quoteText(50), T + 2)]];
    case 'candles':
      // Falta la vela de las 12:01: un candle_missing.
      return [[frame(sessionText, NEXT), frame(pageText(T, T + 179, [T, T + 120]), NEXT + 2)]];
  }
}

/**
 * Un bloque de la historia del oro (precisión del PR 6b de ADR-0021 §9): su horario y una página de
 * ticks, uno por segundo, sin ninguno de las 12:01:00 a las 12:01:59, 60 s: un tick_gap.
 */
function historySegments(): RawSourceFrame[][] {
  const times = Array.from({ length: 180 }, (_, index) => T + index).filter(
    (time) => time < T + 60 || time >= T + 120,
  );
  const page = `{"echo_req":{"count":1000,"end":"${String(T + 179)}","req_id":2,"start":${String(T)},"style":"ticks","ticks_history":"frxXAUUSD"},"history":{"prices":[${times.map(() => '1').join(',')}],"times":[${times.join(',')}]},"msg_type":"history","pip_size":2,"req_id":2}`;
  return [[frame(sessionText, NEXT), frame(page, NEXT + 2)]];
}

function stores() {
  return { metadata: new MemoryMetadataStore(), objects: new MemoryObjectStore() };
}

async function publish(
  target: ReturnType<typeof stores>,
  kind: BatchProfileKind | 'history',
  schema = SOURCE_SCHEMA,
): Promise<BatchDatasetPublication> {
  const history = kind === 'history';
  const publication = prepareBatchPublication({
    connector_version: CONNECTOR,
    derivedCompression: 'gzip',
    environment: 'test',
    objects: target.objects,
    publication_id: '019b76da-cb28-7003-8000-0000000000a1',
    published_at_utc: '2026-11-25T00:10:00.000Z',
    quality_profile_bytes: history
      ? canonicalJsonBytes(derivHistoryProfile('frxXAUUSD'))
      : batchProfileBytes(kind),
    segments: history ? historySegments() : segmentsOf(kind),
    source_schema_bytes: schema,
    source_schema_release: 'synthetic-v1',
    zlibVersion: 'test-zlib',
  });
  return writePublication(publication, {
    environment: 'test',
    metadata: target.metadata,
    objects: target.objects,
  });
}

function replay(target: ReturnType<typeof stores>, datasetId: string, mode: ReplayMode) {
  return replayDataset({
    datasetId,
    environment: 'test',
    metadata: target.metadata,
    mode,
    objects: target.objects,
  });
}

/** Vuelve a firmar el manifiesto con el core cambiado, y sus objetos si se dan. */
function resign(
  target: ReturnType<typeof stores>,
  publication: BatchDatasetPublication,
  change: (core: DatasetManifestCore) => DatasetManifestCore,
  storage: (objects: StorageObjectRef[]) => StorageObjectRef[] = (objects) => objects,
): string {
  const core = datasetManifestCoreSchema.parse(change(structuredClone(publication.core)));
  const datasetId = deriveDatasetId(core as JsonValue);
  const manifest = datasetManifestSchema.parse({
    ...publication.manifest,
    dataset_id: datasetId,
    manifest_core: core,
    storage_objects: storage(structuredClone(publication.manifest.storage_objects)),
  });
  const bytes = canonicalJsonBytes(manifest);
  const digest = sha256Hex(bytes);
  const uri = objectUri(
    target.objects.bucket,
    manifestKey({
      dataset_id: datasetId,
      manifest_document_sha256: digest,
      publication_id: manifest.publication_id,
    }),
  );
  const record = validatePublicationRecord(
    {
      ...publication.record,
      dataset_id: datasetId,
      manifest_document_sha256: digest,
      manifest_object_bytes_sha256: digest,
      manifest_object_uri: uri,
    },
    manifest,
  );
  target.objects.objects.set(keyFromUri(uri, target.objects.bucket) ?? '', bytes);
  target.metadata.records.push({ environment: 'test', record });
  return datasetId;
}

async function failure(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof ReplayError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('data:replay de los datasets de los lotes', () => {
  it.each([
    ['schedules', { contract_offer_count: 1, trading_session_count: 1 }],
    ['quotes', { contract_quote_count: 2 }],
    ['candles', { incident_count: 1, market_candle_count: 2, trading_session_count: 1 }],
    // Con las reglas 4.1.0 de la historia (precisión del PR 6b de ADR-0021 §9).
    ['history', { incident_count: 1, normalized_tick_count: 120, trading_session_count: 1 }],
  ] as const)(
    'reproduce y verifica uno de %s sin reloj, aleatoriedad ni red',
    async (kind, counts) => {
      const target = stores();
      const publication = await publish(target, kind);
      vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
      vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('Math.random no está permitido.');
      });
      vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
        throw new Error('crypto.randomUUID no está permitido.');
      });
      vi.stubGlobal('fetch', () => {
        throw new Error('La red no está permitida.');
      });
      const verified = await replay(target, publication.dataset_id, 'verify-only');
      const reproduced = await replay(target, publication.dataset_id, 'recompute');
      expect(verified.status).toBe('verified');
      expect(reproduced.status).toBe('reproduced');
      for (const report of [verified, reproduced]) {
        expect(report).toMatchObject({
          condition_event_count: 0,
          contract_offer_count: 0,
          contract_quote_count: 0,
          dataset_id: publication.dataset_id,
          incident_count: 0,
          market_candle_count: 0,
          normalized_tick_count: 0,
          trading_session_count: 0,
          ...counts,
        });
      }
    },
  );

  it('ata el esquema de incidencias de las reglas 4.0.0 al 3.0.0, y esas reglas al core 1.1.0', async () => {
    const target = stores();
    const publication = await publish(target, 'candles');
    const oldIncidents = resign(target, publication, (core) => ({
      ...core,
      incident_schema_version: '2.0.0',
    }));
    const liveRules = resign(target, publication, (core) => ({
      ...core,
      quality_rule_version: '3.0.0',
    }));
    for (const mode of ['verify-only', 'recompute'] as const) {
      expect(await failure(replay(target, oldIncidents, mode))).toEqual({
        code: 'VERSION_UNSUPPORTED',
        details: { fields: ['incident_schema_version'] },
      });
      expect(await failure(replay(target, liveRules, mode))).toEqual({
        code: 'VERSION_UNSUPPORTED',
        details: { fields: ['quality_rule_version'] },
      });
    }
  });

  it('ata el esquema de incidencias de las reglas 4.1.0 al 3.1.0, y el 3.1.0 solo a esas reglas', async () => {
    const target = stores();
    const history = await publish(target, 'history');
    expect(history.core.quality_rule_version).toBe('4.1.0');
    expect(history.core.incident_schema_version).toBe('3.1.0');
    const candles = await publish(target, 'candles');
    const historyWithOld = resign(target, history, (core) => ({
      ...core,
      incident_schema_version: '3.0.0',
    }));
    const candlesWithNew = resign(target, candles, (core) => ({
      ...core,
      incident_schema_version: '3.1.0',
    }));
    for (const mode of ['verify-only', 'recompute'] as const) {
      for (const datasetId of [historyWithOld, candlesWithNew]) {
        expect(await failure(replay(target, datasetId, mode))).toEqual({
          code: 'VERSION_UNSUPPORTED',
          details: { fields: ['incident_schema_version'] },
        });
      }
    }
  });

  it('solo recomputa con la política de segmentos 2.0.0 de los lotes', async () => {
    const target = stores();
    const publication = await publish(target, 'quotes');
    const livePolicy = resign(target, publication, (core) => ({
      ...core,
      segment_policy_version: '1.0.0',
    }));
    expect((await replay(target, livePolicy, 'verify-only')).status).toBe('verified');
    expect(await failure(replay(target, livePolicy, 'recompute'))).toEqual({
      code: 'VERSION_UNSUPPORTED',
      details: { fields: ['segment_policy_version'] },
    });
  });

  it('no reproduce un dataset cuyos registros no salen de su esquema de fuente', async () => {
    const target = stores();
    // Con un esquema que exige `history`, la página de velas no lo cumple y no da velas.
    const strict = sourceSchema(
      '{"$schema":"http://json-schema.org/draft-04/schema#","properties":{"history":{}},"required":["history"],"type":"object"}',
    );
    const publication = await publish(target, 'candles', strict);
    expect(publication.derived.candles).toEqual([]);
    // El mismo dataset declarando el esquema abierto, con el que la página sí da sus velas.
    const open = sha256Hex(SOURCE_SCHEMA);
    target.objects.objects.set(contentKey(open), SOURCE_SCHEMA);
    const swapped = resign(
      target,
      publication,
      (core) => ({ ...core, source_schema_sha256: open }),
      (objects) =>
        objects.map((object) =>
          object.artifact_id === 'source_schema:000000'
            ? {
                ...object,
                logical_content_sha256: open,
                object_bytes_sha256: open,
                size_bytes: SOURCE_SCHEMA.byteLength,
                uri: objectUri(target.objects.bucket, contentKey(open)),
              }
            : object,
        ),
    );
    expect((await replay(target, swapped, 'verify-only')).status).toBe('verified');
    const mismatch = await failure(replay(target, swapped, 'recompute'));
    expect(mismatch?.code).toBe('RECOMPUTATION_MISMATCH');
    expect(mismatch?.details['differing_artifacts']).toEqual([
      'market_candles:000000',
      'quality_incidents:000000',
    ]);
  });
});
