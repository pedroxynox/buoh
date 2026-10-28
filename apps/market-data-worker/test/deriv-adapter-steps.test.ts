import { type SourceEvent } from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  prepareDerivAdapter,
  runDerivAdapter,
  startDerivAttempt,
  type DerivPreparation,
} from '../src/deriv/adapter.js';
import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { RawFirstIngestor } from '../src/ingestion/raw-first-ingestor.js';
import { contentKey } from '../src/object-keys.js';
import { OperationalRegistry, type OperationalAlert } from '../src/operational/registry.js';
import { LogIntegrityError, SourceEventLog } from '../src/source-log/source-event-log.js';
import { settle, START, syntheticSchemas, uuid } from './support/connection-harness.js';
import { FakeDerivSocket, ManualClock, syntheticSchemaArchive } from './support/deriv-fixtures.js';
import {
  MemoryCatalogStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemoryRequestedResponseIncidentStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';
import { PREVIOUS, previousConnectionEvents } from './support/recovery-harness.js';

// Los pasos del adaptador de Deriv que reutiliza la sesión (ADR-0015 §3): la preparación, que carga
// los esquemas una vez, comprueba las seis peticiones y arma el perfil, y el intento, que repara el
// cierre anterior, espera a pasarlo y abre la conexión que lo supera. Socket falso, reloj y
// temporizador manuales, IDs secuenciales, almacenes en memoria y esquemas sintéticos.

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

beforeEach(() => {
  forbidAmbientEffects();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SCHEMA_URL = 'https://schemas.invalid/schemas.zip';

/** `fetch` falso que responde siempre con `response()` y anota cada URL. */
function fakeFetch(response: () => Response, calls: string[] = []): typeof fetch {
  return (url: string | URL | Request) => {
    calls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    return Promise.resolve(response());
  };
}

/** Registro operativo en memoria y lo que necesita la preparación, salvo la descarga. */
async function preparationPorts() {
  const clock = new ManualClock(START);
  let sequence = 0;
  const operational = new MemoryOperationalStore();
  const registry = await OperationalRegistry.open({
    alert: () => undefined,
    source: DERIV_SOURCE,
    store: operational,
  });
  return {
    clock,
    nextId: () => uuid((sequence += 1)),
    operational,
    registry,
  };
}

describe('prepareDerivAdapter: lo que la sesión prepara una vez', () => {
  it('carga los esquemas, comprueba las peticiones y devuelve los esquemas, su resumen y el perfil de medición del símbolo', async () => {
    const fixture = syntheticSchemaArchive();
    const calls: string[] = [];
    const ports = await preparationPorts();

    const prepared = await prepareDerivAdapter({
      expected: fixture.expected,
      fetch: fakeFetch(() => new Response(fixture.archive, { status: 200 }), calls),
      nextId: ports.nextId,
      now: ports.clock.now,
      registry: ports.registry,
      related_refs: [],
      scheduler: ports.clock.scheduler,
      schemaUrl: SCHEMA_URL,
      symbol: 'SYNTH_100',
    });

    expect(calls).toEqual([SCHEMA_URL]);
    if (prepared.status !== 'prepared') {
      throw new TypeError(`La preparación no pasó: ${prepared.end.reason}.`);
    }
    expect(prepared.summary).toEqual({
      archive_sha256: fixture.expected.archive_sha256,
      release: 'synthetic-deriv-1',
    });
    expect(prepared.schemas.release).toBe('synthetic-deriv-1');
    expect(prepared.symbol).toBe('SYNTH_100');
    expect(prepared.profile.connector_version).toBe('deriv-options-ws-1.1.0');
    expect(prepared.profile.quality_profile.profile_id).toBe(
      'deriv_options-measurement-v2-SYNTH_100',
    );
    // La descarga ya no tiene tiempo de espera pendiente.
    expect(ports.clock.pendingDelays()).toEqual([]);
  });

  it('si los esquemas no son los fijados, devuelve el fin failed sin resumen', async () => {
    const fixture = syntheticSchemaArchive();
    const ports = await preparationPorts();

    expect(
      await prepareDerivAdapter({
        expected: { ...fixture.expected, archive_sha256: 'f'.repeat(64) },
        fetch: fakeFetch(() => new Response(fixture.archive, { status: 200 })),
        nextId: ports.nextId,
        now: ports.clock.now,
        registry: ports.registry,
        related_refs: [],
        scheduler: ports.clock.scheduler,
        schemaUrl: SCHEMA_URL,
        symbol: 'SYNTH_100',
      }),
    ).toEqual({
      end: {
        detail: fixture.expected.archive_sha256,
        reason: 'archive_sha256_mismatch',
        status: 'failed',
      },
      status: 'failed',
      summary: null,
    });
  });

  it('si una petición no cumple su esquema, devuelve el fin failed con el resumen de la release cargada', async () => {
    const fixture = syntheticSchemaArchive();
    const ports = await preparationPorts();

    expect(
      await prepareDerivAdapter({
        expected: fixture.expected,
        fetch: fakeFetch(() => new Response(fixture.archive, { status: 200 })),
        nextId: ports.nextId,
        now: ports.clock.now,
        registry: ports.registry,
        related_refs: [],
        scheduler: ports.clock.scheduler,
        schemaUrl: SCHEMA_URL,
        // `ticks` no admite el espacio.
        symbol: 'SYNTH 100',
      }),
    ).toEqual({
      end: { detail: 'ticks', reason: 'request_invalid', status: 'failed' },
      status: 'failed',
      summary: { archive_sha256: fixture.expected.archive_sha256, release: 'synthetic-deriv-1' },
    });
  });

  it('un límite de esquema queda en el registro operativo con los related_refs que recibe', async () => {
    const ports = await preparationPorts();
    const last = uuid(9000);

    const prepared = await prepareDerivAdapter({
      fetch: fakeFetch(
        () =>
          new Response(new Uint8Array(0), {
            headers: { 'content-length': '6000000' },
            status: 200,
          }),
      ),
      nextId: ports.nextId,
      now: ports.clock.now,
      registry: ports.registry,
      related_refs: [last],
      scheduler: ports.clock.scheduler,
      schemaUrl: SCHEMA_URL,
      symbol: 'SYNTH_100',
    });

    expect(prepared).toMatchObject({
      end: { reason: 'source_limit_exceeded', status: 'failed' },
      status: 'failed',
      summary: null,
    });
    expect(ports.operational.incidents).toEqual([
      expect.objectContaining({
        incident_type: 'source_limit_exceeded',
        observed_ref: uuid(1),
        related_refs: [last],
      }),
    ]);
  });
});

describe('runDerivAdapter: la preparación con el log abierto', () => {
  it('cita el último evento durable del log en la incidencia de un límite de esquema', async () => {
    const ports = await preparationPorts();
    const objects = new MemoryObjectStore();
    const sourceLog = new MemorySourceLogStore();
    const openLog = () =>
      SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
    const log = await openLog();
    const [opened] = previousConnectionEvents();
    if (opened === undefined) {
      throw new TypeError('Falta la apertura anterior.');
    }
    await log.append(opened);

    const result = await runDerivAdapter({
      alert: () => undefined,
      catalog: new MemoryCatalogStore(),
      connect: () => {
        throw new TypeError('No debe conectar.');
      },
      durationMs: 30_000,
      fetch: fakeFetch(
        () =>
          new Response(new Uint8Array(0), {
            headers: { 'content-length': '6000000' },
            status: 200,
          }),
      ),
      log,
      nextId: ports.nextId,
      now: ports.clock.now,
      registry: ports.registry,
      reopenLog: openLog,
      requestedResponses: new MemoryRequestedResponseIncidentStore(),
      scheduler: ports.clock.scheduler,
      schemaUrl: SCHEMA_URL,
      serverTime: false,
      sink: { invalidFrame: () => undefined, tick: () => undefined },
      symbol: 'SYNTH_100',
    });

    expect(result).toMatchObject({
      connection_id: null,
      end: { reason: 'source_limit_exceeded', status: 'failed' },
      schemas: null,
    });
    expect(ports.operational.incidents).toEqual([
      expect.objectContaining({ related_refs: [uuid(9002)] }),
    ]);
  });
});

/**
 * Lo que necesita un intento, sobre `SYNTH_100`: el log con los `events` de una ejecución anterior
 * (con su segmento cerrado si `closeSegment`), el registro operativo, el ingestor de la sesión y una
 * preparación ya hecha con los esquemas sintéticos. `start` lanza el intento.
 */
async function attemptHarness(
  options: { readonly closeSegment?: boolean; readonly events?: readonly SourceEvent[] } = {},
) {
  const clock = new ManualClock(START);
  let sequence = 0;
  const nextId = () => uuid((sequence += 1));
  const objects = new MemoryObjectStore();
  const sourceLog = new MemorySourceLogStore();
  const operational = new MemoryOperationalStore();
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const sockets: FakeDerivSocket[] = [];
  const openLog = () =>
    SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
  const log = await openLog();
  for (const event of options.events ?? []) {
    await log.append(event);
  }
  if (options.closeSegment === true) {
    await log.close('requested');
  }
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: DERIV_SOURCE,
    store: operational,
  });
  const schemas = syntheticSchemas();
  const preparation: DerivPreparation = {
    profile: createDerivMeasurementProfile({ schemas, symbol: 'SYNTH_100' }),
    schemas,
    status: 'prepared',
    summary: { archive_sha256: schemas.archive_sha256, release: schemas.release },
    symbol: 'SYNTH_100',
  };
  const ingestor = new RawFirstIngestor({
    log,
    nextId,
    now: clock.now,
    profile: preparation.profile,
    registry,
    reopenLog: openLog,
    sink: { invalidFrame: () => undefined, tick: () => undefined },
  });

  const start = () =>
    startDerivAttempt({
      alert: (payload) => alerts.push(payload),
      catalog: new MemoryCatalogStore(),
      connect: (input) => {
        const socket = new FakeDerivSocket(input);
        sockets.push(socket);
        return socket;
      },
      ingestor,
      nextId,
      now: clock.now,
      preparation,
      requestedResponses: new MemoryRequestedResponseIncidentStore(),
      scheduler: clock.scheduler,
      serverTime: false,
    });

  /** Socket del intento; falla si no hay exactamente uno. */
  const socket = (): FakeDerivSocket => {
    const [only] = sockets;
    if (only === undefined || sockets.length !== 1) {
      throw new TypeError(`Se esperaba un socket, hay ${String(sockets.length)}.`);
    }
    return only;
  };

  /** Source events durables, leídos de los almacenes con un log reabierto. */
  const events = async (): Promise<SourceEvent[]> =>
    (await (await openLog()).readDurableSegments()).flat();

  return { alerts, clock, events, objects, operational, socket, sockets, sourceLog, start };
}

describe('startDerivAttempt: un intento de la sesión', () => {
  it('repara el cierre que le falta a la conexión anterior, espera a pasarlo y devuelve viva la conexión que la supera, con la promesa de su resultado', async () => {
    // La conexión anterior cayó sin su cierre: su apertura y un tick.
    const run = await attemptHarness({ events: previousConnectionEvents().slice(0, 2) });
    const started = run.start();
    await settle();
    // El cierre reparado ya es durable; el intento espera 1 ms para pasarlo, todavía sin socket.
    expect(run.sockets).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([1]);
    await run.clock.advance(1);
    const attempt = await started;
    if (attempt.status !== 'started') {
      throw new TypeError(`El intento no conectó: ${JSON.stringify(attempt.end)}.`);
    }
    run.socket().open();
    await settle();
    // Es la conexión que corre: su parada cierra este socket y resuelve la promesa.
    attempt.connection.stop();

    expect(await attempt.result).toEqual({
      catalog: null,
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connection_id: uuid(2),
      end: { status: 'completed' },
      server_time_offset_ms: null,
      subscription_id: null,
    });
    expect(run.socket().ended).toBe('close');
    // IDs: 1 el cierre reparado, 2 la conexión, 3 su apertura y 4 su cierre.
    expect((await run.events()).slice(2)).toEqual([
      expect.objectContaining({
        connection_id: PREVIOUS,
        event_id: uuid(1),
        occurred_at_utc: START,
        reason: 'close_not_recorded',
      }),
      expect.objectContaining({
        connection_id: uuid(2),
        event_id: uuid(3),
        kind: 'connection_opened',
        occurred_at_utc: '2026-03-02T10:00:00.001Z',
        supersedes_connection_id: PREVIOUS,
      }),
      expect.objectContaining({
        connection_id: uuid(2),
        event_id: uuid(4),
        kind: 'connection_closed',
        reason: 'requested',
      }),
    ]);
  });

  it('si el cierre reparado no queda durable, no abre el socket y devuelve el fin en pausa por persistencia', async () => {
    const run = await attemptHarness({ events: previousConnectionEvents().slice(0, 2) });
    run.objects.armNextPutFailure('synthetic_put_failure');

    expect(await run.start()).toEqual({
      end: { detail: 'raw_object_write', reason: 'persistence_unavailable', status: 'paused' },
      status: 'not_connected',
    });
    expect(run.sockets).toEqual([]);
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({ incident_type: 'persistence_unavailable', observed_ref: uuid(1) }),
    ]);
  });

  it('si el log no pasa sus comprobaciones, el intento se rechaza con LogIntegrityError, sin socket ni registro', async () => {
    const run = await attemptHarness({
      closeSegment: true,
      events: previousConnectionEvents().slice(0, 2),
    });
    // El objeto del segmento cerrado ya no tiene el hash de su fila.
    const key = contentKey(run.sourceLog.closed[0]?.object_bytes_sha256 ?? '');
    const altered = Uint8Array.from(run.objects.objects.get(key) ?? new Uint8Array());
    altered[2] = 0x41;
    run.objects.objects.set(key, altered);

    await expect(run.start()).rejects.toThrow(LogIntegrityError);
    expect(run.sockets).toEqual([]);
    expect(run.operational.incidents).toEqual([]);
  });
});
