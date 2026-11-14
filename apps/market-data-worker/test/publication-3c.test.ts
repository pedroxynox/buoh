import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InMemoryObjectStore,
  loadSyntheticFixture,
  preparePublication,
  replayDataset,
  writePublication,
} from '../src/index.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// La publicación con las claves de los datasets vivos (ADR-0020 §5: `datasets/sha256/<hash>` y
// `datasets/manifests/<dataset_id>/<publication_id>/<hash>.json`) y los objetos 8 a la vez (§8).

const VECTORS = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const PUBLICATION = '019b76da-cb28-7003-8000-0000000000c1';

async function prepared(keyPrefix?: string) {
  const fixture = await loadSyntheticFixture(VECTORS);
  const principal = fixture.scenarios.find((item) => item.name === 'principal');
  if (principal === undefined) throw new TypeError('Falta principal.');
  return preparePublication({
    environment: 'test',
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
    objects: new MemoryObjectStore('buoh-captura'),
    profile: fixture.profile,
    publication_id: PUBLICATION,
    published_at_utc: '2026-01-01T00:00:09.000Z',
    segments: principal.segments,
    zlibVersion: 'test-zlib',
  });
}

describe('el prefijo de las claves (ADR-0020 §5)', () => {
  it('las URI del manifiesto y del documento llevan el prefijo, y el dataset_id no cambia', async () => {
    const plain = await prepared();
    const live = await prepared('datasets/');
    expect(live.dataset_id).toBe(plain.dataset_id);
    for (const object of live.manifest.storage_objects) {
      expect(object.uri).toBe(`s3://buoh-captura/datasets/sha256/${object.object_bytes_sha256}`);
    }
    expect(live.record.manifest_object_uri).toBe(
      `s3://buoh-captura/datasets/manifests/${live.dataset_id}/${PUBLICATION}/${live.record.manifest_document_sha256}.json`,
    );
    expect(plain.record.manifest_object_uri).toMatch(/^s3:\/\/buoh-captura\/manifests\//u);
  });

  it('escribe bajo el prefijo, y el replay lo lee con el bucket sin prefijo', async () => {
    const live = await prepared('datasets/');
    const objects = new MemoryObjectStore('buoh-captura');
    const metadata = new MemoryMetadataStore();
    await writePublication(live, { environment: 'test', metadata, objects });
    expect([...objects.objects.keys()].every((key) => key.startsWith('datasets/'))).toBe(true);
    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId: live.dataset_id,
        environment: 'test',
        keyPrefix: 'datasets/',
        metadata,
        mode,
        objects: new InMemoryObjectStore('buoh-captura', objects.objects),
      });
      expect(report.dataset_id).toBe(live.dataset_id);
    }
  });

  it('el replay rechaza un objeto o un manifiesto fuera de su prefijo', async () => {
    for (const [written, read] of [
      ['datasets/', ''],
      ['', 'datasets/'],
      ['otros/', 'datasets/'],
    ] as const) {
      const publication = await prepared(written);
      const objects = new MemoryObjectStore('buoh-captura');
      const metadata = new MemoryMetadataStore();
      await writePublication(publication, { environment: 'test', metadata, objects });
      await expect(
        replayDataset({
          datasetId: publication.dataset_id,
          environment: 'test',
          keyPrefix: read,
          metadata,
          mode: 'verify-only',
          objects,
        }),
        `${written} leído con ${read}`,
      ).rejects.toMatchObject({ code: 'OBJECT_LOCATION_UNSUPPORTED' });
    }
  });

  it('el replay rechaza un manifiesto fuera del prefijo aunque sus objetos estén dentro', async () => {
    const live = await prepared('datasets/');
    const objects = new MemoryObjectStore('buoh-captura');
    const metadata = new MemoryMetadataStore();
    await writePublication(live, { environment: 'test', metadata, objects });
    // El mismo documento, también bajo otro prefijo, y el record apuntando a esa copia.
    const documentKey = live.record.manifest_object_uri.replace('s3://buoh-captura/', '');
    const elsewhere = documentKey.replace(/^datasets\//u, 'otros/');
    objects.objects.set(elsewhere, objects.objects.get(documentKey) ?? new Uint8Array());
    const [stored] = metadata.records;
    if (stored === undefined) throw new Error('sin record');
    metadata.records[0] = {
      ...stored,
      record: { ...stored.record, manifest_object_uri: `s3://buoh-captura/${elsewhere}` },
    };
    const replay = (keyPrefix: string) =>
      replayDataset({
        datasetId: live.dataset_id,
        environment: 'test',
        keyPrefix,
        metadata,
        mode: 'verify-only',
        objects,
      });
    await expect(replay('datasets/')).rejects.toMatchObject({
      code: 'OBJECT_LOCATION_UNSUPPORTED',
    });
    // Con el record en su sitio, sí.
    metadata.records[0] = stored;
    await expect(replay('datasets/')).resolves.toMatchObject({ status: 'verified' });
  });

  it('rechaza un prefijo que no son segmentos con su barra', async () => {
    for (const prefix of ['datasets', '/datasets/', 'datasets//', '../datasets/', 'Datasets/']) {
      await expect(prepared(prefix), prefix).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe('los objetos varios a la vez (ADR-0020 §8)', () => {
  /** Un almacén que cuenta las escrituras en curso y puede hacer fallar una. */
  class CountingStore extends MemoryObjectStore {
    active = 0;
    peak = 0;
    writes = 0;
    failAt: number | null = null;

    override async putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
      this.writes += 1;
      const mine = this.writes;
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      await new Promise((done) => {
        setTimeout(done, 2);
      });
      this.active -= 1;
      if (mine === this.failAt) {
        throw Object.assign(new Error('caído'), { code: 'ECONNRESET' });
      }
      return super.putIfAbsent(key, bytes);
    }
  }

  it('con concurrency 8 escribe como mucho 8 a la vez, todos antes del documento', async () => {
    const live = await prepared('datasets/');
    const objects = new CountingStore('buoh-captura');
    await writePublication(live, {
      concurrency: 8,
      environment: 'test',
      metadata: new MemoryMetadataStore(),
      objects,
    });
    const count = live.manifest.storage_objects.length;
    expect(count).toBeGreaterThan(2);
    expect(objects.peak).toBe(Math.min(8, count));
    expect(objects.writes).toBe(count + 1);
  });

  it('dos artefactos con los mismos bytes comparten clave y se escriben una sola vez', async () => {
    const fixture = await loadSyntheticFixture(VECTORS);
    const zero = fixture.scenarios.find((item) => item.name === 'zero-valid-ticks');
    if (zero === undefined) throw new TypeError('Falta zero-valid-ticks.');
    const live = preparePublication({
      derivedCompression: 'gzip',
      environment: 'test',
      keyPrefix: 'datasets/',
      objects: new MemoryObjectStore('buoh-captura'),
      profile: fixture.profile,
      publication_id: PUBLICATION,
      published_at_utc: '2026-01-01T00:00:09.000Z',
      segments: zero.segments,
      zlibVersion: 'test-zlib',
    });
    const uris = live.manifest.storage_objects.map((object) => object.uri);
    const distinct = new Set(uris).size;
    // Las partes vacías, en gzip, tienen los mismos bytes.
    expect(distinct).toBeLessThan(uris.length);
    const objects = new CountingStore('buoh-captura');
    const metadata = new MemoryMetadataStore();
    await writePublication(live, { concurrency: 8, environment: 'test', metadata, objects });
    expect(objects.writes).toBe(distinct + 1);
    const report = await replayDataset({
      datasetId: live.dataset_id,
      environment: 'test',
      keyPrefix: 'datasets/',
      metadata,
      mode: 'recompute',
      objects,
    });
    expect(report.dataset_id).toBe(live.dataset_id);
  });

  it('por defecto, de uno en uno', async () => {
    const live = await prepared('datasets/');
    const objects = new CountingStore('buoh-captura');
    await writePublication(live, {
      environment: 'test',
      metadata: new MemoryMetadataStore(),
      objects,
    });
    expect(objects.peak).toBe(1);
  });

  it('si una falla, no empieza otras, espera a las que van, no escribe el documento ni hace el commit', async () => {
    const live = await prepared('datasets/');
    const objects = new CountingStore('buoh-captura');
    objects.failAt = 1;
    const metadata = new MemoryMetadataStore();
    const failure = await writePublication(live, {
      concurrency: 2,
      environment: 'test',
      metadata,
      objects,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ step: 'normalized_object_write' });
    expect(objects.active).toBe(0);
    expect(objects.writes).toBeLessThanOrEqual(3);
    expect([...objects.objects.keys()].some((key) => key.includes('manifests/'))).toBe(false);
    expect(metadata.records).toHaveLength(0);
  });

  it('rechaza un concurrency que no es un entero positivo', async () => {
    const live = await prepared('datasets/');
    for (const concurrency of [0, -1, 1.5]) {
      await expect(
        writePublication(live, {
          concurrency,
          environment: 'test',
          metadata: new MemoryMetadataStore(),
          objects: new MemoryObjectStore('buoh-captura'),
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });
});
