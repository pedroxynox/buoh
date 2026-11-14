import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import pg, { type Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contentKey,
  createPool,
  createS3Client,
  DATASETS_SCHEMA,
  ensurePublicationRole,
  ensureRuntimeRoles,
  grantDatasetsPrivileges,
  grantLogPrivileges,
  loadConfig,
  LOGIN_ROLES,
  logLocation,
  migrate,
  migrateDatasets,
  openPublicationStores,
  POSTGRES_ROLES,
  PostgresSourceLogStore,
  PUBLICATION_ROLE,
  publishDatasetCommand,
  S3ObjectStore,
  setRolePassword,
  type WorkerConfig,
} from '../src/index.js';
import { createDerivPublicationProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { SOURCE_SCHEMA_ENTRY } from '../src/deriv/schema-release.js';
import { syntheticSchemas } from '../test/support/connection-harness.js';
import { waitForNoSessions } from '../test/support/databases.js';
import { syntheticSchemaArchive } from '../test/support/deriv-fixtures.js';
import { liveEvents, writeLiveLog } from '../test/support/live-log.js';

/**
 * `datasets:publish` (ADR-0020 §8, paso 6; PR 3c de su §13) contra PostgreSQL y S3-compatible
 * locales, en una base propia: dos logs sucesivos de una captura sintética de R_100, escritos con el
 * `SourceEventLog` del worker con el esquema y el prefijo de cada log, y `buoh_datasets`. Como en
 * integration/datasets.test.ts, el superusuario solo hace de Render. Publica con
 * `buoh_publicacion`, que lee los logs como miembro de `buoh_lectura`, y después `data:replay`, el
 * comando compilado, reproduce el dataset en los dos modos con `buoh_salud` y `buoh_datasets`.
 *
 * Los objetos van al bucket de las demás pruebas, bajo `logs/<n>/` y `datasets/`, con claves
 * content-addressed. Las contraseñas son aleatorias y nunca se escriben. La base y los roles se
 * borran al empezar y al terminar.
 */
const DATABASE = 'buoh_integration_publish';
const RENDER_USER = 'buoh_integration_publish_render';
const TEST_ROLES = [
  PUBLICATION_ROLE,
  ...LOGIN_ROLES,
  POSTGRES_ROLES.reader,
  POSTGRES_ROLES.owner,
  RENDER_USER,
];
const replayCli = resolve(import.meta.dirname, '../dist/cli/replay.js');
const fixture = syntheticSchemaArchive();
const profile = createDerivPublicationProfile({ schemas: syntheticSchemas(), symbol: 'R_100' });
const T0 = Date.parse('2026-11-10T00:00:30.000Z');
/**
 * Dos logs sucesivos con números que ninguna otra prueba usa, porque el bucket es compartido y otras
 * miran qué hay bajo `logs/000001/` y `logs/000002/`.
 */
const LOGS = [logLocation(201), logLocation(202)];
const passwords = {
  health: randomBytes(32).toString('base64'),
  publication: randomBytes(32).toString('base64'),
  render: randomBytes(32).toString('base64'),
};
/** El entorno local, sin `BUOH_POSTGRES_SCHEMA`, que `datasets:publish` no admite. */
const base: Record<string, string | undefined> = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_DB: DATABASE,
};
delete base['BUOH_POSTGRES_SCHEMA'];

let config: WorkerConfig;
let platform: Pool | undefined;
let renderPool: Pool | undefined;
let renderClient: PoolClient | undefined;

async function dropTestDatabaseAndRoles(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  for (const role of TEST_ROLES) {
    await server.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

beforeAll(async () => {
  config = loadConfig(base);
  platform = createPool({
    ...loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres,
    schema: 'public',
  });
  await dropTestDatabaseAndRoles(platform);
  await platform.query(
    `CREATE ROLE ${RENDER_USER} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.render)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE} OWNER ${RENDER_USER}`);
  renderPool = createPool({
    ...config.postgres,
    password: passwords.render,
    schema: 'public',
    user: RENDER_USER,
  });
  renderClient = await renderPool.connect();
  await ensureRuntimeRoles(renderClient);
  await ensurePublicationRole(renderClient);
  // Los dos logs, como los prepara buoh-operaciones: esquemas de buoh_dueno, migrados y con sus
  // privilegios. El 201 terminó: el 202 ya tiene escrituras.
  const durations = [20 * 60_000, 10 * 60_000];
  for (const [index, log] of LOGS.entries()) {
    await renderClient.query(`SET ROLE ${POSTGRES_ROLES.owner}`);
    await renderClient.query(`CREATE SCHEMA ${log.schema}`);
    await renderClient.query('RESET ROLE');
    const logPool = createPool({
      ...config.postgres,
      password: passwords.render,
      schema: log.schema,
      user: RENDER_USER,
    });
    try {
      await migrate(logPool, { ownerRole: POSTGRES_ROLES.owner });
      await grantLogPrivileges(renderClient, log.schema);
      // La captura la escribe el dueño de la base: aquí no se prueban los privilegios de ingest.
      const objects = new S3ObjectStore(createS3Client(config.s3), config.s3.bucket, log.prefix);
      await objects.putIfAbsent(
        contentKey(fixture.expected.entries_sha256[SOURCE_SCHEMA_ENTRY]),
        fixture.entries[SOURCE_SCHEMA_ENTRY],
        'application/json',
      );
      const start = T0 + index * 86_400_000;
      await writeLiveLog({
        events: liveEvents(profile, [
          { end: 'requested', fromMs: start, toMs: start + (durations[index] ?? 0) },
        ]),
        objects,
        source: DERIV_SOURCE,
        store: new PostgresSourceLogStore(logPool),
      });
      objects.destroy();
    } finally {
      await logPool.end();
    }
  }
  await migrateDatasets(renderPool, { ownerRole: POSTGRES_ROLES.owner });
  await grantDatasetsPrivileges(renderClient);
  await setRolePassword(renderClient, PUBLICATION_ROLE, passwords.publication);
  await setRolePassword(renderClient, POSTGRES_ROLES.health, passwords.health);
}, 120_000);

afterAll(async () => {
  renderClient?.release();
  await renderPool?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropTestDatabaseAndRoles(platform);
    await platform.end();
  }
});

function publish(argv: readonly string[] = []) {
  const env = {
    ...base,
    BUOH_POSTGRES_PASSWORD: passwords.publication,
    BUOH_POSTGRES_USER: PUBLICATION_ROLE,
  };
  let ids = 0;
  return publishDatasetCommand(argv, env, {
    elapsedMs: () => 0,
    maxRssBytes: () => 0,
    nextId: () => {
      ids += 1;
      return `019a9000-0000-7000-8000-${ids.toString().padStart(12, '0')}`;
    },
    now: () => '2026-11-11T01:00:00.000Z',
    open: (target) =>
      openPublicationStores(target, { alert: () => undefined, schemas: fixture.expected }),
    schemas: fixture.expected,
    zlibVersion: process.versions.zlib,
  });
}

function replay(args: readonly string[]) {
  const result = spawnSync(process.execPath, [replayCli, ...args], {
    encoding: 'utf8',
    env: {
      ...base,
      BUOH_POSTGRES_PASSWORD: passwords.health,
      BUOH_POSTGRES_SCHEMA: DATASETS_SCHEMA,
      BUOH_POSTGRES_USER: POSTGRES_ROLES.health,
    },
  });
  return {
    report: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    status: result.status,
  };
}

describe('datasets:publish en PostgreSQL y S3 locales (ADR-0020 §8)', () => {
  it('publica el log terminado con buoh_publicacion, y data:replay lo reproduce en los dos modos con buoh_salud', async () => {
    const first = await publish();
    expect(first.exitCode).toBe(0);
    const report = JSON.parse(first.line) as Record<string, unknown>;
    expect(report).toMatchObject({ clean: true, first_segment: 0, log: 201, status: 'published' });
    const datasetId = String(report['dataset_id']);

    // La fila de rango, con su publicación, y el documento bajo datasets/ en el bucket.
    const owner = createPool({ ...config.postgres, schema: 'public' });
    let uri: string;
    try {
      const { rows } = await owner.query<{ publication_id: string; last_segment: number }>(
        `SELECT publication_id::text, last_segment FROM ${DATASETS_SCHEMA}.dataset_log_ranges
          WHERE dataset_id = $1`,
        [datasetId],
      );
      expect(rows).toEqual([
        { last_segment: report['last_segment'], publication_id: report['publication_id'] },
      ]);
      const record = await owner.query<{ uri: string }>(
        `SELECT manifest_object_uri AS uri FROM ${DATASETS_SCHEMA}.published_manifest_records
          WHERE dataset_id = $1`,
        [datasetId],
      );
      uri = record.rows[0]?.uri ?? '';
    } finally {
      await owner.end();
    }
    expect(uri).toMatch(/^s3:\/\/[a-z0-9.-]+\/datasets\/manifests\//u);
    const root = new S3ObjectStore(createS3Client(config.s3), config.s3.bucket, '');
    try {
      await expect(root.get(uri.replace(/^s3:\/\/[^/]+\//u, ''), 1 << 24)).resolves.toBeInstanceOf(
        Uint8Array,
      );
    } finally {
      root.destroy();
    }

    for (const args of [
      ['--dataset', datasetId, '--verify-only'],
      ['--dataset', datasetId],
    ]) {
      const run = replay(args);
      expect(run.status, args.join(' ')).toBe(0);
      expect(run.report).toMatchObject({ dataset_id: datasetId });
      expect(run.report['max_rss_bytes']).toEqual(expect.any(Number));
    }

    // El log 202 es el activo y no llegó a su marca: no queda nada pendiente.
    const second = await publish();
    expect(JSON.parse(second.line)).toMatchObject({ status: 'nothing_due' });
  });

  it('BUOH_POSTGRES_SCHEMA no vale: salida 2', async () => {
    const result = await publishDatasetCommand(
      [],
      { ...base, BUOH_POSTGRES_SCHEMA: DATASETS_SCHEMA },
      {
        elapsedMs: () => 0,
        maxRssBytes: () => 0,
        nextId: () => '019a9000-0000-7000-8000-000000000000',
        now: () => '2026-11-11T01:00:00.000Z',
        open: (target) => openPublicationStores(target, { schemas: fixture.expected }),
        schemas: fixture.expected,
        zlibVersion: process.versions.zlib,
      },
    );
    expect(result.exitCode).toBe(2);
  });
});
