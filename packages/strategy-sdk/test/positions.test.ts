import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { StrategyDefinition } from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drawdownReached,
  fixedProduct,
  fixedQuotient,
  fixedToCents,
  formatFixed,
  initialDrawdownState,
  openCandlePosition,
  openTickPosition,
  parseFixed,
  positionMarkCents,
  requestTickSale,
  sellCandlePositionAtClose,
  stepCandlePosition,
  stepDrawdown,
  stepTickPosition,
  type PositionClose,
  type PositionState,
  type PositionStep,
  type PositionTick,
} from '../src/index.js';

// Vectores compartidos con el motor de investigación (ADR-0022 §11): los resultados esperados los
// calculó, fuera de este paquete, una implementación de referencia en Python escrita desde la ADR.
const root = new URL('../../../test-vectors/strategy-positions/v1/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, root));

type Contract = StrategyDefinition['contract'];

interface VectorTick {
  from_recovery: boolean;
  price: string;
  source_time_ms: number;
}

interface VectorCandle {
  close: string;
  end_ms: number;
  high: string;
  low: string;
  open: string;
  start_ms: number;
}

interface VectorClose {
  cause: string;
  exit_price: string | null;
  exit_time_ms: number;
  result_cents: number;
  won?: boolean;
}

type VectorStep =
  | { tick: VectorTick }
  | { candle: VectorCandle }
  | { sale: { deciding_source_time_ms: number } }
  | { sell_at_close: true };

interface PositionVector {
  contract: Contract;
  costs: { commission: string } | { payout: string };
  data: 'deriv_candles' | 'ticks';
  entry: VectorTick | { open: string; start_ms: number };
  expected: {
    open_close: VectorClose | null;
    open_mark_cents: number | null;
    steps: { close: VectorClose | null; mark_cents: number | null }[];
  };
  latency_ms?: number;
  name: string;
  purchase_ms?: number;
  stake: string;
  steps: VectorStep[];
}

interface AmountVectors {
  cents: { cents: number; value: string }[];
  drawdowns: {
    equity_cents: number[];
    expected: { drawdown_cents: number; reached: boolean }[];
    initial_capital: string;
    max_drawdown_percent: string;
    name: string;
    start_equity_cents: number;
  }[];
  quotients: { dividend: string; divisor: string; quotient: string }[];
}

const manifest = JSON.parse(read('manifest.json').toString('utf8')) as {
  files: { bytes: number; path: string; sha256: string }[];
  strategy_schema_version: string;
  vector_id: string;
};
const positions = JSON.parse(read('positions.json').toString('utf8')) as PositionVector[];
const amounts = JSON.parse(read('amounts.json').toString('utf8')) as AmountVectors;

const toTick = (tick: VectorTick): PositionTick => ({
  fromRecovery: tick.from_recovery,
  price: tick.price,
  sourceTimeMs: tick.source_time_ms,
});

const toVector = (close: PositionClose | null): VectorClose | null =>
  close === null
    ? null
    : {
        cause: close.cause,
        exit_price: close.exitPrice,
        exit_time_ms: close.exitTimeMs,
        result_cents: close.resultCents,
        ...(close.won === undefined ? {} : { won: close.won }),
      };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** Recorre un vector, con cada estado congelado y pasado por JSON, como lo guarda el evaluador. */
function run(vector: PositionVector): PositionVector['expected'] {
  const persist = (state: PositionState): PositionState =>
    deepFreeze(JSON.parse(JSON.stringify(state)) as PositionState);
  let state: PositionState;
  let openClose: PositionClose | null = null;
  if (vector.data === 'ticks') {
    const opened = openTickPosition(
      deepFreeze({
        contract: vector.contract,
        costs: vector.costs,
        entry: toTick(vector.entry as VectorTick),
        latencyMs: vector.latency_ms ?? Number.NaN,
        purchaseMs: vector.purchase_ms ?? Number.NaN,
        stake: vector.stake,
      }),
    );
    state = persist(opened.state);
    openClose = opened.close;
  } else {
    const entry = vector.entry as { open: string; start_ms: number };
    state = persist(
      openCandlePosition(
        deepFreeze({
          contract: vector.contract,
          costs: vector.costs,
          entryOpen: entry.open,
          entryStartMs: entry.start_ms,
          stake: vector.stake,
        }),
      ),
    );
  }
  const openMark = positionMarkCents(state);
  const steps = vector.steps.map((step) => {
    let result: PositionStep;
    if ('tick' in step) {
      result = stepTickPosition(state, deepFreeze(toTick(step.tick)));
    } else if ('candle' in step) {
      const { candle } = step;
      result = stepCandlePosition(
        state,
        deepFreeze({
          close: candle.close,
          endMs: candle.end_ms,
          high: candle.high,
          low: candle.low,
          open: candle.open,
          startMs: candle.start_ms,
        }),
      );
    } else if ('sale' in step) {
      result = { close: null, state: requestTickSale(state, step.sale.deciding_source_time_ms) };
    } else {
      result = sellCandlePositionAtClose(state);
    }
    state = persist(result.state);
    return { close: toVector(result.close), mark_cents: positionMarkCents(state) };
  });
  return { open_close: toVector(openClose), open_mark_cents: openMark, steps };
}

// Sin red, reloj real ni azar (ADR-0022 §12, como F1-VECTOR-001).
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en la posición.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en la posición.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en la posición.');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('vectores de los importes y la posición', () => {
  it('coinciden con su manifiesto, byte a byte', () => {
    expect(manifest.vector_id).toBe('strategy-positions-v1');
    expect(manifest.strategy_schema_version).toBe('1.0.0');
    expect(manifest.files.map((file) => file.path)).toEqual(['amounts.json', 'positions.json']);
    for (const file of manifest.files) {
      const bytes = read(file.path);
      expect(bytes.length, file.path).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });

  it('cubren los cuatro tipos de contrato y cada causa de cierre, con ticks y con velas', () => {
    expect(new Set(positions.map((vector) => vector.name)).size).toBe(positions.length);
    for (const data of ['ticks', 'deriv_candles'] as const) {
      const vectors = positions.filter((vector) => vector.data === data);
      expect(new Set(vectors.map((vector) => vector.contract.contract_type))).toEqual(
        new Set(['MULTUP', 'MULTDOWN', 'CALL', 'PUT']),
      );
      const causes = vectors.flatMap((vector) =>
        [vector.expected.open_close, ...vector.expected.steps.map((step) => step.close)]
          .filter((close) => close !== null)
          .map((close) => close.cause),
      );
      expect(new Set(causes)).toEqual(
        new Set(['exit_rule', 'expiry', 'max_duration', 'stop_loss', 'stop_out', 'take_profit']),
      );
    }
  });

  it.each(positions.map((vector) => [vector.name, vector] as const))(
    '%s da los cierres y los resultados de la referencia',
    (_name, vector) => {
      expect(run(vector)).toEqual(vector.expected);
    },
  );

  it.each(amounts.quotients.map((item) => [`${item.dividend} / ${item.divisor}`, item] as const))(
    'el cociente %s va con 18 decimales, redondeado al par',
    (_name, item) => {
      expect(formatFixed(fixedQuotient(parseFixed(item.dividend), parseFixed(item.divisor)))).toBe(
        item.quotient,
      );
    },
  );

  it.each(amounts.cents.map((item) => [item.value, item] as const))(
    '%s se liquida en centavos redondeados al par',
    (_name, item) => {
      expect(fixedToCents(parseFixed(item.value))).toBe(item.cents);
    },
  );

  it.each(amounts.drawdowns.map((item) => [item.name, item] as const))(
    'la caída máxima %s',
    (_name, item) => {
      let state = initialDrawdownState(item.start_equity_cents);
      const got = item.equity_cents.map((equity) => {
        const step = stepDrawdown(state, equity);
        state = step.state;
        return {
          drawdown_cents: step.drawdownCents,
          reached: drawdownReached(
            step.drawdownCents,
            item.max_drawdown_percent,
            item.initial_capital,
          ),
        };
      });
      expect(got).toEqual(item.expected);
    },
  );
});

const multiplier = (overrides: Partial<Extract<Contract, { multiplier: number }>> = {}) =>
  ({
    contract_type: 'MULTUP',
    max_duration_ms: 60_000,
    multiplier: 100,
    stop_loss: null,
    take_profit: null,
    ...overrides,
  }) as const satisfies Contract;
const callput = (duration: number, unit: 'm' | 's' | 't') =>
  ({
    contract_type: 'CALL',
    duration: { duration, duration_unit: unit },
  }) as const satisfies Contract;
const tick = (price: string, sourceTimeMs: number, fromRecovery = false): PositionTick => ({
  fromRecovery,
  price,
  sourceTimeMs,
});
const openTicks = (contract: Contract, costs = { commission: '0.36' } as const) =>
  openTickPosition({
    contract,
    costs: 'multiplier' in contract ? costs : { payout: '19.5' },
    entry: tick('1000', 2000),
    latencyMs: 1000,
    purchaseMs: 1000,
    stake: '10',
  }).state;

describe('importes de punto fijo', () => {
  it('son exactos en el producto y rechazan lo que no cabe', () => {
    expect(formatFixed(fixedProduct(parseFixed('10'), parseFixed('0.000000000000000123')))).toBe(
      '0.00000000000000123',
    );
    expect(() => fixedProduct(parseFixed('0.1'), parseFixed('0.000000000000000001'))).toThrow(
      RangeError,
    );
    expect(() => parseFixed('0.0000000000000000001')).toThrow(RangeError);
    expect(() => parseFixed('1e3')).toThrow(RangeError);
    expect(() => fixedQuotient(parseFixed('1'), 0n)).toThrow(RangeError);
    expect(formatFixed(parseFixed('-0.50'))).toBe('-0.5');
    expect(formatFixed(parseFixed('-0'))).toBe('0');
  });
});

describe('la posición rechaza lo que no puede pasar', () => {
  it('un tick de entrada de una recuperación, anterior a la compra o con costos de otro tipo', () => {
    const base = {
      contract: multiplier(),
      costs: { commission: '0.36' },
      entry: tick('1000', 2000),
      latencyMs: 1000,
      purchaseMs: 1000,
      stake: '10',
    };
    expect(() => openTickPosition({ ...base, entry: tick('1000', 2000, true) })).toThrow(
      /recuperación/u,
    );
    expect(() => openTickPosition({ ...base, purchaseMs: 2001 })).toThrow(/compra/u);
    expect(() => openTickPosition({ ...base, costs: { payout: '19' } })).toThrow(/comisión/u);
    expect(() => openTickPosition({ ...base, costs: { commission: '-0.1' } })).toThrow(RangeError);
    expect(() => openTickPosition({ ...base, entry: tick('0', 2000) })).toThrow(RangeError);
    expect(() => openTickPosition({ ...base, latencyMs: -1 })).toThrow(RangeError);
    expect(() =>
      openTickPosition({ ...base, contract: callput(15, 's'), costs: { commission: '1' } }),
    ).toThrow(/pago/u);
    expect(() =>
      openTickPosition({
        ...base,
        contract: callput(15, 's'),
        costs: { payout: '19' },
        entry: tick('1000', 16_001),
      }),
    ).toThrow(/vencimiento/u);
  });

  it('un tick anterior, un paso tras el cierre y una venta que no es del último tick', () => {
    const state = openTicks(multiplier());
    expect(() => stepTickPosition(state, tick('1000', 1999))).toThrow(/orden/u);
    expect(() => requestTickSale(state, 1999)).toThrow(/último tick/u);
    const selling = requestTickSale(state, 2000);
    expect(() => requestTickSale(selling, 2000)).toThrow(/ya está decidida/u);
    const closed = stepTickPosition(state, tick('900', 4000));
    expect(closed.close?.cause).toBe('stop_out');
    expect(() => stepTickPosition(closed.state, tick('1000', 6000))).toThrow(/cerrada/u);
    expect(positionMarkCents(closed.state)).toBeNull();
    expect(() => requestTickSale(openTicks(callput(5, 't')), 2000)).toThrow(RangeError);
    expect(() =>
      stepCandlePosition(state, {
        close: '1',
        endMs: 60_000,
        high: '1',
        low: '1',
        open: '1',
        startMs: 0,
      }),
    ).toThrow(/ticks/u);
  });

  it('velas que no son de 1 minuto, desordenadas o incoherentes, y un sube/baja de segundos', () => {
    const state = openCandlePosition({
      contract: multiplier(),
      costs: { commission: '0.2' },
      entryOpen: '2650.1',
      entryStartMs: 60_000,
      stake: '10',
    });
    const candle = {
      close: '2650.5',
      endMs: 120_000,
      high: '2651',
      low: '2650',
      open: '2650.1',
      startMs: 60_000,
    };
    expect(() => stepCandlePosition(state, { ...candle, endMs: 180_000 })).toThrow(/1 minuto/u);
    expect(() => stepCandlePosition(state, { ...candle, high: '2650.4' })).toThrow(/máximo/u);
    expect(() => stepCandlePosition(state, { ...candle, open: '2650.2' })).toThrow(/entrada/u);
    expect(() => sellCandlePositionAtClose(state)).toThrow(RangeError);
    const next = stepCandlePosition(state, candle).state;
    expect(() => stepCandlePosition(next, { ...candle, endMs: 119_000, startMs: 59_000 })).toThrow(
      /orden/u,
    );
    expect(() => stepTickPosition(next, tick('2650', 130_000))).toThrow(/velas/u);
    expect(() =>
      openCandlePosition({
        contract: callput(15, 's'),
        costs: { payout: '19' },
        entryOpen: '2650.1',
        entryStartMs: 60_000,
        stake: '10',
      }),
    ).toThrow(/1 minuto/u);
  });

  it('una caída negativa o unos centavos no enteros', () => {
    expect(() => drawdownReached(-1, '50', '1000')).toThrow(RangeError);
    expect(() => stepDrawdown(initialDrawdownState(), 0.5)).toThrow(RangeError);
    expect(() => initialDrawdownState(Number.NaN)).toThrow(RangeError);
  });
});
