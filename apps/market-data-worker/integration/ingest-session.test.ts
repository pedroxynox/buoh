import { type SourceEvent } from '@buoh/contracts';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
} from '@buoh/domain';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { openSchemaArchive } from '../src/deriv/schema-archive.js';
import {
  contentKey,
  createPool,
  loadConfig,
  migrate,
  ObjectReadError,
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
  type SourceLogStore,
  type WorkerConfig,
} from '../src/index.js';
import { sourceLockHolder } from '../src/postgres/source-lock.js';
import {
  checkStoredCheckpoint,
  liveCheckpointVersionsSha256,
} from '../src/source-log/live-checkpoint.js';
import { START, START_EPOCH, uuid } from '../test/support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';

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
function capture(
  status: IngestionStatusStore = stores.ingestionStatus,
  refused: ReadonlySet<string> = new Set(),
) {
  const sockets: FakeDerivSocket[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const timeline: string[] = [];
  /** Las lecturas del log de un objeto de `refused`, que fallan como si faltara. */
  const refusedReads: string[] = [];
  const objects: ObjectStore = {
    bucket: stores.objects.bucket,
    get: (key, maxBytes) => stores.objects.get(key, maxBytes),
    putIfAbsent: (key, bytes, contentType) => {
      timeline.push(`put:${key}`);
      return stores.objects.putIfAbsent(key, bytes, contentType);
    },
  };
  const logObjects: ObjectStore = {
    bucket: stores.objects.bucket,
    get: (key, maxBytes) => {
      if (refused.has(key)) {
        refusedReads.push(key);
        return Promise.reject(new ObjectReadError('not_found', key));
      }
      return stores.objects.get(key, maxBytes);
    },
    putIfAbsent: (key, bytes, contentType) => stores.objects.putIfAbsent(key, bytes, contentType),
  };
  /** Los IDs que el log buscó en el índice de PostgreSQL (`hasSourceEvent`), en orden. */
  const eventLookups: string[] = [];
  const { sourceLog } = stores;
  const logStore: SourceLogStore = {
    hasSourceEvent: (source, eventId) => {
      eventLookups.push(eventId);
      return sourceLog.hasSourceEvent(source, eventId);
    },
    insertClosedSegment: (segment) => sourceLog.insertClosedSegment(segment),
    insertIndexRow: (row) => sourceLog.insertIndexRow(row),
    insertLiveCheckpoint: (row) => sourceLog.insertLiveCheckpoint(row),
    listClosedSegments: (source, from, to) => sourceLog.listClosedSegments(source, from, to),
    readLiveCheckpoint: (source, versionsSha256, below) =>
      sourceLog.readLiveCheckpoint(source, versionsSha256, below),
    readLogState: (source) => sourceLog.readLogState(source),
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
        objects: logObjects,
        source: DERIV_SOURCE,
        store: logStore,
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
    eventLookups,
    refusedReads,
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

/** El perfil con que deriva la sesión: el de medición con los esquemas sintéticos. */
function sessionProfile() {
  const loaded = openSchemaArchive(fixture.archive, fixture.expected);
  if (loaded.status !== 'loaded') {
    throw new TypeError(loaded.reason);
  }
  return createDerivMeasurementProfile({ schemas: loaded.schemas, symbol: SYMBOL });
}

/** Los puntos de control de la fuente en PostgreSQL, en orden de segmento. */
async function storedCheckpoints() {
  const { rows } = await stores.pool.query<{ checkpoint_jcs: string; segment_index: number }>(
    `SELECT segment_index::int AS segment_index, checkpoint_jcs
       FROM live_derivation_checkpoints WHERE source = $1 ORDER BY segment_index`,
    [DERIV_SOURCE],
  );
  return rows.map((row) => ({
    checkpoint: JSON.parse(row.checkpoint_jcs) as unknown,
    segment_index: row.segment_index,
  }));
}

/**
 * Los que tendría que haber, uno por segmento cerrado del log: el pliegue del log entero, desde el
 * vacío, hasta ese segmento (ADR-0017 §5).
 */
async function foldedCheckpoints() {
  const profile = sessionProfile();
  const log = await SourceEventLog.open({
    objects: stores.objects,
    source: DERIV_SOURCE,
    store: stores.sourceLog,
    zlibVersion: process.versions.zlib,
  });
  const last = log.openSegmentIndex - 1;
  const segments = last < 0 ? [] : await log.readClosedSegments(0, last);
  const closed = last < 0 ? [] : await stores.sourceLog.listClosedSegments(DERIV_SOURCE, 0, last);
  return segments.map((_segment, k) => {
    const events = segments.slice(0, k + 1).flat();
    return {
      checkpoint: buildLiveDerivationCheckpoint({
        event_count: events.length,
        profile,
        raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
        segment_index: k,
        segment_logical_content_sha256: closed[k]?.logical_content_sha256 ?? '',
        state: foldLiveDerivation(emptyLiveDerivationState(), events, profile),
        symbol: SYMBOL,
      }),
      segment_index: k,
    };
  });
}

/** El último punto de control de la fuente, comprobado como lo haría un lector (ADR-0017 §6). */
async function latestCheckpoint() {
  const versions = liveCheckpointVersionsSha256(sessionProfile());
  const candidate = await stores.sourceLog.readLiveCheckpoint(DERIV_SOURCE, versions, null);
  return candidate === null
    ? null
    : checkStoredCheckpoint(candidate, {
        source: DERIV_SOURCE,
        symbol: SYMBOL,
        versions_sha256: versions,
      });
}

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
  it('a un esquema recién creado le faltan las seis migraciones, y después de db:migrate ninguna', () => {
    expect(pendingBefore).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
      '0004_cursor_y_latido.sql',
      '0005_punto_de_control_en_vivo.sql',
      '0006_informes_de_operaciones.sql',
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
    // El punto de control del segmento que cerró la parada: el pliegue del log entero hasta él, y
    // un lector lo acepta con su enlace (ADR-0017 §5 y §6).
    const checkpoints = await storedCheckpoints();
    expect(checkpoints.map((item) => item.segment_index)).toEqual([0]);
    expect(checkpoints).toEqual(await foldedCheckpoints());
    expect(await latestCheckpoint()).toMatchObject({
      checkpoint: { segment_index: 0 },
      status: 'valid',
    });
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
    // Partió del punto de control de la primera y escribió el del segmento que cerró al parar.
    const checkpoints = await storedCheckpoints();
    expect(checkpoints.map((item) => item.segment_index)).toEqual([0, 1]);
    expect(checkpoints).toEqual(await foldedCheckpoints());
    expect(await latestCheckpoint()).toMatchObject({
      checkpoint: { segment_index: 1 },
      status: 'valid',
    });
    expect(run.alerts).toEqual([]);
  });

  it('una tercera ejecución parte del último punto de control: arranca, busca el cursor en el índice, repara y vigila sin leer ningún objeto de los segmentos ya cerrados', async () => {
    await clock.advance(10_000);
    const log = await SourceEventLog.open({
      objects: stores.objects,
      source: DERIV_SOURCE,
      store: stores.sourceLog,
      zlibVersion: process.versions.zlib,
    });
    const closed = await stores.sourceLog.listClosedSegments(
      DERIV_SOURCE,
      0,
      log.openSegmentIndex - 1,
    );
    expect(closed.map((segment) => segment.segment_index)).toEqual([0, 1]);
    const cursor = (await cursorRows()).at(-1)?.['last_durable_source_event_id'];
    expect(typeof cursor).toBe('string');
    // Leer cualquiera de esos objetos fallaría como si faltara: `log_not_derivable`.
    const run = capture(
      stores.ingestionStatus,
      new Set(closed.map((segment) => contentKey(segment.object_bytes_sha256))),
    );
    await eventually(() => run.sockets.length === 1);
    const [socket] = run.sockets;
    if (socket === undefined) {
      throw new TypeError('Falta el socket.');
    }
    socket.open();
    await eventually(() => socket.requests().some((request) => 'active_symbols' in request));
    run.stop();
    const report = await run.report;

    expect(report.end).toEqual({ status: 'completed' });
    expect(run.refusedReads).toEqual([]);
    // El arranque buscó en el índice el evento del último cursor, y lo encontró.
    expect(run.eventLookups).toEqual([cursor]);
    // Escribió el punto de control del segmento que cerró al parar, el pliegue del log entero.
    const checkpoints = await storedCheckpoints();
    expect(checkpoints.map((item) => item.segment_index)).toEqual([0, 1, 2]);
    expect(checkpoints).toEqual(await foldedCheckpoints());
    expect(run.alerts).toEqual([]);
  });
});
