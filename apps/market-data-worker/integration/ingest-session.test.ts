import { type SourceEvent } from '@buoh/contracts';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  createPool,
  loadConfig,
  migrate,
  openLockedSourceLog,
  openStores,
  pendingMigrations,
  PostgresSessionLockProvider,
  runIngest,
  SourceEventLog,
  type IngestionStatusStore,
  type IngestReport,
  type ObjectStore,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';
import { sourceLockHolder } from '../test/support/pg-locks.js';

/**
 * La captura viva continua (`runIngest`, ADR-0015 §7) contra PostgreSQL y S3-compatible locales: los
 * almacenes reales, el bloqueo de PostgreSQL, el log protegido por él, el cursor y el latido. La
 * sesión no sale a la red: su fábrica de sockets es falsa y sus esquemas son sintéticos (ADR-0015
 * §11). Reloj manual e IDs secuenciales; las esperas de la prueba usan el reloj real, porque los
 * almacenes responden con su tiempo. Esquema PostgreSQL propio, recreado en cada ejecución.
 */
const SCHEMA = 'buoh_integration_ingest';
const SYMBOL = 'SYNTH_100';
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
let pendingBefore: string[];
let pendingAfter: string[];

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  pendingBefore = await pendingMigrations(stores.pool);
  await migrate(stores.pool);
  pendingAfter = await pendingMigrations(stores.pool);
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
 * Una captura sobre los almacenes reales, ya arrancada; `stop` es la señal de parada. `timeline`
 * anota en orden cada escritura en el bucket que pide la sesión, con su clave, y cada `connect`: el
 * bucket guarda los objetos de ejecuciones anteriores, así que la prueba ve aquí lo que escribe esta.
 */
function capture(status: IngestionStatusStore = stores.ingestionStatus) {
  const sockets: FakeDerivSocket[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const timeline: string[] = [];
  const objects: ObjectStore = {
    bucket: stores.objects.bucket,
    get: (key, maxBytes) => stores.objects.get(key, maxBytes),
    putIfAbsent: (key, bytes, contentType) => {
      timeline.push(`put:${key}`);
      return stores.objects.putIfAbsent(key, bytes, contentType);
    },
  };
  let signal: (() => void) | null = null;
  const report: Promise<IngestReport> = runIngest({
    alert: (payload) => alerts.push(payload),
    connect: (input) => {
      timeline.push('connect');
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
    stores: { ...stores, ingestionStatus: status, objects },
    symbol: SYMBOL,
  });
  return {
    alerts,
    report,
    sockets,
    stop: () => {
      signal?.();
    },
    timeline,
  };
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

/** Las filas de `ingestion_cursors` del símbolo, en orden de versión. */
async function cursorRows() {
  const { rows } = await stores.pool.query<Record<string, unknown>>(
    `SELECT version, connection_id::text AS connection_id,
            active_segment_index::int AS active_segment_index,
            source_event_count::int AS source_event_count,
            last_durable_source_event_id::text AS last_durable_source_event_id,
            last_durable_observation_id::text AS last_durable_observation_id,
            high_watermark_event_time_utc, updated_at_utc
       FROM ingestion_cursors WHERE source = $1 AND symbol = $2 ORDER BY version`,
    [DERIV_SOURCE, SYMBOL],
  );
  return rows;
}

/** Las filas de `ingestion_heartbeats` de la fuente, en el orden en que se escribieron. */
async function heartbeatRows() {
  const { rows } = await stores.pool.query<Record<string, unknown>>(
    `SELECT run_id::text AS run_id, connection_state, pg_backend_pid,
            backlog_count::int AS backlog_count, backlog_bytes::int AS backlog_bytes,
            observed_at_utc
       FROM ingestion_heartbeats WHERE source = $1 ORDER BY write_order`,
    [DERIV_SOURCE],
  );
  return rows;
}

/** El ID de un source event en el índice: el `observation_id` de un frame y el `event_id` de los demás. */
const indexId = (event: SourceEvent | undefined): string | undefined =>
  event?.kind === 'raw_source_frame' ? event.observation_id : event?.event_id;

/** El almacén del cursor y del latido de PostgreSQL, que anota lo que lee y lo que obtiene. */
function recording(inner: IngestionStatusStore) {
  const reads: unknown[] = [];
  const store: IngestionStatusStore = {
    appendCursor: (cursor) => inner.appendCursor(cursor),
    appendHeartbeat: (heartbeat) => inner.appendHeartbeat(heartbeat),
    cursorSymbols: async (source) => {
      const symbols = await inner.cursorSymbols(source);
      reads.push({ cursorSymbols: symbols });
      return symbols;
    },
    latestCursor: async (source, symbol) => {
      const latest = await inner.latestCursor(source, symbol);
      reads.push({ latestCursor: latest });
      return latest;
    },
    latestHeartbeat: (source) => inner.latestHeartbeat(source),
  };
  return { reads, store };
}

describe('pendingMigrations contra PostgreSQL', () => {
  it('a un esquema recién creado le faltan las cuatro migraciones, y después de db:migrate ninguna', () => {
    expect(pendingBefore).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
      '0004_cursor_y_latido.sql',
    ]);
    expect(pendingAfter).toEqual([]);
  });
});

describe('runIngest sobre PostgreSQL y S3-compatible (ADR-0015 §6 y §7)', () => {
  let firstConnection: string | null = null;

  it('una conexión con ticks y una parada pedida dejan en PostgreSQL los cursores y los latidos, y en el bucket el esquema de fuente', async () => {
    const run = capture();
    await eventually(() => run.sockets.length === 1);
    // Antes de la primera conexión, esta ejecución guardó el esquema de fuente con la clave de su
    // SHA-256 fijado, y el bucket tiene sus bytes.
    const schemaKey = contentKey(fixture.expected.entries_sha256['ticks_response.schema.json']);
    expect(run.timeline).toEqual([`put:${schemaKey}`, 'connect']);
    const entry = fixture.entries['ticks_response.schema.json'];
    expect(await stores.objects.get(schemaKey, entry.byteLength)).toEqual(entry);
    const pid = await sourceLockHolder(admin, DERIV_SOURCE);
    expect(pid).not.toBeNull();

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
    run.stop();
    await eventually(() => socket.requests().some((request) => 'forget_all' in request));
    socket.text(derivMessages.forgetAll(3));
    const report = await run.report;

    expect(report).toMatchObject({
      end: { status: 'completed' },
      recoveries: [],
      stopped_for_retention: false,
      waits_ms: [],
    });
    expect(report.connections).toHaveLength(1);
    const [connection] = report.connections;
    expect(connection?.closure).toEqual({
      closure_type: 'requested',
      persisted: true,
      reason: 'requested',
    });
    firstConnection = connection?.connection_id ?? null;
    expect(firstConnection).not.toBeNull();
    // El bloqueo quedó suelto.
    expect(await sourceLockHolder(admin, DERIV_SOURCE)).toBeNull();

    const events = await durableEvents();
    expect(events.map((event) => event.kind)).toEqual([
      'connection_opened',
      'raw_source_frame',
      'raw_source_frame',
      'raw_source_frame',
      'raw_source_frame',
      'connection_closed',
    ]);
    const closed = {
      active_segment_index: 0,
      connection_id: firstConnection,
      high_watermark_event_time_utc: '2026-03-02T10:00:02.000Z',
      last_durable_observation_id: indexId(
        events.findLast((event) => event.kind === 'raw_source_frame'),
      ),
      last_durable_source_event_id: indexId(events.at(-1)),
      source_event_count: 6,
      updated_at_utc: '2026-03-02T10:00:02.200Z',
    };
    // El del cierre pedido y el del final, con el segmento siguiente como abierto.
    expect(await cursorRows()).toEqual([
      { ...closed, version: 1 },
      { ...closed, active_segment_index: 1, version: 2 },
    ]);
    const beat = (connectionState: string, observedAt: string) => ({
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: connectionState,
      observed_at_utc: observedAt,
      pg_backend_pid: pid,
      run_id: uuid(1),
    });
    expect(await heartbeatRows()).toEqual([
      beat('connecting', START),
      beat('connecting', START),
      beat('connected', START),
      beat('disconnected', '2026-03-02T10:00:02.200Z'),
    ]);
    expect(run.alerts).toEqual([]);
  });

  it('una segunda ejecución lee el cursor al arrancar, comprueba el log con él y supera la conexión de la primera', async () => {
    await clock.advance(10_000);
    const { reads, store } = recording(stores.ingestionStatus);
    const run = capture(store);
    await eventually(() => run.sockets.length === 1);
    expect(reads).toEqual([
      { cursorSymbols: [SYMBOL] },
      {
        latestCursor: {
          cursor: expect.objectContaining({
            active_segment_index: 1,
            connection_id: firstConnection,
            source_event_count: 6,
          }) as unknown,
          version: 2,
        },
      },
    ]);

    const [socket] = run.sockets;
    if (socket === undefined) {
      throw new TypeError('Falta el socket.');
    }
    socket.open();
    await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
    // Sin suscripción no hay nada que olvidar: la parada cierra enseguida con requested.
    run.stop();
    const report = await run.report;

    expect(report.end).toEqual({ status: 'completed' });
    const events = await durableEvents();
    const opened = events.filter((event) => event.kind === 'connection_opened');
    expect(opened.at(-1)).toMatchObject({ supersedes_connection_id: firstConnection });
    const second = report.connections[0]?.connection_id;
    expect(opened.at(-1)?.connection_id).toBe(second);
    // Los cursores siguen la numeración de la fuente y el símbolo: 3 tras el cierre y 4 al final.
    const cursors = await cursorRows();
    expect(
      cursors.map((row) => [row['version'], row['connection_id'], row['source_event_count']]),
    ).toEqual([
      [1, firstConnection, 6],
      [2, firstConnection, 6],
      [3, second, 8],
      [4, second, 8],
    ]);
    // Los latidos de la segunda ejecución llevan otra ejecución.
    const runs = (await heartbeatRows()).map((row) => row['run_id']);
    expect(new Set(runs).size).toBe(2);
    expect(runs.at(-1)).not.toBe(uuid(1));
  });
});
