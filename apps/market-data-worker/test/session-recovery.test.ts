import { deriveMarketData } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile } from '../src/deriv/profile.js';
import { contentKey } from '../src/object-keys.js';
import { settle, START_EPOCH, syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
import { type MemoryObjectStore } from './support/memory-stores.js';
import {
  E,
  PREVIOUS,
  previousConnectionEvents,
  REQUEST,
  S,
  stoppedBeforeRecoveryEvents,
} from './support/recovery-harness.js';
import { sessionHarness, type SessionRun } from './support/session-harness.js';

// La sesión pide la historia de un hueco (ADR-0015 §4, «Cuándo» y «Conexión perdida o parada») y
// aplica el cierre previsto por duración, que espera a la recuperación pendiente (§4 y §9). Reloj y
// temporizador manuales, sockets falsos, IDs secuenciales, `random` inyectado, almacenes en
// memoria, esquemas sintéticos y un bloqueo en memoria; ningún precio es de mercado.

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

/** Espera entre el primer tick posterior al cierre y la petición de historia (ADR-0015 §4). */
const HISTORY_DELAY_MS = 2000;
/** Lo que el cierre previsto espera a una recuperación pendiente después del plazo. */
const PLANNED_CLOSE_BOUND_MS = 300_000;

const profile = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: 'SYNTH_100' });

/** Las páginas de historia que pidió el socket, sin las demás peticiones. */
const pages = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'ticks_history' in request);

/** Las peticiones `forget_all` que envió el socket. */
const forgetAll = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'forget_all' in request);

/** Una página pedida, con los dos extremos incluidos: `start` y `end` en segundos. */
const page = (reqId: number, start: number, end: number) => ({
  count: 1000,
  end: String(end),
  req_id: reqId,
  start,
  style: 'ticks',
  ticks_history: 'SYNTH_100',
});

/** El hueco pendiente que deja la conexión anterior del log: desde S + 1 ms hasta E − 1 ms. */
const GAP = {
  from_event_time_utc: REQUEST.from_event_time_utc,
  symbol: 'SYNTH_100',
  to_event_time_utc: REQUEST.to_event_time_utc,
};

/** Los huecos pendientes del log durable, derivado con el perfil de medición. */
async function pendingGaps(run: SessionRun) {
  return deriveMarketData([await run.events()], profile).pendingGaps;
}

/** Entrega por la suscripción (`req_id` 2) el tick `epoch` con `quote`. */
async function tick(socket: FakeDerivSocket, epoch: number, quote: string): Promise<void> {
  socket.text(derivMessages.tick(2, epoch, quote));
  await settle();
}

/** Para la sesión y responde el `forget_all` de la parada, con el `req_id` que le toca. */
async function stopSession(run: SessionRun, socket: FakeDerivSocket, reqId: number) {
  run.session.stop();
  expect(forgetAll(socket)).toEqual([{ forget_all: 'ticks', req_id: reqId }]);
  socket.text(derivMessages.forgetAll(reqId));
  return run.done;
}

/** Cambia un byte del objeto `key`: ya no tiene el hash de su fila. */
function alterObject(objects: MemoryObjectStore, key: string): void {
  const altered = Uint8Array.from(objects.objects.get(key) ?? new Uint8Array());
  altered[2] = 0x41;
  objects.objects.set(key, altered);
}

/** Un almacén que no responde. */
const unavailable = () => Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });

describe('startDerivSession: cuándo pide la historia (ADR-0015 §4, «Cuándo»)', () => {
  it('el primer tick durable posterior al high-watermark del hueco hace volver a derivar el log y, 2000 ms después, pide el rango exacto; el tick repetido en el high-watermark no la pide', async () => {
    // El log ya tiene un hueco pendiente: la conexión anterior se cerró sin pedirlo tras el tick de S.
    const run = await sessionHarness({ events: previousConnectionEvents() });
    // La suscripción repite el último tick, el del high-watermark: no es posterior a él.
    await run.subscribe(run.socket(1), S, '100.25');
    expect(run.clock.pendingDelays()).toEqual([45_000]);
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([]);

    // A las 10:00:02 llega el tick de E, posterior al cierre.
    await tick(run.socket(1), E, '100.75');
    expect(run.clock.pendingDelays()).toEqual([HISTORY_DELAY_MS, 43_000]);
    await run.clock.advance(HISTORY_DELAY_MS - 1);
    expect(pages(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    // `start` es el segundo del high-watermark y `end`, el del primer tick posterior.
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);

    // Con las cotizaciones recibidas en los dos extremos, la recuperación es complete.
    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    const result = await stopSession(run, run.socket(1), 4);
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 y 5 los ticks, 6 la página y 7 el resultado.
    expect(result.recoveries).toEqual([
      {
        attempts: 1,
        durable: true,
        pages: 1,
        result: {
          connection_id: uuid(1),
          event_id: uuid(7),
          from_event_time_utc: REQUEST.from_event_time_utc,
          kind: 'history_recovery_result',
          occurred_at_utc: '2026-03-02T10:00:04.000Z',
          recovered_event_count: 0,
          schema_version: '1.0.0',
          source: 'deriv_options',
          status: 'complete',
          symbol: 'SYNTH_100',
          to_event_time_utc: REQUEST.to_event_time_utc,
        },
        status: 'finished',
      },
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('un resultado complete deja el log derivando sin hueco pendiente ni condición abierta', async () => {
    const run = await sessionHarness({ events: previousConnectionEvents() });
    await run.subscribe(run.socket(1), E, '100.75');
    expect(await pendingGaps(run)).toEqual([GAP]);
    await run.clock.advance(HISTORY_DELAY_MS);
    run
      .socket(1)
      .text(
        derivMessages.history(3, [S, S + 20, S + 40, E], ['100.25', '100.5', '100.6', '100.75']),
      );
    await settle();

    const derived = deriveMarketData([await run.events()], profile);
    expect(derived.pendingGaps).toEqual([]);
    expect(derived.pendingContinuitySymbols).toEqual([]);
    expect(derived.openConditionTypes).toEqual([]);
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'history_recovery_result',
      recovered_event_count: 2,
      status: 'complete',
    });
    await stopSession(run, run.socket(1), 4);
  });

  it('un hueco pendiente de una ejecución anterior que cayó se recupera en la primera conexión: el cierre reparado lo deja pendiente', async () => {
    // La conexión anterior quedó abierta: el proceso cayó después del tick de S.
    const run = await sessionHarness({ events: previousConnectionEvents().slice(0, 2) });
    // El cierre reparado lleva la hora de la detección; el socket se abre 1 ms después.
    await run.clock.advance(1);
    expect((await run.events()).at(-1)).toMatchObject({
      connection_id: PREVIOUS,
      occurred_at_utc: '2026-03-02T10:00:00.000Z',
      reason: 'close_not_recorded',
    });
    expect(await pendingGaps(run)).toEqual([{ ...GAP, to_event_time_utc: null }]);

    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);
    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    expect(await pendingGaps(run)).toEqual([]);
    // IDs: 1 el cierre reparado, 2 la conexión.
    const result = await stopSession(run, run.socket(1), 4);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ connection_id: uuid(2), status: 'complete' }) as unknown,
        status: 'finished',
      }),
    ]);
  });

  it('un hueco cuyo fin ya se conoce al empezar la conexión, porque la ejecución anterior paró tras el primer tick posterior al cierre, se pide 2000 ms después del primer tick de la conexión nueva, con el rango de entonces', async () => {
    const run = await sessionHarness({ events: stoppedBeforeRecoveryEvents() });
    // Desde S + 1 ms hasta el primer tick posterior al cierre, S + 50, − 1 ms.
    const known = { ...GAP, to_event_time_utc: '2026-03-02T09:59:49.999Z' };
    expect(await pendingGaps(run)).toEqual([known]);
    // Un segundo sin ticks: la conexión no pide nada al empezar.
    await run.clock.advance(1000);
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS - 1);
    expect(pages(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    expect(pages(run.socket(1))).toEqual([page(3, S, S + 50)]);

    run.socket(1).text(derivMessages.history(3, [S, S + 50], ['100.25', '100.5']));
    await settle();
    expect(await pendingGaps(run)).toEqual([]);
    const result = await stopSession(run, run.socket(1), 4);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          connection_id: uuid(1),
          from_event_time_utc: known.from_event_time_utc,
          status: 'complete',
          to_event_time_utc: known.to_event_time_utc,
        }) as unknown,
        status: 'finished',
      }),
    ]);
  });

  it('si el primer tick posterior llega mientras todavía deriva el log al empezar la conexión, lo vuelve a derivar al terminar: no espera al tick siguiente', async () => {
    let reads = 0;
    const gate = Promise.withResolvers<undefined>();
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        const list = sourceLog.listClosedSegments.bind(sourceLog);
        vi.spyOn(sourceLog, 'listClosedSegments').mockImplementation(async (...args) => {
          reads += 1;
          // La tercera lectura, tras la del arranque y la de la reparación, es la derivación del
          // principio de la conexión.
          if (reads === 3) {
            await gate.promise;
          }
          return list(...args);
        });
      },
      closeSegment: true,
      events: previousConnectionEvents(),
    });
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(5000);
    expect(pages(run.socket(1))).toEqual([]);

    gate.resolve(undefined);
    await settle();
    await run.clock.advance(HISTORY_DELAY_MS - 1);
    expect(pages(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);
    expect(reads).toBe(4);
    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    await stopSession(run, run.socket(1), 4);
  });
});

describe('startDerivSession: la recuperación y el fin de la conexión (ADR-0015 §4, «Conexión perdida o parada»)', () => {
  it('si la conexión se pierde antes de los 2000 ms, no pide la historia; la conexión siguiente pide el rango que dan entonces las reglas', async () => {
    const run = await sessionHarness({ events: previousConnectionEvents() });
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS - 1);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    // Solo queda la espera antes de reconectar.
    expect(run.clock.pendingDelays()).toEqual([500]);
    await run.clock.advance(500);

    // El cierre nuevo conserva el inicio del hueco y espera un fin nuevo: el tick repetido de E ya
    // no lo fija, porque no es posterior al high-watermark de ese cierre.
    await run.subscribe(run.socket(2), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([]);
    await tick(run.socket(2), E + 3, '100.8');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([]);
    expect(pages(run.socket(2))).toEqual([page(3, S, E + 3)]);

    run.socket(2).text(derivMessages.history(3, [S, E, E + 3], ['100.25', '100.75', '100.8']));
    await settle();
    expect(await pendingGaps(run)).toEqual([]);
    // IDs: la segunda conexión es la 6.
    const result = await stopSession(run, run.socket(2), 4);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          connection_id: uuid(6),
          from_event_time_utc: REQUEST.from_event_time_utc,
          recovered_event_count: 1,
          status: 'complete',
          to_event_time_utc: '2026-03-02T10:00:02.999Z',
        }) as unknown,
        status: 'finished',
      }),
    ]);
  });

  it('si la conexión termina mientras vuelve a derivar el log por un tick posterior, esa lectura ya no pide nada al acabar: ni página ni recuperación abandonada, y solo queda la espera antes de reconectar', async () => {
    let reads = 0;
    const gate = Promise.withResolvers<undefined>();
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        const list = sourceLog.listClosedSegments.bind(sourceLog);
        vi.spyOn(sourceLog, 'listClosedSegments').mockImplementation(async (...args) => {
          reads += 1;
          // La cuarta lectura, tras la del arranque, la de la reparación y la del principio de la
          // conexión, es la que pide el tick posterior al cierre.
          if (reads === 4) {
            await gate.promise;
          }
          return list(...args);
        });
      },
      closeSegment: true,
      events: previousConnectionEvents(),
    });
    // La suscripción repite el tick del high-watermark; el de E vuelve a derivar el log.
    await run.subscribe(run.socket(1), S, '100.25');
    await tick(run.socket(1), E, '100.75');
    expect(reads).toBe(4);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    // La lectura acaba con la conexión ya terminada; con ella, el hueco tenía fin.
    gate.resolve(undefined);
    await settle();

    expect(run.clock.pendingDelays()).toEqual([500]);
    // Reconecta, y pasan los 2000 ms que habría esperado.
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([]);
    run.session.stop();
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([]);
  });

  it('una parada durante los 2000 ms no pide ninguna página ni deja recuperación en el resultado, y el hueco sigue pendiente', async () => {
    const run = await sessionHarness({ events: previousConnectionEvents() });
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS / 2);
    run.session.stop();
    await run.clock.advance(HISTORY_DELAY_MS / 2);

    expect(pages(run.socket(1))).toEqual([]);
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    run.socket(1).text(derivMessages.forgetAll(3));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);
    // Un cierre pedido no cambia el hueco: la ejecución siguiente lo recupera.
    expect(await pendingGaps(run)).toEqual([GAP]);
  });

  it('si al volver a derivar el log su contenido no pasa las comprobaciones, para la conexión sin pedir la historia y termina failed con log_not_derivable, sin cerrar el segmento', async () => {
    const run = await sessionHarness({ closeSegment: true, events: previousConnectionEvents() });
    // Con la conexión ya en marcha, cambia el objeto del segmento cerrado.
    alterObject(run.objects, contentKey(run.sourceLog.closed[0]?.object_bytes_sha256 ?? ''));
    await run.subscribe(run.socket(1), E, '100.75');

    // La parada llega después de la suscripción: con el tick de E, al volver a derivar.
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    run.socket(1).text(derivMessages.forgetAll(3));
    const result = await run.done;
    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(result.recoveries).toEqual([]);
    expect(pages(run.socket(1))).toEqual([]);
    expect(run.sourceLog.closed).toHaveLength(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si un almacén no responde al volver a derivar el log, avisa con source_log_unavailable y lo intenta otra vez con el tick siguiente', async () => {
    const run = await sessionHarness({ closeSegment: true, events: previousConnectionEvents() });
    vi.spyOn(run.sourceLog, 'listClosedSegments').mockRejectedValueOnce(unavailable());
    await run.subscribe(run.socket(1), E, '100.75');
    expect(run.alerts).toEqual([{ event: 'source_log_unavailable', reason: 'ECONNREFUSED' }]);
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([]);

    await tick(run.socket(1), E + 2, '100.8');
    await run.clock.advance(HISTORY_DELAY_MS);
    // El fin del hueco sigue siendo el primer tick posterior al cierre, E.
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);
    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    await stopSession(run, run.socket(1), 4);
  });

  it('si el log falla antes de volver a derivarlo por un tick que llegó durante la primera derivación, no es un error de programación: la conexión termina en pausa y la siguiente recupera el hueco', async () => {
    let reads = 0;
    const gate = Promise.withResolvers<undefined>();
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        const list = sourceLog.listClosedSegments.bind(sourceLog);
        vi.spyOn(sourceLog, 'listClosedSegments').mockImplementation(async (...args) => {
          reads += 1;
          // La tercera lectura es la derivación del principio de la primera conexión.
          if (reads === 3) {
            await gate.promise;
          }
          return list(...args);
        });
      },
      closeSegment: true,
      // El socket cortado avisa del cierre solo con `finishClose`: la conexión sigue sin terminar.
      deferClose: true,
      events: previousConnectionEvents(),
    });
    // El tick de E llega mientras deriva el log al empezar la conexión.
    await run.subscribe(run.socket(1), E, '100.75');
    // El tick siguiente no queda durable: el log falla y la conexión se cierra en pausa.
    run.objects.armNextPutFailure('synthetic_put_failure');
    await tick(run.socket(1), E + 2, '100.8');
    // La primera derivación termina sin el tick de E, así que vuelve a derivar por él, con el log ya
    // fallido.
    gate.resolve(undefined);
    await settle();
    run.socket(1).finishClose();
    await settle();

    expect(run.alerts).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([500]);
    // La reparación del cierre de la primera conexión; el socket se abre 1 ms después.
    await run.clock.advance(501);
    await run.subscribe(run.socket(2), E + 4, '100.9');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([page(3, S, E + 4)]);
    run.socket(2).text(derivMessages.history(3, [S, E, E + 4], ['100.25', '100.75', '100.9']));
    await settle();
    expect(await pendingGaps(run)).toEqual([]);

    run.session.stop();
    expect(forgetAll(run.socket(2))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);
    run.socket(2).text(derivMessages.forgetAll(4));
    await settle();
    run.socket(2).finishClose();
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections.map((connection) => connection.end)).toEqual([
      { detail: 'raw_object_write', reason: 'persistence_unavailable', status: 'paused' },
      { status: 'completed' },
    ]);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          recovered_event_count: 1,
          status: 'complete',
        }) as unknown,
        status: 'finished',
      }),
    ]);
  });
});

describe('startDerivSession: el cierre previsto por duración (ADR-0015 §4 y §9)', () => {
  it.each([0, -1000, 1.5, Number.NaN, 2 ** 53])(
    'una duración de %s, que no es un entero positivo de milisegundos, es un error de programación: lanza TypeError',
    async (durationMs) => {
      await expect(sessionHarness({ durationMs })).rejects.toThrow(TypeError);
    },
  );

  it('sin recuperación pendiente, pide forget_all al cumplirse la duración, contada desde el primer ConnectionOpened durable de la sesión y no desde la suscripción', async () => {
    const run = await sessionHarness({ durationMs: 10_000 });
    run.socket(1).open();
    await settle();
    // El catálogo responde 300 ms después de la apertura, y la suscripción enseguida.
    await run.clock.advance(300);
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    await tick(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(9699);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);

    run.socket(1).text(derivMessages.forgetAll(3));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
        connection_id: uuid(1),
        end: { status: 'completed' },
      },
    ]);
    expect(result.recoveries).toEqual([]);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['requested']);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('con una reconexión antes del plazo, pide forget_all a los 10 000 ms de la primera apertura durable, no de la segunda, y no deja ningún otro plazo pendiente', async () => {
    const run = await sessionHarness({ durationMs: 10_000 });
    // La primera conexión abre a las 10:00:00 y se pierde a las 10:00:03.
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(3000);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    // La segunda abre a las 10:00:03.500 y recupera el hueco antes del plazo.
    await run.clock.advance(500);
    await run.subscribe(run.socket(2), START_EPOCH + 2, '100.5');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([page(3, START_EPOCH, START_EPOCH + 2)]);
    run
      .socket(2)
      .text(derivMessages.history(3, [START_EPOCH, START_EPOCH + 2], ['100.25', '100.5']));
    await settle();

    // Las 10:00:05.500: el plazo vence a las 10:00:10.
    await run.clock.advance(4499);
    expect(forgetAll(run.socket(2))).toEqual([]);
    await run.clock.advance(1);
    expect(forgetAll(run.socket(2))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);
    run.socket(2).text(derivMessages.forgetAll(4));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([
      expect.objectContaining({ durable: true, status: 'finished' }),
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('una parada antes del plazo lo cancela: después de done no queda ningún temporizador', async () => {
    const run = await sessionHarness({ durationMs: 10_000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(1000);
    run.session.stop();
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    run.socket(1).text(derivMessages.forgetAll(3));

    expect((await run.done).end).toEqual({ status: 'completed' });
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si la duración se cumple durante los 2000 ms antes de pedir la historia, la pide igual, espera su resultado y después pide forget_all', async () => {
    // La conexión abre a las 10:00:00: el plazo vence a las 10:00:01.
    const run = await sessionHarness({ durationMs: 1000, events: previousConnectionEvents() });
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(1000);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1000);
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);
    await run.clock.advance(5000);
    expect(forgetAll(run.socket(1))).toEqual([]);

    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);
    run.socket(1).text(derivMessages.forgetAll(4));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        durable: true,
        result: expect.objectContaining({ status: 'complete' }) as unknown,
        status: 'finished',
      }),
    ]);
    expect((await run.events()).slice(-4).map((event) => event.kind)).toEqual([
      'raw_source_frame',
      'history_recovery_result',
      'raw_source_frame',
      'connection_closed',
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si la duración se cumple mientras reconecta tras un cierre no pedido, reconecta, recupera el hueco que dejó ese cierre y después pide forget_all', async () => {
    const run = await sessionHarness({ durationMs: 5000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    // A las 10:00:04.800 el servidor cierra: el plazo vence durante la espera antes de reconectar.
    await run.clock.advance(4800);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    expect(run.clock.pendingDelays()).toEqual([200, 500]);
    await run.clock.advance(200);
    expect(run.sockets).toHaveLength(1);
    await run.clock.advance(300);
    expect(run.sockets).toHaveLength(2);

    await run.subscribe(run.socket(2), START_EPOCH + 4, '100.5');
    expect(forgetAll(run.socket(2))).toEqual([]);
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([page(3, START_EPOCH, START_EPOCH + 4)]);
    run
      .socket(2)
      .text(
        derivMessages.history(
          3,
          [START_EPOCH, START_EPOCH + 2, START_EPOCH + 4],
          ['100.25', '100.3', '100.5'],
        ),
      );
    await settle();
    expect(forgetAll(run.socket(2))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);

    run.socket(2).text(derivMessages.forgetAll(4));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections.map((connection) => connection.end)).toEqual([
      { detail: '1001', reason: 'remote_closed', status: 'disconnected' },
      { status: 'completed' },
    ]);
    expect(result.waits_ms).toEqual([500]);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          recovered_event_count: 1,
          status: 'complete',
        }) as unknown,
        status: 'finished',
      }),
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si la duración se cumple justo después de un cierre no pedido, antes de que esa conexión termine, finish no hace nada: reconecta, recupera el hueco que dejó ese cierre y después pide forget_all', async () => {
    const run = await sessionHarness({ deferClose: true, durationMs: 5000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(4999);
    // Un error del transporte decide el cierre; el aviso de ws llega más tarde.
    run.socket(1).emit({ code: 'ECONNRESET', kind: 'error' });
    await settle();
    // El plazo vence con ese cierre ya decidido: la conexión no pide forget_all.
    await run.clock.advance(1);
    expect(forgetAll(run.socket(1))).toEqual([]);
    run.socket(1).finishClose();
    await settle();

    // Reconecta tras la espera del primer intento, con el tope del cierre previsto en marcha.
    expect(run.clock.pendingDelays()).toEqual([500, PLANNED_CLOSE_BOUND_MS]);
    await run.clock.advance(500);
    await run.subscribe(run.socket(2), START_EPOCH + 6, '100.5');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([page(3, START_EPOCH, START_EPOCH + 6)]);
    expect(forgetAll(run.socket(2))).toEqual([]);
    run
      .socket(2)
      .text(derivMessages.history(3, [START_EPOCH, START_EPOCH + 6], ['100.25', '100.5']));
    await settle();
    expect(forgetAll(run.socket(2))).toEqual([{ forget_all: 'ticks', req_id: 4 }]);

    run.socket(2).text(derivMessages.forgetAll(4));
    await settle();
    run.socket(2).finishClose();
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections.map((connection) => connection.end)).toEqual([
      { detail: 'ECONNRESET', reason: 'transport_error', status: 'disconnected' },
      { status: 'completed' },
    ]);
    expect(result.waits_ms).toEqual([500]);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ status: 'complete' }) as unknown,
        status: 'finished',
      }),
    ]);
    expect(await pendingGaps(run)).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si la conexión se pierde mientras el cierre previsto espera la respuesta a forget_all, no reconecta ni pide la historia: termina completed y el hueco que deja esa pérdida sigue pendiente', async () => {
    const run = await sessionHarness({ durationMs: 1000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(1000);
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    // Antes de responder, el servidor cierra: el cierre no es el pedido.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();

    // Después de finish no empieza ninguna recuperación, tampoco en otra conexión: no espera para
    // reconectar.
    expect(run.clock.pendingDelays()).toEqual([]);
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'remote', persisted: true, reason: 'close_code_1001' },
        connection_id: uuid(1),
        end: { detail: '1001', reason: 'remote_closed', status: 'disconnected' },
      },
    ]);
    expect(result.waits_ms).toEqual([]);
    expect(result.recoveries).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
    await run.clock.advance(600_000);
    expect(run.sockets).toHaveLength(1);
    // La ejecución siguiente lo recupera.
    expect(await pendingGaps(run)).toEqual([
      {
        from_event_time_utc: '2026-03-02T10:00:00.001Z',
        symbol: 'SYNTH_100',
        to_event_time_utc: null,
      },
    ]);
  });

  it('espera a la recuperación pendiente como mucho 300 000 ms después del plazo: entonces para la sesión, que abandona la recuperación en curso', async () => {
    const run = await sessionHarness({
      answerPings: true,
      durationMs: 5000,
      events: previousConnectionEvents(),
    });
    // Solo llega el tick repetido del high-watermark: el fin del hueco todavía no se conoce.
    await run.subscribe(run.socket(1), S, '100.25');
    await run.clock.advance(5000);
    expect(forgetAll(run.socket(1))).toEqual([]);
    // A las 10:04:55 llega por fin un tick posterior, y la historia se pide 2000 ms después. Entre
    // tanto, el keepalive pidió seis `ping` (`req_id` 3 a 8).
    await run.clock.advance(290_000);
    await tick(run.socket(1), E + 295, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([page(9, S, E + 295)]);

    // La página sigue pendiente cuando se cumple el tope, a las 10:05:05: 8000 ms después.
    await run.clock.advance(PLANNED_CLOSE_BOUND_MS - 290_000 - HISTORY_DELAY_MS - 1);
    expect(forgetAll(run.socket(1))).toEqual([]);
    await run.clock.advance(1);
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 10 }]);

    run.socket(1).text(derivMessages.forgetAll(10));
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([{ status: 'abandoned' }]);
    expect((await run.events()).map((event) => event.kind)).not.toContain(
      'history_recovery_result',
    );
    expect(run.clock.pendingDelays()).toEqual([]);
  });
});

describe('startDerivSession: el corte del smoke de reconexión (ADR-0015 §9)', () => {
  it.each([0, -1000, 1.5, Number.NaN, 2 ** 53])(
    'un corte a los %s ms, que no es un entero positivo de milisegundos, es un error de programación: lanza TypeError',
    async (interruptAfterMs) => {
      await expect(sessionHarness({ interruptAfterMs })).rejects.toThrow(TypeError);
    },
  );

  it('corta la conexión en curso una sola vez, interruptAfterMs después del primer tick durable de la sesión, con transport_error y smoke_interrupt: reconecta y recupera el hueco que deja el corte', async () => {
    const run = await sessionHarness({ interruptAfterMs: 3000 });
    run.socket(1).open();
    await settle();
    // El catálogo responde 400 ms después de la apertura, y el primer tick llega enseguida.
    await run.clock.advance(400);
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    await tick(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(2999);
    expect(run.socket(1).ended).toBeNull();
    await run.clock.advance(1);
    expect(run.socket(1).ended).toBe('terminate');
    await settle();

    expect(run.clock.pendingDelays()).toEqual([500]);
    await run.clock.advance(500);
    await run.subscribe(run.socket(2), START_EPOCH + 4, '100.5');
    // Una sola vez: el primer tick de la conexión nueva no lo vuelve a poner en marcha.
    expect(run.clock.pendingDelays()).toEqual([HISTORY_DELAY_MS, 45_000]);
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(2))).toEqual([page(3, START_EPOCH, START_EPOCH + 4)]);
    run
      .socket(2)
      .text(
        derivMessages.history(
          3,
          [START_EPOCH, START_EPOCH + 2, START_EPOCH + 4],
          ['100.25', '100.3', '100.5'],
        ),
      );
    await settle();

    const result = await stopSession(run, run.socket(2), 4);
    // IDs: 1 la conexión, 2 su apertura, 3 el catálogo, 4 el tick y 5 el cierre; la segunda es
    // la 6.
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'transport_error', persisted: true, reason: 'smoke_interrupt' },
        connection_id: uuid(1),
        end: { detail: null, reason: 'smoke_interrupt', status: 'disconnected' },
      },
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
        connection_id: uuid(6),
        end: { status: 'completed' },
      },
    ]);
    expect(result.waits_ms).toEqual([500]);
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          recovered_event_count: 1,
          status: 'complete',
        }) as unknown,
        status: 'finished',
      }),
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si llega sin conexión en curso, mientras espera para reconectar, no corta nada, tampoco la conexión siguiente', async () => {
    const run = await sessionHarness({ interruptAfterMs: 3000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    // El servidor cierra a las 10:00:02.800: el corte vence durante la espera, a las 10:00:03.
    await run.clock.advance(2800);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    await run.clock.advance(500);
    await run.subscribe(run.socket(2), START_EPOCH + 4, '100.5');

    expect(run.socket(2).ended).toBeNull();
    expect(run.clock.pendingDelays()).toEqual([HISTORY_DELAY_MS, 45_000]);
    const result = await stopSession(run, run.socket(2), 3);
    expect(result.connections.map((connection) => connection.closure?.reason)).toEqual([
      'close_code_1001',
      'requested',
    ]);
  });

  it('si el plazo del cierre previsto ya se cumplió, no corta nada: la conexión termina con el cierre previsto aunque forget_all todavía no haya respondido', async () => {
    // El plazo vence a las 10:00:10, desde la apertura; el corte, a las 10:00:10.500, desde el
    // primer tick, que llega a las 10:00:01.
    const run = await sessionHarness({ durationMs: 10_000, interruptAfterMs: 9500 });
    run.socket(1).open();
    await settle();
    await run.clock.advance(1000);
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    await tick(run.socket(1), START_EPOCH + 1, '100.25');
    await run.clock.advance(9000);
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    await run.clock.advance(500);
    expect(run.socket(1).ended).toBeNull();

    run.socket(1).text(derivMessages.forgetAll(3));
    const result = await run.done;
    expect(result.connections).toEqual([
      {
        closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
        connection_id: uuid(1),
        end: { status: 'completed' },
      },
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('una parada antes del corte lo cancela: no corta nada y no deja temporizadores', async () => {
    const run = await sessionHarness({ interruptAfterMs: 3000 });
    await run.subscribe(run.socket(1), START_EPOCH, '100.25');
    await run.clock.advance(1000);
    const result = await stopSession(run, run.socket(1), 3);

    expect(run.socket(1).ended).toBe('close');
    expect(result.connections.map((connection) => connection.closure?.reason)).toEqual([
      'requested',
    ]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });
});
