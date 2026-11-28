/**
 * La biblioteca de indicadores 1.0.0 (ADR-0022 §3), con las reglas de números de §8: binario64 de
 * IEEE 754 desde los decimales canónicos, solo con suma, resta, multiplicación, división, raíz
 * cuadrada, máximo, mínimo y valor absoluto, cada operación por separado y en el orden de su
 * definición, y las sumas de izquierda a derecha, del valor más antiguo al más reciente. Sin
 * sumas acumuladas que restan el valor que sale de la ventana, ni sumas compensadas: cambiarían los
 * bits frente a Python (§11).
 *
 * Cada paso es puro: recibe el estado anterior y devuelve otro, sin modificarlo. El estado es JSON
 * con números finitos, para que el evaluador lo guarde y lo compare (§8).
 */
import {
  decimalStringSchema,
  INDICATOR_LIBRARY_VERSION,
  type StrategyIndicator,
} from '@buoh/contracts';

export { INDICATOR_LIBRARY_VERSION };

/** Un punto de la serie: el cierre `x`, el máximo `h` y el mínimo `l` (con `tick`, `h = l = x`). */
export interface IndicatorPoint {
  readonly close: number;
  readonly high: number;
  readonly low: number;
  /** El instante del evento, en milisegundos UTC desde 1970 (§2). */
  readonly instantMs: number;
}

/** Los valores que guarda cada indicador entre dos puntos. */
type IndicatorBody =
  | { readonly kind: 'stateless' }
  | { readonly kind: 'window'; readonly values: readonly number[] }
  | { readonly kind: 'ema'; readonly seed: readonly number[]; readonly level: number | null }
  | {
      readonly kind: 'wilder';
      readonly previous: number | null;
      readonly seedUp: readonly number[];
      readonly seedDown: readonly number[];
      readonly up: number | null;
      readonly down: number | null;
    };

/** El estado, con el indicador al que pertenece, como `sma(20)` o `bollinger_pct(20, 2)`. */
export type IndicatorState = IndicatorBody & { readonly indicator: string };

interface BodyStep {
  readonly state: IndicatorBody;
  readonly value: number | null;
}

export interface IndicatorStep {
  readonly state: IndicatorState;
  /** El valor en binario64, o `null` mientras está indefinido (§3). */
  readonly value: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Un decimal canónico en binario64, redondeado al más cercano, como `float()` de Python. Rechaza
 * lo que no es un decimal canónico.
 */
export function decimalToBinary64(value: string): number {
  if (!decimalStringSchema.safeParse(value).success) {
    throw new RangeError('El valor no es un decimal canónico.');
  }
  const number = Number(value);
  if (!isUsable(number)) {
    throw new RangeError('El decimal no cabe en binario64 o es -0.');
  }
  return number;
}

/** Finito y distinto de `-0`: así el estado se guarda en JSON sin perder nada. */
function isUsable(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0);
}

/** El nombre del indicador con sus parámetros, el que lleva su estado. */
export function indicatorKey(indicator: StrategyIndicator): string {
  if (!('n' in indicator)) {
    return indicator.indicator;
  }
  if (indicator.indicator === 'bollinger_pct') {
    return `bollinger_pct(${String(indicator.n)}, ${indicator.k})`;
  }
  return `${indicator.indicator}(${String(indicator.n)})`;
}

/** Los 64 bits de un binario64, en hexadecimal y en el orden de la red, como en los vectores. */
export function binary64Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

/** El estado de un indicador antes de su primer punto. */
export function initialIndicatorState(indicator: StrategyIndicator): IndicatorState {
  return { ...initialBody(indicator), indicator: indicatorKey(indicator) };
}

function initialBody(indicator: StrategyIndicator): IndicatorBody {
  switch (indicator.indicator) {
    case 'price':
    case 'hour_utc':
    case 'weekday_utc':
      return { kind: 'stateless' };
    case 'ema':
      return { kind: 'ema', level: null, seed: [] };
    case 'rsi':
    case 'atr':
      return { down: null, kind: 'wilder', previous: null, seedDown: [], seedUp: [], up: null };
    case 'return':
    case 'sma':
    case 'volatility':
    case 'highest':
    case 'lowest':
    case 'zscore':
    case 'bollinger_pct':
      return { kind: 'window', values: [] };
  }
}

/** El valor en esa posición de la ventana, que existe siempre que se pide. */
function item(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError('La ventana no tiene ese valor.');
  }
  return value;
}

/** La suma de izquierda a derecha, del más antiguo al más reciente (§8). */
function leftSum(values: readonly number[]): number {
  let total = item(values, 0);
  for (let index = 1; index < values.length; index += 1) {
    total = total + item(values, index);
  }
  return total;
}

/** La media, en la primera de las dos pasadas. */
function mean(values: readonly number[]): number {
  return leftSum(values) / values.length;
}

/** La desviación típica poblacional, en la segunda pasada, con la media de la primera. */
function populationDeviation(values: readonly number[], average: number): number {
  const squares = values.map((value) => {
    const difference = value - average;
    return difference * difference;
  });
  return Math.sqrt(leftSum(squares) / values.length);
}

/** Los últimos `size` valores de la ventana, con el nuevo al final. */
function push(values: readonly number[], value: number, size: number): readonly number[] {
  const next = [...values, value];
  return next.length > size ? next.slice(next.length - size) : next;
}

/** El instante, un entero de milisegundos desde 1970: antes, la cuenta del día no vale. */
function instantOf(point: IndicatorPoint): number {
  if (!Number.isSafeInteger(point.instantMs) || point.instantMs < 0) {
    throw new RangeError('El instante no es un entero de milisegundos desde 1970.');
  }
  return point.instantMs;
}

function windowValues(state: IndicatorBody): readonly number[] {
  if (state.kind !== 'window') {
    throw new TypeError('El estado no es el de este indicador.');
  }
  return state.values;
}

/** Los rendimientos simples de cada valor frente al anterior: `x_i / x_{i−1} − 1`. */
function simpleReturns(values: readonly number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    returns.push(item(values, index) / item(values, index - 1) - 1);
  }
  return returns;
}

/** `zscore` y `bollinger_pct`: indefinidos si los `n` valores son todos iguales (§3). */
function deviationIndicator(
  indicator: Extract<StrategyIndicator, { indicator: 'bollinger_pct' | 'zscore' }>,
  state: IndicatorBody,
  point: IndicatorPoint,
): BodyStep {
  const values = push(windowValues(state), point.close, indicator.n);
  const next: IndicatorBody = { kind: 'window', values };
  if (values.length < indicator.n || values.every((value) => value === values[0])) {
    return { state: next, value: null };
  }
  const average = mean(values);
  const deviation = populationDeviation(values, average);
  if (indicator.indicator === 'zscore') {
    return { state: next, value: (point.close - average) / deviation };
  }
  const k = decimalToBinary64(indicator.k);
  const lower = average - k * deviation;
  return { state: next, value: (point.close - lower) / (2 * k * deviation) };
}

/**
 * `rsi` y `atr`, de Wilder: la media simple de los `n` primeros movimientos y después
 * `(anterior·(n−1) + nuevo)/n`. Los dos necesitan el cierre anterior, así que su primer valor
 * llega con el punto `n + 1`.
 */
function wilderIndicator(
  indicator: Extract<StrategyIndicator, { indicator: 'atr' | 'rsi' }>,
  state: IndicatorBody,
  point: IndicatorPoint,
): BodyStep {
  if (state.kind !== 'wilder') {
    throw new TypeError('El estado no es el de este indicador.');
  }
  const { n } = indicator;
  const previous = state.previous;
  if (previous === null) {
    return { state: { ...state, previous: point.close }, value: null };
  }
  let up: number;
  let down: number;
  if (indicator.indicator === 'rsi') {
    up = Math.max(point.close - previous, 0);
    down = Math.max(previous - point.close, 0);
  } else {
    up = Math.max(
      point.high - point.low,
      Math.abs(point.high - previous),
      Math.abs(point.low - previous),
    );
    down = 0;
  }

  // Con la media ya empezada, `up` y `down` siempre tienen valor.
  let next: Extract<IndicatorBody, { kind: 'wilder' }> & { up: number; down: number };
  if (state.up === null || state.down === null) {
    const seedUp = [...state.seedUp, up];
    const seedDown = [...state.seedDown, down];
    if (seedUp.length < n) {
      return {
        state: { down: null, kind: 'wilder', previous: point.close, seedDown, seedUp, up: null },
        value: null,
      };
    }
    next = {
      down: leftSum(seedDown) / n,
      kind: 'wilder',
      previous: point.close,
      seedDown: [],
      seedUp: [],
      up: leftSum(seedUp) / n,
    };
  } else {
    next = {
      down: (state.down * (n - 1) + down) / n,
      kind: 'wilder',
      previous: point.close,
      seedDown: [],
      seedUp: [],
      up: (state.up * (n - 1) + up) / n,
    };
  }

  const gain = next.up;
  const loss = next.down;
  if (indicator.indicator === 'atr') {
    return { state: next, value: gain };
  }
  if (gain === 0 && loss === 0) {
    return { state: next, value: 50 };
  }
  if (loss === 0) {
    return { state: next, value: 100 };
  }
  return { state: next, value: 100 - 100 / (1 + gain / loss) };
}

/**
 * El indicador después de un punto más. Con velas, el punto es una vela cerrada; con `tick`, un
 * tick durable (§2).
 */
export function stepIndicator(
  indicator: StrategyIndicator,
  state: IndicatorState,
  point: IndicatorPoint,
): IndicatorStep {
  const key = indicatorKey(indicator);
  if (state.indicator !== key) {
    throw new TypeError('El estado no es el de este indicador.');
  }
  if (!isUsable(point.close) || !isUsable(point.high) || !isUsable(point.low)) {
    throw new RangeError('El punto tiene un precio no finito o -0.');
  }
  const step = advance(indicator, state, point);
  return { state: { ...step.state, indicator: key }, value: step.value };
}

function advance(
  indicator: StrategyIndicator,
  state: IndicatorBody,
  point: IndicatorPoint,
): BodyStep {
  switch (indicator.indicator) {
    case 'price':
      return { state, value: point.close };
    case 'hour_utc':
      return { state, value: Math.floor(instantOf(point) / HOUR_MS) % 24 };
    case 'weekday_utc':
      // El 1970-01-01 fue jueves, el día 3 si el lunes es el 0.
      return { state, value: (Math.floor(instantOf(point) / DAY_MS) + 3) % 7 };
    case 'return': {
      const values = push(windowValues(state), point.close, indicator.n + 1);
      const value = values.length > indicator.n ? point.close / item(values, 0) - 1 : null;
      return { state: { kind: 'window', values }, value };
    }
    case 'sma': {
      const values = push(windowValues(state), point.close, indicator.n);
      return {
        state: { kind: 'window', values },
        value: values.length === indicator.n ? mean(values) : null,
      };
    }
    case 'ema': {
      if (state.kind !== 'ema') {
        throw new TypeError('El estado no es el de este indicador.');
      }
      if (state.level !== null) {
        const alpha = 2 / (indicator.n + 1);
        const level = state.level + alpha * (point.close - state.level);
        return { state: { kind: 'ema', level, seed: [] }, value: level };
      }
      const seed = [...state.seed, point.close];
      if (seed.length < indicator.n) {
        return { state: { kind: 'ema', level: null, seed }, value: null };
      }
      const level = mean(seed);
      return { state: { kind: 'ema', level, seed: [] }, value: level };
    }
    case 'rsi':
    case 'atr':
      return wilderIndicator(indicator, state, point);
    case 'volatility': {
      const values = push(windowValues(state), point.close, indicator.n + 1);
      if (values.length <= indicator.n) {
        return { state: { kind: 'window', values }, value: null };
      }
      const returns = simpleReturns(values);
      return {
        state: { kind: 'window', values },
        value: populationDeviation(returns, mean(returns)),
      };
    }
    case 'highest':
    case 'lowest': {
      // Los `n` anteriores, sin el actual: la ventana guarda `n + 1` extremos.
      const extreme = indicator.indicator === 'highest' ? point.high : point.low;
      const values = push(windowValues(state), extreme, indicator.n + 1);
      if (values.length <= indicator.n) {
        return { state: { kind: 'window', values }, value: null };
      }
      const previous = values.slice(0, indicator.n);
      return {
        state: { kind: 'window', values },
        value: indicator.indicator === 'highest' ? Math.max(...previous) : Math.min(...previous),
      };
    }
    case 'zscore':
    case 'bollinger_pct':
      return deviationIndicator(indicator, state, point);
  }
}
