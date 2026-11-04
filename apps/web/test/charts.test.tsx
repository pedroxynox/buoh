/**
 * Gráficos accesibles y probados (`F2-CHART-001`; concepto de interfaz §9): la escala, los cortes de
 * la línea, la banda de cada hueco, la alternativa en texto calculada de los datos y el SVG que
 * dibujan los componentes, también con una serie vacía, una sin ningún dato y un hueco en el primer
 * punto. Los valores esperados están calculados a mano, no con el código que prueban.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EquityChart, PriceChart } from '../src/components/Charts';
import { gapBand, linePath, scaleFor, type Scale } from '../src/components/chart-geometry';
import {
  clockUtc,
  decimalComma,
  describeEquityChart,
  describePriceChart,
  gapLabel,
  percentText,
} from '../src/components/chart-text';

const NB = '\u00a0';

/** Una escala de prueba que se lee a ojo: 10 unidades por punto, y el valor tal cual. */
const PLAIN: Scale = { x: (index) => index * 10, y: (value) => value, min: 0, max: 100 };

/** Las horas de una serie de `count` ticks cada 2 s desde la medianoche del 20 oct 2026. */
const timesOf = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 9, 20, 0, 0, 2 * i)).toISOString(),
  );

/** Las rutas `d` de los `<path>` de un SVG. */
const pathsOf = (html: string) => [...html.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1] ?? '');

describe('scaleFor (F2-CHART-001)', () => {
  it('deja un 10 % de margen arriba y abajo y reparte los puntos a lo ancho, también los que faltan', () => {
    const s = scaleFor([1, null, 3]);
    expect(s?.min).toBeCloseTo(0.8, 10);
    expect(s?.max).toBeCloseTo(3.2, 10);
    expect([s?.x(0), s?.x(1), s?.x(2)]).toEqual([0, 500, 1000]);
    expect(s?.y(1)).toBeCloseTo(91.6667, 3);
    expect(s?.y(3)).toBeCloseTo(8.3333, 3);
  });

  it('con includeZero, el cero entra en el rango', () => {
    const s = scaleFor([2, 4], true);
    expect(s?.min).toBeCloseTo(-0.4, 10);
    expect(s?.max).toBeCloseTo(4.4, 10);
    expect(s?.y(0)).toBeCloseTo(91.6667, 3);
  });

  it('una serie plana queda en el centro, y un solo punto en el borde izquierdo', () => {
    expect(scaleFor([5, 5, 5])?.y(5)).toBeCloseTo(50, 10);
    const single = scaleFor([7]);
    expect(single?.x(0)).toBe(0);
    expect(single?.y(7)).toBeCloseTo(50, 10);
  });

  it('sin ningún valor no hay escala: una serie vacía o con todos sus puntos en un hueco', () => {
    expect(scaleFor([])).toBeNull();
    expect(scaleFor([], true)).toBeNull();
    expect(scaleFor([null, null, null])).toBeNull();
  });
});

describe('linePath (F2-CHART-001)', () => {
  it('un valor que falta corta la línea: nunca une los dos lados de un hueco', () => {
    expect(linePath([1, 2, null, 3, 4], PLAIN)).toBe('M0.00 1.00L10.00 2.00M30.00 3.00L40.00 4.00');
  });

  it('un hueco en el primer punto: la línea empieza después de él', () => {
    expect(linePath([null, null, 5, 6], PLAIN)).toBe('M20.00 5.00L30.00 6.00');
  });

  it('un punto sin vecinos es un trazo de largo cero, que se ve como un punto', () => {
    expect(linePath([1, null, 2, null, 3], PLAIN)).toBe(
      'M0.00 1.00L0.00 1.00M20.00 2.00L20.00 2.00M40.00 3.00L40.00 3.00',
    );
    expect(linePath([7], PLAIN)).toBe('M0.00 7.00L0.00 7.00');
  });

  it('sin ningún valor no hay línea', () => {
    expect(linePath([], PLAIN)).toBe('');
    expect(linePath([null, null], PLAIN)).toBe('');
  });
});

describe('gapBand (F2-CHART-001)', () => {
  it('va del último punto antes del hueco al primero después', () => {
    expect(gapBand({ start: 2, end: 3 }, PLAIN, 5)).toEqual({ width: 20, x: 10 });
  });

  it('un hueco en el primer punto empieza en el borde izquierdo, y uno en el último termina en el derecho', () => {
    expect(gapBand({ start: 0, end: 2 }, PLAIN, 5)).toEqual({ width: 20, x: 0 });
    expect(gapBand({ start: 3, end: 5 }, PLAIN, 5)).toEqual({ width: 20, x: 20 });
  });

  it('rechaza un hueco vacío o que se sale de la serie', () => {
    for (const gap of [
      { start: 2, end: 2 },
      { start: -1, end: 1 },
      { start: 3, end: 6 },
      { start: 1.5, end: 3 },
    ]) {
      expect(() => gapBand(gap, PLAIN, 5), JSON.stringify(gap)).toThrow(RangeError);
    }
  });
});

describe('cifras y horas de los textos', () => {
  it('la hora es la UTC del instante', () => {
    expect(clockUtc('2026-10-20T14:30:00.000Z')).toBe('14:30:00');
    expect(clockUtc('2026-10-20T16:30:00+02:00')).toBe('14:30:00');
    expect(() => clockUtc('')).toThrow(RangeError);
  });

  it('las cifras de resultados llevan coma y signo menos, y el cero va sin signo', () => {
    expect(decimalComma(-3.6, 1)).toBe('−3,6');
    expect(decimalComma(1.25, 2)).toBe('1,25');
    expect(decimalComma(-0.04, 1)).toBe('0,0');
    expect(percentText(-3.6)).toBe(`−3,6${NB}%`);
  });

  it('la nota de un hueco dice sus ticks, lo que duran y su motivo', () => {
    expect(gapLabel({ end: 33, reason: 'conexión perdida', start: 27 }, 2)).toBe(
      `Hueco: 6 ticks (12${NB}s) · conexión perdida`,
    );
    expect(gapLabel({ end: 2, reason: 'otro motivo', start: 1 }, 2)).toBe(
      `Hueco: 1 tick (2${NB}s) · otro motivo`,
    );
  });
});

describe('alternativa en texto calculada de los datos (F2-CHART-001)', () => {
  const title = 'Precio de prueba';

  it('ticks: período, ticks, mínimo, máximo, último y cada hueco con su período y su motivo', () => {
    expect(
      describePriceChart({
        gaps: [{ end: 4, reason: 'conexión perdida', start: 2 }],
        times: timesOf(5),
        title,
        values: [1, 2, null, null, 3],
      }),
    ).toBe(
      'Precio de prueba entre las 00:00:00 y las 00:00:08 UTC: 3 ticks, entre 1.00 y 3.00, y el último a 3.00. Un hueco de 2 ticks, de las 00:00:04 a las 00:00:06: conexión perdida.',
    );
  });

  it('ticks: sin huecos lo dice, y con varios los enumera', () => {
    expect(describePriceChart({ gaps: [], times: timesOf(2), title, values: [5, 4] })).toBe(
      'Precio de prueba entre las 00:00:00 y las 00:00:02 UTC: 2 ticks, entre 4.00 y 5.00, y el último a 4.00. Sin huecos.',
    );
    expect(
      describePriceChart({
        gaps: [
          { end: 1, reason: 'conexión perdida', start: 0 },
          { end: 4, reason: 'hueco sin resolver', start: 2 },
        ],
        times: timesOf(5),
        title,
        values: [null, 1, null, null, 2],
      }),
    ).toBe(
      'Precio de prueba entre las 00:00:00 y las 00:00:08 UTC: 2 ticks, entre 1.00 y 2.00, y el último a 2.00. 2 huecos: 1 tick, a las 00:00:00: conexión perdida; 2 ticks, de las 00:00:04 a las 00:00:06: hueco sin resolver.',
    );
  });

  it('ticks: una serie vacía y una sin ningún dato lo dicen, con sus huecos', () => {
    expect(describePriceChart({ gaps: [], times: [], title, values: [] })).toBe(
      'Precio de prueba: no llegó ningún tick en este período.',
    );
    expect(
      describePriceChart({
        gaps: [{ end: 2, reason: 'conexión perdida', start: 0 }],
        times: timesOf(2),
        title,
        values: [null, null],
      }),
    ).toBe(
      'Precio de prueba entre las 00:00:00 y las 00:00:02 UTC: no llegó ningún tick. Un hueco de 2 ticks, de las 00:00:00 a las 00:00:02: conexión perdida.',
    );
  });

  it('ticks: cada valor necesita su hora', () => {
    expect(() =>
      describePriceChart({ gaps: [], times: timesOf(1), title, values: [1, 2] }),
    ).toThrow(RangeError);
  });

  it('curva de resultados: unidad, período, extremos y peor caída en % del capital inicial', () => {
    expect(
      describeEquityChart({
        timeLabels: [
          { index: 0, label: '1 oct' },
          { index: 3, label: '4 oct' },
        ],
        title: 'Curva de prueba',
        values: [0, 1.5, -0.5, 0.2],
      }),
    ).toBe(
      `Curva de prueba, en % del capital inicial, del 1 oct al 4 oct: empieza en 0,0${NB}% y termina en 0,2${NB}%, con un máximo de 1,5${NB}% y un mínimo de −0,5${NB}%. Peor caída: −2,0${NB}%, de 1,5${NB}% a −0,5${NB}%.`,
    );
  });

  it('curva de resultados: sin caídas y sin valores lo dice; sin fechas en sus extremos, no da período', () => {
    expect(
      describeEquityChart({ timeLabels: [], title: 'Curva de prueba', values: [0, 1, 2] }),
    ).toBe(
      `Curva de prueba, en % del capital inicial: empieza en 0,0${NB}% y termina en 2,0${NB}%, con un máximo de 2,0${NB}% y un mínimo de 0,0${NB}%. Sin caídas desde un máximo.`,
    );
    expect(describeEquityChart({ timeLabels: [], title: 'Curva de prueba', values: [] })).toBe(
      'Curva de prueba, en % del capital inicial: todavía no hay resultados en este período.',
    );
  });
});

describe('SVG de los gráficos (F2-CHART-001)', () => {
  const price = (values: readonly (number | null)[], gaps: { start: number; end: number }[]) =>
    renderToStaticMarkup(
      <PriceChart
        title="Precio de prueba"
        values={values}
        times={timesOf(values.length)}
        intervalSeconds={2}
        gaps={gaps.map((gap) => ({ ...gap, reason: 'conexión perdida' }))}
        timeLabels={[]}
      />,
    );

  it('ticks: su nombre es la alternativa calculada, la línea se corta en el hueco y la banda lo cubre', () => {
    const values = [1, 2, null, null, 3];
    const html = price(values, [{ end: 4, start: 2 }]);
    const expected = describePriceChart({
      gaps: [{ end: 4, reason: 'conexión perdida', start: 2 }],
      times: timesOf(5),
      title: 'Precio de prueba',
      values,
    });
    expect(html).toContain(`role="img" aria-label="${expected}"`);
    // Dos tramos: 0–1 y el punto 4, solo, al otro lado del hueco.
    expect(pathsOf(html)).toEqual([
      expect.stringMatching(/^M0\.00 [\d.]+L250\.00 [\d.]+M1000\.00 [\d.]+L1000\.00 [\d.]+$/),
    ]);
    expect(html).toMatch(/<rect x="250" y="0" width="750" height="100"/);
    expect(html).toContain(`Hueco: 2 ticks (4${NB}s) · conexión perdida`);
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('ticks: un hueco en el primer punto no sale del dibujo', () => {
    const html = price([null, null, 1, 2, 3], [{ end: 2, start: 0 }]);
    expect(html).toMatch(/<rect x="0" y="0" width="500" height="100"/);
    expect(html).toContain('style="left:0.00%"');
    expect(pathsOf(html)[0]).toMatch(/^M500\.00 /);
    expect(html).not.toMatch(/="-|NaN|Infinity/);
  });

  it('ticks: una serie vacía y una sin ningún dato muestran su estado vacío, sin dibujo', () => {
    const empty = price([], []);
    expect(empty).not.toContain('<svg');
    expect(empty).toContain('Precio de prueba: no llegó ningún tick en este período.');
    const missing = price([null, null, null], [{ end: 3, start: 0 }]);
    expect(missing).not.toContain('<svg');
    expect(missing).toContain('no llegó ningún tick');
    expect(missing).toContain('conexión perdida');
    expect(`${empty}${missing}`).not.toMatch(/NaN|Infinity/);
  });

  it('curva de resultados: la peor caída va en % del capital inicial, la misma unidad que su contexto', () => {
    const html = renderToStaticMarkup(
      <EquityChart title="Curva de prueba" values={[0, 1.5, -0.5, 0.2]} timeLabels={[]} />,
    );
    expect(html).toContain(`Peor caída: −2,0${NB}%`);
    expect(html).toContain('stroke="var(--b-tone-rojo-fg)"');
    expect(html).toContain(
      `aria-label="${describeEquityChart({ timeLabels: [], title: 'Curva de prueba', values: [0, 1.5, -0.5, 0.2] })}"`,
    );
    expect(html).not.toMatch(/pts|NaN|Infinity/);
  });

  it('curva de resultados: sin caídas no marca ninguna, y sin valores muestra su estado vacío', () => {
    const rising = renderToStaticMarkup(
      <EquityChart title="Curva de prueba" values={[0, 1, 2]} timeLabels={[]} />,
    );
    expect(rising).not.toContain('Peor caída:');
    expect(rising).not.toContain('var(--b-tone-rojo-fg)');
    const empty = renderToStaticMarkup(
      <EquityChart title="Curva de prueba" values={[]} timeLabels={[]} />,
    );
    expect(empty).not.toContain('<svg');
    expect(empty).toContain('todavía no hay resultados en este período');
  });
});
