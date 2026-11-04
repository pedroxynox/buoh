import { worstDrawdown } from '@buoh/prototype-data';

import { presentValues, type GapRange, type SeriesValue } from './chart-geometry';

/**
 * Los textos de los gráficos, calculados de los datos que dibujan (concepto de interfaz §9): la
 * alternativa en texto de cada gráfico, que es su nombre para el lector de pantalla, y la nota de
 * cada hueco. Nunca se escriben a mano, así que cambian con los datos.
 */

const NB = '\u00a0';

/** Un hueco con su motivo, como lo marcan los datos. */
export interface ChartGap extends GapRange {
  readonly reason: string;
}

/** Una etiqueta del eje de tiempo, en el punto `index`. */
export interface AxisLabel {
  readonly index: number;
  readonly label: string;
}

/** La hora UTC (HH:MM:SS) de un instante ISO 8601. Rechaza un instante que no lo es. */
export function clockUtc(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** Un precio con dos decimales, como las cifras del eje. */
export function priceText(value: number): string {
  return value.toFixed(2);
}

/**
 * Una cifra con coma decimal y el signo menos tipográfico (−), como el resto de las cifras de
 * resultados. La que se redondea a cero va sin signo.
 */
export function decimalComma(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  const unsigned = Number(fixed) === 0 ? fixed.replace('-', '') : fixed;
  return unsigned.replace('.', ',').replace('-', '−');
}

/** Un valor en % del capital inicial, con un decimal: «−3,6 %». */
export function percentText(value: number): string {
  return `${decimalComma(value, 1)}${NB}%`;
}

const tickCount = (count: number) => (count === 1 ? '1 tick' : `${String(count)} ticks`);

/** La nota visible de un hueco: cuántos ticks faltan, cuánto duran y su motivo. */
export function gapLabel(gap: ChartGap, intervalSeconds: number): string {
  const count = gap.end - gap.start;
  return `Hueco: ${tickCount(count)} (${String(count * intervalSeconds)}${NB}s) · ${gap.reason}`;
}

/** Cuándo faltan los ticks de un hueco: «a las 14:30:00» o «de las 14:30:00 a las 14:30:10». */
function gapPeriod(gap: ChartGap, times: readonly string[]): string {
  const first = clockUtc(times[gap.start] ?? '');
  if (gap.end - gap.start === 1) {
    return `a las ${first}`;
  }
  return `de las ${first} a las ${clockUtc(times[gap.end - 1] ?? '')}`;
}

function describeGaps(gaps: readonly ChartGap[], times: readonly string[]): string {
  const items = gaps.map(
    (gap) => `${tickCount(gap.end - gap.start)}, ${gapPeriod(gap, times)}: ${gap.reason}`,
  );
  if (items.length === 0) {
    return 'Sin huecos.';
  }
  return items.length === 1
    ? `Un hueco de ${items.join('')}.`
    : `${String(items.length)} huecos: ${items.join('; ')}.`;
}

export interface PriceChartData {
  /** Qué muestra el gráfico, el principio de su alternativa: «Precio ficticio de Volatility 100». */
  readonly title: string;
  readonly values: readonly SeriesValue[];
  /** La hora de cada punto, en ISO 8601: una por valor. */
  readonly times: readonly string[];
  readonly gaps: readonly ChartGap[];
}

/**
 * La alternativa en texto del gráfico de ticks (concepto de interfaz §9): qué es, su período UTC,
 * cuántos ticks tiene, el mínimo y el máximo, el último y cada hueco, con los ticks que faltan, su
 * período y su motivo. Si no llegó ningún tick, lo dice. Rechaza una hora que falta.
 */
export function describePriceChart(data: PriceChartData): string {
  const { gaps, times, title, values } = data;
  if (times.length !== values.length) {
    throw new RangeError('Cada valor del gráfico necesita su hora.');
  }
  if (values.length === 0) {
    return `${title}: no llegó ningún tick en este período.`;
  }
  const period = `entre las ${clockUtc(times[0] ?? '')} y las ${clockUtc(times.at(-1) ?? '')} UTC`;
  const present = presentValues(values);
  const last = present.at(-1);
  if (last === undefined) {
    return `${title} ${period}: no llegó ningún tick. ${describeGaps(gaps, times)}`;
  }
  const min = present.reduce((a, b) => Math.min(a, b));
  const max = present.reduce((a, b) => Math.max(a, b));
  return `${title} ${period}: ${tickCount(present.length)}, entre ${priceText(min)} y ${priceText(max)}, y el último a ${priceText(last)}. ${describeGaps(gaps, times)}`;
}

export interface EquityChartData {
  /** Qué muestra el gráfico, el principio de su alternativa: «Curva ficticia de resultado acumulado». */
  readonly title: string;
  /** El resultado acumulado, en % del capital inicial. */
  readonly values: readonly number[];
  readonly timeLabels: readonly AxisLabel[];
}

/**
 * La alternativa en texto de la curva de resultados (concepto de interfaz §9): qué es y en qué
 * unidad, su período si las etiquetas del eje marcan sus dos extremos, el primer y el último valor,
 * el máximo y el mínimo, y la peor caída, con el máximo del que parte y su valle, en la misma unidad
 * que la nota del gráfico y su contexto. Sin valores, dice que todavía no hay resultados.
 */
export function describeEquityChart(data: EquityChartData): string {
  const { timeLabels, title, values } = data;
  const subject = `${title}, en % del capital inicial`;
  const first = values[0];
  const last = values.at(-1);
  if (first === undefined || last === undefined) {
    return `${subject}: todavía no hay resultados en este período.`;
  }
  const from = timeLabels.find((item) => item.index === 0);
  const to = timeLabels.find((item) => item.index === values.length - 1);
  const period = from === undefined || to === undefined ? '' : `, del ${from.label} al ${to.label}`;
  const max = values.reduce((a, b) => Math.max(a, b));
  const min = values.reduce((a, b) => Math.min(a, b));
  const worst = worstDrawdown(values);
  const drop =
    worst.drop > 0
      ? `Peor caída: ${percentText(-worst.drop)}, de ${percentText(worst.peak)} a ${percentText(values[worst.at] ?? worst.peak)}.`
      : 'Sin caídas desde un máximo.';
  return `${subject}${period}: empieza en ${percentText(first)} y termina en ${percentText(last)}, con un máximo de ${percentText(max)} y un mínimo de ${percentText(min)}. ${drop}`;
}
