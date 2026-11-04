/**
 * Geometría de los gráficos propios (concepto de interfaz §9), sin React ni navegador: la escala, la
 * línea cortada en los huecos y la banda de cada hueco. `Charts.tsx` la dibuja en SVG, y
 * `test/charts.test.tsx` la prueba sola. El SVG se estira a su contenedor.
 */

/** Coordenadas internas del dibujo: 0–1000 en horizontal y 0–100 en vertical. */
export const CHART_WIDTH = 1000;
export const CHART_HEIGHT = 100;

/** Un valor de la serie, o `null` si falta: un tick de un hueco. */
export type SeriesValue = number | null;

export interface Scale {
  /** La posición horizontal del punto `index`. */
  readonly x: (index: number) => number;
  /** La posición vertical de un valor. */
  readonly y: (value: number) => number;
  /** El rango que se dibuja, con su margen. */
  readonly min: number;
  readonly max: number;
}

/** Los puntos de un hueco: faltan los de `start` a `end - 1`. */
export interface GapRange {
  readonly start: number;
  readonly end: number;
}

/** Los valores que tiene la serie, sin los que faltan. */
export function presentValues(values: readonly SeriesValue[]): number[] {
  return values.filter((value): value is number => value !== null);
}

/**
 * Escala lineal con un 10 % de margen arriba y abajo. `includeZero` obliga a mostrar el cero (curva
 * de resultados), y una serie plana se dibuja en el centro. Sin ningún valor, porque la serie está
 * vacía o tiene todos sus puntos en un hueco, no hay escala: devuelve `null`, y el gráfico muestra su
 * estado vacío.
 */
export function scaleFor(values: readonly SeriesValue[], includeZero = false): Scale | null {
  const present = presentValues(values);
  if (present.length === 0) {
    return null;
  }
  let min = present.reduce((a, b) => Math.min(a, b));
  let max = present.reduce((a, b) => Math.max(a, b));
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const span = max - min === 0 ? 1 : max - min;
  const low = min - span * 0.1;
  const high = max + span * 0.1;
  const last = Math.max(values.length - 1, 1);
  return {
    x: (index) => (index / last) * CHART_WIDTH,
    y: (value) => (1 - (value - low) / (high - low)) * CHART_HEIGHT,
    min: low,
    max: high,
  };
}

/**
 * El trazo de la línea, en el lenguaje de rutas de SVG. Un valor que falta la corta: nunca se une ni
 * se interpola un hueco. Un punto sin vecinos, entre dos huecos o junto a uno en un extremo, es un
 * trazo de largo cero, que el extremo redondo de la línea dibuja como un punto, así que no
 * desaparece.
 */
export function linePath(values: readonly SeriesValue[], scale: Scale): string {
  let d = '';
  values.forEach((value, index) => {
    if (value === null) {
      return;
    }
    const point = `${scale.x(index).toFixed(2)} ${scale.y(value).toFixed(2)}`;
    const opens = index === 0 || values[index - 1] === null;
    const closes = index === values.length - 1 || values[index + 1] === null;
    d += `${opens ? 'M' : 'L'}${point}`;
    if (opens && closes) {
      d += `L${point}`;
    }
  });
  return d;
}

/** Rechaza un hueco vacío o que se sale de una serie de `length` puntos. */
function checkGapRange(gap: GapRange, length: number): void {
  if (
    !Number.isInteger(gap.start) ||
    !Number.isInteger(gap.end) ||
    gap.start < 0 ||
    gap.end <= gap.start ||
    gap.end > length
  ) {
    throw new RangeError(
      `Hueco fuera de la serie: puntos ${String(gap.start)} a ${String(gap.end)} de ${String(length)}.`,
    );
  }
}

/**
 * Comprueba que los huecos y los valores que faltan coinciden: cada hueco está dentro de la serie,
 * no está vacío y todos sus puntos faltan, y cada punto que falta está en un hueco. Así un `null` sin
 * hueco que lo marque, o un hueco sobre ticks que sí llegaron, falla en lugar de dibujarse o
 * describirse en silencio.
 */
export function checkGaps(values: readonly SeriesValue[], gaps: readonly GapRange[]): void {
  const marked = new Set<number>();
  for (const gap of gaps) {
    checkGapRange(gap, values.length);
    for (let index = gap.start; index < gap.end; index += 1) {
      if (values[index] !== null) {
        throw new RangeError(`El hueco tiene un valor en el punto ${String(index)}.`);
      }
      marked.add(index);
    }
  }
  const unmarked = values.findIndex((value, index) => value === null && !marked.has(index));
  if (unmarked !== -1) {
    throw new RangeError(`Falta el punto ${String(unmarked)} sin un hueco que lo marque.`);
  }
}

/**
 * La banda de un hueco: va del último punto antes del hueco al primero después, así se ven los dos
 * bordes del corte. La de un hueco en el primer punto empieza en el borde izquierdo, y la de uno en
 * el último termina en el derecho. Rechaza un hueco vacío o que se sale de la serie.
 */
export function gapBand(
  gap: GapRange,
  scale: Scale,
  length: number,
): { readonly x: number; readonly width: number } {
  checkGapRange(gap, length);
  const from = scale.x(Math.max(gap.start - 1, 0));
  const to = scale.x(Math.min(gap.end, length - 1));
  return { width: to - from, x: from };
}
