import { randomBytes } from 'node:crypto';

import { sha256Hex } from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  createPool,
  findActiveLog,
  healthCommand,
  listCaptureLogs,
  loadConfig,
  locateActiveLog,
  LOG_RETENTION_MS,
  logLocation,
  migrate,
  ObjectReadError,
  openHealthStores,
  openLockedSourceLog,
  openStores,
  PostgresIngestionStatusStore,
  PostgresSessionLockProvider,
  runIngest,
  S3ObjectStore,
  withLog,
  type WorkerConfig,
} from '../src/index.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';
import { heartbeatOf } from '../test/support/status-store-rules.js';

/**
 * Los logs sucesivos de producción (ADR-0018 §6, §7 y §15) contra PostgreSQL y S3-compatible
 * locales, en una base propia, `buoh_integration_logs`, para que la búsqueda solo vea los logs de la
 * prueba. Hay cuatro logs y dos esquemas que no son de log:
 *
 * - el 1, con un latido viejo, de un log que ya terminó;
 * - el 2, con una captura de `ingest` (`runIngest`) hecha con el esquema y el prefijo del log;
 * - el 3, migrado y vacío: el preparado;
 * - el 4, solo el esquema, como mientras `buoh-operaciones` lo prepara.
 *
 * Un rol de lectura, como `buoh_salud`, puede leer los tres primeros y no el 4. `data:health` corre en
 * `production` con ese rol y busca el log activo como en producción, salvo el cifrado: el servidor
 * local no tiene TLS, así que la prueba abre sus conexiones con `disable`. Que `require` no conecte
 * sin cifrar lo prueba integration/roles.test.ts.
 *
 * La sesión no sale a la red: su fábrica de sockets es falsa y sus esquemas son sintéticos. La base,
 * el rol y su contraseña aleatoria, que nunca se escribe, se borran al empezar y al terminar. Los
 * objetos van al bucket de las demás pruebas, bajo los prefijos `logs/<n>/`.
 */
const DATABASE = 'buoh_integration_logs';
const READER = 'buoh_integration_logs_lector';
const SYMBOL = 'SYNTH_100';
const LOGS = [1, 2, 3, 4].map((number) => logLocation(number));
/** Esquemas con nombres parecidos que no son de log: la búsqueda los ignora. */
const NOT_LOGS = ['buoh_log_1', 'buoh_log_000000', 'buoh_logs_000005'];
const OLD_HEARTBEAT = '2026-02-20T10:00:00.000Z';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_DB: DATABASE,
};
const readerPassword = randomBytes(32).toString('base64');
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
let config: WorkerConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;

/** Un valor que se inicializa en `beforeAll`; falla si no llegó a hacerlo. */
function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** El log `index` de `LOGS`. */
function logAt(index: number) {
  const log = LOGS[index];
  if (log === undefined) {
    throw new TypeError('Falta el log.');
  }
  return log;
}

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

async function dropDatabaseAndRole(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await server.query(`DROP ROLE IF EXISTS ${READER}`);
}

/** Una captura de `ingest` con el esquema y el prefijo de `log`: abre, un tick, y para. */
async function capture(log: ReturnType<typeof logLocation>): Promise<void> {
  const target = withLog(config, log);
  const stores = openStores(target);
  const sockets: FakeDerivSocket[] = [];
  let signal: (() => void) | null = null;
  const rows = async () =>
    Number(
      (
        await ready(admin).query<{ n: string }>(
          `SELECT count(*) AS n FROM ${log.schema}.source_event_index`,
        )
      ).rows[0]?.n ?? 0,
    );
  try {
    const report = runIngest({
      alert: () => undefined,
      connect: (input) => {
        const socket = new FakeDerivSocket(input);
        sockets.push(socket);
        return socket;
      },
      expected: fixture.expected,
      fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
      lock: new PostgresSessionLockProvider({ postgres: target.postgres, source: DERIV_SOURCE }),
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
    await eventually(async () => (await rows()) === 3);
    (signal as (() => void) | null)?.();
    await eventually(() => socket.requests().some((request) => 'forget_all' in request));
    socket.text(derivMessages.forgetAll(3));
    expect(await report).toMatchObject({ status: 'completed' });
  } finally {
    await stores.close();
  }
}

/** La última escritura de la fuente en `schema`, leída directamente. */
async function lastWriteOf(schema: string): Promise<string> {
  const { rows } = await ready(admin).query<{ event: string; heartbeat: string }>(
    `SELECT (SELECT max(event_time_utc) FROM ${schema}.source_event_index) AS event,
            (SELECT max(observed_at_utc) FROM ${schema}.ingestion_heartbeats) AS heartbeat`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new TypeError('Falta la fila.');
  }
  return row.event > row.heartbeat ? row.event : row.heartbeat;
}

beforeAll(async () => {
  platform = createPool({
    ...loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres,
    schema: 'public',
  });
  await dropDatabaseAndRole(platform);
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  await platform.query(`CREATE ROLE ${READER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`);
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  for (const schema of [...LOGS.map((log) => log.schema), ...NOT_LOGS]) {
    await admin.query(`CREATE SCHEMA ${schema}`);
  }
  // Los logs 1 a 3 tienen sus migraciones y los privilegios del rol de lectura; el 4, todavía no.
  for (const log of LOGS.slice(0, 3)) {
    const pool = createPool({ ...config.postgres, schema: log.schema });
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${log.schema} TO ${READER}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${log.schema} TO ${READER}`);
  }
  const first = createPool(withLog(config, logAt(0)).postgres);
  try {
    await new PostgresIngestionStatusStore(first).appendHeartbeat(
      heartbeatOf(DERIV_SOURCE, 1, { observed_at_utc: OLD_HEARTBEAT }),
    );
  } finally {
    await first.end();
  }
  await capture(logAt(1));
});

afterAll(async () => {
  await admin?.end();
  if (platform !== undefined) {
    await dropDatabaseAndRole(platform);
    await platform.end();
  }
});

/** La configuración de `production` con el rol de lectura, sin cifrar, porque el servidor local no tiene TLS. */
function local(production: WorkerConfig): WorkerConfig {
  return { ...production, postgres: { ...production.postgres, sslMode: 'disable' } };
}

/** Los esquemas con los que `data:health` abrió sus almacenes, en orden. */
const observedSchemas: string[] = [];

/** `data:health` en `production` con el rol de lectura, a la hora `now`, y con `--log` si se pide. */
function productionHealth(now: string, log: number | null = null) {
  return healthCommand(
    ['--', '--json', '--symbol', SYMBOL, ...(log === null ? [] : ['--log', String(log)])],
    {
      ...environment,
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_PASSWORD: readerPassword,
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: READER,
    },
    {
      expected: fixture.expected,
      locateLog: (production, requested) =>
        locateActiveLog(local(production), {
          now: () => now,
          number: requested,
          source: DERIV_SOURCE,
        }),
      nextId: () => uuid((sequence += 1)),
      now: () => now,
      openStores: (located) => {
        observedSchemas.push(located.postgres.schema);
        return openHealthStores(local(located));
      },
      scheduler: clock.scheduler,
    },
  );
}

describe('la búsqueda del log activo (ADR-0018 §6)', () => {
  it('lee los esquemas de log en orden, con la última escritura de cada uno, e ignora los demás nombres', async () => {
    const logs = await listCaptureLogs(ready(admin), DERIV_SOURCE);
    expect(logs).toEqual([
      { lastWriteUtc: OLD_HEARTBEAT, location: logAt(0), readable: true },
      { lastWriteUtc: await lastWriteOf(logAt(1).schema), location: logAt(1), readable: true },
      { lastWriteUtc: null, location: logAt(2), readable: true },
      { lastWriteUtc: null, location: logAt(3), readable: false },
    ]);
  });

  it('con un rol que no puede leer el log 4 (42501), la búsqueda no falla y lo cuenta sin escrituras', async () => {
    const reader = createPool({
      ...config.postgres,
      password: readerPassword,
      schema: 'public',
      user: READER,
    });
    try {
      await expect(
        reader.query(`SELECT 1 FROM ${logAt(3).schema}.source_event_index`),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await listCaptureLogs(reader, DERIV_SOURCE)).toEqual(
        await listCaptureLogs(ready(admin), DERIV_SOURCE),
      );
    } finally {
      await reader.end();
    }
  });

  it('el activo es el de mayor número con escrituras, y cuando vence, el preparado de menor número', async () => {
    const last = Date.parse(await lastWriteOf(logAt(1).schema));
    const at = (ms: number) => () => new Date(last + ms).toISOString();
    const source = DERIV_SOURCE;
    expect(await findActiveLog(ready(admin), { now: at(0), source })).toEqual(logAt(1));
    expect(await findActiveLog(ready(admin), { now: at(LOG_RETENTION_MS - 1), source })).toEqual(
      logAt(1),
    );
    expect(await findActiveLog(ready(admin), { now: at(LOG_RETENTION_MS), source })).toEqual(
      logAt(2),
    );
  });
});

describe('los objetos de cada log, bajo su prefijo en el mismo bucket (ADR-0018 §6)', () => {
  it('la captura del log 2 dejó sus objetos bajo logs/000002/, y ninguno bajo logs/000001/', async () => {
    const root = S3ObjectStore.fromConfig(config.s3);
    try {
      const { rows } = await ready(admin).query<{ object_sha256: string }>(
        `SELECT object_sha256 FROM ${logAt(1).schema}.source_event_index ORDER BY segment_index, position LIMIT 1`,
      );
      const keys = [
        contentKey(rows[0]?.object_sha256 ?? ''),
        contentKey(fixture.expected.entries_sha256['ticks_response.schema.json']),
      ];
      for (const key of keys) {
        expect(
          (await root.get(`${logAt(1).prefix}${key}`, 16 * 1024 * 1024)).byteLength,
        ).toBeGreaterThan(0);
        await expect(root.get(`${logAt(0).prefix}${key}`, 16 * 1024 * 1024)).rejects.toMatchObject({
          reason: 'not_found',
        });
      }
    } finally {
      root.destroy();
    }
  });

  it('un log solo lee los suyos: un objeto que está en la raíz del bucket y en el log 2 no está en el log 3', async () => {
    const bytes = new Uint8Array(randomBytes(32));
    const key = contentKey(sha256Hex(bytes));
    const root = S3ObjectStore.fromConfig(config.s3);
    const second = S3ObjectStore.fromConfig(withLog(config, logAt(1)).s3);
    const third = S3ObjectStore.fromConfig(withLog(config, logAt(2)).s3);
    try {
      expect(await root.putIfAbsent(key, bytes, 'application/octet-stream')).toBe('created');
      expect(await second.putIfAbsent(key, bytes, 'application/octet-stream')).toBe('created');
      expect(await second.get(key, 64)).toEqual(bytes);
      expect(await root.get(`${logAt(1).prefix}${key}`, 64)).toEqual(bytes);
      await expect(third.get(key, 64)).rejects.toBeInstanceOf(ObjectReadError);
      await expect(third.get(key, 64)).rejects.toMatchObject({ reason: 'not_found' });
    } finally {
      for (const store of [root, second, third]) {
        store.destroy();
      }
    }
  });
});

describe('data:health en production (ADR-0018 §6 y §11)', () => {
  it('con el rol de lectura, observa el log activo, el 2, con su esquema y su prefijo: el tick de la captura y la regla 4', async () => {
    observedSchemas.length = 0;
    const result = await productionHealth(await lastWriteOf(logAt(1).schema));
    const { rows } = await ready(admin).query<{ received: string }>(
      `SELECT event_time_utc AS received FROM ${logAt(1).schema}.source_event_index
        WHERE kind = 'raw_source_frame' ORDER BY segment_index DESC, position DESC LIMIT 1`,
    );
    expect(observedSchemas).toEqual([logAt(1).schema]);
    expect(rows).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeNull();
    expect(JSON.parse(result.stdout ?? 'null')).toMatchObject({
      connection_state: 'disconnected',
      last_received_at_utc: rows[0]?.received,
      open_condition_types: [],
      service_health: 'paused',
    });
  });

  it('con --log, observa ese log en lugar del activo, también uno vencido; uno que no existe o que el rol no puede leer da log_not_prepared, sin abrir los almacenes (ADR-0018 §11)', async () => {
    observedSchemas.length = 0;
    const now = await lastWriteOf(logAt(1).schema);
    const expired = await productionHealth(now, 1);
    expect(observedSchemas).toEqual([logAt(0).schema]);
    expect(expired.stderr).toBeNull();
    for (const number of [logAt(3).number, 999]) {
      const result = await productionHealth(now, number);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('{"event":"data_health_failed","reason":"log_not_prepared"}');
    }
    expect(observedSchemas).toEqual([logAt(0).schema]);
  });

  it('cuando el log 2 vence, observa el preparado, el 3, vacío', async () => {
    observedSchemas.length = 0;
    const result = await productionHealth(await expiredLastWrite());
    expect(observedSchemas).toEqual([logAt(2).schema]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeNull();
    expect(JSON.parse(result.stdout ?? 'null')).toMatchObject({
      last_event_time_utc: null,
      last_received_at_utc: null,
    });
  });

  it('sin log preparado, la regla 2 con log_not_prepared, sin abrir los almacenes: con solo un log que se prepara, sin tablas ni privilegios, y sin ningún log', async () => {
    observedSchemas.length = 0;
    await ready(admin).query(`DROP SCHEMA ${logAt(2).schema} CASCADE`);
    const preparing = await productionHealth(await expiredLastWrite());
    for (const log of LOGS.filter((item) => item.number !== 3)) {
      await ready(admin).query(`DROP SCHEMA ${log.schema} CASCADE`);
    }
    const none = await productionHealth(START);
    for (const result of [preparing, none]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('{"event":"data_health_failed","reason":"log_not_prepared"}');
      expect(JSON.parse(result.stdout ?? 'null')).toMatchObject({ service_health: 'failed' });
    }
    expect(observedSchemas).toEqual([]);
  });
});

/** La hora en que vence el log 2: 30 días después de su última escritura. El 1 ya venció. */
async function expiredLastWrite(): Promise<string> {
  return new Date(Date.parse(await lastWriteOf(logAt(1).schema)) + LOG_RETENTION_MS).toISOString();
}
