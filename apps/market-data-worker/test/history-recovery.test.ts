import { sha256Hex } from '@buoh/contracts';
import { deriveMarketData } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_TIMEOUT_MS } from '../src/deriv/connection.js';
import {
  historyRange,
  HistoryRecovery,
  type HistoryRecoveryHooks,
  type HistoryRecoveryOutcome,
} from '../src/deriv/history-recovery.js';
import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { connectionHarness, settle, START, uuid } from './support/connection-harness.js';
import { derivMessages, ManualClock } from './support/deriv-fixtures.js';
import {
  E,
  forgetAllSent,
  holdObjectWrites,
  pagesSent,
  PREVIOUS,
  previousConnectionEvents,
  recovering,
  REQUEST,
  results,
  S,
  type RecoveringRun,
} from './support/recovery-harness.js';

// Recuperación de historia en `DerivConnection` (ADR-0015 §4), con sus reintentos y el cierre
// previsto que la espera. La conexión se arma sin el adaptador: socket falso, reloj y temporizador
// manuales, IDs secuenciales, almacenes en memoria y esquemas sintéticos. Ninguna prueba usa la red,
// el reloj real ni azar, y ningún precio es de mercado.

/** Espera entre intentos (ADR-0015 §4, «Reintentos»). */
const RETRY_WAIT_MS = 30_000;
/** Intentos como máximo: el primero y dos reintentos. */
const ATTEMPTS = 3;

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

type Run = RecoveringRun;

/** `req_id` de cada página pedida, en orden. */
const pageIds = (run: Run) => pagesSent(run).map((page) => page['req_id']);

/** `end` de cada página pedida, en orden, como número. */
const pageEnds = (run: Run) => pagesSent(run).map((page) => Number(page['end']));

/** `req_id` de la última página pedida. */
function lastPageId(run: Run): number {
  const reqId = pageIds(run).at(-1);
  if (typeof reqId !== 'number') {
    throw new TypeError('No se pidió ninguna página.');
  }
  return reqId;
}

/** Responde la última página pedida con lo que da `payload` para su `req_id`. */
async function answerPage(run: Run, payload: (reqId: number) => string): Promise<void> {
  run.socket().text(payload(lastPageId(run)));
  await settle();
}

/**
 * Los tres intentos, iguales: `attempt` responde las páginas de cada uno, que empieza siempre por la
 * primera, y entre uno y otro pasan los 30 000 ms de la espera.
 */
async function everyAttempt(run: Run, attempt: () => Promise<void>): Promise<void> {
  for (let index = 1; index <= ATTEMPTS; index += 1) {
    if (index > 1) {
      await run.clock.advance(RETRY_WAIT_MS);
    }
    await attempt();
  }
}

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

/** Respuesta `history` a la página `reqId` (por defecto, la 3) con estos miembros, tal cual. */
function historyPage(members: string, reqId = 3): string {
  const id = String(reqId);
  return `{"echo_req":{"req_id":${id},"ticks_history":"SYNTH_100"},${members},"msg_type":"history","req_id":${id}}`;
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

  it('para con una página vacía: sin el tick de S, partial con history_boundary_missing, que se reintenta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await everyAttempt(run, async () => {
      await answerPage(run, (id) => derivMessages.history(id, [S + 30, E], ['100.5', '100.75']));
      await answerPage(run, (id) => derivMessages.history(id, [], []));
    });

    // Cada intento pide las mismas dos páginas.
    expect(pageEnds(run)).toEqual([E, S + 29, E, S + 29, E, S + 29]);
    expect(await outcome).toMatchObject({
      attempts: 3,
      pages: 2,
      result: { reason: 'history_boundary_missing', recovered_event_count: 1, status: 'partial' },
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

  it('si la página 50 llega a S, el tope no cuenta: con los dos extremos da complete, no history_page_limit', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // Páginas 1 a 49: un tick cada una, de E a E − 48. La 50 pide hasta E − 49 y trae todos los
    // segundos desde S, con su cotización.
    await answerOneTickPages(run, 49, '100.75');
    expect(pagesSent(run).at(-1)).toEqual(pageRequest(52, E - 49));
    const times = Array.from({ length: E - 49 - S + 1 }, (_, index) => S + index);
    const prices = times.map((time) => (time === S ? '100.25' : '100.5'));
    await answerPage(run, (id) => derivMessages.history(id, times, prices));

    expect(pagesSent(run)).toHaveLength(50);
    expect(await outcome).toMatchObject({
      attempts: 1,
      pages: 50,
      result: { recovered_event_count: 59, status: 'complete' },
    });
  });

  it('si la primera página es un error de ticks_history en los tres intentos, da unavailable con history_error_response y ninguna incidencia de respuesta pedida', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await everyAttempt(run, () =>
      answerPage(run, (id) => derivMessages.historyError(id, 'InvalidSymbol')),
    );

    // IDs: 5, 6 y 8 los errores, 7 la respuesta al ping de las 10:00:45 y 9 el resultado.
    expect(await outcome).toEqual({
      attempts: 3,
      durable: true,
      pages: 1,
      result: expectedResult(9, '2026-03-02T10:01:02.000Z', {
        reason: 'history_error_response',
        status: 'unavailable',
      }),
      status: 'finished',
    });
    // `ticks_history` no se declara: las reglas 2.0.0 ya lo registran como source_error_response.
    expect(run.invalid).toEqual(
      [5, 6, 8].map((id) => ({ observation_id: uuid(id), reason: 'source_error_response' })),
    );
    expect(run.requested.incidents).toEqual([]);
  });

  it('una respuesta history con un objeto error deja su incidencia source_error_response y cuenta como error, que se reintenta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    const payload = historyPage('"error":{"code":"SyntheticError","message":"sintético"}');
    run.socket().text(payload);
    await settle();
    // Como history_error_response se reintenta; history_invalid no se reintentaría.
    await run.clock.advance(RETRY_WAIT_MS);
    await answerPage(run, (id) => derivMessages.history(id, [S, E], ['100.25', '100.75']));

    expect(await outcome).toMatchObject({ attempts: 2, result: { status: 'complete' } });
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
    await run.clock.advance(REQUEST_TIMEOUT_MS - 1);
    expect(run.clock.pendingDelays()).toContain(1);
    await run.clock.advance(1);

    // La página venció: el intento terminó con history_timeout y el siguiente espera 30 000 ms.
    expect(run.clock.pendingDelays()).toContain(RETRY_WAIT_MS);
    expect(run.socket().ended).toBeNull();
    const late = derivMessages.history(3, [S, E], ['100.25']);
    run.socket().text(derivMessages.tick(2, E + 18, '100.9'));
    run.socket().text(late);
    await settle();

    expect(run.ticks.map((tick) => tick.event_time_utc)).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T10:00:18.000Z',
    ]);
    expect((await run.events()).at(-1)).toMatchObject({
      kind: 'raw_source_frame',
      payload_utf8: late,
    });
    expect(run.requested.incidents).toEqual([]);
    // Las páginas del segundo y del tercer intento tampoco responden: el resultado, el del tercero,
    // es unavailable.
    await run.clock.advance(2 * (RETRY_WAIT_MS + REQUEST_TIMEOUT_MS));
    expect(await outcome).toMatchObject({
      attempts: 3,
      durable: true,
      pages: 1,
      result: {
        occurred_at_utc: '2026-03-02T10:01:47.000Z',
        reason: 'history_timeout',
        status: 'unavailable',
      },
    });
    expect(await results(run)).toHaveLength(1);
    expect(run.socket().ended).toBeNull();
    run.socket().emit({ code: 1000, kind: 'closed' });
    expect((await run.run).end).toEqual({
      detail: '1000',
      reason: 'remote_closed',
      status: 'disconnected',
    });
  });

  it.each<[string, string, ((reqId: number) => string) | null, number]>([
    [
      'un error de ticks_history',
      'history_error_response',
      (id) => derivMessages.historyError(id, 'SyntheticError'),
      3,
    ],
    [
      'una página incoherente',
      'history_invalid',
      (id) => derivMessages.history(id, [S, S + 10], ['100.25']),
      1,
    ],
    ['ninguna respuesta', 'history_timeout', null, 3],
  ])(
    'si falla una página posterior (%s), da partial con %s y los ticks de las anteriores',
    async (_label, reason, answer, attempts) => {
      const run = await recovering();
      const outcome = run.connection.recoverHistory(REQUEST);
      await settle();
      const attempt = async () => {
        await answerPage(run, (id) =>
          derivMessages.history(id, [S + 30, S + 40, E], ['100.5', '100.6', '100.75']),
        );
        await (answer === null ? run.clock.advance(REQUEST_TIMEOUT_MS) : answerPage(run, answer));
      };
      await (attempts === 1 ? attempt() : everyAttempt(run, attempt));

      expect(pagesSent(run).slice(0, 2)).toEqual([pageRequest(3, E), pageRequest(4, S + 29)]);
      expect(pagesSent(run)).toHaveLength(2 * attempts);
      expect(await outcome).toMatchObject({
        attempts,
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
  it('una página posterior que falla manda sobre un extremo con otra cotización, así que se reintenta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await everyAttempt(run, async () => {
      await answerPage(run, (id) => derivMessages.history(id, [S + 30, E], ['100.5', '100.70']));
      await answerPage(run, (id) => derivMessages.historyError(id, 'SyntheticError'));
    });

    expect(await outcome).toMatchObject({
      attempts: 3,
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
    ['sin history, que el esquema admite', 'history_inconsistent', historyPage('"pip_size":2')],
    [
      'sin history.times, que el esquema admite',
      'history_inconsistent',
      historyPage('"history":{"prices":[100.25]},"pip_size":2'),
    ],
    [
      'sin history.prices, que el esquema admite',
      'history_inconsistent',
      historyPage(`"history":{"times":[${s}]},"pip_size":2`),
    ],
    [
      'sin pip_size, que el esquema admite',
      'history_inconsistent',
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
    const run = await connectionHarness({
      events: previousConnectionEvents(),
      supersedes: PREVIOUS,
    });
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
    // La página queda durable y un tick vivo, en curso, con su escritura retenida: el resultado entra
    // en la cola detrás de él.
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    // La escritura del tick falla: el log falla, la entrada se cierra y se decide el cierre.
    run.objects.failPut = () => true;
    hold.release();

    expect(await outcome).toEqual({
      attempts: 1,
      durable: false,
      pages: 1,
      // IDs: 5 la página, 6 el tick vivo y 7 el resultado.
      result: expectedResult(7, '2026-03-02T10:00:02.000Z', {
        recovered_event_count: 0,
        status: 'complete',
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
    // El tick de E trae otra cotización: partial, sin reintentos.
    run.socket().text(derivMessages.history(3, [S, S + 30, E], ['100.25', '100.5', '100.70']));
    expect(await outcome).toMatchObject({
      result: { reason: 'history_boundary_mismatch', status: 'partial' },
    });

    const after = deriveMarketData(await run.segments(), run.profile);
    expect(after.pendingGaps).toEqual([]);
    expect(after.openConditionTypes).toEqual(['event_gap_unresolved']);
    expect(after.incidents).toContainEqual(
      expect.objectContaining({
        evidence: {
          from_event_time_utc: REQUEST.from_event_time_utc,
          reason: 'history_boundary_mismatch',
          to_event_time_utc: REQUEST.to_event_time_utc,
        },
        incident_type: 'event_gap_unresolved',
        symbol: 'SYNTH_100',
      }),
    );
  });
});

describe('DerivConnection.recoverHistory: reintentos (ADR-0015 §4)', () => {
  it.each<[string, (run: Run) => Promise<void>, Record<string, unknown>]>([
    [
      'un error de ticks_history',
      (run) => answerPage(run, (id) => derivMessages.historyError(id, 'SyntheticError')),
      { reason: 'history_error_response', status: 'unavailable' },
    ],
    [
      'una página sin respuesta',
      (run) => run.clock.advance(REQUEST_TIMEOUT_MS),
      { reason: 'history_timeout', status: 'unavailable' },
    ],
    [
      'una página que llega a S sin el tick de E',
      (run) =>
        answerPage(run, (id) =>
          derivMessages.history(id, [S, S + 10, S + 20], ['100.25', '100.3', '100.4']),
        ),
      { reason: 'history_boundary_missing', recovered_event_count: 2, status: 'partial' },
    ],
  ])(
    'con %s se reintenta dos veces, 30 000 ms después de cada intento, y solo se persiste el resultado del tercero',
    async (_label, attempt, decision) => {
      const run = await recovering();
      const outcome = run.connection.recoverHistory(REQUEST);
      await settle();
      await attempt(run);
      for (let index = 2; index <= ATTEMPTS; index += 1) {
        await run.clock.advance(RETRY_WAIT_MS - 1);
        expect(pagesSent(run)).toHaveLength(index - 1);
        await run.clock.advance(1);
        // Un intento nuevo empieza por la primera página, con otro req_id.
        expect(pagesSent(run)).toHaveLength(index);
        expect(pagesSent(run).at(-1)).toEqual(pageRequest(lastPageId(run), E));
        await attempt(run);
      }
      const endedAt = run.clock.now();

      const finished = await outcome;
      expect(finished).toMatchObject({
        attempts: 3,
        durable: true,
        pages: 1,
        result: { ...decision, occurred_at_utc: endedAt },
        status: 'finished',
      });
      expect(new Set(pageIds(run)).size).toBe(3);
      expect(await results(run)).toEqual([finished.status === 'finished' ? finished.result : null]);
      // No hay un cuarto intento.
      await run.clock.advance(RETRY_WAIT_MS);
      expect(pagesSent(run)).toHaveLength(3);
    },
  );

  it('si el reintento termina bien, persiste complete con attempts 2; el error del primer intento no deja incidencia de respuesta pedida', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerPage(run, (id) => derivMessages.historyError(id, 'InvalidSymbol'));
    await run.clock.advance(RETRY_WAIT_MS);
    await answerPage(run, (id) =>
      derivMessages.history(id, [S, S + 30, E], ['100.25', '100.5', '100.75']),
    );

    // IDs: 5 el error, 6 la página del segundo intento y 7 el resultado.
    expect(await outcome).toEqual({
      attempts: 2,
      durable: true,
      pages: 1,
      result: expectedResult(7, '2026-03-02T10:00:32.000Z', {
        recovered_event_count: 1,
        status: 'complete',
      }),
      status: 'finished',
    });
    expect(pagesSent(run)).toEqual([pageRequest(3, E), pageRequest(4, E)]);
    expect(await results(run)).toHaveLength(1);
    // `ticks_history` no se declara: las reglas 2.0.0 ya lo registran como source_error_response.
    expect(run.invalid).toEqual([{ observation_id: uuid(5), reason: 'source_error_response' }]);
    expect(run.requested.incidents).toEqual([]);
  });

  it('un reintento vuelve a la primera página y pages cuenta solo las del intento persistido', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await everyAttempt(run, async () => {
      await answerPage(run, (id) =>
        derivMessages.history(id, [S + 30, S + 40, E], ['100.5', '100.6', '100.75']),
      );
      await run.clock.advance(REQUEST_TIMEOUT_MS);
    });

    expect(pageEnds(run)).toEqual([E, S + 29, E, S + 29, E, S + 29]);
    expect(await outcome).toMatchObject({
      attempts: 3,
      pages: 2,
      result: { reason: 'history_timeout', recovered_event_count: 2, status: 'partial' },
    });
  });

  it.each<[string, (run: Run) => Promise<void>, Record<string, unknown>, number]>([
    [
      'una página incoherente (history_invalid)',
      (run) => answerPage(run, (id) => derivMessages.history(id, [S, E], ['100.25'])),
      { reason: 'history_invalid', status: 'unavailable' },
      1,
    ],
    [
      'el tope de páginas (history_page_limit)',
      (run) => answerOneTickPages(run, 50, '100.75'),
      { reason: 'history_page_limit', recovered_event_count: 49, status: 'partial' },
      50,
    ],
    [
      'un extremo con otra cotización (history_boundary_mismatch)',
      (run) =>
        answerPage(run, (id) =>
          derivMessages.history(id, [S, S + 30, E], ['100.26', '100.5', '100.75']),
        ),
      { reason: 'history_boundary_mismatch', recovered_event_count: 1, status: 'partial' },
      1,
    ],
  ])('%s no se reintenta', async (_label, attempt, decision, pages) => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await attempt(run);

    expect(await outcome).toMatchObject({ attempts: 1, durable: true, pages, result: decision });
    await run.clock.advance(RETRY_WAIT_MS);
    expect(pagesSent(run)).toHaveLength(pages);
    expect(await results(run)).toHaveLength(1);
  });

  it('una primera página vacía da partial con history_boundary_missing y 0 ticks, y se reintenta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await everyAttempt(run, () => answerPage(run, (id) => derivMessages.history(id, [], [])));

    expect(pageEnds(run)).toEqual([E, E, E]);
    expect(await outcome).toMatchObject({
      attempts: 3,
      pages: 1,
      result: { reason: 'history_boundary_missing', recovered_event_count: 0, status: 'partial' },
    });
  });

  it('un cierre durante la espera entre intentos abandona la recuperación: no persiste nada y cancela la espera', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerPage(run, (id) => derivMessages.historyError(id, 'SyntheticError'));
    await run.clock.advance(RETRY_WAIT_MS - 1);
    run.socket().emit({ code: 1006, kind: 'closed' });

    expect(await outcome).toEqual({ status: 'abandoned' } satisfies HistoryRecoveryOutcome);
    expect((await run.run).end).toEqual({
      detail: '1006',
      reason: 'transport_error',
      status: 'disconnected',
    });
    expect(await results(run)).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);
    await run.clock.advance(1);
    expect(pagesSent(run)).toHaveLength(1);
  });

  it('otro mensaje con el req_id de una página se ignora: la página vence a los 15 000 ms y se reintenta', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // `ticks_history` sin `error` y un `ping` con el req_id 3: ninguno responde a la página.
    run.socket().text(
      JSON.stringify({
        echo_req: { req_id: 3, ticks_history: 'SYNTH_100' },
        msg_type: 'ticks_history',
        req_id: 3,
      }),
    );
    run.socket().text(derivMessages.ping(3));
    await run.clock.advance(REQUEST_TIMEOUT_MS - 1);
    expect(run.requested.incidents).toEqual([]);
    await run.clock.advance(1 + RETRY_WAIT_MS);
    expect(pagesSent(run)).toHaveLength(2);
    await answerPage(run, (id) => derivMessages.history(id, [S, E], ['100.25', '100.75']));

    expect(await outcome).toMatchObject({ attempts: 2, result: { status: 'complete' } });
    expect(run.requested.incidents).toEqual([]);
  });
});

describe('DerivConnection.recoverHistory: el cierre previsto por duración la espera (ADR-0015 §4)', () => {
  it('si la duración se cumple con una página pendiente, pide forget_all solo cuando el resultado es durable', async () => {
    const run = await recovering({ durationMs: 10_000 });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // La duración se cumple a las 10:00:10, 10 000 ms después del primer tick.
    await run.clock.advance(8000);
    expect(forgetAllSent(run)).toBe(false);
    // La página queda durable; el resultado, en curso, con su escritura retenida.
    run.socket().text(derivMessages.history(3, [S, S + 30, E], ['100.25', '100.5', '100.75']));
    const hold = holdObjectWrites(run.objects);
    await settle();
    expect(forgetAllSent(run)).toBe(false);
    hold.release();

    expect(await outcome).toMatchObject({ durable: true, result: { status: 'complete' } });
    await settle();
    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    run.socket().text(derivMessages.forgetAll(4));
    expect((await run.run).end).toEqual({ status: 'completed' });
    const events = await run.events();
    expect(events.slice(-4).map((event) => event.kind)).toEqual([
      'raw_source_frame',
      'history_recovery_result',
      'raw_source_frame',
      'connection_closed',
    ]);
    expect(events.at(-2)).toMatchObject({ payload_utf8: derivMessages.forgetAll(4) });
    expect(events.at(-1)).toMatchObject({ closure_type: 'requested', reason: 'requested' });
  });

  it('si la duración se cumple durante la espera entre intentos, espera también al intento siguiente', async () => {
    const run = await recovering({ durationMs: 10_000 });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerPage(run, (id) => derivMessages.historyError(id, 'SyntheticError'));
    // La duración se cumple a las 10:00:10, en la espera; el segundo intento sale a las 10:00:32.
    await run.clock.advance(RETRY_WAIT_MS);
    expect(forgetAllSent(run)).toBe(false);
    expect(pagesSent(run)).toHaveLength(2);
    await answerPage(run, (id) => derivMessages.history(id, [S, E], ['100.25', '100.75']));

    expect(await outcome).toMatchObject({ attempts: 2, durable: true });
    await settle();
    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 5 });
    run.socket().text(derivMessages.forgetAll(5));
    expect((await run.run).end).toEqual({ status: 'completed' });
    expect((await run.events()).slice(-4).map((event) => event.kind)).toEqual([
      'raw_source_frame',
      'history_recovery_result',
      'raw_source_frame',
      'connection_closed',
    ]);
  });

  it('sin recuperación en curso, la duración pide forget_all al cumplirse, aunque antes hubo una', async () => {
    const run = await recovering({ durationMs: 10_000 });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerPage(run, (id) => derivMessages.history(id, [S, E], ['100.25', '100.75']));
    await outcome;
    await run.clock.advance(7999);
    expect(forgetAllSent(run)).toBe(false);
    await run.clock.advance(1);

    expect(run.socket().requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
  });

  it('un cierre no previsto durante la recuperación no espera, aunque el previsto esté esperando: abandona y cierra enseguida', async () => {
    const run = await recovering({ durationMs: 10_000 });
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await run.clock.advance(8000);
    run.socket().emit({ code: 1006, kind: 'closed' });

    expect(await outcome).toEqual({ status: 'abandoned' });
    expect((await run.run).end).toEqual({
      detail: '1006',
      reason: 'transport_error',
      status: 'disconnected',
    });
    expect(forgetAllSent(run)).toBe(false);
    expect((await run.events()).at(-1)).toMatchObject({
      closure_type: 'transport_error',
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T10:00:10.000Z',
    });
    expect(await results(run)).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si la conexión falla mientras el cierre previsto espera a la recuperación, no pide forget_all: el cierre se decide antes de abandonarla', async () => {
    // Release sintética cuyo esquema de `ping` rechaza la petición: el keepalive es un error del
    // código, que falla la conexión.
    const run = await recovering({
      durationMs: 10_000,
      schemaOverrides: {
        'ping_request.schema.json': {
          $schema: 'http://json-schema.org/draft-04/schema#',
          type: 'string',
        },
      },
    });
    const rejected = run.run.then(
      () => null,
      (error: unknown) => error,
    );
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // La duración se cumple a las 10:00:10 y la página vence a las 10:00:17: el cierre previsto
    // espera al reintento de las 10:00:47, y el keepalive de las 10:00:45 falla la conexión antes.
    await run.clock.advance(42_999);
    expect(forgetAllSent(run)).toBe(false);
    await run.clock.advance(1);

    expect(await rejected).toBeInstanceOf(TypeError);
    expect(await outcome).toEqual({ status: 'abandoned' });
    expect(forgetAllSent(run)).toBe(false);
  });
});

describe('DerivConnection.recoverHistory: el resultado en la cola y el cierre', () => {
  it('un resultado ya en la cola seguido de un cierre remoto queda durable antes del ConnectionClosed', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    // El resultado entra en la cola detrás de un tick vivo, con su escritura retenida.
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    run.socket().emit({ code: 1001, kind: 'closed' });
    hold.release();

    expect(await outcome).toMatchObject({
      attempts: 1,
      durable: true,
      result: { status: 'complete' },
    });
    expect((await run.run).end).toEqual({
      detail: '1001',
      reason: 'remote_closed',
      status: 'disconnected',
    });
    const events = await run.events();
    expect(events.slice(-4).map((event) => event.kind)).toEqual([
      'raw_source_frame',
      'raw_source_frame',
      'history_recovery_result',
      'connection_closed',
    ]);
    expect(events.at(-1)).toMatchObject({ closure_type: 'remote', reason: 'close_code_1001' });
  });

  it('si la conexión falla con el resultado en la cola, la recuperación se abandona y el resultado nunca llega al log', async () => {
    // Release sintética cuyo esquema de `ping` rechaza la petición: el keepalive es un error del
    // código, que falla la conexión mientras la cola sigue funcionando.
    const run = await recovering({
      schemaOverrides: {
        'ping_request.schema.json': {
          $schema: 'http://json-schema.org/draft-04/schema#',
          type: 'string',
        },
      },
    });
    const rejected = run.run.then(
      () => null,
      (error: unknown) => error,
    );
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S, E], ['100.25', '100.75']));
    const hold = holdObjectWrites(run.objects);
    run.socket().text(derivMessages.tick(2, E + 2, '100.8'));
    await settle();
    // El keepalive sale a las 10:00:45.
    await run.clock.advance(43_000);

    expect(await rejected).toBeInstanceOf(TypeError);
    expect(await outcome).toEqual({ status: 'abandoned' });
    hold.release();
    await settle();
    expect(await results(run)).toEqual([]);
    expect(run.socket().ended).toBe('terminate');
  });

  it('la página de un reintento que queda durable después del cierre deja su incidencia, y no hay resultado', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    await answerPage(run, (id) => derivMessages.historyError(id, 'SyntheticError'));
    await run.clock.advance(RETRY_WAIT_MS);
    // La respuesta y el corte llegan en la misma vuelta: el frame sigue en la cola.
    const payload = derivMessages.history(lastPageId(run), [S, E], ['100.25']);
    run.socket().text(payload);
    run.socket().emit({ code: 1006, kind: 'closed' });

    expect(await outcome).toEqual({ status: 'abandoned' });
    await run.run;
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: sha256Hex(payload), reason: 'history_inconsistent' },
      }),
    ]);
    expect(await results(run)).toEqual([]);
  });

  it('la página 2 se comprueba contra su propio end: un tiempo después de él es history_inconsistent', async () => {
    const run = await recovering();
    const outcome = run.connection.recoverHistory(REQUEST);
    await settle();
    run.socket().text(derivMessages.history(3, [S + 30, E], ['100.5', '100.75']));
    await settle();
    // La página 2 pide hasta S + 29: S + 30 ya vino en la página 1.
    const payload = derivMessages.history(4, [S, S + 30], ['100.25', '100.5']);
    run.socket().text(payload);

    expect(await outcome).toMatchObject({
      attempts: 1,
      pages: 2,
      result: { reason: 'history_invalid', recovered_event_count: 1, status: 'partial' },
    });
    expect(run.requested.incidents).toEqual([
      expect.objectContaining({
        evidence: { raw_payload_sha256: sha256Hex(payload), reason: 'history_inconsistent' },
      }),
    ]);
  });
});

describe('HistoryRecovery: una página que no sale (invariante de sendPage)', () => {
  // La conexión devuelve `null` solo después de abandonar la recuperación, así que este caso se
  // prueba con hooks falsos.
  it('si sendPage no envía la página de un reintento con la recuperación en curso, la abandona: outcome se resuelve, no encola ningún resultado y no deja tiempos pendientes', async () => {
    const clock = new ManualClock(START);
    // La página del primer intento sale con el req_id 1; la del reintento, no.
    const sendPage = vi
      .fn<HistoryRecoveryHooks['sendPage']>()
      .mockReturnValueOnce(1)
      .mockReturnValue(null);
    const queueResult = vi.fn<HistoryRecoveryHooks['queueResult']>();
    const recovery = new HistoryRecovery({
      hooks: { queueResult, scheduler: clock.scheduler, sendPage },
      range: historyRange(REQUEST),
      request: REQUEST,
    });
    recovery.start();
    // Un error de ticks_history termina el primer intento: el reintento sale 30 000 ms después.
    recovery.onPage(1, { incident: null, status: 'error_response' });
    await clock.advance(RETRY_WAIT_MS);

    expect(sendPage.mock.calls).toEqual([[{ end: E, start: S }], [{ end: E, start: S }]]);
    expect(recovery.abandoned).toBe(true);
    expect(await recovery.outcome).toEqual({
      status: 'abandoned',
    } satisfies HistoryRecoveryOutcome);
    expect(queueResult).not.toHaveBeenCalled();
    expect(clock.pendingDelays()).toEqual([]);
  });
});
