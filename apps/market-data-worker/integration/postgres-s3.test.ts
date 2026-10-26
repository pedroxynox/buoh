import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { datasetManifestCoreSchema, EMPTY_SEQUENCE_SHA256 } from '@buoh/contracts';
import { buildDatasetPublication } from '@buoh/domain';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contentKey,
  createPool,
  keyFromUri,
  loadConfig,
  loadSyntheticFixture,
  migrate,
  openStores,
  PublicationConflictError,
  PublicationError,
  publishDataset,
  replayDataset,
  type ReplayError,
  type SyntheticFixture,
  type WorkerConfig,
} from '../src/index.js';

/**
 * Integración local bloqueante (plan F1 §7): PostgreSQL 18 y almacenamiento S3-compatible de
 * `infra/compose.yaml`. Solo conecta a servicios locales por loopback. IDs y tiempos del pipeline se
 * inyectan; el cliente S3 usa el reloj del sistema únicamente para firmar peticiones (SigV4), y
 * ninguna aserción ni hash depende de él.
 */
const SCHEMA = 'buoh_integration';
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const replayCli = resolve(import.meta.dirname, '../dist/cli/replay.js');
const MAIN_DATASET_ID = 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd';
const ZERO_DATASET_ID = 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f';
const PUBLICATION_MAIN = '019b76da-cb28-7003-8000-000000000101';
const PUBLICATION_ZERO = '019b76da-cb28-7003-8000-000000000102';
const PUBLICATION_PARTIAL = '019b76da-cb28-7003-8000-000000000103';
const PUBLICATION_EXTRA = '019b76da-cb28-7003-8000-000000000104';
const PUBLISHED_AT = '2026-01-01T00:00:09.000Z';

const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;
let fixture: SyntheticFixture;
let firstMigration: Awaited<ReturnType<typeof migrate>>;

function segmentsOf(name: 'principal' | 'zero-valid-ticks') {
  const found = fixture.scenarios.find((item) => item.name === name);
  if (found === undefined) {
    throw new TypeError(`Falta el escenario ${name}.`);
  }
  return found.segments;
}

function publish(segments: readonly (readonly unknown[])[], publicationId: string) {
  return publishDataset({
    environment: 'test',
    metadata: stores.metadata,
    objects: stores.objects,
    profile: fixture.profile,
    publication_id: publicationId,
    published_at_utc: PUBLISHED_AT,
    segments,
    zlibVersion: process.versions.zlib,
  });
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [replayCli, ...args], {
    encoding: 'utf8',
    env: environment,
  });
  return {
    report: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    status: result.status,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  firstMigration = await migrate(stores.pool);
  fixture = await loadSyntheticFixture(vectorRoot);
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

describe('integración PostgreSQL + S3-compatible local', () => {
  it('aplica migraciones de forma idempotente y verificada', async () => {
    expect(firstMigration.applied).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
    ]);
    expect((await migrate(stores.pool)).applied).toEqual([]);
  });

  it('publica el escenario principal y lo reproduce con el mismo dataset_id', async () => {
    const publication = await publish(segmentsOf('principal'), PUBLICATION_MAIN);
    expect(publication.dataset_id).toBe(MAIN_DATASET_ID);

    const record = await stores.metadata.findActivePublication(MAIN_DATASET_ID, 'test');
    expect(record).toEqual(publication.record);

    const segment = publication.manifest.storage_objects.find(
      (object) => object.artifact_id === 'source_events:000001',
    );
    const physical = await stores.objects.get(
      contentKey(segment?.object_bytes_sha256 ?? ''),
      segment?.size_bytes ?? 0,
    );
    expect(
      Buffer.from(gunzipSync(physical)).equals(
        readFileSync(resolve(vectorRoot, 'expected-source-events-000001.ndjson')),
      ),
    ).toBe(true);

    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId: MAIN_DATASET_ID,
        environment: 'test',
        metadata: stores.metadata,
        mode,
        objects: stores.objects,
      });
      expect(report.status).toBe(mode === 'recompute' ? 'reproduced' : 'verified');
    }

    const incidents = await stores.pool.query<{ count: string }>(
      'SELECT count(*) FROM dataset_quality_incidents WHERE dataset_id = $1',
      [MAIN_DATASET_ID],
    );
    expect(Number(incidents.rows[0]?.count)).toBe(publication.core.incident_count);
  });

  it('pnpm run data:replay reproduce, verifica y falla cerrado por CLI', () => {
    expect(existsSync(replayCli), 'ejecuta antes pnpm run build').toBe(true);

    const reproduced = runCli(['--', '--dataset', MAIN_DATASET_ID]);
    expect(reproduced.status).toBe(0);
    expect(reproduced.report).toMatchObject({ dataset_id: MAIN_DATASET_ID, status: 'reproduced' });

    const verified = runCli(['--dataset', MAIN_DATASET_ID, '--verify-only']);
    expect(verified.status).toBe(0);
    expect(verified.report).toMatchObject({ mode: 'verify-only', status: 'verified' });

    const missing = runCli(['--dataset', ZERO_DATASET_ID]);
    expect(missing.status).toBe(1);
    expect(missing.report).toMatchObject({ code: 'DATASET_NOT_PUBLISHED', status: 'failed' });

    const usage = runCli(['--dataset', 'no-es-un-id']);
    expect(usage.status).toBe(2);
  });

  it('cero ticks guarda objetos vacíos de cero bytes y se reproduce', async () => {
    const publication = await publish(segmentsOf('zero-valid-ticks'), PUBLICATION_ZERO);
    expect(publication.dataset_id).toBe(ZERO_DATASET_ID);
    const empty = await stores.objects.get(contentKey(EMPTY_SEQUENCE_SHA256), 0);
    expect(empty.byteLength).toBe(0);
    const report = await replayDataset({
      datasetId: ZERO_DATASET_ID,
      environment: 'test',
      metadata: stores.metadata,
      mode: 'recompute',
      objects: stores.objects,
    });
    expect(report).toMatchObject({ normalized_tick_count: 0, status: 'reproduced' });
  });

  it('un commit fallido revierte la transacción completa y deja el dataset invisible', async () => {
    // Solo el primer segmento: otro dataset. Reutilizar un publication_id existente hace fallar el
    // INSERT del record después de insertar dataset e incidencias en la misma transacción.
    const partial = [segmentsOf('principal')[0] ?? []];
    const error = await rejection(publish(partial, PUBLICATION_MAIN));
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).step).toBe('commit');

    const { rows } = await stores.pool.query<{ datasets: string; incidents: string }>(
      `SELECT (SELECT count(*) FROM datasets) AS datasets,
              (SELECT count(*) FROM dataset_quality_incidents) AS incidents`,
    );
    expect(Number(rows[0]?.datasets)).toBe(2);
    const partialId = buildDatasetPublication({
      locateManifest: () => 's3://buoh-local/unused',
      locateObject: () => 's3://buoh-local/unused',
      profile: fixture.profile,
      publication_id: PUBLICATION_PARTIAL,
      published_at_utc: PUBLISHED_AT,
      segments: partial,
    }).dataset_id;
    const replayError = await rejection(
      replayDataset({
        datasetId: partialId,
        environment: 'test',
        metadata: stores.metadata,
        mode: 'verify-only',
        objects: stores.objects,
      }),
    );
    expect((replayError as ReplayError).code).toBe('DATASET_NOT_PUBLISHED');

    // Reanudar con un publication_id nuevo completa la publicación.
    const resumed = await publish(partial, PUBLICATION_PARTIAL);
    expect(resumed.dataset_id).toBe(partialId);
    expect(await stores.metadata.findActivePublication(partialId, 'test')).toEqual(resumed.record);
  });

  it('el índice parcial admite un solo record activo por dataset y entorno', async () => {
    const record = await stores.metadata.findActivePublication(MAIN_DATASET_ID, 'test');
    if (record === null) {
      throw new TypeError('Falta la publicación principal.');
    }
    const publication = await publish(segmentsOf('principal'), PUBLICATION_EXTRA).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(publication).toBeInstanceOf(PublicationConflictError);

    // Saltando la comprobación previa, la propia base rechaza el segundo record activo.
    const stored = await stores.pool.query<{ manifest_core_jcs: string }>(
      'SELECT manifest_core_jcs FROM datasets WHERE dataset_id = $1',
      [MAIN_DATASET_ID],
    );
    const direct = await rejection(
      stores.metadata.commitPublication({
        core: datasetManifestCoreSchema.parse(
          JSON.parse(stored.rows[0]?.manifest_core_jcs ?? 'null'),
        ),
        environment: 'test',
        incidents: [],
        record: { ...record, publication_id: PUBLICATION_EXTRA },
      }),
    );
    expect(direct).toBeInstanceOf(PublicationConflictError);
  });

  it.each([
    ['UPDATE', `UPDATE datasets SET source = 'otra'`],
    ['DELETE', 'DELETE FROM published_manifest_records'],
    ['TRUNCATE', 'TRUNCATE dataset_quality_incidents'],
  ])('las tablas son append-only: %s se rechaza', async (_label, sql) => {
    const error = await rejection(stores.pool.query(sql));
    expect((error as { code?: string }).code).toBe('23001');
  });

  it('la base comprueba que dataset_id es el SHA-256 de manifest_core', async () => {
    const error = await rejection(
      stores.pool.query(
        `INSERT INTO datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ($1, 'published', 'synthetic', '{}')`,
        [`sha256:${'0'.repeat(64)}`],
      ),
    );
    expect((error as { code?: string }).code).toBe('23514');
  });

  it('los objetos publicados están en claves content-addressed del bucket', async () => {
    const record = await stores.metadata.findActivePublication(MAIN_DATASET_ID, 'test');
    expect(keyFromUri(record?.manifest_object_uri ?? '', config.s3.bucket)).toMatch(
      /^manifests\/sha256:[0-9a-f]{64}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.json$/u,
    );
  });
});
