import { sourceEventSchema, type SourceEvent } from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
} from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { checkpointRow } from '../src/source-log/live-checkpoint.js';
import { settle, START_EPOCH, syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
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

  it('si el pliegue falla al reconstruir, termina failed con log_not_derivable sin conectar', async () => {
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
    // El del segmento 0 sí: el pliegue falla en el 1.
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0]);
  });

  it('si el pliegue falla al cerrar el último segmento, la sesión termina failed con log_not_derivable', async () => {
    const run = await sessionHarness({
      events: [...previousConnectionEvents(), unavailableOfAnotherRange()].map((event) =>
        event.kind === 'history_recovery_result'
          ? { ...event, connection_id: previousConnectionEvents()[0]?.connection_id ?? '' }
          : event,
      ),
      failingConnects: 1,
      writeLiveCheckpoints: true,
    });
    run.session.stop();
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'TypeError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.sourceLog.closed).toHaveLength(1);
    expect(run.sourceLog.checkpoints).toEqual([]);
    expect(run.timeline.at(-1)).toBe('release:1');
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
