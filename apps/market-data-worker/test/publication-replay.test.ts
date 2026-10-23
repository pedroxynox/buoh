import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  datasetManifestCoreSchema,
  datasetManifestSchema,
  deriveDatasetId,
  deriveTickFingerprint,
  EMPTY_SEQUENCE_SHA256,
  sha256Hex,
  uuidV7Schema,
  validatePublicationRecord,
  type DatasetManifestCore,
  type MarketTick,
} from '@buoh/contracts';
import { canonicalJsonBytes, ndjsonBytes, type DatasetPublication } from '@buoh/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ConfigError,
  contentKey,
  createStorageEncoder,
  createUuidV7Generator,
  decodeObject,
  keyFromUri,
  loadConfig,
  loadSyntheticFixture,
  manifestKey,
  objectUri,
  parseReplayArgs,
  PublicationConflictError,
  PublicationError,
  publishDataset,
  replayDataset,
  ReplayError,
  UsageError,
  type ReplayMode,
  type SyntheticFixture,
} from '../src/index.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// Casos derivados de F1-DATASET-001 (plan F1 §6), ADR-0004 §8/§9 y del oráculo
// test-vectors/market-data/v1, sin red, reloj real ni aleatoriedad.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const MAIN_DATASET_ID = 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd';
const ZERO_DATASET_ID = 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f';
const ZLIB_VERSION = 'test-zlib';
const PUBLICATION_A = '019b76da-cb28-7003-8000-0000000000a1';
const PUBLICATION_B = '019b76da-cb28-7003-8000-0000000000b2';
const PUBLISHED_AT = '2026-01-01T00:00:09.000Z';

function readVector(path: string): Buffer {
  return readFileSync(resolve(vectorRoot, path));
}

function forbidAmbientEffects(): void {
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
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let fixture: SyntheticFixture;

beforeAll(async () => {
  fixture = await loadSyntheticFixture(vectorRoot);
});

function scenario(name: 'principal' | 'zero-valid-ticks') {
  const found = fixture.scenarios.find((item) => item.name === name);
  if (found === undefined) {
    throw new TypeError(`Falta el escenario ${name}.`);
  }
  return found;
}

function stores() {
  return { metadata: new MemoryMetadataStore(), objects: new MemoryObjectStore() };
}

function publish(
  target: ReturnType<typeof stores>,
  name: 'principal' | 'zero-valid-ticks',
  publicationId = PUBLICATION_A,
) {
  return publishDataset({
    environment: 'test',
    metadata: target.metadata,
    objects: target.objects,
    profile: fixture.profile,
    publication_id: publicationId,
    published_at_utc: PUBLISHED_AT,
    segments: scenario(name).segments,
    zlibVersion: ZLIB_VERSION,
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

async function expectReplayError(promise: Promise<unknown>, code: string) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ReplayError);
  expect((error as ReplayError).code).toBe(code);
  return error as ReplayError;
}

function storedBytes(target: ReturnType<typeof stores>, uri: string): Uint8Array {
  const key = keyFromUri(uri, target.objects.bucket);
  const bytes = key === null ? undefined : target.objects.objects.get(key);
  if (bytes === undefined) {
    throw new TypeError(`Objeto ausente: ${uri}`);
  }
  return bytes;
}

describe('F1-DATASET-001: publicación atómica (ADR-0004 §8)', () => {
  it.each([
    [
      'principal',
      MAIN_DATASET_ID,
      ['expected-source-events-000000.ndjson', 'expected-source-events-000001.ndjson'],
      '',
    ],
    [
      'zero-valid-ticks',
      ZERO_DATASET_ID,
      ['zero-valid-ticks/expected-source-events.ndjson'],
      'zero-valid-ticks/',
    ],
  ] as const)(
    'publica %s con el dataset_id firmado y objetos content-addressed verificables',
    async (name, datasetId, sourceEventFiles, directory) => {
      const target = stores();
      forbidAmbientEffects();
      const publication = await publish(target, name);

      expect(publication.dataset_id).toBe(datasetId);
      const objects = new Map(
        publication.manifest.storage_objects.map((object) => [object.artifact_id, object]),
      );
      for (const object of publication.manifest.storage_objects) {
        expect(object.uri).toBe(objectUri('buoh-test', contentKey(object.object_bytes_sha256)));
        const bytes = storedBytes(target, object.uri);
        expect(sha256Hex(bytes)).toBe(object.object_bytes_sha256);
        expect(bytes.byteLength).toBe(object.size_bytes);
      }

      // Source events: gzip físico; los bytes lógicos son exactamente los segmentos firmados.
      sourceEventFiles.forEach((file, index) => {
        const object = objects.get(`source_events:${index.toString().padStart(6, '0')}`);
        expect(object).toMatchObject({
          compression: 'gzip',
          media_type: 'application/x-ndjson',
          writer_name: 'node:zlib',
          writer_version: ZLIB_VERSION,
        });
        const physical = storedBytes(target, object?.uri ?? '');
        expect(Buffer.from(gunzipSync(physical)).equals(readVector(file))).toBe(true);
        expect(object?.object_bytes_sha256).not.toBe(object?.logical_content_sha256);
      });

      // Derivados: NDJSON sin compresión, idénticos al oráculo.
      for (const [id, file] of [
        ['normalized_ticks:000000', 'expected-ticks.ndjson'],
        ['quality_incidents:000000', 'expected-incidents.ndjson'],
        ['operational_conditions:000000', 'expected-conditions.ndjson'],
      ] as const) {
        const object = objects.get(id);
        expect(object?.compression).toBe('none');
        const bytes = Buffer.from(storedBytes(target, object?.uri ?? ''));
        expect(bytes.equals(readVector(`${directory}${file}`)), id).toBe(true);
      }

      // Documento JCS sin newline bajo manifests/<dataset_id>/<publication_id>/<digest>.json.
      const record = await target.metadata.findActivePublication(datasetId, 'test');
      expect(record).toEqual(publication.record);
      expect(record?.manifest_object_uri).toBe(
        objectUri(
          'buoh-test',
          manifestKey({
            dataset_id: datasetId,
            manifest_document_sha256: publication.record.manifest_document_sha256,
            publication_id: PUBLICATION_A,
          }),
        ),
      );
      expect(
        Buffer.from(storedBytes(target, record?.manifest_object_uri ?? '')).equals(
          Buffer.from(publication.manifest_bytes),
        ),
      ).toBe(true);
      expect(target.metadata.incidents.get(datasetId)).toEqual(publication.derived.incidents);
    },
  );

  it('cero ticks conserva objetos vacíos de cero bytes y tiempos nulos', async () => {
    const target = stores();
    const publication = await publish(target, 'zero-valid-ticks');
    expect(publication.core.event_time_from_utc).toBeNull();
    expect(publication.core.event_time_to_utc).toBeNull();
    for (const id of ['normalized_ticks:000000', 'operational_conditions:000000']) {
      const object = publication.manifest.storage_objects.find((item) => item.artifact_id === id);
      expect(object).toMatchObject({
        compression: 'none',
        logical_content_sha256: EMPTY_SEQUENCE_SHA256,
        object_bytes_sha256: EMPTY_SEQUENCE_SHA256,
        size_bytes: 0,
      });
      expect(storedBytes(target, object?.uri ?? '').byteLength).toBe(0);
    }
  });

  it('el gzip es determinista para el mismo writer y no incrusta fecha ni nombre', () => {
    const encode = createStorageEncoder(ZLIB_VERSION);
    const logical = readVector('expected-source-events-000000.ndjson');
    const first = encode({
      artifact_id: 'source_events:000000',
      logical_bytes: logical,
      role: 'source_events',
    });
    const second = encode({
      artifact_id: 'source_events:000000',
      logical_bytes: logical,
      role: 'source_events',
    });
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    // Cabecera gzip: ID1 ID2 CM FLG MTIME(4) — sin FNAME y con MTIME = 0.
    expect([...first.bytes.slice(0, 8)]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]);
  });

  const failures: [
    string,
    (target: ReturnType<typeof stores>) => void,
    PublicationError['step'],
  ][] = [
    [
      'escritura del primer objeto',
      (target) => {
        target.objects.failPut = (key) => key.startsWith('sha256/');
      },
      'object_write',
    ],
    [
      'verificación de lectura de un objeto',
      (target) => {
        target.objects.onRead = (key, bytes) =>
          key.startsWith('sha256/') && bytes.byteLength > 0 ? bytes.slice(1) : bytes;
      },
      'object_write',
    ],
    [
      'escritura del documento canónico',
      (target) => {
        target.objects.failPut = (key) => key.startsWith('manifests/');
      },
      'manifest_write',
    ],
    [
      'commit transaccional',
      (target) => {
        target.metadata.failCommit = true;
      },
      'commit',
    ],
  ];

  it.each(failures)('un fallo en %s no crea publicación visible', async (_label, inject, step) => {
    const target = stores();
    inject(target);
    const error: unknown = await publish(target, 'principal').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).step).toBe(step);
    expect(await target.metadata.findActivePublication(MAIN_DATASET_ID, 'test')).toBeNull();
    expect(target.metadata.records).toEqual([]);
    await expectReplayError(
      replay(target, MAIN_DATASET_ID, 'verify-only'),
      'DATASET_NOT_PUBLISHED',
    );

    // Reanudar con almacenamiento sano reutiliza los objetos verificados y completa el commit.
    const healthy = new MemoryObjectStore('buoh-test', target.objects.objects);
    target.metadata.failCommit = false;
    await publishDataset({
      environment: 'test',
      metadata: target.metadata,
      objects: healthy,
      profile: fixture.profile,
      publication_id: PUBLICATION_B,
      published_at_utc: PUBLISHED_AT,
      segments: scenario('principal').segments,
      zlibVersion: ZLIB_VERSION,
    });
    const report = await replay(
      { metadata: target.metadata, objects: healthy },
      MAIN_DATASET_ID,
      'recompute',
    );
    expect(report.status).toBe('reproduced');
  });

  it('no sobrescribe ni duplica una publicación activa', async () => {
    const target = stores();
    await publish(target, 'principal');
    const before = new Map(target.objects.objects);
    const error: unknown = await publish(target, 'principal', PUBLICATION_B).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PublicationConflictError);
    expect(target.metadata.records).toHaveLength(1);
    expect(target.objects.objects).toEqual(before);
  });
});

/**
 * Construye una publicación cuyos hashes, core, `dataset_id`, documento y record son coherentes
 * entre sí, pero con un cambio respecto a la recomputación legítima. Simula un writer defectuoso.
 */
function forge(
  target: ReturnType<typeof stores>,
  base: DatasetPublication,
  change: {
    core?: (core: DatasetManifestCore) => DatasetManifestCore;
    ticks?: (ticks: MarketTick[]) => MarketTick[];
  },
): string {
  const bucket = target.objects.bucket;
  let core: DatasetManifestCore = structuredClone(base.core);
  const storage = base.manifest.storage_objects.map((object) => ({ ...object }));
  const bytesById = new Map(base.objects);

  if (change.ticks !== undefined) {
    const ticks = change.ticks([...base.derived.ticks]);
    const bytes = ndjsonBytes(ticks);
    const digest = sha256Hex(bytes);
    core = {
      ...core,
      event_time_from_utc: ticks[0]?.event_time_utc ?? null,
      event_time_to_utc: ticks.at(-1)?.event_time_utc ?? null,
      logical_artifacts: core.logical_artifacts.map((artifact) =>
        artifact.artifact_id === 'normalized_ticks:000000'
          ? { ...artifact, logical_content_sha256: digest, record_count: ticks.length }
          : artifact,
      ),
      normalized_tick_count: ticks.length,
    };
    const index = storage.findIndex((object) => object.artifact_id === 'normalized_ticks:000000');
    const previous = storage[index];
    if (previous === undefined) {
      throw new TypeError('Falta normalized_ticks:000000.');
    }
    storage[index] = {
      ...previous,
      logical_content_sha256: digest,
      object_bytes_sha256: digest,
      size_bytes: bytes.byteLength,
      uri: objectUri(bucket, contentKey(digest)),
    };
    bytesById.set('normalized_ticks:000000', bytes);
  }
  if (change.core !== undefined) {
    core = change.core(core);
  }

  const parsedCore = datasetManifestCoreSchema.parse(core);
  const datasetId = deriveDatasetId(parsedCore);
  const manifest = datasetManifestSchema.parse({
    ...base.manifest,
    dataset_id: datasetId,
    manifest_core: parsedCore,
    storage_objects: storage,
  });
  const manifestBytes = canonicalJsonBytes(manifest);
  const digest = sha256Hex(manifestBytes);
  const uri = objectUri(
    bucket,
    manifestKey({
      dataset_id: datasetId,
      manifest_document_sha256: digest,
      publication_id: manifest.publication_id,
    }),
  );
  const record = validatePublicationRecord(
    {
      ...base.record,
      dataset_id: datasetId,
      manifest_document_sha256: digest,
      manifest_object_bytes_sha256: digest,
      manifest_object_uri: uri,
    },
    manifest,
  );
  for (const object of manifest.storage_objects) {
    const bytes = bytesById.get(object.artifact_id);
    if (bytes === undefined) {
      throw new TypeError(`Sin bytes: ${object.artifact_id}`);
    }
    target.objects.objects.set(contentKey(object.object_bytes_sha256), bytes);
  }
  target.objects.objects.set(keyFromUri(uri, bucket) ?? '', manifestBytes);
  target.metadata.records.push({ environment: 'test', record });
  return datasetId;
}

describe('F1-DATASET-001: data:replay (ADR-0004 §9)', () => {
  it.each([
    ['principal', MAIN_DATASET_ID],
    ['zero-valid-ticks', ZERO_DATASET_ID],
  ] as const)('recomputa y verifica %s sin reloj, aleatoriedad ni red', async (name, datasetId) => {
    const target = stores();
    const publication = await publish(target, name);
    forbidAmbientEffects();

    const verified = await replay(target, datasetId, 'verify-only');
    const reproduced = await replay(target, datasetId, 'recompute');
    expect(verified.status).toBe('verified');
    expect(reproduced.status).toBe('reproduced');
    for (const report of [verified, reproduced]) {
      expect(report).toMatchObject({
        condition_event_count: publication.core.condition_event_count,
        dataset_id: datasetId,
        deployment_environment: 'test',
        incident_count: publication.core.incident_count,
        normalized_tick_count: publication.core.normalized_tick_count,
        publication_id: PUBLICATION_A,
        raw_frame_count: publication.core.raw_frame_count,
        source_event_count: publication.core.source_event_count,
      });
    }
  });

  it('detecta un objeto alterado en ambos modos', async () => {
    const target = stores();
    const publication = await publish(target, 'principal');
    const ticks = publication.manifest.storage_objects.find(
      (object) => object.artifact_id === 'normalized_ticks:000000',
    );
    const key = contentKey(ticks?.object_bytes_sha256 ?? '');
    const original = target.objects.objects.get(key) ?? new Uint8Array();
    const altered = Uint8Array.from(original);
    altered[0] = 0x20;
    target.objects.objects.set(key, altered);
    const error = await expectReplayError(
      replay(target, MAIN_DATASET_ID, 'verify-only'),
      'OBJECT_INTEGRITY',
    );
    expect(error.details).toMatchObject({ artifact_id: 'normalized_ticks:000000' });
    await expectReplayError(replay(target, MAIN_DATASET_ID, 'recompute'), 'OBJECT_INTEGRITY');
  });

  it('detecta un documento canónico alterado', async () => {
    const target = stores();
    const publication = await publish(target, 'principal');
    const key = keyFromUri(publication.record.manifest_object_uri, 'buoh-test') ?? '';
    target.objects.objects.set(key, new TextEncoder().encode(' '));
    await expectReplayError(replay(target, MAIN_DATASET_ID, 'verify-only'), 'MANIFEST_INTEGRITY');
  });

  it('rechaza objetos fuera del bucket configurado', async () => {
    const shared = new Map<string, Uint8Array>();
    const elsewhere = {
      metadata: new MemoryMetadataStore(),
      objects: new MemoryObjectStore('otro-bucket', shared),
    };
    await publish(elsewhere, 'principal');
    const target = {
      metadata: elsewhere.metadata,
      objects: new MemoryObjectStore('buoh-test', shared),
    };
    await expectReplayError(
      replay(target, MAIN_DATASET_ID, 'verify-only'),
      'OBJECT_LOCATION_UNSUPPORTED',
    );
  });

  it('--verify-only demuestra integridad, no el normalizador', async () => {
    const target = stores();
    const base = await publish(target, 'principal');
    // Un tick menos, con conteos y extremos coherentes: íntegro, pero no reproducible.
    const forged = forge(target, base, { ticks: (ticks) => ticks.slice(0, -1) });

    expect((await replay(target, forged, 'verify-only')).status).toBe('verified');
    const error = await expectReplayError(
      replay(target, forged, 'recompute'),
      'RECOMPUTATION_MISMATCH',
    );
    expect(error.details).toEqual({
      differing_artifacts: ['normalized_ticks:000000'],
      recomputed_dataset_id: MAIN_DATASET_ID,
    });
  });

  it('aborta ante una versión no implementada en lugar de migrar', async () => {
    const target = stores();
    const base = await publish(target, 'principal');
    const forged = forge(target, base, {
      core: (core) => ({ ...core, normalizer_version: '2.0.0' }),
    });

    // La versión del normalizador solo afecta a la recomputación.
    expect((await replay(target, forged, 'verify-only')).status).toBe('verified');
    const error = await expectReplayError(
      replay(target, forged, 'recompute'),
      'VERSION_UNSUPPORTED',
    );
    expect(error.details).toEqual({ fields: ['normalizer_version'] });
  });

  it('--verify-only aborta ante una versión de contrato no implementada', async () => {
    const target = stores();
    const base = await publish(target, 'principal');
    const forged = forge(target, base, {
      core: (core) => ({ ...core, market_tick_schema_version: '2.0.0' }),
    });
    for (const mode of ['verify-only', 'recompute'] as const) {
      const error = await expectReplayError(replay(target, forged, mode), 'VERSION_UNSUPPORTED');
      expect(error.details).toEqual({ fields: ['market_tick_schema_version'] });
    }
  });

  const inconsistencies: [string, Parameters<typeof forge>[2], string | undefined][] = [
    [
      'ticks fuera de orden canónico',
      {
        ticks: (ticks) => {
          const [first, second, ...rest] = ticks;
          return first === undefined || second === undefined ? ticks : [second, first, ...rest];
        },
      },
      'DATASET_ORDER_INVALID',
    ],
    [
      'extremo temporal que no es el primer tick',
      { core: (core) => ({ ...core, event_time_from_utc: '2000-01-01T00:00:00.000Z' }) },
      'DATASET_RANGE_MISMATCH',
    ],
    [
      'tick sin raw correspondiente',
      {
        ticks: (ticks) =>
          ticks.map((tick, index) =>
            index === 0
              ? { ...tick, observation_id: '019b76da-cb28-7003-8000-00000000dead' }
              : tick,
          ),
      },
      'DATASET_REFERENCE_UNKNOWN',
    ],
    [
      'tick de otra fuente',
      {
        ticks: (ticks) =>
          ticks.map((tick, index) => {
            if (index !== 0) {
              return tick;
            }
            const moved = { ...tick, source: 'otra-fuente' };
            return { ...moved, tick_fingerprint_sha256: deriveTickFingerprint(moved) };
          }),
      },
      'DATASET_PROVENANCE_MISMATCH',
    ],
    [
      'perfil de calidad distinto del declarado',
      { core: (core) => ({ ...core, quality_profile_id: 'otro-perfil' }) },
      undefined,
    ],
  ];

  it.each(inconsistencies)(
    '--verify-only rechaza un dataset íntegro pero inconsistente: %s',
    async (_label, change, contractCode) => {
      const target = stores();
      const base = await publish(target, 'principal');
      const forged = forge(target, base, change);
      for (const mode of ['verify-only', 'recompute'] as const) {
        const error = await expectReplayError(replay(target, forged, mode), 'CONTRACT_INVALID');
        if (contractCode !== undefined) {
          expect(error.details).toMatchObject({ contract_code: contractCode });
        }
      }
    },
  );

  it('no descomprime por encima del límite', () => {
    const encode = createStorageEncoder(ZLIB_VERSION);
    const logical = new Uint8Array(4096);
    const encoded = encode({
      artifact_id: 'source_events:000000',
      logical_bytes: logical,
      role: 'source_events',
    });
    const object = {
      artifact_id: 'source_events:000000',
      compression: 'gzip',
      logical_content_sha256: sha256Hex(logical),
      media_type: 'application/x-ndjson',
      object_bytes_sha256: sha256Hex(encoded.bytes),
      role: 'source_events',
      size_bytes: encoded.bytes.byteLength,
      uri: 's3://buoh-test/x',
      writer_name: 'node:zlib',
      writer_version: ZLIB_VERSION,
    } as const;
    expect(decodeObject(object, encoded.bytes, 4096).byteLength).toBe(4096);
    expect(() => decodeObject(object, encoded.bytes, 4095)).toThrow();
  });
});

describe('configuración, argumentos e identificadores', () => {
  it('interpreta los argumentos de data:replay', () => {
    expect(parseReplayArgs(['--', '--dataset', MAIN_DATASET_ID])).toEqual({
      datasetId: MAIN_DATASET_ID,
      mode: 'recompute',
    });
    expect(parseReplayArgs(['--dataset', MAIN_DATASET_ID, '--verify-only'])).toEqual({
      datasetId: MAIN_DATASET_ID,
      mode: 'verify-only',
    });
    expect(() => parseReplayArgs([])).toThrow(UsageError);
    expect(() => parseReplayArgs(['--dataset', 'sha256:abc'])).toThrow(UsageError);
    expect(() => parseReplayArgs(['--dataset', MAIN_DATASET_ID, '--publish'])).toThrow(UsageError);
  });

  it('informa variables ausentes sin revelar valores', () => {
    const secret = 'valor-que-no-debe-aparecer';
    let error: unknown;
    try {
      loadConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: 'test', BUOH_POSTGRES_PASSWORD: secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variables).toEqual([
      'BUOH_S3_ACCESS_KEY_ID',
      'BUOH_S3_SECRET_ACCESS_KEY',
    ]);
    expect((error as ConfigError).message).not.toContain(secret);
  });

  it('genera UUIDv7 desde reloj y entropía inyectados', () => {
    const next = createUuidV7Generator({
      now: () => 0x019b76dacb28,
      randomBytes: (size) => new Uint8Array(size).fill(0xff),
    });
    const value = next();
    expect(value).toBe('019b76da-cb28-7fff-bfff-ffffffffffff');
    expect(uuidV7Schema.safeParse(value).success).toBe(true);
  });

  it('solo resuelve URIs del bucket configurado y sin traversal', () => {
    expect(keyFromUri('s3://buoh-test/sha256/abc', 'buoh-test')).toBe('sha256/abc');
    expect(keyFromUri('s3://otro/sha256/abc', 'buoh-test')).toBeNull();
    expect(keyFromUri('s3://buoh-test/../x', 'buoh-test')).toBeNull();
    expect(keyFromUri('fixture://x', 'buoh-test')).toBeNull();
  });
});
