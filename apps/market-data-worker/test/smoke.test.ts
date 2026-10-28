import { deriveCatalogContentSha256 } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type HistoryRecoveryOutcome } from '../src/deriv/history-recovery.js';
import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  distribution,
  lastDurableRecovery,
  parseSmokeArgs,
  runSmoke,
  smokeCommand,
  smokeExitCode,
  UsageError,
  type OperationalAlert,
  type SmokeReport,
} from '../src/index.js';
import {
  derivMessages,
  FakeDerivSocket,
  flush,
  ManualClock,
  SYNTH_50,
  SYNTH_100,
  syntheticSchemaArchive,
} from './support/deriv-fixtures.js';

// `data:smoke` (ADR-0012 §10) sin red: socket falso, reloj y temporizador manuales, IDs
// secuenciales y esquemas sintéticos. El resultado tiene que salir saneado, sin payloads ni precios.
const START = '2026-03-02T10:00:00.000Z';
const START_EPOCH = Date.parse(START) / 1000;

function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flush();
  }
}

/**
 * Un smoke de 10 s sobre la sesión, con `random` 0: la primera espera antes de reconectar es de
 * 500 ms.
 */
function smoke(
  options: { readonly interruptAfterSeconds?: number; readonly symbol?: string } = {},
) {
  forbidAmbientEffects();
  const clock = new ManualClock(START);
  const fixture = syntheticSchemaArchive();
  const sockets: FakeDerivSocket[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  let sequence = 0;
  const run = runSmoke({
    alert: (payload) => alerts.push(payload),
    connect: (input) => {
      const socket = new FakeDerivSocket(input);
      sockets.push(socket);
      return socket;
    },
    durationSeconds: 10,
    expected: fixture.expected,
    fetch: () => Promise.resolve(new Response(fixture.archive)),
    ...(options.interruptAfterSeconds === undefined
      ? {}
      : { interruptAfterSeconds: options.interruptAfterSeconds }),
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    random: () => 0,
    scheduler: clock.scheduler,
    schemaUrl: 'https://schemas.invalid/schemas.zip',
    symbol: options.symbol ?? 'SYNTH_100',
    zlibVersion: 'test',
  });
  /** El socket número `number` del smoke, desde 1; falla si no existe. */
  const socket = (number = 1): FakeDerivSocket => {
    const found = sockets[number - 1];
    if (found === undefined) {
      throw new TypeError(`El smoke no abrió el socket ${String(number)}.`);
    }
    return found;
  };
  return { alerts, clock, fixture, run, socket, sockets };
}

type SmokeRun = ReturnType<typeof smoke>;

/** Espera entre el primer tick posterior al cierre y la petición de historia (ADR-0015 §4). */
const HISTORY_DELAY_MS = 2000;

/** El plazo del cierre previsto: 10 s después de la primera apertura durable, a las 10:00:00. */
const DEADLINE = '2026-03-02T10:00:10.000Z';

/** Avanza el reloj hasta `instantUtc`. */
async function advanceTo(run: SmokeRun, instantUtc: string): Promise<void> {
  await run.clock.advance(Date.parse(instantUtc) - Date.parse(run.clock.now()));
}

/** Las páginas de historia que pidió el socket, sin las demás peticiones. */
const pages = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'ticks_history' in request);

/**
 * La primera conexión: abre a las 10:00:00, recibe el catálogo (`req_id` 1), el primer tick de la
 * suscripción (`req_id` 2, de las 10:00:00) a las 10:00:00.200, la hora del servidor (`req_id` 3) y
 * el tick de las 10:00:02 a las 10:00:02.200: dos retrasos de 200 ms y 2 s entre sus horas.
 */
async function firstConnection(run: SmokeRun): Promise<void> {
  const socket = run.socket(1);
  socket.open();
  await settle();
  socket.text(derivMessages.catalog(1));
  await settle();
  await run.clock.advance(200);
  socket.text(derivMessages.tick(2, START_EPOCH, '100.25'));
  await settle();
  socket.text(derivMessages.time(3, START_EPOCH));
  await settle();
  await run.clock.advance(2000);
  socket.text(derivMessages.tick(2, START_EPOCH + 2, '101.50'));
  await settle();
}

/**
 * La conexión que sigue a la primera, tras la espera de 500 ms: su suscripción repite el tick de
 * las 10:00:02, el high-watermark del hueco, y responde `time` con las 10:00:03;
 * `newTickAfterMs` después llega el de las 10:00:04, el primero posterior al cierre.
 */
async function secondConnection(run: SmokeRun, newTickAfterMs = 400): Promise<FakeDerivSocket> {
  await run.clock.advance(500);
  const socket = run.socket(2);
  socket.open();
  await settle();
  socket.text(derivMessages.catalog(1));
  await settle();
  socket.text(derivMessages.tick(2, START_EPOCH + 2, '101.50'));
  await settle();
  socket.text(derivMessages.time(3, START_EPOCH + 3));
  await settle();
  await run.clock.advance(newTickAfterMs);
  socket.text(derivMessages.tick(2, START_EPOCH + 4, '100.5'));
  await settle();
  return socket;
}

/**
 * 2000 ms después del primer tick posterior al cierre, la segunda conexión pide el hueco entre las
 * 10:00:02 y las 10:00:04 (`req_id` 4) y recibe la página con `prices`; al plazo pide `forget_all`
 * (`req_id` 5) y recibe su respuesta.
 */
async function recoverAndFinish(
  run: SmokeRun,
  socket: FakeDerivSocket,
  prices: readonly string[] = ['101.50', '100.75', '100.5'],
): Promise<SmokeReport> {
  await run.clock.advance(HISTORY_DELAY_MS);
  expect(pages(socket)).toEqual([
    {
      count: 1000,
      end: String(START_EPOCH + 4),
      req_id: 4,
      start: START_EPOCH + 2,
      style: 'ticks',
      ticks_history: 'SYNTH_100',
    },
  ]);
  socket.text(
    derivMessages.history(4, [START_EPOCH + 2, START_EPOCH + 3, START_EPOCH + 4], prices),
  );
  await settle();
  await advanceTo(run, DEADLINE);
  expect(socket.requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 5 });
  socket.text(derivMessages.forgetAll(5));
  return run.run;
}

/** Ninguna cotización de los ticks ni de la historia, ni un payload, sale en la línea. */
function expectNoPrices(report: SmokeReport): void {
  const line = JSON.stringify(report);
  for (const forbidden of ['100.25', '101.5', '100.75', '100.5', 'quote', 'prices', 'payload']) {
    expect(line).not.toContain(forbidden);
  }
}

/** Catálogo de las dos entradas sintéticas, sin `trade_count`, ordenado por código. */
const CATALOG_CONTENT_SHA256 = deriveCatalogContentSha256(
  [SYNTH_100, SYNTH_50].map((entry) => ({
    exchange_is_open: 1 as const,
    is_trading_suspended: 0 as const,
    market: entry.market,
    pip_size: '0.01',
    subgroup: entry.subgroup,
    submarket: entry.submarket,
    underlying_symbol: entry.underlying_symbol,
    underlying_symbol_name: entry.underlying_symbol_name,
    underlying_symbol_type: entry.underlying_symbol_type,
  })),
);

describe('runSmoke', () => {
  it('sin corte, pasa con el cierre previsto de una sola conexión y da un resultado saneado con sus distribuciones', async () => {
    const run = smoke();
    await settle();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    await settle();
    // Tres ticks: retrasos de 400 ms (el primero, aparte), 700 y 250 ms, y 2 s entre sus horas.
    await run.clock.advance(400);
    socket.text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await settle();
    socket.text(derivMessages.time(3, START_EPOCH));
    await settle();
    await run.clock.advance(2300);
    socket.text(derivMessages.tick(2, START_EPOCH + 2, '101.50'));
    await settle();
    await run.clock.advance(1550);
    socket.text(derivMessages.tick(2, START_EPOCH + 4, '99.75'));
    await settle();
    // La duración cuenta desde la primera apertura durable de la sesión (10:00:00), no desde el
    // primer tick.
    await run.clock.advance(5749);
    expect(socket.requests().at(-1)).toEqual({ req_id: 3, time: 1 });
    await run.clock.advance(1);
    expect(socket.requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    socket.text(derivMessages.forgetAll(4));
    const report: SmokeReport = await run.run;

    expect(report).toEqual({
      catalog: { content_sha256: CATALOG_CONTENT_SHA256, entry_count: 2 },
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connections: 1,
      connector_version: DERIV_CONNECTOR_VERSION,
      delivery_delay_ms: { count: 2, max: 700, min: 250, p50: 250, p90: 700, p99: 700 },
      duration_seconds: 10,
      end: { status: 'completed' },
      finished_at_utc: DEADLINE,
      first_tick_delay_ms: 400,
      frames: {
        invalid: 0,
        non_tick: { active_symbols: 1, forget_all: 1, time: 1 },
        raw: 6,
        ticks: 3,
      },
      incidents: { invalid_frames: {}, operational: {}, requested_responses: {} },
      interrupt_after_seconds: null,
      // El aviso de ADR-0012 §10, escrito aquí como oráculo.
      note: 'Deriv da sus horas en segundos enteros: el retraso y el desfase medidos pueden superar a los reales hasta en 999 ms. El primer tick de la suscripción va aparte, porque puede ser uno que Deriv ya tenía.',
      reconnect_waits_ms: [],
      reconnections: 0,
      recovery: null,
      schemas: {
        archive_sha256: run.fixture.expected.archive_sha256,
        release: 'synthetic-deriv-1',
      },
      server_time_offset_ms: 400,
      source: DERIV_SOURCE,
      source_time_resolution_ms: 1000,
      started_at_utc: START,
      status: 'passed',
      symbol: 'SYNTH_100',
      symbol_name: 'Synthetic 100 Index',
      tick_interval_ms: { count: 2, max: 2000, min: 2000, p50: 2000, p90: 2000, p99: 2000 },
    });
    // Saneado: ni precios ni payloads.
    const line = JSON.stringify(report);
    for (const forbidden of ['100.25', '101.5', '99.75', 'quote', 'payload', 'sub-1']) {
      expect(line).not.toContain(forbidden);
    }
    expect(run.alerts).toEqual([]);
    expect(smokeExitCode(report)).toBe(0);
  });

  it('con --interrupt-after-seconds, corta su socket una vez, reconecta, recupera el hueco con complete y pasa con el cierre previsto', async () => {
    const run = smoke({ interruptAfterSeconds: 3 });
    await settle();
    await firstConnection(run);
    // El corte llega 3 s después del primer tick durable, a las 10:00:03.200.
    await run.clock.advance(999);
    expect(run.socket(1).ended).toBeNull();
    await run.clock.advance(1);
    expect(run.socket(1).ended).toBe('terminate');
    await settle();
    const socket = await secondConnection(run);
    const report = await recoverAndFinish(run, socket);

    expect(report).toMatchObject({
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connections: 2,
      end: { status: 'completed' },
      finished_at_utc: DEADLINE,
      frames: {
        invalid: 0,
        non_tick: { active_symbols: 2, forget_all: 1, history: 1, time: 2 },
        // Cuatro de la primera conexión y seis de la segunda.
        raw: 10,
        ticks: 4,
      },
      incidents: { invalid_frames: {}, operational: {}, requested_responses: {} },
      interrupt_after_seconds: 3,
      reconnect_waits_ms: [500],
      reconnections: 1,
      recovery: {
        attempts: 1,
        pages: 1,
        reason: null,
        recovered_event_count: 1,
        status: 'complete',
      },
      // La hora del servidor de la última conexión: 10:00:03.700 menos las 10:00:03.
      server_time_offset_ms: 700,
      status: 'passed',
    });
    expect(run.sockets).toHaveLength(2);
    expect(run.socket(2).ended).toBe('close');
    expectNoPrices(report);
    expect(run.alerts).toEqual([]);
    expect(smokeExitCode(report)).toBe(0);
  });

  it('con varias suscripciones, el primer tick de cada una va aparte y los intervalos son entre ticks de la misma suscripción', async () => {
    const run = smoke({ interruptAfterSeconds: 3 });
    await settle();
    await firstConnection(run);
    await run.clock.advance(1000);
    await settle();
    const report = await recoverAndFinish(run, await secondConnection(run));

    // La segunda suscripción repite a las 10:00:03.700 el tick de las 10:00:02, con 1700 ms de
    // retraso y la misma hora: ni ese retraso ni el intervalo de 0 ms entran. El tick de las
    // 10:00:04 llega a las 10:00:04.100.
    expect(report.first_tick_delay_ms).toBe(200);
    expect(report.delivery_delay_ms).toEqual({
      count: 2,
      max: 200,
      min: 100,
      p50: 100,
      p90: 200,
      p99: 200,
    });
    expect(report.tick_interval_ms).toEqual({
      count: 2,
      max: 2000,
      min: 2000,
      p50: 2000,
      p90: 2000,
      p99: 2000,
    });
  });

  it('falla si la conexión se pierde mientras espera la respuesta a forget_all: la sesión termina completed sin reconectar, pero el último cierre no es el previsto', async () => {
    const run = smoke();
    await settle();
    await firstConnection(run);
    await advanceTo(run, DEADLINE);
    expect(run.socket(1).requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    const report = await run.run;

    expect(report).toMatchObject({
      closure: { closure_type: 'remote', persisted: true, reason: 'close_code_1001' },
      connections: 1,
      end: { status: 'completed' },
      frames: { ticks: 2 },
      reconnections: 0,
      status: 'failed',
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('si la conexión se pierde sin pedirlo, reconecta y recupera el hueco, pero falla: sin corte no admite ninguna reconexión', async () => {
    const run = smoke();
    await settle();
    await firstConnection(run);
    await run.clock.advance(1000);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    const report = await recoverAndFinish(run, await secondConnection(run));

    expect(report).toMatchObject({
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connections: 2,
      end: { status: 'completed' },
      interrupt_after_seconds: null,
      reconnect_waits_ms: [500],
      reconnections: 1,
      recovery: { status: 'complete' },
      status: 'failed',
    });
    expectNoPrices(report);
    expect(smokeExitCode(report)).toBe(1);
  });

  it('con --interrupt-after-seconds, falla si la única reconexión no fue la del corte: el servidor cerró antes y el corte llegó mientras reconectaba', async () => {
    const run = smoke({ interruptAfterSeconds: 3 });
    await settle();
    await firstConnection(run);
    // El servidor cierra a las 10:00:03; el corte vence a las 10:00:03.200, durante la espera.
    await run.clock.advance(800);
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    const socket = await secondConnection(run, 600);
    const report = await recoverAndFinish(run, socket);

    expect(run.socket(1).ended).toBeNull();
    expect(run.socket(2).ended).toBe('close');
    expect(report).toMatchObject({
      connections: 2,
      end: { status: 'completed' },
      interrupt_after_seconds: 3,
      reconnections: 1,
      recovery: { status: 'complete' },
      status: 'failed',
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('con --interrupt-after-seconds, falla si la recuperación no es complete, y el resultado da su motivo', async () => {
    const run = smoke({ interruptAfterSeconds: 3 });
    await settle();
    await firstConnection(run);
    await run.clock.advance(1000);
    await settle();
    // La página trae otra cotización en el high-watermark: partial, sin reintentos.
    const report = await recoverAndFinish(run, await secondConnection(run), [
      '101.25',
      '100.75',
      '100.5',
    ]);

    expect(report).toMatchObject({
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      reconnections: 1,
      recovery: {
        attempts: 1,
        pages: 1,
        reason: 'history_boundary_mismatch',
        recovered_event_count: 1,
        status: 'partial',
      },
      status: 'failed',
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('falla sin ticks normalizados aunque la conexión termine con el cierre previsto', async () => {
    const run = smoke();
    await settle();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    await settle();
    // Confirma la suscripción, pero su precio con exponente no se normaliza.
    socket.text(derivMessages.tick(2, START_EPOCH, '1e2'));
    await settle();
    socket.text(derivMessages.time(3, START_EPOCH));
    await settle();
    await run.clock.advance(10_000);
    socket.text(derivMessages.forgetAll(4));
    const report = await run.run;

    expect(report).toMatchObject({
      delivery_delay_ms: null,
      end: { status: 'completed' },
      first_tick_delay_ms: null,
      frames: { invalid: 1, ticks: 0 },
      incidents: { invalid_frames: { quote_exponent_not_supported: 1 } },
      status: 'failed',
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('cuenta las incidencias del registro operativo de un frame cortado; la sesión reconecta después de la pausa, así que el smoke falla', async () => {
    const run = smoke();
    await settle();
    run.socket(1).open();
    await settle();
    run.socket(1).emit({ kind: 'frame_too_large', observed_value: 2_000_000 });
    await settle();
    // La conexión terminó en pausa antes de suscribirse; la siguiente reabre la entrada.
    await run.clock.advance(500);
    const socket = run.socket(2);
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    await settle();
    socket.text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await settle();
    socket.text(derivMessages.time(3, START_EPOCH));
    await settle();
    await advanceTo(run, DEADLINE);
    expect(socket.requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    socket.text(derivMessages.forgetAll(4));
    const report = await run.run;

    expect(report).toMatchObject({
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connections: 2,
      end: { status: 'completed' },
      frames: { ticks: 1 },
      incidents: { operational: { source_limit_exceeded: 1 } },
      reconnect_waits_ms: [500],
      reconnections: 1,
      // La primera conexión no estaba suscrita: no dejó hueco que recuperar.
      recovery: null,
      status: 'failed',
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('falla si el símbolo no está en el catálogo, sin distribuciones', async () => {
    const run = smoke({ symbol: 'SYNTH_999' });
    await settle();
    run.socket().open();
    await settle();
    run.socket().text(derivMessages.catalog(1));
    const report = await run.run;

    expect(report).toMatchObject({
      closure: { closure_type: 'requested', persisted: true, reason: 'symbol_not_in_catalog' },
      connections: 1,
      delivery_delay_ms: null,
      end: { detail: null, reason: 'symbol_not_in_catalog', status: 'failed' },
      frames: { ticks: 0 },
      reconnections: 0,
      status: 'failed',
      symbol: 'SYNTH_999',
      symbol_name: null,
      tick_interval_ms: null,
    });
    expect(smokeExitCode(report)).toBe(1);
  });

  it('cuenta los frames inválidos y las respuestas pedidas inválidas sin dejar de pasar', async () => {
    const run = smoke();
    await settle();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    await settle();
    socket.text(derivMessages.tick(2, START_EPOCH));
    await settle();
    socket.text(derivMessages.error(3, 'time', { time: 1 }));
    socket.text('esto no es JSON');
    await settle();
    await run.clock.advance(10_000);
    socket.text(derivMessages.forgetAll(4));
    const report = await run.run;

    expect(report.status).toBe('passed');
    expect(report.server_time_offset_ms).toBeNull();
    expect(report.frames).toEqual({
      invalid: 1,
      non_tick: { active_symbols: 1, forget_all: 1, time: 1 },
      raw: 5,
      ticks: 1,
    });
    expect(report.incidents).toEqual({
      invalid_frames: { payload_not_json: 1 },
      operational: {},
      requested_responses: { source_error_response: 1 },
    });
    expect(report.tick_interval_ms).toBeNull();
  });

  it('si los esquemas no cargan, falla sin conectar', async () => {
    forbidAmbientEffects();
    const clock = new ManualClock(START);
    const fixture = syntheticSchemaArchive();
    let connected = false;
    const report = await runSmoke({
      alert: () => undefined,
      connect: () => {
        connected = true;
        throw new Error('no debería conectar');
      },
      durationSeconds: 10,
      expected: { ...fixture.expected, archive_sha256: 'f'.repeat(64) },
      fetch: () => Promise.resolve(new Response(fixture.archive)),
      nextId: () => uuid(1),
      now: clock.now,
      random: () => 0,
      scheduler: clock.scheduler,
      symbol: 'SYNTH_100',
      zlibVersion: 'test',
    });

    expect(connected).toBe(false);
    expect(report).toMatchObject({
      catalog: null,
      closure: null,
      connections: 0,
      end: { reason: 'archive_sha256_mismatch', status: 'failed' },
      reconnect_waits_ms: [],
      reconnections: 0,
      recovery: null,
      schemas: null,
      status: 'failed',
    });
  });
});

describe('lastDurableRecovery', () => {
  const base = {
    connection_id: uuid(1),
    event_id: uuid(2),
    from_event_time_utc: '2026-03-02T10:00:02.001Z',
    kind: 'history_recovery_result',
    occurred_at_utc: '2026-03-02T10:00:06.100Z',
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    symbol: 'SYNTH_100',
    to_event_time_utc: '2026-03-02T10:00:03.999Z',
  } as const;
  const complete: HistoryRecoveryOutcome = {
    attempts: 1,
    durable: true,
    pages: 2,
    result: { ...base, recovered_event_count: 5, status: 'complete' },
    status: 'finished',
  };
  const unavailable: HistoryRecoveryOutcome = {
    attempts: 3,
    durable: true,
    pages: 1,
    result: { ...base, reason: 'history_timeout', status: 'unavailable' },
    status: 'finished',
  };
  const notDurable: HistoryRecoveryOutcome = {
    attempts: 1,
    durable: false,
    pages: 1,
    result: {
      ...base,
      reason: 'history_boundary_missing',
      recovered_event_count: 0,
      status: 'partial',
    },
    status: 'finished',
  };

  it('da la última recuperación cuyo resultado quedó en el log, sin horas ni precios', () => {
    expect(lastDurableRecovery([complete])).toEqual({
      attempts: 1,
      pages: 2,
      reason: null,
      recovered_event_count: 5,
      status: 'complete',
    });
    expect(lastDurableRecovery([complete, unavailable])).toEqual({
      attempts: 3,
      pages: 1,
      reason: 'history_timeout',
      recovered_event_count: null,
      status: 'unavailable',
    });
  });

  it('no cuenta las abandonadas, que pueden no haber pedido ninguna página, ni las que no quedaron en el log', () => {
    expect(lastDurableRecovery([])).toBeNull();
    expect(lastDurableRecovery([{ status: 'abandoned' }])).toBeNull();
    expect(lastDurableRecovery([notDurable])).toBeNull();
    expect(lastDurableRecovery([complete, { status: 'abandoned' }, notDurable])).toMatchObject({
      status: 'complete',
    });
  });
});

describe('smokeCommand', () => {
  function dependencies(overrides: Partial<Parameters<typeof smokeCommand>[1]> = {}) {
    forbidAmbientEffects();
    const clock = new ManualClock(START);
    const fixture = syntheticSchemaArchive();
    const connections: unknown[] = [];
    return {
      connections,
      deps: {
        alert: () => undefined,
        connect: () => {
          connections.push(1);
          throw new Error('no debería conectar');
        },
        expected: fixture.expected,
        fetch: () => Promise.resolve(new Response(fixture.archive)),
        nextId: () => uuid(1),
        now: clock.now,
        random: () => 0,
        scheduler: clock.scheduler,
        zlibVersion: 'test',
        ...overrides,
      },
    };
  }

  it('sin --live da salida 2 y una línea UsageError, sin cargar nada', async () => {
    let fetched = false;
    const { deps } = dependencies({
      fetch: () => {
        fetched = true;
        throw new Error('no debería descargar');
      },
    });
    const result = await smokeCommand([], deps);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(fetched).toBe(false);
  });

  it('un corte que no es menor que la duración da salida 2 y una línea UsageError, sin cargar nada ni conectar', async () => {
    let fetched = false;
    const { connections, deps } = dependencies({
      fetch: () => {
        fetched = true;
        throw new Error('no debería descargar');
      },
    });
    const result = await smokeCommand(
      ['--live', '--duration-seconds', '30', '--interrupt-after-seconds', '30'],
      deps,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(fetched).toBe(false);
    expect(connections).toEqual([]);
  });

  it('un símbolo que el esquema de ticks no admite también es un error de uso; el resultado lleva el corte pedido', async () => {
    const { connections, deps } = dependencies();
    const result = await smokeCommand(
      ['--live', '--symbol', 'R', '--interrupt-after-seconds', '30'],
      deps,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({
      end: { detail: 'ticks', reason: 'request_invalid', status: 'failed' },
      interrupt_after_seconds: 30,
      status: 'failed',
    });
    expect(connections).toEqual([]);
  });

  it('un error inesperado da code UNEXPECTED y salida 1', async () => {
    const { deps } = dependencies({
      now: () => {
        throw new RangeError('reloj roto');
      },
    });
    const result = await smokeCommand(['--live'], deps);
    expect(result).toEqual({
      exitCode: 1,
      line: '{"code":"UNEXPECTED","message":"RangeError","status":"failed"}',
    });
  });
});

describe('distribution', () => {
  it('da mínimo, percentiles por rango más cercano y máximo', () => {
    expect(distribution([])).toBeNull();
    expect(distribution([7])).toEqual({ count: 1, max: 7, min: 7, p50: 7, p90: 7, p99: 7 });
    const hundred = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(distribution(hundred)).toEqual({
      count: 100,
      max: 100,
      min: 1,
      p50: 50,
      p90: 90,
      p99: 99,
    });
    expect(distribution([-1000, 3000, 1000])).toEqual({
      count: 3,
      max: 3000,
      min: -1000,
      p50: 1000,
      p90: 3000,
      p99: 3000,
    });
  });
});

describe('parseSmokeArgs', () => {
  it('exige --live y usa R_100, 120 s y ningún corte por defecto', () => {
    expect(() => parseSmokeArgs([])).toThrow(UsageError);
    expect(() => parseSmokeArgs(['--symbol', 'R_100'])).toThrow(/--live/u);
    const defaults = { durationSeconds: 120, interruptAfterSeconds: null, symbol: 'R_100' };
    expect(parseSmokeArgs(['--live'])).toEqual(defaults);
    expect(parseSmokeArgs(['--', '--live'])).toEqual(defaults);
    expect(parseSmokeArgs(['--live', '--symbol', '1HZ100V', '--duration-seconds', '3600'])).toEqual(
      { durationSeconds: 3600, interruptAfterSeconds: null, symbol: '1HZ100V' },
    );
    expect(parseSmokeArgs(['--live', '--duration-seconds', '1']).durationSeconds).toBe(1);
  });

  it.each<[string[], number]>([
    [['--interrupt-after-seconds', '30'], 30],
    [['--interrupt-after-seconds', '1'], 1],
    [['--interrupt-after-seconds', '119'], 119],
    [['--duration-seconds', '10', '--interrupt-after-seconds', '9'], 9],
    [['--interrupt-after-seconds', '3599', '--duration-seconds', '3600'], 3599],
  ])('acepta el corte %j: un entero desde 1 y menor que la duración', (args, seconds) => {
    expect(parseSmokeArgs(['--live', ...args]).interruptAfterSeconds).toBe(seconds);
  });

  it.each<[string, string[]]>([
    ['sin valor', ['--interrupt-after-seconds']],
    ['0', ['--interrupt-after-seconds', '0']],
    ['igual a la duración por defecto', ['--interrupt-after-seconds', '120']],
    ['igual a la duración', ['--duration-seconds', '10', '--interrupt-after-seconds', '10']],
    ['mayor que la duración', ['--duration-seconds', '10', '--interrupt-after-seconds', '11']],
    ['con una duración de 1 s', ['--duration-seconds', '1', '--interrupt-after-seconds', '1']],
    ['con decimales', ['--interrupt-after-seconds', '1.5']],
    ['negativo', ['--interrupt-after-seconds', '-5']],
    ['con un cero delante', ['--interrupt-after-seconds', '05']],
    ['con letras', ['--interrupt-after-seconds', '5s']],
    ['vacío', ['--interrupt-after-seconds', '']],
    ['con espacios', ['--interrupt-after-seconds', ' 5']],
  ])('rechaza el corte %s con un error de uso', (_label, args) => {
    expect(() => parseSmokeArgs(['--live', ...args])).toThrow(UsageError);
    expect(() => parseSmokeArgs(['--live', ...args])).toThrow(/--interrupt-after-seconds/u);
  });

  it('rechaza duraciones y símbolos inválidos y opciones desconocidas', () => {
    for (const duration of ['0', '3601', '1.5', '-5', 'abc', '01', '', '10000']) {
      expect(() => parseSmokeArgs(['--live', '--duration-seconds', duration])).toThrow(UsageError);
    }
    for (const symbol of ['', 'R 100', 'R-100', 'R_100;', 'x'.repeat(65)]) {
      expect(() => parseSmokeArgs(['--live', '--symbol', symbol])).toThrow(UsageError);
    }
    expect(() => parseSmokeArgs(['--live', '--verbose'])).toThrow(UsageError);
    expect(() => parseSmokeArgs(['--live', 'R_100'])).toThrow(UsageError);
  });
});
