import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect as tcpConnect, createServer, type Server } from 'node:net';
import { resolve } from 'node:path';

import pg, { type Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_READER_ROLE,
  CommitOutcomeUnknownError,
  createPool,
  createS3Client,
  DATASETS_MIGRATIONS,
  DATASETS_OWNER_TABLES,
  DATASETS_PREFIX,
  DATASETS_PUBLICATION_TABLES,
  DATASETS_SCHEMA,
  ensureApiReaderRole,
  ensurePublicationRole,
  ensureRuntimeRoles,
  GOLD_SEQUENCE,
  grantDatasetsPrivileges,
  loadConfig,
  loadSyntheticFixture,
  loadMigrations,
  LOGIN_ROLES,
  migrateDatasets,
  MIGRATIONS_TABLE,
  OperationalRegistry,
  POSTGRES_ROLES,
  PostgresDatasetStore,
  PostgresOperationalStore,
  PUBLICATION_ROLE,
  PublicationConflictError,
  publishLiveDataset,
  R_100_SEQUENCE,
  replayDataset,
  S3ObjectStore,
  setRolePassword,
  type DatasetPlan,
  type SyntheticFixture,
  type WorkerConfig,
} from '../src/index.js';
import { readLastActiveDatasetId } from '../src/postgres/data-events.js';
import { openHealthStores } from '../src/runtime.js';
import { waitForNoSessions } from '../test/support/databases.js';

/**
 * El esquema de los datasets vivos, `buoh_datasets` (ADR-0020 §5 y §9; PR 3b de su §13), contra
 * PostgreSQL y S3-compatible locales. Como en integration/roles.test.ts, el superusuario solo hace de
 * Render: crea el usuario por defecto y su base. Ese usuario crea `buoh_dueno` y los roles con el
 * código del worker, y `buoh_dueno` migra `buoh_datasets` y da sus privilegios, como hará
 * `buoh-operaciones` con el PR 4. Comprueba:
 *
 * - con `buoh_publicacion` y `buoh_api_lectura`, `UPDATE`, `DELETE`, `TRUNCATE` y el DDL fallan con
 *   `42501`; `buoh_publicacion` no inserta en `dataset_verifications`, y con `buoh_ingesta` no se lee
 *   nada;
 * - publicar con `buoh_publicacion`, en gzip y bajo el prefijo `datasets/`, con su fila de rango en el
 *   mismo commit, y reproducir el dataset en los dos modos con el mismo `dataset_id`;
 * - el `COMMIT` cortado, que se confirmó y que no: el reintento comprueba antes si ya está.
 *
 * Las contraseñas son aleatorias y nunca se escriben. Los roles son de todo el servidor: la prueba
 * borra los suyos y su base al empezar y al terminar.
 */
const DATABASE = 'buoh_integration_datasets';
const RENDER_USER = 'buoh_integration_datasets_render';
const TEST_ROLES = [
  PUBLICATION_ROLE,
  API_READER_ROLE,
  ...LOGIN_ROLES,
  POSTGRES_ROLES.reader,
  POSTGRES_ROLES.owner,
  RENDER_USER,
];
const TABLES = [...DATASETS_PUBLICATION_TABLES, ...DATASETS_OWNER_TABLES, MIGRATIONS_TABLE];
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_SCHEMA: DATASETS_SCHEMA,
};
const passwords = {
  apiReader: randomBytes(32).toString('base64'),
  ingest: randomBytes(32).toString('base64'),
  publication: randomBytes(32).toString('base64'),
  render: randomBytes(32).toString('base64'),
};
/** Un prefijo propio de esta ejecución en el bucket local, con `datasets/` al final. */
const KEY_PREFIX = `integration-datasets-${randomUUID().slice(0, 8)}/${DATASETS_PREFIX}`;

let config: WorkerConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let renderPool: Pool | undefined;
let renderClient: PoolClient | undefined;
let firstMigration: Awaited<ReturnType<typeof migrateDatasets>>;
let fixture: SyntheticFixture;
const pools: Pool[] = [];
const servers: Server[] = [];

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** Un pool de `user` en la base de la prueba, con `buoh_datasets` en su `search_path`. */
function poolAs(user: string, password: string): Pool {
  const pool = createPool({
    ...config.postgres,
    password,
    schema: DATASETS_SCHEMA,
    user,
  });
  pools.push(pool);
  return pool;
}

async function dropTestDatabaseAndRoles(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  for (const role of TEST_ROLES) {
    await server.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

/** El código SQLSTATE con que falla `text`, o `null` si no falla. */
async function sqlState(pool: Pool, text: string): Promise<string | null> {
  return pool.query(text).then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? 'sin_codigo',
  );
}

beforeAll(async () => {
  config = loadConfig(environment);
  platform = createPool({
    ...loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres,
    schema: 'public',
  });
  await dropTestDatabaseAndRoles(platform);
  await platform.query(
    `CREATE ROLE ${RENDER_USER} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.render)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE} OWNER ${RENDER_USER}`);
  admin = createPool({ ...config.postgres, schema: 'public' });
  renderPool = createPool({
    ...config.postgres,
    password: passwords.render,
    schema: 'public',
    user: RENDER_USER,
  });
  renderClient = await renderPool.connect();
  await ensureRuntimeRoles(renderClient);
  await ensureApiReaderRole(renderClient);
  await ensurePublicationRole(renderClient);
  firstMigration = await migrateDatasets(renderPool, { ownerRole: POSTGRES_ROLES.owner });
  await grantDatasetsPrivileges(renderClient);
  await setRolePassword(renderClient, PUBLICATION_ROLE, passwords.publication);
  await setRolePassword(renderClient, API_READER_ROLE, passwords.apiReader);
  await setRolePassword(renderClient, POSTGRES_ROLES.ingest, passwords.ingest);
  fixture = await loadSyntheticFixture(vectorRoot);
});

afterAll(async () => {
  for (const pool of pools) {
    await pool.end();
  }
  for (const server of servers) {
    await new Promise((done) => {
      server.close(done);
    });
  }
  renderClient?.release();
  await renderPool?.end();
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropTestDatabaseAndRoles(platform);
    await platform.end();
  }
});

describe('las migraciones de buoh_datasets (ADR-0020 §5)', () => {
  it('crean el esquema y sus tablas, de buoh_dueno, y una segunda vez no aplican nada', async () => {
    expect(firstMigration).toEqual({
      applied: ['0001_datasets.sql', '0002_secuencias.sql'],
      current: ['0001_datasets.sql', '0002_secuencias.sql'],
    });
    const { rows } = await ready(admin).query<{ owner: string; table_name: string }>(
      `SELECT tablename AS table_name, tableowner AS owner FROM pg_tables
        WHERE schemaname = $1 ORDER BY tablename`,
      [DATASETS_SCHEMA],
    );
    expect(rows.map((row) => row.table_name)).toEqual([...TABLES].sort());
    expect(new Set(rows.map((row) => row.owner))).toEqual(new Set([POSTGRES_ROLES.owner]));
    const schema = await ready(admin).query<{ owner: string }>(
      'SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = $1',
      [DATASETS_SCHEMA],
    );
    expect(schema.rows[0]?.owner).toBe(POSTGRES_ROLES.owner);
    expect(await migrateDatasets(ready(renderPool), { ownerRole: POSTGRES_ROLES.owner })).toEqual({
      applied: [],
      current: ['0001_datasets.sql', '0002_secuencias.sql'],
    });
  });

  it('la fila de rango es coherente con cómo terminó y cita una publicación de su dataset', async () => {
    const insert = (clean: boolean, pending: string, open: string, first = 0) =>
      sqlState(
        ready(admin),
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ('sha256:${'0'.repeat(64)}', gen_random_uuid(), 'R_100', 99, ${String(first)}, 5,
                 ${String(clean)}, '${open}'::text[], '${pending}'::text[])`,
      );
    // Limpio solo sin continuidad pendiente ni connection_lost abierta.
    expect(await insert(true, '{SYNTH_100}', '{}')).toBe('23514');
    expect(await insert(true, '{}', '{connection_lost}')).toBe('23514');
    expect(await insert(false, '{}', '{event_gap_unresolved}')).toBe('23514');
    expect(await insert(false, '{NULL}', '{}')).toBe('23514');
    // El primer dataset de un log empieza en su segmento 0.
    expect(await insert(true, '{}', '{}', 1)).toBe('23514');
    // Un rango coherente necesita su dataset y su publicación.
    expect(await insert(true, '{}', '{event_gap_unresolved}')).toBe('23503');
    // Y la publicación tiene que ser de su propio dataset: dos datasets sintéticos, cuyo core es
    // '{}' y '[]', y una publicación del primero.
    const owner = ready(admin);
    const ids = await owner.query<{ first: string; second: string }>(
      `SELECT 'sha256:' || encode(sha256('{}'), 'hex') AS first,
              'sha256:' || encode(sha256('[]'), 'hex') AS second`,
    );
    const { first, second } = ids.rows[0] ?? { first: '', second: '' };
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
       VALUES ($1, 'published', 'synthetic', '{}'), ($2, 'published', 'synthetic', '[]')`,
      [first, second],
    );
    const publication = '019a8000-0000-7000-8000-0000000000f1';
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
         (publication_id, deployment_environment, dataset_id, schema_version,
          manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
          published_at_utc, state)
       VALUES ($1, 'development', $2, '1.0.0', $3, 's3://x/y', $3, '2026-11-14T00:00:00.000Z',
               'superseded')`,
      [publication, first, '0'.repeat(64)],
    );
    const range = (dataset: string) =>
      sqlState(
        owner,
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ('${dataset}', '${publication}', 'R_100', 98, 0, 0, true, '{}', '{}')`,
      );
    expect(await range(second)).toBe('23503');
    expect(await range(first)).toBe(null);
  });

  it('la clave única impide dos datasets con el mismo comienzo, también con una instantánea anterior', async () => {
    // Con REPEATABLE READ, el disparador de la segunda inserción no ve la primera, ya confirmada:
    // la clave única por log y primer segmento es la que la rechaza.
    const owner = ready(admin);
    const id = await owner.query<{ id: string }>(
      `SELECT 'sha256:' || encode(sha256('1'), 'hex') AS id`,
    );
    const dataset = id.rows[0]?.id ?? '';
    const publication = '019a8000-0000-7000-8000-0000000000f2';
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
       VALUES ($1, 'published', 'synthetic', '1')`,
      [dataset],
    );
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
         (publication_id, deployment_environment, dataset_id, schema_version,
          manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
          published_at_utc, state)
       VALUES ($1, 'development', $2, '1.0.0', $3, 's3://x/y', $3, '2026-11-14T00:00:00.000Z',
               'superseded')`,
      [publication, dataset, '0'.repeat(64)],
    );
    const first = await owner.connect();
    const second = await owner.connect();
    try {
      for (const client of [first, second]) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query(`SELECT 1 FROM ${DATASETS_SCHEMA}.dataset_log_ranges LIMIT 1`);
      }
      await first.query(
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ($1, $2, 'R_100', 97, 0, 0, true, '{}', '{}')`,
        [dataset, publication],
      );
      await first.query('COMMIT');
      const state = await second
        .query(
          `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
             (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
              open_condition_types, pending_continuity_symbols)
           VALUES ($1, gen_random_uuid(), 'R_100', 97, 0, 3, true, '{}', '{}')`,
          [`sha256:${'2'.repeat(64)}`],
        )
        .then(
          () => null,
          (error: unknown) => (error as { code?: string }).code ?? 'sin_codigo',
        );
      expect(state).toBe('23505');
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('cada rango nombra su secuencia, y la contigüidad y la clave única son por secuencia (ADR-0021 §1)', async () => {
    const owner = ready(admin);
    const publication = '019a8000-0000-7000-8000-0000000000f3';
    // Cada dataset sintético es el SHA-256 de su core, como pide datasets_check.
    const cores = ['"a1"', '"a2"', '"a3"', '"a4"'];
    const ids = cores.map((core) => `sha256:${createHash('sha256').update(core).digest('hex')}`);
    const publicationOf = (dataset: string) =>
      publication.replace(/f3$/u, `a${String(ids.indexOf(dataset) + 1)}`);
    for (const [index, dataset] of ids.entries()) {
      await owner.query(
        `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ($1, 'published', 'synthetic', $2)`,
        [dataset, cores[index]],
      );
    }
    const range = (dataset: string, sequence: string | null, first: number, last: number) =>
      sqlState(
        owner,
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ('${dataset}', gen_random_uuid(), ${sequence === null ? 'NULL' : `'${sequence}'`},
                 96, ${String(first)}, ${String(last)}, true, '{}', '{}')`,
      );
    // Las publicaciones de esas filas no existen: el disparador de la contigüidad va antes que la
    // clave foránea, así que con la secuencia y el primer segmento correctos el rechazo es 23503.
    expect(await range(ids[0] ?? '', null, 0, 5)).toBe('23502');
    expect(await range(ids[0] ?? '', 'R-100', 0, 5)).toBe('23514');
    expect(await range(ids[0] ?? '', 'R_100', 0, 5)).toBe('23503');
    // Con sus publicaciones: el log 96 de R_100 y el log 96 del oro empiezan los dos en el 0.
    for (const dataset of ids) {
      await owner.query(
        `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
           (publication_id, deployment_environment, dataset_id, schema_version,
            manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
            published_at_utc, state)
         VALUES ($1, 'development', $2, '1.0.0', $3, 's3://x/y', $3, '2026-11-14T00:00:00.000Z',
                 'superseded')`,
        [publicationOf(dataset), dataset, '0'.repeat(64)],
      );
    }
    const withPublication = (dataset: string, sequence: string, first: number, last: number) =>
      sqlState(
        owner,
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ('${dataset}', '${publicationOf(dataset)}',
                 '${sequence}', 96, ${String(first)}, ${String(last)}, true, '{}', '{}')`,
      );
    expect(await withPublication(ids[0] ?? '', 'R_100', 0, 5)).toBe(null);
    expect(await withPublication(ids[1] ?? '', 'frxXAUUSD', 1, 2)).toBe('23514');
    expect(await withPublication(ids[1] ?? '', 'frxXAUUSD', 0, 2)).toBe(null);
    // Cada una sigue desde el último segmento de su propia secuencia.
    expect(await withPublication(ids[2] ?? '', 'frxXAUUSD', 6, 7)).toBe('23514');
    expect(await withPublication(ids[2] ?? '', 'frxXAUUSD', 3, 7)).toBe(null);
    expect(await withPublication(ids[3] ?? '', 'R_100', 6, 9)).toBe(null);
    // Sin nombrarla, la secuencia es R_100, la del código de antes de las secuencias.
    const legacy = `sha256:${createHash('sha256').update('"a5"').digest('hex')}`;
    const legacyPublication = publication.replace(/f3$/u, 'a5');
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
       VALUES ($1, 'published', 'synthetic', '"a5"')`,
      [legacy],
    );
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
         (publication_id, deployment_environment, dataset_id, schema_version,
          manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
          published_at_utc, state)
       VALUES ($1, 'development', $2, '1.0.0', $3, 's3://x/y', $3, '2026-11-14T00:00:00.000Z',
               'superseded')`,
      [legacyPublication, legacy, '0'.repeat(64)],
    );
    await owner.query(
      `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
         (dataset_id, publication_id, log_number, first_segment, last_segment, clean,
          open_condition_types, pending_continuity_symbols)
       VALUES ($1, $2, 96, 10, 11, true, '{}', '{}')`,
      [legacy, legacyPublication],
    );
    // La publicación sigue cada log desde el último rango de su propia secuencia.
    const datasetsPool = createPool({ ...config.postgres, schema: DATASETS_SCHEMA });
    pools.push(datasetsPool);
    const store = new PostgresDatasetStore(datasetsPool);
    expect((await store.lastLogRange('R_100', 96))?.last_segment).toBe(11);
    expect(await store.lastLogRange('frxXAUUSD', 96)).toMatchObject({
      first_segment: 3,
      last_segment: 7,
      log_number: 96,
      sequence: 'frxXAUUSD',
    });
    expect(await store.lastLogRange('frxXAUUSD', 95)).toBe(null);
  });

  it('la 0002 da R_100 a las filas que ya existían y lo deja por defecto (ADR-0021 §1)', async () => {
    const owner = ready(admin);
    const schema = 'buoh_datasets_secuencias';
    const [first, second] = await loadMigrations(DATASETS_MIGRATIONS);
    if (first === undefined || second === undefined) throw new Error('faltan las migraciones');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(first.sql);
      const dataset = `sha256:${createHash('sha256').update('"b1"').digest('hex')}`;
      const publication = '019a8000-0000-7000-8000-0000000000f9';
      await client.query(
        `INSERT INTO datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ($1, 'published', 'synthetic', '"b1"')`,
        [dataset],
      );
      await client.query(
        `INSERT INTO published_manifest_records
           (publication_id, deployment_environment, dataset_id, schema_version,
            manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
            published_at_utc, state)
         VALUES ($1, 'production', $2, '1.0.0', $3, 's3://x/y', $3, '2026-11-14T00:00:00.000Z',
                 'active')`,
        [publication, dataset, '0'.repeat(64)],
      );
      await client.query(
        `INSERT INTO dataset_log_ranges
           (dataset_id, publication_id, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ($1, $2, 1, 0, 70, true, '{}', '{}')`,
        [dataset, publication],
      );
      await client.query(second.sql);
      const { rows } = await client.query<{ sequence: string }>(
        'SELECT sequence FROM dataset_log_ranges',
      );
      expect(rows).toEqual([{ sequence: 'R_100' }]);
      const column = await client.query<{ default_value: string | null; nullable: string }>(
        `SELECT column_default AS default_value, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'dataset_log_ranges' AND column_name = 'sequence'`,
        [schema],
      );
      expect(column.rows).toEqual([{ default_value: "'R_100'::text", nullable: 'NO' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('el último dataset activo de producción de una secuencia, que data:health lee con buoh_salud en production (ADR-0015 §8; ADR-0020 §5)', async () => {
    const owner = ready(admin);
    // Cada dataset es el SHA-256 de su core y va en su propio log, desde el segmento 0.
    const rows = [
      // [core, secuencia, log, entorno, estado, fuente, publicación, hora]
      [
        '"c1"',
        'R_100',
        80,
        'production',
        'active',
        'deriv_options',
        'c1',
        '2026-11-20T00:00:00.000Z',
      ],
      [
        '"c2"',
        'R_100',
        81,
        'production',
        'active',
        'deriv_options',
        'c2',
        '2026-11-21T00:00:00.000Z',
      ],
      // A la misma hora, gana el publication_id mayor.
      [
        '"c3"',
        'R_100',
        82,
        'production',
        'active',
        'deriv_options',
        'c3',
        '2026-11-21T00:00:00.000Z',
      ],
      // Más tardíos, pero no cuentan: uno sustituido, otro de otro entorno, otro de otra fuente.
      [
        '"c4"',
        'R_100',
        83,
        'production',
        'superseded',
        'deriv_options',
        'c4',
        '2026-11-22T00:00:00.000Z',
      ],
      [
        '"c5"',
        'R_100',
        84,
        'development',
        'active',
        'deriv_options',
        'c5',
        '2026-11-22T00:00:00.000Z',
      ],
      ['"c6"', 'R_100', 85, 'production', 'active', 'synthetic', 'c6', '2026-11-22T00:00:00.000Z'],
      // El más tardío de todos es del oro: es el del oro y no el de R_100.
      [
        '"c7"',
        'frxXAUUSD',
        80,
        'production',
        'active',
        'deriv_options',
        'c7',
        '2026-11-23T00:00:00.000Z',
      ],
    ] as const;
    const idOf = (core: string) => `sha256:${createHash('sha256').update(core).digest('hex')}`;
    for (const [core, logSequence, log, env, state, source, suffix, at] of rows) {
      const dataset = idOf(core);
      const publication = `019a8000-0000-7000-8000-0000000000${suffix}`;
      await owner.query(
        `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ($1, 'published', $2, $3)`,
        [dataset, source, core],
      );
      await owner.query(
        `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
           (publication_id, deployment_environment, dataset_id, schema_version,
            manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
            published_at_utc, state)
         VALUES ($1, $2, $3, '1.0.0', $4, 's3://x/y', $4, $5, $6)`,
        [publication, env, dataset, '0'.repeat(64), at, state],
      );
      await owner.query(
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
           (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
            open_condition_types, pending_continuity_symbols)
         VALUES ($1, $2, $3, $4, 0, 70, true, '{}', '{}')`,
        [dataset, publication, logSequence, log],
      );
    }
    // Con buoh_salud, como data:health en production: su pool tiene el log en el search_path.
    const healthPassword = randomBytes(32).toString('base64');
    await setRolePassword(ready(renderClient), POSTGRES_ROLES.health, healthPassword);
    const production: WorkerConfig = {
      ...config,
      environment: 'production',
      postgres: {
        ...config.postgres,
        password: healthPassword,
        schema: 'buoh_log_000080',
        user: POSTGRES_ROLES.health,
      },
    };
    const latest = async (logSequence: typeof R_100_SEQUENCE) => {
      const stores = openHealthStores(production, { sequence: logSequence });
      try {
        return await stores.datasets.lastActiveDatasetId('deriv_options', 'production');
      } finally {
        await stores.close();
      }
    };
    expect(await latest(R_100_SEQUENCE)).toBe(idOf('"c3"'));
    expect(await latest(GOLD_SEQUENCE)).toBe(idOf('"c7"'));
    const reader = poolAs(POSTGRES_ROLES.health, healthPassword);
    expect(
      await readLastActiveDatasetId(reader, {
        environment: 'development',
        sequence: 'R_100',
        source: 'deriv_options',
      }),
    ).toBe(idOf('"c5"'));
    expect(
      await readLastActiveDatasetId(reader, {
        environment: 'production',
        sequence: 'R_100',
        source: 'otra_fuente',
      }),
    ).toBe(null);
  });

  it('cada verificación tiene la salida de su estado', async () => {
    const insert = (status: string, exit: string, error: string, report: string) =>
      sqlState(
        ready(admin),
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_verifications
           (verification_id, dataset_id, publication_id, mode, status, exit_code, error_code,
            report_jcs, run_id, verified_at_utc)
         VALUES (gen_random_uuid(), 'sha256:${'0'.repeat(64)}', gen_random_uuid(), 'recompute',
                 '${status}', ${exit}, ${error}, ${report}, gen_random_uuid(),
                 '2026-11-14T00:00:00.000Z')`,
      );
    expect(await insert('passed', '1', 'NULL', "'{}'")).toBe('23514');
    expect(await insert('passed', '0', "'OBJECT_INTEGRITY'", "'{}'")).toBe('23514');
    expect(await insert('passed', '0', 'NULL', 'NULL')).toBe('23514');
    expect(await insert('failed', '1', 'NULL', 'NULL')).toBe('23514');
    expect(await insert('failed', '0', "'OBJECT_INTEGRITY'", 'NULL')).toBe('23514');
    expect(await insert('incomplete', '0', 'NULL', 'NULL')).toBe('23514');
    // Coherentes, solo les falta su dataset y su publicación. Una incompleta puede llevar la
    // salida 1 de un error inesperado (UNEXPECTED), o ninguna si el proceso no terminó.
    expect(await insert('passed', '0', 'NULL', "'{}'")).toBe('23503');
    expect(await insert('failed', '1', "'OBJECT_INTEGRITY'", 'NULL')).toBe('23503');
    expect(await insert('incomplete', 'NULL', 'NULL', 'NULL')).toBe('23503');
    expect(await insert('incomplete', '1', "'UNEXPECTED'", 'NULL')).toBe('23503');
  });

  it('ninguna tabla se puede vaciar, tampoco con un superusuario', async () => {
    for (const table of [...DATASETS_PUBLICATION_TABLES, ...DATASETS_OWNER_TABLES]) {
      expect(
        await sqlState(ready(admin), `TRUNCATE ${DATASETS_SCHEMA}.${table} CASCADE`),
        table,
      ).toBe('23001');
    }
  });
});

describe('los privilegios de buoh_datasets (ADR-0020 §5)', () => {
  /** Una columna de cada tabla, para que el `UPDATE` llegue a comprobar el privilegio. */
  const COLUMN: Readonly<Record<string, string>> = {
    buoh_schema_migrations: 'name',
    dataset_log_ranges: 'clean',
    dataset_quality_incidents: 'severity',
    dataset_verifications: 'status',
    datasets: 'source',
    operational_conditions: 'source',
    operational_incidents: 'source',
    published_manifest_records: 'state',
  };
  const MUTATIONS = (table: string) => {
    const column = COLUMN[table] ?? 'sin_columna';
    return [
      `UPDATE ${table} SET ${column} = ${column} WHERE false`,
      `DELETE FROM ${table} WHERE false`,
      `TRUNCATE ${table}`,
    ];
  };
  const DDL = [
    'CREATE TABLE intrusa (x int)',
    'ALTER TABLE datasets ADD COLUMN intrusa int',
    'DROP TABLE dataset_verifications',
    'CREATE INDEX intruso ON datasets (source)',
  ];

  it('buoh_publicacion lee e inserta en sus tablas, y nada más', async () => {
    const pool = poolAs(PUBLICATION_ROLE, passwords.publication);
    for (const table of DATASETS_PUBLICATION_TABLES) {
      expect(await sqlState(pool, `SELECT 1 FROM ${table} LIMIT 1`), table).toBe(null);
      const { rows } = await pool.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, $1, 'INSERT') AS allowed",
        [`${DATASETS_SCHEMA}.${table}`],
      );
      expect(rows[0]?.allowed, table).toBe(true);
      for (const text of MUTATIONS(table)) {
        expect(await sqlState(pool, text), text).toBe('42501');
      }
    }
    expect(await sqlState(pool, 'SELECT 1 FROM dataset_verifications LIMIT 1')).toBe(null);
    expect(
      await sqlState(
        pool,
        `INSERT INTO dataset_verifications (verification_id, dataset_id, publication_id, mode,
           status, run_id, verified_at_utc)
         VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'recompute', 'incomplete',
           gen_random_uuid(), '2026-11-14T00:00:00.000Z')`,
      ),
    ).toBe('42501');
    expect(
      await sqlState(pool, `INSERT INTO ${MIGRATIONS_TABLE} (name, sha256) VALUES ('x', 'y')`),
    ).toBe('42501');
    for (const table of [...DATASETS_OWNER_TABLES, MIGRATIONS_TABLE]) {
      for (const text of MUTATIONS(table)) {
        expect(await sqlState(pool, text), text).toBe('42501');
      }
    }
    for (const text of DDL) {
      expect(await sqlState(pool, text), text).toBe('42501');
    }
  });

  it('buoh_api_lectura solo lee', async () => {
    const pool = poolAs(API_READER_ROLE, passwords.apiReader);
    for (const table of TABLES) {
      expect(await sqlState(pool, `SELECT 1 FROM ${table} LIMIT 1`), table).toBe(null);
      expect(await sqlState(pool, `INSERT INTO ${table} DEFAULT VALUES`), table).toBe('42501');
      for (const text of MUTATIONS(table)) {
        expect(await sqlState(pool, text), text).toBe('42501');
      }
    }
    for (const text of DDL) {
      expect(await sqlState(pool, text), text).toBe('42501');
    }
  });

  it('buoh_ingesta no lee nada', async () => {
    const pool = poolAs(POSTGRES_ROLES.ingest, passwords.ingest);
    for (const table of TABLES) {
      expect(await sqlState(pool, `SELECT 1 FROM ${DATASETS_SCHEMA}.${table} LIMIT 1`), table).toBe(
        '42501',
      );
    }
    const { rows } = await pool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege(current_user, $1, 'USAGE') AS allowed",
      [DATASETS_SCHEMA],
    );
    expect(rows[0]?.allowed).toBe(false);
  });
});

describe('publicar en buoh_datasets (ADR-0020 §9)', () => {
  /** El bucket sin prefijo: las claves de los datasets llevan el suyo, `KEY_PREFIX`. */
  const objects = () => new S3ObjectStore(createS3Client(config.s3), config.s3.bucket, '');

  function plan(
    scenario: 'principal' | 'zero-valid-ticks',
    from: number,
  ): Extract<DatasetPlan, { status: 'due' }> {
    const found = fixture.scenarios.find((item) => item.name === scenario);
    if (found === undefined) throw new TypeError(`Falta ${scenario}.`);
    return {
      clean: true,
      elements: found.segments.flat().length,
      from,
      open: { open_condition_types: [], pending_continuity_symbols: [] },
      segments: found.segments,
      status: 'due',
      to: from + found.segments.length - 1,
    };
  }

  /**
   * Un pool de `buoh_publicacion` que pasa por un proxy TCP hacia PostgreSQL y corta la conexión
   * durante el `COMMIT`: con `before`, el `COMMIT` no llega al servidor, que deshace la
   * transacción al ver la conexión cerrada; con `after`, llega, el servidor lo confirma y su
   * respuesta no vuelve. En los dos casos, quien publica no sabe cómo terminó. El `COMMIT` sin
   * parámetros va en un mensaje `Query` del protocolo: `Q`, su longitud y `COMMIT` con su cero.
   */
  async function cutPool(cut: 'after' | 'before'): Promise<Pool> {
    const commit = Buffer.concat([
      Buffer.from('Q'),
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('COMMIT\0'),
    ]);
    const server = createServer((client) => {
      const upstream = tcpConnect(config.postgres.port, config.postgres.host);
      let state: 'awaiting_reply' | 'cut' | 'open' = 'open';
      const close = () => {
        state = 'cut';
        client.destroy();
        upstream.destroy();
      };
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('data', (chunk: Buffer) => {
        if (state !== 'open') return;
        if (chunk.includes(commit)) {
          if (cut === 'before') {
            close();
            return;
          }
          state = 'awaiting_reply';
        }
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        if (state === 'cut') return;
        if (state === 'awaiting_reply') {
          // La respuesta del COMMIT: el servidor ya lo confirmó.
          close();
          return;
        }
        client.write(chunk);
      });
    });
    servers.push(server);
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new TypeError('Sin puerto.');
    const pool = createPool({
      ...config.postgres,
      host: '127.0.0.1',
      password: passwords.publication,
      port: address.port,
      schema: DATASETS_SCHEMA,
      user: PUBLICATION_ROLE,
    });
    pools.push(pool);
    return pool;
  }

  /**
   * La publicación de `logNumber` de `sequence` (R_100 sin ella) con `pool`, y su registro operativo
   * con `registryPool`.
   */
  async function publisher(
    logNumber: number,
    pool: Pool,
    registryPool: Pool = pool,
    sequence = 'R_100',
  ) {
    const store = new PostgresDatasetStore(pool);
    const operational = new PostgresOperationalStore(registryPool);
    const registry = await OperationalRegistry.open({
      alert: () => undefined,
      source: fixture.profile.source,
      store: operational,
    });
    const target = objects();
    return {
      operational,
      publish: (due: ReturnType<typeof plan>, publication_id: string, at: string) =>
        publishLiveDataset({
          environment: 'test',
          keyPrefix: KEY_PREFIX,
          logNumber,
          sequence,
          now: () => at.replace(/\.000Z$/u, '.500Z'),
          objects: target,
          plan: due,
          profile: fixture.profile,
          publication_id,
          published_at_utc: at,
          registry,
          store,
          zlibVersion: process.versions.zlib,
        }),
      registry,
      store,
      target,
    };
  }

  it('el log 1 del oro se publica en su propia secuencia, aparte del log 1 de R_100 (ADR-0021 §1)', async () => {
    const publication = poolAs(PUBLICATION_ROLE, passwords.publication);
    const r100 = await publisher(1, publication);
    const before = await r100.store.lastLogRange('R_100', 1);
    const gold = await publisher(1, publication, publication, 'frxXAUUSD');
    const principal = fixture.scenarios.find((item) => item.name === 'principal');
    if (principal === undefined) throw new TypeError('Falta principal.');
    const due = { ...plan('principal', 0), segments: principal.segments.slice(1, 2), to: 0 };
    const outcome = await gold.publish(
      due,
      '019a8000-0000-7000-8000-000000000071',
      '2026-11-14T07:05:00.000Z',
    );
    expect(outcome.status).toBe('published');
    expect(outcome.range).toMatchObject({ first_segment: 0, log_number: 1, sequence: 'frxXAUUSD' });
    const { rows } = await ready(admin).query<{ sequence: string }>(
      `SELECT sequence FROM ${DATASETS_SCHEMA}.dataset_log_ranges
        WHERE publication_id = '019a8000-0000-7000-8000-000000000071'`,
    );
    expect(rows).toEqual([{ sequence: 'frxXAUUSD' }]);
    expect(await gold.store.lastLogRange('frxXAUUSD', 1)).toEqual(outcome.range);
    expect(await r100.store.lastLogRange('R_100', 1)).toEqual(before);
  });

  it('publica con su fila de rango en el mismo commit, en gzip bajo datasets/, y se reproduce en los dos modos', async () => {
    const { publish, store, target } = await publisher(
      1,
      poolAs(PUBLICATION_ROLE, passwords.publication),
    );
    const due = plan('principal', 0);
    const outcome = await publish(
      due,
      '019a8000-0000-7000-8000-000000000011',
      '2026-11-14T06:05:00.000Z',
    );
    expect(outcome.status).toBe('published');
    if (outcome.status !== 'published') return;
    const datasetId = outcome.publication.dataset_id;
    expect(await store.lastLogRange('R_100', 1)).toEqual(outcome.range);
    const { rows } = await ready(admin).query<{ publication_id: string }>(
      `SELECT publication_id::text FROM ${DATASETS_SCHEMA}.dataset_log_ranges WHERE dataset_id = $1`,
      [datasetId],
    );
    expect(rows).toEqual([{ publication_id: '019a8000-0000-7000-8000-000000000011' }]);
    expect(
      outcome.publication.manifest.storage_objects
        .filter((object) => object.role === 'normalized_ticks')
        .every((object) => object.compression === 'gzip'),
    ).toBe(true);
    // Los objetos viven bajo el prefijo datasets/ del bucket.
    const [first] = outcome.publication.manifest.storage_objects;
    if (first === undefined) throw new Error('sin objetos');
    const raw = new S3ObjectStore(createS3Client(config.s3), config.s3.bucket, '');
    await expect(
      raw.get(`${KEY_PREFIX}sha256/${first.object_bytes_sha256}`, 1 << 26),
    ).resolves.toBeInstanceOf(Uint8Array);
    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId,
        environment: 'test',
        keyPrefix: KEY_PREFIX,
        metadata: store,
        mode,
        objects: target,
      });
      expect(report).toMatchObject({ dataset_id: datasetId, mode });
    }
    // Sus filas son append-only, también para un superusuario.
    for (const table of ['datasets', 'published_manifest_records', 'dataset_log_ranges']) {
      expect(
        await sqlState(
          ready(admin),
          `UPDATE ${DATASETS_SCHEMA}.${table} SET dataset_id = dataset_id`,
        ),
        table,
      ).toBe('23001');
      expect(await sqlState(ready(admin), `DELETE FROM ${DATASETS_SCHEMA}.${table}`), table).toBe(
        '23001',
      );
    }
    // Un dataset que deja un hueco tras el último del log choca con lo publicado.
    await expect(
      publish(
        plan('zero-valid-ticks', due.to + 2),
        '019a8000-0000-7000-8000-000000000013',
        '2026-11-14T06:10:00.000Z',
      ),
    ).rejects.toBeInstanceOf(PublicationConflictError);
    // Uno que se solapa con él, también.
    await expect(
      publish(
        plan('zero-valid-ticks', 0),
        '019a8000-0000-7000-8000-000000000012',
        '2026-11-14T06:10:00.000Z',
      ),
    ).rejects.toBeInstanceOf(PublicationConflictError);
  });

  it('un COMMIT cortado que no se confirmó: commit_outcome_unknown, y el reintento lo publica con otro publication_id', async () => {
    // Cada caso publica otro dataset: el dataset_id solo depende del contenido.
    const due = plan('zero-valid-ticks', 0);
    const registryPool = poolAs(PUBLICATION_ROLE, passwords.publication);
    const cut = await publisher(2, await cutPool('before'), registryPool);
    const failure = await cut
      .publish(due, '019a8000-0000-7000-8000-000000000021', '2026-11-14T07:05:00.000Z')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(failure).toMatchObject({ reason: 'commit_outcome_unknown', step: 'manifest_commit' });
    expect(await cut.store.lastLogRange('R_100', 2)).toBe(null);
    expect(cut.registry.openConditionTypes()).toEqual(['persistence_unavailable']);

    const retry = await publisher(2, registryPool, registryPool);
    const outcome = await retry.publish(
      due,
      '019a8000-0000-7000-8000-000000000022',
      '2026-11-14T07:10:00.000Z',
    );
    expect(outcome.status).toBe('published');
    expect((await retry.store.lastLogRange('R_100', 2))?.last_segment).toBe(due.to);
    // La publicación nueva resuelve la condición del intento cortado.
    expect(retry.registry.openConditionTypes()).toEqual([]);
    const resolved = (await retry.operational.load(fixture.profile.source)).conditions.filter(
      (condition) => condition.action === 'resolved',
    );
    expect(resolved.at(-1)?.cause_refs).toContain('019a8000-0000-7000-8000-000000000022');
  });

  it('un COMMIT cortado que se confirmó: commit_outcome_unknown, y el reintento lo encuentra publicado', async () => {
    const principal = fixture.scenarios.find((item) => item.name === 'principal');
    if (principal === undefined) throw new TypeError('Falta principal.');
    const due = { ...plan('principal', 0), segments: principal.segments.slice(0, 1), to: 0 };
    const registryPool = poolAs(PUBLICATION_ROLE, passwords.publication);
    const cut = await publisher(3, await cutPool('after'), registryPool);
    const failure = await cut
      .publish(due, '019a8000-0000-7000-8000-000000000031', '2026-11-14T08:05:00.000Z')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
    // Sí se confirmó: el dataset y su rango son visibles.
    expect((await cut.store.lastLogRange('R_100', 3))?.last_segment).toBe(0);

    const retry = await publisher(3, registryPool, registryPool);
    const outcome = await retry.publish(
      due,
      '019a8000-0000-7000-8000-000000000032',
      '2026-11-14T08:10:00.000Z',
    );
    expect(outcome.status).toBe('already_published');
    if (outcome.status !== 'already_published') return;
    expect(outcome.record.publication_id).toBe('019a8000-0000-7000-8000-000000000031');
    const { rows } = await ready(admin).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${DATASETS_SCHEMA}.published_manifest_records
        WHERE dataset_id = $1`,
      [outcome.record.dataset_id],
    );
    expect(rows[0]?.count).toBe('1');
    // Su hora es anterior a la apertura: la condición sigue abierta.
    expect(retry.registry.openConditionTypes()).toEqual(['persistence_unavailable']);
  });
});
