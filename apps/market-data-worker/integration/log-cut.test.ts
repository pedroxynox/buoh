import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { SourceEvent } from '@buoh/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  createPool,
  firstWriteOf,
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
  S3ObjectStore,
  SourceLock,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { START, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';
import { waitForNoSessions } from '../test/support/databases.js';

/**
 * El corte semanal de un log al siguiente (ADR-0018 §6 y §15) contra PostgreSQL y S3-compatible
 * locales, con `ingestCommand` en `production`, sus lecturas reales y el socket falso: la primera
 * escritura del log fija su hora de corte, el log siguiente está preparado y, a esa hora, con el log
 * limpio, la sesión para como una parada y el mismo proceso sigue en el log siguiente, con su
 * catálogo, su esquema de fuente guardado y una primera conexión sin anterior, sin soltar el
 * bloqueo de la fuente: otro proceso que lo pide sin parar durante el corte nunca lo consigue.
 *
 * Usa su propia base, `buoh_integration_log_cut`, y los logs 201 y 202, números que ninguna otra
 * prueba usa, porque el bucket es el de todas. Como en integration/ingest-production.test.ts, el
 * servidor local no tiene TLS, así que las conexiones van con `disable`, y el bucket es el de las
 * pruebas. La base se borra al empezar y al terminar.
 */
const DATABASE = 'buoh_integration_log_cut';
const FIRST = logLocation(201);
const NEXT = logLocation(202);
const SYMBOL = 'SYNTH_100';
const TEST_BUCKET = process.env['BUOH_S3_BUCKET'] ?? 'buoh-local';
/** La hora de corte de un log escrito por primera vez en `START`, un lunes: el lunes siguiente. */
const CUT_TIME = '2026-03-09T00:00:00.000Z';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
  BUOH_S3_BUCKET: 'buoh-captura',
};
const fixture = syntheticSchemaArchive();
const SOURCE_SCHEMA_KEY = contentKey(fixture.expected.entries_sha256['ticks_response.schema.json']);
const clock = new ManualClock(START);
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

/** Borra lo que dejó una pasada anterior bajo los prefijos de los dos logs de la prueba. */
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
    for (const prefix of [FIRST.prefix, NEXT.prefix]) {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: TEST_BUCKET, Prefix: prefix }),
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

/** Las filas del índice de un log, en orden. */
async function indexOf(log: ReturnType<typeof logLocation>) {
  const { rows } = await ready(admin).query<{ kind: string; object_sha256: string }>(
    `SELECT kind, object_sha256 FROM ${log.schema}.source_event_index
      ORDER BY segment_index, position`,
  );
  return rows;
}

/** El source event de una fila del índice, leído de su objeto bajo el prefijo del log. */
async function eventOf(
  log: ReturnType<typeof logLocation>,
  row: { readonly object_sha256: string },
): Promise<SourceEvent> {
  const root = S3ObjectStore.fromConfig(local(localConfig).s3);
  try {
    const bytes = await root.get(`${log.prefix}${contentKey(row.object_sha256)}`, 1024 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes)) as SourceEvent;
  } finally {
    root.destroy();
  }
}

/** Los PID de los latidos de un log, en orden de escritura. */
async function heartbeatPids(log: ReturnType<typeof logLocation>): Promise<number[]> {
  const { rows } = await ready(admin).query<{ pg_backend_pid: number }>(
    `SELECT pg_backend_pid FROM ${log.schema}.ingestion_heartbeats ORDER BY write_order`,
  );
  return rows.map((row) => row.pg_backend_pid);
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

/** Abre la conexión, recibe el catálogo y un tick con la hora del reloj, y espera su apertura durable. */
async function subscribe(socket: FakeDerivSocket, log: ReturnType<typeof logLocation>) {
  socket.open();
  await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
  socket.text(derivMessages.catalog(1));
  await eventually(() => socket.requests().some((request) => 'ticks' in request));
  socket.text(derivMessages.tick(2, Math.floor(Date.parse(clock.now()) / 1000), '100.25'));
  await eventually(async () => (await indexOf(log)).length >= 3);
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
  // Los dos logs, con todas sus migraciones: el 201 todavía sin escrituras y el 202, el preparado.
  for (const log of [FIRST, NEXT]) {
    await admin.query(`CREATE SCHEMA ${log.schema}`);
    const pool = createPool({ ...localConfig.postgres, schema: log.schema });
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  }
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

describe('el corte de un log al siguiente (ADR-0018 §6)', () => {
  it('a la hora de corte que fija la primera escritura, con el log limpio y el siguiente preparado, para la sesión del log y sigue en el siguiente con el mismo bloqueo', async () => {
    const alerts: Parameters<OperationalAlert>[0][] = [];
    const sockets: FakeDerivSocket[] = [];
    let signal: (() => void) | null = null;
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

    // 1. Captura en el log 201, el activo: su primera escritura es de START, un lunes.
    const first = await socketNumber(sockets, 1);
    await subscribe(first, FIRST);
    expect(await firstWriteOf(ready(admin), FIRST, DERIV_SOURCE)).toBe(START);
    // El primer paso del corte lee esa escritura; el siguiente, 30 s después, cae en la hora de corte.
    await clock.advance(0);
    await eventually(() => clock.pendingDelays().includes(LOG_CUT_CHECK_MS));
    clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(clock.now()) - LOG_CUT_CHECK_MS);
    await clock.advance(LOG_CUT_CHECK_MS);
    await eventually(() => alerts.some((alert) => alert['event'] === 'log_cut'));
    expect(alerts).toEqual([{ event: 'log_cut', forced: 'false', log: '201', next: '202' }]);

    // 2. La parada del log 201 y la sesión nueva en el 202. Mientras tanto, otro proceso, como la
    // instancia nueva de un despliegue, pide el bloqueo de la fuente sin parar: nunca lo consigue.
    const attempts: boolean[] = [];
    const poll = { on: true };
    const poller = (async () => {
      while (poll.on) {
        const other = await SourceLock.acquire({
          postgres: local(localConfig).postgres,
          source: DERIV_SOURCE,
        });
        attempts.push(other !== null);
        await other?.release();
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    })();
    await answerForgetAll(first);
    const second = await socketNumber(sockets, 2);
    await subscribe(second, NEXT);
    poll.on = false;
    await poller;
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.filter(Boolean)).toEqual([]);
    (signal as (() => void) | null)?.();
    await answerForgetAll(second);

    const { exitCode, line } = await command;
    stopCommand = null;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ status: 'completed' });

    // El log 201 terminó con el cierre pedido; el 202 empieza con una conexión sin anterior.
    const firstIndex = await indexOf(FIRST);
    const lastOfFirst = firstIndex.at(-1);
    expect(lastOfFirst?.kind).toBe('connection_closed');
    expect(await eventOf(FIRST, ready(lastOfFirst))).toMatchObject({ closure_type: 'requested' });
    const { rows: closed } = await ready(admin).query<{ close_reason: string }>(
      `SELECT close_reason FROM ${FIRST.schema}.closed_source_segments ORDER BY segment_index`,
    );
    expect(closed.at(-1)?.close_reason).toBe('requested');
    const nextIndex = await indexOf(NEXT);
    expect(nextIndex[0]?.kind).toBe('connection_opened');
    expect(await eventOf(NEXT, ready(nextIndex[0]))).toMatchObject({
      supersedes_connection_id: null,
    });
    // Su catálogo y su esquema de fuente, bajo su prefijo.
    const { rows: catalogs } = await ready(admin).query<{ n: string }>(
      `SELECT count(*) AS n FROM ${NEXT.schema}.source_catalog_versions`,
    );
    expect(Number(catalogs[0]?.n)).toBeGreaterThan(0);
    const root = S3ObjectStore.fromConfig(local(localConfig).s3);
    try {
      expect(await root.get(`${NEXT.prefix}${SOURCE_SCHEMA_KEY}`, 16 * 1024 * 1024)).toEqual(
        fixture.entries['ticks_response.schema.json'],
      );
    } finally {
      root.destroy();
    }
    // Un solo bloqueo para las dos sesiones: los latidos de los dos logs llevan el mismo PID.
    const pids = new Set([...(await heartbeatPids(FIRST)), ...(await heartbeatPids(NEXT))]);
    expect(pids.size).toBe(1);
  });
});
