import { sourceEventSchema, type SourceEvent } from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
} from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { contentKey } from '../src/object-keys.js';
import { checkpointRow } from '../src/source-log/live-checkpoint.js';
import { settle, START_EPOCH, syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
import { type MemoryObjectStore } from './support/memory-stores.js';
import {
  previousConnectionEvents,
  S,
  STOPPED,
  stoppedBeforeRecoveryEvents,
} from './support/recovery-harness.js';
import { sessionHarness, type SessionRun } from './support/session-harness.js';

// El punto de control del estado vivo en la sesión de ingesta (ADR-0017 §5 y §6, PR 3 de §11):
// cuándo lo escribe, qué escribe y cómo termina la sesión si no puede seguir. Reloj y temporizador
// manuales, sockets falsos, IDs secuenciales, almacenes en memoria, esquemas sintéticos y un
// bloqueo en memoria; ningún precio es de mercado.

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

const SYMBOL = 'SYNTH_100';
/** El perfil de la sesión del harness: el de medición con los esquemas sintéticos. */
const profile = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });

/**
 * Los puntos de control que tendría que haber, uno por segmento cerrado del log: el pliegue del log
 * entero, desde el vacío, hasta ese segmento. Llevan la hora de escritura de la fila guardada, que no
 * entra en ningún hash.
 */
async function foldedRows(run: SessionRun) {
  const log = await run.unlockedLog();
  const last = log.openSegmentIndex - 1;
  const segments = last < 0 ? [] : await log.readClosedSegments(0, last);
  return segments.map((_segment, k) => {
    const events = segments.slice(0, k + 1).flat();
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: events.length,
      profile,
      raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
      segment_index: k,
      segment_logical_content_sha256: run.sourceLog.closed[k]?.logical_content_sha256 ?? '',
      state: foldLiveDerivation(emptyLiveDerivationState(), events, profile),
      symbol: SYMBOL,
    });
    return checkpointRow(checkpoint, run.sourceLog.checkpoints[k]?.written_at_utc ?? '');
  });
}

/**
 * Un punto de control del segmento 0 con las versiones de la sesión y otro SHA-256 que el que dará
 * su pliegue: como si otro escritor ya lo hubiera guardado.
 */
const conflictingRow = () =>
  checkpointRow(
    buildLiveDerivationCheckpoint({
      event_count: 1,
      profile,
      raw_frame_count: 0,
      segment_index: 0,
      segment_logical_content_sha256: 'e'.repeat(64),
      state: emptyLiveDerivationState(),
      symbol: SYMBOL,
    }),
    '2026-03-02T09:00:00.000Z',
  );

/** ¿Son los bytes de un objeto de segmento? Los segmentos se guardan en gzip; los eventos, no. */
const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * Altera cada objeto de segmento desde su segunda lectura, o solo el de `key`: la primera lo lee
 * bien, y la del punto de control ya no, como un almacenamiento que se corrompió después de
 * verificarlo. Armada en `beforeStart`, la primera lectura de un segmento de una ejecución anterior
 * es la del arranque, que lee los segmentos cerrados posteriores a su último punto de control
 * (ADR-0017 §4); la de un segmento que cierra la sesión, la de su escritura verificada.
 */
function corruptSegmentsAfterFirstRead(objects: MemoryObjectStore, key?: string): void {
  const reads = new Map<string, number>();
  objects.onRead = (read, bytes) => {
    if (!(key === undefined ? isGzip(bytes) : read === key)) {
      return bytes;
    }
    const count = (reads.get(read) ?? 0) + 1;
    reads.set(read, count);
    return count === 1
      ? bytes
      : Uint8Array.from(bytes, (byte, index) => (index === 0 ? byte : byte ^ 0xff));
  };
}

/** Responde el `forget_all` de la parada de la conexión, sea cual sea su `req_id`. */
async function answerForgetAll(socket: FakeDerivSocket): Promise<void> {
  await settle();
  const request = socket.requests().find((item) => 'forget_all' in item);
  if (request === undefined) {
    throw new TypeError('La conexión no pidió forget_all.');
  }
  socket.text(derivMessages.forgetAll(Number(request['req_id'])));
  await settle();
}

/** Una conexión suscrita a las 10:00:00 y un tick cinco minutos después, que cierra el segmento 0. */
async function rotateOnce(run: SessionRun): Promise<FakeDerivSocket> {
  const socket = run.socket(1);
  await run.subscribe(socket, START_EPOCH);
  await run.clock.advance(300_000);
  socket.text(derivMessages.tick(2, START_EPOCH + 300, '100.5'));
  await settle();
  return socket;
}

/**
 * El log de una ejecución anterior en dos segmentos cerrados: la conexión anterior, cerrada sin
 * pedirlo, y otra que la supera, con el primer tick posterior al cierre y un cierre pedido.
 */
function twoClosedSegments(): SourceEvent[][] {
  const events = stoppedBeforeRecoveryEvents();
  return [events.slice(0, 3), events.slice(3)];
}

/**
 * Un resultado `unavailable` de la conexión que paró que no cubre exactamente el hueco pendiente:
 * `deriveMarketData` lo acepta, y el pliegue no (ADR-0017 §3).
 */
const unavailableOfAnotherRange = (): SourceEvent =>
  sourceEventSchema.parse({
    connection_id: STOPPED,
    event_id: uuid(9150),
    from_event_time_utc: new Date(S * 1000 + 1).toISOString(),
    kind: 'history_recovery_result',
    occurred_at_utc: '2026-03-02T09:59:52.000Z',
    reason: 'history_timeout',
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    status: 'unavailable',
    symbol: SYMBOL,
    to_event_time_utc: new Date((S + 30) * 1000).toISOString(),
  });

describe('startDerivSession: el punto de control del estado vivo (ADR-0017 §5 y §6)', () => {
  it('con writeLiveCheckpoints escribe en cada cierre, al rotar y al parar, el pliegue del log entero hasta ese segmento', async () => {
    const run = await sessionHarness({ answerPings: true, writeLiveCheckpoints: true });
    const socket = await rotateOnce(run);
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual(['window']);
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0]);

    run.session.stop();
    await answerForgetAll(socket);
    const result = await run.done;

    expect(result.end).toEqual({ status: 'completed' });
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual([
      'window',
      'requested',
    ]);
    expect(run.sourceLog.checkpoints).toEqual(await foldedRows(run));
    expect(run.sourceLog.checkpoints.map((row) => row.written_at_utc)).toEqual([
      '2026-03-02T10:05:00.000Z',
      '2026-03-02T10:05:00.000Z',
    ]);
    expect(run.alerts).toEqual([]);
  });

  it('al arrancar, antes de conectar, reconstruye por partes los que faltan', async () => {
    const run = await sessionHarness({
      closedSegments: twoClosedSegments(),
      failingConnects: 1,
      writeLiveCheckpoints: true,
    });
    expect(run.checkpointsAtConnect).toEqual([2]);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });

    expect(run.sourceLog.checkpoints).toEqual(await foldedRows(run));
    expect(run.alerts).toEqual([]);
  });

  it('sin writeLiveCheckpoints, como en el smoke, no escribe ninguno', async () => {
    const run = await sessionHarness({ answerPings: true, closedSegments: twoClosedSegments() });
    const socket = await rotateOnce(run);
    run.session.stop();
    await answerForgetAll(socket);
    await run.done;

    expect(run.sourceLog.closed).toHaveLength(4);
    expect(run.sourceLog.checkpoints).toEqual([]);
  });

  it('si un segmento cerrado no se pliega, el arranque termina failed con log_not_derivable sin conectar ni escribir ninguno', async () => {
    const [previous, stopped] = twoClosedSegments();
    const run = await sessionHarness({
      closedSegments: [
        previous ?? [],
        [...(stopped ?? []).slice(0, 2), unavailableOfAnotherRange(), ...(stopped ?? []).slice(2)],
      ],
      writeLiveCheckpoints: true,
    });
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'TypeError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    // El arranque pliega los segmentos cerrados antes de reconstruir (ADR-0017 §4).
    expect(run.sourceLog.checkpoints).toEqual([]);
  });

  it('si un segmento cerrado no pasa sus comprobaciones al reconstruir, termina failed con log_not_derivable sin conectar', async () => {
    const run = await sessionHarness({
      beforeStart: ({ objects, sourceLog }) => {
        const segment = sourceLog.closed[1];
        if (segment === undefined) {
          throw new TypeError('Falta el segmento 1.');
        }
        // El arranque lo lee bien; la reconstrucción, ya alterado.
        corruptSegmentsAfterFirstRead(objects, contentKey(segment.object_bytes_sha256));
      },
      closedSegments: twoClosedSegments(),
      writeLiveCheckpoints: true,
    });
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    // El del segmento 0 sí: la reconstrucción falla en el 1.
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0]);
  });

  it('si el punto de control del último cierre no puede seguir, la sesión termina failed con log_not_derivable', async () => {
    const run = await sessionHarness({
      beforeStart: ({ objects }) => {
        corruptSegmentsAfterFirstRead(objects);
      },
      events: previousConnectionEvents(),
      failingConnects: 1,
      writeLiveCheckpoints: true,
    });
    run.session.stop();
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.sourceLog.closed).toHaveLength(1);
    expect(run.sourceLog.checkpoints).toEqual([]);
    expect(run.timeline.at(-1)).toBe('release:1');
  });

  it('después de perder el bloqueo y tomar otro, escribe con el log reabierto con el bloqueo nuevo', async () => {
    const run = await sessionHarness({ answerPings: true, writeLiveCheckpoints: true });
    await rotateOnce(run);
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0]);
    // La escritura del tick siguiente falla, la conexión termina en pausa y la sesión toma otro.
    run.provider.lock(1).lose();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 302, '100.75'));
    await settle();
    await run.clock.advance(500);
    await run.clock.advance(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:2', 'connect:2']);
    const second = run.socket(2);
    await run.subscribe(second, START_EPOCH + 303);
    await run.clock.advance(300_000);
    second.text(derivMessages.tick(2, START_EPOCH + 603, '100.5'));
    await settle();
    run.session.stop();
    await answerForgetAll(second);
    expect((await run.done).end).toEqual({ status: 'completed' });

    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0, 1, 2]);
    expect(run.sourceLog.checkpoints).toEqual(await foldedRows(run));
    expect(run.alerts.filter((alert) => String(alert['event']).startsWith('checkpoint'))).toEqual(
      [],
    );
  });

  it('si no puede seguir mientras espera entre intentos, corta la espera y termina sin conectar otra vez', async () => {
    const run = await sessionHarness({ answerPings: true, writeLiveCheckpoints: true });
    await run.sourceLog.insertLiveCheckpoint(conflictingRow());
    const writes = run.sourceLog.holdCheckpointWrites();
    await rotateOnce(run);
    // La conexión se pierde; la escritura del punto de control sigue retenida.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    expect(run.clock.pendingDelays()).toContain(500);
    writes.release();
    await settle();
    const result = await run.done;

    expect(result.end).toEqual({ detail: '0', reason: 'checkpoint_conflict', status: 'failed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });

  it('si no puede seguir mientras el intento espera antes de su socket, lo aborta y termina sin abrirlo', async () => {
    // El segmento abierto del log anterior empieza a las 09:55 y su última conexión no tiene
    // cierre: el cierre reparado del intento, a las 10:00, lo rota antes de escribirse, y el intento
    // espera 1 ms a pasarlo. El punto de control de ese segmento falla durante esa espera, porque su
    // objeto ya no pasa sus comprobaciones.
    const [opened, ...rest] = stoppedBeforeRecoveryEvents().slice(0, -1);
    if (opened?.kind !== 'connection_opened') {
      throw new TypeError('Falta la apertura.');
    }
    const run = await sessionHarness({
      beforeStart: ({ objects }) => {
        corruptSegmentsAfterFirstRead(objects);
      },
      events: [{ ...opened, occurred_at_utc: '2026-03-02T09:55:00.000Z' }, ...rest],
      writeLiveCheckpoints: true,
    });
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(result.connections).toEqual([]);
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.sourceLog.closed).toHaveLength(1);
  });

  it('si no puede seguir mientras espera para volver a tomar el bloqueo, termina con su motivo sin tomarlo', async () => {
    const run = await sessionHarness({
      answerPings: true,
      locks: ['lock', 'unavailable', 'taken'],
      writeLiveCheckpoints: true,
    });
    await run.sourceLog.insertLiveCheckpoint(conflictingRow());
    const writes = run.sourceLog.holdCheckpointWrites();
    await rotateOnce(run);
    // El bloqueo se pierde, la conexión termina en pausa y PostgreSQL no responde al tomar otro.
    run.provider.lock(1).lose();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH + 302, '100.75'));
    await settle();
    await run.clock.advance(500);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:unavailable']);
    writes.release();
    await settle();
    const result = await run.done;

    expect(result.end).toEqual({ detail: '0', reason: 'checkpoint_conflict', status: 'failed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1', 'acquire:unavailable']);
  });

  it('si la sesión se rechaza con un error de programación, espera al punto de control pendiente antes de soltar el bloqueo', async () => {
    let failTick = false;
    const run = await sessionHarness({
      answerPings: true,
      onTick: () => {
        if (failTick) {
          throw new TypeError('sintético');
        }
      },
      writeLiveCheckpoints: true,
    });
    let checkpointsAtRelease: number | null = null;
    run.provider.onRelease = () => {
      checkpointsAtRelease = run.sourceLog.checkpoints.length;
    };
    const socket = run.socket(1);
    await run.subscribe(socket, START_EPOCH);
    const writes = run.sourceLog.holdCheckpointWrites();
    await run.clock.advance(300_000);
    failTick = true;
    socket.text(derivMessages.tick(2, START_EPOCH + 300, '100.5'));
    await settle();
    expect(run.provider.lock(1).released).toBe(false);
    writes.release();

    await expect(run.done).rejects.toThrow('sintético');
    expect(checkpointsAtRelease).toBe(1);
  });

  it('con otro punto de control en la clave del segmento que cierra, avisa con checkpoint_conflict, para la conexión y termina failed con checkpoint_conflict', async () => {
    const run = await sessionHarness({ answerPings: true, writeLiveCheckpoints: true });
    // Otro escritor ya guardó un punto de control distinto del segmento 0 con las mismas versiones.
    await run.sourceLog.insertLiveCheckpoint(
      checkpointRow(
        buildLiveDerivationCheckpoint({
          event_count: 1,
          profile,
          raw_frame_count: 0,
          segment_index: 0,
          segment_logical_content_sha256: 'e'.repeat(64),
          state: emptyLiveDerivationState(),
          symbol: SYMBOL,
        }),
        '2026-03-02T09:00:00.000Z',
      ),
    );
    const socket = await rotateOnce(run);
    expect(run.alerts).toEqual([{ event: 'checkpoint_conflict', segment_index: '0' }]);
    // La sesión pidió parar la conexión.
    await answerForgetAll(socket);
    const result = await run.done;

    expect(result.end).toEqual({ detail: '0', reason: 'checkpoint_conflict', status: 'failed' });
    expect(result.connections).toHaveLength(1);
    // El log sigue sano: el segmento abierto se cierra al parar, sin otro punto de control.
    expect(run.sourceLog.closed.map((segment) => segment.close_reason)).toEqual([
      'window',
      'requested',
    ]);
    expect(run.sourceLog.checkpoints).toHaveLength(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'release:1']);
  });
});
