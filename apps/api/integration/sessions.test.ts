import { createHash, randomBytes } from 'node:crypto';

import { auditEventSchema, type AuditEvent, type LinkSecret } from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountCommandError, LoginError, RateLimitedError } from '../src/accounts/errors.js';
import { createAccountService } from '../src/accounts/links.js';
import { createRateLimiter } from '../src/accounts/limits.js';
import { createLoginFailureBuffer } from '../src/accounts/login-failures.js';
import {
  ACTIVITY_MIN_INTERVAL_MS,
  createSessionService,
  SESSION_IDLE_MS,
  SESSION_LIMIT,
  SESSION_MAX_MS,
  type AuthenticatedSession,
} from '../src/accounts/sessions.js';
import { insertAuditEvent } from '../src/audit.js';
import { auditEvent, auditObjects } from '../src/accounts/audit-helpers.js';
import { createPasswordHasher, type Argon2Function } from '../src/auth/password-hash.js';
import { loadCommonPasswords } from '../src/auth/common-passwords.js';
import { hotp, totpStep, TOTP_PERIOD_MS } from '../src/auth/totp.js';
import { createUuidV7Generator } from '../src/ids.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { migrate } from '../src/postgres/migrate.js';
import { createPool, SERVICE_POOL_TIMEOUTS } from '../src/postgres/pool.js';

/**
 * Las sesiones, el inicio de sesión, los límites y la auditoría (ADR-0019 §1, §2, §5 y §13) contra
 * el PostgreSQL local, sin TLS, con un rol que solo tiene los privilegios de `buoh_api`. El reloj y
 * el azar llegan inyectados; Argon2id se sustituye por un resumen determinista rápido (el vector
 * real está en la prueba unitaria), para que los 100 fallos del bloqueo no tarden.
 */
const DATABASE = 'buoh_integration_api_sesiones';
const API_USER = 'buoh_integration_api_sesiones_api';
const apiPassword = randomBytes(24).toString('hex');
const KEYS = {
  passwordPepper: randomBytes(32),
  totpKey: randomBytes(32),
  tokenKey: randomBytes(32),
};
const ORIGIN = 'https://buoh.test';
const START = Date.parse('2026-11-03T12:00:00.000Z');
const PASSWORD = 'una contraseña larga de prueba';
const COMMON = loadCommonPasswords();

/** Argon2id de mentira para la integración: un resumen determinista, para que hash y verify casen. */
const fastArgon2: Argon2Function = (parameters) =>
  Promise.resolve(
    createHash('sha256')
      .update(Buffer.from(parameters.nonce))
      .update(Buffer.from(parameters.secret))
      .update(Buffer.from(parameters.message))
      .digest()
      .subarray(0, parameters.tagLength),
  );

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let apiPool: Pool | undefined;
let reqCounter = 0;

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

function reqId(): string {
  reqCounter += 1;
  return `00000000-0000-4000-8000-${reqCounter.toString(16).padStart(12, '0')}`;
}

/** Una sesión que tiene que estar validada; lanza si `authenticate` devolvió `null`. */
function present(value: AuthenticatedSession | null): AuthenticatedSession {
  if (value === null) {
    throw new TypeError('La sesión no está validada.');
  }
  return value;
}

function testClock(start = START) {
  let now = start;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function codeFor(secret: LinkSecret, nowMs: number): string {
  return hotp(base32Decode(secret.totp.secret), totpStep(nowMs));
}

function tokenOf(url: string): string {
  return url.slice(`${ORIGIN}/enlace/#`.length);
}

/** Un paquete de servicios con su propio reloj, límites y buffer, sobre la misma base. */
function bundle(start = START) {
  const clock = testClock(start);
  const newId = createUuidV7Generator({ now: clock.now, randomBytes });
  const hasher = createPasswordHasher({
    pepper: KEYS.passwordPepper,
    maxWaiting: 8,
    randomBytes,
    argon2: fastArgon2,
  });
  const limiter = createRateLimiter();
  const failures = createLoginFailureBuffer();
  const common = {
    pool: ready(apiPool),
    keys: KEYS,
    hasher,
    clock: clock.now,
    randomBytes,
    newId,
  };
  const accounts = createAccountService({
    ...common,
    environment: 'test' as const,
    origin: ORIGIN,
    commonPasswords: COMMON,
  });
  const sessions = createSessionService({ ...common, limiter, failures });
  return { clock, limiter, failures, accounts, sessions, newId };
}

async function accountIdOf(username: string): Promise<string> {
  const { rows } = await ready(admin).query<{ account_id: string }>(
    'SELECT account_id FROM buoh_api.accounts WHERE username = $1',
    [username],
  );
  return ready(rows[0]).account_id;
}

async function credentialIdOf(accountId: string): Promise<string> {
  const { rows } = await ready(admin).query<{ credential_id: string }>(
    'SELECT credential_id FROM buoh_api.credentials WHERE account_id = $1 ORDER BY write_order DESC LIMIT 1',
    [accountId],
  );
  return ready(rows[0]).credential_id;
}

/** Da de alta una cuenta y devuelve su identificador y su secreto TOTP (para calcular códigos). */
async function enroll(
  b: ReturnType<typeof bundle>,
  username: string,
  password = PASSWORD,
): Promise<{ accountId: string; secret: LinkSecret }> {
  const link = await b.accounts.createLink({ username, purpose: 'enrollment' });
  const token = tokenOf(link.url);
  const secret = await b.accounts.issueSecret({ token });
  await b.accounts.useLink({
    token,
    password,
    code: codeFor(secret, b.clock.now()),
    requestId: reqId(),
  });
  // Pasa a un paso TOTP nuevo: el código del alta no sirve para el primer inicio de sesión.
  b.clock.advance(2 * TOTP_PERIOD_MS);
  return { accountId: await accountIdOf(username), secret };
}

function login(
  b: ReturnType<typeof bundle>,
  username: string,
  secret: LinkSecret,
  password = PASSWORD,
  address = '203.0.113.7',
) {
  return b.sessions.login({
    username,
    password,
    code: codeFor(secret, b.clock.now()),
    address,
    requestId: reqId(),
  });
}

async function auditOf(accountId: string | null): Promise<AuditEvent[]> {
  const { rows } = await ready(admin).query<{ event_jcs: string }>(
    `SELECT event_jcs FROM buoh_api.audit_events
      WHERE account_id IS NOT DISTINCT FROM $1 ORDER BY audit_event_id`,
    [accountId],
  );
  return rows.map((row) => auditEventSchema.parse(JSON.parse(row.event_jcs)));
}

/** El código con que falló un intento: `rate_limited`, o el de `LoginError`. */
function codeOf(error: unknown): string {
  if (error instanceof RateLimitedError) {
    return 'rate_limited';
  }
  if (error instanceof LoginError) {
    return error.code;
  }
  return `otro:${String(error)}`;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('La operación no se rechazó.');
    },
    (error: unknown) => error,
  );
}

async function openSessionCount(accountId: string): Promise<number> {
  const { rows } = await ready(admin).query<{ count: number }>(
    `SELECT count(*)::int AS count FROM buoh_api.sessions s
      WHERE s.account_id = $1
        AND NOT EXISTS (SELECT 1 FROM buoh_api.session_closures c WHERE c.session_id = s.session_id)`,
    [accountId],
  );
  return rows[0]?.count ?? 0;
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
  await admin.query(`GRANT USAGE ON SCHEMA buoh_api TO ${API_USER}`);
  await admin.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA buoh_api TO ${API_USER}`);
  await admin.query(`REVOKE INSERT ON buoh_api.buoh_schema_migrations FROM ${API_USER}`);
  await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA buoh_api TO ${API_USER}`);
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

describe('las duraciones y los topes de las sesiones (ADR-0019 §2)', () => {
  it('son los de la decisión, con valores fijos', () => {
    expect(SESSION_IDLE_MS).toBe(60 * 60_000);
    expect(SESSION_MAX_MS).toBe(24 * 60 * 60_000);
    expect(SESSION_LIMIT).toBe(10);
    expect(ACTIVITY_MIN_INTERVAL_MS).toBe(60_000);
  });
});

describe('inicio de sesión (ADR-0019 §1 y §2)', () => {
  it('entra con la contraseña y el código, crea la sesión y su session_started, y authenticate la valida', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'pedro');
    const { sessionSecret, csrfToken } = await login(b, 'pedro', secret);
    const session = await b.sessions.authenticate(sessionSecret);
    expect(session).toMatchObject({ sessionSecret, accountId });
    expect(b.sessions.validateCsrf(sessionSecret, csrfToken)).toBe(true);
    expect(b.sessions.validateCsrf(sessionSecret, 'f'.repeat(64))).toBe(false);
    const started = (await auditOf(accountId)).filter((e) => e.action === 'session_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ actor: 'account', reason: 'password_and_totp' });
  });

  it('una contraseña o un código que no valen no dejan entrar y dejan un login_failed', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'ana');
    expect(await rejection(login(b, 'ana', secret, 'otra contraseña larga 1'))).toBeInstanceOf(
      LoginError,
    );
    // Un código que no corresponde tampoco deja entrar.
    const bad = await rejection(
      b.sessions.login({
        username: 'ana',
        password: PASSWORD,
        code: '000000',
        address: '203.0.113.7',
        requestId: reqId(),
      }),
    );
    expect(bad).toBeInstanceOf(LoginError);
    const failed = (await auditOf(accountId)).filter((e) => e.action === 'login_failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed[0]).toMatchObject({ actor: 'anonymous', reason: 'invalid_credentials' });
  });

  it('un nombre que no existe recibe el mismo error, sin login_failed, con un login_failures agrupado', async () => {
    const b = bundle();
    const error = await rejection(
      b.sessions.login({
        username: 'fantasma',
        password: PASSWORD,
        code: '123456',
        address: '203.0.113.7',
        requestId: reqId(),
      }),
    );
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).code).toBe('invalid_credentials');
    // El fallo de un nombre que no existe no queda uno a uno: se agrupa al vaciar el buffer.
    await b.sessions.flushPendingFailures();
    const grouped = (await auditOf(null)).filter(
      (e): e is Extract<AuditEvent, { action: 'login_failures' }> => e.action === 'login_failures',
    );
    expect(grouped.some((e) => e.reason === 'unknown_username')).toBe(true);
  });

  it('el código del alta no sirve para el primer inicio de sesión', async () => {
    const b = bundle();
    const link = await b.accounts.createLink({ username: 'leo', purpose: 'enrollment' });
    const token = tokenOf(link.url);
    const secret = await b.accounts.issueSecret({ token });
    const enrollmentCode = codeFor(secret, b.clock.now());
    await b.accounts.useLink({
      token,
      password: PASSWORD,
      code: enrollmentCode,
      requestId: reqId(),
    });
    // Mismo paso TOTP que el alta: el código ya está usado.
    const error = await rejection(
      b.sessions.login({
        username: 'leo',
        password: PASSWORD,
        code: enrollmentCode,
        address: '203.0.113.7',
        requestId: reqId(),
      }),
    );
    expect(error).toBeInstanceOf(LoginError);
  });
});

describe('la duración de la sesión (ADR-0019 §2)', () => {
  it('vence tras 1 hora sin actividad y siempre a las 24 horas', async () => {
    const b = bundle();
    const { secret } = await enroll(b, 'duracion');
    const { sessionSecret } = await login(b, 'duracion', secret);
    expect(await b.sessions.authenticate(sessionSecret)).not.toBeNull();
    b.clock.advance(SESSION_IDLE_MS + 1);
    expect(await b.sessions.authenticate(sessionSecret)).toBeNull();

    const b2 = bundle();
    const enrolled2 = await enroll(b2, 'maxvida');
    const second = await login(b2, 'maxvida', enrolled2.secret);
    // Actividad justo antes de la hora, varias veces, no pasa del tope de 24 horas.
    for (let minute = 50; minute < 24 * 60; minute += 50) {
      b2.clock.set(START + 4 * TOTP_PERIOD_MS + minute * 60_000);
      const active = await b2.sessions.authenticate(second.sessionSecret);
      expect(active, `minuto ${String(minute)}`).not.toBeNull();
      await b2.sessions.renewActivity(present(active));
    }
    b2.clock.set(START + SESSION_MAX_MS + 60_000);
    expect(await b2.sessions.authenticate(second.sessionSecret)).toBeNull();
  });

  it('guarda como mucho una fila de actividad por minuto', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'actividad');
    const { sessionSecret } = await login(b, 'actividad', secret);
    const base = b.clock.now();
    const session = present(await b.sessions.authenticate(sessionSecret));
    b.clock.set(base + ACTIVITY_MIN_INTERVAL_MS - 1);
    await b.sessions.renewActivity(session);
    b.clock.set(base + ACTIVITY_MIN_INTERVAL_MS + 1);
    await b.sessions.renewActivity(session);
    const { rows } = await ready(admin).query<{ count: number }>(
      `SELECT count(*)::int AS count FROM buoh_api.session_activity a
         JOIN buoh_api.sessions s ON s.session_id = a.session_id WHERE s.account_id = $1`,
      [accountId],
    );
    expect(rows[0]?.count).toBe(1);
  });
});

describe('el tope de 10 sesiones (ADR-0019 §2)', () => {
  it('una sesión nueva cierra la más antigua con session_limit', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'tope');
    const ids: string[] = [];
    for (let i = 0; i < SESSION_LIMIT + 1; i += 1) {
      b.clock.advance(TOTP_PERIOD_MS);
      ids.push((await login(b, 'tope', secret)).sessionSecret);
    }
    expect(await openSessionCount(accountId)).toBe(SESSION_LIMIT);
    // La primera quedó cerrada.
    expect(await b.sessions.authenticate(ids[0] ?? '')).toBeNull();
    expect(await b.sessions.authenticate(ids[SESSION_LIMIT] ?? '')).not.toBeNull();
    const limited = (await auditOf(accountId)).filter(
      (e) => e.action === 'session_closed' && e.reason === 'session_limit',
    );
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ actor: 'system' });
  });
});

describe('cierres (ADR-0019 §2 y §3)', () => {
  it('«cerrar sesión» cierra la actual; «cerrar las demás» cierra las otras', async () => {
    const b = bundle();
    const { secret } = await enroll(b, 'cierres');
    const first = await login(b, 'cierres', secret);
    b.clock.advance(TOTP_PERIOD_MS);
    const second = await login(b, 'cierres', secret);
    const firstSession = present(await b.sessions.authenticate(first.sessionSecret));
    expect(await b.sessions.logout({ session: firstSession, requestId: reqId() })).toBe(1);
    expect(await b.sessions.authenticate(first.sessionSecret)).toBeNull();
    expect(await b.sessions.authenticate(second.sessionSecret)).not.toBeNull();

    b.clock.advance(TOTP_PERIOD_MS);
    const third = await login(b, 'cierres', secret);
    const secondSession = present(await b.sessions.authenticate(second.sessionSecret));
    expect(await b.sessions.closeOthers({ session: secondSession, requestId: reqId() })).toBe(1);
    expect(await b.sessions.authenticate(second.sessionSecret)).not.toBeNull();
    expect(await b.sessions.authenticate(third.sessionSecret)).toBeNull();
  });

  it('cuenta cerrar-sesiones cierra todas, con operator_command sin petición', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'operador');
    await login(b, 'operador', secret);
    b.clock.advance(TOTP_PERIOD_MS);
    const keep = await login(b, 'operador', secret);
    expect(await b.accounts.closeSessions({ username: 'operador' })).toBe(2);
    expect(await openSessionCount(accountId)).toBe(0);
    expect(await b.sessions.authenticate(keep.sessionSecret)).toBeNull();
    const closed = (await auditOf(accountId)).filter((e) => e.action === 'sessions_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      actor: 'operator',
      reason: 'operator_command',
      request_id: null,
    });
    // Una cuenta que no existe falla.
    expect(await rejection(b.accounts.closeSessions({ username: 'nadie' }))).toBeInstanceOf(
      AccountCommandError,
    );
  });

  it('un restablecimiento cierra todas las sesiones, con credential_reset', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'reinicio');
    const open = await login(b, 'reinicio', secret);
    b.clock.advance(TOTP_PERIOD_MS);
    const resetLink = await b.accounts.createLink({ username: 'reinicio', purpose: 'reset' });
    const token = tokenOf(resetLink.url);
    const resetSecret = await b.accounts.issueSecret({ token });
    await b.accounts.useLink({
      token,
      password: 'contraseña nueva muy larga',
      code: codeFor(resetSecret, b.clock.now()),
      requestId: reqId(),
    });
    expect(await openSessionCount(accountId)).toBe(0);
    expect(await b.sessions.authenticate(open.sessionSecret)).toBeNull();
    const closed = (await auditOf(accountId)).filter(
      (e) => e.action === 'sessions_closed' && e.reason === 'credential_reset',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ actor: 'system' });
  });
});

describe('límites por credencial (ADR-0019 §1)', () => {
  it('100 fallos seguidos deshabilitan la credencial; acertar los dos factores da credential_disabled; restablecer la recupera', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'bloqueo');
    const credentialId = await credentialIdOf(accountId);
    const account = { kind: 'account' as const, id: accountId };
    const credential = { kind: 'credential' as const, id: credentialId };
    // 99 fallos posteriores al alta de la credencial, pero más de un minuto antes de ahora (para no
    // toparse con el límite por nombre). El reloj avanza para que quepan entre medias.
    b.clock.set(START + 20 * 60_000);
    const base = START + 5 * 60_000;
    for (let i = 0; i < 99; i += 1) {
      await insertAuditEvent(
        ready(admin),
        auditEvent(
          b.newId,
          {
            account_id: accountId,
            actor: 'anonymous',
            action: 'login_failed',
            reason: 'invalid_credentials',
            objects: auditObjects(account, credential),
            request_id: reqId(),
          },
          new Date(base + i).toISOString(),
        ),
      );
    }
    // El fallo número 100, desde una dirección nueva: deshabilita la credencial.
    expect(
      await rejection(login(b, 'bloqueo', secret, 'otra larga 1', '198.51.100.1')),
    ).toBeInstanceOf(LoginError);
    const disabled = (await auditOf(accountId)).filter((e) => e.action === 'credential_disabled');
    expect(disabled).toHaveLength(1);
    // Con los dos factores correctos, quien los tiene sabe que está deshabilitada. Más de un minuto
    // después del último fallo, para no toparse con el límite por nombre.
    b.clock.set(START + 22 * 60_000);
    const twoFactor = await rejection(login(b, 'bloqueo', secret, PASSWORD, '198.51.100.2'));
    expect((twoFactor as LoginError).code).toBe('credential_disabled');
    // Restablecer pone una credencial nueva, que deja entrar, y el recuento parte de cero.
    b.clock.advance(TOTP_PERIOD_MS);
    const resetLink = await b.accounts.createLink({ username: 'bloqueo', purpose: 'reset' });
    const resetSecret = await b.accounts.issueSecret({ token: tokenOf(resetLink.url) });
    await b.accounts.useLink({
      token: tokenOf(resetLink.url),
      password: 'contraseña nueva muy larga',
      code: codeFor(resetSecret, b.clock.now()),
      requestId: reqId(),
    });
    b.clock.advance(TOTP_PERIOD_MS);
    const ok = await b.sessions.login({
      username: 'bloqueo',
      password: 'contraseña nueva muy larga',
      code: codeFor(resetSecret, b.clock.now()),
      address: '198.51.100.3',
      requestId: reqId(),
    });
    expect(await b.sessions.authenticate(ok.sessionSecret)).not.toBeNull();
  });

  it('un paso TOTP falso con el máximo de bigint no deja la credencial sin aceptar códigos (revisión del PR 4b)', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'pasofalso');
    const credentialId = await credentialIdOf(accountId);
    // Con la contraseña de buoh_api, un paso con el máximo de bigint.
    await ready(apiPool).query(
      `INSERT INTO buoh_api.totp_steps_used (credential_id, totp_step, used_at_utc)
       VALUES ($1, 9223372036854775807, $2)`,
      [credentialId, new Date(b.clock.now()).toISOString()],
    );
    b.clock.advance(TOTP_PERIOD_MS);
    const ok = await login(b, 'pasofalso', secret, PASSWORD, '198.51.100.9');
    expect(await b.sessions.authenticate(ok.sessionSecret)).not.toBeNull();
  });
});

describe('integridad de las sesiones (ADR-0019 §2 y §13)', () => {
  it('una sesión insertada con buoh_api y el SHA-256 sin clave de un identificador no vale', async () => {
    const b = bundle();
    const { accountId, secret } = await enroll(b, 'falsa');
    const forgedId = randomBytes(32).toString('base64url');
    const sha256 = createHash('sha256').update(Buffer.from(forgedId, 'base64url')).digest();
    await ready(apiPool).query(
      `INSERT INTO buoh_api.sessions (session_id, account_id, token_hmac, created_at_utc, expires_at_utc)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        b.newId(),
        accountId,
        sha256,
        new Date(b.clock.now()).toISOString(),
        new Date(b.clock.now() + SESSION_MAX_MS).toISOString(),
      ],
    );
    expect(await b.sessions.authenticate(forgedId)).toBeNull();
    // La sesión real de la cuenta sí vale.
    const real = await login(b, 'falsa', secret, PASSWORD, '198.51.100.20');
    expect(await b.sessions.authenticate(real.sessionSecret)).not.toBeNull();
  });

  it('cada columna write_order del esquema tiene el trigger que la asigna', async () => {
    const { rows: columns } = await ready(admin).query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'buoh_api' AND column_name = 'write_order' ORDER BY table_name`,
    );
    const names = columns.map((row) => row.table_name);
    expect(names).toEqual([
      'account_links',
      'account_preferences',
      'credentials',
      'link_totp_secrets',
      'sessions',
    ]);
    for (const table of names) {
      const { rows } = await ready(admin).query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE n.nspname = 'buoh_api' AND c.relname = $1
              AND p.proname = 'buoh_assign_write_order' AND NOT t.tgisinternal
         ) AS present`,
        [table],
      );
      expect(rows[0]?.present, table).toBe(true);
    }
  });
});

describe('aislamiento entre cuentas (ADR-0019 §4 y §5)', () => {
  it('cada cuenta solo ve su auditoría, y nadie ve las entradas sin cuenta', async () => {
    const b = bundle();
    const ana = await enroll(b, 'aislana');
    b.clock.advance(TOTP_PERIOD_MS);
    const beto = await enroll(b, 'aislbeto');
    const anaLogin = await login(b, 'aislana', ana.secret, PASSWORD, '198.51.100.30');
    b.clock.advance(TOTP_PERIOD_MS);
    const betoLogin = await login(b, 'aislbeto', beto.secret, PASSWORD, '198.51.100.31');
    // Un fallo de un nombre que no existe deja una entrada sin cuenta.
    await rejection(
      b.sessions.login({
        username: 'nadieaqui',
        password: PASSWORD,
        code: '123456',
        address: '198.51.100.32',
        requestId: reqId(),
      }),
    );
    await b.sessions.flushPendingFailures();

    const anaSession = present(await b.sessions.authenticate(anaLogin.sessionSecret));
    const betoSession = present(await b.sessions.authenticate(betoLogin.sessionSecret));
    const anaEvents = await b.sessions.listAudit(anaSession);
    const betoEvents = await b.sessions.listAudit(betoSession);
    expect(anaEvents.every((e) => e.account_id === ana.accountId)).toBe(true);
    expect(betoEvents.every((e) => e.account_id === beto.accountId)).toBe(true);
    expect(anaEvents.some((e) => e.account_id === beto.accountId)).toBe(false);
    // Ninguna ve la entrada agrupada sin cuenta.
    expect([...anaEvents, ...betoEvents].some((e) => e.account_id === null)).toBe(false);
  });
});

describe('un nombre que existe y uno que no (ADR-0019 §1 y §13)', () => {
  it('reciben la misma respuesta en cada intento, también en el sexto y el vigesimoprimero', async () => {
    const b = bundle();
    await enroll(b, 'siexiste');
    // Una secuencia rápida (sin avanzar el reloj) desde una dirección por nombre: los cinco
    // primeros fallan, y del sexto en adelante los frena la espera por nombre y dirección, igual
    // para la cuenta que existe (su contraseña es mala) y para el nombre que no existe.
    const attempt = (username: string, address: string) =>
      rejection(
        b.sessions.login({
          username,
          password: 'otra contraseña mala larga 1',
          code: '000000',
          address,
          requestId: reqId(),
        }),
      );
    const exists: string[] = [];
    const unknown: string[] = [];
    for (let i = 1; i <= 21; i += 1) {
      exists.push(codeOf(await attempt('siexiste', '198.51.100.70')));
      unknown.push(codeOf(await attempt('nnoexiste', '198.51.100.71')));
    }
    expect(exists).toEqual(unknown);
    expect(exists.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => 'invalid_credentials'));
    expect(exists[5]).toBe('rate_limited');
    expect(exists[20]).toBe('rate_limited');
  });
});

describe('dos inicios de sesión a la vez con el mismo código (ADR-0019 §13)', () => {
  it('solo deja entrar a uno', async () => {
    const b = bundle();
    const { secret } = await enroll(b, 'carrera');
    const code = codeFor(secret, b.clock.now());
    const attempt = () =>
      b.sessions.login({
        username: 'carrera',
        password: PASSWORD,
        code,
        address: '198.51.100.40',
        requestId: reqId(),
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [onlyRejected] = rejected;
    expect(onlyRejected?.status).toBe('rejected');
    if (onlyRejected?.status === 'rejected') {
      expect(onlyRejected.reason).toBeInstanceOf(LoginError);
    }
  });
});
