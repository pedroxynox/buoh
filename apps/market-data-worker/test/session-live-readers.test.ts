import { type IngestionCursor, type SourceEvent } from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
  sourceEventTime,
} from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile } from '../src/deriv/profile.js';
import { contentKey } from '../src/object-keys.js';
import { checkpointRow } from '../src/source-log/live-checkpoint.js';
import { type StoredLiveCheckpoint } from '../src/source-log/ports.js';
import { settle, START, syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages, type FakeDerivSocket } from './support/deriv-fixtures.js';
import { type MemorySourceLogStore } from './support/memory-stores.js';
import {
  E,
  PREVIOUS,
  previousConnectionEvents,
  S,
  stoppedBeforeRecoveryEvents,
} from './support/recovery-harness.js';
import { sessionHarness, type SessionRun } from './support/session-harness.js';

// Los lectores en vivo de la sesión desde el último punto de control válido (ADR-0017 §4, PR 4 de
// §11): el arranque, la reparación de cierres y la vigilancia de huecos ya no leen los segmentos
// cerrados anteriores a él, avisan una sola vez de cada fila que rechazan y tratan un PostgreSQL que
// no responde como cualquier almacén del log. Reloj y temporizador manuales, sockets falsos, IDs
// secuenciales, almacenes en memoria, esquemas sintéticos y un bloqueo en memoria; ningún precio es
// de mercado.

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
const HISTORY_DELAY_MS = 2000;
/** La primera espera entre intentos, con `random` a 0 (ADR-0015 §3, «Espera»). */
const FIRST_BACKOFF_MS = 500;
const profile = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });

/** Un almacén que no responde. */
const unavailable = () => Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });

/** Las páginas de historia que pidió el socket, sin las demás peticiones. */
const pages = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'ticks_history' in request);

/** Una página pedida, con los dos extremos incluidos: `start` y `end` en segundos. */
const page = (reqId: number, start: number, end: number) => ({
  count: 1000,
  end: String(end),
  req_id: reqId,
  start,
  style: 'ticks',
  ticks_history: SYMBOL,
});

/** Para la sesión y responde el `forget_all` de la parada, con el `req_id` que le toca. */
async function stopSession(run: SessionRun, socket: FakeDerivSocket, reqId: number) {
  run.session.stop();
  await settle();
  socket.text(derivMessages.forgetAll(reqId));
  return run.done;
}

/**
 * El log de una ejecución anterior que paró antes de recuperar el hueco, en dos segmentos cerrados:
 * la conexión anterior, cerrada sin pedirlo, y la que la supera, con el primer tick posterior al
 * cierre y un cierre pedido.
 */
function stoppedInTwoSegments(): SourceEvent[][] {
  const events = stoppedBeforeRecoveryEvents();
  return [events.slice(0, 3), events.slice(3)];
}

/**
 * Las filas de los puntos de control de los segmentos cerrados del almacén, como las escribe
 * `ingest`: el pliegue del log desde el vacío hasta cada uno, con `segments`, sus eventos.
 */
function checkpointRows(
  sourceLog: MemorySourceLogStore,
  segments: readonly (readonly SourceEvent[])[],
): StoredLiveCheckpoint[] {
  return segments.map((_segment, k) => {
    const events = segments.slice(0, k + 1).flat();
    return checkpointRow(
      buildLiveDerivationCheckpoint({
        event_count: events.length,
        profile,
        raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
        segment_index: k,
        segment_logical_content_sha256: sourceLog.closed[k]?.logical_content_sha256 ?? '',
        state: foldLiveDerivation(emptyLiveDerivationState(), events, profile),
        symbol: SYMBOL,
      }),
      '2026-03-02T09:59:56.000Z',
    );
  });
}

/** Borra los objetos de los segmentos cerrados: leerlos daría `LogIntegrityError`. */
function deleteClosedObjects(
  objects: { readonly objects: Map<string, Uint8Array> },
  sourceLog: MemorySourceLogStore,
): void {
  for (const segment of sourceLog.closed) {
    objects.objects.delete(contentKey(segment.object_bytes_sha256));
  }
}

describe('startDerivSession: los lectores desde el último punto de control válido (ADR-0017 §4)', () => {
  it('con un punto de control válido en cada segmento cerrado, arranca, repara y vigila el hueco sin leer los objetos de esos segmentos, y pide el rango de siempre', async () => {
    const segments = stoppedInTwoSegments();
    const run = await sessionHarness({
      beforeStart: ({ objects, sourceLog }) => {
        sourceLog.checkpoints.push(...checkpointRows(sourceLog, segments));
        deleteClosedObjects(objects, sourceLog);
      },
      closedSegments: segments,
      writeLiveCheckpoints: true,
    });
    // Desde S + 1 ms hasta el primer tick posterior al cierre, S + 50, − 1 ms.
    await run.subscribe(run.socket(1), E, '100.75');
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([page(3, S, S + 50)]);
    run.socket(1).text(derivMessages.history(3, [S, S + 50], ['100.25', '100.5']));
    await settle();
    const result = await stopSession(run, run.socket(1), 4);

    expect(result.end).toEqual({ status: 'completed' });
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          from_event_time_utc: '2026-03-02T09:59:00.001Z',
          status: 'complete',
          to_event_time_utc: '2026-03-02T09:59:49.999Z',
        }) as unknown,
        status: 'finished',
      }),
    ]);
    // La conexión supera la del log anterior, y la parada escribió el punto de control de su cierre.
    expect(result.connections).toHaveLength(1);
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0, 1, 2]);
    expect(run.alerts).toEqual([]);
  });

  it('sin puntos de control, los mismos objetos que faltan dan log_not_derivable al arrancar: el arranque lee el log desde el vacío', async () => {
    const run = await sessionHarness({
      beforeStart: ({ objects, sourceLog }) => {
        deleteClosedObjects(objects, sourceLog);
      },
      closedSegments: stoppedInTwoSegments(),
      writeLiveCheckpoints: true,
    });
    const result = await run.done;

    expect(result.end).toEqual({
      detail: 'LogIntegrityError',
      reason: 'log_not_derivable',
      status: 'failed',
    });
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
  });

  it('la reparación lee la conexión anterior desde el punto de control: sin el objeto del segmento donde se abrió, escribe su cierre no registrado', async () => {
    const [opened, frame] = previousConnectionEvents();
    if (opened === undefined || frame === undefined) {
      throw new TypeError('Faltan la apertura y el tick.');
    }
    const segments = [[opened, frame]];
    const run = await sessionHarness({
      beforeStart: ({ objects, sourceLog }) => {
        sourceLog.checkpoints.push(...checkpointRows(sourceLog, segments));
        deleteClosedObjects(objects, sourceLog);
      },
      closedSegments: segments,
      writeLiveCheckpoints: true,
    });

    // Antes del socket, el cierre que le falta a la conexión anterior, en el segmento abierto; el
    // intento espera 1 ms a pasar su hora.
    expect(run.timeline).toEqual(['acquire:1']);
    await run.clock.advance(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    expect(run.sourceLog.rows.slice(2).map((row) => [row.segment_index, row.kind])).toEqual([
      [1, 'connection_closed'],
    ]);
    const close = run.sourceLog.rows[2];
    expect(close?.event_id).toBeDefined();
    run.socket(1).open();
    await settle();
    // La apertura de la conexión nueva supera la anterior.
    expect(run.sourceLog.rows.slice(2).map((row) => row.kind)).toEqual([
      'connection_closed',
      'connection_opened',
    ]);
    run.session.stop();
    run.socket(1).text(derivMessages.forgetAll(2));
    await settle();
    const result = await run.done;
    expect(result.end).toEqual({ status: 'completed' });
    expect(result.connections.map((item) => item.connection_id)).not.toContain(PREVIOUS);
    expect(run.alerts).toEqual([]);
  });

  it('una fila rechazada avisa una sola vez en toda la sesión, aunque la encuentren el arranque, la reconstrucción, cada reparación y la vigilancia, y no se reemplaza', async () => {
    const segments = stoppedInTwoSegments();
    let bad: StoredLiveCheckpoint | undefined;
    const run = await sessionHarness({
      answerPings: true,
      beforeStart: ({ sourceLog }) => {
        const [first, second] = checkpointRows(sourceLog, segments);
        if (first === undefined || second === undefined) {
          throw new TypeError('Faltan las filas.');
        }
        bad = { ...second, checkpoint_sha256: 'f'.repeat(64) };
        sourceLog.checkpoints.push(first, bad);
      },
      closedSegments: segments,
      writeLiveCheckpoints: true,
    });
    await run.subscribe(run.socket(1), E, '100.75');
    // La conexión se pierde y la siguiente vuelve a reparar y a vigilar el hueco.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    await run.clock.advance(FIRST_BACKOFF_MS);
    await run.subscribe(run.socket(2), E + 1, '100.8');
    await run.clock.advance(HISTORY_DELAY_MS);
    // El cierre nuevo conserva el inicio del hueco; su fin es el primer tick posterior a ese cierre.
    expect(pages(run.socket(2))).toEqual([page(3, S, E + 1)]);
    run
      .socket(2)
      .text(
        derivMessages.history(3, [S, S + 50, E, E + 1], ['100.25', '100.5', '100.75', '100.8']),
      );
    await settle();
    const result = await stopSession(run, run.socket(2), 4);

    expect(result.end).toEqual({ status: 'completed' });
    expect(run.timeline).toEqual(['acquire:1', 'connect:1', 'connect:2', 'release:1']);
    expect(run.alerts).toEqual([
      {
        event: 'checkpoint_rejected',
        reason: 'checkpoint_digest_mismatch',
        segment_index: '1',
      },
    ]);
    // La fila rechazada sigue ahí; la del segmento 2, que cerró la parada, la supera.
    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0, 1, 2]);
    expect(run.sourceLog.checkpoints[1]).toEqual(bad);
  });

  it('si PostgreSQL no responde al leer los puntos de control al arrancar, avisa con source_log_unavailable, espera y lo intenta otra vez', async () => {
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        sourceLog.failCheckpointReads = true;
      },
      closedSegments: stoppedInTwoSegments(),
    });
    expect(run.alerts).toEqual([{ event: 'source_log_unavailable', reason: 'ECONNREFUSED' }]);
    expect(run.timeline).toEqual(['acquire:1']);
    expect(run.clock.pendingDelays()).toEqual([FIRST_BACKOFF_MS]);

    run.sourceLog.failCheckpointReads = false;
    await run.clock.advance(FIRST_BACKOFF_MS);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('si PostgreSQL no responde al buscar el evento del cursor en el índice, avisa con source_log_unavailable, espera y lo intenta otra vez', async () => {
    const events = previousConnectionEvents();
    const cursor: IngestionCursor = {
      active_segment_index: 0,
      connection_id: PREVIOUS,
      high_watermark_event_time_utc: '2026-03-02T09:59:00.000Z',
      last_durable_observation_id: uuid(9003),
      last_durable_source_event_id: uuid(9004),
      schema_version: '1.0.0',
      source: 'deriv_options',
      source_event_count: 3,
      symbol: SYMBOL,
      updated_at_utc: '2026-03-02T09:59:30.000Z',
    };
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        sourceLog.failEventLookups = true;
      },
      cursors: [cursor],
      events,
    });
    expect(run.alerts).toEqual([{ event: 'source_log_unavailable', reason: 'ECONNREFUSED' }]);
    expect(run.sourceLog.eventLookups).toEqual([uuid(9004)]);

    run.sourceLog.failEventLookups = false;
    await run.clock.advance(FIRST_BACKOFF_MS);
    expect(run.sourceLog.eventLookups).toEqual([uuid(9004), uuid(9004)]);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('si PostgreSQL no responde al leer los puntos de control en la reparación, el intento queda en pausa sin socket y el siguiente repara', async () => {
    const [opened, frame] = previousConnectionEvents();
    if (opened === undefined || frame === undefined) {
      throw new TypeError('Faltan la apertura y el tick.');
    }
    let reads = 0;
    const run = await sessionHarness({
      beforeStart: ({ sourceLog }) => {
        const read = sourceLog.readLiveCheckpoint.bind(sourceLog);
        vi.spyOn(sourceLog, 'readLiveCheckpoint').mockImplementation((...args) => {
          reads += 1;
          // La primera es la del arranque; la segunda, la de la reparación del primer intento.
          return reads === 2 ? Promise.reject(unavailable()) : read(...args);
        });
      },
      events: [opened, frame],
    });
    expect(run.timeline).toEqual(['acquire:1']);
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
        incident_type: 'persistence_unavailable',
      }) as unknown,
    ]);
    expect(run.clock.pendingDelays()).toEqual([FIRST_BACKOFF_MS]);

    // El intento siguiente repara el cierre y espera 1 ms a pasar su hora.
    await run.clock.advance(FIRST_BACKOFF_MS);
    await run.clock.advance(1);
    expect(run.timeline).toEqual(['acquire:1', 'connect:1']);
    expect(run.sourceLog.rows.map((row) => row.kind).slice(2)).toEqual(['connection_closed']);
    run.session.stop();
    expect((await run.done).end).toEqual({ status: 'completed' });
  });

  it('si la retención se cumple mientras el arranque lee los segmentos posteriores al punto de control, termina failed con retention_expired sin conectar ni escribir nada', async () => {
    const events = stoppedBeforeRecoveryEvents();
    const first = events[0];
    if (first === undefined) {
      throw new TypeError('Falta el primer evento.');
    }
    // Al arrancar faltan 30 s para que el evento más antiguo cumpla la retención.
    const retentionMs = Date.parse(START) - Date.parse(sourceEventTime(first));
    const gate = Promise.withResolvers<undefined>();
    let gated = false;
    const run = await sessionHarness({
      beforeStart: ({ objects, sourceLog }) => {
        const keys = new Set(
          sourceLog.closed.map((segment) => contentKey(segment.object_bytes_sha256)),
        );
        const get = objects.get.bind(objects);
        vi.spyOn(objects, 'get').mockImplementation(async (key, maxBytes) => {
          if (!gated && keys.has(key)) {
            gated = true;
            await gate.promise;
          }
          return get(key, maxBytes);
        });
      },
      closedSegments: [events.slice(0, 3)],
      events: events.slice(3),
      retentionMs: retentionMs + 30_000,
    });
    expect(gated).toBe(true);
    // La lectura del segmento cerrado tarda 60 s.
    run.clock.jumpWallClock(60_000);
    gate.resolve(undefined);
    const rows = run.sourceLog.rows.length;
    const result = await run.done;

    expect(result.end).toEqual({ detail: null, reason: 'retention_expired', status: 'failed' });
    expect(result.stopped_for_retention).toBe(false);
    expect(run.timeline).toEqual(['acquire:1', 'release:1']);
    expect(run.sourceLog.rows).toHaveLength(rows);
    expect(run.sourceLog.closed).toHaveLength(1);
  });

  it('si PostgreSQL no responde al leer los puntos de control mientras vigila el hueco, avisa con source_log_unavailable y lo intenta otra vez con el tick siguiente', async () => {
    const run = await sessionHarness({
      closedSegments: stoppedInTwoSegments().slice(0, 1),
    });
    // La lectura que pide el tick de E, posterior al cierre.
    vi.spyOn(run.sourceLog, 'readLiveCheckpoint').mockRejectedValueOnce(unavailable());
    await run.subscribe(run.socket(1), E, '100.75');
    expect(run.alerts).toEqual([{ event: 'source_log_unavailable', reason: 'ECONNREFUSED' }]);
    await run.clock.advance(HISTORY_DELAY_MS);
    expect(pages(run.socket(1))).toEqual([]);

    run.socket(1).text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    await run.clock.advance(HISTORY_DELAY_MS);
    // El fin del hueco sigue siendo el primer tick posterior al cierre, E.
    expect(pages(run.socket(1))).toEqual([page(3, S, E)]);
    run.socket(1).text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    await settle();
    expect((await stopSession(run, run.socket(1), 4)).end).toEqual({ status: 'completed' });
  });
});
