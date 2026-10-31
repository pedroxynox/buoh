import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  createPool,
  ingestCommand,
  loadConfig,
  logLocation,
  migrate,
  ObjectReadError,
  openLockedSourceLog,
  openStartupReads,
  openStores,
  pendingMigrations,
  PostgresSessionLockProvider,
  S3ObjectStore,
  SourceLock,
  STARTUP_LOCK_RETRY_MS,
  STARTUP_RETRY_MS,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { loadMigrations } from '../src/postgres/migrate.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';

/**
 * `ingest` en `production` (ADR-0018 §4) contra PostgreSQL y S3-compatible locales, con
 * `ingestCommand` y sus lecturas reales: la espera del arranque, sin escribir nada, en el orden de
 * §4 (sin log preparado, con una migración que falta y con el bloqueo de otro proceso, que intenta
 * cada segundo), y después la captura en el esquema y el prefijo de su log, con el bloqueo que tomó
 * la espera y sin la retención de 23 horas.
 *
 * Usa su propia base, `buoh_integration_ingest_prod`, para que la búsqueda solo vea su log y el
 * bloqueo de la fuente, que vale para toda la base, no choque con las demás pruebas. Dos cosas del
 * entorno local cambian en las dependencias, no en el comando: el servidor no tiene TLS, así que
 * las conexiones van con `disable`, y el único bucket es el de las demás pruebas, que el comando
 * rechaza en `production` por ser el de los datos sintéticos. Que `require` no conecte sin cifrar lo
 * prueba integration/roles.test.ts.
 *
 * La sesión no sale a la red: su fábrica de sockets es falsa y sus esquemas son sintéticos. La base
 * se borra al empezar y al terminar.
 */
const DATABASE = 'buoh_integration_ingest_prod';
/**
 * El log de la prueba: el 101, un número que ninguna otra prueba usa, porque el bucket es el de todas
 * y integration/successive-logs.test.ts comprueba qué hay bajo los prefijos de los logs 1 a 4.
 */
const LOG = logLocation(101);
const SYMBOL = 'SYNTH_100';
const TEST_BUCKET = process.env['BUOH_S3_BUCKET'] ?? 'buoh-local';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
  BUOH_S3_BUCKET: 'buoh-captura',
};
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
/** El superusuario en la base por defecto: crea y borra la base de la prueba. */
let platform: Pool | undefined;
/** El superusuario en la base de la prueba, para preparar el log y mirar lo que queda. */
let admin: Pool | undefined;
/** La configuración del entorno local en la base de la prueba. */
let localConfig: WorkerConfig;
let stopCommand: (() => void) | null = null;

/** Un valor que se inicializa en `beforeAll`; falla si no llegó a hacerlo. */
function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

/** La configuración de `production` con lo que cambia en local: sin TLS y el bucket de las pruebas. */
function local(config: WorkerConfig): WorkerConfig {
  return {
    ...config,
    postgres: { ...config.postgres, sslMode: 'disable' },
    s3: { ...config.s3, bucket: TEST_BUCKET },
  };
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

async function dropDatabase(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
}

/** Las filas de una tabla del log de la prueba. */
async function rowsOf(table: string): Promise<number> {
  const { rows } = await ready(admin).query<{ n: string }>(
    `SELECT count(*) AS n FROM ${LOG.schema}.${table}`,
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  platform = createPool({
    ...loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres,
    schema: 'public',
  });
  await dropDatabase(platform);
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  localConfig = loadConfig({
    ...process.env,
    BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
    BUOH_POSTGRES_DB: DATABASE,
  });
  admin = createPool({ ...localConfig.postgres, schema: 'public' });
});

afterAll(async () => {
  stopCommand?.();
  await admin?.end();
  if (platform !== undefined) {
    await dropDatabase(platform);
    await platform.end();
  }
});

describe('ingest en production (ADR-0018 §4)', () => {
  it('espera sin escribir nada el log preparado, sus migraciones y el bloqueo, en ese orden, y captura en el esquema y el prefijo del log con el bloqueo de la espera', async () => {
    const alerts: Parameters<OperationalAlert>[0][] = [];
    const sockets: FakeDerivSocket[] = [];
    const opened: WorkerConfig[] = [];
    let signal: (() => void) | null = null;
    const waiting = (reason: string) =>
      alerts.filter((alert) => alert['event'] === 'ingest_waiting' && alert['reason'] === reason);
    const command = ingestCommand(['--live', '--symbol', SYMBOL], environment, {
      alert: (payload) => alerts.push(payload),
      connect: (input) => {
        const socket = new FakeDerivSocket(input);
        sockets.push(socket);
        return socket;
      },
      expected: fixture.expected,
      fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
      lockProvider: (config) =>
        new PostgresSessionLockProvider({ postgres: local(config).postgres, source: DERIV_SOURCE }),
      nextId: () => uuid((sequence += 1)),
      now: clock.now,
      openLog: openLockedSourceLog,
      openStartupReads: (config) =>
        openStartupReads(local(config), {
          alert: (payload) => alerts.push(payload),
          now: clock.now,
          source: DERIV_SOURCE,
        }),
      openStores: (config) => {
        opened.push(config);
        const stores = openStores(local(config));
        return { ...stores, pendingMigrations: () => pendingMigrations(stores.pool) };
      },
      random: () => 0,
      scheduler: clock.scheduler,
      schemaUrl: 'https://schemas.invalid/schemas.zip',
      signals: (handler) => {
        signal = handler;
        return () => {
          signal = null;
        };
      },
      zlibVersion: process.versions.zlib,
    });
    stopCommand = () => {
      signal?.();
    };

    // 1. Sin ningún log: log_not_prepared, y vuelve a mirar a los 30 s.
    await eventually(() => waiting('log_not_prepared').length === 1);
    expect(clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);

    // 2. El log con las migraciones 0001 a 0004: falta la 0005.
    const logPool = createPool({ ...localConfig.postgres, schema: LOG.schema });
    try {
      await ready(admin).query(`CREATE SCHEMA ${LOG.schema}`);
      await logPool.query(
        `CREATE TABLE buoh_schema_migrations (
           name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migration of (await loadMigrations()).slice(0, 4)) {
        await logPool.query(migration.sql);
        await logPool.query('INSERT INTO buoh_schema_migrations (name, sha256) VALUES ($1, $2)', [
          migration.name,
          migration.sha256,
        ]);
      }
      await clock.advance(STARTUP_RETRY_MS);
      await eventually(() => waiting('migrations_pending').length === 1);
      expect(waiting('migrations_pending')[0]?.['detail']).toBe(
        '0005_punto_de_control_en_vivo.sql',
      );

      // 3. Otro proceso tiene el bloqueo y se aplica la 0005: source_lock_taken, cada segundo.
      const other = await SourceLock.acquire({
        postgres: localConfig.postgres,
        source: DERIV_SOURCE,
      });
      if (other === null) {
        throw new TypeError('No se tomó el bloqueo.');
      }
      try {
        expect((await migrate(logPool)).applied).toEqual(['0005_punto_de_control_en_vivo.sql']);
        await clock.advance(STARTUP_RETRY_MS);
        await eventually(() => waiting('source_lock_taken').length === 1);
        expect(clock.pendingDelays()).toEqual([STARTUP_LOCK_RETRY_MS]);
        await clock.advance(STARTUP_LOCK_RETRY_MS);
        await eventually(() => clock.pendingDelays().length === 1);
        expect(clock.pendingDelays()).toEqual([STARTUP_LOCK_RETRY_MS]);
        // Mientras espera, no escribió nada: ni en el log ni en su prefijo, ni abrió sus almacenes.
        expect(opened).toEqual([]);
        for (const table of ['source_event_index', 'ingestion_heartbeats', 'ingestion_cursors']) {
          expect(await rowsOf(table)).toBe(0);
        }
      } finally {
        await other.release();
      }
    } finally {
      await logPool.end();
    }

    // 4. Con el bloqueo libre, lo toma al segundo y captura en el log.
    await clock.advance(STARTUP_LOCK_RETRY_MS);
    await eventually(() => sockets.length === 1);
    expect(opened.map((config) => [config.postgres.schema, config.s3.keyPrefix])).toEqual([
      [LOG.schema, LOG.prefix],
    ]);
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
    await eventually(async () => (await rowsOf('source_event_index')) === 3);
    (signal as (() => void) | null)?.();
    await eventually(() => socket.requests().some((request) => 'forget_all' in request));
    socket.text(derivMessages.forgetAll(3));

    const { exitCode, line } = await command;
    stopCommand = null;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({
      end: { status: 'completed' },
      status: 'completed',
      stopped_for_retention: false,
    });
    expect(await rowsOf('source_event_index')).toBe(5);
    expect(await rowsOf('ingestion_heartbeats')).toBeGreaterThan(0);
    // El esquema de fuente quedó bajo el prefijo del log.
    const root = S3ObjectStore.fromConfig(local(localConfig).s3);
    try {
      const key = contentKey(fixture.expected.entries_sha256['ticks_response.schema.json']);
      expect(await root.get(`${LOG.prefix}${key}`, 16 * 1024 * 1024)).toEqual(
        fixture.entries['ticks_response.schema.json'],
      );
      await expect(root.get(`${logLocation(102).prefix}${key}`, 64)).rejects.toBeInstanceOf(
        ObjectReadError,
      );
    } finally {
      root.destroy();
    }
    // Las alertas de la espera, una por motivo, sin el mensaje de ningún error.
    expect(alerts.map((alert) => alert['reason'])).toEqual([
      'log_not_prepared',
      'migrations_pending',
      'source_lock_taken',
    ]);
  });
});
