import { randomBytes } from 'node:crypto';

import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPreferenceService, StoredPreferenceError } from '../src/accounts/preferences.js';
import type { AuthenticatedSession } from '../src/accounts/sessions.js';
import { createUuidV7Generator } from '../src/ids.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { migrate } from '../src/postgres/migrate.js';
import { createPool, SERVICE_POOL_TIMEOUTS } from '../src/postgres/pool.js';

/**
 * Las preferencias de cada cuenta (ADR-0019 §4 y §7; F2-UI-001) contra el PostgreSQL local, sin
 * TLS, con un rol que solo tiene los privilegios de `buoh_api`: la migración `0004`, el tema de
 * cada cuenta, que una cuenta no lee ni cambia el de otra (F2-AUTH-001) y que la tabla es
 * append-only. El reloj llega inyectado. Las contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api_preferencias';
const API_USER = 'buoh_integration_api_preferencias_api';
const apiPassword = randomBytes(24).toString('hex');
const START = Date.parse('2026-11-13T12:00:00.000Z');
const ACCOUNT_A = '01900000-0000-7000-8000-00000000a001';
const ACCOUNT_B = '01900000-0000-7000-8000-00000000a002';

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let apiPool: Pool | undefined;

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** Una sesión de la cuenta: el servicio solo mira su cuenta. */
const sessionOf = (accountId: string): AuthenticatedSession => ({
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  accountId,
  lastActivityMs: 0,
});

function service() {
  let now = START;
  const clock = () => now;
  return {
    preferences: createPreferenceService({
      pool: ready(apiPool),
      clock,
      newId: createUuidV7Generator({ now: clock, randomBytes }),
    }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function rowsOf(accountId: string) {
  const { rows } = await ready(admin).query<{ theme: string; set_at_utc: string }>(
    `SELECT theme, set_at_utc FROM buoh_api.account_preferences
      WHERE account_id = $1 ORDER BY write_order`,
    [accountId],
  );
  return rows;
}

/** El código de error de PostgreSQL de una consulta que tiene que fallar. */
async function failureCode(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  throw new Error('La consulta no falló.');
}

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await platform.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await platform.query(`DROP ROLE IF EXISTS ${API_USER}`);
  await platform.query(`CREATE ROLE ${API_USER} LOGIN PASSWORD ${pg.escapeLiteral(apiPassword)}`);
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  admin = new pg.Pool({ ...local, database: DATABASE, ssl: false, max: 2 });
  await migrate(admin);
  // Los privilegios de buoh_api (grantApiPrivileges): uso del esquema y de sus secuencias, y
  // SELECT e INSERT en sus tablas, salvo las migraciones, que solo lee.
  await admin.query(`GRANT USAGE ON SCHEMA buoh_api TO ${API_USER}`);
  await admin.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA buoh_api TO ${API_USER}`);
  await admin.query(`REVOKE INSERT ON buoh_api.buoh_schema_migrations FROM ${API_USER}`);
  await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA buoh_api TO ${API_USER}`);
  for (const [accountId, username] of [
    [ACCOUNT_A, 'cuenta-a'],
    [ACCOUNT_B, 'cuenta-b'],
  ] as const) {
    await admin.query(
      `INSERT INTO buoh_api.accounts (account_id, username, created_at_utc)
       VALUES ($1, $2, '2026-11-13T11:00:00.000Z')`,
      [accountId, username],
    );
  }
  apiPool = createPool(
    { ...local, database: DATABASE, password: apiPassword, sslMode: 'disable', user: API_USER },
    SERVICE_POOL_TIMEOUTS,
  );
});

afterAll(async () => {
  await apiPool?.end();
  await admin?.end();
  if (platform !== undefined) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await platform.query<{ sessions: number }>(
        `SELECT count(*)::int AS sessions FROM pg_stat_activity
          WHERE datname = $1 AND backend_type = 'client backend'`,
        [DATABASE],
      );
      if ((rows[0]?.sessions ?? 0) === 0 || Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await platform.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await platform.query(`DROP ROLE IF EXISTS ${API_USER}`);
    await platform.end();
  }
});

describe('Las preferencias de cada cuenta contra PostgreSQL (ADR-0019 §7)', () => {
  it('sin ninguna guardada, el tema es noche', async () => {
    const { preferences } = service();
    expect(await preferences.get(sessionOf(ACCOUNT_A))).toEqual({ theme: 'night' });
    expect(await rowsOf(ACCOUNT_A)).toEqual([]);
  });

  it('guarda el tema de la cuenta, vale el último, y repetir el que vale no escribe nada', async () => {
    const { preferences, advance } = service();
    expect(await preferences.set(sessionOf(ACCOUNT_A), 'day')).toEqual({ theme: 'day' });
    expect(await preferences.get(sessionOf(ACCOUNT_A))).toEqual({ theme: 'day' });
    advance(60_000);
    expect(await preferences.set(sessionOf(ACCOUNT_A), 'day')).toEqual({ theme: 'day' });
    advance(60_000);
    await preferences.set(sessionOf(ACCOUNT_A), 'night');
    expect(await preferences.get(sessionOf(ACCOUNT_A))).toEqual({ theme: 'night' });
    expect(await rowsOf(ACCOUNT_A)).toEqual([
      { theme: 'day', set_at_utc: '2026-11-13T12:00:00.000Z' },
      { theme: 'night', set_at_utc: '2026-11-13T12:02:00.000Z' },
    ]);
    // Elegir noche sin ninguna guardada tampoco escribe: ya es el que vale.
    await preferences.set(sessionOf(ACCOUNT_B), 'night');
    expect(await rowsOf(ACCOUNT_B)).toEqual([]);
  });

  it('una cuenta no lee ni cambia el tema de otra (F2-AUTH-001)', async () => {
    const { preferences } = service();
    await preferences.set(sessionOf(ACCOUNT_A), 'day');
    expect(await preferences.get(sessionOf(ACCOUNT_B))).toEqual({ theme: 'night' });
    await preferences.set(sessionOf(ACCOUNT_B), 'day');
    await preferences.set(sessionOf(ACCOUNT_B), 'night');
    expect(await preferences.get(sessionOf(ACCOUNT_A))).toEqual({ theme: 'day' });
  });

  it('la tabla es append-only: buoh_api no cambia ni borra filas, y el dueño tampoco', async () => {
    const api = ready(apiPool);
    expect(
      await failureCode(api.query("UPDATE buoh_api.account_preferences SET theme = 'night'")),
    ).toBe('42501');
    expect(await failureCode(api.query('DELETE FROM buoh_api.account_preferences'))).toBe('42501');
    const owner = ready(admin);
    for (const statement of [
      "UPDATE buoh_api.account_preferences SET theme = 'night'",
      'DELETE FROM buoh_api.account_preferences',
      'TRUNCATE buoh_api.account_preferences',
    ]) {
      expect(await failureCode(owner.query(statement)), statement).toBe('23001');
    }
  });

  it('la base rechaza un tema que no existe, una hora sin su formato y una cuenta que no existe', async () => {
    const insert = (theme: string, at: string, account = ACCOUNT_A) =>
      ready(apiPool).query(
        `INSERT INTO buoh_api.account_preferences (preference_id, account_id, theme, set_at_utc)
         VALUES ($1, $2, $3, $4)`,
        ['01900000-0000-7000-8000-0000000c0001', account, theme, at],
      );
    expect(await failureCode(insert('dia', '2026-11-13T13:00:00.000Z'))).toBe('23514');
    expect(await failureCode(insert('day', '2026-11-13 13:00'))).toBe('23514');
    expect(
      await failureCode(
        insert('day', '2026-11-13T13:00:00.000Z', '01900000-0000-7000-8000-00000000a099'),
      ),
    ).toBe('23503');
  });

  it('write_order lo asigna la base, aunque el INSERT traiga otro', async () => {
    const { preferences } = service();
    await ready(apiPool).query(
      `INSERT INTO buoh_api.account_preferences
         (preference_id, write_order, account_id, theme, set_at_utc)
       OVERRIDING SYSTEM VALUE
       VALUES ('01900000-0000-7000-8000-0000000c0002', 9223372036854775807, $1, 'day',
               '2026-11-13T13:00:00.000Z')`,
      [ACCOUNT_B],
    );
    const { rows } = await ready(admin).query<{ write_order: string }>(
      `SELECT write_order::text FROM buoh_api.account_preferences
        WHERE preference_id = '01900000-0000-7000-8000-0000000c0002'`,
    );
    expect(rows[0]?.write_order).not.toBe('9223372036854775807');
    // Una fila posterior sigue valiendo.
    await preferences.set(sessionOf(ACCOUNT_B), 'night');
    expect(await preferences.get(sessionOf(ACCOUNT_B))).toEqual({ theme: 'night' });
  });

  it('un tema guardado que la API no conoce es StoredPreferenceError', async () => {
    const owner = ready(admin);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // Como si una migración futura ampliara el CHECK sin que esta API lo sepa.
      await client.query(
        'ALTER TABLE buoh_api.account_preferences DROP CONSTRAINT account_preferences_theme_check',
      );
      await client.query(
        `INSERT INTO buoh_api.account_preferences (preference_id, account_id, theme, set_at_utc)
         VALUES ('01900000-0000-7000-8000-0000000c0003', $1, 'sepia', '2026-11-13T14:00:00.000Z')`,
        [ACCOUNT_A],
      );
      const preferences = createPreferenceService({
        pool: client,
        clock: () => START,
        newId: () => '01900000-0000-7000-8000-0000000c0004',
      });
      await expect(preferences.get(sessionOf(ACCOUNT_A))).rejects.toBeInstanceOf(
        StoredPreferenceError,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
