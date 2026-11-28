import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { StrategyIndicator, StrategyIndicatorName } from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  binary64Bits,
  decimalToBinary64,
  INDICATOR_LIBRARY_VERSION,
  initialIndicatorState,
  stepIndicator,
  type IndicatorPoint,
  type IndicatorState,
} from '../src/index.js';

// Vectores compartidos con el motor de investigación (ADR-0022 §11): los valores esperados los
// calculó, fuera de este paquete, una implementación de referencia en Python escrita desde la ADR.
const root = new URL('../../../test-vectors/strategy-indicators/v1/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, root));

interface ManifestFile {
  bytes: number;
  path: string;
  sha256: string;
}

interface SeriesVector {
  name: string;
  points: { close: string; high: string; instant_utc: string; low: string }[];
}

interface IndicatorVector {
  indicator: StrategyIndicator;
  name: string;
  series: string;
  values: (string | null)[];
}

const manifest = JSON.parse(read('manifest.json').toString('utf8')) as {
  files: ManifestFile[];
  indicator_library_version: string;
  vector_id: string;
};
const seriesVectors = JSON.parse(read('series.json').toString('utf8')) as SeriesVector[];
const cases = JSON.parse(read('indicators.json').toString('utf8')) as IndicatorVector[];

// Los instantes se leen antes de las guardas, que también sustituyen `Date`.
const series = new Map<string, IndicatorPoint[]>(
  seriesVectors.map((vector) => [
    vector.name,
    vector.points.map((point) => ({
      close: decimalToBinary64(point.close),
      high: decimalToBinary64(point.high),
      instantMs: Date.parse(point.instant_utc),
      low: decimalToBinary64(point.low),
    })),
  ]),
);

const pointsOf = (name: string): IndicatorPoint[] => {
  const points = series.get(name);
  if (points === undefined) {
    throw new Error(`Falta la serie ${name}.`);
  }
  return points;
};

/** Los valores del indicador en cada punto de la serie, en bits, o `null` si está indefinido. */
function run(indicator: StrategyIndicator, points: readonly IndicatorPoint[]): (string | null)[] {
  let state = initialIndicatorState(indicator);
  return points.map((point) => {
    const step = stepIndicator(indicator, state, point);
    state = step.state;
    return step.value === null ? null : binary64Bits(step.value);
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

// Sin red, reloj real ni azar (ADR-0022 §12, como F1-VECTOR-001).
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en los indicadores.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en los indicadores.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en los indicadores.');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('vectores de la biblioteca de indicadores 1.0.0', () => {
  it('coinciden con su manifiesto, byte a byte', () => {
    expect(manifest.vector_id).toBe('strategy-indicators-v1');
    expect(manifest.indicator_library_version).toBe(INDICATOR_LIBRARY_VERSION);
    expect(manifest.files.map((file) => file.path)).toEqual(['indicators.json', 'series.json']);
    for (const file of manifest.files) {
      const bytes = read(file.path);
      expect(bytes.length, file.path).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });

  it('cubren los 13 indicadores, con un valor por punto', () => {
    const names: StrategyIndicatorName[] = [
      'atr',
      'bollinger_pct',
      'ema',
      'highest',
      'hour_utc',
      'lowest',
      'price',
      'return',
      'rsi',
      'sma',
      'volatility',
      'weekday_utc',
      'zscore',
    ];
    expect([...new Set(cases.map((item) => item.indicator.indicator))].sort()).toEqual(names);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.values, item.name).toHaveLength(pointsOf(item.series).length);
      for (const value of item.values) {
        expect(value === null || /^[0-9a-f]{16}$/u.test(value), item.name).toBe(true);
      }
    }
  });

  it.each(cases.map((item) => [item.name, item] as const))(
    '%s da los mismos bits en cada punto',
    (_name, item) => {
      expect(run(item.indicator, pointsOf(item.series))).toEqual(item.values);
    },
  );

  it('fijan los casos límite de la ADR', () => {
    const find = (name: string): (string | null)[] => {
      const item = cases.find((candidate) => candidate.name === name);
      if (item === undefined) {
        throw new Error(`Falta el caso ${name}.`);
      }
      return item.values;
    };
    const fifty = binary64Bits(50);
    const hundred = binary64Bits(100);
    // Con el precio quieto, `zscore` y `bollinger_pct` quedan indefinidos y `rsi` da 50.
    expect(find('plano_y_rupturas/zscore_5').slice(4, 25)).toEqual(Array(21).fill(null));
    expect(find('plano_y_rupturas/bollinger_pct_5_k2').slice(4, 25)).toEqual(Array(21).fill(null));
    expect(find('plano_y_rupturas/rsi_5').slice(5, 25)).toEqual(Array(20).fill(fifty));
    // Solo subidas: `rsi` da 100.
    expect(find('subida/rsi_14').slice(14)).toEqual(Array(16).fill(hundred));
    // Indefinidos hasta tener lo que necesitan.
    expect(find('r100_ticks/sma_500').indexOf(null)).toBe(0);
    expect(find('r100_ticks/sma_500').lastIndexOf(null)).toBe(498);
    expect(find('r100_ticks/return_500').lastIndexOf(null)).toBe(499);
    expect(find('r100_ticks/rsi_100').lastIndexOf(null)).toBe(99);
    expect(find('oro_velas_1m/atr_100').lastIndexOf(null)).toBe(99);
    expect(find('r100_ticks/highest_500').lastIndexOf(null)).toBe(499);
  });

  it('fijan una ruptura de highest y de lowest', () => {
    const points = pointsOf('oro_velas_1m');
    const highest = run({ indicator: 'highest', n: 20 }, points);
    const lowest = run({ indicator: 'lowest', n: 20 }, points);
    const fromBits = (bits: string): number => {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, BigInt(`0x${bits}`));
      return view.getFloat64(0);
    };
    const breakUp = points.findIndex(
      (point, index) => highest[index] !== null && point.close > fromBits(highest[index] ?? ''),
    );
    const breakDown = points.findIndex(
      (point, index) => lowest[index] !== null && point.close < fromBits(lowest[index] ?? ''),
    );
    expect(breakUp).toBeGreaterThan(0);
    expect(breakDown).toBeGreaterThan(0);
  });

  it('cambian de bits con una suma acumulada o compensada', () => {
    // Las series están elegidas para que un atajo de suma no dé los mismos bits (ADR-0022 §11).
    const closes = pointsOf('r100_ticks').map((point) => point.close);
    for (const n of [13, 500]) {
      const expected = cases.find((item) => item.name === `r100_ticks/sma_${String(n)}`)?.values;
      let running = 0;
      const runningValues = closes.map((close, index) => {
        running = running + close;
        if (index >= n) {
          running = running - (closes[index - n] ?? Number.NaN);
        }
        return index < n - 1 ? null : binary64Bits(running / n);
      });
      const kahanValues = closes.map((_close, index) => {
        if (index < n - 1) {
          return null;
        }
        let sum = 0;
        let compensation = 0;
        for (const value of closes.slice(index - n + 1, index + 1)) {
          const corrected = value - compensation;
          const next = sum + corrected;
          compensation = next - sum - corrected;
          sum = next;
        }
        return binary64Bits(sum / n);
      });
      expect(runningValues, `sma ${String(n)}`).not.toEqual(expected);
      expect(kahanValues, `sma ${String(n)}`).not.toEqual(expected);
    }
  });
});

describe('el estado de un indicador', () => {
  it('no cambia al dar el paso siguiente', () => {
    for (const item of cases) {
      let state: IndicatorState = deepFreeze(initialIndicatorState(item.indicator));
      for (const point of pointsOf(item.series)) {
        const before = JSON.stringify(state);
        const step = stepIndicator(item.indicator, state, deepFreeze({ ...point }));
        expect(JSON.stringify(state), item.name).toBe(before);
        state = deepFreeze(step.state);
      }
    }
  });

  it('se guarda en JSON y sigue igual', () => {
    for (const item of cases) {
      const points = pointsOf(item.series);
      const middle = Math.floor(points.length / 2);
      let state = initialIndicatorState(item.indicator);
      const values: (string | null)[] = [];
      for (const [index, point] of points.entries()) {
        if (index === middle) {
          state = JSON.parse(JSON.stringify(state)) as IndicatorState;
        }
        const step = stepIndicator(item.indicator, state, point);
        state = step.state;
        values.push(step.value === null ? null : binary64Bits(step.value));
      }
      expect(values, item.name).toEqual(item.values);
    }
  });
});

describe('las entradas', () => {
  it('solo acepta decimales canónicos', () => {
    expect(decimalToBinary64('2650.123')).toBe(2650.123);
    expect(decimalToBinary64('-0.0005')).toBe(-0.0005);
    for (const value of ['1e3', '+1', '.5', '1.', '0x10', ' 1', 'NaN', 'Infinity', '']) {
      expect(() => decimalToBinary64(value), value).toThrow(RangeError);
    }
  });

  it('rechaza un instante que no es un entero desde 1970', () => {
    const point = { close: 1, high: 1, low: 1 };
    for (const instantMs of [-1, 1.5, Number.NaN]) {
      for (const indicator of [{ indicator: 'hour_utc' }, { indicator: 'weekday_utc' }] as const) {
        expect(() =>
          stepIndicator(indicator, initialIndicatorState(indicator), { ...point, instantMs }),
        ).toThrow(RangeError);
      }
    }
  });

  it('rechaza el estado de otro indicador', () => {
    const point = { close: 1, high: 1, instantMs: 0, low: 1 };
    expect(() =>
      stepIndicator(
        { indicator: 'ema', n: 2 },
        initialIndicatorState({ indicator: 'sma', n: 2 }),
        point,
      ),
    ).toThrow(TypeError);
    expect(() =>
      stepIndicator(
        { indicator: 'sma', n: 2 },
        initialIndicatorState({ indicator: 'rsi', n: 2 }),
        point,
      ),
    ).toThrow(TypeError);
  });
});
