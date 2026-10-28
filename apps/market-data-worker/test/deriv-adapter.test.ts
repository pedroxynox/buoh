import { TextDecoder } from 'node:util';

import {
  canonicalJson,
  sha256Hex,
  sourceEventSchema,
  type ConnectionClosed,
  type RawSourceFrame,
  type SourceEvent,
} from '@buoh/contracts';
import {
  createCatalogResponseSchema,
  deriveCatalogSnapshot,
  publicationThresholds,
  type InvalidFrameReason,
  type UnflaggedTick,
} from '@buoh/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDerivAdapter, type DerivAdapterResult } from '../src/deriv/adapter.js';
import { KEEPALIVE_INTERVAL_MS, REQUEST_TIMEOUT_MS } from '../src/deriv/connection.js';
import {
  createDerivMeasurementProfile,
  DERIV_CONNECTOR_VERSION,
  DERIV_PUBLIC_ENDPOINT,
  DERIV_SOURCE,
} from '../src/deriv/profile.js';
import { encodeRequest } from '../src/deriv/requests.js';
import {
  openSchemaArchive,
  type DerivSchemaSet,
  type SchemaEntryName,
} from '../src/deriv/schema-archive.js';
import { CONNECT_TIMEOUT_MS, declaredMessageLength } from '../src/deriv/socket.js';
import {
  buildRawSourceFrame,
  contentKey,
  OperationalRegistry,
  RawFirstIngestor,
  SourceEventLog,
  type OperationalAlert,
} from '../src/index.js';
import {
  catalogEntry,
  derivMessages,
  FakeDerivSocket,
  flush,
  ManualClock,
  SYNTH_50,
  SYNTH_100,
  syntheticSchemaArchive,
} from './support/deriv-fixtures.js';
import {
  MemoryCatalogStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemoryRequestedResponseIncidentStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';

// Adaptador público de Deriv (F1-SOURCE-001, F1-CATALOG-001; ADR-0004 §2, §7 y §12; ADR-0012 §1 a
// §8): socket falso, reloj y temporizador manuales, IDs secuenciales y esquemas sintéticos. Ninguna
// prueba usa la red, el reloj real ni aleatoriedad.
const START = '2026-03-02T10:00:00.000Z';
const START_EPOCH = Date.parse(START) / 1000;
const MIB = 1_048_576;

function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida.');
  });
  vi.stubGlobal('WebSocket', function forbidden() {
    throw new Error('El WebSocket global no está permitido.');
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Varias vueltas del bucle: la descarga sintética lee su cuerpo en varios pasos. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flush();
  }
}

interface HarnessOptions {
  readonly catalog?: MemoryCatalogStore;
  /** El socket falso avisa del cierre solo con `finishClose`, como `ws`. */
  readonly deferClose?: boolean;
  /** `connect` lanza este error en lugar de devolver un socket. */
  readonly connectError?: Error;
  readonly durationMs?: number;
  readonly expectedSha256?: string;
  readonly fetch?: typeof fetch;
  readonly operational?: MemoryOperationalStore;
  /** Esquemas que cambian en el archivo sintético (`syntheticSchemaArchive`). */
  readonly schemaOverrides?: Readonly<Partial<Record<SchemaEntryName, unknown>>>;
  readonly serverTime?: boolean;
  readonly symbol?: string;
}

async function harness(options: HarnessOptions = {}) {
  forbidAmbientEffects();
  const clock = new ManualClock(START);
  let sequence = 0;
  const nextId = () => uuid((sequence += 1));
  const objects = new MemoryObjectStore();
  const sourceLog = new MemorySourceLogStore();
  const operational = options.operational ?? new MemoryOperationalStore();
  const catalog = options.catalog ?? new MemoryCatalogStore();
  const requested = new MemoryRequestedResponseIncidentStore();
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const ticks: UnflaggedTick[] = [];
  const invalid: { observation_id: string; reason: InvalidFrameReason }[] = [];
  const nonTick: { msg_type: string; observation_id: string }[] = [];
  const sockets: FakeDerivSocket[] = [];
  const fixture = syntheticSchemaArchive(options.schemaOverrides);
  const fetchCalls: string[] = [];
  const openLog = () =>
    SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: DERIV_SOURCE,
    store: operational,
  });
  const fakeFetch = ((url: string | URL | Request) => {
    fetchCalls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    return Promise.resolve(new Response(fixture.archive, { status: 200 }));
  }) as typeof fetch;
  const run = runDerivAdapter({
    alert: (payload) => alerts.push(payload),
    catalog,
    connect: (input) => {
      if (options.connectError !== undefined) {
        throw options.connectError;
      }
      const socket = new FakeDerivSocket({ ...input, deferClose: options.deferClose ?? false });
      sockets.push(socket);
      return socket;
    },
    durationMs: options.durationMs ?? 30_000,
    expected:
      options.expectedSha256 === undefined
        ? fixture.expected
        : { ...fixture.expected, archive_sha256: options.expectedSha256 },
    fetch: options.fetch ?? fakeFetch,
    log: await openLog(),
    nextId,
    now: clock.now,
    registry,
    reopenLog: openLog,
    requestedResponses: requested,
    scheduler: clock.scheduler,
    schemaUrl: 'https://schemas.invalid/schemas.zip',
    serverTime: options.serverTime ?? false,
    sink: {
      invalidFrame: (item) => invalid.push(item),
      nonTickFrame: (item) => nonTick.push(item),
      tick: (tick) => ticks.push(tick),
    },
    symbol: options.symbol ?? 'SYNTH_100',
  });
  await settle();

  /** Socket de la conexión; falla si el adaptador no conectó. */
  const socket = (): FakeDerivSocket => {
    const [only] = sockets;
    if (only === undefined || sockets.length !== 1) {
      throw new TypeError(`Se esperaba un socket, hay ${String(sockets.length)}.`);
    }
    return only;
  };

  /** Source events del log, leídos de sus objetos. */
  const events = async (): Promise<SourceEvent[]> =>
    Promise.all(
      sourceLog.rows.map(async (row) =>
        sourceEventSchema.parse(
          JSON.parse(
            decoder.decode(await objects.get(contentKey(row.object_sha256), row.byte_length)),
          ),
        ),
      ),
    );

  const frames = async (): Promise<RawSourceFrame[]> =>
    (await events()).filter((event) => event.kind === 'raw_source_frame');

  const lastClosed = async (): Promise<ConnectionClosed> => {
    const last = (await events()).at(-1);
    if (last?.kind !== 'connection_closed') {
      throw new TypeError(`El último evento es ${String(last?.kind)}.`);
    }
    return last;
  };

  /** Abre la conexión y responde el catálogo: deja la suscripción pedida con `req_id` 2. */
  const openAndListCatalog = async (entries?: readonly unknown[]) => {
    socket().open();
    await settle();
    socket().text(derivMessages.catalog(1, entries));
    await settle();
  };

  return {
    alerts,
    catalog,
    clock,
    events,
    fetchCalls,
    fixture,
    frames,
    invalid,
    lastClosed,
    nonTick,
    objects,
    openAndListCatalog,
    operational,
    registry,
    requested,
    run,
    socket,
    sockets,
    sourceLog,
    ticks,
  };
}

/** El conjunto de esquemas sintético ya abierto, para armar lo que una prueba espera. */
function syntheticSchemas(): DerivSchemaSet {
  const fixture = syntheticSchemaArchive();
  const result = openSchemaArchive(fixture.archive, fixture.expected);
  if (result.status !== 'loaded') {
    throw new TypeError(`Esquemas sintéticos inválidos: ${result.reason}`);
  }
  return result.schemas;
}

describe('runDerivAdapter: recorrido completo', () => {
  it('pide catálogo, se suscribe, mide la hora, pide forget_all y cierra como requested', async () => {
    const run = await harness({ serverTime: true });
    const socket = run.socket();
    expect(run.fetchCalls).toEqual(['https://schemas.invalid/schemas.zip']);
    expect(socket.url).toBe(DERIV_PUBLIC_ENDPOINT);

    await run.openAndListCatalog();
    await run.clock.advance(1000);
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    await run.clock.advance(500);
    socket.text(derivMessages.time(3, START_EPOCH + 1));
    await settle();
    await run.clock.advance(30_000);
    socket.text(derivMessages.forgetAll(4));
    const result: DerivAdapterResult = await run.run;

    // Peticiones en JCS, con `req_id` creciente desde 1 en la conexión (ADR-0012 §5).
    expect(socket.sent).toEqual([
      '{"active_symbols":"brief","req_id":1}',
      '{"req_id":2,"subscribe":1,"ticks":"SYNTH_100"}',
      '{"req_id":3,"time":1}',
      '{"forget_all":"ticks","req_id":4}',
    ]);
    expect(socket.ended).toBe('close');

    const events = await run.events();
    expect(events.map((event) => event.kind)).toEqual([
      'connection_opened',
      'raw_source_frame',
      'raw_source_frame',
      'raw_source_frame',
      'raw_source_frame',
      'connection_closed',
    ]);
    const [opened] = events;
    if (opened?.kind !== 'connection_opened') {
      throw new TypeError('Falta ConnectionOpened.');
    }
    expect(opened).toMatchObject({
      occurred_at_utc: START,
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    });
    const frames = await run.frames();
    expect(frames.map((frame) => frame.payload_utf8)).toEqual([
      derivMessages.catalog(1),
      derivMessages.tick(2, START_EPOCH),
      derivMessages.time(3, START_EPOCH + 1),
      derivMessages.forgetAll(4),
    ]);
    expect(frames.map((frame) => frame.received_at_utc)).toEqual([
      START,
      '2026-03-02T10:00:01.000Z',
      '2026-03-02T10:00:01.500Z',
      '2026-03-02T10:00:31.500Z',
    ]);
    for (const frame of frames) {
      expect(frame).toMatchObject({
        connection_id: opened.connection_id,
        connector_version: DERIV_CONNECTOR_VERSION,
        source: DERIV_SOURCE,
      });
    }
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'requested',
      connection_id: opened.connection_id,
      occurred_at_utc: '2026-03-02T10:00:31.500Z',
      reason: 'requested',
    });

    // Catálogo: versión 1 desde el frame durable, sin traducir nombres.
    const [catalogFrame] = frames;
    expect(run.catalog.versions).toHaveLength(1);
    expect(run.catalog.versions[0]?.version).toBe(1);
    const snapshot = run.catalog.versions[0]?.snapshot;
    expect(snapshot).toMatchObject({
      connector_version: DERIV_CONNECTOR_VERSION,
      entry_count: 2,
      observation_id: catalogFrame?.observation_id,
      raw_payload_sha256: catalogFrame?.raw_payload_sha256,
      source: DERIV_SOURCE,
      source_schema_release: 'synthetic-deriv-1',
    });
    expect(snapshot?.entries.map((entry) => entry.underlying_symbol_name)).toEqual([
      'Synthetic 100 Index',
      'Synthetic 50 Index',
    ]);

    // El tick pasa por las reglas 2.0.0 con el perfil de medición.
    expect(run.ticks).toHaveLength(1);
    expect(run.ticks[0]).toMatchObject({
      event_time_utc: START,
      observation_id: frames[1]?.observation_id,
      quote_decimal: '100.25',
      symbol: 'SYNTH_100',
    });
    expect(run.invalid).toEqual([]);
    expect(run.requested.incidents).toEqual([]);
    expect(run.registry.openConditions()).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);

    expect(result).toEqual({
      catalog: { snapshot, status: 'created', version: 1 },
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connection_id: opened.connection_id,
      end: { status: 'completed' },
      schemas: {
        archive_sha256: run.fixture.expected.archive_sha256,
        release: 'synthetic-deriv-1',
      },
      // Recepción 10:00:01.500 menos la hora del servidor 10:00:01.
      server_time_offset_ms: 500,
      subscription_id: 'sub-1',
    });
  });
});

describe('runDerivAdapter: keepalive y tiempos de espera (ADR-0012 §5)', () => {
  it('envía ping cada 45 s y cierra con timeout si uno no responde en 15 s', async () => {
    const run = await harness({ durationMs: 600_000 });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();

    // El keepalive cuenta desde la apertura durable.
    await run.clock.advance(KEEPALIVE_INTERVAL_MS - 1);
    expect(socket.requests()).toHaveLength(2);
    await run.clock.advance(1);
    expect(socket.requests()[2]).toEqual({ ping: 1, req_id: 3 });
    socket.text(derivMessages.ping(3));
    await settle();

    await run.clock.advance(KEEPALIVE_INTERVAL_MS);
    expect(socket.requests()[3]).toEqual({ ping: 1, req_id: 4 });
    await run.clock.advance(REQUEST_TIMEOUT_MS - 1);
    expect(socket.ended).toBeNull();
    await run.clock.advance(1);
    const result = await run.run;

    expect(socket.ended).toBe('terminate');
    expect(result.end).toEqual({
      detail: 'ping',
      reason: 'request_timeout',
      status: 'disconnected',
    });
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'timeout',
      occurred_at_utc: '2026-03-02T10:01:45.000Z',
      reason: 'ping_timeout',
    });
    expect(result.closure).toEqual({
      closure_type: 'timeout',
      persisted: true,
      reason: 'ping_timeout',
    });
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('una respuesta a ping con error cuenta como keepalive sin respuesta y deja su incidencia', async () => {
    const run = await harness({ durationMs: 600_000 });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    await run.clock.advance(KEEPALIVE_INTERVAL_MS);
    socket.text(derivMessages.error(3, 'ping', { ping: 1 }));
    const result = await run.run;

    const pingFrame = (await run.frames()).at(-1);
    expect(result.end).toEqual({ detail: null, reason: 'ping_invalid', status: 'disconnected' });
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'timeout',
      reason: 'ping_invalid',
    });
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: {
          raw_payload_sha256: pingFrame?.raw_payload_sha256,
          reason: 'source_error_response',
        },
        incident_type: 'invalid_source_frame',
        observed_at_utc: pingFrame?.received_at_utc,
        observed_ref: pingFrame?.observation_id,
        quality_rule_version: '2.0.0',
        related_refs: [],
        schema_version: '2.0.0',
        severity: 'error',
        source: DERIV_SOURCE,
        symbol: null,
      }),
    ]);
  });

  it('una petición vencida cierra con timeout aunque llegue otra respuesta con su req_id', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    // Mismo req_id con otro msg_type, y el catálogo con otro req_id: ninguno empareja.
    socket.text(derivMessages.ping(1));
    socket.text(derivMessages.catalog(9));
    await settle();
    await run.clock.advance(REQUEST_TIMEOUT_MS);
    const result = await run.run;

    expect(result.end).toEqual({
      detail: 'active_symbols',
      reason: 'request_timeout',
      status: 'disconnected',
    });
    expect(result.catalog).toBeNull();
    expect(run.catalog.versions).toEqual([]);
    // Raw primero: los dos frames quedan en el log aunque no emparejen.
    expect(await run.frames()).toHaveLength(2);
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: [],
      closure_type: 'timeout',
      reason: 'active_symbols_timeout',
    });
  });

  it('sin apertura en 10 s corta el socket y no escribe nada', async () => {
    const run = await harness();
    await run.clock.advance(CONNECT_TIMEOUT_MS);
    const result = await run.run;

    expect(run.socket().ended).toBe('terminate');
    expect(result).toMatchObject({
      closure: null,
      connection_id: null,
      end: { detail: null, reason: 'connect_timeout', status: 'disconnected' },
    });
    expect(run.sourceLog.rows).toEqual([]);
  });
});

describe('runDerivAdapter: respuestas pedidas (ADR-0012 §5 y §6)', () => {
  it('time y forget_all con error dejan su incidencia, y el cierre previsto sigue', async () => {
    const run = await harness({ serverTime: true });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    socket.text(derivMessages.error(3, 'time', { time: 1 }));
    await settle();
    await run.clock.advance(30_000);
    socket.text(derivMessages.error(4, 'forget_all', { forget_all: 'ticks' }));
    const result = await run.run;

    const frames = await run.frames();
    expect(run.requested.incidents.map((incident) => incident.observed_ref)).toEqual([
      frames[2]?.observation_id,
      frames[3]?.observation_id,
    ]);
    expect(run.requested.incidents.map((incident) => incident.evidence)).toEqual([
      { raw_payload_sha256: frames[2]?.raw_payload_sha256, reason: 'source_error_response' },
      { raw_payload_sha256: frames[3]?.raw_payload_sha256, reason: 'source_error_response' },
    ]);
    // Las reglas 2.0.0 no miran las respuestas declaradas: ninguna llega al sink como inválida.
    expect(run.invalid).toEqual([]);
    expect(result.server_time_offset_ms).toBeNull();
    expect(result.end).toEqual({ status: 'completed' });
    expect(await run.lastClosed()).toMatchObject({ closure_type: 'requested' });
  });

  it('una respuesta que no cumple su esquema deja schema_validation_failed', async () => {
    const run = await harness({ serverTime: true });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    socket.text('{"echo_req":{"req_id":3,"time":1},"msg_type":"time","req_id":3,"time":"tarde"}');
    await settle();
    socket.emit({ code: 1000, kind: 'closed' });
    await run.run;

    expect(run.requested.incidents.map((incident) => incident.evidence)).toEqual([
      expect.objectContaining({ reason: 'schema_validation_failed' }),
    ]);
  });

  it('si la incidencia no se puede guardar, deja una alerta saneada y sigue', async () => {
    const run = await harness({ serverTime: true });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    run.requested.failAppend = true;
    socket.text(derivMessages.error(3, 'time', { time: 1 }));
    await settle();
    await run.clock.advance(30_000);
    socket.text(derivMessages.forgetAll(4));
    const result = await run.run;

    const timeFrame = (await run.frames())[2];
    expect(run.alerts).toEqual([
      {
        event: 'requested_response_incident_unavailable',
        incident_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string,
        observed_ref: timeFrame?.observation_id,
        reason: 'ECONNREFUSED',
      },
    ]);
    expect(result.end).toEqual({ status: 'completed' });
  });

  it('una suscripción rechazada termina con failed y cierre requested, sin símbolos afectados', async () => {
    const run = await harness();
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.error(2, 'ticks', { subscribe: 1, ticks: 'SYNTH_100' }));
    const result = await run.run;

    const frames = await run.frames();
    // `ticks` no está en non_tick_msg_types: las reglas 2.0.0 ya lo registran como inválido.
    expect(run.invalid).toEqual([
      { observation_id: frames[1]?.observation_id, reason: 'source_error_response' },
    ]);
    expect(run.requested.incidents).toEqual([]);
    expect(result.end).toEqual({ detail: null, reason: 'subscription_failed', status: 'failed' });
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: [],
      closure_type: 'requested',
      reason: 'subscription_failed',
    });
    expect(socket.ended).toBe('close');
  });

  it('interpreta una respuesta solo si su frame quedó durable', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    run.objects.armNextPutFailure('synthetic_put_failure');
    socket.text(derivMessages.catalog(1));
    const result = await run.run;

    expect(run.catalog.versions).toEqual([]);
    expect(socket.requests()).toHaveLength(1);
    expect(socket.ended).toBe('terminate');
    expect(result.end).toEqual({
      detail: 'raw_object_write',
      reason: 'persistence_unavailable',
      status: 'paused',
    });
    // El log fallido no admite el cierre: queda solo la condición del registro operativo.
    expect(result.closure).toEqual({
      closure_type: 'transport_error',
      persisted: false,
      reason: 'persistence_unavailable',
    });
    expect(run.registry.openConditionTypes()).toEqual(['persistence_unavailable']);
  });

  it('si el log falla después de un cierre remoto, la salida es paused por persistencia', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    run.objects.armNextPutFailure('synthetic_put_failure');
    socket.text('{"msg_type":"tick","n":1}');
    socket.emit({ code: 1000, kind: 'closed' });
    const result = await run.run;

    expect(result.closure).toEqual({
      closure_type: 'remote',
      persisted: false,
      reason: 'close_code_1000',
    });
    expect(result.end).toEqual({
      detail: null,
      reason: 'persistence_unavailable',
      status: 'paused',
    });
  });
});

describe('runDerivAdapter: catálogo (F1-CATALOG-001, ADR-0012 §7)', () => {
  it('sin snapshot válido no se suscribe: incidencia, ninguna versión y salud failed', async () => {
    const run = await harness();
    await run.openAndListCatalog([]);
    const result = await run.run;

    const [catalogFrame] = await run.frames();
    expect(run.catalog.versions).toEqual([]);
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: catalogFrame?.raw_payload_sha256, reason: 'catalog_empty' },
        observed_ref: catalogFrame?.observation_id,
        symbol: null,
      }),
    ]);
    expect(run.socket().requests()).toEqual([{ active_symbols: 'brief', req_id: 1 }]);
    expect(result.end).toEqual({
      detail: 'catalog_empty',
      reason: 'catalog_invalid',
      status: 'failed',
    });
    expect(result.catalog).toBeNull();
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: [],
      closure_type: 'requested',
      reason: 'catalog_invalid',
    });
  });

  it('un catálogo inválido no reemplaza la última versión válida, que sigue vigente', async () => {
    const schemas = syntheticSchemas();
    const previous = deriveCatalogSnapshot(
      buildRawSourceFrame(
        {
          connection_id: uuid(900),
          observation_id: uuid(901),
          payload_utf8: derivMessages.catalog(1, [SYNTH_100]),
          received_at_utc: '2026-03-01T00:00:00.000Z',
        },
        createDerivMeasurementProfile({ schemas, symbol: 'SYNTH_100' }),
      ),
      createCatalogResponseSchema({
        source_schema_bytes: schemas.schema('active_symbols', 'response').bytes,
        source_schema_release: schemas.release,
      }),
    );
    if (!previous.ok) {
      throw new TypeError(previous.reason);
    }
    const catalog = new MemoryCatalogStore();
    await catalog.record(previous.snapshot);

    const run = await harness({ catalog });
    run.socket().open();
    await settle();
    run.socket().text(derivMessages.error(1, 'active_symbols', { active_symbols: 'brief' }));
    await settle();

    expect(run.catalog.versions).toHaveLength(1);
    expect(run.requested.incidents.map((incident) => incident.evidence)).toEqual([
      expect.objectContaining({ reason: 'source_error_response' }),
    ]);
    expect(run.socket().requests()[1]).toEqual({ req_id: 2, subscribe: 1, ticks: 'SYNTH_100' });
    run.socket().emit({ code: 1000, kind: 'closed' });
    const result = await run.run;
    expect(result.catalog).toEqual({ snapshot: previous.snapshot, status: 'previous', version: 1 });
  });

  it('un contenido distinto crea versión nueva; trade_count no cuenta como cambio', async () => {
    const catalog = new MemoryCatalogStore();
    for (const entries of [
      [SYNTH_100, SYNTH_50],
      [catalogEntry('SYNTH_100', 'Synthetic 100 Index', 99), SYNTH_50],
      [SYNTH_100, { ...SYNTH_50, exchange_is_open: 0 }],
    ]) {
      const run = await harness({ catalog });
      await run.openAndListCatalog(entries);
      run.socket().emit({ code: 1000, kind: 'closed' });
      await run.run;
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    expect(catalog.versions.map((item) => item.version)).toEqual([1, 2]);
    expect(catalog.versions[1]?.snapshot.entries[1]?.exchange_is_open).toBe(0);
  });

  it('si el símbolo no está en el catálogo no se suscribe y termina con failed', async () => {
    const run = await harness();
    await run.openAndListCatalog([SYNTH_50]);
    const result = await run.run;

    expect(run.catalog.versions).toHaveLength(1);
    expect(run.socket().requests()).toHaveLength(1);
    expect(result.end).toEqual({
      detail: null,
      reason: 'symbol_not_in_catalog',
      status: 'failed',
    });
    expect(await run.lastClosed()).toMatchObject({ closure_type: 'requested' });
  });

  it('si el almacén del catálogo no responde, no se suscribe y pausa', async () => {
    const catalog = new MemoryCatalogStore();
    catalog.failNext = true;
    const run = await harness({ catalog });
    await run.openAndListCatalog();
    const result = await run.run;

    expect(run.socket().requests()).toHaveLength(1);
    expect(result.end).toEqual({
      detail: 'ECONNREFUSED',
      reason: 'catalog_store_unavailable',
      status: 'paused',
    });
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'requested',
      reason: 'catalog_store_unavailable',
    });
  });
});

/** Bloquea las escrituras de objetos hasta `release`, para que los frames esperen en la cola. */
function holdObjectWrites(objects: MemoryObjectStore) {
  const gate = Promise.withResolvers<undefined>();
  const original = objects.putIfAbsent.bind(objects);
  vi.spyOn(objects, 'putIfAbsent').mockImplementation(async (key, bytes) => {
    await gate.promise;
    return original(key, bytes);
  });
  return {
    release: () => {
      gate.resolve(undefined);
    },
  };
}

describe('runDerivAdapter: cola en memoria y pausa desde el transporte (ADR-0012 §4)', () => {
  it('el frame 1001 en memoria no cabe: vacía la cola, corta, registra y cierra con transport_error', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    const hold = holdObjectWrites(run.objects);

    // El primero queda en curso; con él, 1000 frames en memoria.
    for (let index = 0; index < 1000; index += 1) {
      socket.text(`{"msg_type":"tick","n":${String(index)}}`);
    }
    expect(socket.ended).toBeNull();
    socket.text('{"msg_type":"tick","n":"no cabe"}');
    expect(socket.ended).toBe('terminate');
    // Después del límite no se acepta nada más.
    socket.text('{"msg_type":"tick","n":"tarde"}');
    hold.release();
    const result = await run.run;

    const events = await run.events();
    expect(events.map((event) => event.kind)).toEqual([
      'connection_opened',
      'raw_source_frame',
      'connection_closed',
    ]);
    expect((await run.frames())[0]?.payload_utf8).toBe('{"msg_type":"tick","n":0}');
    const [incident] = run.operational.incidents;
    // IDs: 1 conexión, 2 apertura, 3..1002 los frames aceptados, 1003 el que no cupo.
    expect(incident).toMatchObject({
      evidence: {
        maximum_value: 1000,
        observed_value: 1001,
        resource: 'in_memory_queue_events',
        unit: 'events',
      },
      incident_type: 'source_limit_exceeded',
      observed_ref: uuid(1003),
      // Último source event durable antes del registro: el frame que estaba en curso.
      related_refs: [uuid(3)],
      severity: 'error',
    });
    expect(run.registry.openConditionTypes()).toEqual(['source_limit_exceeded']);
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: [],
      closure_type: 'transport_error',
      reason: 'in_memory_queue_events',
    });
    expect(result.end).toEqual({
      detail: null,
      reason: 'in_memory_queue_events',
      status: 'paused',
    });
    expect(result.closure?.persisted).toBe(true);
  });

  it('el límite de 33 554 432 bytes salta antes que el de eventos', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    const hold = holdObjectWrites(run.objects);
    const frame = (index: number) => {
      const head = `{"msg_type":"tick","n":${String(index)},"pad":"`;
      return `${head}${'x'.repeat(MIB - head.length - 2)}"}`;
    };
    expect(Buffer.byteLength(frame(10), 'utf8')).toBe(MIB);

    // 32 frames de 1 MiB caben justo; el 33 no.
    for (let index = 10; index < 42; index += 1) {
      socket.text(frame(index));
    }
    expect(socket.ended).toBeNull();
    socket.text(frame(42));
    hold.release();
    const result = await run.run;

    expect(run.operational.incidents[0]?.evidence).toEqual({
      maximum_value: 33_554_432,
      observed_value: 33 * MIB,
      resource: 'in_memory_queue_bytes',
      unit: 'bytes',
    });
    expect(await run.frames()).toHaveLength(1);
    expect(result.end).toMatchObject({ reason: 'in_memory_queue_bytes', status: 'paused' });
  });

  it('un frame cortado por ws registra su tamaño declarado, descarta lo que espera y pausa', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    const hold = holdObjectWrites(run.objects);
    socket.text('{"msg_type":"tick","n":1}');
    socket.text('{"msg_type":"tick","n":2}');
    await run.clock.advance(250);
    socket.emit({ kind: 'frame_too_large', observed_value: 2_000_001 });
    hold.release();
    const result = await run.run;

    expect((await run.frames()).map((frame) => frame.payload_utf8)).toEqual([
      '{"msg_type":"tick","n":1}',
    ]);
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: {
          maximum_value: MIB,
          observed_value: 2_000_001,
          resource: 'websocket_frame',
          unit: 'bytes',
        },
        observed_at_utc: '2026-03-02T10:00:00.250Z',
        // Un ID nuevo para el frame que nunca llegó entero (no está en el log).
        observed_ref: uuid(5),
        severity: 'error',
      }),
    ]);
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'websocket_frame',
    });
    expect(result.end).toEqual({ detail: null, reason: 'websocket_frame', status: 'paused' });
  });

  it('sin el tamaño declarado no inventa uno: cierra y termina con failed', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.emit({ kind: 'frame_too_large', observed_value: null });
    const result = await run.run;

    expect(run.operational.incidents).toEqual([]);
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'websocket_frame',
    });
    expect(result.end).toEqual({
      detail: null,
      reason: 'frame_size_unavailable',
      status: 'failed',
    });
  });
});

describe('runDerivAdapter: cierres del transporte', () => {
  it('un mensaje binario cierra la entrada con transport_error y conserva lo anterior', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text('{"msg_type":"tick","n":1}');
    socket.emit({ kind: 'binary' });
    const result = await run.run;

    expect(await run.frames()).toHaveLength(1);
    expect(socket.ended).toBe('terminate');
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'binary_frame',
    });
    expect(result.end).toEqual({ detail: null, reason: 'binary_frame', status: 'disconnected' });
  });

  it('un cierre del servidor es remote; uno sin cierre ordenado (1006), transport_error', async () => {
    const remote = await harness();
    remote.socket().open();
    await settle();
    remote.socket().emit({ code: 1001, kind: 'closed' });
    const remoteResult = await remote.run;
    expect(await remote.lastClosed()).toMatchObject({
      closure_type: 'remote',
      reason: 'close_code_1001',
    });
    expect(remoteResult.end).toEqual({
      detail: '1001',
      reason: 'remote_closed',
      status: 'disconnected',
    });
    expect(remote.socket().ended).toBeNull();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const abnormal = await harness();
    abnormal.socket().open();
    await settle();
    abnormal.socket().emit({ code: 1006, kind: 'closed' });
    await abnormal.run;
    expect(await abnormal.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'close_code_1006',
    });
  });

  it('un error del transporte cierra con su código saneado', async () => {
    const run = await harness();
    run.socket().open();
    await settle();
    run.socket().emit({ code: 'WS_ERR_INVALID_UTF8', kind: 'error' });
    const result = await run.run;
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'WS_ERR_INVALID_UTF8',
    });
    expect(result.end).toEqual({
      detail: 'WS_ERR_INVALID_UTF8',
      reason: 'transport_error',
      status: 'disconnected',
    });
  });

  it('un error antes de abrir no escribe nada', async () => {
    const run = await harness();
    run.socket().emit({ code: 'ECONNREFUSED', kind: 'error' });
    const result = await run.run;
    expect(run.sourceLog.rows).toEqual([]);
    expect(result.end).toEqual({
      detail: 'ECONNREFUSED',
      reason: 'connect_failed',
      status: 'disconnected',
    });
  });
});

describe('runDerivAdapter: antes de conectar', () => {
  it('si los esquemas no son los fijados, nunca conecta (salud failed)', async () => {
    const run = await harness({ expectedSha256: 'f'.repeat(64) });
    const result = await run.run;
    expect(run.sockets).toEqual([]);
    expect(result).toMatchObject({
      end: { reason: 'archive_sha256_mismatch', status: 'failed' },
      schemas: null,
    });
  });

  it('la descarga de esquemas vence a los 30 s del temporizador inyectado', async () => {
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const run = await harness({ fetch: hanging });
    await run.clock.advance(29_999);
    expect(run.sockets).toEqual([]);
    await run.clock.advance(1);
    const result = await run.run;
    expect(run.sockets).toEqual([]);
    expect(result.end).toEqual({ detail: null, reason: 'download_timeout', status: 'failed' });
  });

  it('si una petición propia no cumple su esquema, no conecta', async () => {
    const run = await harness({ symbol: 'SYNTH 100' });
    const result = await run.run;
    expect(run.sockets).toEqual([]);
    expect(result.end).toEqual({ detail: 'ticks', reason: 'request_invalid', status: 'failed' });
  });

  it('comprueba también la petición ticks_history: si su esquema la rechaza, no conecta', async () => {
    // Release sintética que pide `end` como entero; la petición lo manda como texto (ADR-0015 §1).
    const run = await harness({
      schemaOverrides: {
        'ticks_history_request.schema.json': {
          $schema: 'http://json-schema.org/draft-04/schema#',
          properties: { end: { type: 'integer' }, ticks_history: { type: 'string' } },
          required: ['end', 'ticks_history'],
          type: 'object',
        },
      },
    });
    expect(run.sockets).toEqual([]);
    const result = await run.run;
    expect(run.sockets).toEqual([]);
    expect(result.end).toEqual({
      detail: 'ticks_history',
      reason: 'request_invalid',
      status: 'failed',
    });
  });

  it('una condición abierta que la apertura no resuelve deja la entrada cerrada', async () => {
    // Condición de una ejecución anterior, que el registro no podrá resolver porque PostgreSQL
    // deja de responder: la entrada sigue en pausa después de la apertura.
    const operational = new MemoryOperationalStore();
    const earlier = await OperationalRegistry.open({ source: DERIV_SOURCE, store: operational });
    await earlier.recordSourceLimitExceeded({
      observed_at_utc: '2026-03-01T00:00:00.000Z',
      observed_ref: uuid(800),
      related_refs: [],
      violation: {
        action: 'stop_accepting_and_close_input',
        evidence: {
          maximum_value: 1000,
          observed_value: 1001,
          resource: 'in_memory_queue_events',
          unit: 'events',
        },
        service_health: 'paused',
      },
    });
    operational.failAppend = true;
    const run = await harness({ operational });
    run.socket().open();
    const result = await run.run;

    expect(run.alerts).toEqual([
      expect.objectContaining({ event: 'operational_registry_unavailable', operation: 'resolve' }),
    ]);
    expect(run.registry.openConditionTypes()).toEqual(['source_limit_exceeded']);
    expect(run.socket().requests()).toEqual([]);
    expect(result.end).toEqual({ detail: null, reason: 'input_closed', status: 'paused' });
    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: [],
      closure_type: 'requested',
      reason: 'input_closed',
    });
  });
});

describe('RawFirstIngestor.pauseForSourceLimit', () => {
  async function ingestor() {
    const objects = new MemoryObjectStore();
    const sourceLog = new MemorySourceLogStore();
    const operational = new MemoryOperationalStore();
    const openLog = () =>
      SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
    const registry = await OperationalRegistry.open({ source: DERIV_SOURCE, store: operational });
    let sequence = 100;
    const value = new RawFirstIngestor({
      log: await openLog(),
      nextId: () => uuid((sequence += 1)),
      now: () => START,
      profile: createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: 'SYNTH_100' }),
      registry,
      reopenLog: openLog,
      sink: { invalidFrame: () => undefined, tick: () => undefined },
    });
    return { ingestor: value, operational, registry, sourceLog };
  }

  it('pausa la entrada y solo escribe en el registro operativo', async () => {
    const run = await ingestor();
    const outcome = await run.ingestor.pauseForSourceLimit({
      observed_at_utc: START,
      observed_ref: uuid(7),
      violation: {
        action: 'reject_frame_and_close_input',
        evidence: {
          maximum_value: MIB,
          observed_value: MIB + 1,
          resource: 'websocket_frame',
          unit: 'bytes',
        },
        service_health: 'paused',
      },
    });

    expect(outcome).toEqual({ resource: 'websocket_frame', status: 'limit_exceeded' });
    expect(run.sourceLog.rows).toEqual([]);
    expect(run.ingestor.state).toBe('paused');
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({ observed_ref: uuid(7), related_refs: [], severity: 'error' }),
    ]);
    expect(
      await run.ingestor.receiveFrame({
        connection_id: uuid(1),
        observation_id: uuid(2),
        payload_utf8: '{}',
        received_at_utc: START,
      }),
    ).toEqual({ status: 'input_closed' });
    // El cierre de la entrada sigue admitido.
    expect(
      (
        await run.ingestor.receiveEvent({
          affected_symbols: [],
          closure_type: 'transport_error',
          connection_id: uuid(1),
          event_id: uuid(3),
          kind: 'connection_closed',
          occurred_at_utc: START,
          reason: 'websocket_frame',
          schema_version: '1.0.0',
          source: DERIV_SOURCE,
        })
      ).status,
    ).toBe('durable');
  });

  it('rechaza los límites de esquema, que dejan failed y no pausan', async () => {
    const run = await ingestor();
    await expect(
      run.ingestor.pauseForSourceLimit({
        observed_at_utc: START,
        observed_ref: uuid(7),
        violation: {
          action: 'abort_schema_load',
          evidence: {
            maximum_value: 5_242_880,
            observed_value: 5_242_881,
            resource: 'schema_archive',
            unit: 'bytes',
          },
          service_health: 'failed',
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(run.ingestor.state).toBe('accepting');
    expect(run.operational.incidents).toEqual([]);
  });
});

describe('perfil de medición de Deriv (ADR-0012 §8 y ADR-0015 §1)', () => {
  it('usa las reglas 2.0.0, las cinco respuestas pedidas con history, el esquema de ticks y el conector 1.1.0, y nunca publica', () => {
    const schemas = syntheticSchemas();
    const profile = createDerivMeasurementProfile({ schemas, symbol: 'SYNTH_100' });
    const expected = {
      allowed_symbols: ['SYNTH_100'],
      gap_detection: 'after_reconnection',
      non_tick_msg_types: ['active_symbols', 'forget_all', 'history', 'ping', 'time'],
      profile_id: 'deriv_options-measurement-v2-SYNTH_100',
      purpose: 'measurement',
      quality_rule_version: '2.0.0',
      source: 'deriv_options',
    };
    expect(profile.quality_profile).toEqual(expected);
    expect(decoder.decode(profile.quality_profile_bytes)).toBe(canonicalJson(expected));
    expect(profile.purpose).toBe('measurement');
    expect(profile.rules.quality_rule_version).toBe('2.0.0');
    expect([...profile.nonTickMsgTypes]).toEqual(expected.non_tick_msg_types);
    expect(profile.connector_version).toBe('deriv-options-ws-1.1.0');
    expect(profile.source_schema_release).toBe('synthetic-deriv-1');
    const ticksSchema = syntheticSchemaArchive().entries['ticks_response.schema.json'];
    expect(profile.source_schema_bytes).toEqual(ticksSchema);
    expect(profile.source_schema_sha256).toBe(
      sha256Hex(canonicalJson(JSON.parse(decoder.decode(ticksSchema)) as never)),
    );
    expect(() => publicationThresholds(profile)).toThrow(/medición/u);
  });

  it('un frame history durable es una respuesta declarada: ni tick ni frame inválido', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    const payload = derivMessages.history(7, [START_EPOCH - 2, START_EPOCH], ['100.25', '100.75']);
    socket.text(payload);
    await settle();
    socket.emit({ code: 1000, kind: 'closed' });
    await run.run;

    const [historyFrame] = await run.frames();
    expect(historyFrame?.payload_utf8).toBe(payload);
    expect(run.nonTick).toEqual([
      { msg_type: 'history', observation_id: historyFrame?.observation_id },
    ]);
    expect(run.invalid).toEqual([]);
    expect(run.ticks).toEqual([]);
  });
});

describe('petición ticks_history (ADR-0015 §4)', () => {
  it('pide una página de 1000 ticks con start entero y end como texto, en JCS', () => {
    const request = {
      end: 1_700_000_060,
      operation: 'ticks_history',
      start: 1_700_000_000,
      symbol: 'SYNTH_100',
    } as const;
    expect(encodeRequest(syntheticSchemas(), request, 7)).toBe(
      '{"count":1000,"end":"1700000060","req_id":7,"start":1700000000,"style":"ticks","ticks_history":"SYNTH_100"}',
    );
  });
});

describe('declaredMessageLength', () => {
  it('lee el tamaño declarado de ws solo si existe y supera el máximo', () => {
    expect(declaredMessageLength({})).toBeNull();
    expect(declaredMessageLength({ _receiver: null })).toBeNull();
    expect(declaredMessageLength({ _receiver: {} })).toBeNull();
    expect(declaredMessageLength({ _receiver: { _totalPayloadLength: MIB } })).toBeNull();
    expect(declaredMessageLength({ _receiver: { _totalPayloadLength: '2000000' } })).toBeNull();
    expect(declaredMessageLength({ _receiver: { _totalPayloadLength: 2 ** 53 } })).toBeNull();
    expect(declaredMessageLength({ _receiver: { _totalPayloadLength: MIB + 1 } })).toBe(MIB + 1);
  });
});

describe('runDerivAdapter: después de decidir el cierre', () => {
  it('una respuesta pedida que queda durable tras el cierre deja su incidencia (ADR-0012 §6)', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    // La respuesta y el cierre del servidor llegan en la misma vuelta: el frame sigue en la cola.
    socket.text(derivMessages.error(1, 'active_symbols', { active_symbols: 'brief' }));
    socket.emit({ code: 1000, kind: 'closed' });
    const result = await run.run;

    const [catalogFrame] = await run.frames();
    expect(result.end).toEqual({ detail: '1000', reason: 'remote_closed', status: 'disconnected' });
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: {
          raw_payload_sha256: catalogFrame?.raw_payload_sha256,
          reason: 'source_error_response',
        },
        observed_ref: catalogFrame?.observation_id,
      }),
    ]);
    // Ya no se suscribe.
    expect(socket.requests()).toHaveLength(1);
  });

  it('un catálogo válido que queda durable tras el cierre guarda su versión, sin suscribirse', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    socket.emit({ code: 1001, kind: 'closed' });
    const result = await run.run;

    expect(run.catalog.versions).toHaveLength(1);
    expect(result.catalog?.status).toBe('created');
    expect(socket.requests()).toHaveLength(1);
    expect(await run.lastClosed()).toMatchObject({ affected_symbols: [], closure_type: 'remote' });
  });

  it('con el aviso de cierre de ws más tarde, termina cuando llega, con el cierre ya durable', async () => {
    const run = await harness({ deferClose: true });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    await run.clock.advance(30_000);
    socket.text(derivMessages.forgetAll(3));
    let settled = false;
    void run.run.then(() => {
      settled = true;
    });
    await settle();

    expect(socket.ended).toBe('close');
    expect(await run.lastClosed()).toMatchObject({ closure_type: 'requested' });
    expect(settled).toBe(false);
    socket.finishClose();
    const result = await run.run;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.closure?.persisted).toBe(true);
  });

  it('si el servidor cierra tras pedir la suscripción y antes del primer tick, el símbolo queda afectado', async () => {
    const run = await harness();
    await run.openAndListCatalog();
    run.socket().emit({ code: 1001, kind: 'closed' });
    await run.run;

    expect(await run.lastClosed()).toMatchObject({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'remote',
    });
  });
});

describe('runDerivAdapter: ramas del ingestor y del transporte', () => {
  it('segunda barrera: un frame de más de 1 MiB que llega entero pausa y descarta lo que espera', async () => {
    const run = await harness();
    const socket = run.socket();
    socket.open();
    await settle();
    const hold = holdObjectWrites(run.objects);
    socket.text('{"msg_type":"tick","n":1}');
    socket.text('x'.repeat(MIB + 1));
    socket.text('{"msg_type":"tick","n":2}');
    hold.release();
    const result = await run.run;

    expect((await run.frames()).map((frame) => frame.payload_utf8)).toEqual([
      '{"msg_type":"tick","n":1}',
    ]);
    // IDs: 1 conexión, 2 apertura, 3 el primer frame y 4 el de más de 1 MiB.
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: {
          maximum_value: MIB,
          observed_value: MIB + 1,
          resource: 'websocket_frame',
          unit: 'bytes',
        },
        observed_ref: uuid(4),
      }),
    ]);
    expect(run.socket().ended).toBe('terminate');
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'transport_error',
      reason: 'websocket_frame',
    });
    expect(result.end).toEqual({ detail: null, reason: 'websocket_frame', status: 'paused' });
  });

  it('si ConnectionOpened no queda durable, no pide nada y pausa', async () => {
    const run = await harness();
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket().open();
    const result = await run.run;

    expect(run.socket().requests()).toEqual([]);
    expect(run.socket().ended).toBe('terminate');
    expect(result.end).toEqual({
      detail: 'raw_object_write',
      reason: 'persistence_unavailable',
      status: 'paused',
    });
    expect(result.closure).toEqual({
      closure_type: 'transport_error',
      persisted: false,
      reason: 'persistence_unavailable',
    });
  });

  it('un mensaje ticks sin error no responde a la suscripción: vence a los 15 s', async () => {
    const run = await harness();
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(
      '{"echo_req":{"req_id":2,"subscribe":1,"ticks":"SYNTH_100"},"msg_type":"ticks","req_id":2}',
    );
    await settle();
    expect(socket.ended).toBeNull();
    await run.clock.advance(REQUEST_TIMEOUT_MS);
    const result = await run.run;

    expect(result.end).toEqual({
      detail: 'ticks',
      reason: 'request_timeout',
      status: 'disconnected',
    });
    expect(await run.lastClosed()).toMatchObject({
      closure_type: 'timeout',
      reason: 'ticks_timeout',
    });
  });

  it('un ping que no cumple su esquema también cierra como ping_invalid', async () => {
    const run = await harness({ durationMs: 600_000 });
    const socket = run.socket();
    await run.openAndListCatalog();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    await run.clock.advance(KEEPALIVE_INTERVAL_MS);
    socket.text('{"echo_req":{"ping":1,"req_id":3},"msg_type":"ping","ping":"no","req_id":3}');
    const result = await run.run;

    expect(result.end).toEqual({ detail: null, reason: 'ping_invalid', status: 'disconnected' });
    expect(run.requested.incidents.map((incident) => incident.evidence)).toEqual([
      expect.objectContaining({ reason: 'schema_validation_failed' }),
    ]);
  });

  it('si connect lanza, termina sin socket ni eventos, con connect_failed', async () => {
    const run = await harness({
      connectError: Object.assign(new Error('sintético'), { code: 'ERR_INVALID_URL' }),
    });
    const result = await run.run;

    expect(run.sockets).toEqual([]);
    expect(run.sourceLog.rows).toEqual([]);
    expect(result).toMatchObject({
      closure: null,
      end: { detail: 'ERR_INVALID_URL', reason: 'connect_failed', status: 'disconnected' },
    });
  });
});
