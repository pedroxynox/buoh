import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  createPool,
  GOLD_SEQUENCE,
  INGEST_RESTART_FIRST_WAIT_MS,
  ingestCommand,
  loadConfig,
  LOG_CUT_CHECK_MS,
  logLocation,
  migrate,
  openLockedSourceLog,
  openStartupReads,
  openStores,
  pendingMigrations,
  readLogQualityProfile,
  PostgresSessionLockProvider,
  R_100_SEQUENCE,
  S3ObjectStore,
  sourceLockHolder,
  type LogLocation,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { START, uuid } from '../test/support/connection-harness.js';
import {
  catalogEntry,
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';
import { waitForNoSessions } from '../test/support/databases.js';

/**
 * Dos sesiones de `ingest` en un proceso (ADR-0021 §1 y §8), R_100 y el oro, contra PostgreSQL y
 * S3-compatible locales, con `ingestCommand` en `production`, sus lecturas reales y el socket falso:
 * cada una con su log, su bloqueo y su corte. R_100 conserva sus nombres (`buoh_log_<n>` y
 * `logs/<n>/`) y la clave de bloqueo de la fuente; el oro usa los de su secuencia. Una sesión que
 * termina `failed` vuelve a empezar dentro del proceso, tras su espera, y no corta la otra. A la hora
 * de corte, el oro, con su log siguiente preparado, corta y sigue en él con el mismo bloqueo, y R_100,
 * sin el suyo, sigue en su log.
 *
 * Usa su propia base, `buoh_integration_ingest_two`, y los logs 301, 401 y 402 de cada secuencia,
 * números que ninguna otra prueba usa, porque el bucket es el de todas. Como en
 * integration/log-cut.test.ts, el servidor local no tiene TLS, así que las conexiones van con
 * `disable`, y el bucket es el de las pruebas. La base se borra al empezar y al terminar.
 */
const DATABASE = 'buoh_integration_ingest_two';
const GOLD = 'frxXAUUSD';
const R_100 = 'R_100';
const TEST_BUCKET = process.env['BUOH_S3_BUCKET'] ?? 'buoh-local';
/** La hora de corte de un log escrito por primera vez en `START`, un lunes: el lunes siguiente. */
const CUT_TIME = '2026-03-09T00:00:00.000Z';
const ARGV = ['--live', '--symbol', R_100, '--symbol', GOLD];
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
  BUOH_S3_BUCKET: 'buoh-captura',
};
const ENTRIES = {
  [GOLD]: catalogEntry(GOLD, 'Gold/USD'),
  [R_100]: catalogEntry(R_100, 'Volatility 100 Index'),
};
const fixture = syntheticSchemaArchive();
const SOURCE_SCHEMA_KEY = contentKey(fixture.expected.entries_sha256['ticks_response.schema.json']);
const LOGS = [301, 401, 402].flatMap((number) => [
  logLocation(number, R_100_SEQUENCE),
  logLocation(number, GOLD_SEQUENCE),
]);
let sequence = 0;
let platform: Pool | undefined;
let admin: Pool | undefined;
let localConfig: WorkerConfig;
let stopCommand: (() => void) | null = null;

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

/** Borra lo que dejó una pasada anterior bajo los prefijos de los logs de la prueba. */
async function clearPrefixes(config: WorkerConfig): Promise<void> {
  const client = new S3Client({
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    region: config.s3.region,
  });
  try {
    for (const log of LOGS) {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: TEST_BUCKET, Prefix: log.prefix }),
      );
      for (const object of listed.Contents ?? []) {
        if (object.Key !== undefined) {
          await client.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: object.Key }));
        }
      }
    }
  } finally {
    client.destroy();
  }
}

/** Crea el esquema del log con todas sus migraciones. */
async function prepare(log: LogLocation): Promise<void> {
  await ready(admin).query(`CREATE SCHEMA ${log.schema}`);
  const pool = createPool({ ...localConfig.postgres, schema: log.schema });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

/** Las filas del índice de un log. */
async function indexRows(log: LogLocation): Promise<number> {
  const { rows } = await ready(admin).query<{ n: string }>(
    `SELECT count(*) AS n FROM ${log.schema}.source_event_index`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Los PID distintos de los latidos de un log. */
async function heartbeatPids(log: LogLocation): Promise<Set<number>> {
  const { rows } = await ready(admin).query<{ pg_backend_pid: number }>(
    `SELECT DISTINCT pg_backend_pid FROM ${log.schema}.ingestion_heartbeats`,
  );
  return new Set(rows.map((row) => row.pg_backend_pid));
}

/** Si el esquema de fuente que guarda la sesión está bajo el prefijo del log. */
async function hasSourceSchema(log: LogLocation): Promise<boolean> {
  const root = S3ObjectStore.fromConfig(local(localConfig).s3);
  try {
    await root.get(`${log.prefix}${SOURCE_SCHEMA_KEY}`, 16 * 1024 * 1024);
    return true;
  } catch {
    return false;
  } finally {
    root.destroy();
  }
}

/** El símbolo de la suscripción `ticks` que pidió el socket, o `null`. */
function subscribedTo(socket: FakeDerivSocket): string | null {
  const request = socket.requests().find((item) => 'ticks' in item) as
    { ticks?: unknown } | undefined;
  return typeof request?.ticks === 'string' ? request.ticks : null;
}

/** El socket número `number`, desde 1, cuando existe. */
async function socketNumber(sockets: FakeDerivSocket[], number: number): Promise<FakeDerivSocket> {
  await eventually(() => sockets.length >= number);
  const socket = sockets[number - 1];
  if (socket === undefined) {
    throw new TypeError('Falta el socket.');
  }
  return socket;
}

/** Abre la conexión y contesta el catálogo con esas entradas. */
async function answerCatalog(socket: FakeDerivSocket, entries: readonly unknown[]): Promise<void> {
  socket.open();
  await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
  socket.text(derivMessages.catalog(1, entries));
}

/**
 * Con el catálogo ya contestado, espera la suscripción y le manda un tick de su símbolo con la hora
 * del reloj. Da el símbolo.
 */
async function answerTick(socket: FakeDerivSocket, clock: ManualClock): Promise<string> {
  await eventually(() => subscribedTo(socket) !== null);
  const symbol = ready(subscribedTo(socket) ?? undefined);
  socket.text(derivMessages.tick(2, Math.floor(Date.parse(clock.now()) / 1000), '100.25', symbol));
  return symbol;
}

/** Responde a la petición `forget_all` de la parada, cuando llega. */
async function answerForgetAll(socket: FakeDerivSocket): Promise<void> {
  await eventually(() => socket.requests().some((request) => 'forget_all' in request));
  const request = socket.requests().find((item) => 'forget_all' in item) as
    { req_id?: number } | undefined;
  if (request?.req_id === undefined) {
    throw new TypeError('Falta forget_all.');
  }
  socket.text(derivMessages.forgetAll(request.req_id));
}

/** `ingestCommand` con dos símbolos y las dependencias de la prueba. */
function start(clock: ManualClock) {
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const sockets: FakeDerivSocket[] = [];
  let signal: (() => void) | null = null;
  const command = ingestCommand(ARGV, environment, {
    alert: (payload) => alerts.push(payload),
    connect: (input) => {
      const socket = new FakeDerivSocket(input);
      sockets.push(socket);
      return socket;
    },
    expected: fixture.expected,
    fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
    lockProvider: (config, logSequence) =>
      new PostgresSessionLockProvider({
        postgres: local(config).postgres,
        sequence: logSequence,
        source: DERIV_SOURCE,
      }),
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    openLog: openLockedSourceLog,
    openStartupReads: (config, logSequence, alert) =>
      openStartupReads(local(config), {
        alert,
        now: clock.now,
        sequence: logSequence,
        source: DERIV_SOURCE,
      }),
    openStores: (config) => {
      const stores = openStores(local(config));
      return {
        ...stores,
        logProfile: () => readLogQualityProfile(stores.pool),
        pendingMigrations: () => pendingMigrations(stores.pool),
      };
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
  return {
    alerts,
    command,
    sockets,
    stop: () => {
      signal?.();
    },
  };
}

/** Las capturas de la línea final, como `[símbolo, salida, estado]`. */
function capturesOf(line: string): [string, number, string][] {
  const parsed = JSON.parse(line) as {
    captures: { exit_code: number; result: { status: string }; symbol: string }[];
  };
  return parsed.captures.map((item) => [item.symbol, item.exit_code, item.result.status]);
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
  await clearPrefixes(local(localConfig));
});

afterAll(async () => {
  stopCommand?.();
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropDatabase(platform);
    await platform.end();
  }
});

describe('dos sesiones de ingest en un proceso (ADR-0021 §1 y §8)', () => {
  it('cada símbolo captura en el log de su secuencia, con su bloqueo; la del oro, que termina failed, vuelve a empezar tras su espera, y R_100 sigue', async () => {
    const r100 = logLocation(301, R_100_SEQUENCE);
    const gold = logLocation(301, GOLD_SEQUENCE);
    // R_100 conserva sus nombres; el oro usa los de su secuencia.
    expect([r100.schema, r100.prefix]).toEqual(['buoh_log_000301', 'logs/000301/']);
    expect([gold.schema, gold.prefix]).toEqual([
      'buoh_frxxauusd_log_000301',
      'logs/frxxauusd/000301/',
    ]);
    await prepare(r100);
    await prepare(gold);
    const clock = new ManualClock(START);
    const run = start(clock);

    // Las dos primeras conexiones reciben un catálogo sin el oro: la de R_100 se suscribe, y la
    // sesión del oro termina failed con symbol_not_in_catalog.
    const first = await socketNumber(run.sockets, 1);
    const second = await socketNumber(run.sockets, 2);
    await answerCatalog(first, [ENTRIES[R_100]]);
    await answerCatalog(second, [ENTRIES[R_100]]);
    await eventually(() => run.alerts.some((alert) => alert['event'] === 'ingest_capture_restart'));
    expect(run.alerts.filter((alert) => alert['event'] === 'ingest_capture_restart')).toEqual([
      {
        event: 'ingest_capture_restart',
        reason: 'symbol_not_in_catalog',
        symbol: GOLD,
        wait_ms: String(INGEST_RESTART_FIRST_WAIT_MS),
      },
    ]);
    await eventually(() => [first, second].some((socket) => subscribedTo(socket) === R_100));
    const r100Socket = subscribedTo(first) === R_100 ? first : second;
    expect(subscribedTo(r100Socket === first ? second : first)).toBeNull();
    expect(await answerTick(r100Socket, clock)).toBe(R_100);
    await eventually(async () => (await indexRows(r100)) >= 3);

    // Tras su espera, el oro vuelve a empezar con otra conexión, y R_100 sigue con la suya.
    await clock.advance(INGEST_RESTART_FIRST_WAIT_MS);
    const third = await socketNumber(run.sockets, 3);
    await answerCatalog(third, [ENTRIES[R_100], ENTRIES[GOLD]]);
    expect(await answerTick(third, clock)).toBe(GOLD);
    await eventually(async () => (await indexRows(gold)) >= 3);
    expect(r100Socket.requests().some((request) => 'forget_all' in request)).toBe(false);

    // Cada secuencia tiene su escritor: dos sesiones de PostgreSQL distintas, y la de R_100 tiene
    // la clave de bloqueo de la fuente de siempre.
    const r100Holder = await sourceLockHolder(ready(admin), DERIV_SOURCE);
    const goldHolder = await sourceLockHolder(ready(admin), DERIV_SOURCE, GOLD_SEQUENCE);
    expect(r100Holder).not.toBeNull();
    expect(goldHolder).not.toBeNull();
    expect(r100Holder).not.toBe(goldHolder);

    run.stop();
    await answerForgetAll(r100Socket);
    await answerForgetAll(third);
    const { exitCode, line } = await run.command;
    stopCommand = null;
    expect(exitCode).toBe(0);
    expect(capturesOf(line)).toEqual([
      [R_100, 0, 'completed'],
      [GOLD, 0, 'completed'],
    ]);
    // Cada log tiene sus escrituras, sus latidos con el PID de su bloqueo y su esquema de fuente
    // bajo su prefijo.
    expect([...(await heartbeatPids(r100))]).toEqual([r100Holder]);
    expect([...(await heartbeatPids(gold))]).toContain(goldHolder);
    expect(await hasSourceSchema(r100)).toBe(true);
    expect(await hasSourceSchema(gold)).toBe(true);
    // Todas las alertas llevan su símbolo.
    expect(run.alerts.every((alert) => typeof alert['symbol'] === 'string')).toBe(true);
  });

  it('a la hora de corte, el oro, con su log siguiente preparado, corta y sigue en él con el mismo bloqueo; R_100, sin el suyo, sigue en su log', async () => {
    const r100 = logLocation(401, R_100_SEQUENCE);
    const gold = logLocation(401, GOLD_SEQUENCE);
    const goldNext = logLocation(402, GOLD_SEQUENCE);
    // Sin los logs de la prueba anterior, que tienen escrituras y serían los activos.
    for (const log of [logLocation(301, R_100_SEQUENCE), logLocation(301, GOLD_SEQUENCE)]) {
      await ready(admin).query(`DROP SCHEMA IF EXISTS ${log.schema} CASCADE`);
    }
    await prepare(r100);
    await prepare(gold);
    await prepare(goldNext);
    const clock = new ManualClock(START);
    const run = start(clock);

    const first = await socketNumber(run.sockets, 1);
    const second = await socketNumber(run.sockets, 2);
    await answerCatalog(first, [ENTRIES[R_100], ENTRIES[GOLD]]);
    await answerCatalog(second, [ENTRIES[R_100], ENTRIES[GOLD]]);
    const symbols = [await answerTick(first, clock), await answerTick(second, clock)];
    expect([...symbols].sort()).toEqual([R_100, GOLD]);
    const r100Socket = symbols[0] === R_100 ? first : second;
    const goldSocket = symbols[0] === R_100 ? second : first;
    await eventually(async () => (await indexRows(r100)) >= 3 && (await indexRows(gold)) >= 3);

    // El primer paso de cada corte lee su primera escritura; el siguiente cae en la hora de corte.
    await clock.advance(0);
    await eventually(
      () => clock.pendingDelays().filter((delay) => delay === LOG_CUT_CHECK_MS).length >= 2,
    );
    clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(clock.now()) - LOG_CUT_CHECK_MS);
    await clock.advance(LOG_CUT_CHECK_MS);
    await eventually(
      () =>
        run.alerts.some((alert) => alert['event'] === 'log_cut') &&
        run.alerts.some((alert) => alert['event'] === 'log_cut_blocked'),
    );
    expect(run.alerts.filter((alert) => String(alert['event']).startsWith('log_cut'))).toEqual(
      expect.arrayContaining([
        { event: 'log_cut', forced: 'false', log: '401', next: '402', symbol: GOLD },
        expect.objectContaining({
          event: 'log_cut_blocked',
          reason: 'next_log_not_prepared',
          symbol: R_100,
        }),
      ]),
    );
    expect(run.alerts.filter((alert) => alert['event'] === 'log_cut')).toHaveLength(1);

    // La sesión del oro para y la nueva captura en el 402; R_100 sigue con su conexión.
    await answerForgetAll(goldSocket);
    const third = await socketNumber(run.sockets, 3);
    await answerCatalog(third, [ENTRIES[R_100], ENTRIES[GOLD]]);
    expect(await answerTick(third, clock)).toBe(GOLD);
    await eventually(async () => (await indexRows(goldNext)) >= 3);
    expect(r100Socket.requests().some((request) => 'forget_all' in request)).toBe(false);

    run.stop();
    await answerForgetAll(r100Socket);
    await answerForgetAll(third);
    const { exitCode, line } = await run.command;
    stopCommand = null;
    expect(exitCode).toBe(0);
    expect(capturesOf(line)).toEqual([
      [R_100, 0, 'completed'],
      [GOLD, 0, 'completed'],
    ]);
    // El oro siguió con el mismo bloqueo: los latidos de sus dos logs llevan el mismo PID, que no es
    // el de R_100. R_100 no escribió en ningún log de la secuencia del oro, ni el oro en el de R_100.
    const goldPids = new Set([...(await heartbeatPids(gold)), ...(await heartbeatPids(goldNext))]);
    const r100Pids = await heartbeatPids(r100);
    expect(goldPids.size).toBe(1);
    expect(r100Pids.size).toBe(1);
    expect([...goldPids][0]).not.toBe([...r100Pids][0]);
    expect(await hasSourceSchema(goldNext)).toBe(true);
    expect(await hasSourceSchema(logLocation(402, R_100_SEQUENCE))).toBe(false);
  });
});
