import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { canonicalJson, sha256Hex } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  createDerivMeasurementProfile,
  createDerivPublicationProfile,
  DERIV_PUBLICATION_THRESHOLDS,
} from '../src/deriv/profile.js';
import {
  createStorageEncoder,
  loadSyntheticFixture,
  MAX_MANIFEST_DOCUMENT_BYTES,
  MAX_REPLAY_OBJECT_BYTES,
  MAX_SOURCE_SEGMENT_BYTES,
  PublicationConflictError,
  PublicationLimitError,
  publishDataset,
  REPLAY_READ_LIMITS,
  replayDataset,
  type ReplayReadLimits,
} from '../src/index.js';
import { syntheticSchemas } from './support/connection-harness.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// La publicación de los datasets vivos en el worker, primera parte (ADR-0020 §2 y §7; PR 3a de su
// §13): el perfil de publicación de Deriv, los derivados en gzip y los límites del replay antes de
// escribir nada. Sin red, reloj real ni aleatoriedad.

describe('perfil de publicación de Deriv (ADR-0020 §1 y §2)', () => {
  const schemas = syntheticSchemas();

  it('fija los umbrales medidos de R_100, las reglas 3.0.0 y las respuestas que no son ticks', () => {
    const profile = createDerivPublicationProfile({ schemas, symbol: 'R_100' });
    const expected = {
      allowed_symbols: ['R_100'],
      gap_detection: 'after_reconnection',
      maximum_delivery_delay_ms: 3000,
      maximum_event_gap_ms: 2000,
      non_tick_msg_types: ['active_symbols', 'forget_all', 'history', 'ping', 'time'],
      profile_id: 'deriv_options-publication-v1-R_100',
      quality_rule_version: '3.0.0',
      source: 'deriv_options',
    };
    expect(Buffer.from(profile.quality_profile_bytes).toString('utf8')).toBe(
      canonicalJson(expected),
    );
    expect(profile.quality_profile_sha256).toBe(sha256Hex(canonicalJson(expected)));
    expect(profile).toMatchObject({
      connector_version: 'deriv-options-ws-1.1.0',
      purpose: 'publication',
      source_schema_release: schemas.release,
    });
    expect(profile.rules.quality_rule_version).toBe('3.0.0');
    expect(DERIV_PUBLICATION_THRESHOLDS).toEqual({
      R_100: { maximum_delivery_delay_ms: 3000, maximum_event_gap_ms: 2000 },
    });
  });

  it('usa el mismo esquema de fuente que el perfil de medición, que no cambia', () => {
    const publication = createDerivPublicationProfile({ schemas, symbol: 'R_100' });
    const measurement = createDerivMeasurementProfile({ schemas, symbol: 'R_100' });
    expect(publication.source_schema_sha256).toBe(measurement.source_schema_sha256);
    expect(JSON.parse(Buffer.from(measurement.quality_profile_bytes).toString('utf8'))).toEqual({
      allowed_symbols: ['R_100'],
      gap_detection: 'after_reconnection',
      non_tick_msg_types: ['active_symbols', 'forget_all', 'history', 'ping', 'time'],
      profile_id: 'deriv_options-measurement-v2-R_100',
      purpose: 'measurement',
      quality_rule_version: '2.0.0',
      source: 'deriv_options',
    });
  });

  it('rechaza un símbolo sin umbrales medidos', () => {
    expect(() => createDerivPublicationProfile({ schemas, symbol: 'R_50' })).toThrow(
      /R_50 no tiene umbrales medidos/u,
    );
  });
});

describe('derivados en gzip (ADR-0020 §7, «Formato físico»)', () => {
  const logical = new TextEncoder().encode('{"a":1}\n{"a":2}\n');

  it.each(['normalized_ticks', 'quality_incidents', 'operational_conditions'] as const)(
    'con derived gzip, %s va en gzip determinista con su writer, y se descomprime igual',
    (role) => {
      const encode = createStorageEncoder('test-zlib', { derived: 'gzip' });
      const first = encode({ artifact_id: `${role}:000000`, logical_bytes: logical, role });
      const second = encode({ artifact_id: `${role}:000000`, logical_bytes: logical, role });
      expect(first).toMatchObject({
        compression: 'gzip',
        writer_name: 'node:zlib',
        writer_version: 'test-zlib',
      });
      expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
      expect(Buffer.from(gunzipSync(first.bytes)).equals(Buffer.from(logical))).toBe(true);
    },
  );

  it('sin la opción, los derivados siguen sin comprimir, como en los vectores', () => {
    const encode = createStorageEncoder('test-zlib');
    expect(
      encode({
        artifact_id: 'normalized_ticks:000000',
        logical_bytes: logical,
        role: 'normalized_ticks',
      }),
    ).toEqual({ bytes: logical, compression: 'none' });
  });

  it('el perfil y el esquema nunca se comprimen', () => {
    const encode = createStorageEncoder('test-zlib', { derived: 'gzip' });
    for (const role of ['quality_profile', 'source_schema'] as const) {
      expect(encode({ artifact_id: `${role}:000000`, logical_bytes: logical, role })).toEqual({
        bytes: logical,
        compression: 'none',
      });
    }
  });
});

describe('publicar con los derivados en gzip y los límites del replay', () => {
  const PUBLICATION = '019b76da-cb28-7003-8000-0000000000a1';

  async function publish(options: Partial<Parameters<typeof publishDataset>[0]> = {}) {
    const fixture = await loadSyntheticFixture(
      resolve(import.meta.dirname, '../../../test-vectors/market-data/v1'),
    );
    const principal = fixture.scenarios.find((item) => item.name === 'principal');
    if (principal === undefined) {
      throw new TypeError('Falta el escenario principal.');
    }
    const target = { metadata: new MemoryMetadataStore(), objects: new MemoryObjectStore() };
    const result = publishDataset({
      environment: 'test',
      metadata: target.metadata,
      objects: target.objects,
      profile: fixture.profile,
      publication_id: PUBLICATION,
      published_at_utc: '2026-01-01T00:00:09.000Z',
      segments: principal.segments,
      zlibVersion: 'test-zlib',
      ...options,
    });
    return { result, target };
  }

  it('con los derivados en gzip, el dataset_id no cambia y se reproduce en los dos modos', async () => {
    const plain = await (await publish()).result;
    const { result, target } = await publish({ derivedCompression: 'gzip' });
    const gzip = await result;
    expect(gzip.dataset_id).toBe(plain.dataset_id);
    const derived = gzip.manifest.storage_objects.filter((object) =>
      ['normalized_ticks', 'quality_incidents', 'operational_conditions'].includes(object.role),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((object) => object.compression === 'gzip')).toBe(true);
    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId: gzip.dataset_id,
        environment: 'test',
        metadata: target.metadata,
        mode,
        objects: target.objects,
      });
      expect(report.status).toBe(mode === 'recompute' ? 'reproduced' : 'verified');
    }
  });

  it('los límites por defecto son los de lectura del replay', () => {
    expect(REPLAY_READ_LIMITS).toEqual({
      gzip_logical_bytes: MAX_SOURCE_SEGMENT_BYTES,
      manifest_document_bytes: MAX_MANIFEST_DOCUMENT_BYTES,
      object_bytes: MAX_REPLAY_OBJECT_BYTES,
    });
  });

  it('cada límite admite justo su tamaño y rechaza un byte menos; el de gzip mide los bytes lógicos', async () => {
    const reference = await (await publish({ derivedCompression: 'gzip' })).result;
    const gzip = reference.manifest.storage_objects.filter(
      (object) => object.compression === 'gzip',
    );
    const physical = Math.max(
      ...reference.manifest.storage_objects.map((object) => object.size_bytes),
    );
    const logical = Math.max(
      ...gzip.map(
        (object) =>
          gunzipSync(reference.objects.get(object.artifact_id) ?? new Uint8Array()).byteLength,
      ),
    );
    const physicalGzip = Math.max(...gzip.map((object) => object.size_bytes));
    // Hay un objeto en gzip cuyo tamaño lógico pasa el físico de todos los que van en gzip.
    expect(logical).toBeGreaterThan(physicalGzip);
    const manifest = reference.manifest_bytes.byteLength;
    const outcome = async (limits: Partial<ReplayReadLimits>) => {
      const { result } = await publish({
        derivedCompression: 'gzip',
        limits: { ...REPLAY_READ_LIMITS, ...limits },
      });
      return result.then(
        () => 'published',
        (error: unknown) => (error instanceof PublicationLimitError ? error.limit : 'other'),
      );
    };
    expect(await outcome({ object_bytes: physical })).toBe('published');
    expect(await outcome({ object_bytes: physical - 1 })).toBe('object_bytes');
    expect(await outcome({ gzip_logical_bytes: logical })).toBe('published');
    expect(await outcome({ gzip_logical_bytes: logical - 1 })).toBe('gzip_logical_bytes');
    // Un límite entre el tamaño físico y el lógico: lo pasan los bytes lógicos.
    expect(await outcome({ gzip_logical_bytes: physicalGzip })).toBe('gzip_logical_bytes');
    expect(await outcome({ manifest_document_bytes: manifest })).toBe('published');
    expect(await outcome({ manifest_document_bytes: manifest - 1 })).toBe(
      'manifest_document_bytes',
    );
  });

  it('un dataset que ya está publicado se rechaza en la consulta previa, antes de escribir', async () => {
    const { result, target } = await publish();
    await result;
    const before = new Map(target.objects.objects);
    const fixture = await loadSyntheticFixture(
      resolve(import.meta.dirname, '../../../test-vectors/market-data/v1'),
    );
    const principal = fixture.scenarios.find((item) => item.name === 'principal');
    const error: unknown = await publishDataset({
      environment: 'test',
      metadata: target.metadata,
      objects: target.objects,
      profile: fixture.profile,
      publication_id: '019b76da-cb28-7003-8000-0000000000b2',
      published_at_utc: '2026-01-01T00:00:10.000Z',
      segments: principal?.segments ?? [],
      zlibVersion: 'test-zlib',
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PublicationConflictError);
    expect(error).toMatchObject({ step: 'precondition' });
    expect(target.objects.objects).toEqual(before);
  });

  it.each([
    ['un objeto físico', { object_bytes: 100 }, 'object_bytes'],
    ['los bytes lógicos de un objeto en gzip', { gzip_logical_bytes: 100 }, 'gzip_logical_bytes'],
    ['el documento del manifiesto', { manifest_document_bytes: 100 }, 'manifest_document_bytes'],
  ] as const)(
    'si %s pasa su límite, no escribe nada ni hace el commit',
    async (_label, override, limit) => {
      const { result, target } = await publish({
        derivedCompression: 'gzip',
        limits: { ...REPLAY_READ_LIMITS, ...override },
      });
      const error: unknown = await result.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(PublicationLimitError);
      expect(error).toMatchObject({
        limit,
        reason: 'publication_limit_exceeded',
        step: 'precondition',
      });
      expect(target.objects.objects.size).toBe(0);
      expect(target.metadata.records).toEqual([]);
    },
  );
});
