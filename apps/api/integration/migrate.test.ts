import { randomBytes } from 'node:crypto';

import { auditEventSchema, canonicalJson } from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateCommand } from '../src/migrate-command.js';
import { API_SCHEMA, loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { migrate } from '../src/postgres/migrate.js';
import { createPool } from '../src/postgres/pool.js';

/**
 * `db:migrate` de la API (ADR-0019 §7 y §13) contra el PostgreSQL local, sin TLS. El superusuario
 * solo hace de Render: crea el usuario por defecto, sin superusuario y con `CREATEROLE`, y su base,
 * `buoh_integration_api`. Ese usuario crea `buoh_dueno` y su pertenencia, como `buoh-operaciones`
 * (ADR-0018 §8), y migra el esquema `buoh_api` como `buoh_dueno`. Los privilegios del rol
 * `buoh_api` los prueba la integración de `buoh-operaciones`, que los da.
 *
 * Los roles son de todo el servidor: la prueba borra los suyos y su base al empezar y al terminar.
 * Las contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api';
const RENDER_USER = 'buoh_integration_api_render';
const OUTSIDER = 'buoh_integration_api_ajeno';
const OWNER = 'buoh_dueno';
const TEST_ROLES = [OWNER, RENDER_USER, OUTSIDER];
const secret = () => randomBytes(32).toString('base64');
const passwords = { outsider: secret(), render: secret() };

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** Las variables de `db:migrate` con ese usuario sobre la base de la prueba, sin TLS. */
function migrateEnvironment(user: string, password: string): Record<string, string> {
  return {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
    BUOH_POSTGRES_DB: DATABASE,
    BUOH_POSTGRES_HOST: local.host,
    BUOH_POSTGRES_OWNER_ROLE: OWNER,
    BUOH_POSTGRES_PASSWORD: password,
    BUOH_POSTGRES_PORT: String(local.port),
    BUOH_POSTGRES_SSLMODE: 'disable',
    BUOH_POSTGRES_USER: user,
  };
}

async function runMigrate(user = RENDER_USER, password = passwords.render) {
  const result = await migrateCommand(migrateEnvironment(user, password), { createPool, migrate });
  return {
    exitCode: result.exitCode,
    line: result.line,
    parsed: JSON.parse(result.line) as unknown,
  };
}

/** Espera a que la base no tenga sesiones de clientes, para borrarla sin cortar ninguna. */
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

async function dropDatabaseAndRoles(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  for (const role of TEST_ROLES) {
    await server.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

/** El código SQLSTATE con que falla `text`, o `null` si no falla. */
async function sqlState(pool: Pool, text: string, values: unknown[] = []): Promise<string | null> {
  return pool.query(text, values).then(
    () => null,
    (error: unknown) => String((error as { code?: unknown }).code),
  );
}

/** Una entrada válida, en JCS, con sus columnas. */
function auditRow(n: number) {
  const id = `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
  const event = auditEventSchema.parse({
    account_id: '01900000-0000-7000-8000-00000000a001',
    action: 'session_started',
    actor: 'account',
    audit_event_id: id,
    objects: [{ id: '01900000-0000-7000-8000-00000000b001', kind: 'session' }],
    occurred_at_utc: '2026-11-03T10:00:00.000Z',
    reason: 'password_and_totp',
    request_id: '00000000-0000-4000-8000-000000000001',
    schema_version: '1.0.0',
  });
  return [
    event.audit_event_id,
    event.account_id,
    event.occurred_at_utc,
    event.action,
    canonicalJson(event),
  ];
}

const INSERT_AUDIT = `INSERT INTO buoh_api.audit_events
  (audit_event_id, account_id, occurred_at_utc, action, event_jcs) VALUES ($1, $2, $3, $4, $5)`;

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await dropDatabaseAndRoles(platform);
  await platform.query(
    `CREATE ROLE ${RENDER_USER} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.render)}`,
  );
  await platform.query(
    `CREATE ROLE ${OUTSIDER} LOGIN PASSWORD ${pg.escapeLiteral(passwords.outsider)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE} OWNER ${RENDER_USER}`);
  // Lo que hace `ensureRuntimeRoles` con `buoh_dueno`, con el usuario de Render.
  const render = new pg.Client({
    ...local,
    database: DATABASE,
    password: passwords.render,
    ssl: false,
    user: RENDER_USER,
  });
  await render.connect();
  try {
    await render.query(`CREATE ROLE ${OWNER} NOLOGIN CREATEROLE`);
    await render.query(`GRANT ${OWNER} TO CURRENT_USER WITH SET TRUE`);
    await render.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ${OWNER}`);
  } finally {
    await render.end();
  }
  admin = new pg.Pool({ ...local, database: DATABASE, ssl: false, max: 2 });
});

afterAll(async () => {
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropDatabaseAndRoles(platform);
    await platform.end();
  }
});

describe('db:migrate de la API (ADR-0019 §7)', () => {
  it('migra el esquema buoh_api como buoh_dueno; dos a la vez se esperan, y una aplica 0001', async () => {
    const [first, second] = await Promise.all([runMigrate(), runMigrate()]);
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    const applied = [first.parsed, second.parsed]
      .map((line) => (line as { applied: string[] }).applied)
      .sort((a, b) => a.length - b.length);
    expect(applied).toEqual([[], ['0001_auditoria.sql']]);
    expect(first.parsed).toMatchObject({ current: ['0001_auditoria.sql'], status: 'migrated' });

    const { rows: schema } = await ready(admin).query<{ owner: string }>(
      'SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = $1',
      [API_SCHEMA],
    );
    expect(schema).toEqual([{ owner: OWNER }]);
    const { rows: tables } = await ready(admin).query<{ owner: string; table: string }>(
      `SELECT tablename AS table, tableowner AS owner FROM pg_tables
        WHERE schemaname = $1 ORDER BY tablename`,
      [API_SCHEMA],
    );
    expect(tables).toEqual([
      { owner: OWNER, table: 'audit_events' },
      { owner: OWNER, table: 'buoh_schema_migrations' },
    ]);
    const { rows: functions } = await ready(admin).query<{ owner: string }>(
      `SELECT p.proowner::regrole::text AS owner FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'buoh_reject_mutation'`,
      [API_SCHEMA],
    );
    expect(functions).toEqual([{ owner: OWNER }]);

    const again = await runMigrate();
    expect(again.exitCode).toBe(0);
    expect(again.parsed).toMatchObject({ applied: [], status: 'migrated' });
  });

  it('sus errores salen saneados: una contraseña mala da 28P01 y un usuario que no es de buoh_dueno, 42501', async () => {
    const wrong = await runMigrate(RENDER_USER, secret());
    expect(wrong.exitCode).toBe(1);
    expect(wrong.parsed).toEqual({ code: 'MIGRATION_FAILED', reason: '28P01', status: 'failed' });
    const outsider = await runMigrate(OUTSIDER, passwords.outsider);
    expect(outsider.exitCode).toBe(1);
    expect(outsider.parsed).toEqual({
      code: 'MIGRATION_FAILED',
      reason: '42501',
      status: 'failed',
    });
    for (const line of [wrong.line, outsider.line]) {
      for (const value of [
        passwords.render,
        passwords.outsider,
        RENDER_USER,
        OUTSIDER,
        OWNER,
        DATABASE,
        local.host,
        'permission denied',
        'authentication failed',
      ]) {
        expect(line).not.toContain(value);
      }
    }
  });

  it('audit_events es append-only, también para su dueño: UPDATE, DELETE y TRUNCATE dan 23001', async () => {
    await ready(admin).query(INSERT_AUDIT, auditRow(1));
    for (const text of [
      "UPDATE buoh_api.audit_events SET action = 'session_closed'",
      'DELETE FROM buoh_api.audit_events',
      'TRUNCATE buoh_api.audit_events',
    ]) {
      expect(await sqlState(ready(admin), text), text).toBe('23001');
    }
    const { rows } = await ready(admin).query<{ n: number }>(
      'SELECT count(*)::int AS n FROM buoh_api.audit_events',
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('cada columna es igual a su campo del documento, que es un objeto JSON', async () => {
    const [id, account, at, action, jcs] = auditRow(2);
    const insert = (values: unknown[]) => sqlState(ready(admin), INSERT_AUDIT, values);
    expect(await insert([id, '01900000-0000-7000-8000-00000000a002', at, action, jcs])).toBe(
      '23514',
    );
    expect(await insert([id, null, at, action, jcs])).toBe('23514');
    expect(await insert([id, account, '2026-11-03T10:00:00.001Z', action, jcs])).toBe('23514');
    expect(await insert([id, account, at, 'session_closed', jcs])).toBe('23514');
    expect(await insert(['01900000-0000-7000-8000-0000000000ff', account, at, action, jcs])).toBe(
      '23514',
    );
    expect(await insert([id, account, at, action, '[]'])).toBe('23514');
    expect(await insert([id, account, at, action, '{no es json'])).toBe('22P02');
    expect(await insert([id, account, '2026-11-03 10:00:00', action, jcs])).toBe('23514');
    // Un documento al que le faltan los campos no cumple sus comprobaciones, tampoco sin cuenta.
    const event = JSON.parse(String(jcs)) as Record<string, unknown>;
    const without = (field: string) =>
      JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => key !== field)));
    for (const document of ['[]', '{}']) {
      expect(await insert([id, null, at, action, document]), document).toBe('23514');
    }
    for (const field of ['audit_event_id', 'account_id', 'occurred_at_utc', 'action']) {
      expect(await insert([id, account, at, action, without(field)]), field).toBe('23514');
    }
    // Sin el campo, tampoco vale con la columna vacía: account_id siempre está en el documento.
    expect(await insert([id, null, at, action, without('account_id')])).toBe('23514');
    expect(await insert([id, account, at, action, jcs])).toBeNull();
  });

  it('require y verify-full contra un servidor sin TLS fallan en lugar de conectar sin cifrar', async () => {
    for (const sslMode of ['require', 'verify-full'] as const) {
      const pool = createPool({ ...local, database: DATABASE, sslMode });
      try {
        await expect(pool.query('SELECT 1'), sslMode).rejects.toThrow(/does not support SSL/u);
      } finally {
        await pool.end();
      }
    }
    const plain = createPool({ ...local, database: DATABASE, sslMode: 'disable' });
    try {
      const { rows } = await plain.query<{ one: number }>('SELECT 1 AS one');
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await plain.end();
    }
  });
});
