import { connectionClosedSchema, connectionOpenedSchema, type SourceEvent } from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settle, START_EPOCH, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
import { PREVIOUS } from './support/recovery-harness.js';
import { sessionHarness } from './support/session-harness.js';

// La retención de la sesión de ingesta (ADR-0015 §7). Reloj y temporizador manuales, sockets falsos,
// IDs secuenciales, `random` inyectado, almacenes en memoria, esquemas sintéticos y un bloqueo en
// memoria; ningún precio es de mercado.

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

  it('con un log vacío, cuenta retentionMs desde el primer evento durable de la sesión', async () => {
    const run = await sessionHarness({ answerPings: true, retentionMs: 120_000 });
    // El socket abre a las 10:00:01: su ConnectionOpened es el primer evento durable del log.
    await run.clock.advance(1000);
    await run.subscribe(run.socket(1), START_EPOCH + 1);
    await run.clock.advance(119_999);
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
