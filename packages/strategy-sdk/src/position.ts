/**
 * La posición hipotética de ADR-0022 §5, con sus precisiones de ADR-0024 §3 y §6 y la del PR 3b en
 * §13. Una posición nunca es una orden (ADR-0002): es lo que habría pasado con un contrato de
 * Deriv, calculado con los importes de punto fijo de `amounts.ts`.
 *
 * Con ticks, quien la abre le da el tick de entrada y la hora de la compra; después, cada tick en
 * el orden de su hora de la fuente. Con velas de Deriv, que solo sirven para investigar, le da las
 * velas de 1 minuto desde la de la entrada. Cada paso es puro: devuelve otro estado, JSON, sin
 * modificar el anterior, y el cierre si lo hubo. El evaluador (PR 3c) decide cuándo abrir, cuándo
 * vender por reglas y qué hacer con un hueco, el mercado cerrado o el fin de la ventana.
 */
import type { StrategyDefinition } from '@buoh/contracts';

import {
  centsToFixed,
  fixedProduct,
  fixedQuotient,
  fixedToCents,
  formatFixed,
  parseFixed,
} from './amounts.js';

type Contract = StrategyDefinition['contract'];
type MultiplierContract = Extract<Contract, { readonly multiplier: number }>;
type CallPutContract = Extract<Contract, { readonly duration: unknown }>;

/** Un tick que recibe la posición. */
export interface PositionTick {
  readonly price: string;
  /** La hora de la fuente, en milisegundos UTC. */
  readonly sourceTimeMs: number;
  /** Si lo trajo la recuperación de un hueco: ninguna venta de buoh sale con él (ADR-0024 §6). */
  readonly fromRecovery: boolean;
}

/** Una vela de 1 minuto de Deriv. */
export interface PositionCandle {
  readonly close: string;
  readonly endMs: number;
  readonly high: string;
  readonly low: string;
  readonly open: string;
  readonly startMs: number;
}

/**
 * Lo que cobra Deriv, de la cotización con la misma apuesta (ADR-0021 §3): la comisión de un
 * multiplicador, en USD, o el pago de un sube/baja, en USD.
 */
export type PositionCosts = { readonly commission: string } | { readonly payout: string };

export type PositionCloseCause =
  'exit_rule' | 'expiry' | 'max_duration' | 'stop_loss' | 'stop_out' | 'take_profit';

export interface PositionClose {
  readonly cause: PositionCloseCause;
  /** El precio de salida, o `null` si una vela de Deriv tocó un umbral y vale el umbral exacto. */
  readonly exitPrice: string | null;
  readonly exitTimeMs: number;
  /** El resultado, en centavos, redondeado al par (§5). */
  readonly resultCents: number;
  /** En un sube/baja, si ganó. */
  readonly won?: boolean;
}

interface Common {
  readonly closed: PositionClose | null;
  readonly entryPrice: string;
  readonly entryTimeMs: number;
  readonly stake: string;
}

interface MultiplierFields extends Common {
  readonly commission: string;
  readonly contract: MultiplierContract;
  /** El resultado sin redondear con el último precio, para la caída máxima (con velas, el extremo adverso). */
  readonly lastPnl: string;
}

interface CallPutFields extends Common {
  readonly contract: CallPutContract;
  readonly payout: string;
}

export type PositionState =
  | (MultiplierFields & {
      readonly kind: 'tick_multiplier';
      readonly lastTimeMs: number;
      readonly latencyMs: number;
      /** La hora de la fuente desde la que sale una venta por reglas ya decidida. */
      readonly saleAtMs: number | null;
    })
  | (CallPutFields & {
      readonly expiryMs: number | null;
      readonly kind: 'tick_callput';
      readonly lastPrice: string;
      readonly lastTimeMs: number;
      /** El precio y la hora del último tick a la hora del vencimiento o antes. */
      readonly lastTickAtOrBeforeExpiry: { readonly price: string; readonly timeMs: number };
      readonly ticksAfterEntry: number;
    })
  | (MultiplierFields & {
      readonly kind: 'candle_multiplier';
      readonly lastCandle: { readonly close: string; readonly endMs: number } | null;
    })
  | (CallPutFields & {
      readonly expiryMs: number;
      readonly kind: 'candle_callput';
      readonly lastCandle: { readonly close: string; readonly endMs: number } | null;
    });

export interface PositionStep {
  readonly close: PositionClose | null;
  readonly state: PositionState;
}

export interface OpenTickPositionInput {
  readonly contract: Contract;
  readonly costs: PositionCosts;
  readonly entry: PositionTick;
  /** La latencia declarada, en milisegundos (ADR-0024 §6). */
  readonly latencyMs: number;
  /** La compra: la hora de la fuente del tick que decidió más la latencia. */
  readonly purchaseMs: number;
  readonly stake: string;
}

export interface OpenCandlePositionInput {
  readonly contract: Contract;
  readonly costs: PositionCosts;
  /** La apertura de la vela siguiente a la decisión, con la que empieza la posición. */
  readonly entryOpen: string;
  readonly entryStartMs: number;
  readonly stake: string;
}

const MINUTE_MS = 60_000;
const ONE = parseFixed('1');

function checkTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} es un entero de milisegundos no negativo.`);
  }
}

function positive(value: string, name: string): bigint {
  const fixed = parseFixed(value);
  if (fixed <= 0n) {
    throw new RangeError(`${name} es mayor que cero.`);
  }
  return fixed;
}

function nonNegative(value: string, name: string): bigint {
  const fixed = parseFixed(value);
  if (fixed < 0n) {
    throw new RangeError(`${name} no puede ser negativo.`);
  }
  return fixed;
}

const isMultiplier = (contract: Contract): contract is MultiplierContract =>
  contract.contract_type === 'MULTUP' || contract.contract_type === 'MULTDOWN';

function durationMs(contract: CallPutContract): number | null {
  const { duration, duration_unit: unit } = contract.duration;
  return unit === 't' ? null : duration * (unit === 's' ? 1000 : MINUTE_MS);
}

/**
 * La apuesta y los costos de una posición. La apuesta es un entero de USD, como los 10 de
 * `StrategyDefinition`, para que su producto con el cociente de 18 decimales sea exacto. Deriv no
 * vende un multiplicador con un stop loss que no pasa de la comisión (`validation_params` de
 * `proposal`), y una comisión que llega a la apuesta lo cerraría al entrar: la posición no abre
 * ninguno de los dos, y el evaluador omite esa señal.
 */
function costsFor(
  contract: Contract,
  costs: PositionCosts,
  stake: string,
): { commission: string; payout: string } {
  if (!/^[1-9][0-9]*$/u.test(stake)) {
    throw new RangeError('La apuesta es un entero de USD mayor que cero.');
  }
  if (isMultiplier(contract)) {
    if (!('commission' in costs)) {
      throw new RangeError('Un multiplicador lleva la comisión de su cotización.');
    }
    const commission = nonNegative(costs.commission, 'La comisión');
    if (commission >= parseFixed(stake)) {
      throw new RangeError('La comisión es menor que la apuesta.');
    }
    if (contract.stop_loss !== null && parseFixed(contract.stop_loss) <= commission) {
      throw new RangeError('Deriv no acepta un stop loss que no pasa de la comisión.');
    }
    return { commission: costs.commission, payout: '0' };
  }
  if (!('payout' in costs)) {
    throw new RangeError('Un sube/baja lleva el pago de su cotización.');
  }
  nonNegative(costs.payout, 'El pago');
  return { commission: '0', payout: costs.payout };
}

/**
 * El resultado de un multiplicador con el precio `x` (§5): `apuesta × multiplicador ×
 * (x / x_entrada − 1)` en `MULTUP`, con el signo contrario en `MULTDOWN`, menos la comisión. El
 * cociente va con 18 decimales; lo demás es exacto.
 */
function multiplierPnl(state: MultiplierFields, price: bigint): bigint {
  const ratio = fixedQuotient(price, parseFixed(state.entryPrice));
  const move = state.contract.contract_type === 'MULTUP' ? ratio - ONE : ONE - ratio;
  const exposure = fixedProduct(parseFixed(state.stake), move) * BigInt(state.contract.multiplier);
  return exposure - parseFixed(state.commission);
}

function close(
  cause: PositionCloseCause,
  result: bigint,
  exitPrice: string | null,
  exitTimeMs: number,
): PositionClose {
  return { cause, exitPrice, exitTimeMs, resultCents: fixedToCents(result) };
}

/**
 * Los cierres que aplica Deriv con un precio, en su orden de precedencia (§5): la pérdida de la
 * apuesta, con `−apuesta` aunque el precio diga más, y el stop loss o el take profit, con el
 * resultado de ese precio.
 */
function limitClose(
  state: MultiplierFields,
  pnl: bigint,
  price: string,
  timeMs: number,
): PositionClose | null {
  const stake = parseFixed(state.stake);
  const { stop_loss: stopLoss, take_profit: takeProfit } = state.contract;
  if (pnl <= -stake) {
    return close('stop_out', -stake, price, timeMs);
  }
  if (stopLoss !== null && pnl <= -parseFixed(stopLoss)) {
    return close('stop_loss', pnl, price, timeMs);
  }
  if (takeProfit !== null && pnl >= parseFixed(takeProfit)) {
    return close('take_profit', pnl, price, timeMs);
  }
  return null;
}

function expiryClose(state: CallPutFields, exitPrice: string, exitTimeMs: number): PositionClose {
  const exit = parseFixed(exitPrice);
  const entry = parseFixed(state.entryPrice);
  // Un empate pierde (§5): Deriv paga si el precio de salida es estrictamente mayor o menor.
  const won = state.contract.contract_type === 'CALL' ? exit > entry : exit < entry;
  const stake = parseFixed(state.stake);
  const result = won ? parseFixed(state.payout) - stake : -stake;
  return { ...close('expiry', result, exitPrice, exitTimeMs), won };
}

function checkTick(tick: PositionTick): bigint {
  checkTime(tick.sourceTimeMs, 'La hora de la fuente');
  return positive(tick.price, 'El precio');
}

function assertOpen(state: PositionState): void {
  if (state.closed !== null) {
    throw new RangeError('La posición ya está cerrada.');
  }
}

/**
 * Abre una posición con ticks en su tick de entrada, el primero usado posterior al que decidió
 * con una hora de la fuente igual o posterior a la compra (ADR-0024 §6), que elige el evaluador.
 * En él ningún cierre de Deriv se cumple: el resultado es `−comisión`, mayor que `−apuesta` y que
 * `−stop loss`, y el take profit es positivo.
 */
export function openTickPosition(input: OpenTickPositionInput): PositionState {
  const { contract, entry, latencyMs, purchaseMs, stake } = input;
  checkTick(entry);
  checkTime(purchaseMs, 'La compra');
  checkTime(latencyMs, 'La latencia');
  if (entry.fromRecovery) {
    throw new RangeError('Una posición nunca empieza con un tick de la recuperación de un hueco.');
  }
  if (entry.sourceTimeMs < purchaseMs) {
    throw new RangeError('El tick de entrada es igual o posterior a la compra.');
  }
  const costs = costsFor(contract, input.costs, stake);
  const common = { closed: null, entryPrice: entry.price, entryTimeMs: entry.sourceTimeMs, stake };
  if (isMultiplier(contract)) {
    const opened = {
      ...common,
      commission: costs.commission,
      contract,
      kind: 'tick_multiplier' as const,
      lastPnl: '0',
      lastTimeMs: entry.sourceTimeMs,
      latencyMs,
      saleAtMs: null,
    };
    return { ...opened, lastPnl: formatFixed(multiplierPnl(opened, parseFixed(entry.price))) };
  }
  const length = durationMs(contract);
  const expiryMs = length === null ? null : purchaseMs + length;
  if (expiryMs !== null && entry.sourceTimeMs > expiryMs) {
    throw new RangeError('El tick de entrada llega después del vencimiento.');
  }
  return {
    ...common,
    contract,
    expiryMs,
    kind: 'tick_callput',
    lastPrice: entry.price,
    lastTickAtOrBeforeExpiry: { price: entry.price, timeMs: entry.sourceTimeMs },
    lastTimeMs: entry.sourceTimeMs,
    payout: costs.payout,
    ticksAfterEntry: 0,
  };
}

/**
 * Pasa un tick a una posición con ticks. En un multiplicador, primero los cierres de Deriv, que
 * también aplica a un tick de la recuperación de un hueco; después las ventas de buoh, que nunca
 * salen con uno: el tiempo máximo, en el primer tick con una hora igual o posterior a la de la
 * entrada más el tiempo máximo y la latencia, y la venta por reglas ya decidida. En un sube/baja de
 * ticks, vence con el enésimo tick después del de entrada, y en uno de tiempo, al llegar el primer
 * tick posterior al vencimiento, con el último a esa hora o antes.
 */
export function stepTickPosition(state: PositionState, tick: PositionTick): PositionStep {
  assertOpen(state);
  if (state.kind !== 'tick_multiplier' && state.kind !== 'tick_callput') {
    throw new RangeError('Esta posición es de velas de Deriv.');
  }
  const price = checkTick(tick);
  if (tick.sourceTimeMs < state.lastTimeMs) {
    throw new RangeError('Los ticks llegan en el orden de su hora de la fuente.');
  }
  if (state.kind === 'tick_multiplier') {
    const pnl = multiplierPnl(state, price);
    let closed = limitClose(state, pnl, tick.price, tick.sourceTimeMs);
    if (closed === null && !tick.fromRecovery) {
      const deadline = state.entryTimeMs + state.contract.max_duration_ms + state.latencyMs;
      if (tick.sourceTimeMs >= deadline) {
        closed = close('max_duration', pnl, tick.price, tick.sourceTimeMs);
      } else if (state.saleAtMs !== null && tick.sourceTimeMs >= state.saleAtMs) {
        closed = close('exit_rule', pnl, tick.price, tick.sourceTimeMs);
      }
    }
    return {
      close: closed,
      state: { ...state, closed, lastPnl: formatFixed(pnl), lastTimeMs: tick.sourceTimeMs },
    };
  }
  const next = { ...state, lastPrice: tick.price, lastTimeMs: tick.sourceTimeMs };
  if (state.expiryMs === null) {
    const ticksAfterEntry = state.ticksAfterEntry + 1;
    const closed =
      ticksAfterEntry === state.contract.duration.duration
        ? expiryClose(state, tick.price, tick.sourceTimeMs)
        : null;
    return { close: closed, state: { ...next, closed, ticksAfterEntry } };
  }
  if (tick.sourceTimeMs <= state.expiryMs) {
    return {
      close: null,
      state: {
        ...next,
        lastTickAtOrBeforeExpiry: { price: tick.price, timeMs: tick.sourceTimeMs },
      },
    };
  }
  const { price: exitPrice, timeMs } = state.lastTickAtOrBeforeExpiry;
  const closed = expiryClose(state, exitPrice, timeMs);
  return { close: closed, state: { ...next, closed } };
}

/**
 * Una venta por reglas de un multiplicador con ticks, decidida con el último tick que recibió la
 * posición: sale en el primer tick posterior que no trae la recuperación de un hueco y tiene una
 * hora de la fuente igual o posterior a la de ese tick más la latencia (ADR-0024 §6).
 */
export function requestTickSale(state: PositionState, decidingSourceTimeMs: number): PositionState {
  assertOpen(state);
  if (state.kind !== 'tick_multiplier') {
    throw new RangeError('Solo se vende por reglas un multiplicador con ticks.');
  }
  if (state.saleAtMs !== null) {
    throw new RangeError('La venta ya está decidida.');
  }
  if (decidingSourceTimeMs !== state.lastTimeMs) {
    throw new RangeError('La venta se decide con el último tick que recibió la posición.');
  }
  return { ...state, saleAtMs: decidingSourceTimeMs + state.latencyMs };
}

function checkCandle(candle: PositionCandle): Record<'close' | 'high' | 'low' | 'open', bigint> {
  checkTime(candle.startMs, 'El inicio de la vela');
  if (candle.endMs - candle.startMs !== MINUTE_MS) {
    throw new RangeError('La posición recibe velas de 1 minuto de Deriv.');
  }
  const values = {
    close: positive(candle.close, 'El cierre'),
    high: positive(candle.high, 'El máximo'),
    low: positive(candle.low, 'El mínimo'),
    open: positive(candle.open, 'La apertura'),
  };
  const top = values.open > values.close ? values.open : values.close;
  const bottom = values.open < values.close ? values.open : values.close;
  if (values.high < top || values.low > bottom) {
    throw new RangeError('El máximo y el mínimo contienen la apertura y el cierre.');
  }
  return values;
}

/**
 * Abre una posición con velas de Deriv, con la apertura de la vela siguiente a la decisión, sin
 * latencia (ADR-0024 §6). La primera vela que recibe es esa. Un sube/baja dura 1 minuto o más.
 */
export function openCandlePosition(input: OpenCandlePositionInput): PositionState {
  const { contract, entryOpen, entryStartMs, stake } = input;
  checkTime(entryStartMs, 'El inicio de la vela de entrada');
  positive(entryOpen, 'La apertura');
  const costs = costsFor(contract, input.costs, stake);
  const common = {
    closed: null,
    entryPrice: entryOpen,
    entryTimeMs: entryStartMs,
    lastCandle: null,
    stake,
  };
  if (isMultiplier(contract)) {
    const opened = { ...common, commission: costs.commission, contract, lastPnl: '0' };
    const lastPnl = formatFixed(multiplierPnl(opened, parseFixed(entryOpen)));
    return { ...opened, kind: 'candle_multiplier', lastPnl };
  }
  if (contract.duration.duration_unit !== 'm') {
    throw new RangeError('Con velas de Deriv, un sube/baja dura 1 minuto o más.');
  }
  return {
    ...common,
    contract,
    expiryMs: entryStartMs + contract.duration.duration * MINUTE_MS,
    kind: 'candle_callput',
    payout: costs.payout,
  };
}

/**
 * Los cierres de un multiplicador con una vela (§5 y ADR-0024 §6). Desde su tiempo máximo cierra
 * con la apertura de la primera vela que empieza en él o después, con la precedencia de §5. Si no,
 * se mira el máximo y el mínimo: la pérdida de la apuesta da `−apuesta`; si la vela toca el stop
 * loss y el take profit, cuenta el stop loss; y un umbral tocado da su valor exacto, o el de la
 * apertura si la vela ya abre más allá de él. Los extremos van antes que la apertura, que es la
 * lectura prudente: una vela que abre más allá del take profit y toca el stop loss da el stop loss,
 * y una que abre más allá del stop loss y llega a la pérdida de la apuesta, `−apuesta`.
 */
function candleMultiplierClose(
  state: MultiplierFields & { readonly kind: 'candle_multiplier' },
  candle: PositionCandle,
  values: Record<'close' | 'high' | 'low' | 'open', bigint>,
): PositionClose | null {
  const up = state.contract.contract_type === 'MULTUP';
  const atOpen = multiplierPnl(state, values.open);
  if (candle.startMs >= state.entryTimeMs + state.contract.max_duration_ms) {
    return (
      limitClose(state, atOpen, candle.open, candle.startMs) ??
      close('max_duration', atOpen, candle.open, candle.startMs)
    );
  }
  const adverse = multiplierPnl(state, up ? values.low : values.high);
  const favorable = multiplierPnl(state, up ? values.high : values.low);
  const stake = parseFixed(state.stake);
  if (adverse <= -stake) {
    return close('stop_out', -stake, null, candle.endMs);
  }
  const { stop_loss: stopLoss, take_profit: takeProfit } = state.contract;
  if (stopLoss !== null && adverse <= -parseFixed(stopLoss)) {
    const threshold = -parseFixed(stopLoss);
    return atOpen <= threshold
      ? close('stop_loss', atOpen, candle.open, candle.startMs)
      : close('stop_loss', threshold, null, candle.endMs);
  }
  if (takeProfit !== null && favorable >= parseFixed(takeProfit)) {
    const threshold = parseFixed(takeProfit);
    return atOpen >= threshold
      ? close('take_profit', atOpen, candle.open, candle.startMs)
      : close('take_profit', threshold, null, candle.endMs);
  }
  return null;
}

/**
 * Pasa una vela de 1 minuto de Deriv, en orden, sin solaparse con la anterior. Un sube/baja sale
 * con el cierre de la última vela que termina en su vencimiento o antes, en cuanto se sabe: con la
 * vela que termina en él o con la primera que termina después.
 */
export function stepCandlePosition(state: PositionState, candle: PositionCandle): PositionStep {
  assertOpen(state);
  if (state.kind !== 'candle_multiplier' && state.kind !== 'candle_callput') {
    throw new RangeError('Esta posición es de ticks.');
  }
  const values = checkCandle(candle);
  if (state.lastCandle === null) {
    if (candle.startMs !== state.entryTimeMs || values.open !== parseFixed(state.entryPrice)) {
      throw new RangeError('La primera vela es la de la entrada.');
    }
  } else if (candle.startMs < state.lastCandle.endMs) {
    throw new RangeError('Las velas llegan en orden y sin solaparse.');
  }
  const lastCandle = { close: candle.close, endMs: candle.endMs };
  if (state.kind === 'candle_multiplier') {
    const closed = candleMultiplierClose(state, candle, values);
    // Para la caída máxima, el resultado con el extremo adverso de la vela, el prudente.
    const adverse = state.contract.contract_type === 'MULTUP' ? values.low : values.high;
    const lastPnl = closed === null ? formatFixed(multiplierPnl(state, adverse)) : state.lastPnl;
    return { close: closed, state: { ...state, closed, lastCandle, lastPnl } };
  }
  const atOrBefore = candle.endMs <= state.expiryMs ? lastCandle : state.lastCandle;
  if (candle.endMs < state.expiryMs) {
    return { close: null, state: { ...state, lastCandle } };
  }
  if (atOrBefore === null) {
    throw new RangeError('Falta la vela de la entrada.');
  }
  const closed = expiryClose(state, atOrBefore.close, atOrBefore.endMs);
  return { close: closed, state: { ...state, closed, lastCandle } };
}

/**
 * Una venta por reglas, o al cerrar la ventana, de un multiplicador con velas de Deriv: sale con el
 * cierre de la vela en que se decide, la última que recibió (ADR-0024 §6).
 */
export function sellCandlePositionAtClose(state: PositionState): PositionStep {
  assertOpen(state);
  if (state.kind !== 'candle_multiplier' || state.lastCandle === null) {
    throw new RangeError('Solo se vende así un multiplicador con velas que ya recibió una.');
  }
  const { close: price, endMs } = state.lastCandle;
  const closed = close('exit_rule', multiplierPnl(state, parseFixed(price)), price, endMs);
  return { close: closed, state: { ...state, closed } };
}

/**
 * El resultado de un multiplicador abierto con su último precio, en centavos redondeados al par:
 * el que suma la curva de resultados para la caída máxima (§5). Con velas de Deriv, el del extremo
 * adverso de la última vela. `null` si está cerrada o es un
 * sube/baja, que solo cuenta al vencer.
 */
export function positionMarkCents(state: PositionState): number | null {
  if (state.closed !== null || state.kind === 'tick_callput' || state.kind === 'candle_callput') {
    return null;
  }
  return fixedToCents(parseFixed(state.lastPnl));
}

/** La curva de resultados acumulados, en centavos, y su máximo anterior (§5). */
export interface DrawdownState {
  readonly peakCents: number;
}

export interface DrawdownStep {
  /** La bajada desde el máximo anterior, en centavos. */
  readonly drawdownCents: number;
  readonly state: DrawdownState;
}

/**
 * El estado de la caída al empezar, o al reanudar a mano tras la caída máxima, que se vuelve a
 * contar desde el resultado de ese instante (precisión de ADR-0026 §4).
 */
export function initialDrawdownState(equityCents = 0): DrawdownState {
  centsToFixed(equityCents);
  return { peakCents: equityCents };
}

/** Suma un punto de la curva: el resultado acumulado de las cerradas más el del multiplicador abierto. */
export function stepDrawdown(state: DrawdownState, equityCents: number): DrawdownStep {
  centsToFixed(equityCents);
  const peakCents = Math.max(state.peakCents, equityCents);
  return { drawdownCents: peakCents - equityCents, state: { peakCents } };
}

/**
 * Si la caída llega a su tope, en % del capital inicial: `caída ≥ tope % × capital`, exacto, en
 * centavos (§5).
 */
export function drawdownReached(
  drawdownCents: number,
  maxDrawdownPercent: string,
  initialCapital: string,
): boolean {
  const limit = fixedProduct(
    positive(maxDrawdownPercent, 'El tope de la caída'),
    positive(initialCapital, 'El capital inicial'),
  );
  if (!Number.isSafeInteger(drawdownCents) || drawdownCents < 0) {
    throw new RangeError('La caída es un entero de centavos no negativo.');
  }
  // El tope en centavos es `tope × capital`: el 50 % de 1000 USD son 500 USD, 50 000 centavos.
  return parseFixed(String(drawdownCents)) >= limit;
}
