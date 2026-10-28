import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { connectionHarness, settle, START, uuid } from './support/connection-harness.js';
import { derivMessages } from './support/deriv-fixtures.js';
import {
  E,
  forgetAllSent,
  holdObjectWrites,
  pagesSent,
  recovering,
  REQUEST,
  results,
  S,
  type RecoveringRun,
} from './support/recovery-harness.js';

// Cierres que decide quien sigue la conexión (ADR-0015 §3, §4 y §9): el cierre previsto
// (`finish`), la parada por señal (`stop`) y el corte del propio transporte (`interrupt`), y una
// conexión sin duración, que nunca pide el cierre previsto por su cuenta. Socket falso, reloj y
// temporizador manuales, IDs secuenciales, almacenes en memoria y esquemas sintéticos; ningún
// precio es de mercado.

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

/** Las peticiones `forget_all` enviadas. */
const forgetAllRequests = (run: RecoveringRun) =>
  run
    .socket()
    .requests()
    .filter((request) => 'forget_all' in request);

// En `recovering`, la conexión ya pidió el catálogo (`req_id` 1) y la suscripción (2): la
// petición siguiente lleva el `req_id` 3.

describe('DerivConnection sin duración', () => {
  it('nunca pide el cierre previsto por su cuenta: no pide forget_all y su único temporizador es el keepalive', async () => {
    const run = await recovering({ durationMs: null });
    // El keepalive vence a las 10:00:45, 45 000 ms después de abrir.
    expect(run.clock.pendingDelays()).toEqual([43_000]);
    // Una hora después sigue suscrita: el servidor respondió cada ping y llega otro tick.
    await run.clock.advance(3_600_000);
    run.socket().text(derivMessages.tick(2, E + 3600, '100.8'));
    await settle();

    expect(forgetAllSent(run)).toBe(false);
    expect(run.ticks.map((tick) => tick.event_time_utc)).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T11:00:00.000Z',
    ]);
    run.socket().emit({ code: 1001, kind: 'closed' });
    expect((await run.run).end).toEqual({
      detail: '1001',
      reason: 'remote_closed',
      status: 'disconnected',
    });
  });
});

describe('DerivConnection.finish: el cierre previsto a pedido', () => {
  it('pide forget_all y, con su respuesta durable, cierra con requested y termina completed', async () => {
    const run = await recovering({ durationMs: null });
    run.connection.finish();

    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 3 });
    run.socket().text(derivMessages.forgetAll(3));
    const result = await run.run;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.closure).toEqual({
      closure_type: 'requested',
      persisted: true,
      reason: 'requested',
    });
    expect(run.socket().ended).toBe('close');
    expect((await run.events()).slice(-2)).toEqual([
      expect.objectContaining({ payload_utf8: derivMessages.forgetAll(3) }),
      expect.objectContaining({
        affected_symbols: ['SYNTH_100'],
        closure_type: 'requested',
        kind: 'connection_closed',
        reason: 'requested',
      }),
    ]);
  });

  it('con una recuperación en curso, espera a que su resultado sea durable y después pide forget_all', async () => {
    const run = await recovering({ durationMs: null });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.connection.finish();
    // La página (`req_id` 3) sigue pendiente: el cierre previsto espera.
    await run.clock.advance(1000);
    expect(forgetAllSent(run)).toBe(false);
    run.socket().text(derivMessages.history(3, [S, S + 30, E], ['100.25', '100.5', '100.75']));

    expect(await outcome).toMatchObject({
      durable: true,
      result: { status: 'complete' },
      status: 'finished',
    });
    await settle();
    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    run.socket().text(derivMessages.forgetAll(4));
    expect((await run.run).end).toEqual({ status: 'completed' });
    expect((await run.events()).slice(-4).map((event) => event.kind)).toEqual([
      'raw_source_frame',
      'history_recovery_result',
      'raw_source_frame',
      'connection_closed',
    ]);
  });

  it('pide forget_all una sola vez: ni otra llamada ni la duración, que se cumple después, piden otro', async () => {
    const run = await recovering({ durationMs: 10_000 });
    run.connection.finish();
    run.connection.finish();
    // Quedan el tiempo de espera de forget_all y el keepalive; la duración, que vencía en 8000 ms, no.
    expect(run.clock.pendingDelays()).toEqual([15_000, 43_000]);
    await run.clock.advance(8000);

    expect(forgetAllRequests(run)).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    run.socket().text(derivMessages.forgetAll(3));
    expect((await run.run).end).toEqual({ status: 'completed' });
  });
});

describe('DerivConnection.stop: la parada por señal (ADR-0015 §3, «Parada»)', () => {
  it('con una página pendiente, abandona la recuperación sin persistir nada, pide forget_all y cierra con requested', async () => {
    const run = await recovering({ durationMs: null });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.connection.stop();

    expect(await outcome).toEqual({ status: 'abandoned' });
    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    // La página llega después: queda raw, pero ya no hay recuperación que la use.
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    run.socket().text(derivMessages.forgetAll(4));
    expect((await run.run).end).toEqual({ status: 'completed' });
    const events = await run.events();
    expect(events.slice(-3)).toEqual([
      expect.objectContaining({
        kind: 'raw_source_frame',
        payload_utf8: expect.stringContaining('"msg_type":"history"') as unknown,
      }),
      expect.objectContaining({ payload_utf8: derivMessages.forgetAll(4) }),
      expect.objectContaining({
        closure_type: 'requested',
        kind: 'connection_closed',
        reason: 'requested',
      }),
    ]);
    expect(await results(run)).toEqual([]);
  });

  it('abandona la recuperación aunque su resultado ya esté en la cola: el resultado no llega al log', async () => {
    const run = await recovering({ durationMs: null });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // La página queda durable y un tick vivo, en curso, con su escritura retenida: el resultado
    // entra en la cola detrás de él.
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    run.connection.stop();
    hold.release();

    expect(await outcome).toEqual({ status: 'abandoned' });
    await settle();
    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    run.socket().text(derivMessages.forgetAll(4));
    expect((await run.run).end).toEqual({ status: 'completed' });
    expect(await results(run)).toEqual([]);
  });

  it('si el cierre previsto esperaba a la recuperación, ya no la espera: la abandona y pide forget_all enseguida', async () => {
    const run = await recovering({ durationMs: null });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.connection.finish();
    expect(forgetAllSent(run)).toBe(false);
    run.connection.stop();

    expect(await outcome).toEqual({ status: 'abandoned' });
    expect(forgetAllRequests(run)).toEqual([{ forget_all: 'ticks', req_id: 4 }]);
    run.socket().text(derivMessages.forgetAll(4));
    expect((await run.run).end).toEqual({ status: 'completed' });
    expect(await results(run)).toEqual([]);
  });

  it('cancela la duración y, si forget_all no responde en 15 000 ms, cierra con timeout como cualquier petición', async () => {
    const run = await recovering({ durationMs: 10_000 });
    run.connection.stop();
    // Quedan el tiempo de espera de forget_all y el keepalive; la duración, que vencía en 8000 ms, no.
    expect(run.clock.pendingDelays()).toEqual([15_000, 43_000]);
    await run.clock.advance(15_000);

    const result = await run.run;
    expect(result.end).toEqual({
      detail: 'forget_all',
      reason: 'request_timeout',
      status: 'disconnected',
    });
    expect(result.closure).toEqual({
      closure_type: 'timeout',
      persisted: true,
      reason: 'forget_all_timeout',
    });
  });
});

describe.each(['finish', 'stop'] as const)('DerivConnection.%s sin suscripción', (method) => {
  it('con la conexión abierta, cierra enseguida con requested, sin forget_all ni símbolos afectados', async () => {
    const run = await connectionHarness({ durationMs: null });
    run.socket().open();
    await settle();
    run.connection[method]();

    const result = await run.run;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.closure).toEqual({
      closure_type: 'requested',
      persisted: true,
      reason: 'requested',
    });
    expect(run.socket().ended).toBe('close');
    expect(run.socket().requests()).toEqual([{ active_symbols: 'brief', req_id: 1 }]);
    expect(await run.events()).toEqual([
      expect.objectContaining({ connection_id: uuid(1), kind: 'connection_opened' }),
      {
        affected_symbols: [],
        closure_type: 'requested',
        connection_id: uuid(1),
        event_id: uuid(3),
        kind: 'connection_closed',
        occurred_at_utc: START,
        reason: 'requested',
        schema_version: '1.0.0',
        source: DERIV_SOURCE,
      },
    ]);
  });

  it('antes de abrir el socket, lo cierra y termina sin escribir nada', async () => {
    const run = await connectionHarness({ durationMs: null });
    run.connection[method]();

    expect(await run.run).toEqual({
      catalog: null,
      closure: null,
      connection_id: null,
      end: { status: 'completed' },
      server_time_offset_ms: null,
      subscription_id: null,
    });
    expect(run.socket().ended).toBe('close');
    expect(run.clock.pendingDelays()).toEqual([]);
    expect(await run.events()).toEqual([]);
  });
});

describe.each(['finish', 'stop'] as const)(
  'DerivConnection.recoverHistory después de %s',
  (method) => {
    it('se resuelve como abandoned sin pedir páginas, aunque forget_all todavía no haya respondido', async () => {
      const run = await recovering({ durationMs: null });
      run.connection[method]();
      const outcome = run.connection.recoverHistory(REQUEST);
      await settle();

      expect(pagesSent(run)).toEqual([]);
      expect(await outcome).toEqual({ status: 'abandoned' });
      expect(forgetAllRequests(run)).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
      run.socket().text(derivMessages.forgetAll(3));
      expect((await run.run).end).toEqual({ status: 'completed' });
      expect(await results(run)).toEqual([]);
    });
  },
);

describe('DerivConnection.interrupt: el corte del propio transporte (ADR-0015 §9)', () => {
  it('corta el socket y cierra con transport_error y el motivo dado, detrás de los frames que ya llegaron: termina disconnected', async () => {
    const run = await recovering({ durationMs: null });
    // Dos ticks llegan con la escritura retenida: uno en curso y otro esperando en la cola.
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    run.socket().text(derivMessages.tick(2, E + 4, '100.9'));
    run.connection.interrupt('smoke_interrupt');
    hold.release();

    const result = await run.run;
    expect(run.socket().ended).toBe('terminate');
    expect(result.end).toEqual({ detail: null, reason: 'smoke_interrupt', status: 'disconnected' });
    expect(result.closure).toEqual({
      closure_type: 'transport_error',
      persisted: true,
      reason: 'smoke_interrupt',
    });
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 el primer tick, 5 y 6 los dos ticks y 7
    // el cierre.
    expect((await run.events()).slice(-3)).toEqual([
      expect.objectContaining({ kind: 'raw_source_frame', observation_id: uuid(5) }),
      expect.objectContaining({ kind: 'raw_source_frame', observation_id: uuid(6) }),
      {
        affected_symbols: ['SYNTH_100'],
        closure_type: 'transport_error',
        connection_id: uuid(1),
        event_id: uuid(7),
        kind: 'connection_closed',
        occurred_at_utc: '2026-03-02T10:00:02.000Z',
        reason: 'smoke_interrupt',
        schema_version: '1.0.0',
        source: DERIV_SOURCE,
      },
    ]);
    expect(run.ticks).toHaveLength(3);
    expect(forgetAllSent(run)).toBe(false);
  });

  it.each(['', 'Corte manual'])(
    'con el motivo %j, que no es un código estable, lanza TypeError y la conexión sigue',
    async (reason) => {
      const run = await recovering({ durationMs: null });

      const call = () => {
        run.connection.interrupt(reason);
      };
      expect(call).toThrow(TypeError);
      expect(call).toThrow(/no es un código estable/u);
      expect(run.socket().ended).toBeNull();
      run.socket().emit({ code: 1001, kind: 'closed' });
      expect((await run.run).end).toMatchObject({ reason: 'remote_closed' });
    },
  );
});

describe('DerivConnection con el cierre ya decidido', () => {
  it('finish, stop e interrupt no hacen nada: manda el primer cierre', async () => {
    const run = await recovering({ deferClose: true, durationMs: null });
    // Un error del transporte decide el cierre; el aviso de ws llega más tarde.
    run.socket().emit({ code: 'ECONNRESET', kind: 'error' });
    run.connection.finish();
    run.connection.stop();
    run.connection.interrupt('smoke_interrupt');
    run.socket().finishClose();

    expect((await run.run).end).toEqual({
      detail: 'ECONNRESET',
      reason: 'transport_error',
      status: 'disconnected',
    });
    expect(forgetAllSent(run)).toBe(false);
    const closes = (await run.events()).filter(
      (event) => event.kind === 'connection_closed' && event.connection_id === uuid(1),
    );
    expect(closes).toEqual([
      expect.objectContaining({ closure_type: 'transport_error', reason: 'ECONNRESET' }),
    ]);
  });
});
