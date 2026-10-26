import { deriveCatalogContentSha256 } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  distribution,
  parseSmokeArgs,
  runSmoke,
  SMOKE_NOTE,
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

function smoke(symbol = 'SYNTH_100') {
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
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    scheduler: clock.scheduler,
    schemaUrl: 'https://schemas.invalid/schemas.zip',
    symbol,
    zlibVersion: 'test',
  });
  const socket = (): FakeDerivSocket => {
    const [only] = sockets;
    if (only === undefined) {
      throw new TypeError('El smoke no conectó.');
    }
    return only;
  };
  return { alerts, clock, fixture, run, socket };
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
  it('pasa con el cierre previsto y da un resultado saneado con sus distribuciones', async () => {
    const run = smoke();
    await settle();
    const socket = run.socket();
    socket.open();
    await settle();
    socket.text(derivMessages.catalog(1));
    await settle();
    // Tres ticks: retrasos de 400, 700 y 250 ms, y 2 s entre sus horas.
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
    // La duración cuenta desde el primer tick (10:00:00.400).
    await run.clock.advance(6150);
    expect(socket.requests().at(-1)).toEqual({ forget_all: 'ticks', req_id: 4 });
    socket.text(derivMessages.forgetAll(4));
    const report: SmokeReport = await run.run;

    expect(report).toEqual({
      catalog: { content_sha256: CATALOG_CONTENT_SHA256, entry_count: 2 },
      closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
      connector_version: DERIV_CONNECTOR_VERSION,
      delivery_delay_ms: { count: 3, max: 700, min: 250, p50: 400, p90: 700, p99: 700 },
      duration_seconds: 10,
      end: { status: 'completed' },
      finished_at_utc: '2026-03-02T10:00:10.400Z',
      frames: {
        invalid: 0,
        non_tick: { active_symbols: 1, forget_all: 1, time: 1 },
        raw: 6,
        ticks: 3,
      },
      incidents: { invalid_frames: {}, operational: {}, requested_responses: {} },
      note: SMOKE_NOTE,
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
  });

  it('falla si el símbolo no está en el catálogo, sin distribuciones', async () => {
    const run = smoke('SYNTH_999');
    await settle();
    run.socket().open();
    await settle();
    run.socket().text(derivMessages.catalog(1));
    const report = await run.run;

    expect(report).toMatchObject({
      delivery_delay_ms: null,
      end: { detail: null, reason: 'symbol_not_in_catalog', status: 'failed' },
      frames: { ticks: 0 },
      status: 'failed',
      symbol: 'SYNTH_999',
      symbol_name: null,
      tick_interval_ms: null,
    });
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
      scheduler: clock.scheduler,
      symbol: 'SYNTH_100',
      zlibVersion: 'test',
    });

    expect(connected).toBe(false);
    expect(report).toMatchObject({
      catalog: null,
      closure: null,
      end: { reason: 'archive_sha256_mismatch', status: 'failed' },
      schemas: null,
      status: 'failed',
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
  it('exige --live y usa R_100 y 120 s por defecto', () => {
    expect(() => parseSmokeArgs([])).toThrow(UsageError);
    expect(() => parseSmokeArgs(['--symbol', 'R_100'])).toThrow(/--live/u);
    expect(parseSmokeArgs(['--live'])).toEqual({ durationSeconds: 120, symbol: 'R_100' });
    expect(parseSmokeArgs(['--', '--live'])).toEqual({ durationSeconds: 120, symbol: 'R_100' });
    expect(parseSmokeArgs(['--live', '--symbol', '1HZ100V', '--duration-seconds', '3600'])).toEqual(
      { durationSeconds: 3600, symbol: '1HZ100V' },
    );
    expect(parseSmokeArgs(['--live', '--duration-seconds', '1']).durationSeconds).toBe(1);
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
