import { worstDrawdown } from '@buoh/prototype-data';
import type { ReactNode } from 'react';

import {
  CHART_HEIGHT,
  CHART_WIDTH,
  gapBand,
  linePath,
  scaleFor,
  type Scale,
  type SeriesValue,
} from './chart-geometry';
import {
  decimalComma,
  describeEquityChart,
  describePriceChart,
  gapLabel,
  percentText,
  priceText,
  type AxisLabel,
  type ChartGap,
} from './chart-text';

/**
 * Gráficos propios (guía §8 y concepto de interfaz §9). El SVG dibuja solo líneas y áreas y se
 * estira al contenedor; los textos van en HTML encima, para que se lean al mismo tamaño en móvil y
 * en escritorio. La geometría está en `chart-geometry.ts`, y la alternativa en texto de cada
 * gráfico, calculada de sus datos, en `chart-text.ts`.
 *
 * Es un componente de servidor: se renderiza en la exportación estática y no lleva JavaScript de
 * cliente ni interacción. Hoy solo lo alimentan los datos ficticios de @buoh/prototype-data. El
 * flujo completo está en docs/diseno/flujo-de-graficas.md.
 */

// Convierten coordenadas del dibujo en porcentajes del contenedor, para colocar las etiquetas HTML.
const pctX = (x: number) => `${((x / CHART_WIDTH) * 100).toFixed(2)}%`;
const pctY = (y: number) => `${((y / CHART_HEIGHT) * 100).toFixed(2)}%`;

/**
 * El estado vacío de un gráfico sin ningún valor (concepto de interfaz §5 y §9): su alternativa en
 * texto, visible, en lugar del dibujo.
 */
function EmptyChart({ text }: { readonly text: string }) {
  return <p className="w-chart-empty">{text}</p>;
}

function Frame({
  s,
  height,
  format,
  timeLabels,
  children,
  overlay,
}: {
  readonly s: Scale;
  readonly height: number;
  readonly format: (v: number) => string;
  readonly timeLabels: readonly AxisLabel[];
  readonly children: ReactNode;
  readonly overlay?: ReactNode;
}) {
  // Cinco líneas de rejilla repartidas por igual en el rango con margen; no son valores redondos.
  // Son decorativas: los valores están en las cifras del eje y en la alternativa en texto.
  const steps = 4;
  const ticks = Array.from({ length: steps + 1 }, (_, k) => s.min + ((s.max - s.min) * k) / steps);
  return (
    <div className="w-chart__area" style={{ height: `${String(height)}px` }}>
      <svg
        className="w-chart__svg"
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {ticks.map((v) => (
          <line
            key={v}
            x1={0}
            x2={CHART_WIDTH}
            y1={s.y(v)}
            y2={s.y(v)}
            stroke="var(--b-chart-grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {children}
      </svg>
      {ticks.map((v) => (
        <span key={v} className="w-chart__y b-num" style={{ top: pctY(s.y(v)) }}>
          {format(v)}
        </span>
      ))}
      {timeLabels.map((t, k) => (
        <span
          key={t.index}
          className={`w-chart__x b-num${k === 0 ? ' w-chart__x--start' : k === timeLabels.length - 1 ? ' w-chart__x--end' : ' w-chart__x--mid'}`}
          style={{ left: pctX(s.x(t.index)) }}
        >
          {t.label}
        </span>
      ))}
      {overlay}
    </div>
  );
}

/**
 * Gráfico de ticks con los huecos marcados como cortes. En cada hueco faltan los ticks `start` a
 * `end - 1`, y `reason` es su motivo. `times` da la hora de cada punto, y `intervalSeconds`, la de
 * un tick a otro. Sin ningún valor, muestra su estado vacío.
 */
export function PriceChart({
  title,
  values,
  times,
  intervalSeconds,
  gaps,
  timeLabels,
  height = 240,
}: {
  readonly title: string;
  readonly values: readonly SeriesValue[];
  readonly times: readonly string[];
  readonly intervalSeconds: number;
  readonly gaps: readonly ChartGap[];
  readonly timeLabels: readonly AxisLabel[];
  readonly height?: number;
}) {
  const description = describePriceChart({ gaps, times, title, values });
  const s = scaleFor(values);
  if (s === null) {
    return <EmptyChart text={description} />;
  }
  const bands = gaps.map((gap) => ({ band: gapBand(gap, s, values.length), gap }));
  return (
    // `role="img"` hace que el lector de pantalla lea solo `aria-label`, la alternativa en texto
    // calculada de los datos: las etiquetas HTML de dentro quedan ocultas para él.
    <div className="w-chart" role="img" aria-label={description}>
      <Frame
        s={s}
        height={height}
        format={priceText}
        timeLabels={timeLabels}
        overlay={bands.map(({ band, gap }) => (
          <span key={gap.start} className="w-chart__note" style={{ left: pctX(band.x) }}>
            {gapLabel(gap, intervalSeconds)}
          </span>
        ))}
      >
        {/* La banda va del último tick antes del hueco al primero después, así se ven los dos bordes. */}
        {bands.map(({ band, gap }) => (
          <rect
            key={gap.start}
            x={band.x}
            y={0}
            width={band.width}
            height={CHART_HEIGHT}
            fill="color-mix(in srgb, var(--b-chart-gap) 14%, transparent)"
            stroke="var(--b-chart-gap)"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={linePath(values, s)}
          fill="none"
          stroke="var(--b-chart-line)"
          strokeWidth="1.75"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </Frame>
    </div>
  );
}

/**
 * Curva de resultado acumulado, en % del capital inicial, con línea de cero y la peor caída marcada
 * en esa misma unidad (concepto de interfaz §9). Sin ningún valor, muestra su estado vacío.
 */
export function EquityChart({
  title,
  values,
  timeLabels,
  height = 220,
}: {
  readonly title: string;
  readonly values: readonly number[];
  readonly timeLabels: readonly AxisLabel[];
  readonly height?: number;
}) {
  const description = describeEquityChart({ timeLabels, title, values });
  const s = scaleFor(values, true);
  if (s === null) {
    return <EmptyChart text={description} />;
  }
  const worst = worstDrawdown(values);
  const bottom = values[worst.at] ?? 0;
  const dropped = worst.drop > 0;
  return (
    <div className="w-chart" role="img" aria-label={description}>
      <Frame
        s={s}
        height={height}
        format={(v) => decimalComma(v, 1)}
        timeLabels={timeLabels}
        overlay={
          dropped ? (
            <span
              className="w-chart__note w-chart__note--loss"
              style={{ left: pctX(s.x(worst.at)), top: pctY(s.y(bottom)) }}
            >
              {`Peor caída: ${percentText(-worst.drop)}`}
            </span>
          ) : null
        }
      >
        <line
          x1={0}
          x2={CHART_WIDTH}
          y1={s.y(0)}
          y2={s.y(0)}
          stroke="var(--b-text-muted)"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={linePath(values, s)}
          fill="none"
          stroke="var(--b-chart-line)"
          strokeWidth="1.75"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Peor caída: segmento vertical en el valle, desde la altura del máximo previo. */}
        {dropped ? (
          <line
            x1={s.x(worst.at)}
            x2={s.x(worst.at)}
            y1={s.y(worst.peak)}
            y2={s.y(bottom)}
            stroke="var(--b-tone-rojo-fg)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </Frame>
    </div>
  );
}
