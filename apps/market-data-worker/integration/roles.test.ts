import { randomBytes } from 'node:crypto';

import pg, { type Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  AGENT_CONNECTION_LIMIT,
  AGENT_IDLE_IN_TRANSACTION_TIMEOUT,
  AGENT_STATEMENT_TIMEOUT,
  createPool,
  ensureRuntimeRoles,
  grantLogPrivileges,
  healthCommand,
  INGEST_DENIED_TABLES,
  INGEST_WRITE_TABLES,
  loadConfig,
  LOGIN_ROLES,
  migrate,
  migrateCommand,
  openHealthStores,
  openLockedSourceLog,
  openStores,
  POSTGRES_ROLES,
  PostgresSessionLockProvider,
  runIngest,
  setRolePassword,
  type WorkerConfig,
} from '../src/index.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';

/**
 * Los roles de PostgreSQL de producción (ADR-0018 §8 y §9, `F2-ROLE-001`) contra PostgreSQL y
 * S3-compatible locales. El usuario de los servicios locales, superusuario, hace solo de Render:
 * crea el usuario por defecto, que no es superusuario y tiene `CREATEROLE`, y su base, y después los
 * usuarios de las rotaciones. Lo demás lo hace ese usuario por defecto con el código del worker,
 * como `buoh-operaciones` en producción: crea `buoh_dueno` y, como él, los roles de ejecución, y el
 * esquema del log y sus tablas son de `buoh_dueno`. Con `buoh_ingesta`, `UPDATE`, `DELETE`,
 * `TRUNCATE` y el DDL fallan con `42501`, y la captura de `ingest` funciona; con `buoh_salud`,
 * `data:health` funciona y no puede escribir. Dos usuarios sucesivos, como tras dos rotaciones de la
 * credencial dueña, siguen administrándolo todo.
 *
 * La sesión no sale a la red: su fábrica de sockets es falsa y sus esquemas son sintéticos. Las
 * contraseñas de la prueba son aleatorias y nunca se escriben. Los roles son de todo el servidor:
 * la prueba borra los suyos y su base al empezar, por si quedaron de una ejecución cortada, y al
 * terminar.
 */
const DATABASE = 'buoh_integration_roles';
const SCHEMA = 'buoh_integration_roles';
const SYMBOL = 'SYNTH_100';
/** El usuario por defecto de Render: inicia sesión, crea roles y bases, y no es superusuario. */
const RENDER_USER = 'buoh_integration_render';
/** Dos usuarios como el anterior, los que crea Render al rotar la credencial dueña. */
const ROTATED = ['buoh_integration_dueno_2', 'buoh_integration_dueno_3'] as const;
/** Todos los roles de la prueba, en un orden en que se pueden borrar. */
const TEST_ROLES = [
  ...[...ROTATED].reverse(),
  ...LOGIN_ROLES,
  POSTGRES_ROLES.reader,
  POSTGRES_ROLES.owner,
  RENDER_USER,
];
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
/** La configuración del superusuario en la base de la prueba. */
let config: WorkerConfig;
/** El superusuario en la base de la prueba, para mirar lo que dejan los demás. */
let admin: Pool | undefined;
/** El superusuario en la base por defecto: hace de Render. */
let platform: Pool | undefined;
/** El usuario por defecto de Render en la base de la prueba. */
let renderPool: Pool | undefined;
let renderClient: PoolClient | undefined;
const passwords = {
  health: randomBytes(32).toString('base64'),
  ingest: randomBytes(32).toString('base64'),
  render: randomBytes(32).toString('base64'),
  rotated: ROTATED.map(() => randomBytes(32).toString('base64')),
};
let migrateLine: Record<string, unknown>;

/** El entorno de `user` en la base de la prueba, con su contraseña. */
function roleEnvironment(user: string, password: string): Record<string, string | undefined> {
  return { ...environment, BUOH_POSTGRES_PASSWORD: password, BUOH_POSTGRES_USER: user };
}

/** La configuración de `user` en la base de la prueba, con su contraseña. */
function roleConfig(user: string, password: string): WorkerConfig {
  return loadConfig(roleEnvironment(user, password));
}

/** Un valor que se inicializa en `beforeAll`; falla si no llegó a hacerlo. */
function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** Como Render: borra la base de la prueba y después sus roles, si quedaron. */
async function dropTestDatabaseAndRoles(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  for (const role of TEST_ROLES) {
    await server.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

beforeAll(async () => {
  platform = createPool({
    ...loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres,
    schema: 'public',
  });
  await dropTestDatabaseAndRoles(platform);
  await platform.query(
    `CREATE ROLE ${RENDER_USER} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.render)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE} OWNER ${RENDER_USER}`);
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  renderPool = createPool({
    ...roleConfig(RENDER_USER, passwords.render).postgres,
    schema: 'public',
  });
  renderClient = await renderPool.connect();
  await ensureRuntimeRoles(renderClient);
  // El log 1 lo prepara buoh-operaciones (ADR-0018 §6): un esquema de buoh_dueno.
  await renderClient.query(`SET ROLE ${POSTGRES_ROLES.owner}`);
  await renderClient.query(`CREATE SCHEMA ${SCHEMA}`);
  await renderClient.query('RESET ROLE');
  const migrated = await migrateCommand(
    {
      ...roleEnvironment(RENDER_USER, passwords.render),
      BUOH_POSTGRES_OWNER_ROLE: POSTGRES_ROLES.owner,
    },
    { createPool: (postgres) => createPool(postgres), migrate },
  );
  migrateLine = { exitCode: migrated.exitCode, ...(JSON.parse(migrated.line) as object) };
  await grantLogPrivileges(renderClient, SCHEMA);
  await setRolePassword(renderClient, POSTGRES_ROLES.ingest, passwords.ingest);
  await setRolePassword(renderClient, POSTGRES_ROLES.health, passwords.health);
});

afterAll(async () => {
  renderClient?.release();
  await renderPool?.end();
  await admin?.end();
  if (platform !== undefined) {
    await dropTestDatabaseAndRoles(platform);
    await platform.end();
  }
});

/** Espera con el reloj real a que `check` se cumpla, como mucho 10 s. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('La condición no se cumplió en 10 s.');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** El código SQLSTATE con que falla `text`, o `null` si no falla. */
async function sqlState(pool: Pool, text: string): Promise<string | null> {
  return pool.query(text).then(
    () => null,
    (error: unknown) => String((error as { code?: unknown }).code),
  );
}

describe('el usuario por defecto de Render prepara la base (ADR-0018 §8)', () => {
  it('sin ser superusuario, crea buoh_dueno, y solo buoh_dueno administra los roles de ejecución, con los límites de buoh_agente', async () => {
    const server = ready(admin);
    const { rows: render } = await server.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = $1',
      [RENDER_USER],
    );
    expect(render).toEqual([{ rolsuper: false }]);
    const runtime = [POSTGRES_ROLES.reader, ...LOGIN_ROLES];
    const { rows: admins } = await server.query<{ admin: string; role: string }>(
      `SELECT r.rolname AS role, m.rolname AS admin
         FROM pg_auth_members a
         JOIN pg_roles r ON r.oid = a.roleid
         JOIN pg_roles m ON m.oid = a.member
        WHERE a.admin_option AND r.rolname = ANY($1)`,
      [runtime],
    );
    expect(new Set(admins.map((row) => row.role))).toEqual(new Set(runtime));
    expect(new Set(admins.map((row) => row.admin))).toEqual(new Set([POSTGRES_ROLES.owner]));
    const { rows: agent } = await server.query<{ rolconfig: string[]; rolconnlimit: number }>(
      'SELECT rolconfig, rolconnlimit FROM pg_roles WHERE rolname = $1',
      [POSTGRES_ROLES.agent],
    );
    expect(agent[0]?.rolconnlimit).toBe(AGENT_CONNECTION_LIMIT);
    expect([...(agent[0]?.rolconfig ?? [])].sort()).toEqual([
      `idle_in_transaction_session_timeout=${AGENT_IDLE_IN_TRANSACTION_TIMEOUT}`,
      `statement_timeout=${AGENT_STATEMENT_TIMEOUT}`,
    ]);
  });
});

describe('db:migrate con el rol dueño (F2-ROLE-001)', () => {
  it('aplica las cinco migraciones como buoh_dueno: el esquema y cada tabla son suyos', async () => {
    expect(migrateLine).toMatchObject({ exitCode: 0, status: 'migrated' });
    expect(migrateLine['applied']).toHaveLength(5);
    const { rows } = await ready(admin).query<{ owner: string }>(
      `SELECT tableowner AS owner FROM pg_tables WHERE schemaname = $1
       UNION ALL
       SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1`,
      [SCHEMA],
    );
    expect(rows.length).toBeGreaterThan(INGEST_WRITE_TABLES.length);
    expect(new Set(rows.map((row) => row.owner))).toEqual(new Set([POSTGRES_ROLES.owner]));
  });

  it('sus errores contra PostgreSQL salen saneados con salida 1: un usuario que no es miembro del rol dueño (42501) y una contraseña mala (28P01)', async () => {
    const cases = [
      [POSTGRES_ROLES.ingest, passwords.ingest, '42501'],
      [RENDER_USER, randomBytes(32).toString('base64'), '28P01'],
    ] as const;
    for (const [user, password, reason] of cases) {
      const result = await migrateCommand(
        { ...roleEnvironment(user, password), BUOH_POSTGRES_OWNER_ROLE: POSTGRES_ROLES.owner },
        { createPool: (postgres) => createPool(postgres), migrate },
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.line)).toEqual({
        code: 'MIGRATION_FAILED',
        reason,
        status: 'failed',
      });
      // Ni el mensaje de PostgreSQL ni lo que lleva: el usuario, la contraseña, el servidor, el rol
      // o la base.
      for (const secret of [
        user,
        password,
        config.postgres.host,
        POSTGRES_ROLES.owner,
        DATABASE,
        'permission denied',
        'authentication failed',
      ]) {
        expect(result.line).not.toContain(secret);
      }
    }
  });
});

describe('buoh_ingesta solo lee e inserta (F2-ROLE-001)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(roleConfig(POSTGRES_ROLES.ingest, passwords.ingest).postgres);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('UPDATE, DELETE y TRUNCATE fallan por permisos (42501) en cada tabla del log', async () => {
    for (const table of INGEST_WRITE_TABLES) {
      expect(await sqlState(pool, `SELECT 1 FROM ${table} LIMIT 1`)).toBeNull();
      expect(await sqlState(pool, `UPDATE ${table} SET source = source WHERE false`)).toBe('42501');
      expect(await sqlState(pool, `DELETE FROM ${table} WHERE false`)).toBe('42501');
      expect(await sqlState(pool, `TRUNCATE ${table}`)).toBe('42501');
    }
  });

  it('el DDL falla por permisos (42501): crear, cambiar y borrar tablas, y crear esquemas', async () => {
    for (const text of [
      'CREATE TABLE intrusa (x int)',
      'ALTER TABLE source_event_index ADD COLUMN intrusa int',
      'DROP TABLE ingestion_heartbeats',
      'CREATE SCHEMA intruso',
    ]) {
      expect(await sqlState(pool, text)).toBe('42501');
    }
  });

  it('no lee ni escribe las tablas de datasets de 0001', async () => {
    for (const table of INGEST_DENIED_TABLES) {
      expect(await sqlState(pool, `SELECT 1 FROM ${table} LIMIT 1`)).toBe('42501');
    }
  });

  it('la captura de ingest funciona con ese rol: abre, guarda ticks, el cursor y los latidos, y para', async () => {
    const ingest = roleConfig(POSTGRES_ROLES.ingest, passwords.ingest);
    const stores = openStores(ingest);
    const sockets: FakeDerivSocket[] = [];
    const alerts: unknown[] = [];
    let signal: (() => void) | null = null;
    try {
      const report = runIngest({
        alert: (payload) => alerts.push(payload),
        connect: (input) => {
          const socket = new FakeDerivSocket(input);
          sockets.push(socket);
          return socket;
        },
        expected: fixture.expected,
        fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
        lock: new PostgresSessionLockProvider({ postgres: ingest.postgres, source: DERIV_SOURCE }),
        nextId: () => uuid((sequence += 1)),
        now: clock.now,
        openLog: (lock) =>
          openLockedSourceLog(lock, {
            objects: stores.objects,
            source: DERIV_SOURCE,
            store: stores.sourceLog,
            zlibVersion: process.versions.zlib,
          }),
        random: () => 0,
        scheduler: clock.scheduler,
        schemaUrl: 'https://schemas.invalid/schemas.zip',
        signals: (handler) => {
          signal = handler;
          return () => {
            signal = null;
          };
        },
        stores,
        symbol: SYMBOL,
      });
      await eventually(() => sockets.length === 1);
      const [socket] = sockets;
      if (socket === undefined) {
        throw new TypeError('Falta el socket.');
      }
      socket.open();
      await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
      socket.text(derivMessages.catalog(1));
      await eventually(() => socket.requests().some((request) => 'ticks' in request));
      await clock.advance(200);
      socket.text(derivMessages.tick(2, START_EPOCH, '100.25'));
      const rows = async () =>
        Number(
          (
            await ready(admin).query<{ n: string }>(
              `SELECT count(*) AS n FROM ${SCHEMA}.source_event_index`,
            )
          ).rows[0]?.n ?? 0,
        );
      await eventually(async () => (await rows()) === 3);
      (signal as (() => void) | null)?.();
      await eventually(() => socket.requests().some((request) => 'forget_all' in request));
      socket.text(derivMessages.forgetAll(3));
      const result = await report;
      expect(result).toMatchObject({ end: { status: 'completed' }, status: 'completed' });
      expect(result.connections[0]?.closure).toEqual({
        closure_type: 'requested',
        persisted: true,
        reason: 'requested',
      });
      expect(await rows()).toBe(5);
      const written = await ready(admin).query<{
        heartbeats: string;
        cursors: string;
        catalog: string;
      }>(
        `SELECT (SELECT count(*) FROM ${SCHEMA}.ingestion_heartbeats) AS heartbeats,
                (SELECT count(*) FROM ${SCHEMA}.ingestion_cursors) AS cursors,
                (SELECT count(*) FROM ${SCHEMA}.source_catalog_versions) AS catalog`,
      );
      expect(Number(written.rows[0]?.heartbeats)).toBeGreaterThan(0);
      expect(Number(written.rows[0]?.cursors)).toBeGreaterThan(0);
      expect(Number(written.rows[0]?.catalog)).toBe(1);
      expect(JSON.stringify(alerts)).not.toContain('42501');
    } finally {
      await stores.close();
    }
  });
});

describe('buoh_salud solo lee (F2-ROLE-001)', () => {
  it('data:health funciona con ese rol, sin un rechazo por permisos, sobre el log que dejó la captura', async () => {
    const result = await healthCommand(
      ['--', '--json', '--symbol', SYMBOL],
      {
        ...environment,
        BUOH_POSTGRES_PASSWORD: passwords.health,
        BUOH_POSTGRES_USER: POSTGRES_ROLES.health,
      },
      {
        expected: fixture.expected,
        nextId: () => uuid((sequence += 1)),
        now: clock.now,
        openStores: (opened) => openHealthStores(opened),
        scheduler: clock.scheduler,
      },
    );
    // Sin escritor vivo, la regla 4 (ADR-0015 §8): desconectada, backlog 0 y paused, con salida 1.
    // Sin stderr: ni la alerta de las reglas 2 y 3 ni un punto de control rechazado.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeNull();
    const report = JSON.parse(result.stdout ?? 'null') as Record<string, unknown>;
    expect(report).toMatchObject({
      backlog_count: 0,
      connection_state: 'disconnected',
      open_condition_types: [],
      service_health: 'paused',
    });
    expect(report['last_received_at_utc']).not.toBeNull();
  });

  it('INSERT, UPDATE y DELETE fallan por permisos (42501)', async () => {
    const pool = createPool(roleConfig(POSTGRES_ROLES.health, passwords.health).postgres);
    try {
      expect(await sqlState(pool, 'SELECT count(*) FROM source_event_index')).toBeNull();
      expect(
        await sqlState(pool, "INSERT INTO ingestion_heartbeats (source) VALUES ('synthetic')"),
      ).toBe('42501');
      expect(await sqlState(pool, 'UPDATE ingestion_cursors SET source = source WHERE false')).toBe(
        '42501',
      );
      expect(await sqlState(pool, 'DELETE FROM source_event_index WHERE false')).toBe('42501');
    } finally {
      await pool.end();
    }
  });
});

describe('BUOH_POSTGRES_SSLMODE contra un servidor sin TLS (ADR-0018 §9)', () => {
  it('require y verify-full fallan en lugar de conectar sin cifrar; disable conecta', async () => {
    for (const sslMode of ['require', 'verify-full'] as const) {
      const pool = createPool({ ...config.postgres, sslMode });
      try {
        await expect(pool.query('SELECT 1')).rejects.toThrow(/does not support SSL/u);
      } finally {
        await pool.end();
      }
    }
    const plain = createPool({ ...config.postgres, sslMode: 'disable' });
    try {
      expect((await plain.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one).toBe(1);
    } finally {
      await plain.end();
    }
  });
});

describe('dos rotaciones de la credencial dueña (ADR-0018 §8)', () => {
  it('cada usuario nuevo recibe buoh_dueno con ADMIN OPTION del anterior, y el último migra, vuelve a fijar los atributos cambiados a mano y ajusta privilegios y contraseñas', async () => {
    const server = ready(platform);
    // Render crea cada usuario nuevo como el primero.
    for (const [index, user] of ROTATED.entries()) {
      await server.query(
        `CREATE ROLE ${user} LOGIN CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(passwords.rotated[index] ?? '')}`,
      );
    }
    // El usuario de Render da la pertenencia al primero, y el primero al segundo.
    await ready(renderClient).query(
      `GRANT ${POSTGRES_ROLES.owner} TO ${ROTATED[0]} WITH ADMIN TRUE, SET TRUE`,
    );
    const first = createPool(roleConfig(ROTATED[0], passwords.rotated[0] ?? '').postgres);
    try {
      await first.query(`GRANT ${POSTGRES_ROLES.owner} TO ${ROTATED[1]} WITH ADMIN TRUE, SET TRUE`);
    } finally {
      await first.end();
    }
    // Atributos cambiados a mano, que ensureRuntimeRoles vuelve a fijar.
    // Sin CREATEROLE, buoh_dueno no podría ajustar los roles de ejecución en el paso 3: lo recupera
    // antes, en la misma transacción.
    await server.query(`ALTER ROLE ${POSTGRES_ROLES.owner} LOGIN NOCREATEROLE`);
    await server.query(`ALTER ROLE ${POSTGRES_ROLES.reader} LOGIN`);
    await server.query(`ALTER ROLE ${POSTGRES_ROLES.ingest} CREATEROLE`);
    const pool = createPool(roleConfig(ROTATED[1], passwords.rotated[1] ?? '').postgres);
    const client = await pool.connect();
    const renewed = randomBytes(32).toString('base64');
    try {
      await ensureRuntimeRoles(client);
      const { rows: attributes } = await server.query<{
        rolcanlogin: boolean;
        rolcreaterole: boolean;
        rolname: string;
      }>(
        'SELECT rolname, rolcanlogin, rolcreaterole FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
        [[POSTGRES_ROLES.owner, POSTGRES_ROLES.reader, ...LOGIN_ROLES]],
      );
      expect(attributes).toEqual([
        { rolcanlogin: true, rolcreaterole: false, rolname: POSTGRES_ROLES.agent },
        { rolcanlogin: false, rolcreaterole: true, rolname: POSTGRES_ROLES.owner },
        { rolcanlogin: true, rolcreaterole: false, rolname: POSTGRES_ROLES.ingest },
        { rolcanlogin: false, rolcreaterole: false, rolname: POSTGRES_ROLES.reader },
        { rolcanlogin: true, rolcreaterole: false, rolname: POSTGRES_ROLES.health },
      ]);
      expect(await migrate(pool, { ownerRole: POSTGRES_ROLES.owner })).toMatchObject({
        applied: [],
      });
      await grantLogPrivileges(client, SCHEMA);
      await setRolePassword(client, POSTGRES_ROLES.ingest, renewed);
      await client.query(`SET ROLE ${POSTGRES_ROLES.owner}`);
      await client.query('CREATE TABLE rotacion_prueba (x int)');
      await client.query('DROP TABLE rotacion_prueba');
      await client.query('RESET ROLE');
    } finally {
      client.release();
      await pool.end();
    }
    // La contraseña nueva vale, y la anterior ya no.
    const ingest = createPool(roleConfig(POSTGRES_ROLES.ingest, renewed).postgres);
    const stale = createPool(roleConfig(POSTGRES_ROLES.ingest, passwords.ingest).postgres);
    try {
      expect(await sqlState(ingest, 'SELECT count(*) FROM source_event_index')).toBeNull();
      expect(await sqlState(stale, 'SELECT 1')).toBe('28P01');
    } finally {
      await ingest.end();
      await stale.end();
    }
    // El usuario de la primera rotación no se puede borrar mientras sea quien dio la pertenencia al
    // segundo (2BP01): los pasos de la rotación lo tienen en cuenta (ADR-0018 §8).
    expect(await sqlState(server, `DROP ROLE ${ROTATED[0]}`)).toBe('2BP01');
  });
});
