import {
  connectionOpenedSchema,
  healthReportSchema,
  sha256Hex,
  type HealthReport,
  type SourceEvent,
} from '@buoh/contracts';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { type ExpectedSchemaArchive } from '../src/deriv/schema-archive.js';
import {
  contentKey,
  createPool,
  healthCommand,
  loadConfig,
  migrate,
  openHealthStores,
  openLockedSourceLog,
  openStores,
  PostgresSessionLockProvider,
  runIngest,
  SourceEventLog,
  SourceLock,
  type IngestReport,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { loadMigrations } from '../src/postgres/migrate.js';
import { sourceLockHolder } from '../src/postgres/source-lock.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';

/**
 * `data:health` (ADR-0015 §8) contra PostgreSQL y S3-compatible locales: el comando completo
 * (`healthCommand`) con las lecturas reales (`openHealthStores`), mientras corre la captura de
 * `ingest` (`runIngest`) con los almacenes reales, el bloqueo de PostgreSQL, el cursor y el latido,
 * y después de pararla. Nunca sale a la red ni a Deriv (ADR-0015 §11): la fábrica de sockets es
 * falsa y los esquemas son sintéticos. Reloj manual e IDs secuenciales; las esperas de la prueba
 * usan el reloj real, porque los almacenes responden con su tiempo. Esquemas PostgreSQL propios,
 * recreados en cada ejecución.
 */
const SCHEMA = 'buoh_integration_health';
/** Un esquema con las migraciones 0001 a 0003, sin la 0004 del cursor y el latido. */
const OLD_SCHEMA = 'buoh_integration_health_old';
const SYMBOL = 'SYNTH_100';
const ARGS = ['--', '--json', '--symbol', SYMBOL];
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
const fixture = syntheticSchemaArchive();
const clock = new ManualClock(START);
let sequence = 0;
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;
/** El último dataset activo de `deriv_options` en `test`, de la primera prueba. */
let lastDataset: string | null = null;

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  for (const schema of [SCHEMA, OLD_SCHEMA]) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  }
  stores = openStores(config);
  await migrate(stores.pool);
});

afterAll(async () => {
  await stores.close();
  await admin.end();
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

/**
 * Un dataset visible de `source`, con un core sintético (`label`) y su record en `environment`. La
 * base comprueba que `dataset_id` es el SHA-256 de su core (migración `0001`).
 */
async function published(input: {
  readonly environment: 'development' | 'test';
  readonly label: string;
  readonly publication: number;
  readonly publishedAt: string;
  readonly source: string;
  readonly state?: 'active' | 'superseded';
}): Promise<string> {
  const { rows } = await stores.pool.query<{ dataset_id: string }>(
    `INSERT INTO datasets (dataset_id, state, source, manifest_core_jcs)
     VALUES ('sha256:' || encode(sha256(convert_to($2, 'UTF8')), 'hex'), 'published', $1, $2)
     RETURNING dataset_id`,
    [input.source, JSON.stringify({ prueba: input.label })],
  );
  const datasetId = rows[0]?.dataset_id;
  if (datasetId === undefined) {
    throw new TypeError('El dataset no devolvió su ID.');
  }
  await stores.pool.query(
    `INSERT INTO published_manifest_records
       (publication_id, deployment_environment, dataset_id, schema_version,
        manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
        published_at_utc, state)
     VALUES ($1, $2, $3, '1.0.0', $4, 's3://buoh-sintetico/manifests/prueba.json', $4, $5, $6)`,
    [
      uuid(input.publication),
      input.environment,
      datasetId,
      '0'.repeat(64),
      input.publishedAt,
      input.state ?? 'active',
    ],
  );
  return datasetId;
}

/**
 * Los bloqueos advisory de toda la base, con su sesión, y cuántas filas tiene cada tabla del
 * esquema: lo que `data:health` nunca cambia.
 */
async function footprint(schema: string) {
  const locks = await admin.query<Record<string, unknown>>(
    `SELECT pid, classid::text AS classid, objid::text AS objid, objsubid, mode, granted
       FROM pg_locks WHERE locktype = 'advisory' ORDER BY pid, classid, objid`,
  );
  const tables = await admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schema],
  );
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables.rows) {
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM ${schema}.${table}`,
    );
    counts[table] = Number(rows[0]?.count);
  }
  return { counts, locks: locks.rows };
}

/**
 * `data:health` completo sobre las lecturas reales, con el reloj manual: la salida y el informe, si
 * hay. Comprueba que no tomó ningún bloqueo, que no escribió nada en el esquema, que stdout tiene
 * una sola línea y que ninguna salida lleva una credencial.
 */
async function health(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly expected?: ExpectedSchemaArchive;
    readonly schema?: string;
  } = {},
) {
  const schema = options.schema ?? SCHEMA;
  const before = await footprint(schema);
  const result = await healthCommand(
    ARGS,
    { ...environment, BUOH_POSTGRES_SCHEMA: schema, ...options.env },
    {
      expected: options.expected ?? fixture.expected,
      nextId: () => uuid((sequence += 1)),
      now: clock.now,
      openStores: (opened) => openHealthStores(opened),
      scheduler: clock.scheduler,
    },
  );
  expect(await footprint(schema)).toEqual(before);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const secret of [
    config.postgres.password,
    config.s3.accessKeyId,
    config.s3.secretAccessKey,
  ]) {
    expect(output).not.toContain(secret);
  }
  expect(result.stdout).not.toBeNull();
  expect(result.stdout).not.toContain('\n');
  const report: HealthReport = healthReportSchema.parse(JSON.parse(result.stdout ?? ''));
  return { ...result, report };
}

/** Los source events durables del log de la fuente, leídos de PostgreSQL y del bucket. */
async function durableEvents(): Promise<SourceEvent[]> {
  const log = await SourceEventLog.open({
    objects: stores.objects,
    source: DERIV_SOURCE,
    store: stores.sourceLog,
    zlibVersion: process.versions.zlib,
  });
  return (await log.readDurableSegments()).flat();
}

const indexRows = async (): Promise<number> => {
  const { rows } = await stores.pool.query<{ count: string }>(
    'SELECT count(*) FROM source_event_index WHERE source = $1',
    [DERIV_SOURCE],
  );
  return Number(rows[0]?.count ?? 0);
};

/** El PID del último latido de la fuente. */
async function lastHeartbeatPid(): Promise<number | undefined> {
  const { rows } = await stores.pool.query<{ pg_backend_pid: number }>(
    'SELECT pg_backend_pid FROM ingestion_heartbeats WHERE source = $1 ORDER BY write_order DESC LIMIT 1',
    [DERIV_SOURCE],
  );
  return rows[0]?.pg_backend_pid;
}

/** El último frame durable del log. */
async function lastFrame() {
  const frame = (await durableEvents()).findLast((event) => event.kind === 'raw_source_frame');
  if (frame?.kind !== 'raw_source_frame') {
    throw new TypeError('El log no tiene frames.');
  }
  return frame;
}

/** Una captura sobre los almacenes reales, ya arrancada; `stop` es la señal de parada. */
function capture() {
  const sockets: FakeDerivSocket[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  let signal: (() => void) | null = null;
  const report: Promise<IngestReport> = runIngest({
    alert: (payload) => alerts.push(payload),
    connect: (input) => {
      const socket = new FakeDerivSocket(input);
      sockets.push(socket);
      return socket;
    },
    expected: fixture.expected,
    fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
    lock: new PostgresSessionLockProvider({ postgres: config.postgres, source: DERIV_SOURCE }),
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
  return {
    alerts,
    report,
    sockets,
    stop: () => {
      signal?.();
    },
  };
}

describe('PostgresMetadataStore.lastActiveDatasetId (ADR-0015 §8, «Entradas»)', () => {
  it('da el dataset_id del último record activo de la fuente en el entorno, por hora de publicación y después por publication_id, o null', async () => {
    const last = () => stores.metadata.lastActiveDatasetId(DERIV_SOURCE, 'test');
    expect(await last()).toBeNull();

    const first = await published({
      environment: 'test',
      label: 'primero',
      publication: 1,
      publishedAt: '2026-03-02T10:00:00.000Z',
      source: DERIV_SOURCE,
    });
    expect(await last()).toBe(first);

    // Más tardíos, pero de otra fuente, de otro entorno o ya no activos: no cuentan.
    await published({
      environment: 'test',
      label: 'otra fuente',
      publication: 2,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: 'synthetic',
    });
    await published({
      environment: 'development',
      label: 'otro entorno',
      publication: 3,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: DERIV_SOURCE,
    });
    await published({
      environment: 'test',
      label: 'reemplazado',
      publication: 4,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: DERIV_SOURCE,
      state: 'superseded',
    });
    expect(await last()).toBe(first);

    // Uno publicado después, y otro a la misma hora con un publication_id mayor.
    await published({
      environment: 'test',
      label: 'segundo',
      publication: 6,
      publishedAt: '2026-03-02T10:30:00.000Z',
      source: DERIV_SOURCE,
    });
    const tied = await published({
      environment: 'test',
      label: 'empatado',
      publication: 7,
      publishedAt: '2026-03-02T10:30:00.000Z',
      source: DERIV_SOURCE,
    });
    expect(await last()).toBe(tied);
    lastDataset = tied;
  });
});

describe('data:health sobre PostgreSQL y S3-compatible (ADR-0015 §8)', () => {
  let firstConnection: string | null = null;
  let sessionPid: number | null = null;

  it('mientras la captura tiene el bloqueo y su latido es reciente, aplica la regla 5: conectada, con raw durable, healthy y salida 0', async () => {
    const run = capture();
    await eventually(() => run.sockets.length === 1);
    const [socket] = run.sockets;
    if (socket === undefined) {
      throw new TypeError('Falta el socket.');
    }
    socket.open();
    await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
    socket.text(derivMessages.catalog(1));
    await eventually(() => socket.requests().some((request) => 'ticks' in request));
    await clock.advance(200);
    socket.text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await eventually(async () => (await indexRows()) === 3);
    await clock.advance(2000);
    socket.text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await eventually(async () => (await indexRows()) === 4);
    // El escritor vivo es el de este esquema: su PID es el del último latido.
    sessionPid = await sourceLockHolder(admin, DERIV_SOURCE);
    expect(sessionPid).not.toBeNull();
    expect(await lastHeartbeatPid()).toBe(sessionPid);

    const result = await health();
    const frame = await lastFrame();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBeNull();
    expect(result.report).toEqual({
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: 'connected',
      execution_mode: 'disabled',
      last_event_time_utc: '2026-03-02T10:00:02.000Z',
      last_observation_id: frame.observation_id,
      last_published_dataset_id: lastDataset,
      last_received_at_utc: frame.received_at_utc,
      open_condition_types: [],
      schema_version: '1.0.0',
      service_health: 'healthy',
      source: DERIV_SOURCE,
    });
    // data:health no tocó el bloqueo de la captura.
    expect(await sourceLockHolder(admin, DERIV_SOURCE)).toBe(sessionPid);

    run.stop();
    await eventually(() => socket.requests().some((request) => 'forget_all' in request));
    socket.text(derivMessages.forgetAll(3));
    const report = await run.report;
    expect(report.end).toEqual({ status: 'completed' });
    expect(run.alerts).toEqual([]);
    firstConnection = report.connections[0]?.connection_id ?? null;
    expect(firstConnection).not.toBeNull();
  });

  it('después de la parada, sin escritor vivo, aplica la regla 4: desconectada, backlog 0 y paused, con salida 1', async () => {
    expect(await sourceLockHolder(admin, DERIV_SOURCE)).toBeNull();
    const result = await health();
    const frame = await lastFrame();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeNull();
    expect(result.report).toEqual({
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: 'disconnected',
      execution_mode: 'disabled',
      last_event_time_utc: '2026-03-02T10:00:02.000Z',
      last_observation_id: frame.observation_id,
      last_published_dataset_id: lastDataset,
      last_received_at_utc: frame.received_at_utc,
      open_condition_types: [],
      schema_version: '1.0.0',
      service_health: 'paused',
      source: DERIV_SOURCE,
    });
  });

  it('con otro SourceLock sin latido, que abrió una conexión, aplica la regla 6: la conexión del log y paused; al soltarlo, la regla 4 con el cierre close_not_recorded en memoria', async () => {
    const second = await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE });
    if (second === null) {
      throw new TypeError('No se tomó el bloqueo.');
    }
    try {
      // Un proceso nuevo, antes de su primer latido: su PID no es el del último latido.
      expect(await sourceLockHolder(admin, DERIV_SOURCE)).toBe(second.backendPid);
      expect(await lastHeartbeatPid()).toBe(sessionPid);
      expect(second.backendPid).not.toBe(sessionPid);
      const log = await openLockedSourceLog(second, {
        objects: stores.objects,
        source: DERIV_SOURCE,
        store: stores.sourceLog,
        zlibVersion: process.versions.zlib,
      });
      await clock.advance(1000);
      await log.append(
        connectionOpenedSchema.parse({
          connection_id: uuid(9501),
          event_id: uuid(9502),
          kind: 'connection_opened',
          occurred_at_utc: clock.now(),
          schema_version: '1.0.0',
          source: DERIV_SOURCE,
          supersedes_connection_id: firstConnection,
        }),
      );

      const writing = await health();
      expect(writing.exitCode).toBe(1);
      expect(writing.stderr).toBeNull();
      expect(writing.report).toMatchObject({
        backlog_bytes: 0,
        backlog_count: 0,
        connection_state: 'connected',
        open_condition_types: [],
        service_health: 'paused',
      });
    } finally {
      await second.release();
    }

    await clock.advance(1000);
    const released = await health();
    expect(released.exitCode).toBe(1);
    expect(released.report).toMatchObject({
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: 'disconnected',
      open_condition_types: ['connection_lost'],
      service_health: 'paused',
    });
    // El cierre de la regla 4 nunca se persiste: el log termina en la apertura.
    expect((await durableEvents()).at(-1)).toMatchObject({
      connection_id: uuid(9501),
      kind: 'connection_opened',
    });
  });

  it('con la clave del esquema de fuente con otros bytes, da failed con source_schema_mismatch', async () => {
    // Otro esquema esperado, cuya clave ya tiene otros bytes: el bucket es el de las demás pruebas,
    // y el esquema que guardó la captura no se puede cambiar sin romperlas.
    const expected = new TextEncoder().encode('{"prueba":"esquema esperado por data:health"}');
    const pinned = sha256Hex(expected);
    await stores.objects.putIfAbsent(
      contentKey(pinned),
      new TextEncoder().encode('{"prueba":"otros bytes"}'),
      'application/json',
    );
    const result = await health({
      expected: {
        ...fixture.expected,
        entries_sha256: {
          ...fixture.expected.entries_sha256,
          'ticks_response.schema.json': pinned,
        },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      connection_state: 'disconnected',
      service_health: 'failed',
    });
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"source_schema_mismatch"}');
  });

  it('con un esquema PostgreSQL sin la migración 0004, da failed con migrations_pending', async () => {
    const old = createPool({ ...config.postgres, schema: OLD_SCHEMA });
    try {
      await old.query(
        `CREATE TABLE buoh_schema_migrations (
           name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migration of (await loadMigrations()).slice(0, 3)) {
        await old.query(migration.sql);
        await old.query('INSERT INTO buoh_schema_migrations (name, sha256) VALUES ($1, $2)', [
          migration.name,
          migration.sha256,
        ]);
      }
    } finally {
      await old.end();
    }
    const result = await health({ schema: OLD_SCHEMA });
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      connection_state: 'disconnected',
      service_health: 'failed',
    });
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"migrations_pending"}');
  });

  it('si PostgreSQL o el almacenamiento de objetos no responden, da paused con la alerta data_health_storage_unavailable y el motivo saneado', async () => {
    const postgres = await health({ env: { BUOH_POSTGRES_PORT: '1' } });
    expect(postgres.exitCode).toBe(1);
    expect(postgres.report).toMatchObject({
      connection_state: 'disconnected',
      service_health: 'paused',
    });
    expect(postgres.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"ECONNREFUSED"}',
    );

    const objects = await health({ env: { BUOH_S3_ENDPOINT: 'http://127.0.0.1:9' } });
    expect(objects.exitCode).toBe(1);
    expect(objects.report).toMatchObject({
      connection_state: 'disconnected',
      service_health: 'paused',
    });
    const alert = JSON.parse(objects.stderr ?? '') as Record<string, unknown>;
    expect(Object.keys(alert).sort()).toEqual(['event', 'reason']);
    expect(alert['event']).toBe('data_health_storage_unavailable');
    expect(alert['reason']).toMatch(/^[A-Za-z0-9_.-]{1,64}$/u);
  });
});
