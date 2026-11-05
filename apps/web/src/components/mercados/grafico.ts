/**
 * El gráfico de R_100 con datos reales (concepto de interfaz §9 y §11; ADR-0019 §8), sin React ni
 * navegador. De la respuesta `DataChart` salen los ticks en su hora de fuente, la línea cortada en
 * los huecos, la banda de cada hueco, las velas y las alternativas en texto y en tabla. El eje
 * horizontal es el tiempo UTC, así que un hueco ocupa lo que duró. Un hueco es siempre uno que marca
 * el log: el gráfico nunca lo deduce de la distancia entre dos ticks. `MarketCharts.tsx` lo dibuja, y
 * `test/mercados.test.tsx` lo prueba solo.
 */
import type { DataChart, DataChartGap } from '@buoh/contracts';
import { formatUtc } from '@buoh/prototype-data';

import { CHART_HEIGHT, CHART_WIDTH } from '../chart-geometry';

const MINUTE_MS = 60_000;

/** Un tick del gráfico: su hora de fuente, su cotización en decimal canónico y su valor numérico. */
export interface ChartTick {
  readonly timeMs: number;
  readonly quote: string;
  readonly value: number;
}

/** Un hueco del log, en milisegundos; `toMs` es `null` mientras sigue. */
export interface ChartGapRange {
  readonly fromMs: number;
  readonly toMs: number | null;
  readonly cause: DataChartGap['cause'];
  readonly history: DataChartGap['history'];
  readonly reason: string | null;
  readonly recoveredTicks: number | null;
}

/** Los ticks de la respuesta, en orden, cada uno en su hora: `from_utc` más su desfase. */
export function ticksOf(chart: DataChart): ChartTick[] {
  const from = Date.parse(chart.from_utc);
  return chart.ticks.offsets_ms.map((offset, index) => {
    const quote = chart.ticks.quotes[index] ?? '0';
    return { quote, timeMs: from + offset, value: Number(quote) };
  });
}

/** Los huecos de la respuesta, en milisegundos y en el mismo orden. */
export function gapsOf(chart: DataChart): ChartGapRange[] {
  return chart.gaps.map((gap) => ({
    cause: gap.cause,
    fromMs: Date.parse(gap.from_utc),
    history: gap.history,
    reason: gap.reason,
    recoveredTicks: gap.recovered_ticks,
    toMs: gap.to_utc === null ? null : Date.parse(gap.to_utc),
  }));
}

/**
 * Si al hueco le faltan datos: una conexión perdida cuya historia no lo cubrió o todavía no llegó, o
 * una parada de la captura, que no se recupera. En uno recuperado, la historia trajo los ticks.
 */
export function isUnresolved(gap: ChartGapRange): boolean {
  return gap.history !== 'recovered';
}

/** La calidad de la ventana, por sus huecos: cuántos hay y cuántos siguen sin recuperar. */
export function qualityText(gaps: readonly ChartGapRange[]): string {
  const missing = gaps.filter(isUnresolved).length;
  const count = gaps.length === 1 ? '1 hueco' : `${String(gaps.length)} huecos`;
  if (gaps.length === 0) {
    return 'Sin huecos';
  }
  if (missing === gaps.length) {
    return `${count} sin recuperar`;
  }
  if (missing === 0) {
    return gaps.length === 1 ? '1 hueco recuperado' : `${count} recuperados`;
  }
  return `${count}, ${String(missing)} sin recuperar`;
}

/** La escala de tiempo y de precio del dibujo: `x` recibe milisegundos y `y`, un precio. */
export interface TimeScale {
  readonly x: (timeMs: number) => number;
  readonly y: (value: number) => number;
  /** El rango de precios que se dibuja, con su margen. */
  readonly min: number;
  readonly max: number;
}

/**
 * La escala de la ventana `[fromMs, toMs]` con un 10 % de margen de precio arriba y abajo, como los
 * gráficos ficticios (`scaleFor`), y una serie plana en el centro. Sin ningún valor no hay escala:
 * devuelve `null`, y el gráfico muestra su alternativa en lugar del dibujo.
 */
export function timeScaleFor(
  fromMs: number,
  toMs: number,
  values: readonly number[],
): TimeScale | null {
  if (values.length === 0 || toMs <= fromMs) {
    return null;
  }
  const min = values.reduce((a, b) => Math.min(a, b));
  const max = values.reduce((a, b) => Math.max(a, b));
  const span = max - min === 0 ? 1 : max - min;
  const low = min - span * 0.1;
  const high = max + span * 0.1;
  return {
    max: high,
    min: low,
    x: (timeMs) => ((timeMs - fromMs) / (toMs - fromMs)) * CHART_WIDTH,
    y: (value) => (1 - (value - low) / (high - low)) * CHART_HEIGHT,
  };
}

/** Si un hueco del log empieza entre dos ticks seguidos: entonces la línea se corta. */
function cutsBetween(before: ChartTick, after: ChartTick, gaps: readonly ChartGapRange[]): boolean {
  return gaps.some((gap) => gap.fromMs > before.timeMs && gap.fromMs <= after.timeMs);
}

/**
 * El trazo de la línea en el lenguaje de rutas de SVG. Une cada tick con el siguiente salvo si entre
 * los dos empieza un hueco del log: la distancia entre dos ticks nunca corta la línea, solo el log.
 * Un tick sin vecinos es un trazo de largo cero, que el extremo redondo dibuja como un punto.
 */
export function tickPath(
  ticks: readonly ChartTick[],
  gaps: readonly ChartGapRange[],
  scale: TimeScale,
): string {
  let d = '';
  ticks.forEach((tick, index) => {
    const point = `${scale.x(tick.timeMs).toFixed(2)} ${scale.y(tick.value).toFixed(2)}`;
    const previous = ticks[index - 1];
    const next = ticks[index + 1];
    const opens = previous === undefined || cutsBetween(previous, tick, gaps);
    const closes = next === undefined || cutsBetween(tick, next, gaps);
    d += `${opens ? 'M' : 'L'}${point}`;
    if (opens && closes) {
      d += `L${point}`;
    }
  });
  return d;
}

/**
 * La banda de un hueco dentro de la ventana: de su principio a su fin, o al final de la ventana si
 * sigue, recortada a sus bordes.
 */
export function gapBandOf(
  gap: ChartGapRange,
  fromMs: number,
  toMs: number,
  scale: TimeScale,
): { readonly x: number; readonly width: number } {
  const start = scale.x(Math.max(gap.fromMs, fromMs));
  const end = scale.x(Math.min(gap.toMs ?? toMs, toMs));
  return { width: Math.max(end - start, 0), x: start };
}

/** Los intervalos posibles de una vela, en minutos (concepto de interfaz §9, «Velas»). */
export const CANDLE_MINUTES = [1, 5, 15, 60] as const;

/** Cuántos intervalos puede durar como mucho la ventana con el intervalo elegido. */
const MAX_CANDLES = 120;

/**
 * El intervalo de las velas de una ventana: el menor de 1, 5, 15 y 60 minutos con el que dura como
 * mucho 120 intervalos. Así son 1 minuto hasta 2 horas, 5 hasta 10, 15 hasta 30 y 60 por encima.
 */
export function candleMinutes(windowMs: number): number {
  return CANDLE_MINUTES.find((minutes) => windowMs <= MAX_CANDLES * minutes * MINUTE_MS) ?? 60;
}

/** Una vela: el resumen de los ticks de su intervalo, alineado en UTC a su múltiplo. */
export interface Candle {
  readonly startMs: number;
  readonly endMs: number;
  readonly open: ChartTick;
  readonly high: ChartTick;
  readonly low: ChartTick;
  readonly close: ChartTick;
  readonly ticks: number;
  /** Los huecos que tocan su intervalo: si hay alguno, la vela está incompleta. */
  readonly gaps: readonly ChartGapRange[];
}

/** Si un hueco toca el intervalo `[startMs, endMs)`; uno que sigue llega hasta el final. */
function touches(gap: ChartGapRange, startMs: number, endMs: number): boolean {
  return gap.fromMs < endMs && (gap.toMs ?? Number.POSITIVE_INFINITY) >= startMs;
}

/**
 * Las velas de los ticks, cada una del intervalo de `minutes` minutos alineado a su múltiplo en UTC
 * que contiene la hora de fuente de sus ticks: la apertura es el primero, el cierre el último, y el
 * máximo y el mínimo, los extremos. Un intervalo sin ticks no tiene vela, y nunca se dibuja una con
 * el cierre de la anterior. Cada vela lleva los huecos del log que tocan su intervalo.
 */
export function candlesOf(
  ticks: readonly ChartTick[],
  gaps: readonly ChartGapRange[],
  minutes: number,
): Candle[] {
  const intervalMs = minutes * MINUTE_MS;
  // Los ticks llegan en orden, así que los intervalos quedan en orden en el mapa.
  const buckets = new Map<number, ChartTick[]>();
  for (const tick of ticks) {
    const startMs = Math.floor(tick.timeMs / intervalMs) * intervalMs;
    const bucket = buckets.get(startMs);
    if (bucket === undefined) {
      buckets.set(startMs, [tick]);
    } else {
      bucket.push(tick);
    }
  }
  const candles: Candle[] = [];
  for (const [startMs, members] of buckets) {
    const [open] = members;
    const close = members.at(-1);
    if (open === undefined || close === undefined) {
      continue;
    }
    const endMs = startMs + intervalMs;
    candles.push({
      close,
      endMs,
      gaps: gaps.filter((gap) => touches(gap, startMs, endMs)),
      high: members.reduce((a, b) => (b.value > a.value ? b : a)),
      low: members.reduce((a, b) => (b.value < a.value ? b : a)),
      open,
      startMs,
      ticks: members.length,
    });
  }
  return candles;
}

/** Si la vela baja: cierra por debajo de su apertura. Las demás se dibujan como las que suben. */
export function isFalling(candle: Candle): boolean {
  return candle.close.value < candle.open.value;
}

const tickCount = (count: number) => (count === 1 ? '1 tick' : `${String(count)} ticks`);

/** Qué pasó en un hueco, en una frase: su causa y lo que dijo la historia. */
export function gapCauseText(gap: ChartGapRange): string {
  if (gap.cause === 'capture_stopped') {
    return 'Captura parada, como en un despliegue o un reinicio. No se recupera.';
  }
  switch (gap.history) {
    case 'recovered':
      return `Conexión perdida. La historia la recuperó con ${tickCount(gap.recoveredTicks ?? 0)}, que todavía no se dibujan.`;
    case 'partial':
      return `Conexión perdida. La historia trajo ${tickCount(gap.recoveredTicks ?? 0)}, pero no la cubre entera (${gap.reason ?? 'sin motivo'}).`;
    case 'unavailable':
      return `Conexión perdida. La historia no la pudo recuperar (${gap.reason ?? 'sin motivo'}).`;
    case 'pending':
    case 'not_requested':
      return 'Conexión perdida. La historia todavía no llegó.';
  }
}

/** El nombre corto de un hueco, para su nota y su fila. */
export function gapShortText(gap: ChartGapRange): string {
  if (gap.cause === 'capture_stopped') {
    return 'Captura parada';
  }
  switch (gap.history) {
    case 'recovered':
      return 'Conexión perdida, recuperada';
    case 'partial':
    case 'unavailable':
      return 'Conexión perdida, sin recuperar';
    case 'pending':
    case 'not_requested':
      return 'Conexión perdida, pendiente';
  }
}

/** Cuándo fue un hueco: «del … al …» o «desde el …», si sigue. */
export function gapPeriodText(gap: ChartGapRange): string {
  const from = formatUtc(new Date(gap.fromMs).toISOString());
  return gap.toMs === null
    ? `desde el ${from}, y sigue`
    : `del ${from} al ${formatUtc(new Date(gap.toMs).toISOString())}`;
}

/** Un hueco entero, para su lista y para la alternativa: su período y lo que pasó. */
export function gapText(gap: ChartGapRange): string {
  return `${gapPeriodText(gap)}: ${gapCauseText(gap)}`;
}

function describeGaps(gaps: readonly ChartGapRange[]): string {
  if (gaps.length === 0) {
    return 'Sin huecos.';
  }
  const items = gaps.map(gapText);
  return items.length === 1
    ? `Un hueco, ${items.join('')}`
    : `${String(items.length)} huecos: ${items.join(' ')}`;
}

export interface TickChartData {
  /** Qué muestra el gráfico, el principio de su alternativa. */
  readonly title: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly ticks: readonly ChartTick[];
  readonly gaps: readonly ChartGapRange[];
}

/**
 * La alternativa en texto del gráfico de ticks (concepto de interfaz §9): qué es, su período UTC,
 * cuántos ticks tiene, el primero y el último, el mínimo y el máximo con sus cotizaciones exactas, y
 * cada hueco, con su período y lo que pasó. Si no llegó ningún tick, lo dice.
 */
export function describeTickChart(data: TickChartData): string {
  const { fromMs, gaps, ticks, title, toMs } = data;
  const period = `del ${formatUtc(new Date(fromMs).toISOString())} al ${formatUtc(new Date(toMs).toISOString())}`;
  const first = ticks[0];
  const last = ticks.at(-1);
  if (first === undefined || last === undefined) {
    return `${title}, ${period}: no llegó ningún tick. ${describeGaps(gaps)}`;
  }
  const low = ticks.reduce((a, b) => (b.value < a.value ? b : a));
  const high = ticks.reduce((a, b) => (b.value > a.value ? b : a));
  return `${title}, ${period}: ${tickCount(ticks.length)}, el primero a ${first.quote} y el último a ${last.quote}, entre ${low.quote} y ${high.quote}. ${describeGaps(gaps)}`;
}
