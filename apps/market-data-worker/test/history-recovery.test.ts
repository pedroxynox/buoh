import {
  connectionClosedSchema,
  connectionOpenedSchema,
  sha256Hex,
  type SourceEvent,
} from '@buoh/contracts';
import { deriveMarketData } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_TIMEOUT_MS } from '../src/deriv/connection.js';
import type {
  HistoryRecoveryOutcome,
  HistoryRecoveryRequest,
} from '../src/deriv/history-recovery.js';
import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { buildRawSourceFrame } from '../src/ingestion/raw-first-ingestor.js';
import {
  connectionHarness,
  settle,
  START_EPOCH,
  syntheticSchemas,
  uuid,
} from './support/connection-harness.js';
import { derivMessages } from './support/deriv-fixtures.js';
import { type MemoryObjectStore } from './support/memory-stores.js';

// Recuperación de historia en `DerivConnection` (ADR-0015 §4), con un solo intento. La conexión se
// arma sin el adaptador: socket falso, reloj y temporizador manuales, IDs secuenciales, almacenes en
// memoria y esquemas sintéticos. Ninguna prueba usa la red, el reloj real ni azar, y ningún precio
// es de mercado.

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

/** Conexión anterior del log, que la nueva supera. */
const PREVIOUS = uuid(9001);
/** S: segundo del high-watermark, el último tick antes del cierre (09:59:00). */
const S = START_EPOCH - 60;
/** E: segundo del primer tick posterior al cierre, el primero de la conexión nueva (10:00:00). */
const E = START_EPOCH;

/** El hueco que dan las reglas, y la cotización canónica recibida en cada extremo. */
const REQUEST: HistoryRecoveryRequest = {
  end_quote: '100.75',
  from_event_time_utc: '2026-03-02T09:59:00.001Z',
  start_quote: '100.25',
  symbol: 'SYNTH_100',
  to_event_time_utc: '2026-03-02T09:59:59.999Z',
};

/** La conexión anterior: su apertura, un tick en S (100.25) y su cierre remoto, que no es pedido. */
function previousConnection(): SourceEvent[] {
  const profile = createDerivMeasurementProfile({
    schemas: syntheticSchemas(),
    symbol: 'SYNTH_100',
  });
  return [
    connectionOpenedSchema.parse({
      connection_id: PREVIOUS,
      event_id: uuid(9002),
      kind: 'connection_opened',
      occurred_at_utc: '2026-03-02T09:58:00.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    }),
    buildRawSourceFrame(
      {
        connection_id: PREVIOUS,
        observation_id: uuid(9003),
        payload_utf8: derivMessages.tick(2, S, '100.25'),
        received_at_utc: '2026-03-02T09:59:00.000Z',
      },
      profile,
    ),
    connectionClosedSchema.parse({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'remote',
      connection_id: PREVIOUS,
      event_id: uuid(9004),
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T09:59:30.000Z',
      reason: 'close_code_1001',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    }),
  ];
}

/**
 * La conexión nueva, que supera a la anterior, suscrita y con su primer tick (E, 100.75) durable.
 * Después avanza 2000 ms, la espera que hará la sesión antes de pedir la historia. IDs: 1 la
 * conexión, 2 su apertura, 3 el catálogo y 4 el primer tick.
 */
async function recovering(options: { readonly deferClose?: boolean } = {}) {
  const run = await connectionHarness({
    ...options,
    events: previousConnection(),
    supersedes: PREVIOUS,
  });
  await run.subscribe(derivMessages.tick(2, E, '100.75'));
  await run.clock.advance(2000);
  return run;
}

type Run = Awaited<ReturnType<typeof recovering>>;

/** Una página pedida: `start` siempre en S, `end` según la página. */
function pageRequest(reqId: number, end: number) {
  return {
    count: 1000,
    end: String(end),
    req_id: reqId,
    start: S,
    style: 'ticks',
    ticks_history: 'SYNTH_100',
  };
}

/** Las páginas pedidas, después de `active_symbols` y `ticks`. */
const pagesSent = (run: Run) => run.socket().requests().slice(2);

/** Respuesta `history` a la página 3 con estos miembros, escritos tal cual. */
function historyPage(members: string): string {
  return `{"echo_req":{"req_id":3,"ticks_history":"SYNTH_100"},${members},"msg_type":"history","req_id":3}`;
}

/** `HistoryRecoveryResult` de esta conexión y este hueco, con su decisión. */
function expectedResult(eventId: number, occurredAt: string, decision: Record<string, unknown>) {
  return {
    connection_id: uuid(1),
    event_id: uuid(eventId),
    from_event_time_utc: REQUEST.from_event_time_utc,
    kind: 'history_recovery_result',
    occurred_at_utc: occurredAt,
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    symbol: 'SYNTH_100',
    to_event_time_utc: REQUEST.to_event_time_utc,
    ...decision,
  };
}

/**
 * Responde `count` páginas de un tick cada una, desde la 3: la página k pide `end` = E − (k − 1) y
 * trae solo ese segundo, así que nunca llega a S. El tick de E lleva `endPrice`.
 */
async function answerOneTickPages(run: Run, count: number, endPrice: string): Promise<void> {
  for (let page = 1; page <= count; page += 1) {
    const reqId = 2 + page;
    const time = E - (page - 1);
    expect(pagesSent(run).at(-1)).toEqual(pageRequest(reqId, time));
    run.socket().text(derivMessages.history(reqId, [time], [page === 1 ? endPrice : '100.5']));
    await settle();
  }
}

/** Retiene las escrituras de objetos hasta `release`, para dejar un frame en curso. */
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

describe('DerivConnection.recoverHistory: páginas y resultado (ADR-0015 §4)', () => {
  it('con los dos extremos y su cotización da complete: cuenta los ticks de en medio, queda en el log tras el primer tick posterior y no llega al sink', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();

    // Pide el rango del hueco, con los dos extremos incluidos: start = S y end = E, en texto.
    expect(run.socket().sent.slice(2)).toEqual([
      '{"count":1000,"end":"1772445600","req_id":3,"start":1772445540,"style":"ticks","ticks_history":"SYNTH_100"}',
    ]);
    const prices = ['100.25', '100.5', '100.6', '100.75'];
    run.socket().text(derivMessages.history(3, [S, S + 20, S + 40, E], prices));
    const finished = await outcome;

    // IDs: 5 la página y 6 el resultado.
    expect(finished).toEqual({
      attempts: 1,
      durable: true,
      pages: 1,
      result: expectedResult(6, '2026-03-02T10:00:02.000Z', {
        recovered_event_count: 2,
        status: 'complete',
      }),
      status: 'finished',
    });
    const events = await run.events();
    expect(events.slice(3).map((event) => event.kind)).toEqual([
      'connection_opened',
      'raw_source_frame',
      'raw_source_frame',
      'raw_source_frame',
      'history_recovery_result',
    ]);
    expect(events.at(-1)).toEqual(finished.status === 'finished' ? finished.result : null);
    // Los ticks recuperados quedan raw: el sink recibe solo el tick vivo.
    expect(run.ticks.map((tick) => tick.event_time_utc)).toEqual(['2026-03-02T10:00:00.000Z']);
    expect(run.nonTick.map((frame) => frame.msg_type)).toEqual(['active_symbols', 'history']);
    expect(run.requested.incidents).toEqual([]);
    expect(run.alerts).toEqual([]);
    // No queda ninguna página esperando: solo el keepalive y la duración.
    expect(run.clock.pendingDelays()).toEqual([43_000, 598_000]);
  });

  it('mientras una página no vacía no llega a S pide la anterior, con end en su primer tick − 1 s, y los ticks siguen llegando', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, S + 40, E], ['100.5', '100.6', '100.75']));
    await settle();
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    run.socket().text(derivMessages.history(4, [S, S + 10, S + 20], ['100.25', '100.3', '100.4']));
    const finished = await outcome;

    expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, S + 29)]);
    expect(finished).toMatchObject({
      attempts: 1,
      durable: true,
      pages: 2,
      result: { recovered_event_count: 4, status: 'complete' },
    });
    expect(run.ticks.map((tick) => tick.event_time_utc)).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T10:00:02.000Z',
    ]);
  });

  it('para con una página vacía: sin el tick de S, partial con history_boundary_missing', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, E], ['100.5', '100.75']));
    await settle();
    run.socket().text(derivMessages.history(4, [], []));
    const finished = await outcome;

    expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, S + 29)]);
    expect(finished).toMatchObject({
      pages: 2,
      result: { reason: 'history_boundary_missing', recovered_event_count: 1, status: 'partial' },
    });
  });

  it('una página que llega a S sin el tick de E termina la paginación con partial y history_boundary_missing', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S, S + 10, S + 20], ['100.25', '100.3', '100.4']));
    const finished = await outcome;

    expect(pagesSent(run)).toEqual([pageRequest(3, E)]);
    expect(finished).toMatchObject({
      pages: 1,
      result: { reason: 'history_boundary_missing', recovered_event_count: 2, status: 'partial' },
    });
  });

  it('pide como mucho 50 páginas: la 51 nunca se pide, y sin llegar a S da partial con history_page_limit', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerOneTickPages(run, 50, '100.75');
    const finished = await outcome;

    expect(pagesSent(run)).toHaveLength(50);
    expect(finished).toMatchObject({
      pages: 50,
      result: { reason: 'history_page_limit', recovered_event_count: 49, status: 'partial' },
    });
    expect(run.clock.pendingDelays()).toEqual([43_000, 598_000]);
  });

  it('si la primera página es un error de ticks_history, da unavailable con history_error_response y ninguna incidencia de respuesta pedida', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.historyError(3, 'InvalidSymbol'));

    expect(await outcome).toEqual({
      attempts: 1,
      durable: true,
      pages: 1,
      result: expectedResult(6, '2026-03-02T10:00:02.000Z', {
        reason: 'history_error_response',
        status: 'unavailable',
      }),
      status: 'finished',
    });
    // `ticks_history` no se declara: las reglas 2.0.0 ya lo registran como source_error_response.
    expect(run.invalid).toEqual([{ observation_id: uuid(5), reason: 'source_error_response' }]);
    expect(run.requested.incidents).toEqual([]);
  });

  it('una respuesta history con un objeto error deja su incidencia source_error_response y cuenta como error', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    const payload = historyPage('"error":{"code":"SyntheticError","message":"sintético"}');
    run.socket().text(payload);

    expect(await outcome).toMatchObject({
      result: { reason: 'history_error_response', status: 'unavailable' },
    });
    expect(run.invalid).toEqual([]);
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: sha256Hex(payload), reason: 'source_error_response' },
        observed_ref: uuid(5),
      }),
    ]);
  });

  it('una página sin respuesta en 15 000 ms es history_timeout y no cierra la conexión: los ticks siguen y la respuesta tardía se guarda raw y se ignora', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    let finished = false;
    void outcome.then(() => {
      finished = true;
    });
    await run.clock.advance(REQUEST_TIMEOUT_MS - 1);
    expect(finished).toBe(false);
    await run.clock.advance(1);

    expect(await outcome).toEqual({
      attempts: 1,
      durable: true,
      pages: 1,
      // IDs: 5 el resultado, porque no llegó ninguna página.
      result: expectedResult(5, '2026-03-02T10:00:17.000Z', {
        reason: 'history_timeout',
        status: 'unavailable',
      }),
      status: 'finished',
    });
    expect(run.socket().ended).toBeNull();
    const late = derivMessages.history(3, [S, E], ['100.25']);
    run.socket().text(derivMessages.tick(2, E + 18, '100.9'));
    run.socket().text(late);
    await settle();

    expect(run.ticks.map((tick) => tick.event_time_utc)).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T10:00:18.000Z',
    ]);
    const events = await run.events();
    expect(events.filter((event) => event.kind === 'history_recovery_result')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'raw_source_frame', payload_utf8: late });
    expect(run.requested.incidents).toEqual([]);
    run.socket().emit({ code: 1000, kind: 'closed' });
    expect((await run.run).end).toEqual({
      detail: '1000',
      reason: 'remote_closed',
      status: 'disconnected',
    });
  });

  it.each([
    [
      'un error de ticks_history',
      'history_error_response',
      () => derivMessages.historyError(4, 'SyntheticError'),
    ],
    [
      'una página incoherente',
      'history_invalid',
      () => derivMessages.history(4, [S, S + 10], ['100.25']),
    ],
    ['ninguna respuesta', 'history_timeout', null],
  ])(
    'si falla una página posterior (%s), da partial con %s y los ticks de las anteriores',
    async (_label, reason, answer) => {
      const run = await recovering();
      const outcome = run.connection.recoverHistory(REQUEST);
      await settle();
      const socket = run.socket();
      socket.text(derivMessages.history(3, [S + 30, S + 40, E], ['100.5', '100.6', '100.75']));
      await settle();
      if (answer === null) {
        await run.clock.advance(REQUEST_TIMEOUT_MS);
      } else {
        socket.text(answer());
      }

      expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, S + 29)]);
      expect(await outcome).toMatchObject({
        pages: 2,
        result: { reason, recovered_event_count: 2, status: 'partial' },
      });
    },
  );

  it.each([
    ['el tick de S trae otra cotización', ['100.26', '100.5', '100.75'], 2],
    ['el tick de E trae otra cotización', ['100.25', '100.5', '100.70'], 2],
    [
      'con el pip_size de la respuesta, el decimal canónico es otro',
      ['100.25', '100.5', '100.75'],
      3,
    ],
  ])('si %s, da partial con history_boundary_mismatch', async (_label, prices, pipSize) => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S, S + 30, E], prices, pipSize));

    expect(await outcome).toMatchObject({
      result: { reason: 'history_boundary_mismatch', recovered_event_count: 1, status: 'partial' },
    });
    expect(run.requested.incidents).toEqual([]);
  });
});

describe('DerivConnection.recoverHistory: precedencia del resultado', () => {
  it('una página posterior que falla manda sobre un extremo con otra cotización', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, E], ['100.5', '100.70']));
    await settle();
    run.socket().text(derivMessages.historyError(4, 'SyntheticError'));

    expect(await outcome).toMatchObject({
      result: { reason: 'history_error_response', recovered_event_count: 1, status: 'partial' },
    });
  });

  it('un extremo con otra cotización manda sobre el tope de páginas', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerOneTickPages(run, 50, '100.70');

    expect(await outcome).toMatchObject({
      pages: 50,
      result: { reason: 'history_boundary_mismatch', recovered_event_count: 49, status: 'partial' },
    });
  });

  it('un extremo con otra cotización manda sobre un extremo que falta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, E], ['100.5', '100.70']));
    await settle();
    run.socket().text(derivMessages.history(4, [], []));

    expect(await outcome).toMatchObject({
      result: { reason: 'history_boundary_mismatch', recovered_event_count: 1, status: 'partial' },
    });
  });
});

describe('DerivConnection.recoverHistory: páginas inválidas (ADR-0015 §4, «Raw primero»)', () => {
  const s = String(S);
  it.each([
    [
      'sin echo_req, que exige el esquema de respuesta',
      'schema_validation_failed',
      `{"history":{"prices":[100.25],"times":[${s}]},"msg_type":"history","pip_size":2,"req_id":3}`,
    ],
    [
      'un tiempo en texto, que el esquema rechaza',
      'schema_validation_failed',
      historyPage(`"history":{"prices":[100.25],"times":["${s}"]},"pip_size":2`),
    ],
    ['sin history', 'schema_validation_failed', historyPage('"pip_size":2')],
    [
      'sin history.times',
      'schema_validation_failed',
      historyPage('"history":{"prices":[100.25]},"pip_size":2'),
    ],
    [
      'sin history.prices',
      'schema_validation_failed',
      historyPage(`"history":{"times":[${s}]},"pip_size":2`),
    ],
    [
      'sin pip_size',
      'schema_validation_failed',
      historyPage(`"history":{"prices":[100.25],"times":[${s}]}`),
    ],
    ['pip_size 19', 'history_inconsistent', derivMessages.history(3, [S], ['100.25'], 19)],
    [
      'pip_size 2.5',
      'history_inconsistent',
      historyPage(`"history":{"prices":[100.25],"times":[${s}]},"pip_size":2.5`),
    ],
    [
      'times y prices de distinta longitud',
      'history_inconsistent',
      derivMessages.history(3, [S, E], ['100.25']),
    ],
    [
      'un tiempo repetido',
      'history_inconsistent',
      derivMessages.history(3, [S + 10, S + 10], ['100.3', '100.3']),
    ],
    [
      'tiempos que bajan',
      'history_inconsistent',
      derivMessages.history(3, [S + 20, S + 10], ['100.4', '100.3']),
    ],
    [
      'un tiempo antes de S',
      'history_inconsistent',
      derivMessages.history(3, [S - 1, E], ['100.2', '100.75']),
    ],
    [
      'un tiempo después del end pedido',
      'history_inconsistent',
      derivMessages.history(3, [S, E + 1], ['100.25', '100.8']),
    ],
    [
      'un tiempo con fracción, que el esquema admite',
      'history_inconsistent',
      historyPage(`"history":{"prices":[100.25],"times":[${s}.0]},"pip_size":2`),
    ],
    [
      'un precio con más decimales que pip_size',
      'history_inconsistent',
      derivMessages.history(3, [S], ['100.255']),
    ],
    [
      'un precio con exponente',
      'history_inconsistent',
      derivMessages.history(3, [S], ['1.0025e2']),
    ],
  ])('%s: incidencia %s y unavailable con history_invalid', async (_label, reason, payload) => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(payload);

    expect(await outcome).toMatchObject({
      pages: 1,
      result: { reason: 'history_invalid', status: 'unavailable' },
    });
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: sha256Hex(payload), reason },
        incident_type: 'invalid_source_frame',
        observed_ref: uuid(5),
        symbol: null,
      }),
    ]);
  });
});

describe('DerivConnection.recoverHistory: conexión perdida o cerrándose', () => {
  it('si la conexión se pierde con una página pendiente, se abandona: ningún resultado en el log ni tiempos pendientes', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, E], ['100.5', '100.75']));
    await settle();
    expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, S + 29)]);
    run.socket().emit({ code: 1006, kind: 'closed' });

    expect(await outcome).toEqual({ status: 'abandoned' } satisfies HistoryRecoveryOutcome);
    expect((await run.run).end).toEqual({
      detail: '1006',
      reason: 'transport_error',
      status: 'disconnected',
    });
    const events = await run.events();
    expect(events.map((event) => event.kind)).not.toContain('history_recovery_result');
    expect(events.at(-1)).toMatchObject({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'transport_error',
      kind: 'connection_closed',
      reason: 'close_code_1006',
    });
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('una página que queda durable después del cierre deja su incidencia, y no hay resultado', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // La respuesta y el corte llegan en la misma vuelta: el frame sigue en la cola.
    const payload = derivMessages.history(3, [S, E], ['100.25']);
    run.socket().text(payload);
    run.socket().emit({ code: 1006, kind: 'closed' });

    expect(await outcome).toEqual({ status: 'abandoned' });
    await run.run;
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: sha256Hex(payload), reason: 'history_inconsistent' },
        observed_ref: uuid(5),
      }),
    ]);
    expect((await run.events()).map((event) => event.kind)).not.toContain(
      'history_recovery_result',
    );
  });

  it('sin suscripción se abandona sin pedir nada', async () => {
    const run = await connectionHarness({ events: previousConnection(), supersedes: PREVIOUS });
    run.socket().open();
    await settle();

    expect(await run.connection.recoverHistory(REQUEST)).toEqual({ status: 'abandoned' });
    expect(run.socket().requests()).toEqual([{ active_symbols: 'brief', req_id: 1 }]);
  });

  it('con el cierre ya decidido se abandona sin pedir nada', async () => {
    const run = await recovering({ deferClose: true });
    // Un error del transporte decide el cierre; el aviso de ws llega más tarde.
    run.socket().emit({ code: 'ECONNRESET', kind: 'error' });

    expect(await run.connection.recoverHistory(REQUEST)).toEqual({ status: 'abandoned' });
    expect(pagesSent(run)).toEqual([]);
    run.socket().finishClose();
    await run.run;
  });
});

describe('DerivConnection.recoverHistory: errores de programación', () => {
  it.each([
    ['un inicio que no es un segundo + 1 ms', { from_event_time_utc: '2026-03-02T09:59:00.002Z' }],
    ['un fin que no es un segundo − 1 ms', { to_event_time_utc: '2026-03-02T09:59:59.998Z' }],
    ['un fin anterior al inicio', { from_event_time_utc: '2026-03-02T10:00:00.001Z' }],
    [
      'una hora que no está en UTC con milisegundos',
      { from_event_time_utc: '2026-03-02T09:59:00.001+00:00' },
    ],
    ['otro símbolo que el de la conexión', { symbol: 'SYNTH_50' }],
  ])('%s lanza TypeError, no pide nada y no deja nada en curso', async (_label, change) => {
    const run = await recovering();

    expect(() => run.connection.recoverHistory({ ...REQUEST, ...change })).toThrow(TypeError);
    await settle();
    expect(pagesSent(run)).toEqual([]);
    // La misma conexión acepta después el hueco correcto: el error era del pedido.
    void run.connection.recoverHistory(REQUEST);
    await settle();
    expect(pagesSent(run)).toEqual([pageRequest(3, E)]);
  });

  it('una segunda llamada con otra recuperación en curso lanza TypeError; terminada, se puede volver a pedir', async () => {
    const run = await recovering();
    const first = run.connection.recoverHistory(REQUEST);
    await settle();

    expect(() => run.connection.recoverHistory(REQUEST)).toThrow(TypeError);
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    expect(await first).toMatchObject({ result: { status: 'complete' } });
    void run.connection.recoverHistory(REQUEST);
    await settle();
    expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, E)]);
  });
});

describe('DerivConnection.recoverHistory: el resultado en el log', () => {
  it('si el resultado no queda durable, cierra como con un frame no durable: pausa por persistencia', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.sourceLog.failIndex = (row) => row.kind === 'history_recovery_result';
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));

    expect(await outcome).toEqual({
      attempts: 1,
      durable: false,
      pages: 1,
      result: expectedResult(6, '2026-03-02T10:00:02.000Z', {
        recovered_event_count: 0,
        status: 'complete',
      }),
      status: 'finished',
    });
    const result = await run.run;
    expect(run.socket().ended).toBe('terminate');
    expect(result.end).toEqual({
      detail: 'source_event_index',
      reason: 'persistence_unavailable',
      status: 'paused',
    });
    expect(result.closure).toEqual({
      closure_type: 'transport_error',
      persisted: false,
      reason: 'persistence_unavailable',
    });
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({ incident_type: 'persistence_unavailable', observed_ref: uuid(6) }),
    ]);
    expect((await run.events()).map((event) => event.kind)).not.toContain(
      'history_recovery_result',
    );
  });

  it('un resultado que ya estaba en la cola se procesa aunque después se decida el cierre: con la entrada cerrada, no queda durable', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // Un tick vivo queda en curso, con su escritura retenida; al vencer la página, el resultado entra
    // en la cola detrás de él.
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await run.clock.advance(REQUEST_TIMEOUT_MS);
    // La escritura del tick falla: el log falla, la entrada se cierra y se decide el cierre.
    run.objects.failPut = () => true;
    hold.release();

    expect(await outcome).toEqual({
      attempts: 1,
      durable: false,
      pages: 1,
      // IDs: 5 el tick vivo y 6 el resultado.
      result: expectedResult(6, '2026-03-02T10:00:17.000Z', {
        reason: 'history_timeout',
        status: 'unavailable',
      }),
      status: 'finished',
    });
    expect((await run.run).end).toEqual({
      detail: 'raw_object_write',
      reason: 'persistence_unavailable',
      status: 'paused',
    });
  });
});

describe('DerivConnection.recoverHistory con las reglas (ADR-0015 §2 y §4)', () => {
  it('pide el hueco que dan las reglas, y un resultado complete lo cierra', async () => {
    const run = await recovering();
    const before = deriveMarketData(await run.segments(), run.profile);
    expect(before.pendingGaps).toEqual([
      {
        from_event_time_utc: REQUEST.from_event_time_utc,
        symbol: 'SYNTH_100',
        to_event_time_utc: REQUEST.to_event_time_utc,
      },
    ]);
    // Las cotizaciones canónicas de los dos extremos, como las da la derivación.
    expect(before.ticks.map((tick) => [tick.event_time_utc, tick.quote_decimal])).toEqual([
      ['2026-03-02T09:59:00.000Z', REQUEST.start_quote],
      ['2026-03-02T10:00:00.000Z', REQUEST.end_quote],
    ]);
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S, S + 30, E], ['100.25', '100.5', '100.75']));
    expect(await outcome).toMatchObject({ durable: true, result: { status: 'complete' } });

    const after = deriveMarketData(await run.segments(), run.profile);
    expect(after.pendingGaps).toEqual([]);
    expect(after.pendingContinuitySymbols).toEqual([]);
    expect(after.openConditionTypes).toEqual([]);
    expect(after.incidents.map((incident) => incident.incident_type)).toEqual(['connection_lost']);
  });

  it('un resultado partial deja abierto event_gap_unresolved', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S, S + 30], ['100.25', '100.5']));
    expect(await outcome).toMatchObject({
      result: { reason: 'history_boundary_missing', status: 'partial' },
    });

    const after = deriveMarketData(await run.segments(), run.profile);
    expect(after.pendingGaps).toEqual([]);
    expect(after.openConditionTypes).toEqual(['event_gap_unresolved']);
    expect(after.incidents).toContainEqual(
      expect.objectContaining({
        evidence: {
          from_event_time_utc: REQUEST.from_event_time_utc,
          reason: 'history_boundary_missing',
          to_event_time_utc: REQUEST.to_event_time_utc,
        },
        incident_type: 'event_gap_unresolved',
        symbol: 'SYNTH_100',
      }),
    );
  });
});
