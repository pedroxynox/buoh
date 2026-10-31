import { randomBytes } from 'node:crypto';

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  createPool,
  healthCommand,
  LOGIN_ROLES,
  loadConfig,
  loadOperationsConfig,
  locateActiveLog,
  logLocation,
  migrate,
  migrateCommand,
  openHealthStores,
  openLogObjects,
  openOwnerDatabase,
  openStores,
  operationsCommand,
  POSTGRES_ROLES,
  S3ObjectStore,
  SourceEventLog,
  withLog,
  type ChildResult,
  type RunChild,
  type WorkerConfig,
} from '../src/index.js';
import { START, uuid } from '../test/support/connection-harness.js';
import { waitForNoSessions } from '../test/support/databases.js';
import { ManualClock, syntheticSchemaArchive } from '../test/support/deriv-fixtures.js';
import { previousConnectionEvents } from '../test/support/recovery-harness.js';

/**
 * `buoh-operaciones` (ADR-0018 §11) contra PostgreSQL y S3-compatible locales, con
 * `operationsCommand` y la base real con la credencial dueña (`openOwnerDatabase`). El superusuario
 * de los servicios locales solo hace de Render: crea el usuario por defecto, que no es superusuario
 * y tiene `CREATEROLE`, y su base, `buoh_integration_ops`. Lo demás lo hace el servicio: los roles,
 * el log 1 y el siguiente, sus migraciones, sus privilegios, las contraseñas, la verificación por
 * partes con los objetos reales bajo el prefijo de cada log, el espacio y los informes.
 *
 * Los procesos de `db:migrate` y de `data:health` corren en el mismo proceso de la prueba, con el
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
const TEST_ROLES = [...LOGIN_ROLES, POSTGRES_ROLES.reader, POSTGRES_ROLES.owner, RENDER_USER];
const LOG_1 = 'buoh_log_000001';
const LOG_2 = 'buoh_log_000002';
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
const secret = () => randomBytes(32).toString('base64');
const passwords = {
  agent: secret(),
  health: secret(),
  ingest: secret(),
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

/** `db:migrate` y `data:health` en este proceso, con el entorno que les da el servicio. */
const inProcess: RunChild = async (child, args, env) => {
  if (child === 'migrate') {
    const { exitCode, line } = await migrateCommand(env, {
      createPool: (postgres) => createPool(plain(postgres)),
      migrate,
    });
    return { exitCode, stderr: '', stdout: `${line}\n`, timedOut: false } satisfies ChildResult;
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
async function sqlStateAs(user: string, password: string, text: string): Promise<string | null> {
  const pool = createPool({
    ...local.postgres,
    database: DATABASE,
    password,
    schema: 'public',
    user,
  });
  try {
    return await pool.query(text).then(
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
  it('la primera ejecución crea los roles y el log 1, con sus seis migraciones como buoh_dueno, sus privilegios y las contraseñas, y guarda en él la salud, la verificación y el espacio', async () => {
    const run = await operations();
    expect(run.alerts).toEqual([]);
    // data:health leyó el log sin ninguna alerta: ni un almacén sin responder ni un rechazo.
    expect(run.forwarded).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.steps.map((line) => [line['step'], line['status']])).toEqual([
      ['roles_and_logs', 'completed'],
      ['health', 'completed'],
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
    expect(migrations.rowCount).toBe(6);

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

  // La última: los eventos que escribe en el log 1, sin su esquema de fuente guardado, cambian la
  // salud de las ejecuciones siguientes.
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
});
