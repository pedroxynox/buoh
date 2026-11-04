import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  auditEventSchema,
  linkSecretSchema,
  type AuditEvent,
  type LinkSecret,
} from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountCommandError, LinkError, PasswordRejectedError } from '../src/accounts/errors.js';
import { createAccountService, LINK_LIFETIME_MS } from '../src/accounts/links.js';
import { buildApp } from '../src/app.js';
import { loadCommonPasswords } from '../src/auth/common-passwords.js';
import { createPasswordHasher, type PasswordHasher } from '../src/auth/password-hash.js';
import { linkTokenDigest } from '../src/auth/tokens.js';
import { hotp, totpStep } from '../src/auth/totp.js';
import { createUuidV7Generator } from '../src/ids.js';
import type { ApiLogLine } from '../src/log.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { migrate } from '../src/postgres/migrate.js';
import { createPool, SERVICE_POOL_TIMEOUTS } from '../src/postgres/pool.js';
import { migrationState } from '../src/postgres/readiness.js';
import { createRateLimiter } from '../src/accounts/limits.js';
import type { SessionService } from '../src/accounts/sessions.js';
import { apiRoutes } from '../src/routes.js';

/**
 * Las cuentas, los enlaces y las credenciales de la API (ADR-0019 §1, §3, §5, §7 y §13) contra el
 * PostgreSQL local, sin TLS. El superusuario migra cada base, como haría `buoh_dueno`, y da a un
 * rol de prueba los privilegios de `buoh_api`: uso del esquema y de sus secuencias, y `SELECT` e
 * `INSERT` en sus tablas (como `grantApiPrivileges`, cuya prueba está en la integración de
 * `buoh-operaciones`). El servicio corre con ese rol, así que nunca necesita modificar ni borrar.
 *
 * Los roles son de todo el servidor: la prueba borra los suyos y sus bases al empezar y al
 * terminar. Las contraseñas y las claves son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api_cuentas';
const PRODUCTION_DATABASE = 'buoh_integration_api_cuentas_prod';
const EMPTY_DATABASE = 'buoh_integration_api_cuentas_vacia';
/** Una base de production para las altas a la vez, sin ninguna cuenta dada de alta. */
const RACE_DATABASE = 'buoh_integration_api_cuentas_prod_carrera';
const API_USER = 'buoh_integration_api_cuentas_api';
const DATABASES = [DATABASE, PRODUCTION_DATABASE, RACE_DATABASE, EMPTY_DATABASE];
const apiPassword = randomBytes(24).toString('hex');
const KEYS = {
  passwordPepper: randomBytes(32),
  totpKey: randomBytes(32),
  tokenKey: randomBytes(32),
};
const ORIGIN = 'https://buoh.test';
/** El CLI compilado: `pnpm run test:integration` compila antes. */
const CUENTA_CLI = resolve(import.meta.dirname, '../dist/cli/cuenta.js');
const START = Date.parse('2026-11-03T12:00:00.000Z');
const PASSWORD = 'una contraseña larga de prueba';
const NEW_TABLES = [
  'accounts',
  'account_links',
  'link_totp_secrets',
  'credentials',
  'credential_disablements',
  'totp_steps_used',
];

let local: PostgresConfig;
let platform: Pool | undefined;
const pools = new Map<string, { admin: Pool; api: Pool }>();

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

function poolsOf(database: string): { admin: Pool; api: Pool } {
  return ready(pools.get(database));
}

/** Un reloj de prueba que solo avanza cuando la prueba lo mueve. */
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

function service(
  database: string,
  environment: 'test' | 'production' = 'test',
  clock = testClock(),
  hasher: PasswordHasher = createPasswordHasher({
    pepper: KEYS.passwordPepper,
    maxWaiting: 8,
    randomBytes,
  }),
) {
  const accounts = createAccountService({
    pool: poolsOf(database).api,
    environment,
    origin: ORIGIN,
    keys: KEYS,
    hasher,
    commonPasswords: loadCommonPasswords(),
    clock: clock.now,
    randomBytes,
    newId: createUuidV7Generator({ now: clock.now, randomBytes }),
  });
  return { accounts, clock };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Base32 de RFC 4648 sin relleno, como lo lee la app de autenticación. */
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

/** El código que mostraría la app de autenticación con ese secreto a esa hora. */
function codeFor(secret: LinkSecret, nowMs: number): string {
  return hotp(base32Decode(secret.totp.secret), totpStep(nowMs));
}

function tokenOf(url: string): string {
  expect(url.startsWith(`${ORIGIN}/enlace/#`)).toBe(true);
  return url.slice(`${ORIGIN}/enlace/#`.length);
}

async function auditOf(database: string, accountId: string | null): Promise<AuditEvent[]> {
  const { rows } = await poolsOf(database).admin.query<{ event_jcs: string }>(
    `SELECT event_jcs FROM buoh_api.audit_events
      WHERE account_id IS NOT DISTINCT FROM $1 ORDER BY audit_event_id`,
    [accountId],
  );
  return rows.map((row) => auditEventSchema.parse(JSON.parse(row.event_jcs)));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('La operación no se rechazó.');
    },
    (error: unknown) => error,
  );
}

async function linkError(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(LinkError);
  return (error as LinkError).code;
}

async function commandError(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(AccountCommandError);
  return (error as AccountCommandError).code;
}

/** El código SQLSTATE con que falla `text` con ese pool, o `null` si no falla. */
async function sqlState(pool: Pool, text: string, values: unknown[] = []): Promise<string | null> {
  return pool.query(text, values).then(
    () => null,
    (error: unknown) => String((error as { code?: unknown }).code),
  );
}

async function createDatabase(server: Pool, database: string, migrated: boolean): Promise<void> {
  await server.query(`CREATE DATABASE ${database}`);
  const admin = new pg.Pool({ ...local, database, ssl: false, max: 2 });
  if (migrated) {
    await migrate(admin);
    await admin.query(`GRANT USAGE ON SCHEMA buoh_api TO ${API_USER}`);
    await admin.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA buoh_api TO ${API_USER}`);
    await admin.query(`REVOKE INSERT ON buoh_api.buoh_schema_migrations FROM ${API_USER}`);
    await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA buoh_api TO ${API_USER}`);
  }
  const api = createPool(
    { ...local, database, password: apiPassword, sslMode: 'disable', user: API_USER },
    SERVICE_POOL_TIMEOUTS,
  );
  pools.set(database, { admin, api });
}

/**
 * Espera a que la base no tenga sesiones de clientes, para borrarla sin cortar ninguna: `pool.end()`
 * termina antes de que el servidor cierre cada conexión, y `DROP DATABASE … WITH (FORCE)` mandaría a
 * una que todavía no cerró un `57P01` que nadie escucha.
 */
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
  for (const database of DATABASES) {
    await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  await server.query(`DROP ROLE IF EXISTS ${API_USER}`);
}

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await dropAll(platform);
  await platform.query(`CREATE ROLE ${API_USER} LOGIN PASSWORD ${pg.escapeLiteral(apiPassword)}`);
  await createDatabase(platform, DATABASE, true);
  await createDatabase(platform, PRODUCTION_DATABASE, true);
  await createDatabase(platform, RACE_DATABASE, true);
  await createDatabase(platform, EMPTY_DATABASE, false);
});

afterAll(async () => {
  for (const { admin, api } of pools.values()) {
    await api.end();
    await admin.end();
  }
  if (platform !== undefined) {
    for (const database of DATABASES) {
      await waitForNoSessions(platform, database);
    }
    await dropAll(platform);
    await platform.end();
  }
});

describe('la espera de la API con la base real (ADR-0019 §7)', () => {
  it('sin el esquema faltan migraciones; migrada, está lista', async () => {
    expect(await migrationState(poolsOf(EMPTY_DATABASE).api)).toBe('migrations_pending');
    expect(await migrationState(poolsOf(DATABASE).api)).toBe('ready');
  });
});

describe('cuenta alta (ADR-0019 §3 y precisión del PR 3 en §5)', () => {
  it('crea la cuenta sin credencial con su primer enlace, que vale 15 minutos, y su link_created', async () => {
    const { accounts } = service(DATABASE);
    const link = await accounts.createLink({ username: 'ana', purpose: 'enrollment' });
    expect(link).toMatchObject({
      purpose: 'enrollment',
      username: 'ana',
      expiresAtUtc: '2026-11-03T12:15:00.000Z',
    });
    expect(LINK_LIFETIME_MS).toBe(15 * 60 * 1000);
    const token = tokenOf(link.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const { admin } = poolsOf(DATABASE);
    const { rows: accountRows } = await admin.query<{ account_id: string }>(
      "SELECT account_id FROM buoh_api.accounts WHERE username = 'ana'",
    );
    expect(accountRows).toHaveLength(1);
    const accountId = accountRows[0]?.account_id ?? '';
    const { rows: links } = await admin.query<{
      link_id: string;
      token_hmac: Buffer;
      purpose: string;
    }>('SELECT link_id, token_hmac, purpose FROM buoh_api.account_links WHERE account_id = $1', [
      accountId,
    ]);
    expect(links).toHaveLength(1);
    // Solo el HMAC con la clave de los tokens: ni el token ni su SHA-256 sin clave.
    expect(links[0]?.token_hmac).toEqual(linkTokenDigest(KEYS.tokenKey, token));
    expect(links[0]?.token_hmac).not.toEqual(
      createHash('sha256').update(Buffer.from(token, 'base64url')).digest(),
    );
    const { rows: credentials } = await admin.query(
      'SELECT 1 FROM buoh_api.credentials WHERE account_id = $1',
      [accountId],
    );
    expect(credentials).toEqual([]);

    const audit = await auditOf(DATABASE, accountId);
    expect(audit).toEqual([
      {
        schema_version: '1.0.0',
        audit_event_id: expect.any(String) as string,
        occurred_at_utc: '2026-11-03T12:00:00.000Z',
        account_id: accountId,
        actor: 'operator',
        action: 'link_created',
        reason: 'enrollment',
        objects: [
          { kind: 'account', id: accountId },
          { kind: 'link', id: links[0]?.link_id },
        ],
        request_id: null,
      },
    ]);
  });

  it('repetirla con la cuenta sin dar de alta crea otro enlace para ella, que anula el anterior', async () => {
    const { accounts } = service(DATABASE);
    const first = tokenOf(
      (await accounts.createLink({ username: 'beto', purpose: 'enrollment' })).url,
    );
    const second = tokenOf(
      (await accounts.createLink({ username: 'beto', purpose: 'enrollment' })).url,
    );
    expect(second).not.toBe(first);
    const { rows } = await poolsOf(DATABASE).admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM buoh_api.accounts WHERE username = 'beto'",
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(await linkError(accounts.issueSecret({ token: first }))).toBe('invalid_link');
    const secret = await accounts.issueSecret({ token: second });
    expect(linkSecretSchema.parse(secret)).toMatchObject({
      purpose: 'enrollment',
      username: 'beto',
    });
  });
});

describe('el alta con su enlace (ADR-0019 §1 y §3)', () => {
  it('da el secreto TOTP, toma la contraseña y un código válido, y el enlace no se vuelve a usar', async () => {
    const { accounts, clock } = service(DATABASE);
    const token = tokenOf(
      (await accounts.createLink({ username: 'carla', purpose: 'enrollment' })).url,
    );
    clock.advance(60_000);
    const secret = await accounts.issueSecret({ token });
    expect(secret).toEqual(
      linkSecretSchema.parse({
        purpose: 'enrollment',
        username: 'carla',
        expires_at_utc: '2026-11-03T12:15:00.000Z',
        totp: {
          secret: secret.totp.secret,
          uri: `otpauth://totp/buoh:carla?secret=${secret.totp.secret}&issuer=buoh&algorithm=SHA1&digits=6&period=30`,
        },
      }),
    );
    clock.advance(20_000);
    const requestId = '00000000-0000-4000-8000-0000000000c1';
    expect(
      await accounts.useLink({
        token,
        password: PASSWORD,
        code: codeFor(secret, clock.now()),
        requestId,
      }),
    ).toEqual({ result: 'account_enrolled' });

    const { admin } = poolsOf(DATABASE);
    const { rows } = await admin.query<{
      account_id: string;
      credential_id: string;
      link_id: string;
      password_hash: string;
      sealed: Buffer;
    }>(
      `SELECT c.account_id, c.credential_id, c.link_id, c.password_hash,
              s.totp_secret_sealed AS sealed
         FROM buoh_api.credentials c
         JOIN buoh_api.accounts a USING (account_id)
         JOIN buoh_api.link_totp_secrets s USING (credential_id)
        WHERE a.username = 'carla'`,
    );
    expect(rows).toHaveLength(1);
    const credential = rows[0];
    expect(credential?.password_hash).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u,
    );
    expect(credential?.password_hash).not.toContain(PASSWORD);
    // El secreto se guarda cifrado: ni sus bytes ni su base32 están en la fila.
    expect(credential?.sealed).toHaveLength(49);
    expect(credential?.sealed.includes(base32Decode(secret.totp.secret))).toBe(false);
    const { rows: steps } = await admin.query<{ totp_step: string }>(
      'SELECT totp_step FROM buoh_api.totp_steps_used WHERE credential_id = $1',
      [credential?.credential_id],
    );
    expect(steps).toEqual([{ totp_step: String(totpStep(clock.now())) }]);

    const accountId = credential?.account_id ?? '';
    const audit = await auditOf(DATABASE, accountId);
    expect(
      audit.map((event) => [event.action, event.actor, event.reason, event.request_id]),
    ).toEqual([
      ['link_created', 'operator', 'enrollment', null],
      ['link_used', 'anonymous', 'enrollment', requestId],
      ['account_enrolled', 'anonymous', 'enrollment_link', requestId],
    ]);
    expect(audit[1]?.objects).toEqual([
      { kind: 'account', id: accountId },
      { kind: 'link', id: credential?.link_id },
    ]);
    expect(audit[2]?.objects).toEqual([
      { kind: 'account', id: accountId },
      { kind: 'credential', id: credential?.credential_id },
    ]);
    expect(audit[2]?.occurred_at_utc).toBe('2026-11-03T12:01:20.000Z');

    // El enlace ya se usó: no da otro secreto ni vale otra vez.
    expect(await linkError(accounts.issueSecret({ token }))).toBe('invalid_link');
    expect(
      await linkError(
        accounts.useLink({
          token,
          password: PASSWORD,
          code: codeFor(secret, clock.now()),
          requestId,
        }),
      ),
    ).toBe('invalid_link');
    // Y la cuenta ya está dada de alta.
    expect(
      await commandError(accounts.createLink({ username: 'carla', purpose: 'enrollment' })),
    ).toBe('account_already_enrolled');
  });

  it('una contraseña que no vale o un código malo no gastan el enlace', async () => {
    const { accounts, clock } = service(DATABASE);
    const token = tokenOf(
      (await accounts.createLink({ username: 'daniela_martinez', purpose: 'enrollment' })).url,
    );
    const secret = await accounts.issueSecret({ token });
    const requestId = '00000000-0000-4000-8000-0000000000d1';
    const code = codeFor(secret, clock.now());
    for (const [password, reason] of [
      ['corta', 'too_short'],
      ['1qaz2wsx3edc4rfv', 'common_password'],
      // La contraseña entera es el nombre de usuario, con espacios en lugar de _.
      ['Daniela Martinez', 'context_words'],
    ] as const) {
      const error = await rejection(accounts.useLink({ token, password, code, requestId }));
      expect(error, password).toBeInstanceOf(PasswordRejectedError);
      expect((error as PasswordRejectedError).reason).toBe(reason);
    }
    const wrong = code === '000000' ? '000001' : '000000';
    expect(
      await linkError(accounts.useLink({ token, password: PASSWORD, code: wrong, requestId })),
    ).toBe('invalid_code');
    // Un código de hace dos pasos ya no vale.
    const old = hotp(base32Decode(secret.totp.secret), totpStep(clock.now()) - 2);
    expect(
      await linkError(accounts.useLink({ token, password: PASSWORD, code: old, requestId })),
    ).toBe('invalid_code');
    expect(await accounts.useLink({ token, password: PASSWORD, code, requestId })).toEqual({
      result: 'account_enrolled',
    });
  });

  it('vale el último secreto del enlace, y sin pedir ninguno no hay código que valga', async () => {
    const { accounts, clock } = service(DATABASE);
    const token = tokenOf(
      (await accounts.createLink({ username: 'elena', purpose: 'enrollment' })).url,
    );
    const requestId = '00000000-0000-4000-8000-0000000000e1';
    expect(
      await linkError(accounts.useLink({ token, password: PASSWORD, code: '123456', requestId })),
    ).toBe('invalid_code');
    const first = await accounts.issueSecret({ token });
    const second = await accounts.issueSecret({ token });
    expect(second.totp.secret).not.toBe(first.totp.secret);
    expect(
      await linkError(
        accounts.useLink({
          token,
          password: PASSWORD,
          code: codeFor(first, clock.now()),
          requestId,
        }),
      ),
    ).toBe('invalid_code');
    expect(
      await accounts.useLink({
        token,
        password: PASSWORD,
        code: codeFor(second, clock.now()),
        requestId,
      }),
    ).toEqual({ result: 'account_enrolled' });
  });

  it('un enlace vence a los 15 minutos exactos de crearlo', async () => {
    const { accounts, clock } = service(DATABASE);
    const token = tokenOf(
      (await accounts.createLink({ username: 'fran', purpose: 'enrollment' })).url,
    );
    clock.advance(LINK_LIFETIME_MS - 1);
    const secret = await accounts.issueSecret({ token });
    clock.advance(1);
    expect(await linkError(accounts.issueSecret({ token }))).toBe('invalid_link');
    expect(
      await linkError(
        accounts.useLink({
          token,
          password: PASSWORD,
          code: codeFor(secret, clock.now()),
          requestId: '00000000-0000-4000-8000-0000000000f1',
        }),
      ),
    ).toBe('invalid_link');
  });

  it('si el enlace da otro secreto o lo anula otro mientras se calcula el hash, el uso no vale', async () => {
    const clock = testClock();
    const other = service(DATABASE, 'test', clock).accounts;
    const real = createPasswordHasher({ pepper: KEYS.passwordPepper, maxWaiting: 8, randomBytes });
    let during: () => Promise<unknown> = () => Promise.resolve();
    const { accounts } = service(DATABASE, 'test', clock, {
      hash: async (password) => {
        await during();
        return real.hash(password);
      },
      verify: (hash, password) => real.verify(hash, password),
    });
    const requestId = '00000000-0000-4000-8000-000000000a02';

    const lara = tokenOf(
      (await accounts.createLink({ username: 'lara', purpose: 'enrollment' })).url,
    );
    const laraSecret = await accounts.issueSecret({ token: lara });
    during = () => other.issueSecret({ token: lara });
    expect(
      await linkError(
        accounts.useLink({
          token: lara,
          password: PASSWORD,
          code: codeFor(laraSecret, clock.now()),
          requestId,
        }),
      ),
    ).toBe('invalid_code');

    const luis = tokenOf(
      (await accounts.createLink({ username: 'luis', purpose: 'enrollment' })).url,
    );
    const luisSecret = await accounts.issueSecret({ token: luis });
    during = () => other.createLink({ username: 'luis', purpose: 'enrollment' });
    expect(
      await linkError(
        accounts.useLink({
          token: luis,
          password: PASSWORD,
          code: codeFor(luisSecret, clock.now()),
          requestId,
        }),
      ),
    ).toBe('invalid_link');

    const { rows } = await poolsOf(DATABASE).admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM buoh_api.credentials
         JOIN buoh_api.accounts USING (account_id) WHERE username IN ('lara', 'luis')`,
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('dos usos a la vez del mismo enlace, desde dos procesos: solo vale uno', async () => {
    // Dos servicios, como dos instancias de la API, cada uno con su cola de hashes, y una barrera:
    // los dos terminan el hash antes de que ninguno empiece su transacción, así que solo el
    // bloqueo de las cuentas impide que los dos vean el enlace sin usar.
    const clock = testClock();
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothHashed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrierHasher = (): PasswordHasher => {
      const real = createPasswordHasher({
        pepper: KEYS.passwordPepper,
        maxWaiting: 8,
        randomBytes,
      });
      return {
        hash: async (password) => {
          const hash = await real.hash(password);
          arrived += 1;
          if (arrived === 2) {
            release();
          }
          await bothHashed;
          return hash;
        },
        verify: (hash, password) => real.verify(hash, password),
      };
    };
    const first = service(DATABASE, 'test', clock, barrierHasher()).accounts;
    const second = service(DATABASE, 'test', clock, barrierHasher()).accounts;
    const token = tokenOf(
      (await first.createLink({ username: 'gael', purpose: 'enrollment' })).url,
    );
    const secret = await first.issueSecret({ token });
    const use = {
      token,
      password: PASSWORD,
      code: codeFor(secret, clock.now()),
      requestId: '00000000-0000-4000-8000-000000000a01',
    };
    const results = await Promise.allSettled([first.useLink(use), second.useLink(use)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(LinkError);
    expect((rejected?.reason as LinkError).code).toBe('invalid_link');
    const { rows } = await poolsOf(DATABASE).admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM buoh_api.credentials
         JOIN buoh_api.accounts USING (account_id) WHERE username = 'gael'`,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('el rol de la API no elige write_order: filas con el máximo no dejan sin valor lo que viene detrás', async () => {
    const { accounts, clock } = service(DATABASE);
    const { api, admin } = poolsOf(DATABASE);
    const enrollment = tokenOf(
      (await accounts.createLink({ username: 'mara', purpose: 'enrollment' })).url,
    );
    const first = await accounts.issueSecret({ token: enrollment });
    await accounts.useLink({
      token: enrollment,
      password: PASSWORD,
      code: codeFor(first, clock.now()),
      requestId: '00000000-0000-4000-8000-000000000a10',
    });
    const { rows: account } = await admin.query<{ account_id: string }>(
      "SELECT account_id FROM buoh_api.accounts WHERE username = 'mara'",
    );
    const accountId = account[0]?.account_id ?? '';
    const MAX = '9223372036854775807';
    // Un enlace, su secreto y una credencial falsos, con el máximo de bigint en write_order.
    const forgedLink = '01900000-0000-7000-8000-0000000000c1';
    const forgedCredential = '01900000-0000-7000-8000-0000000000c2';
    for (const [text, values] of [
      [
        `INSERT INTO buoh_api.account_links
           (link_id, write_order, account_id, purpose, token_hmac, created_at_utc, expires_at_utc)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, 'reset', $4, '2026-11-03T12:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
        [forgedLink, MAX, accountId, randomBytes(32)],
      ],
      [
        `INSERT INTO buoh_api.link_totp_secrets
           (credential_id, write_order, link_id, totp_secret_sealed, created_at_utc)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, '2026-11-03T12:00:00.000Z')`,
        [forgedCredential, MAX, forgedLink, Buffer.concat([Buffer.from([1]), randomBytes(48)])],
      ],
      [
        `INSERT INTO buoh_api.credentials
           (credential_id, write_order, account_id, link_id, password_hash, created_at_utc)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, '2026-11-03T12:00:00.000Z')`,
        [
          forgedCredential,
          MAX,
          accountId,
          forgedLink,
          `$argon2id$v=19$m=65536,t=3,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
        ],
      ],
    ] as const) {
      expect(await sqlState(api, text, [...values]), text).toBeNull();
    }
    // La base les dio el valor siguiente de su secuencia, no el que llegó en el INSERT.
    const { rows: orders } = await admin.query<{ max: string }>(
      `SELECT max(write_order)::text AS max FROM (
         SELECT write_order FROM buoh_api.account_links
         UNION ALL SELECT write_order FROM buoh_api.link_totp_secrets
         UNION ALL SELECT write_order FROM buoh_api.credentials) AS orders`,
    );
    expect(orders[0]?.max).not.toBe(MAX);

    // El restablecimiento que viene después sigue valiendo, y su credencial queda como la vigente.
    clock.advance(60_000);
    const reset = tokenOf((await accounts.createLink({ username: 'mara', purpose: 'reset' })).url);
    const secret = await accounts.issueSecret({ token: reset });
    expect(
      await accounts.useLink({
        token: reset,
        password: 'otra contraseña larga y nueva',
        code: codeFor(secret, clock.now()),
        requestId: '00000000-0000-4000-8000-000000000a11',
      }),
    ).toEqual({ result: 'credential_reset' });
    const { rows: current } = await admin.query<{ link_id: string }>(
      `SELECT c.link_id FROM buoh_api.credentials c
         JOIN buoh_api.account_links l ON l.link_id = c.link_id
        WHERE c.account_id = $1 ORDER BY c.write_order DESC LIMIT 1`,
      [accountId],
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.link_id).not.toBe(forgedLink);
    expect(linkTokenDigest(KEYS.tokenKey, reset)).toEqual(
      (
        await admin.query<{ token_hmac: Buffer }>(
          'SELECT token_hmac FROM buoh_api.account_links WHERE link_id = $1',
          [current[0]?.link_id],
        )
      ).rows[0]?.token_hmac,
    );
  });

  it('el trigger de write_order no usa una nextval de quien inserta, aunque pueda crear funciones', async () => {
    // Un rol de la API con CREATE en un esquema, algo que buoh_api no tiene: su nextval(text)
    // ganaría a pg_catalog.nextval(regclass) si la función del trigger usara su search_path.
    const { admin } = poolsOf(DATABASE);
    await admin.query('DROP SCHEMA IF EXISTS intruso CASCADE');
    await admin.query('CREATE SCHEMA intruso');
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA intruso TO ${API_USER}`);
    const intruder = new pg.Client({
      ...local,
      database: DATABASE,
      password: apiPassword,
      ssl: false,
      user: API_USER,
    });
    await intruder.connect();
    try {
      await intruder.query(
        `CREATE FUNCTION intruso.nextval(text) RETURNS bigint
         LANGUAGE sql AS 'SELECT 9223372036854775807::bigint'`,
      );
      await intruder.query('SET search_path = intruso, buoh_api, public');
      const accountId = '01900000-0000-7000-8000-0000000000d1';
      await intruder.query(
        `INSERT INTO buoh_api.accounts (account_id, username, created_at_utc)
         VALUES ($1, 'intrusa_2', '2026-11-03T12:00:00.000Z')`,
        [accountId],
      );
      const { rows } = await intruder.query<{ write_order: string }>(
        `INSERT INTO buoh_api.account_links
           (link_id, write_order, account_id, purpose, token_hmac, created_at_utc, expires_at_utc)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, 9223372036854775807, $2, 'enrollment', $3,
                 '2026-11-03T12:00:00.000Z', '2026-11-03T12:15:00.000Z')
         RETURNING write_order::text`,
        ['01900000-0000-7000-8000-0000000000d2', accountId, randomBytes(32)],
      );
      expect(rows[0]?.write_order).not.toBe('9223372036854775807');
    } finally {
      await intruder.end();
      await admin.query('DROP SCHEMA intruso CASCADE');
    }
  });

  it('un enlace insertado con el rol de la API y el SHA-256 sin clave de su token no vale', async () => {
    const { accounts } = service(DATABASE);
    const { api } = poolsOf(DATABASE);
    const token = Buffer.alloc(32, 0x5a).toString('base64url');
    const accountId = '01900000-0000-7000-8000-0000000000aa';
    expect(
      await sqlState(
        api,
        `INSERT INTO buoh_api.accounts (account_id, username, created_at_utc)
         VALUES ($1, 'intrusa', '2026-11-03T12:00:00.000Z')`,
        [accountId],
      ),
    ).toBeNull();
    for (const [n, digest] of [
      [1, createHash('sha256').update(Buffer.from(token, 'base64url')).digest()],
      [2, createHmac('sha256', randomBytes(32)).update(Buffer.from(token, 'base64url')).digest()],
    ] as const) {
      expect(
        await sqlState(
          api,
          `INSERT INTO buoh_api.account_links
             (link_id, account_id, purpose, token_hmac, created_at_utc, expires_at_utc)
           VALUES ($1, $2, 'enrollment', $3, '2026-11-03T12:00:00.000Z', '2026-11-03T12:15:00.000Z')`,
          [`01900000-0000-7000-8000-0000000000b${String(n)}`, accountId, digest],
        ),
      ).toBeNull();
    }
    expect(await linkError(accounts.issueSecret({ token }))).toBe('invalid_link');
  });
});

describe('cuenta restablecer (ADR-0019 §3)', () => {
  it('no crea enlace para una cuenta que no existe o que todavía no está dada de alta', async () => {
    const { accounts } = service(DATABASE);
    expect(await commandError(accounts.createLink({ username: 'nadie', purpose: 'reset' }))).toBe(
      'account_not_found',
    );
    await accounts.createLink({ username: 'hugo', purpose: 'enrollment' });
    expect(await commandError(accounts.createLink({ username: 'hugo', purpose: 'reset' }))).toBe(
      'account_not_enrolled',
    );
  });

  it('pone una credencial nueva y deja deshabilitada la anterior', async () => {
    const { accounts, clock } = service(DATABASE);
    const enrollment = tokenOf(
      (await accounts.createLink({ username: 'ines', purpose: 'enrollment' })).url,
    );
    const first = await accounts.issueSecret({ token: enrollment });
    await accounts.useLink({
      token: enrollment,
      password: PASSWORD,
      code: codeFor(first, clock.now()),
      requestId: '00000000-0000-4000-8000-000000000b01',
    });
    clock.advance(3_600_000);
    // Un enlace de restablecimiento nuevo anula el anterior.
    const stale = tokenOf((await accounts.createLink({ username: 'ines', purpose: 'reset' })).url);
    const reset = tokenOf((await accounts.createLink({ username: 'ines', purpose: 'reset' })).url);
    expect(await linkError(accounts.issueSecret({ token: stale }))).toBe('invalid_link');
    const secret = await accounts.issueSecret({ token: reset });
    expect(secret).toMatchObject({ purpose: 'reset', username: 'ines' });
    const requestId = '00000000-0000-4000-8000-000000000b02';
    expect(
      await accounts.useLink({
        token: reset,
        password: 'otra contraseña larga y nueva',
        code: codeFor(secret, clock.now()),
        requestId,
      }),
    ).toEqual({ result: 'credential_reset' });

    const { admin } = poolsOf(DATABASE);
    const { rows } = await admin.query<{
      account_id: string;
      credential_id: string;
      reason: string | null;
    }>(
      `SELECT c.account_id, c.credential_id, d.reason
         FROM buoh_api.credentials c
         JOIN buoh_api.accounts a USING (account_id)
         LEFT JOIN buoh_api.credential_disablements d USING (credential_id)
        WHERE a.username = 'ines' ORDER BY c.write_order`,
    );
    expect(rows.map((row) => row.reason)).toEqual(['replaced', null]);
    const [old, current] = rows;
    const accountId = current?.account_id ?? '';
    const audit = await auditOf(DATABASE, accountId);
    expect(audit.map((event) => [event.action, event.reason])).toEqual([
      ['link_created', 'enrollment'],
      ['link_used', 'enrollment'],
      ['account_enrolled', 'enrollment_link'],
      ['link_created', 'reset'],
      ['link_created', 'reset'],
      ['link_used', 'reset'],
      ['credential_reset', 'reset_link'],
    ]);
    const credentials = [old?.credential_id ?? '', current?.credential_id ?? ''].sort();
    expect(audit.at(-1)).toMatchObject({
      actor: 'anonymous',
      request_id: requestId,
      objects: [
        { kind: 'account', id: accountId },
        { kind: 'credential', id: credentials[0] },
        { kind: 'credential', id: credentials[1] },
      ],
    });

    // El enlace de restablecimiento ya se usó: aunque la cuenta siga dada de alta y sea su último
    // enlace, no da otro secreto ni vale otra vez.
    expect(await linkError(accounts.issueSecret({ token: reset }))).toBe('invalid_link');
    expect(
      await linkError(
        accounts.useLink({
          token: reset,
          password: 'otra contraseña larga y nueva',
          code: codeFor(secret, clock.now()),
          requestId,
        }),
      ),
    ).toBe('invalid_link');
  });
});

describe('en production (ADR-0019 §3)', () => {
  it('alta solo si no hay ninguna cuenta dada de alta, y el enlace de otra deja de valer en cuanto hay una', async () => {
    const { accounts, clock } = service(PRODUCTION_DATABASE, 'production');
    const eva = tokenOf(
      (await accounts.createLink({ username: 'eva', purpose: 'enrollment' })).url,
    );
    // Mientras ninguna está dada de alta, otra cuenta sin credencial puede tener su enlace.
    const fede = tokenOf(
      (await accounts.createLink({ username: 'fede', purpose: 'enrollment' })).url,
    );
    const fedeSecret = await accounts.issueSecret({ token: fede });
    const evaSecret = await accounts.issueSecret({ token: eva });
    await accounts.useLink({
      token: eva,
      password: PASSWORD,
      code: codeFor(evaSecret, clock.now()),
      requestId: '00000000-0000-4000-8000-000000000c01',
    });
    expect(
      await commandError(accounts.createLink({ username: 'gabi', purpose: 'enrollment' })),
    ).toBe('enrolled_account_exists');
    expect(
      await commandError(accounts.createLink({ username: 'fede', purpose: 'enrollment' })),
    ).toBe('enrolled_account_exists');
    expect(await linkError(accounts.issueSecret({ token: fede }))).toBe('invalid_link');
    expect(
      await linkError(
        accounts.useLink({
          token: fede,
          password: PASSWORD,
          code: codeFor(fedeSecret, clock.now()),
          requestId: '00000000-0000-4000-8000-000000000c02',
        }),
      ),
    ).toBe('invalid_link');
    // La cuenta dada de alta sí se puede restablecer.
    const reset = await accounts.createLink({ username: 'eva', purpose: 'reset' });
    expect(reset.purpose).toBe('reset');
    const { rows } = await poolsOf(PRODUCTION_DATABASE).admin.query<{ username: string }>(
      `SELECT a.username FROM buoh_api.accounts a
        WHERE EXISTS (SELECT 1 FROM buoh_api.credentials c WHERE c.account_id = a.account_id)`,
    );
    expect(rows).toEqual([{ username: 'eva' }]);
  });
});

describe('en production, dos altas a la vez (ADR-0019 §3)', () => {
  it('con dos enlaces de alta de cuentas distintas usados a la vez, solo una queda dada de alta', async () => {
    // Como en la prueba de los dos usos a la vez: dos servicios con su cola de hashes y una barrera,
    // así que solo el bloqueo y la nueva lectura de las otras cuentas impiden las dos altas.
    const clock = testClock();
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothHashed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrierHasher = (): PasswordHasher => {
      const real = createPasswordHasher({
        pepper: KEYS.passwordPepper,
        maxWaiting: 8,
        randomBytes,
      });
      return {
        hash: async (password) => {
          const hash = await real.hash(password);
          arrived += 1;
          if (arrived === 2) {
            release();
          }
          await bothHashed;
          return hash;
        },
        verify: (hash, password) => real.verify(hash, password),
      };
    };
    const first = service(RACE_DATABASE, 'production', clock, barrierHasher()).accounts;
    const second = service(RACE_DATABASE, 'production', clock, barrierHasher()).accounts;
    const nora = tokenOf((await first.createLink({ username: 'nora', purpose: 'enrollment' })).url);
    const omar = tokenOf((await first.createLink({ username: 'omar', purpose: 'enrollment' })).url);
    const noraSecret = await first.issueSecret({ token: nora });
    const omarSecret = await first.issueSecret({ token: omar });
    const results = await Promise.allSettled([
      first.useLink({
        token: nora,
        password: PASSWORD,
        code: codeFor(noraSecret, clock.now()),
        requestId: '00000000-0000-4000-8000-000000000e01',
      }),
      second.useLink({
        token: omar,
        password: PASSWORD,
        code: codeFor(omarSecret, clock.now()),
        requestId: '00000000-0000-4000-8000-000000000e02',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(LinkError);
    expect((rejected?.reason as LinkError).code).toBe('invalid_link');
    const { rows } = await poolsOf(RACE_DATABASE).admin.query<{ n: number }>(
      'SELECT count(DISTINCT account_id)::int AS n FROM buoh_api.credentials',
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe('las tablas de las cuentas son append-only (ADR-0019 §7)', () => {
  /** Una columna de cada tabla, para un UPDATE que no cambia nada. */
  const COLUMN: Readonly<Record<string, string>> = {
    accounts: 'username',
    account_links: 'purpose',
    link_totp_secrets: 'created_at_utc',
    credentials: 'created_at_utc',
    credential_disablements: 'reason',
    totp_steps_used: 'used_at_utc',
  };

  it('cada tabla nueva tiene filas, para que los triggers de fila se prueben', async () => {
    for (const table of NEW_TABLES) {
      const { rows } = await poolsOf(DATABASE).admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM buoh_api.${table}`,
      );
      expect(rows[0]?.n, table).toBeGreaterThan(0);
    }
  });

  it('con el rol de la API, UPDATE, DELETE, TRUNCATE y el DDL fallan con 42501 en cada una', async () => {
    const { api } = poolsOf(DATABASE);
    for (const table of NEW_TABLES) {
      const column = COLUMN[table] ?? '';
      for (const text of [
        `UPDATE buoh_api.${table} SET ${column} = ${column}`,
        `DELETE FROM buoh_api.${table}`,
        `TRUNCATE buoh_api.${table}`,
        `ALTER TABLE buoh_api.${table} ADD COLUMN intrusa int`,
        `DROP TABLE buoh_api.${table}`,
      ]) {
        expect(await sqlState(api, text), text).toBe('42501');
      }
    }
  });

  it('como su dueño, los triggers rechazan UPDATE, DELETE y TRUNCATE con 23001', async () => {
    const { admin } = poolsOf(DATABASE);
    for (const table of NEW_TABLES) {
      const column = COLUMN[table] ?? '';
      for (const text of [
        `UPDATE buoh_api.${table} SET ${column} = ${column}`,
        `DELETE FROM buoh_api.${table}`,
        `TRUNCATE buoh_api.${table} CASCADE`,
      ]) {
        expect(await sqlState(admin, text), text).toBe('23001');
      }
    }
  });
});

describe('el recorrido completo por HTTP, con inject contra la base (ADR-0019 §11 y §13)', () => {
  it('los secretos solo salen por su canal: el token en la orden, el secreto TOTP en su respuesta', async () => {
    const { accounts, clock } = service(DATABASE);
    const lines: ApiLogLine[] = [];
    let n = 0;
    const unusedSessions: SessionService = {
      login: () => Promise.reject(new Error('sin sesiones en esta prueba')),
      authenticate: () => Promise.resolve(null),
      renewActivity: () => Promise.resolve(),
      logout: () => Promise.resolve(0),
      closeOthers: () => Promise.resolve(0),
      listAudit: () => Promise.resolve([]),
      csrfToken: () => '0'.repeat(64),
      validateCsrf: () => false,
      flushPendingFailures: () => Promise.resolve(),
    };
    const app = buildApp({
      log: (line) => lines.push(line),
      now: () => 0,
      requestId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
      origin: ORIGIN,
      routes: apiRoutes({
        readiness: { isReady: () => true },
        links: accounts,
        sessions: unusedSessions,
        limiter: createRateLimiter(),
        clock: clock.now,
        data: null,
      }),
      rateLimit: () => 0,
    });
    const headers = { origin: ORIGIN, 'content-type': 'application/json' };
    const token = tokenOf(
      (await accounts.createLink({ username: 'ivan', purpose: 'enrollment' })).url,
    );
    const secretResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/enlace/secreto',
      headers,
      payload: JSON.stringify({ token }),
    });
    expect(secretResponse.statusCode).toBe(200);
    const secret = linkSecretSchema.parse(secretResponse.json());
    // Los dos códigos enviados, el bueno y el malo, también son secretos de la petición.
    const goodCode = codeFor(secret, clock.now());
    const badCode = goodCode === '000000' ? '000001' : '000000';
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/enlace',
      headers,
      payload: JSON.stringify({ token, password: PASSWORD, code: badCode }),
    });
    expect(bad.statusCode).toBe(400);
    const use = await app.inject({
      method: 'POST',
      url: '/api/v1/enlace',
      headers,
      payload: JSON.stringify({ token, password: PASSWORD, code: goodCode }),
    });
    expect(use.statusCode).toBe(200);
    expect(use.json()).toEqual({ result: 'account_enrolled' });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/enlace/secreto',
      headers,
      payload: JSON.stringify({ token }),
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'invalid_link' } });

    const logged = JSON.stringify(lines);
    const keys = Object.values(KEYS).flatMap((key) => [
      key.toString('base64'),
      key.toString('hex'),
    ]);
    const codes = [goodCode, badCode].map((code) => JSON.stringify(code));
    for (const value of [token, PASSWORD, secret.totp.secret, ...codes, ...keys]) {
      expect(logged).not.toContain(value);
      for (const response of [bad, use, again]) {
        expect(response.body).not.toContain(value);
        expect(JSON.stringify(response.headers)).not.toContain(value);
      }
    }
    for (const value of [token, PASSWORD, ...codes, ...keys]) {
      expect(secretResponse.body).not.toContain(value);
    }
    // En la auditoría, ninguno de ellos.
    const { rows } = await poolsOf(DATABASE).admin.query<{ event_jcs: string }>(
      'SELECT event_jcs FROM buoh_api.audit_events',
    );
    const audit = JSON.stringify(rows);
    for (const value of [token, PASSWORD, secret.totp.secret, ...codes, ...keys]) {
      expect(audit).not.toContain(value);
    }
  });
});

describe('la orden cuenta compilada (ADR-0019 §3)', () => {
  const env = (database: string, extra: Record<string, string> = {}) => ({
    BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
    BUOH_API_ORIGIN: ORIGIN,
    BUOH_API_PASSWORD_PEPPER: KEYS.passwordPepper.toString('base64'),
    BUOH_API_TOTP_KEY: KEYS.totpKey.toString('base64'),
    BUOH_API_TOKEN_KEY: KEYS.tokenKey.toString('base64'),
    BUOH_POSTGRES_HOST: local.host,
    BUOH_POSTGRES_PORT: String(local.port),
    BUOH_POSTGRES_DB: database,
    BUOH_POSTGRES_USER: API_USER,
    BUOH_POSTGRES_PASSWORD: apiPassword,
    BUOH_POSTGRES_SSLMODE: 'disable',
    ...extra,
  });
  const run = (args: string[], environment: Record<string, string>) => {
    const result = spawnSync(process.execPath, [CUENTA_CLI, ...args], {
      encoding: 'utf8',
      env: environment,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('alta escribe el enlace y sale con 0; sobre una cuenta dada de alta sale con 1, sin el enlace', async () => {
    const created = run(['alta', 'julia'], env(DATABASE));
    expect(created.status).toBe(0);
    expect(created.stderr).toBe('');
    const lines = created.stdout.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^Enlace de alta de la cuenta «julia», de un solo uso, válido hasta \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:$/u,
    );
    const token = tokenOf(lines[1] ?? '');
    expect(lines[2]).toBe('');
    const { accounts, clock } = service(DATABASE, 'test', testClock(Date.now()));
    const secret = await accounts.issueSecret({ token });
    await accounts.useLink({
      token,
      password: PASSWORD,
      code: codeFor(secret, clock.now()),
      requestId: '00000000-0000-4000-8000-000000000d01',
    });
    const again = run(['alta', 'julia'], env(DATABASE));
    expect(again).toEqual({
      status: 1,
      stdout: '',
      stderr:
        'No se creó el enlace: la cuenta «julia» ya está dada de alta. Para una contraseña o un código nuevos: cuenta restablecer julia (account_already_enrolled).\n',
    });
    const reset = run(['restablecer', 'julia'], env(DATABASE));
    expect(reset.status).toBe(0);
    expect(reset.stdout).toMatch(
      /^Enlace de restablecimiento de la cuenta «julia», de un solo uso/u,
    );
  });

  it('sale con 1 y el código de PostgreSQL si no puede conectar, y con 2 ante un uso o una configuración que no valen', () => {
    expect(
      run(['restablecer', 'julia'], env(DATABASE, { BUOH_POSTGRES_PASSWORD: 'otra-mala' })),
    ).toEqual({
      status: 1,
      stdout: '',
      stderr: 'No se creó el enlace: PostgreSQL no respondió (28P01).\n',
    });
    for (const args of [
      [],
      ['alta'],
      ['borrar', 'julia'],
      ['alta', 'Julia'],
      ['alta', 'julia', 'otra'],
    ]) {
      const result = run(args, env(DATABASE));
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
    }
    const invalid = run(['alta', 'julia'], env(DATABASE, { BUOH_API_TOKEN_KEY: 'mala' }));
    expect(invalid).toEqual({
      status: 2,
      stdout: '',
      stderr: 'Configuración inválida o ausente: BUOH_API_TOKEN_KEY.\n',
    });
  });

  it('sin las migraciones de la API sale con 1 y not_ready', () => {
    expect(run(['alta', 'kim'], env(EMPTY_DATABASE))).toEqual({
      status: 1,
      stdout: '',
      stderr:
        'No se creó el enlace: faltan las migraciones de la API; buoh-operaciones las aplica cada 5 minutos (not_ready).\n',
    });
  });
});
