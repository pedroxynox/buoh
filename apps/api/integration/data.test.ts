import { randomBytes } from 'node:crypto';

import {
  canonicalJson,
  dataHealthSchema,
  type HealthReport,
  type JsonValue,
} from '@buoh/contracts';
import { createPool as createWorkerPool, logLocation, migrate } from '@buoh/market-data-worker';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { createRateLimiter } from '../src/accounts/limits.js';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { createDataReader } from '../src/data/reader.js';
import type { ApiLogLine } from '../src/log.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { createReaderPool } from '../src/postgres/pool.js';
import { apiRoutes } from '../src/routes.js';

/**
 * La salud de los datos (ADR-0019 §8) contra el PostgreSQL local, sin TLS: `GET /api/v1/datos/salud`
 * con el pool de lectura de la API (`createReaderPool`) y el código del worker por la ruta `lectura`.
 * El superusuario hace de `buoh-operaciones`: crea los logs con las migraciones del worker, les da
 * a un rol de prueba lo que tiene `buoh_lectura` (el uso de cada esquema de log y `SELECT` en sus
 * tablas) y guarda los informes. Que `buoh-operaciones` crea `buoh_api_lectura` con esos privilegios
 * lo prueba su integración (`apps/market-data-worker/integration/operations.test.ts`). Las sesiones
 * son falsas: aquí se prueba la lectura de los datos.
 *
 * Los roles son de todo el servidor: la prueba borra el suyo y su base al empezar y al terminar. Las
 * contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api_datos';
const READER_USER = 'buoh_integration_api_datos_lectura';
const readerPassword = randomBytes(24).toString('hex');
const ORIGIN = 'https://buoh.test';
const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: '01900000-0000-7000-8000-00000000a001',
  lastActivityMs: 0,
};
/** La hora de la prueba: los logs no vencen. */
const NOW = Date.parse('2026-11-04T13:00:00.000Z');

const REPORT: HealthReport = {
  backlog_bytes: 0,
  backlog_count: 0,
  connection_state: 'connected',
  execution_mode: 'disabled',
  last_event_time_utc: '2026-11-04T12:55:29.000Z',
  last_observation_id: '01900000-0000-7000-8000-000000000001',
  last_published_dataset_id: null,
  last_received_at_utc: '2026-11-04T12:55:29.412Z',
  open_condition_types: [],
  schema_version: '1.0.0',
  service_health: 'healthy',
  source: 'deriv_options',
};

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let reader: Pool | undefined;

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

const readerConfig = (password = readerPassword): PostgresConfig => ({
  ...local,
  database: DATABASE,
  password,
  sslMode: 'disable',
  user: READER_USER,
});

/** Las sesiones falsas: solo vale la cookie `SID`. */
const sessions: SessionService = {
  login: () => Promise.reject(new Error('sin inicio de sesión en esta prueba')),
  authenticate: (secret) => Promise.resolve(secret === SID ? SESSION : null),
  renewActivity: () => Promise.resolve(),
  logout: () => Promise.resolve(0),
  closeOthers: () => Promise.resolve(0),
  listAudit: () => Promise.resolve([]),
  csrfToken: () => '0'.repeat(64),
  validateCsrf: () => false,
  flushPendingFailures: () => Promise.resolve(),
};

/** `GET /api/v1/datos/salud` con sesión y el pool de lectura `pool`: su estado, su cuerpo y el registro. */
async function getHealth(pool: Pool = ready(reader)) {
  const lines: ApiLogLine[] = [];
  let n = 0;
  const app = buildApp({
    log: (line) => lines.push(line),
    now: () => 0,
    requestId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
    origin: ORIGIN,
    routes: apiRoutes({
      readiness: { isReady: () => true },
      links: {
        issueSecret: () => Promise.reject(new Error('sin enlaces en esta prueba')),
        useLink: () => Promise.reject(new Error('sin enlaces en esta prueba')),
      },
      sessions,
      limiter: createRateLimiter(),
      clock: () => NOW,
      data: createDataReader({ pool, clock: () => NOW }),
    }),
    rateLimit: () => 0,
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/datos/salud',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SID}` },
    });
    return { body: response.json<unknown>(), lines, status: response.statusCode };
  } finally {
    await app.close();
  }
}

/** Crea el log `number` con las migraciones del worker y le da al rol de prueba lo de `buoh_lectura`. */
async function createLog(number: number): Promise<string> {
  const { schema } = logLocation(number);
  await ready(admin).query(`CREATE SCHEMA ${schema}`);
  const pool = createWorkerPool({ ...local, database: DATABASE, schema, sslMode: 'disable' });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  await ready(admin).query(`GRANT USAGE ON SCHEMA ${schema} TO ${READER_USER}`);
  await ready(admin).query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${READER_USER}`);
  return schema;
}

let sequence = 0;
/** Guarda un informe en el log, como `buoh-operaciones`, con un `report_id` mayor que los anteriores. */
async function appendReport(
  schema: string,
  row: { step: string; status: 'completed' | 'failed'; observed: string; report: JsonValue },
): Promise<void> {
  sequence += 1;
  const id = `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
  await ready(admin).query(
    `INSERT INTO ${schema}.operations_reports
       (report_id, run_id, step, status, observed_at_utc, report_jcs)
     VALUES ($1, $1, $2, $3, $4, $5)`,
    [id, row.step, row.status, row.observed, canonicalJson(row.report)],
  );
}

/** Un latido de la captura en el log, que cuenta como una escritura (ADR-0018 §6). */
async function heartbeat(schema: string, observed: string): Promise<void> {
  sequence += 1;
  const id = `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
  await ready(admin).query(
    `INSERT INTO ${schema}.ingestion_heartbeats
       (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
        backlog_count, backlog_bytes)
     VALUES ($1, 'deriv_options', $1, $2, 1, 'connected', 0, 0)`,
    [id, observed],
  );
}

async function waitForNoSessions(server: Pool, database: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await server.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM pg_stat_activity
        WHERE datname = $1 AND backend_type = 'client backend'`,
      [database],
    );
    if (rows[0]?.sessions === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`La base ${database} sigue con sesiones.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function dropAll(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await server.query(`DROP ROLE IF EXISTS ${READER_USER}`);
}

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await dropAll(platform);
  await platform.query(
    `CREATE ROLE ${READER_USER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  admin = new pg.Pool({ ...local, database: DATABASE, ssl: false, max: 2 });
  reader = createReaderPool(readerConfig());
});

afterAll(async () => {
  await reader?.end();
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropAll(platform);
    await platform.end();
  }
});

describe('GET /api/v1/datos/salud contra PostgreSQL (ADR-0019 §8)', () => {
  it('sin ningún log, no hay log activo ni observación', async () => {
    expect(await getHealth()).toMatchObject({
      body: { log: null, observation: null },
      status: 200,
    });
  });

  it('del log activo, su último informe de la salud: ninguno, el que terminó y después el que falló', async () => {
    const log1 = await createLog(1);
    expect(await getHealth()).toMatchObject({ body: { log: 1, observation: null }, status: 200 });

    await appendReport(log1, {
      step: 'health',
      status: 'completed',
      observed: '2026-11-04T12:50:31.000Z',
      report: { alerts: [], exit_code: 0, log: 1, report: REPORT },
    });
    const completed = await getHealth();
    expect(completed.status).toBe(200);
    expect(dataHealthSchema.parse(completed.body)).toEqual({
      log: 1,
      observation: {
        status: 'completed',
        observed_at_utc: '2026-11-04T12:50:31.000Z',
        report: REPORT,
      },
    });

    // Uno más nuevo que falló la sustituye; el de otro paso, aunque sea posterior, no cuenta.
    await appendReport(log1, {
      step: 'health',
      status: 'failed',
      observed: '2026-11-04T12:55:31.000Z',
      report: { log: 1, reason: 'child_timeout' },
    });
    await appendReport(log1, {
      step: 'verification',
      status: 'completed',
      observed: '2026-11-04T12:55:40.000Z',
      report: { due: 0, read: 0 },
    });
    expect(await getHealth()).toMatchObject({
      body: {
        log: 1,
        observation: {
          status: 'failed',
          observed_at_utc: '2026-11-04T12:55:31.000Z',
          reason: 'child_timeout',
        },
      },
      status: 200,
    });
  });

  it('cuando otro log pasa a ser el activo, lo dice sin observación, sin tomar la del anterior', async () => {
    const log2 = await createLog(2);
    // El log 1 tiene una escritura, así que sigue activo hasta que el 2 tenga una.
    await heartbeat(logLocation(1).schema, '2026-11-04T12:59:00.000Z');
    expect(await getHealth()).toMatchObject({ body: { log: 1 }, status: 200 });
    await heartbeat(log2, '2026-11-04T12:59:30.000Z');
    expect(await getHealth()).toMatchObject({ body: { log: 2, observation: null }, status: 200 });
  });

  it('un informe guardado sin su forma es internal, con StoredHealthError en el registro y sin su contenido', async () => {
    await appendReport(logLocation(2).schema, {
      step: 'health',
      status: 'completed',
      observed: '2026-11-04T13:00:31.000Z',
      report: { exit_code: 0, log: 2, nota: 'contenido-del-informe' },
    });
    const response = await getHealth();
    expect(response.status).toBe(500);
    expect(response.lines).toContainEqual({
      event: 'api_error',
      request_id: '00000000-0000-4000-8000-000000000000',
      error: 'StoredHealthError',
    });
    expect(JSON.stringify(response)).not.toContain('contenido-del-informe');
  });

  it('con una contraseña que PostgreSQL rechaza, postgres_unavailable con el código y sin el mensaje', async () => {
    const wrong = createReaderPool(readerConfig(randomBytes(24).toString('hex')));
    wrong.on('error', () => undefined);
    try {
      const response = await getHealth(wrong);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: { code: 'postgres_unavailable' } });
      expect(response.lines).toContainEqual({
        event: 'api_error',
        request_id: '00000000-0000-4000-8000-000000000000',
        error: '28P01',
      });
      expect(JSON.stringify(response)).not.toContain(READER_USER);
    } finally {
      await wrong.end();
    }
  });

  it('cada sesión del pool de lectura empieza sin esquema propio y en solo lectura, y rechaza escribir', async () => {
    const pool = ready(reader);
    const { rows } = await pool.query<{ path: string; read_only: string }>(
      "SELECT current_setting('search_path') AS path, current_setting('transaction_read_only') AS read_only",
    );
    expect(rows).toEqual([{ path: 'pg_catalog', read_only: 'on' }]);
    const schema = logLocation(2).schema;
    const code = await pool
      .query(
        `INSERT INTO ${schema}.operations_reports SELECT * FROM ${schema}.operations_reports LIMIT 0`,
      )
      .then(
        () => null,
        (error: unknown) => String((error as { code?: unknown }).code),
      );
    expect(code).toBe('25006');
  });
});
