import { randomBytes } from 'node:crypto';

import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { auditEventSchema, canonicalJson, sha256Hex } from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  API_READER_ROLE,
  API_ROLE,
  createPool,
  createS3Client,
  DATASETS_PREFIX,
  DATASETS_SCHEMA,
  DROP_LOG_LOCK_TIMEOUT_MS,
  findActiveLog,
  healthCommand,
  LOGIN_ROLES,
  loadConfig,
  loadOperationsConfig,
  locateActiveLog,
  logLocation,
  migrate,
  migrateCommand,
  migrateDatasets,
  openHealthStores,
  openLogDeletion,
  openLogObjects,
  openOwnerDatabase,
  openPublicationStores,
  openStores,
  operationsCommand,
  parseStoredHealthObservation,
  POSTGRES_ROLES,
  PostgresSourceLogStore,
  PUBLICATION_ROLE,
  publishDatasetCommand,
  readLatestStoredHealth,
  replayCommand,
  runNodeScript,
  S3ObjectStore,
  SourceEventLog,
  withLog,
  workerChildScript,
  type ChildResult,
  type RunChild,
  type WorkerConfig,
} from '../src/index.js';
import { derivLogProfileRow } from '../src/deriv/log-profile.js';
import { readLogQualityProfile } from '../src/postgres/log-profile.js';
import { START, uuid } from '../test/support/connection-harness.js';
import { contentKey } from '../src/object-keys.js';
import { waitForNoSessions } from '../test/support/databases.js';
import { syntheticSchemas } from '../test/support/connection-harness.js';
import { ManualClock, syntheticSchemaArchive } from '../test/support/deriv-fixtures.js';
import { liveEvents, writeLiveLog } from '../test/support/live-log.js';
import { createDerivPublicationProfile } from '../src/deriv/profile.js';
import { SOURCE_SCHEMA_ENTRY } from '../src/deriv/schema-release.js';
import { previousConnectionEvents } from '../test/support/recovery-harness.js';

/**
 * `buoh-operaciones` (ADR-0018 §11) contra PostgreSQL y S3-compatible locales, con
 * `operationsCommand` y la base real con la credencial dueña (`openOwnerDatabase`). El superusuario
 * de los servicios locales solo hace de Render: crea el usuario por defecto, que no es superusuario
 * y tiene `CREATEROLE`, y su base, `buoh_integration_ops`. Lo demás lo hace el servicio: los roles,
 * el log 1 y el siguiente, sus migraciones, sus privilegios, las contraseñas, la verificación por
 * partes con los objetos reales bajo el prefijo de cada log, el espacio y los informes.
 *
 * Los procesos de `db:migrate`, `data:health`, `datasets:publish` y `data:replay` corren en el
 * mismo proceso de la prueba, con el
 * entorno explícito que les da el servicio (`migrateCommand` y `healthCommand`), porque el servidor
 * local no tiene TLS y en `production` los dos lo exigen: solo sus conexiones van con `disable`, en
 * sus dependencias. Que el entorno de cada proceso sea ese y nada más lo prueban
 * test/operations.test.ts y su `runNodeScript`, con procesos reales.
 *
 * Los roles son de todo el servidor: la prueba borra los suyos y su base al empezar y al terminar.
 * Las contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_ops';
const RENDER_USER = 'buoh_integration_ops_render';
const TEST_ROLES = [
  PUBLICATION_ROLE,
  ...LOGIN_ROLES,
  API_ROLE,
  API_READER_ROLE,
  POSTGRES_ROLES.reader,
  POSTGRES_ROLES.owner,
  RENDER_USER,
];
const LOG_1 = 'buoh_log_000001';
const LOG_2 = 'buoh_log_000002';
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
const secret = () => randomBytes(32).toString('base64');
const passwords = {
  agent: secret(),
  api: secret(),
  health: secret(),
  ingest: secret(),
  publication: secret(),
  reader: secret(),
  render: secret(),
};
let local: WorkerConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;

/** Un valor que se inicializa en `beforeAll`; falla si no llegó a hacerlo. */
function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** La conexión de un proceso, sin TLS: el servidor local no lo tiene. */
const plain = <T extends WorkerConfig['postgres']>(postgres: T): T => ({
  ...postgres,
  sslMode: 'disable',
});
const plainConfig = (config: WorkerConfig): WorkerConfig => ({
  ...config,
  postgres: plain(config.postgres),
});

/** Las variables de `buoh-operaciones` sobre los servicios locales, con otras contraseñas si se dan. */
function operationsEnvironment(rotated: { agent?: string; health?: string } = {}) {
  return {
    BUOH_AGENTE_POSTGRES_PASSWORD: rotated.agent ?? passwords.agent,
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_DUENO_POSTGRES_DB: DATABASE,
    BUOH_DUENO_POSTGRES_HOST: local.postgres.host,
    BUOH_DUENO_POSTGRES_PASSWORD: passwords.render,
    BUOH_DUENO_POSTGRES_PORT: String(local.postgres.port),
    BUOH_DUENO_POSTGRES_SSLMODE: 'require',
    BUOH_DUENO_POSTGRES_USER: RENDER_USER,
    BUOH_INGESTA_POSTGRES_PASSWORD: passwords.ingest,
    BUOH_SALUD_POSTGRES_PASSWORD: rotated.health ?? passwords.health,
    BUOH_SALUD_S3_ACCESS_KEY_ID: local.s3.accessKeyId,
    BUOH_SALUD_S3_BUCKET: local.s3.bucket,
    BUOH_SALUD_S3_ENDPOINT: local.s3.endpoint,
    BUOH_SALUD_S3_REGION: local.s3.region,
    BUOH_SALUD_S3_SECRET_ACCESS_KEY: local.s3.secretAccessKey,
    BUOH_OPERACIONES_S3_ACCESS_KEY_ID: local.s3.accessKeyId,
    BUOH_OPERACIONES_S3_BUCKET: local.s3.bucket,
    BUOH_OPERACIONES_S3_ENDPOINT: local.s3.endpoint,
    BUOH_OPERACIONES_S3_REGION: local.s3.region,
    BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY: local.s3.secretAccessKey,
  };
}

/**
 * `db:migrate` y `data:health` en este proceso, con el entorno que les da el servicio. El
 * `db:migrate` de la API corre en su proceso, con el CLI compilado de `apps/api` y el entorno que le
 * da el servicio, salvo el cifrado, que el servidor local no tiene: `test` y `disable`.
 */
const inProcess: RunChild = async (child, args, env) => {
  if (child === 'api_migrate') {
    return runNodeScript(
      workerChildScript(child, args, {
        ...env,
        BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
        BUOH_POSTGRES_SSLMODE: 'disable',
      }),
    );
  }
  if (child === 'migrate' || child === 'datasets_migrate') {
    const { exitCode, line } = await migrateCommand(env, {
      createPool: (postgres) => createPool(plain(postgres)),
      migrate: child === 'migrate' ? migrate : migrateDatasets,
    });
    return { exitCode, stderr: '', stdout: `${line}\n`, timedOut: false } satisfies ChildResult;
  }
  if (child === 'publish') {
    const progress: string[] = [];
    const { exitCode, line } = await publishDatasetCommand(args, env, {
      alert: () => undefined,
      elapsedMs: () => 0,
      maxRssBytes: () => 0,
      nextId: () => uuid((sequence += 1)),
      now: clock.now,
      open: (config) => openPublicationStores(plainConfig(config), { schemas: fixture.expected }),
      progress: (event) => progress.push(JSON.stringify(event)),
      schemas: fixture.expected,
      zlibVersion: process.versions.zlib,
    });
    return {
      exitCode,
      stderr: progress.map((text) => `${text}\n`).join(''),
      stdout: `${line}\n`,
      timedOut: false,
    };
  }
  if (child === 'replay') {
    const { exitCode, line } = await replayCommand(args, env, {
      maxRssBytes: () => 0,
      openStores: (config) => openStores(plainConfig(config)),
    });
    return { exitCode, stderr: '', stdout: `${line}\n`, timedOut: false };
  }
  const result = await healthCommand(args, env, {
    expected: fixture.expected,
    locateLog: (config, requested) =>
      locateActiveLog(plainConfig(config), {
        now: clock.now,
        number: requested,
        source: DERIV_SOURCE,
      }),
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    openStores: (config) => openHealthStores(plainConfig(config)),
    scheduler: clock.scheduler,
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr === null ? '' : `${result.stderr}\n`,
    stdout: result.stdout === null ? '' : `${result.stdout}\n`,
    timedOut: false,
  };
};

/** Una ejecución del servicio; da su código, sus líneas y sus alertas. */
async function operations(env = operationsEnvironment()) {
  const alerts: unknown[] = [];
  const forwarded: string[] = [];
  const result = await operationsCommand(env, {
    alert: (payload) => alerts.push(payload),
    forwardChildStderr: (text) => forwarded.push(text),
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    openDatabase: (config) =>
      openOwnerDatabase({ ...config, owner: plain(config.owner) }, { source: DERIV_SOURCE }),
    openDeletion: (config, location) => openLogDeletion(config.operationsObjects, location),
    openObjects: (config, location) => openLogObjects(config.operationsObjects, location),
    runChild: inProcess,
    scheduler: clock.scheduler,
  });
  const lines = result.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const step = (name: string) => lines.find((line) => line['step'] === name);
  return { alerts, exitCode: result.exitCode, forwarded, lines, step, steps: lines.slice(0, -1) };
}

/** Los informes guardados en un log, en orden. */
async function reportsOf(schema: string) {
  const { rows } = await ready(admin).query<{
    report_jcs: string;
    status: string;
    step: string;
  }>(`SELECT step, status, report_jcs FROM ${schema}.operations_reports ORDER BY report_id`);
  return rows.map((row) => ({
    report: JSON.parse(row.report_jcs) as Record<string, unknown>,
    status: row.status,
    step: row.step,
  }));
}

/** El código SQLSTATE con que falla `text` con ese usuario, o `null` si no falla. */
async function sqlStateAs(
  user: string,
  password: string,
  text: string,
  values: unknown[] = [],
): Promise<string | null> {
  const pool = createPool({
    ...local.postgres,
    database: DATABASE,
    password,
    schema: 'public',
    user,
  });
  try {
    return await pool.query(text, values).then(
      () => null,
      (error: unknown) => String((error as { code?: unknown }).code),
    );
  } finally {
    await pool.end();
  }
}

async function dropDatabaseAndRoles(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  for (const role of TEST_ROLES) {
    await server.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

beforeAll(async () => {
  local = loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' });
  platform = createPool({ ...local.postgres, schema: 'public' });
  await dropDatabaseAndRoles(platform);
  await platform.query(
    `CREATE ROLE ${RENDER_USER} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.render)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE} OWNER ${RENDER_USER}`);
  admin = createPool({ ...local.postgres, database: DATABASE, schema: 'public' });
});

afterAll(async () => {
  await admin?.end();
  if (platform !== undefined) {
    // Sin sesiones: `DROP DATABASE … WITH (FORCE)` terminaría las que todavía se cierran.
    await waitForNoSessions(platform, DATABASE);
    await dropDatabaseAndRoles(platform);
    await platform.end();
  }
});

describe('buoh-operaciones (ADR-0018 §11)', () => {
  it('la primera ejecución crea los roles y el log 1, con sus siete migraciones como buoh_dueno, sus privilegios y las contraseñas, y guarda en él la salud, la verificación y el espacio', async () => {
    const run = await operations();
    expect(run.alerts).toEqual([]);
    // data:health leyó el log sin ninguna alerta: ni un almacén sin responder ni un rechazo.
    expect(run.forwarded).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.steps.map((line) => [line['step'], line['status']])).toEqual([
      ['roles_and_logs', 'completed'],
      ['health', 'completed'],
      // Ningún log terminó: el informe final no guarda nada (ADR-0018 §6, «Traspaso»). Ninguno
      // venció: la retención tampoco.
      ['final_health', 'completed'],
      ['retention', 'completed'],
      ['verification', 'completed'],
      ['space', 'completed'],
    ]);
    // A las 10:00 UTC toca la ejecución 120; el log 1 todavía no tiene segmentos.
    expect(run.step('verification')?.['report']).toEqual({
      due: 0,
      mismatched: [],
      read: 0,
      slot: 120,
    });
    expect(run.steps[0]?.['report']).toMatchObject({
      failures: [],
      migrated: [{ log: 1 }],
      passwords_set: ['buoh_ingesta', 'buoh_salud', 'buoh_agente'],
      prepared: 1,
    });
    const owners = await ready(admin).query<{ owner: string }>(
      `SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = $1
       UNION SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1`,
      [LOG_1],
    );
    expect(owners.rows).toEqual([{ owner: POSTGRES_ROLES.owner }]);
    const migrations = await ready(admin).query(`SELECT name FROM ${LOG_1}.buoh_schema_migrations`);
    expect(migrations.rowCount).toBe(7);
    // El perfil del log nuevo (ADR-0020 §4): el de publicación, que dio esta ejecución.
    expect(run.steps[0]?.['report']).toMatchObject({ profiles_assigned: [1] });
    const profile = await ready(admin).query(
      `SELECT profile_slot, profile_id, quality_profile_sha256, run_id::text, assigned_at_utc
         FROM ${LOG_1}.log_quality_profile`,
    );
    expect(profile.rows).toEqual([
      {
        ...derivLogProfileRow('R_100'),
        assigned_at_utc: START,
        profile_slot: 1,
        run_id: run.steps[0]?.['run_id'],
      },
    ]);

    const reports = await reportsOf(LOG_1);
    expect(reports.map((item) => [item.step, item.status])).toEqual([
      ['roles_and_logs', 'completed'],
      ['health', 'completed'],
      ['verification', 'completed'],
      ['space', 'completed'],
    ]);
    expect(reports[1]?.report).toMatchObject({
      alerts: [],
      exit_code: 1,
      log: 1,
      report: {
        connection_state: 'disconnected',
        service_health: 'paused',
        source: DERIV_SOURCE,
      },
    });
  });

  it('los roles de ejecución inician sesión con sus contraseñas; buoh_ingesta no toca los informes y buoh_salud los lee', async () => {
    const reports = `SELECT count(*) FROM ${LOG_1}.operations_reports`;
    expect(await sqlStateAs(POSTGRES_ROLES.ingest, passwords.ingest, reports)).toBe('42501');
    expect(
      await sqlStateAs(
        POSTGRES_ROLES.ingest,
        passwords.ingest,
        `INSERT INTO ${LOG_1}.operations_reports (report_id, run_id, step, status, observed_at_utc, report_jcs)
         VALUES ('${uuid(9001)}', '${uuid(9002)}', 'health', 'completed', '${START}', '{}')`,
      ),
    ).toBe('42501');
    expect(await sqlStateAs(POSTGRES_ROLES.health, passwords.health, reports)).toBeNull();
    expect(await sqlStateAs(POSTGRES_ROLES.agent, passwords.agent, reports)).toBeNull();
  });

  it('log_quality_profile (ADR-0020 §4): buoh_ingesta y buoh_lectura solo la leen (42501 al insertar), es append-only y admite una sola fila', async () => {
    const table = `${LOG_1}.log_quality_profile`;
    const insert = (slot: number) =>
      `INSERT INTO ${table} (profile_slot, profile_id, quality_profile_sha256, run_id, assigned_at_utc)
       VALUES (${String(slot)}, 'deriv_options-publication-v1-R_100', '${'a'.repeat(64)}',
               '${uuid(9301)}', '${START}')`;
    for (const [role, password] of [
      [POSTGRES_ROLES.ingest, passwords.ingest],
      [POSTGRES_ROLES.health, passwords.health],
      [POSTGRES_ROLES.agent, passwords.agent],
    ] as const) {
      expect(await sqlStateAs(role, password, `SELECT count(*) FROM ${table}`), role).toBeNull();
      expect(await sqlStateAs(role, password, insert(1)), role).toBe('42501');
    }
    const asOwner = (statement: string) =>
      sqlStateAs(RENDER_USER, passwords.render, `SET ROLE ${POSTGRES_ROLES.owner}; ${statement}`);
    // Una segunda fila: la clave constante la rechaza, y otra clave, su CHECK.
    expect(await asOwner(insert(1))).toBe('23505');
    expect(await asOwner(insert(2))).toBe('23514');
    for (const statement of [
      `UPDATE ${table} SET profile_id = 'otro'`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ]) {
      expect(await asOwner(statement), statement).toBe('23001');
    }
    const rows = await ready(admin).query(`SELECT profile_id FROM ${table}`);
    expect(rows.rows).toEqual([{ profile_id: 'deriv_options-publication-v1-R_100' }]);
  });

  it('operations_reports es append-only: UPDATE, DELETE y TRUNCATE fallan con 23001, también como buoh_dueno, su dueño', async () => {
    const before = await reportsOf(LOG_1);
    expect(before.length).toBeGreaterThan(0);
    for (const statement of [
      `UPDATE ${LOG_1}.operations_reports SET status = 'failed'`,
      `DELETE FROM ${LOG_1}.operations_reports`,
      `TRUNCATE ${LOG_1}.operations_reports`,
    ]) {
      expect(
        await sqlStateAs(
          RENDER_USER,
          passwords.render,
          `SET ROLE ${POSTGRES_ROLES.owner}; ${statement}`,
        ),
      ).toBe('23001');
    }
    expect(await reportsOf(LOG_1)).toEqual(before);
  });

  it('sin nada que cambiar, no crea otro log ni pone contraseñas, y solo guarda los informes de la salud y de la verificación', async () => {
    const run = await operations();
    expect(run.exitCode).toBe(0);
    expect(run.steps[0]?.['report']).toEqual({
      failures: [],
      migrated: [],
      passwords_set: [],
      passwords_unchecked: [],
      prepared: null,
      profiles_assigned: [],
    });
    // El espacio ya se midió hoy: no vuelve a medir ni guarda su informe.
    expect(run.step('space')?.['report']).toMatchObject({ measured: false });
    expect((await reportsOf(LOG_1)).map((item) => item.step)).toEqual([
      'roles_and_logs',
      'health',
      'verification',
      'space',
      'health',
      'verification',
    ]);
    const logs = await ready(admin).query(
      "SELECT 1 FROM pg_namespace WHERE nspname ~ '^buoh_log_'",
    );
    expect(logs.rowCount).toBe(1);
  });

  it('en cuanto ingest escribe en el log 1, prepara el log 2, y la salud sigue en el log 1', async () => {
    expect(
      await sqlStateAs(
        POSTGRES_ROLES.ingest,
        passwords.ingest,
        `INSERT INTO ${LOG_1}.ingestion_heartbeats
           (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
            backlog_count, backlog_bytes)
         VALUES ('${uuid(9101)}', '${DERIV_SOURCE}', '${uuid(9102)}', '${START}', 4242,
                 'connecting', 0, 0)`,
      ),
    ).toBeNull();
    const run = await operations();
    expect(run.exitCode).toBe(0);
    expect(run.steps[0]?.['report']).toMatchObject({ migrated: [{ log: 2 }], prepared: 2 });
    expect(run.steps[1]).toMatchObject({ log: 1, status: 'completed' });
    expect(
      await sqlStateAs(
        POSTGRES_ROLES.ingest,
        passwords.ingest,
        `SELECT 1 FROM ${LOG_2}.ingestion_cursors`,
      ),
    ).toBeNull();
    // El informe del paso 1 queda en el log activo, el 1, como el de la salud.
    expect((await reportsOf(LOG_1)).map((item) => item.step).slice(-3)).toEqual([
      'roles_and_logs',
      'health',
      'verification',
    ]);
  });

  it('con las 4 conexiones de buoh_agente abiertas, su contraseña no se puede comprobar (53300): no se pone ni es un fallo, y una rotada se aplica igual', async () => {
    const agent = createPool({
      ...local.postgres,
      database: DATABASE,
      password: passwords.agent,
      schema: 'public',
      user: POSTGRES_ROLES.agent,
    });
    const held = await Promise.all([1, 2, 3, 4].map(() => agent.connect()));
    try {
      const run = await operations();
      expect(run.alerts).toEqual([]);
      expect(run.forwarded).toEqual([]);
      expect(run.exitCode).toBe(0);
      expect(run.steps[0]?.['report']).toEqual({
        failures: [],
        migrated: [],
        passwords_set: [],
        passwords_unchecked: [POSTGRES_ROLES.agent],
        prepared: null,
        profiles_assigned: [],
      });

      // PostgreSQL rechaza una contraseña mala (28P01) antes de mirar el límite del rol.
      const rotated = secret();
      const rotation = await operations(operationsEnvironment({ agent: rotated }));
      expect(rotation.exitCode).toBe(0);
      expect(rotation.steps[0]?.['report']).toMatchObject({
        passwords_set: [POSTGRES_ROLES.agent],
        passwords_unchecked: [],
      });
      passwords.agent = rotated;
    } finally {
      for (const client of held) {
        client.release();
      }
      await agent.end();
    }
  });

  it('los segmentos que tocan en una ejecución son los de índice i con i mod 288 igual a ella, de la fuente del servicio, en orden', async () => {
    // Una copia de la tabla en un esquema que no es de un log, para que ninguna ejecución la vea.
    const schema = 'buoh_integration_ops_modulo';
    await ready(admin).query(`CREATE SCHEMA ${schema} AUTHORIZATION ${POSTGRES_ROLES.owner}`);
    await ready(admin).query(
      `CREATE TABLE ${schema}.closed_source_segments
         (LIKE ${LOG_1}.closed_source_segments INCLUDING ALL)`,
    );
    await ready(admin).query(
      `ALTER TABLE ${schema}.closed_source_segments OWNER TO ${POSTGRES_ROLES.owner}`,
    );
    await ready(admin).query(
      `INSERT INTO ${schema}.closed_source_segments
         (source, segment_index, event_count, raw_frame_count, byte_count, logical_content_sha256,
          object_bytes_sha256, object_size_bytes, compression, close_reason,
          segment_policy_version, first_event_time_utc, last_event_time_utc)
       SELECT source, i, 1, 0, 10, repeat('a', 64), repeat('b', 64), 10, 'none', 'window',
              '1.0.0', '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z'
         FROM (VALUES ($1, 0), ($1, 287), ($1, 288), ($1, 289), ($1, 576), ('synthetic', 0))
              AS rows (source, i)`,
      [DERIV_SOURCE],
    );
    const config = loadOperationsConfig(operationsEnvironment());
    const database = openOwnerDatabase(
      { ...config, owner: plain(config.owner) },
      { source: DERIV_SOURCE },
    );
    try {
      const location = { number: 999_999, prefix: 'logs/999999/', schema };
      const indexes = async (slot: number) =>
        (await database.listSegmentsDue(location, slot)).map((row) => row.segment_index);
      expect(await indexes(0)).toEqual([0, 288, 576]);
      expect(await indexes(1)).toEqual([289]);
      expect(await indexes(287)).toEqual([287]);
      expect(await indexes(2)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('assignLogProfile solo da el perfil a un log sin fila, sin escrituras y sin el uso de buoh_ingesta; readLogQualityProfile la lee (ADR-0020 §4)', async () => {
    // Esquemas que no son de un log, para que ninguna ejecución los vea, con las migraciones de un log.
    const schemas = {
      fresh: 'buoh_integration_ops_profile_fresh',
      granted: 'buoh_integration_ops_profile_granted',
      heartbeat: 'buoh_integration_ops_profile_heartbeat',
      written: 'buoh_integration_ops_profile_written',
    } as const;
    const location = (schema: string) => ({ number: 999_999, prefix: 'logs/999999/', schema });
    for (const schema of Object.values(schemas)) {
      await ready(admin).query(`CREATE SCHEMA ${schema} AUTHORIZATION ${POSTGRES_ROLES.owner}`);
      const pool = createPool({
        ...local.postgres,
        database: DATABASE,
        password: passwords.render,
        schema,
        user: RENDER_USER,
      });
      try {
        await migrate(pool, { ownerRole: POSTGRES_ROLES.owner });
      } finally {
        await pool.end();
      }
    }
    await ready(admin).query(
      `GRANT USAGE ON SCHEMA ${schemas.granted} TO ${POSTGRES_ROLES.ingest}`,
    );
    await ready(admin).query(
      `INSERT INTO ${schemas.heartbeat}.ingestion_heartbeats
         (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
          backlog_count, backlog_bytes)
       VALUES ('${uuid(9311)}', 'synthetic', '${uuid(9312)}', '${START}', 4343, 'connecting', 0, 0)`,
    );
    await ready(admin).query(
      // Su disparador busca los segmentos del log con el search_path: el del esquema.
      `SET search_path TO ${schemas.written};
       INSERT INTO ${schemas.written}.source_event_index
         (source, segment_index, position, event_id, kind, event_time_utc, object_sha256, byte_length)
       VALUES ('synthetic', 0, 0, '${uuid(9314)}', 'connection_opened', '${START}', '${'c'.repeat(64)}', 10);
       RESET search_path`,
    );
    const config = loadOperationsConfig(operationsEnvironment());
    const database = openOwnerDatabase(
      { ...config, owner: plain(config.owner) },
      { source: DERIV_SOURCE },
    );
    const row = { ...derivLogProfileRow('R_100'), assigned_at_utc: START, run_id: uuid(9313) };
    try {
      expect(await database.assignLogProfile(location(schemas.fresh), row)).toBe(true);
      // Ya tiene su fila: la segunda vez no inserta nada, tampoco con otro perfil.
      expect(
        await database.assignLogProfile(location(schemas.fresh), {
          ...row,
          profile_id: 'otro',
        }),
      ).toBe(false);
      expect(await database.assignLogProfile(location(schemas.granted), row)).toBe(false);
      expect(await database.assignLogProfile(location(schemas.heartbeat), row)).toBe(false);
      expect(await database.assignLogProfile(location(schemas.written), row)).toBe(false);
      const reader = ready(admin);
      expect(await readLogQualityProfile(reader, schemas.fresh)).toEqual(
        derivLogProfileRow('R_100'),
      );
      expect(await readLogQualityProfile(reader, schemas.granted)).toBeNull();
      expect(await readLogQualityProfile(reader, schemas.heartbeat)).toBeNull();
      expect(await readLogQualityProfile(reader, schemas.written)).toBeNull();
      // Un esquema sin la tabla, como un log sin la migración 0007: tampoco tiene perfil.
      expect(await readLogQualityProfile(reader, 'public')).toBeNull();
    } finally {
      await database.close();
      for (const schema of Object.values(schemas)) {
        await ready(admin).query(`DROP SCHEMA ${schema} CASCADE`);
      }
    }
  });

  it('una contraseña nueva de un rol, como tras una rotación, se aplica antes de la salud, que ya la usa', async () => {
    const rotated = secret();
    const run = await operations(operationsEnvironment({ health: rotated }));
    expect(run.exitCode).toBe(0);
    expect(run.forwarded).toEqual([]);
    expect(run.steps[0]?.['report']).toMatchObject({ passwords_set: ['buoh_salud'] });
    expect(run.steps[1]).toMatchObject({ status: 'completed' });
    expect(await sqlStateAs(POSTGRES_ROLES.health, rotated, 'SELECT 1')).toBeNull();
    expect(await sqlStateAs(POSTGRES_ROLES.health, passwords.health, 'SELECT 1')).toBe('28P01');
  });

  // Los eventos que escribe en el log 1, sin su esquema de fuente guardado, cambian la salud de las
  // ejecuciones siguientes: la prueba de la retención, después, no la mira.
  it('vuelve a leer con el token operaciones el segmento que toca, bajo el prefijo del log; uno que falta deja su alerta; y el espacio se mide una vez al día', async () => {
    const location = logLocation(1);
    const target = withLog(
      { ...local, postgres: { ...local.postgres, database: DATABASE } },
      location,
    );
    /** Escribe en el log 1 los eventos de una conexión y cierra su segmento: da su fila. */
    const writeSegment = async () => {
      const stores = openStores(target);
      try {
        const log = await SourceEventLog.open({
          objects: stores.objects,
          source: DERIV_SOURCE,
          store: stores.sourceLog,
          zlibVersion: process.versions.zlib,
        });
        for (const event of previousConnectionEvents()) {
          await log.append(event);
        }
        return await log.close('requested');
      } finally {
        await stores.close();
      }
    };
    const closed = await writeSegment();
    expect(closed).toMatchObject({ segment_index: 0 });
    if (closed === null) {
      throw new TypeError('Falta el segmento cerrado.');
    }
    const key = `sha256/${closed.object_bytes_sha256}`;
    const objects = S3ObjectStore.fromConfig(target.s3);
    const bytes = await objects.get(key, closed.object_size_bytes);

    // A las 00:00 UTC del día siguiente toca la ejecución 0: la del segmento 0.
    clock.jumpWallClock(Date.parse('2026-03-03T00:00:00.000Z') - Date.parse(clock.now()));
    const first = await operations();
    expect(first.exitCode).toBe(0);
    expect(first.alerts).toEqual([]);
    expect(first.step('verification')).toMatchObject({
      report: { due: 1, mismatched: [], read: 1, slot: 0 },
      status: 'completed',
    });
    const space = first.step('space')?.['report'] as {
      database_bytes: number;
      logs: { bytes: number; log: number }[];
      measured: boolean;
    };
    expect(space.measured).toBe(true);
    expect(space.logs.map((item) => item.log)).toEqual([1, 2]);
    expect(space.logs.every((item) => item.bytes > 0)).toBe(true);
    expect(space.database_bytes).toBeGreaterThanOrEqual(
      space.logs.reduce((sum, item) => sum + item.bytes, 0),
    );

    const s3 = new S3Client({
      credentials: {
        accessKeyId: local.s3.accessKeyId,
        secretAccessKey: local.s3.secretAccessKey,
      },
      endpoint: local.s3.endpoint,
      forcePathStyle: true,
      region: local.s3.region,
    });
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: local.s3.bucket, Key: `${location.prefix}${key}` }),
      );
      const second = await operations();
      expect(second.exitCode).toBe(0);
      expect(second.step('verification')).toMatchObject({
        report: {
          due: 1,
          mismatched: [{ log: 1, reason: 'object_missing', segment_index: 0 }],
          read: 1,
          slot: 0,
        },
        status: 'completed',
      });
      expect(second.alerts).toEqual([
        {
          event: 'operations_segment_mismatch',
          log: '1',
          reason: 'object_missing',
          segment_index: '0',
        },
      ]);
      expect(second.step('space')?.['report']).toMatchObject({ measured: false });
      const stored = (await reportsOf(LOG_1)).filter((item) => item.step !== 'health');
      expect(stored.slice(-3).map((item) => item.step)).toEqual([
        'verification',
        'space',
        'verification',
      ]);
      expect(stored.at(-1)?.report).toMatchObject({
        mismatched: [{ log: 1, reason: 'object_missing', segment_index: 0 }],
      });

      // Con el objeto otra vez en su sitio, a las 00:05 toca la ejecución 1: el segmento 0 espera
      // al día siguiente.
      expect(await objects.putIfAbsent(key, bytes, 'application/gzip')).toBe('created');
      clock.jumpWallClock(5 * 60 * 1000);
      const third = await operations();
      expect(third.alerts).toEqual([]);
      expect(third.step('verification')?.['report']).toEqual({
        due: 0,
        mismatched: [],
        read: 0,
        slot: 1,
      });

      // Un día con solo una medida fallida, como la que guarda el servicio si PostgreSQL no
      // responde: no cuenta, así que la ejecución siguiente vuelve a medir.
      clock.jumpWallClock(24 * 60 * 60 * 1000);
      await ready(admin).query(
        `INSERT INTO ${LOG_1}.operations_reports
           (report_id, run_id, step, status, observed_at_utc, report_jcs)
         VALUES ($1, $2, 'space', 'failed', $3, '{"reason":"57P01"}')`,
        [uuid(9201), uuid(9202), '2026-03-04T00:01:00.000Z'],
      );
      const fourth = await operations();
      expect(fourth.step('space')?.['report']).toMatchObject({ measured: true });
    } finally {
      // Lo deja como estaba: el bucket es de todas las pruebas.
      await objects.putIfAbsent(key, bytes, 'application/gzip');
      objects.destroy();
      s3.destroy();
    }
  });

  // Después de la verificación: el log 1 tiene su latido de las 10:00 UTC del 2026-03-02 y sus
  // objetos bajo logs/000001/, y el log 2 está preparado.
  it('la retención: vence el log 1 y se borran su prefijo y su esquema, sin tocar los objetos ni las filas de los logs 2 y 3; después vence el 2, el activo de una captura detenida, y el preparado queda', async () => {
    const s3 = new S3Client({
      credentials: {
        accessKeyId: local.s3.accessKeyId,
        secretAccessKey: local.s3.secretAccessKey,
      },
      endpoint: local.s3.endpoint,
      forcePathStyle: true,
      region: local.s3.region,
    });
    /** Las claves del bucket bajo el prefijo, con su listado propio, sin el código del worker. */
    const keysUnder = async (prefix: string): Promise<string[]> => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: local.s3.bucket,
            ContinuationToken: token,
            Prefix: prefix,
          }),
        );
        keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ?? []));
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return keys.sort();
    };
    const schemaExists = async (schema: string): Promise<boolean> =>
      ((await ready(admin).query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]))
        .rowCount ?? 0) > 0;
    /** Las filas de las tablas de la captura de un log, que la retención de otro no puede cambiar. */
    const captureRows = async (schema: string) =>
      Promise.all(
        ['ingestion_heartbeats', 'source_event_index', 'closed_source_segments'].map(
          async (table) =>
            (
              await ready(admin).query<Record<string, unknown>>(
                `SELECT * FROM ${schema}.${table} ORDER BY 1, 2, 3`,
              )
            ).rows,
        ),
      );
    const LOG_3 = 'buoh_log_000003';
    const second = withLog(
      { ...local, postgres: { ...local.postgres, database: DATABASE } },
      logLocation(2),
    );
    const secondObjects = S3ObjectStore.fromConfig(second.s3);
    try {
      // Una escritura en el log 2, de la hora de la prueba: el servicio prepara el log 3.
      const writtenAt = clock.now();
      expect(
        await sqlStateAs(
          POSTGRES_ROLES.ingest,
          passwords.ingest,
          `INSERT INTO ${LOG_2}.ingestion_heartbeats
             (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
              backlog_count, backlog_bytes)
           VALUES ('${uuid(9301)}', '${DERIV_SOURCE}', '${uuid(9302)}', '${writtenAt}', 4343,
                   'connecting', 0, 0)`,
        ),
      ).toBeNull();
      for (const index of [1, 2]) {
        const bytes = new Uint8Array(randomBytes(64));
        expect(
          await secondObjects.putIfAbsent(`sha256/retencion-${String(index)}`, bytes, 'x/y'),
        ).toBe('created');
      }
      const prepared = await operations();
      expect(prepared.steps[0]?.['report']).toMatchObject({ prepared: 3 });

      const firstKeys = await keysUnder('logs/000001/');
      const secondKeys = await keysUnder('logs/000002/');
      expect(firstKeys.length).toBeGreaterThan(0);
      expect(secondKeys).toEqual(
        expect.arrayContaining([
          'logs/000002/sha256/retencion-1',
          'logs/000002/sha256/retencion-2',
        ]),
      );
      const secondRows = await captureRows(LOG_2);
      // Un dataset vivo: un objeto bajo datasets/ y el esquema buoh_datasets, de buoh_dueno, con una
      // fila. La retención de un log no los toca (ADR-0020 §5 y §12).
      const datasetKey = `${DATASETS_PREFIX}sha256/${sha256Hex('retencion-dataset')}`;
      const root = new S3ObjectStore(createS3Client(local.s3), local.s3.bucket, '');
      await root.putIfAbsent(datasetKey, new TextEncoder().encode('retencion-dataset'), 'x/y');
      root.destroy();
      await migrateDatasets(ready(admin), { ownerRole: POSTGRES_ROLES.owner });
      await ready(admin).query(
        `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
         VALUES ('sha256:' || encode(sha256('{}'), 'hex'), 'published', $1, '{}')`,
        [DERIV_SOURCE],
      );
      const datasetRows = async (): Promise<unknown[]> => {
        const result = await ready(admin).query<Record<string, unknown>>(
          `SELECT * FROM ${DATASETS_SCHEMA}.datasets`,
        );
        return result.rows;
      };
      const datasetsBefore = await datasetRows();
      expect(datasetsBefore).toHaveLength(1);

      // El borrado del esquema vuelve a mirar la última escritura en su transacción: antes de vencer
      // no borra nada; un log que no existe no es un fallo; y con alguien leyendo sus tablas espera
      // como mucho DROP_LOG_LOCK_TIMEOUT_MS y falla con 55P03, sin borrarlo.
      const config = loadOperationsConfig(operationsEnvironment());
      const database = openOwnerDatabase(
        { ...config, owner: plain(config.owner) },
        { source: DERIV_SOURCE },
      );
      try {
        expect(await database.dropExpiredLog(logLocation(1), '2026-04-01T09:59:59.999Z')).toBe(
          'not_expired',
        );
        expect(await database.dropExpiredLog(logLocation(999_998), clock.now())).toBe('absent');
        const reader = await ready(admin).connect();
        try {
          await reader.query('BEGIN');
          await reader.query(`SELECT 1 FROM ${LOG_1}.ingestion_heartbeats LIMIT 1`);
          const started = Date.now();
          await expect(
            database.dropExpiredLog(logLocation(1), '2026-04-01T10:00:00.000Z'),
          ).rejects.toMatchObject({ code: '55P03' });
          const waited = Date.now() - started;
          expect(waited).toBeGreaterThanOrEqual(DROP_LOG_LOCK_TIMEOUT_MS - 50);
          expect(waited).toBeLessThan(DROP_LOG_LOCK_TIMEOUT_MS + 2000);
        } finally {
          await reader.query('ROLLBACK');
          reader.release();
        }
      } finally {
        await database.close();
      }
      expect(await schemaExists(LOG_1)).toBe(true);

      // Un milisegundo antes de los 30 días de la última escritura del log 1, nada vence.
      clock.jumpWallClock(Date.parse('2026-04-01T09:59:59.999Z') - Date.parse(clock.now()));
      const early = await operations();
      expect(early.step('retention')).toMatchObject({
        report: { log: null },
        status: 'completed',
      });
      expect(await keysUnder('logs/000001/')).toEqual(firstKeys);
      expect(await schemaExists(LOG_1)).toBe(true);

      // A los 30 días justos vence, y una sola ejecución lo borra: primero su prefijo, después su
      // esquema.
      clock.jumpWallClock(1);
      const expired = await operations();
      expect(expired.step('retention')).toMatchObject({
        event: 'operations_step',
        log: null,
        status: 'completed',
      });
      expect(expired.step('retention')?.['report']).toEqual({
        deleted: firstKeys.length,
        locked: 0,
        log: 1,
        schema_dropped: true,
      });
      expect(await keysUnder('logs/000001/')).toEqual([]);
      expect(await schemaExists(LOG_1)).toBe(false);
      expect(await keysUnder(datasetKey)).toEqual([datasetKey]);
      expect(await schemaExists(DATASETS_SCHEMA)).toBe(true);
      expect(await datasetRows()).toEqual(datasetsBefore);
      expect(await keysUnder('logs/000002/')).toEqual(secondKeys);
      expect(await captureRows(LOG_2)).toEqual(secondRows);
      expect(await schemaExists(LOG_3)).toBe(true);
      // El informe queda en el log activo, el 2.
      expect((await reportsOf(LOG_2)).filter((item) => item.step === 'retention')).toEqual([
        {
          report: { deleted: firstKeys.length, locked: 0, log: 1, schema_dropped: true },
          status: 'completed',
          step: 'retention',
        },
      ]);

      // Sin captura, el log 2, el activo, vence a los 30 días de su latido; el 3, preparado, queda,
      // y pasa a ser el activo.
      clock.jumpWallClock(
        Date.parse(writtenAt) + 30 * 24 * 60 * 60 * 1000 - Date.parse(clock.now()),
      );
      const stopped = await operations();
      expect(stopped.step('retention')).toMatchObject({
        report: { deleted: secondKeys.length, locked: 0, log: 2, schema_dropped: true },
        status: 'completed',
      });
      expect(await keysUnder('logs/000002/')).toEqual([]);
      expect(await schemaExists(LOG_2)).toBe(false);
      expect(await keysUnder(datasetKey)).toEqual([datasetKey]);
      expect(await datasetRows()).toEqual(datasetsBefore);
      expect(await schemaExists(LOG_3)).toBe(true);
      expect(stopped.steps[0]?.['report']).toMatchObject({ prepared: null });
      expect((await reportsOf(LOG_3)).map((item) => item.step)).toContain('retention');
    } finally {
      secondObjects.destroy();
      s3.destroy();
    }
  });

  it('con la contraseña de buoh_api, el paso 1 crea el rol, migra buoh_api como buoh_dueno con el db:migrate de la API y le da solo SELECT e INSERT; buoh_lectura no la lee (ADR-0019 §7)', async () => {
    // Hasta aquí, sin la contraseña, como en producción hasta el PR 6, el servicio no tocó la API.
    const api = async () => {
      const { rows } = await ready(admin).query<{ roles: number; schemas: number }>(
        `SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS roles,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname = $1) AS schemas`,
        [API_ROLE],
      );
      return rows[0];
    };
    expect(await api()).toEqual({ roles: 0, schemas: 0 });

    const env = { ...operationsEnvironment(), BUOH_API_POSTGRES_PASSWORD: passwords.api };
    const first = await operations(env);
    expect(first.alerts).toEqual([]);
    expect(first.step('roles_and_logs')).toMatchObject({
      report: {
        api_migrated: [
          '0001_auditoria.sql',
          '0002_cuentas.sql',
          '0003_sesiones.sql',
          '0004_preferencias.sql',
        ],
        failures: [],
        passwords_set: [API_ROLE],
      },
      status: 'completed',
    });
    expect(await api()).toEqual({ roles: 1, schemas: 1 });
    const { rows: owners } = await ready(admin).query<{ owner: string; name: string }>(
      `SELECT nspname AS name, nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = $1
        UNION ALL
       SELECT tablename, tableowner FROM pg_tables WHERE schemaname = $1
        ORDER BY name`,
      [API_ROLE],
    );
    expect(owners).toEqual(
      [
        'account_links',
        'account_preferences',
        'accounts',
        'audit_events',
        'buoh_api',
        'buoh_schema_migrations',
        'credential_disablements',
        'credentials',
        'link_totp_secrets',
        'session_activity',
        'session_closures',
        'sessions',
        'totp_steps_used',
      ].map((name) => ({ name, owner: POSTGRES_ROLES.owner })),
    );

    // buoh_api lee e inserta en sus tablas, y nada más.
    const asApi = (text: string, values: unknown[] = []) =>
      sqlStateAs(API_ROLE, passwords.api, text, values);
    const event = auditEventSchema.parse({
      account_id: '01900000-0000-7000-8000-00000000a001',
      action: 'session_started',
      actor: 'account',
      audit_event_id: '01900000-0000-7000-8000-000000000001',
      objects: [{ id: '01900000-0000-7000-8000-00000000b001', kind: 'session' }],
      occurred_at_utc: '2026-11-03T10:00:00.000Z',
      reason: 'password_and_totp',
      request_id: '00000000-0000-4000-8000-000000000001',
      schema_version: '1.0.0',
    });
    expect(
      await asApi(
        `INSERT INTO buoh_api.audit_events
           (audit_event_id, account_id, occurred_at_utc, action, event_jcs)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event.audit_event_id,
          event.account_id,
          event.occurred_at_utc,
          event.action,
          canonicalJson(event),
        ],
      ),
    ).toBeNull();
    for (const text of [
      'SELECT count(*) FROM buoh_api.audit_events',
      'SELECT count(*) FROM buoh_api.buoh_schema_migrations',
    ]) {
      expect(await asApi(text), text).toBeNull();
    }
    // Con sus privilegios, buoh_api inserta en una tabla con el trigger de write_order, que necesita
    // el uso de su secuencia, y aunque pida el máximo de bigint, la base guarda el de la secuencia.
    expect(
      await asApi(
        `INSERT INTO buoh_api.accounts (account_id, username, created_at_utc)
         VALUES ('01900000-0000-7000-8000-00000000a001', 'operaciones', '2026-11-03T10:00:00.000Z')`,
      ),
    ).toBeNull();
    expect(
      await asApi(
        `INSERT INTO buoh_api.account_links
           (link_id, write_order, account_id, purpose, token_hmac, created_at_utc, expires_at_utc)
         OVERRIDING SYSTEM VALUE
         VALUES ('01900000-0000-7000-8000-00000000c001', 9223372036854775807,
                 '01900000-0000-7000-8000-00000000a001', 'enrollment', decode(repeat('ab', 32), 'hex'),
                 '2026-11-03T10:00:00.000Z', '2026-11-03T10:15:00.000Z')`,
      ),
    ).toBeNull();
    const { rows: orders } = await ready(admin).query<{ write_order: string }>(
      'SELECT write_order::text AS write_order FROM buoh_api.account_links',
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]?.write_order).not.toBe('9223372036854775807');
    for (const text of [
      "INSERT INTO buoh_api.buoh_schema_migrations (name, sha256) VALUES ('0003_x.sql', 'x')",
      'CREATE TABLE buoh_api.intrusa (x int)',
      'CREATE SCHEMA intruso',
      // Sin crear funciones en ningún esquema, buoh_api no puede poner una nextval propia delante
      // de la del trigger de write_order (ADR-0019 §7).
      "CREATE FUNCTION public.nextval(text) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'",
      "CREATE FUNCTION buoh_api.nextval(text) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'",
      `SELECT count(*) FROM ${logLocation(3).schema}.operations_reports`,
    ]) {
      expect(await asApi(text), text).toBe('42501');
    }
    // En cada tabla de la API, también las de las cuentas (migración 0002), buoh_api lee e inserta,
    // salvo en la de migraciones, que solo lee, y nunca modifica, borra ni cambia la tabla; y
    // buoh_lectura, con buoh_salud y buoh_agente, no la lee.
    const { rows: tables } = await ready(admin).query<{ name: string; first_column: string }>(
      `SELECT c.relname AS name, a.attname AS first_column
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = 1
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [API_ROLE],
    );
    expect(tables).toHaveLength(12);
    for (const { name, first_column: column } of tables) {
      const table = `buoh_api.${name}`;
      expect(await asApi(`SELECT count(*) FROM ${table}`), table).toBeNull();
      const { rows: insert } = await ready(admin).query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, 'INSERT') AS allowed",
        [API_ROLE, table],
      );
      expect(insert, table).toEqual([{ allowed: name !== 'buoh_schema_migrations' }]);
      for (const text of [
        `UPDATE ${table} SET ${column} = ${column}`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
        `ALTER TABLE ${table} ADD COLUMN intrusa int`,
        `DROP TABLE ${table}`,
      ]) {
        expect(await asApi(text), text).toBe('42501');
      }
      for (const [user, password] of [
        [POSTGRES_ROLES.health, passwords.health],
        [POSTGRES_ROLES.agent, passwords.agent],
      ] as const) {
        expect(await sqlStateAs(user, password, `SELECT count(*) FROM ${table}`), table).toBe(
          '42501',
        );
      }
    }

    // La ejecución siguiente no cambia nada.
    const second = await operations(env);
    expect(second.step('roles_and_logs')).toMatchObject({
      report: { api_migrated: [], failures: [], passwords_set: [] },
      status: 'completed',
    });
  });

  it('con la contraseña de buoh_api_lectura, el paso 1 crea el rol, miembro de buoh_lectura y de nada más, que lee la salud del log activo y no escribe ni lee buoh_api (ADR-0019 §7 y §8)', async () => {
    const roleOf = async () => {
      const { rows } = await ready(admin).query<{
        can_login: boolean;
        create_role: boolean;
        memberships: string[];
        superuser: boolean;
      }>(
        `SELECT r.rolcanlogin AS can_login, r.rolcreaterole AS create_role, r.rolsuper AS superuser,
                ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                       WHERE m.member = r.oid ORDER BY g.rolname) AS memberships
           FROM pg_roles r WHERE r.rolname = $1`,
        [API_READER_ROLE],
      );
      return rows;
    };
    // Hasta aquí, sin su contraseña, el servicio no creó el rol.
    expect(await roleOf()).toEqual([]);

    const env = {
      ...operationsEnvironment(),
      BUOH_API_LECTURA_POSTGRES_PASSWORD: passwords.reader,
      BUOH_API_POSTGRES_PASSWORD: passwords.api,
    };
    const first = await operations(env);
    expect(first.alerts).toEqual([]);
    expect(first.step('roles_and_logs')).toMatchObject({
      report: { api_migrated: [], failures: [], passwords_set: [API_READER_ROLE] },
      status: 'completed',
    });
    expect(await roleOf()).toEqual([
      {
        can_login: true,
        create_role: false,
        memberships: [POSTGRES_ROLES.reader],
        superuser: false,
      },
    ]);

    // Con las opciones de sesión del pool de lectura de la API: sin esquema por defecto y en solo
    // lectura. Busca el log activo y lee el mismo último informe de la salud que ve el dueño.
    const reader = new pg.Pool({
      database: DATABASE,
      host: local.postgres.host,
      max: 1,
      options: '-c search_path=pg_catalog -c default_transaction_read_only=on',
      password: passwords.reader,
      port: local.postgres.port,
      ssl: false,
      user: API_READER_ROLE,
    });
    try {
      const active = await findActiveLog(reader, { now: clock.now, source: DERIV_SOURCE });
      if (active === null) {
        throw new TypeError('Sin log activo.');
      }
      const { rows: latest } = await ready(admin).query<{
        observed_at_utc: string;
        report_jcs: string;
        status: string;
      }>(
        `SELECT status, observed_at_utc, report_jcs FROM ${active.schema}.operations_reports
          WHERE step = 'health' ORDER BY report_id DESC LIMIT 1`,
      );
      expect(latest).toHaveLength(1);
      const [expected] = latest;
      if (expected === undefined) {
        throw new TypeError('Sin informe de la salud.');
      }
      expect(await readLatestStoredHealth(reader, active)).toEqual(
        parseStoredHealthObservation(expected),
      );
      expect(await readLatestStoredHealth(reader, active)).toMatchObject({ status: 'completed' });
      // La sesión de solo lectura rechaza cualquier escritura antes de mirar los privilegios.
      const readOnly = await reader
        .query(
          `INSERT INTO ${active.schema}.operations_reports
             SELECT * FROM ${active.schema}.operations_reports LIMIT 0`,
        )
        .then(
          () => null,
          (error: unknown) => String((error as { code?: unknown }).code),
        );
      expect(readOnly).toBe('25006');

      // Sin esas opciones, sus privilegios: lee las tablas del log, y nada más.
      const asReader = (text: string) => sqlStateAs(API_READER_ROLE, passwords.reader, text);
      const schema = active.schema;
      expect(await asReader(`SELECT count(*) FROM ${schema}.source_event_index`)).toBeNull();
      expect(await asReader(`SELECT count(*) FROM ${schema}.operations_reports`)).toBeNull();
      for (const text of [
        `INSERT INTO ${schema}.operations_reports SELECT * FROM ${schema}.operations_reports LIMIT 0`,
        `UPDATE ${schema}.ingestion_heartbeats SET source = source`,
        `DELETE FROM ${schema}.operations_reports`,
        `TRUNCATE ${schema}.operations_reports`,
        `CREATE TABLE ${schema}.intrusa (x int)`,
        'CREATE SCHEMA intruso',
        'SELECT count(*) FROM buoh_api.audit_events',
        'SELECT count(*) FROM buoh_api.credentials',
        'SELECT count(*) FROM buoh_api.sessions',
      ]) {
        expect(await asReader(text), text).toBe('42501');
      }
    } finally {
      await reader.end();
    }

    // La ejecución siguiente solo comprueba su contraseña.
    const second = await operations(env);
    expect(second.step('roles_and_logs')).toMatchObject({
      report: { api_migrated: [], failures: [], passwords_set: [] },
      status: 'completed',
    });
  });

  it('con la contraseña de buoh_publicacion: el paso 1 crea buoh_datasets y el rol, el 6 publica el log terminado y el 7 lo verifica en los dos modos (ADR-0020 §8)', async () => {
    const env = {
      ...operationsEnvironment(),
      BUOH_PUBLICACION_POSTGRES_PASSWORD: passwords.publication,
    };
    const first = await operations(env);
    expect(first.step('roles_and_logs')).toMatchObject({
      report: { failures: [], passwords_set: [PUBLICATION_ROLE] },
      status: 'completed',
    });
    // buoh_datasets ya existía, con su migración: no aplica nada.
    expect(first.step('roles_and_logs')?.['report']).toMatchObject({ datasets_migrated: [] });
    expect(first.step('publication')).toMatchObject({ status: 'completed' });
    expect(
      await sqlStateAs(
        PUBLICATION_ROLE,
        passwords.publication,
        `SELECT count(*) FROM ${DATASETS_SCHEMA}.datasets`,
      ),
    ).toBeNull();

    // Una captura sintética de 20 minutos en el log activo, con su esquema de fuente.
    const location = await findActiveLog(ready(admin), { now: clock.now, source: DERIV_SOURCE });
    if (location === null) {
      throw new TypeError('Sin log activo.');
    }
    const target = withLog(
      { ...local, postgres: { ...local.postgres, database: DATABASE } },
      location,
    );
    const objects = S3ObjectStore.fromConfig(target.s3);
    const pool = createPool(target.postgres);
    try {
      await objects.putIfAbsent(
        contentKey(fixture.expected.entries_sha256[SOURCE_SCHEMA_ENTRY]),
        fixture.entries[SOURCE_SCHEMA_ENTRY],
        'application/json',
      );
      const end = Date.parse(clock.now()) - 60_000;
      const profile = createDerivPublicationProfile({
        schemas: syntheticSchemas(),
        symbol: 'R_100',
      });
      await writeLiveLog({
        events: liveEvents(profile, [{ end: 'requested', fromMs: end - 20 * 60_000, toMs: end }]),
        objects,
        source: DERIV_SOURCE,
        store: new PostgresSourceLogStore(pool),
      });
    } finally {
      objects.destroy();
      await pool.end();
    }
    // El servicio prepara el log siguiente; una escritura en él termina el de la captura.
    const prepared = await operations(env);
    const next = (prepared.step('roles_and_logs')?.['report'] as { prepared: number | null })
      .prepared;
    expect(next).toBe(location.number + 1);
    expect(
      await sqlStateAs(
        POSTGRES_ROLES.ingest,
        passwords.ingest,
        `INSERT INTO ${logLocation(location.number + 1).schema}.ingestion_heartbeats
           (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
            backlog_count, backlog_bytes)
         VALUES ('${uuid(9401)}', '${DERIV_SOURCE}', '${uuid(9402)}', '${clock.now()}', 4343,
                 'connecting', 0, 0)`,
      ),
    ).toBeNull();

    const published = await operations(env);
    expect(published.step('publication')).toMatchObject({
      report: { result: { first_segment: 0, log: location.number, status: 'published' } },
      status: 'completed',
    });
    const result = (published.step('publication')?.['report'] as { result: { dataset_id: string } })
      .result;
    expect(published.step('dataset_verification')).toMatchObject({
      report: {
        dataset_id: result.dataset_id,
        results: [
          { mode: 'verify-only', status: 'passed' },
          { mode: 'recompute', status: 'passed' },
        ],
      },
      status: 'completed',
    });
    const { rows } = await ready(admin).query<{ mode: string; status: string }>(
      `SELECT mode, status FROM ${DATASETS_SCHEMA}.dataset_verifications WHERE dataset_id = $1
        ORDER BY verified_at_utc, mode`,
      [result.dataset_id],
    );
    expect(rows.map((row) => [row.mode, row.status]).sort()).toEqual([
      ['recompute', 'passed'],
      ['verify-only', 'passed'],
    ]);
    // Los informes de los dos pasos quedan en el log activo, y ninguno lleva un precio.
    const reports = await reportsOf(logLocation(location.number + 1).schema);
    expect(reports.map((item) => item.step)).toEqual(
      expect.arrayContaining(['publication', 'dataset_verification']),
    );
    expect(JSON.stringify(reports)).not.toContain('1234.56');

    // La ejecución siguiente no tiene nada que publicar ni que verificar.
    const quiet = await operations(env);
    expect(quiet.step('publication')).toMatchObject({
      report: { result: { status: 'nothing_due' } },
    });
    expect(quiet.step('dataset_verification')).toMatchObject({ report: { dataset_id: null } });

    // El informe de un fallo de antes de leer el estado no lleva `state`, y no lo cambia: el estado
    // sigue siendo el del último informe que lo lleva.
    const config = loadOperationsConfig(env);
    const database = openOwnerDatabase(
      { ...config, owner: plain(config.owner) },
      { source: DERIV_SOURCE },
    );
    try {
      const active = logLocation(location.number + 1);
      const before = await database.latestReportWithState(active, 'publication');
      expect(before?.report).toMatchObject({ state: { attempts: null, stopped: [] } });
      await database.appendReport(active, {
        observed_at_utc: clock.now(),
        report: { reason: '57014' },
        report_id: uuid((sequence += 1)),
        run_id: uuid((sequence += 1)),
        status: 'failed',
        step: 'publication',
      });
      expect((await database.latestReportWithState(active, 'publication'))?.report_id).toBe(
        before?.report_id,
      );
    } finally {
      await database.close();
    }
  });
});
