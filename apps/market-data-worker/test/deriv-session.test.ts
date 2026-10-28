import {
  connectionClosedSchema,
  connectionOpenedSchema,
  rawSourceFrameSchema,
  sha256Hex,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contentKey } from '../src/object-keys.js';
import { LogIntegrityError, SourceEventLog } from '../src/source-log/source-event-log.js';
import { settle, START_EPOCH, uuid } from './support/connection-harness.js';
import { derivMessages } from './support/deriv-fixtures.js';
import { type MemoryObjectStore, type MemorySourceLogStore } from './support/memory-stores.js';
import { PREVIOUS, previousConnectionEvents } from './support/recovery-harness.js';
import { LOCK_BUG, sessionHarness, type SessionRun } from './support/session-harness.js';

// La sesión de ingesta de Deriv (ADR-0015 §3 y §5): prepara una vez, toma el bloqueo, abre y
// comprueba el log y sigue una conexión por intento, con la espera entre intentos, hasta la parada o
// un fallo. Reloj y temporizador manuales, sockets falsos, IDs secuenciales, `random` inyectado,
// almacenes en memoria, esquemas sintéticos y un bloqueo en memoria; ningún precio es de mercado.

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

/** Una conexión de otro proceso, que escribe el log mientras la sesión no tiene el bloqueo. */
const OTHER = uuid(8000);

const isEvent = (event: SourceEvent | undefined): event is SourceEvent => event !== undefined;

/** Un almacén que no responde. */
const unavailable = () => Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });

describe('startDerivSession: arranque', () => {
  it('si la preparación falla, termina failed con su motivo, sin tomar el bloqueo ni conectar', async () => {
    const run = await sessionHarness({ expectedSha256: 'f'.repeat(64) });

    expect(await run.done).toEqual({
      catalog: null,
      connections: [],
      end: {
        detail: run.fixture.expected.archive_sha256,
        reason: 'archive_sha256_mismatch',
        status: 'failed',
      },
      recoveries: [],
      schemas: null,
      server_time_offset_ms: null,
      subscription_id: null,
      waits_ms: [],
    });
    expect(run.timeline).toEqual([]);
    expect(run.openedWith).toEqual([]);
  });

  it('una parada durante la carga de los esquemas termina completed al acabarla, sin tomar el bloqueo', async () => {
    const run = await sessionHarness({ stopOnFetch: true });

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.schemas).toEqual({
      archive_sha256: run.fixture.expected.archive_sha256,
      release: 'synthetic-deriv-1',
    });
    expect(run.timeline).toEqual([]);
    expect(run.openedWith).toEqual([]);
  });

  it('el resultado lleva el catálogo, el id de la suscripción y el desfase con el servidor de la última conexión', async () => {
    const run = await sessionHarness({ serverTime: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    // Tras el primer tick pide `time` (`req_id` 3): el servidor va 1000 ms por detrás.
    expect(run.socket(1).requests().at(-1)).toEqual({ req_id: 3, time: 1 });
    run.socket(1).text(derivMessages.time(3, START_EPOCH - 1));
    await settle();
    run.session.stop();
    run.socket(1).text(derivMessages.forgetAll(4));

    const result = await run.done;
    expect(result.catalog?.snapshot.entry_count).toBe(2);
    expect(result.subscription_id).toBe('sub-1');
    expect(result.server_time_offset_ms).toBe(1000);
  });
});

/**
 * La sesión no usó el log: no conectó, soltó el bloqueo y el log sigue con sus `rows` filas y sus
 * `closed` segmentos cerrados.
 */
function expectRefusedLog(run: SessionRun, rows: number, closed = 0): void {
  expect(run.timeline).toEqual(['acquire:1', 'release:1']);
  expect(run.sockets).toEqual([]);
  expect(run.sourceLog.rows).toHaveLength(rows);
  expect(run.sourceLog.closed).toHaveLength(closed);
  expect(run.clock.pendingDelays()).toEqual([]);
}

/** Cambia un byte del objeto `key`: ya no tiene el hash de su fila. */
function alterObject(objects: MemoryObjectStore, key: string): void {
  const altered = Uint8Array.from(objects.objects.get(key) ?? new Uint8Array());
  altered[2] = 0x41;
  objects.objects.set(key, altered);
}

describe('startDerivSession: el estado al arrancar (ADR-0015 §5)', () => {
  it('si el log tiene frames de otro conector, termina failed con connector_version_mismatch sin conectar', async () => {
    const [opened, tick, closed] = previousConnectionEvents();
    const old = rawSourceFrameSchema.parse({
      ...tick,
      connector_version: 'deriv-options-ws-1.0.0',
    });
    const run = await sessionHarness({ events: [opened, old, closed].filter(isEvent) });
    expect(run.sockets).toEqual([]);

    const result = await run.done;
    expect(result.end).toEqual({
      detail: null,
      reason: 'connector_version_mismatch',
      status: 'failed',
    });
    expect(result.connections).toEqual([]);
    expectRefusedLog(run, 3);
  });

  it('si el log no se puede derivar, como uno que cierra dos veces la misma conexión, termina failed con log_not_derivable sin conectar', async () => {
    const events = previousConnectionEvents();
    const again = connectionClosedSchema.parse({
      ...events[2],
      event_id: uuid(9005),
      occurred_at_utc: '2026-03-02T09:59:40.000Z',
    });
    const run = await sessionHarness({ events: [...events, again] });
    expect(run.sockets).toEqual([]);

    expect((await run.done).end).toEqual({
      detail: 'TypeError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expectRefusedLog(run, 4);
  });

  it.each<[string, boolean]>([
    ['al abrir el log, el objeto de un evento del segmento abierto', false],
    ['al leer el log, el objeto de un segmento cerrado', true],
  ])(
    'si %s no pasa sus comprobaciones, termina failed con log_not_derivable sin conectar ni reintentar',
    async (_label, closeSegment) => {
      const run = await sessionHarness({
        beforeStart: ({ objects, sourceLog }) => {
          const segment = sourceLog.closed[0];
          const row = sourceLog.rows[1];
          alterObject(
            objects,
            contentKey(
              closeSegment ? (segment?.object_bytes_sha256 ?? '') : (row?.object_sha256 ?? ''),
            ),
          );
        },
        closeSegment,
        events: previousConnectionEvents(),
      });

      expect((await run.done).end).toEqual({
        detail: 'LogIntegrityError',
        reason: 'log_not_derivable',
        status: 'failed',
      });
      expectRefusedLog(run, 3, closeSegment ? 1 : 0);
    },
  );

  it('si los ticks del log son de otro símbolo, termina failed con symbol_mismatch sin conectar', async () => {
    const [opened, tick, closed] = previousConnectionEvents();
    const other = rawSourceFrameSchema.parse({
      ...tick,
      payload_utf8: derivMessages.tick(2, START_EPOCH - 60, '100.25', 'SYNTH_50'),
      raw_payload_sha256: sha256Hex(derivMessages.tick(2, START_EPOCH - 60, '100.25', 'SYNTH_50')),
    });
    const closedOther = connectionClosedSchema.parse({ ...closed, affected_symbols: ['SYNTH_50'] });
    const run = await sessionHarness({ events: [opened, other, closedOther].filter(isEvent) });
    expect(run.sockets).toEqual([]);

    expect((await run.done).end).toEqual({
      detail: null,
      reason: 'symbol_mismatch',
      status: 'failed',
    });
    expectRefusedLog(run, 3);
  });

  it('con un frame de tick del símbolo pedido que no cumple el esquema (schema_validation_failed), conecta: symbol_mismatch es solo para ticks de otro símbolo', async () => {
    const [opened, tick, closed] = previousConnectionEvents();
    // Sin `pip_size`, que el esquema de `ticks` exige: un frame inválido, pero de SYNTH_100.
    const payload = `{"echo_req":{"req_id":2,"subscribe":1,"ticks":"SYNTH_100"},"msg_type":"tick","req_id":2,"subscription":{"id":"sub-1"},"tick":{"epoch":${String(START_EPOCH - 50)},"id":"sub-1","quote":100.5,"symbol":"SYNTH_100"}}`;
    const invalid = rawSourceFrameSchema.parse({
      ...tick,
      observation_id: uuid(9006),
      payload_utf8: payload,
      raw_payload_sha256: sha256Hex(payload),
      received_at_utc: '2026-03-02T09:59:10.000Z',
    });
    const run = await sessionHarness({ events: [opened, tick, invalid, closed].filter(isEvent) });

    expect(run.sockets).toHaveLength(1);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('con un log del símbolo pedido, que pasa las comprobaciones, conecta y supera su última conexión', async () => {
    const run = await sessionHarness({ events: previousConnectionEvents() });
    expect(run.sockets).toHaveLength(1);
    run.socket(1).open();
    await settle();
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: PREVIOUS,
    });
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it.each<[string, (sourceLog: MemorySourceLogStore) => void]>([
    [
      'al abrir el log',
      (sourceLog) => {
        vi.spyOn(sourceLog, 'readLogState').mockRejectedValueOnce(unavailable());
      },
    ],
    [
      'al leer sus segmentos cerrados',
      (sourceLog) => {
        vi.spyOn(sourceLog, 'listClosedSegments').mockRejectedValueOnce(unavailable());
      },
    ],
  ])('si un almacén no responde %s, avisa, espera y lo intenta otra vez', async (_label, fail) => {
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        fail(sourceLog);
      },
      closeSegment: true,
      events: previousConnectionEvents(),
    });
    expect(run.sockets).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([500]);
    expect(run.alerts).toEqual([{ event: 'source_log_unavailable', reason: 'ECONNREFUSED' }]);

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    expect(run.openedWith).toEqual([run.provider.lock(1), run.provider.lock(1)]);
    // Al arrancar no se intentó escribir nada: no hay incidencia de persistencia.
    expect(run.operational.incidents).toEqual([]);
    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500]);
  });

  it('un error al abrir el log que no es de un almacén ni del contenido se rechaza después de soltar el bloqueo', async () => {
    const bug = new TypeError('sintético');
    const run = await sessionHarness({
      beforeStart: () => {
        vi.spyOn(SourceEventLog, 'open').mockRejectedValueOnce(bug);
      },
    });

    await expect(run.done).rejects.toBe(bug);
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.sockets).toEqual([]);
  });
});

describe('startDerivSession: cómo terminó cada conexión (ADR-0015 §3)', () => {
  it('completed, por la parada durante la conexión: pide forget_all, cierra con requested y el segmento con requested, suelta el bloqueo y termina completed sin reconectar', async () => {
    const run = await sessionHarness();
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    await run.subscribe(run.socket(1), START_EPOCH);
    run.session.stop();
    // Catálogo (`req_id` 1) y suscripción (2): `forget_all` lleva el 3.
    expect(run.socket(1).requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 3 });
    run.socket(1).text(derivMessages.forgetAll(3));

    const result = await run.done;
    expect(result).toEqual({
      catalog: expect.objectContaining({ status: 'created', version: 1 }) as unknown,
      connections: [
        {
          closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
          connection_id: uuid(1),
          end: { status: 'completed' },
        },
      ],
      end: { status: 'completed' },
      // El log estaba vacío: no hay hueco que recuperar.
      recoveries: [],
      schemas: {
        archive_sha256: run.fixture.expected.archive_sha256,
        release: 'synthetic-deriv-1',
      },
      server_time_offset_ms: null,
      subscription_id: 'sub-1',
      waits_ms: [],
    });
    expect(run.socket(1).ended).toBe('close');
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 el tick, 5 forget_all y 6 el cierre.
    expect(run.sourceLog.closed).toEqual([
      expect.objectContaining({ close_reason: 'requested', event_count: 5, segment_index: 0 }),
    ]);
    expect((await run.events()).at(-1)).toMatchObject({
      closure_type: 'requested',
      event_id: uuid(6),
      kind: 'connection_closed',
      reason: 'requested',
    });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('failed: termina failed con el motivo y el dato de la conexión, sin esperar ni reconectar, y cierra el segmento con requested', async () => {
    const run = await sessionHarness();
    run.socket(1).open();
    await settle();
    // Un catálogo vacío no deja snapshot válido (ADR-0012 §7).
    run.socket(1).text(derivMessages.catalog(1, []));

    const result = await run.done;
    expect(result.end).toEqual({
      detail: 'catalog_empty',
      reason: 'catalog_invalid',
      status: 'failed',
    });
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'catalog_invalid' },
        connection_id: uuid(1),
        end: { detail: 'catalog_empty', reason: 'catalog_invalid', status: 'failed' },
      },
    ]);
    expect(result.waits_ms).toEqual([]);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['requested']);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('disconnected: reconecta después de la espera, y la conexión nueva supera a la anterior del log', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();

    // Intento 1, con `random` 0: d = 1000 ms y la espera, d/2.
    expect(run.clock.pendingDelays()).toEqual([500]);
    await run.clock.advance(499);
    expect(run.sockets).toHaveLength(1);
    await run.clock.advance(1);
    expect(run.sockets).toHaveLength(2);
    run.socket(2).open();
    await settle();
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'connection_opened',
      occurred_at_utc: '2026-03-02T10:00:00.500Z',
      supersedes_connection_id: uuid(1),
    });

    run.session.stop();
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.waits_ms).toEqual([500]);
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'remote', persisted: true, reason: 'close_code_1001' },
        connection_id: uuid(1),
        end: { detail: '1001', reason: 'remote_closed', status: 'disconnected' },
      },
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
        connection_id: uuid(6),
        end: { status: 'completed' },
      },
    ]);
    // Los datos de la última conexión: no llegó a pedir el catálogo.
    expect(result.catalog).toBeNull();
    expect(result.subscription_id).toBeNull();
  });

  it('paused por persistencia: espera y, antes del socket siguiente, repara el cierre que no quedó durable; ese cierre resuelve persistence_unavailable y la apertura reabre la entrada', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    // El segundo tick no queda durable: el log falla y la conexión termina en pausa.
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    expect(run.registry.openConditionTypes()).toEqual(['persistence_unavailable']);
    expect(run.clock.pendingDelays()).toEqual([500]);

    await run.clock.advance(500);
    // El cierre reparado ya es durable; el intento espera 1 ms para pasarlo, todavía sin socket.
    expect(run.sockets).toHaveLength(1);
    expect(run.registry.openConditionTypes()).toEqual([]);
    await run.clock.advance(1);
    expect(run.sockets).toHaveLength(2);
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 el tick y 5 y 6 el tick y el cierre que no
    // quedaron durables; 7 el cierre reparado, el último evento cuando se abre el socket.
    const events = await run.events();
    expect(run.rowsAtConnect).toEqual([0, 4]);
    expect(events[3]).toEqual({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'transport_error',
      connection_id: uuid(1),
      event_id: uuid(7),
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T10:00:00.500Z',
      reason: 'close_not_recorded',
      schema_version: '1.0.0',
      source: 'deriv_options',
    });
    run.socket(2).open();
    await settle();
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: uuid(1),
    });
    // La entrada está abierta: la conexión pide el catálogo.
    expect(run.socket(2).requests()).toEqual([{ active_symbols: 'brief', req_id: 1 }]);

    run.session.stop();
    const result = await run.done;
    expect(result.connections[0]).toEqual({
      closure: {
        closure_type: 'transport_error',
        persisted: false,
        reason: 'persistence_unavailable',
      },
      connection_id: uuid(1),
      end: { detail: 'raw_object_write', reason: 'persistence_unavailable', status: 'paused' },
    });
    expect(result.waits_ms).toEqual([500]);
  });

  it('si el cierre reparado tampoco queda durable, no abre el socket: espera otra vez, con el intento siguiente, y lo vuelve a intentar', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    // El objeto del cierre reparado tampoco se escribe.
    run.objects.armNextPutFailure('synthetic_put_failure');
    await run.clock.advance(500);

    expect(run.sockets).toHaveLength(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    expect(run.clock.pendingDelays()).toEqual([1000]);
    await run.clock.advance(1000);
    await run.clock.advance(1);
    expect(run.sockets).toHaveLength(2);
    expect((await run.events()).at(-1)).toMatchObject({
      connection_id: uuid(1),
      reason: 'close_not_recorded',
    });

    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500, 1000]);
  });

  it('un intento cuyo ConnectionOpened no quedó durable no existe para el log: la conexión siguiente supera a la anterior durable', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    await run.clock.advance(500);
    // La apertura de la segunda conexión no queda durable: termina en pausa, sin cierre en el log.
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket(2).open();
    await settle();
    expect(run.clock.pendingDelays()).toEqual([1000]);
    await run.clock.advance(1000);
    run.socket(3).open();
    await settle();

    // IDs: la segunda conexión es la 6; la tercera, la 10.
    const opened = (await run.events()).filter((event) => event.kind === 'connection_opened');
    expect(
      opened.map((event) => [event.connection_id, event.supersedes_connection_id] as const),
    ).toEqual([
      [uuid(1), null],
      [uuid(10), uuid(1)],
    ]);
    // Nada que reparar: la conexión 6 no existe para el log.
    expect((await run.events()).filter((event) => event.kind === 'connection_closed')).toEqual([
      expect.objectContaining({ connection_id: uuid(1), reason: 'close_code_1001' }),
    ]);

    run.session.stop();
    const result = await run.done;
    expect(result.connections.map((connection) => connection.connection_id)).toEqual([
      uuid(1),
      uuid(6),
      uuid(10),
    ]);
    expect(result.waits_ms).toEqual([500, 1000]);
  });
});

describe('startDerivSession: el bloqueo de la fuente (ADR-0015 §3, «Bloqueo»)', () => {
  it('si otro proceso tiene el bloqueo, termina failed con source_lock_taken, sin abrir el log ni conectar', async () => {
    const run = await sessionHarness({ locks: ['taken'] });

    const result = await run.done;
    expect(result.end).toEqual({ detail: null, reason: 'source_lock_taken', status: 'failed' });
    expect(result.schemas).not.toBeNull();
    expect(run.timeline).toEqual(['acquire:taken']);
    expect(run.openedWith).toEqual([]);
  });

  it('si PostgreSQL no responde al tomarlo, avisa, espera y lo intenta otra vez antes de abrir el log', async () => {
    const run = await sessionHarness({ locks: ['unavailable'] });
    expect(run.timeline).toEqual(['acquire:unavailable']);
    expect(run.openedWith).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([500]);
    // Una alerta saneada por intento fallido: el motivo, nunca el mensaje.
    expect(run.alerts).toEqual([{ event: 'source_lock_unavailable', reason: 'ECONNREFUSED' }]);

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:unavailable', 'acquire:1', 'connect:1']);
    expect(run.openedWith).toEqual([run.provider.lock(1)]);
    expect(run.alerts).toHaveLength(1);
    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500]);
  });

  it.each<[string, unknown, string]>([
    [
      'su código',
      Object.assign(
        new Error('password authentication failed for user "buoh_owner" at db.internal:5432'),
        { code: '28P01' },
      ),
      '28P01',
    ],
    [
      'sin código, su nombre',
      new Error('connect ECONNREFUSED 10.0.0.5:5432 (role "buoh_owner", database "buoh")'),
      'Error',
    ],
  ])(
    'el motivo de la alerta sale saneado de la causa del proveedor, nunca de su mensaje, aunque sea el texto de un error de PostgreSQL: %s',
    async (_label, cause, reason) => {
      const run = await sessionHarness({ locks: [{ unavailable: cause }] });

      expect(run.alerts).toEqual([{ event: 'source_lock_unavailable', reason }]);
      run.session.stop();
      expect((await run.done).end).toEqual({ status: 'completed' });
    },
  );

  it('un rechazo de acquire que no es SourceLockUnavailableError es de programación: la sesión se rechaza con él, sin esperar ni abrir el log', async () => {
    const run = await sessionHarness({ locks: ['bug'] });

    await expect(run.done).rejects.toBe(LOCK_BUG);
    expect(run.timeline).toEqual(['acquire:bug']);
    expect(run.openedWith).toEqual([]);
    expect(run.alerts).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si acquire devuelve un bloqueo que ya no está tomado, lo suelta, avisa y espera antes de intentarlo otra vez, sin abrir el log con él', async () => {
    const run = await sessionHarness({ locks: ['lost'] });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.openedWith).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([500]);
    expect(run.alerts).toEqual([{ event: 'source_lock_unavailable', reason: 'source_lock_lost' }]);

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'release:1', 'acquire:2', 'connect:1']);
    expect(run.openedWith).toEqual([run.provider.lock(2)]);
    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500]);
  });

  it('si se pierde mientras espera para volver a abrir el log al arrancar, toma uno nuevo y abre el log con él', async () => {
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        vi.spyOn(sourceLog, 'readLogState').mockRejectedValueOnce(unavailable());
      },
    });
    expect(run.timeline).toEqual(['acquire:1']);
    expect(run.clock.pendingDelays()).toEqual([500]);
    run.provider.lock(1).lose();

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'release:1', 'acquire:2', 'connect:1']);
    expect(run.openedWith).toEqual([run.provider.lock(1), run.provider.lock(2)]);
    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500]);
  });

  it('si se pierde durante una conexión, la escritura falla, la conexión termina en pausa y la sesión toma uno nuevo antes del socket siguiente: el log se reabre con él y el cierre se repara', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.provider.lock(1).lose();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: 'source_lock_lost', stage: 'source_event_index' },
        incident_type: 'persistence_unavailable',
      }),
    ]);

    await run.clock.advance(500);
    await run.clock.advance(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:2', 'connect:2']);
    expect(run.openedWith).toEqual([run.provider.lock(1), run.provider.lock(2)]);
    expect((await run.events()).at(-1)).toMatchObject({
      connection_id: uuid(1),
      reason: 'close_not_recorded',
    });
    run.socket(2).open();
    await settle();
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: uuid(1),
    });

    run.session.stop();
    await run.done;
    expect(run.provider.lock(2).released).toBe(true);
  });

  it('si se pierde sin conexión, durante la espera, toma uno nuevo y reabre el log con él antes de escribir: la apertura siguiente queda durable sin fallar antes', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:2', 'connect:2']);
    run.socket(2).open();
    await settle();
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: uuid(1),
    });
    expect(run.operational.incidents).toEqual([]);
    expect(run.socket(2).requests()).toEqual([{ active_symbols: 'brief', req_id: 1 }]);

    run.session.stop();
    await run.done;
  });

  it('después de tomar uno nuevo vuelve a leer la conexión anterior del log: supera la que abrió otro proceso mientras tanto, y repara su cierre', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    // Otro proceso toma el bloqueo, abre su conexión y cae sin cerrarla.
    const other = await run.unlockedLog();
    await other.append(
      connectionOpenedSchema.parse({
        connection_id: OTHER,
        event_id: uuid(8001),
        kind: 'connection_opened',
        occurred_at_utc: '2026-03-02T10:00:00.100Z',
        schema_version: '1.0.0',
        source: 'deriv_options',
        supersedes_connection_id: uuid(1),
      }),
    );

    await run.clock.advance(500);
    await run.clock.advance(1);
    expect(run.sockets).toHaveLength(2);
    run.socket(2).open();
    await settle();
    expect((await run.events()).slice(-3)).toEqual([
      expect.objectContaining({ connection_id: OTHER, kind: 'connection_opened' }),
      expect.objectContaining({
        connection_id: OTHER,
        kind: 'connection_closed',
        occurred_at_utc: '2026-03-02T10:00:00.500Z',
        reason: 'close_not_recorded',
      }),
      expect.objectContaining({ kind: 'connection_opened', supersedes_connection_id: OTHER }),
    ]);
    expect(run.operational.incidents).toEqual([]);

    run.session.stop();
    await run.done;
  });

  it('si al tomar uno nuevo lo tiene otro proceso, termina failed con source_lock_taken, sin otro socket ni escribir en el log ni en el registro operativo', async () => {
    const run = await sessionHarness({ locks: ['lock', 'taken'] });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    const rows = run.sourceLog.rows.length;

    await run.clock.advance(500);
    const result = await run.done;
    expect(result.end).toEqual({ detail: null, reason: 'source_lock_taken', status: 'failed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:taken']);
    expect(run.sourceLog.rows).toHaveLength(rows);
    expect(run.sourceLog.closed).toEqual([]);
    // Sin el bloqueo no intenta cerrar el segmento: esa escritura fallaría y dejaría un
    // persistence_unavailable que no corresponde a ninguna pérdida.
    expect(run.operational.incidents).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('si al tomar uno nuevo PostgreSQL no responde, avisa, espera con el intento siguiente y lo vuelve a intentar', async () => {
    const run = await sessionHarness({ locks: ['lock', 'unavailable'] });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();

    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:unavailable']);
    expect(run.alerts).toEqual([{ event: 'source_lock_unavailable', reason: 'ECONNREFUSED' }]);
    expect(run.clock.pendingDelays()).toEqual([1000]);
    await run.clock.advance(1000);
    expect(run.timeline.slice(-2)).toEqual(['acquire:2', 'connect:2']);

    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500, 1000]);
  });
});

describe('startDerivSession: la espera entre intentos (ADR-0015 §3, «Espera»)', () => {
  it.each<[string, () => number, number[]]>([
    ['0', () => 0, [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]],
    [
      'el mayor valor por debajo de 1',
      () => 1 - 2 ** -53,
      [999, 1999, 3999, 7999, 15_999, 31_999, 59_999, 59_999],
    ],
  ])(
    'con random %s, el intento n espera d/2 + random · d/2, con d = mín(60 000, 1000 · 2^(n−1)) ms',
    async (_label, random, waits) => {
      // Ocho intentos seguidos que no conectan; el noveno abre su socket.
      const run = await sessionHarness({ failingConnects: 8, random });
      const connects = () => run.timeline.filter((entry) => entry.startsWith('connect')).length;

      for (const [index, wait] of waits.entries()) {
        expect(run.clock.pendingDelays()).toEqual([wait]);
        await run.clock.advance(wait - 1);
        expect(connects()).toBe(index + 1);
        await run.clock.advance(1);
        expect(connects()).toBe(index + 2);
      }
      expect(run.sockets).toHaveLength(1);

      run.session.stop();
      const result = await run.done;
      expect(result.waits_ms).toEqual(waits);
      expect(result.connections).toHaveLength(9);
      expect(result.connections[0]).toEqual({
        closure: null,
        connection_id: null,
        end: { detail: 'ECONNREFUSED', reason: 'connect_failed', status: 'disconnected' },
      });
    },
  );

  it.each<[string, string, number, number]>([
    ['60 000', '500', 60_000, 500],
    ['59 999', '2000', 59_999, 2000],
  ])(
    'después de una conexión que tuvo ticks durables durante %s ms, la espera es de %s ms: el contador vuelve a 1 solo tras 60 000 ms',
    async (_connected, _wait, connectedMs, wait) => {
      // Dos intentos que no conectan dejan el contador en 3, tras esperas de 500 y 1000 ms.
      const run = await sessionHarness({ answerPings: true, failingConnects: 2 });
      await run.clock.advance(500);
      await run.clock.advance(1000);
      await run.subscribe(run.socket(1), START_EPOCH + 1);
      // Cuenta desde el primer tick durable, no desde el último.
      await run.clock.advance(30_000);
      run.socket(1).text(derivMessages.tick(2, START_EPOCH + 31, '100.5'));
      await settle();
      await run.clock.advance(connectedMs - 30_000);
      run.socket(1).emit({ code: 1001, kind: 'closed' });
      await settle();

      expect(run.clock.pendingDelays()).toEqual([wait]);
      await run.clock.advance(wait);
      expect(run.sockets).toHaveLength(2);
      run.session.stop();
      expect((await run.done).waits_ms).toEqual([500, 1000, wait]);
    },
  );

  it('solo cuentan los ticks de la conexión que termina: los de una anterior no devuelven el contador a 1', async () => {
    const run = await sessionHarness();
    // El primer tick durable de la primera conexión, a las 10:00:00; se pierde 1000 ms después.
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(1000);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    // Las cinco conexiones siguientes nunca abren: cada una vence a los 10 000 ms, tras esperas de
    // 500, 1000, 2000, 4000 y 8000 ms. La sexta vence 66 500 ms después de aquel tick.
    await run.clock.advance(65_500);

    expect(run.sockets).toHaveLength(6);
    expect(run.clock.pendingDelays()).toEqual([16_000]);
    run.session.stop();
    expect((await run.done).waits_ms).toEqual([500, 1000, 2000, 4000, 8000, 16_000]);
  });
});

describe('startDerivSession: la parada fuera de una conexión (ADR-0015 §3, «Parada»)', () => {
  it('durante la espera entre intentos, la cancela y termina completed sin otro socket: cierra el segmento con requested y suelta el bloqueo', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    expect(run.clock.pendingDelays()).toEqual([500]);
    run.session.stop();
    await settle();

    expect(run.clock.pendingDelays()).toEqual([]);
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.waits_ms).toEqual([500]);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['requested']);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('durante la espera para volver a tomar el bloqueo, la cancela y termina completed sin abrir el log', async () => {
    const run = await sessionHarness({ locks: ['unavailable'] });
    expect(run.clock.pendingDelays()).toEqual([500]);
    run.session.stop();
    await settle();

    expect(run.clock.pendingDelays()).toEqual([]);
    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:unavailable']);
    expect(run.openedWith).toEqual([]);
  });

  it('durante la espera para pasar el cierre anterior, la corta sin abrir el socket y termina completed', async () => {
    // La conexión anterior se cerró con un reloj adelantado: el intento espera en tramos.
    const [opened, tick, closed] = previousConnectionEvents();
    const ahead = connectionClosedSchema.parse({
      ...closed,
      occurred_at_utc: '2026-03-02T10:02:30.000Z',
    });
    const run = await sessionHarness({ events: [opened, tick, ahead].filter(isEvent) });
    expect(run.clock.pendingDelays()).toEqual([60_000]);
    expect(run.alerts).toEqual([
      expect.objectContaining({
        event: 'clock_behind_log',
        previous_close_utc: ahead.occurred_at_utc,
      }),
    ]);
    run.session.stop();
    await settle();

    expect(run.clock.pendingDelays()).toEqual([]);
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections).toEqual([]);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['requested']);
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    await run.clock.advance(600_000);
    expect(run.sockets).toEqual([]);
  });

  it('mientras toma el bloqueo al arrancar, termina completed sin abrir el log y suelta el bloqueo que tomó', async () => {
    const run = await sessionHarness({ stopOnAcquire: 1 });

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.openedWith).toEqual([]);
  });

  it('mientras abre el log al arrancar, termina completed sin conectar: cierra el segmento con requested', async () => {
    const run = await sessionHarness({ events: previousConnectionEvents(), stopOnOpenLog: 1 });

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.sourceLog.closed).toEqual([
      expect.objectContaining({ close_reason: 'requested', event_count: 3 }),
    ]);
  });

  it('mientras suelta el bloqueo perdido, termina completed sin tomar otro', async () => {
    const run = await sessionHarness({ stopOnRelease: 1 });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    await run.clock.advance(500);

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });

  it('mientras vuelve a tomar el bloqueo, termina completed sin otro socket: con el bloqueo nuevo, reabre el log y cierra el segmento con requested', async () => {
    const run = await sessionHarness({ stopOnAcquire: 2 });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    await run.clock.advance(500);

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:2', 'release:2']);
    // La apertura, el catálogo, el tick y el cierre remoto de la conexión.
    expect(run.sourceLog.closed).toEqual([
      expect.objectContaining({ close_reason: 'requested', event_count: 4, segment_index: 0 }),
    ]);
    expect(run.openedWith).toEqual([run.provider.lock(1), run.provider.lock(2)]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('mientras vuelve a tomar el bloqueo, si al reabrir el log con el bloqueo nuevo su contenido no pasa las comprobaciones, termina failed con log_not_derivable sin cerrar el segmento, y suelta el bloqueo', async () => {
    const run = await sessionHarness({ stopOnAcquire: 2 });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    // Mientras la sesión espera, cambia el objeto del primer tick, en el segmento abierto.
    alterObject(run.objects, contentKey(run.sourceLog.rows[2]?.object_sha256 ?? ''));
    await run.clock.advance(500);

    expect((await run.done).end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.sourceLog.closed).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:2', 'release:2']);
    expect(run.openedWith).toEqual([run.provider.lock(1), run.provider.lock(2)]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si llega mientras se crea el socket, la conexión nueva se cierra enseguida con requested', async () => {
    const run = await sessionHarness({ stopOnConnect: 1 });

    expect(run.socket(1).ended).toBe('close');
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections).toEqual([
      { closure: null, connection_id: null, end: { status: 'completed' } },
    ]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });

  it('si después de la parada la conexión termina disconnected, porque forget_all no respondió, no reconecta: termina completed', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.session.stop();
    await run.clock.advance(15_000);

    expect(run.clock.pendingDelays()).toEqual([]);
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections[0]?.end).toEqual({
      detail: 'forget_all',
      reason: 'request_timeout',
      status: 'disconnected',
    });
    expect(result.waits_ms).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });
});

describe('startDerivSession: errores', () => {
  it('si al reabrir el log para reparar el cierre su contenido no pasa las comprobaciones, termina failed con log_not_derivable, sin otro socket ni cerrar el segmento', async () => {
    const run = await sessionHarness();
    await run.subscribe(run.socket(1), START_EPOCH);
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    // Mientras la sesión espera, cambia el objeto del primer tick, en el segmento abierto.
    alterObject(run.objects, contentKey(run.sourceLog.rows[2]?.object_sha256 ?? ''));

    await run.clock.advance(500);
    const result = await run.done;
    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.sockets).toHaveLength(1);
    expect(run.sourceLog.closed).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });

  it('si la conexión se rechaza con LogIntegrityError, termina failed con log_not_derivable, sin otro socket ni cerrar el segmento', async () => {
    const run = await sessionHarness({
      onTick: () => {
        throw new LogIntegrityError('sintético');
      },
    });
    await run.subscribe(run.socket(1), START_EPOCH);

    expect((await run.done).end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.socket(1).ended).toBe('terminate');
    expect(run.sourceLog.closed).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });

  it('si la conexión se rechaza con otro error, es de programación: la sesión suelta el bloqueo y se rechaza con él, sin reconectar', async () => {
    const bug = new TypeError('sintético');
    const run = await sessionHarness({
      onTick: () => {
        throw bug;
      },
    });
    await run.subscribe(run.socket(1), START_EPOCH);

    await expect(run.done).rejects.toBe(bug);
    expect(run.sourceLog.closed).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it.each([1, -0.25, Number.NaN])(
    'un random que da %s, fuera de [0, 1), es un error de programación: la sesión suelta el bloqueo y se rechaza con TypeError',
    async (value) => {
      const run = await sessionHarness({ random: () => value });
      await run.subscribe(run.socket(1), START_EPOCH);
      run.socket(1).emit({ code: 1001, kind: 'closed' });
      await settle();

      // Ninguna espera fuera de [d/2, d): ni d, ni negativa, ni sin número.
      expect(run.clock.pendingDelays()).toEqual([]);
      await expect(run.done).rejects.toThrow(TypeError);
      expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    },
  );
});
