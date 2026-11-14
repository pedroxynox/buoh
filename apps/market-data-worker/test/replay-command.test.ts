import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadSyntheticFixture,
  publishDataset,
  replayCommand,
  type ReplayCommandDependencies,
  type WorkerConfig,
} from '../src/index.js';
import { MemoryMetadataStore, MemoryObjectStore } from './support/memory-stores.js';

// `data:replay` (ADR-0020 §8, paso 7; PR 3c de su §13): en `production` lee siempre `buoh_datasets`
// y los objetos del bucket con sus claves, que llevan el prefijo `datasets/`, sin
// `BUOH_POSTGRES_SCHEMA`, y cada salida informa la memoria máxima de su proceso (§7).

const DATASET = `sha256:${'a'.repeat(64)}`;
const VECTORS = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const PUBLICATION_A = '019b76da-cb28-7003-8000-0000000000d1';
const PUBLICATION_B = '019b76da-cb28-7003-8000-0000000000d2';
const BASE = {
  BUOH_POSTGRES_PASSWORD: 'sintetica-0123456789',
  BUOH_S3_ACCESS_KEY_ID: 'sintetica',
  BUOH_S3_SECRET_ACCESS_KEY: 'sintetica',
};
const PRODUCTION = {
  ...BASE,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_SSLMODE: 'verify-full',
  BUOH_S3_BUCKET: 'buoh-captura',
};

function harness() {
  const opened: WorkerConfig[] = [];
  let closed = 0;
  const dependencies: ReplayCommandDependencies = {
    maxRssBytes: () => 64 * 1048576,
    openStores: (config) => {
      opened.push(config);
      return {
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
        metadata: new MemoryMetadataStore(),
        objects: new MemoryObjectStore(config.s3.bucket),
      };
    },
  };
  return { closed: () => closed, dependencies, opened };
}

describe('replayCommand (ADR-0020 §8)', () => {
  it('en production lee buoh_datasets y el bucket sin prefijo, e informa su memoria', async () => {
    const { closed, dependencies, opened } = harness();
    const result = await replayCommand(
      ['--dataset', DATASET, '--verify-only'],
      PRODUCTION,
      dependencies,
    );
    expect(opened.map((config) => [config.postgres.schema, config.s3.keyPrefix])).toEqual([
      ['buoh_datasets', ''],
    ]);
    // Sin publicación, el replay falla como siempre, con su código, y la línea lleva la memoria.
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toEqual({
      code: 'DATASET_NOT_PUBLISHED',
      dataset_id: DATASET,
      details: expect.any(Object) as unknown,
      max_rss_bytes: 64 * 1048576,
      message: expect.any(String) as unknown,
      mode: 'verify-only',
      status: 'failed',
    });
    expect(closed()).toBe(1);
  });

  it('con buoh_datasets reproduce un dataset con sus claves bajo datasets/, y con otro esquema no', async () => {
    const fixture = await loadSyntheticFixture(VECTORS);
    const principal = fixture.scenarios.find((item) => item.name === 'principal');
    if (principal === undefined) throw new TypeError('Falta principal.');
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore('buoh-captura');
    for (const environment of ['production', 'test'] as const) {
      await publishDataset({
        environment,
        keyPrefix: 'datasets/',
        metadata,
        objects,
        profile: fixture.profile,
        publication_id: environment === 'production' ? PUBLICATION_A : PUBLICATION_B,
        published_at_utc: '2026-01-01T00:00:09.000Z',
        segments: principal.segments,
        zlibVersion: 'test-zlib',
      });
    }
    const dependencies: ReplayCommandDependencies = {
      maxRssBytes: () => 1,
      openStores: () => ({ close: () => Promise.resolve(), metadata, objects }),
    };
    const dataset = metadata.records[0]?.record.dataset_id ?? '';
    const production = await replayCommand(['--dataset', dataset], PRODUCTION, dependencies);
    expect(JSON.parse(production.line)).toMatchObject({ status: 'reproduced' });
    expect(production.exitCode).toBe(0);
    const test = await replayCommand(
      ['--dataset', dataset],
      { ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: 'test', BUOH_S3_BUCKET: 'buoh-captura' },
      dependencies,
    );
    expect(test.exitCode).toBe(1);
    expect(JSON.parse(test.line)).toMatchObject({ code: 'OBJECT_LOCATION_UNSUPPORTED' });
    // Con buoh_datasets, también fuera de production: sus claves llevan el prefijo.
    const datasets = await replayCommand(
      ['--dataset', dataset],
      {
        ...BASE,
        BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
        BUOH_POSTGRES_SCHEMA: 'buoh_datasets',
        BUOH_S3_BUCKET: 'buoh-captura',
      },
      dependencies,
    );
    expect(JSON.parse(datasets.line)).toMatchObject({ status: 'reproduced' });
  });

  it('en production rechaza BUOH_POSTGRES_SCHEMA, sin abrir nada: salida 2', async () => {
    const { dependencies, opened } = harness();
    const result = await replayCommand(
      ['--dataset', DATASET],
      { ...PRODUCTION, BUOH_POSTGRES_SCHEMA: 'buoh_log_000001' },
      dependencies,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({ code: 'ConfigError', status: 'failed' });
    expect(result.line).toContain('BUOH_POSTGRES_SCHEMA');
    expect(opened).toEqual([]);
  });

  it('fuera de production sigue con BUOH_POSTGRES_SCHEMA y sin prefijo', async () => {
    const { dependencies, opened } = harness();
    await replayCommand(
      ['--dataset', DATASET],
      { ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: 'test', BUOH_POSTGRES_SCHEMA: 'buoh_prueba' },
      dependencies,
    );
    expect(opened.map((config) => [config.postgres.schema, config.s3.keyPrefix])).toEqual([
      ['buoh_prueba', ''],
    ]);
  });

  it('un error de uso sale con 2 sin abrir nada', async () => {
    const { dependencies, opened } = harness();
    const result = await replayCommand(['--dataset', 'x'], PRODUCTION, dependencies);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(opened).toEqual([]);
  });

  it('un error inesperado sale con 1 y UNEXPECTED, sin su mensaje', async () => {
    const { dependencies } = harness();
    const failing: ReplayCommandDependencies = {
      ...dependencies,
      openStores: () => {
        throw new RangeError('secreto en el mensaje');
      },
    };
    const result = await replayCommand(['--dataset', DATASET], PRODUCTION, failing);
    expect(result.exitCode).toBe(1);
    expect(result.line).not.toContain('secreto');
    expect(JSON.parse(result.line)).toMatchObject({
      code: 'UNEXPECTED',
      max_rss_bytes: 64 * 1048576,
      mode: 'recompute',
      status: 'failed',
    });
  });
});
