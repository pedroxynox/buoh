import {
  connectionClosedSchema,
  connectionOpenedSchema,
  type IngestionCursor,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settle, START_EPOCH, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
import {
  holdObjectWrites,
  PREVIOUS,
  previousConnectionEvents,
} from './support/recovery-harness.js';
import { lockPid, sessionHarness, type SessionRun } from './support/session-harness.js';

// El cursor, el latido y la retención de la sesión de ingesta (ADR-0015 §6 y §7). Reloj y
// temporizador manuales, sockets falsos, IDs secuenciales, `random` inyectado, almacenes en memoria,
// esquemas sintéticos y un bloqueo en memoria; ningún precio es de mercado.

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

/** 23 horas, la retención que pasa `ingest` (ADR-0015 §7). */
const RETENTION_MS = 23 * 3_600_000;

/** Las peticiones `forget_all` que envió el socket. */
const forgetAll = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'forget_all' in request);

/**
 * El log de una ejecución anterior cuyo primer evento es de `firstAt`: una conexión que se abrió
 * entonces y se cerró a las 09:59:30 con un cierre pedido, sin suscribirse.
 */
function logSince(firstAt: string): SourceEvent[] {
  return [
    connectionOpenedSchema.parse({
      connection_id: PREVIOUS,
      event_id: uuid(9002),
      kind: 'connection_opened',
      occurred_at_utc: firstAt,
      schema_version: '1.0.0',
      source: 'deriv_options',
      supersedes_connection_id: null,
    }),
    connectionClosedSchema.parse({
      affected_symbols: [],
      closure_type: 'requested',
      connection_id: PREVIOUS,
      event_id: uuid(9004),
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T09:59:30.000Z',
      reason: 'requested',
      schema_version: '1.0.0',
      source: 'deriv_options',
    }),
  ];
}

describe('startDerivSession: la parada por retención (ADR-0015 §7)', () => {
  it('con un log que no está vacío, para como con stop cuando su evento durable más antiguo cumple retentionMs: forget_all, cierre requested, segmento cerrado con requested, bloqueo suelto y stopped_for_retention en true', async () => {
    // El primer evento del log es de las 11:00:30 del día anterior: cumple 23 horas a las 10:00:30.
    const run = await sessionHarness({
      events: logSince('2026-03-01T11:00:30.000Z'),
      retentionMs: RETENTION_MS,
    });
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(29_999);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    // Catálogo (`req_id` 1) y suscripción (2): `forget_all` lleva el 3.
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    run.socket(1).text(derivMessages.forgetAll(3));

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.stopped_for_retention).toBe(true);
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 el tick, 5 forget_all y 6 el cierre.
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
        connection_id: uuid(1),
        end: { status: 'completed' },
      },
    ]);
    // El primero lo rotó la ventana al seguir el cierre 23 horas después de la apertura.
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual([
      'window',
      'requested',
    ]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('con un log vacío, cuenta retentionMs desde la hora del primer evento durable de la sesión', async () => {
    const run = await sessionHarness({ answerPings: true, retentionMs: 120_000 });
    // El socket abre a las 10:00:01: su ConnectionOpened, el primer evento del log, lleva esa hora,
    // pero queda durable 5000 ms después. La retención se cumple a las 10:02:01.
    await run.clock.advance(1000);
    const writes = holdObjectWrites(run.objects);
    run.socket(1).open();
    await settle();
    await run.clock.advance(5000);
    writes.release();
    await settle();
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 6));
    await settle();
    await run.clock.advance(114_999);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    // Entre tanto, el keepalive pidió dos `ping` (`req_id` 3 y 4).
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 5 }]);
    run.socket(1).text(derivMessages.forgetAll(5));

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.stopped_for_retention).toBe(true);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['requested']);
  });

  it('si retentionMs se cumple mientras espera para reconectar, corta la espera y termina completed sin otro socket', async () => {
    // Cumple 23 horas a las 10:00:01.200, durante la espera que sigue al cierre de las 10:00:01.
    const run = await sessionHarness({
      events: logSince('2026-03-01T11:00:01.200Z'),
      retentionMs: RETENTION_MS,
    });
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(1000);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    expect(run.clock.pendingDelays()).toEqual([200, 500]);
    await run.clock.advance(200);

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.stopped_for_retention).toBe(true);
    expect(result.waits_ms).toEqual([500]);
    expect(run.sourceLog.closed.at(-1)?.close_reason).toBe('requested');
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
  });

  it('una parada antes de cumplirse la cancela: stopped_for_retention es false y no queda ningún temporizador', async () => {
    const run = await sessionHarness({
      events: logSince('2026-03-01T11:00:30.000Z'),
      retentionMs: RETENTION_MS,
    });
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(10_000);
    run.session.stop();
    run.socket(1).text(derivMessages.forgetAll(3));

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.stopped_for_retention).toBe(false);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('vuelve a mirar el reloj cada 60 000 ms como mucho: un salto del reloj hacia delante se nota en un minuto', async () => {
    // Cumple 23 horas a las 10:10:00; el reloj salta 10 minutos hacia delante enseguida.
    const run = await sessionHarness({
      answerPings: true,
      events: logSince('2026-03-01T11:10:00.000Z'),
      retentionMs: RETENTION_MS,
    });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.clock.jumpWallClock(600_000);
    await run.clock.advance(59_999);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    // El keepalive pidió un `ping` a los 45 000 ms (`req_id` 3).
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);
    run.socket(1).text(derivMessages.forgetAll(4));

    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.stopped_for_retention).toBe(true);
  });
});

/** El cursor de SYNTH_100 en la fuente `deriv_options`, con los campos que cambian en cada prueba. */
const cursorOf = (
  fields: Pick<
    IngestionCursor,
    | 'active_segment_index'
    | 'connection_id'
    | 'high_watermark_event_time_utc'
    | 'last_durable_observation_id'
    | 'last_durable_source_event_id'
    | 'source_event_count'
    | 'updated_at_utc'
  >,
): IngestionCursor => ({
  ...fields,
  schema_version: '1.0.0',
  source: 'deriv_options',
  symbol: 'SYNTH_100',
});

/** Los cursores que escribió la sesión, en orden. */
const cursors = (run: SessionRun) => run.status?.cursors.map((item) => item.cursor) ?? [];

/** Para la sesión y responde el `forget_all` de la parada, con el `req_id` que le toca. */
async function stopSession(run: SessionRun, socket: FakeDerivSocket, reqId: number) {
  await stopSessionWithoutWaiting(run, socket, reqId);
  return run.done;
}

/** Como `stopSession`, pero sin esperar a `done`: deja correr lo que sigue al cierre pedido. */
async function stopSessionWithoutWaiting(run: SessionRun, socket: FakeDerivSocket, reqId: number) {
  run.session.stop();
  expect(forgetAll(socket)).toEqual([{ forget_all: 'ticks', req_id: reqId }]);
  socket.text(derivMessages.forgetAll(reqId));
  await settle();
  await settle();
}

/** Un error de PostgreSQL: su código y un mensaje con texto del servidor, que no sale en la alerta. */
const postgresError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe('startDerivSession: el cursor (ADR-0015 §6)', () => {
  it('después de un cierre durable escribe el cursor del símbolo con el estado durable: la conexión, el segmento abierto, los eventos, el último evento y el último raw, el high-watermark y la hora', async () => {
    // Sin PID en el bloqueo no hay latidos: los IDs son solo los del log, después del de la ejecución.
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    // IDs: 1 la ejecución, 2 la conexión, 3 su apertura, 4 el catálogo y 5 el tick de las 10:00:00.
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(2000);
    // 6, el tick de las 10:00:02.
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    expect(cursors(run)).toEqual([]);
    await run.clock.advance(1000);
    // 7, el cierre del servidor.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();

    expect(run.status?.cursors).toEqual([
      {
        cursor: cursorOf({
          active_segment_index: 0,
          connection_id: uuid(2),
          high_watermark_event_time_utc: '2026-03-02T10:00:02.000Z',
          last_durable_observation_id: uuid(6),
          last_durable_source_event_id: uuid(7),
          source_event_count: 5,
          updated_at_utc: '2026-03-02T10:00:03.000Z',
        }),
        version: 1,
      },
    ]);
    // La ingesta sigue: reconecta.
    await run.clock.advance(500);
    expect(run.sockets).toHaveLength(2);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('después de un cierre reparado escribe el cursor con ese cierre como último evento, y nunca avanza con un evento que no quedó durable', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    // IDs: 1 la ejecución, 2 la conexión, 3 su apertura, 4 el catálogo y 5 el tick.
    await run.subscribe(run.socket(1), START_EPOCH);
    // 6, el tick siguiente, y 7, su cierre: ninguno queda durable.
    run.objects.armNextPutFailure('synthetic_put_failure');
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    expect(cursors(run)).toEqual([]);

    // 8, el cierre reparado, antes del socket siguiente.
    await run.clock.advance(500);
    expect(cursors(run)).toEqual([
      cursorOf({
        active_segment_index: 0,
        connection_id: uuid(2),
        high_watermark_event_time_utc: '2026-03-02T10:00:00.000Z',
        last_durable_observation_id: uuid(5),
        last_durable_source_event_id: uuid(8),
        source_event_count: 4,
        updated_at_utc: '2026-03-02T10:00:00.500Z',
      }),
    ]);
    await run.clock.advance(1);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('al terminar escribe el cursor una última vez, después de cerrar el segmento: con el siguiente como segmento abierto', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    // IDs: 1 la ejecución, 2 la conexión, 3 su apertura, 4 el catálogo, 5 el tick, 6 forget_all y 7
    // el cierre pedido.
    await run.subscribe(run.socket(1), START_EPOCH);
    await stopSession(run, run.socket(1), 3);

    const closed = cursorOf({
      active_segment_index: 0,
      connection_id: uuid(2),
      high_watermark_event_time_utc: '2026-03-02T10:00:00.000Z',
      last_durable_observation_id: uuid(6),
      last_durable_source_event_id: uuid(7),
      source_event_count: 5,
      updated_at_utc: '2026-03-02T10:00:00.000Z',
    });
    expect(run.status?.cursors).toEqual([
      { cursor: closed, version: 1 },
      { cursor: { ...closed, active_segment_index: 1 }, version: 2 },
    ]);
    expect(run.sourceLog.closed).toEqual([
      expect.objectContaining({ event_count: 5, segment_index: 0 }),
    ]);
  });

  it('con el log de una ejecución anterior, el cursor parte de lo que el arranque derivó: su último evento, su conexión y el high-watermark del símbolo', async () => {
    // La parada llega mientras se crea el socket: la sesión no escribe ningún evento.
    const run = await sessionHarness({
      events: previousConnectionEvents(),
      pidlessLocks: true,
      status: true,
      stopOnConnect: 1,
    });

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(cursors(run)).toEqual([
      cursorOf({
        active_segment_index: 1,
        connection_id: PREVIOUS,
        high_watermark_event_time_utc: '2026-03-02T09:59:00.000Z',
        last_durable_observation_id: uuid(9003),
        last_durable_source_event_id: uuid(9004),
        source_event_count: 3,
        updated_at_utc: '2026-03-02T10:00:00.000Z',
      }),
    ]);
  });

  it('el high-watermark es la hora del tick más tardío del símbolo: un tick fuera de orden no lo baja', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    // IDs: 1 la ejecución, 2 la conexión, 3 su apertura, 4 el catálogo y 5 el tick de las 10:00:02.
    await run.subscribe(run.socket(1), START_EPOCH + 2);
    // 6, uno de las 10:00:01, y 7, el cierre del servidor.
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 1, '100.5'));
    await settle();
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();

    expect(cursors(run)).toEqual([
      expect.objectContaining({
        high_watermark_event_time_utc: '2026-03-02T10:00:02.000Z',
        last_durable_observation_id: uuid(6),
        last_durable_source_event_id: uuid(7),
      }),
    ]);
    run.session.stop();
    await run.done;
  });

  it('done espera a las escrituras pendientes del cursor y del latido, y solo después suelta el bloqueo', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    const writes = run.status?.holdWrites();
    let finished = false;
    void run.done.then(() => {
      finished = true;
    });
    await stopSessionWithoutWaiting(run, run.socket(1), 3);

    expect(finished).toBe(false);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    writes?.release();
    await run.done;
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(cursors(run)).toHaveLength(2);
  });

  it('nunca escribe un cursor antes de que el log tenga un evento', async () => {
    const run = await sessionHarness({ failingConnects: 1, pidlessLocks: true, status: true });
    run.session.stop();

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.sourceLog.rows).toEqual([]);
    expect(cursors(run)).toEqual([]);
  });

  it('si al reabrir el log adopta un tick que el índice confirmó aunque informó error, el high-watermark lo incluye desde la derivación de la conexión siguiente', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    // IDs: 1 la ejecución, 2 la conexión, 3 su apertura, 4 el catálogo y 5 el tick de las 10:00:00.
    await run.subscribe(run.socket(1), START_EPOCH);
    // 6, el tick de las 10:00:02: el índice lo confirma, pero informa error.
    await run.clock.advance(2000);
    run.sourceLog.failIndexAfterInsert = (row) => row.event_id === uuid(6);
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 2, '100.5'));
    await settle();
    run.sourceLog.failIndexAfterInsert = () => false;

    // La reparación reabre el log, que lo adopta, y escribe 8, el cierre reparado.
    await run.clock.advance(500);
    // El tick adoptado no pasó por el sink: este cursor todavía no lo lleva en su high-watermark.
    expect(cursors(run)).toEqual([
      cursorOf({
        active_segment_index: 0,
        connection_id: uuid(2),
        high_watermark_event_time_utc: '2026-03-02T10:00:00.000Z',
        last_durable_observation_id: uuid(6),
        last_durable_source_event_id: uuid(8),
        source_event_count: 5,
        updated_at_utc: '2026-03-02T10:00:02.500Z',
      }),
    ]);
    // La conexión siguiente deriva el log al empezar, ya con el tick adoptado.
    await run.clock.advance(1);
    await settle();
    run.session.stop();
    await run.done;

    expect(cursors(run).at(-1)).toEqual(
      cursorOf({
        active_segment_index: 1,
        connection_id: uuid(2),
        high_watermark_event_time_utc: '2026-03-02T10:00:02.000Z',
        last_durable_observation_id: uuid(6),
        last_durable_source_event_id: uuid(8),
        source_event_count: 5,
        updated_at_utc: '2026-03-02T10:00:02.501Z',
      }),
    );
  });

  it('si el cursor no se puede escribir, deja la alerta ingestion_status_unavailable con el motivo saneado, nunca el texto de PostgreSQL, y la ingesta sigue', async () => {
    const run = await sessionHarness({
      beforeStart: ({ status }) => {
        if (status !== null) {
          status.failCursorWrites = true;
          status.failure = () =>
            postgresError('23514', 'buoh: la versión 3 del cursor de deriv_options y SYNTH_100');
        }
      },
      pidlessLocks: true,
      status: true,
    });
    await run.subscribe(run.socket(1), START_EPOCH);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    expect(run.alerts).toEqual([{ event: 'ingestion_status_unavailable', reason: '23514' }]);

    // Reconecta y sigue entregando ticks.
    await run.clock.advance(1000);
    await run.subscribe(run.socket(2), START_EPOCH + 1, '100.5');
    expect(run.ticks).toHaveLength(2);
    const result = await stopSession(run, run.socket(2), 3);
    expect(result.end).toEqual({ status: 'completed' });
    // También fallan el cursor del cierre pedido y el del final.
    expect(run.alerts).toEqual([
      { event: 'ingestion_status_unavailable', reason: '23514' },
      { event: 'ingestion_status_unavailable', reason: '23514' },
      { event: 'ingestion_status_unavailable', reason: '23514' },
    ]);
    expect(cursors(run)).toEqual([]);
  });
});

/** Los latidos que escribió la sesión, sin su ID. */
const heartbeats = (run: SessionRun) =>
  run.status?.heartbeats.map((heartbeat) => {
    const fields: Partial<typeof heartbeat> = { ...heartbeat };
    delete fields.heartbeat_id;
    return fields;
  }) ?? [];

/** Un latido de la ejecución `uuid(1)` en `deriv_options`, por defecto sin backlog y del bloqueo 1. */
const beat = (
  connectionState: 'connected' | 'connecting' | 'disconnected',
  observedAtUtc: string,
  fields: { readonly backlog?: readonly [number, number]; readonly lock?: number } = {},
) => ({
  backlog_bytes: fields.backlog?.[1] ?? 0,
  backlog_count: fields.backlog?.[0] ?? 0,
  connection_state: connectionState,
  observed_at_utc: observedAtUtc,
  pg_backend_pid: lockPid(fields.lock ?? 1),
  run_id: uuid(1),
  source: 'deriv_options',
});

describe('startDerivSession: el latido (ADR-0015 §6)', () => {
  it('se escribe al arrancar, al empezar cada intento, con el ConnectionOpened durable y al terminar cada intento, con el PID del bloqueo y la ejecución, un UUIDv7 del arranque', async () => {
    const run = await sessionHarness({ status: true });
    // IDs: 1 la ejecución, 2 el latido de arranque y 3 el del intento.
    expect(heartbeats(run)).toEqual([
      beat('connecting', '2026-03-02T10:00:00.000Z'),
      beat('connecting', '2026-03-02T10:00:00.000Z'),
    ]);
    // 4 la conexión, 5 su apertura, 6 el latido connected, 7 el catálogo y 8 el tick.
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(1000);
    // 9 el cierre del servidor y 10 el latido disconnected.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    // 11 el latido del intento siguiente.
    await run.clock.advance(500);
    run.session.stop();
    await run.done;

    expect(heartbeats(run)).toEqual([
      beat('connecting', '2026-03-02T10:00:00.000Z'),
      beat('connecting', '2026-03-02T10:00:00.000Z'),
      beat('connected', '2026-03-02T10:00:00.000Z'),
      beat('disconnected', '2026-03-02T10:00:01.000Z'),
      beat('connecting', '2026-03-02T10:00:01.500Z'),
      beat('disconnected', '2026-03-02T10:00:01.500Z'),
    ]);
    expect(run.status?.heartbeats.map((item) => item.heartbeat_id)).toEqual(
      [2, 3, 6, 10, 11, 12].map(uuid),
    );
  });

  it('cada 15 000 ms mientras el bloqueo siga tomado, con el estado de la conexión y el backlog de su cola por conteo y bytes', async () => {
    const run = await sessionHarness({ status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    // El primero se escribe y el segundo espera: los dos están en la cola.
    const first = derivMessages.tick(2, START_EPOCH + 1, '100.5');
    const second = derivMessages.tick(2, START_EPOCH + 2, '100.75');
    const writes = holdObjectWrites(run.objects);
    run.socket(1).text(first);
    run.socket(1).text(second);
    await settle();
    await run.clock.advance(14_999);
    expect(heartbeats(run)).toHaveLength(3);
    await run.clock.advance(1);
    expect(heartbeats(run).at(-1)).toEqual(
      beat('connected', '2026-03-02T10:00:15.000Z', {
        backlog: [2, Buffer.byteLength(first) + Buffer.byteLength(second)],
      }),
    );

    writes.release();
    await settle();
    await run.clock.advance(15_000);
    expect(heartbeats(run).at(-1)).toEqual(beat('connected', '2026-03-02T10:00:30.000Z'));
    expect(heartbeats(run)).toHaveLength(5);
    await stopSession(run, run.socket(1), 3);
  });

  it('nunca se escribe sin el bloqueo tomado: tras perderlo, ni el periódico ni el del fin del intento; el bloqueo nuevo escribe con su PID', async () => {
    const run = await sessionHarness({ status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    expect(heartbeats(run)).toHaveLength(3);
    run.provider.lock(1).lose();
    await run.clock.advance(15_000);
    // El tick siguiente no queda durable sin el bloqueo, y la conexión termina en pausa.
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 15, '100.5'));
    await settle();
    expect(heartbeats(run)).toHaveLength(3);

    // Antes del intento siguiente toma el bloqueo 2.
    await run.clock.advance(500);
    expect(heartbeats(run).at(-1)).toEqual(
      beat('connecting', '2026-03-02T10:00:15.500Z', { lock: 2 }),
    );
    await run.clock.advance(14_500);
    expect(heartbeats(run).at(-1)).toEqual(
      beat('connecting', '2026-03-02T10:00:30.000Z', { lock: 2 }),
    );
    run.session.stop();
    await run.done;
  });

  it('uno que espera detrás de otra escritura no se escribe si el bloqueo se pierde mientras tanto', async () => {
    const run = await sessionHarness({ status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    const writes = run.status?.holdWrites();
    // El periódico de las 10:00:15 empieza a escribirse con el bloqueo tomado y espera.
    await run.clock.advance(15_000);
    // El cierre del servidor encola detrás el cursor y el latido disconnected.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    run.provider.lock(1).lose();
    writes?.release();
    await settle();

    expect(heartbeats(run)).toEqual([
      beat('connecting', '2026-03-02T10:00:00.000Z'),
      beat('connecting', '2026-03-02T10:00:00.000Z'),
      beat('connected', '2026-03-02T10:00:00.000Z'),
      beat('connected', '2026-03-02T10:00:15.000Z'),
    ]);
    expect(cursors(run)).toHaveLength(1);
    run.session.stop();
    await run.done;
  });

  it('ninguno después de done: el temporizador se cancela', async () => {
    const run = await sessionHarness({ status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    await stopSession(run, run.socket(1), 3);
    const written = heartbeats(run).length;

    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(60_000);
    expect(heartbeats(run)).toHaveLength(written);
  });

  it('si no se puede escribir, deja la alerta ingestion_status_unavailable con el motivo saneado, nunca el texto de PostgreSQL, y la ingesta sigue', async () => {
    const run = await sessionHarness({
      beforeStart: ({ status }) => {
        if (status !== null) {
          status.failHeartbeatWrites = true;
          status.failure = () =>
            postgresError('57P01', 'terminating connection due to administrator command');
        }
      },
      status: true,
    });
    await run.subscribe(run.socket(1), START_EPOCH);

    expect(run.ticks).toHaveLength(1);
    // El de arranque, el del intento y el de la apertura.
    expect(run.alerts).toEqual(
      Array.from({ length: 3 }, () => ({ event: 'ingestion_status_unavailable', reason: '57P01' })),
    );
    const result = await stopSession(run, run.socket(1), 3);
    expect(result.end).toEqual({ status: 'completed' });
    expect(run.status?.heartbeats).toEqual([]);
    expect(cursors(run)).toHaveLength(2);
  });

  it('sin backendPid en el bloqueo, como en el smoke, no se escribe ninguno, pero sí el cursor', async () => {
    const run = await sessionHarness({ pidlessLocks: true, status: true });
    await run.subscribe(run.socket(1), START_EPOCH);
    await run.clock.advance(15_000);
    await stopSession(run, run.socket(1), 3);

    expect(run.status?.heartbeats).toEqual([]);
    expect(cursors(run)).toHaveLength(2);
  });
});
