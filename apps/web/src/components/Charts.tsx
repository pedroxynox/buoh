import { worstDrawdown } from '@buoh/prototype-data';
import type { ReactNode } from 'react';

/**
 * Gráficos propios (guía §8). El SVG dibuja solo líneas y áreas y se estira al contenedor;
 * los textos van en HTML encima, para que se lean al mismo tamaño en móvil y en escritorio.
 *
 * Es un componente de servidor: se renderiza en la exportación estática y no lleva JavaScript de
 * cliente ni interacción. Hoy solo lo alimentan los datos ficticios de @buoh/prototype-data. El
 * flujo completo está en docs/diseno/flujo-de-graficas.md.
 */

/** Coordenadas internas del dibujo: 0–1000 en horizontal y 0–100 en vertical. */
const W = 1000;
const H = 100;

interface Scale {
  readonly x: (i: number) => number;
  readonly y: (v: number) => number;
  readonly min: number;
  readonly max: number;
}

/**
 * Escala lineal con un 10 % de margen arriba y abajo. `includeZero` obliga a mostrar el cero (curva
 * de resultados). Supone al menos un valor no nulo: con todos nulos, min y max serían infinitos.
 */
function scaleFor(values: readonly (number | null)[], includeZero = false): Scale {
  const finite = values.filter((v): v is number => v !== null);
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const span = max - min === 0 ? 1 : max - min;
  min -= span * 0.1;
  max += span * 0.1;
  return {
    x: (i) => (i / Math.max(values.length - 1, 1)) * W,
    y: (v) => (1 - (v - min) / (max - min)) * H,
    min,
    max,
  };
}

/** Trazo dividido en segmentos: un `null` corta la línea, nunca se interpola un hueco. */
function segments(values: readonly (number | null)[], s: Scale): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${s.x(i).toFixed(2)} ${s.y(v).toFixed(2)}`;
    pen = true;
  });
  return d;
}

// Convierten coordenadas del dibujo en porcentajes del contenedor, para colocar las etiquetas HTML.
const pctX = (x: number) => `${((x / W) * 100).toFixed(2)}%`;
const pctY = (y: number) => `${((y / H) * 100).toFixed(2)}%`;

interface AxisLabel {
  readonly index: number;
  readonly label: string;
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
  const steps = 4;
  const ticks = Array.from({ length: steps + 1 }, (_, k) => s.min + ((s.max - s.min) * k) / steps);
  return (
    <div className="w-chart__area" style={{ height: `${String(height)}px` }}>
      <svg
        className="w-chart__svg"
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {ticks.map((v) => (
          <line
            key={v}
            x1={0}
            x2={W}
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

export interface ChartGap {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/** Gráfico de precios con los huecos marcados como cortes. `start`–`end - 1` son los ticks que faltan. */
export function PriceChart({
  values,
  gaps,
  timeLabels,
  label,
  height = 240,
}: {
  readonly values: readonly (number | null)[];
  readonly gaps: readonly ChartGap[];
  readonly timeLabels: readonly AxisLabel[];
  readonly label: string;
  readonly height?: number;
}) {
  const s = scaleFor(values);
  return (
    // `role="img"` hace que el lector de pantalla lea solo `label`: las etiquetas HTML de dentro
    // quedan ocultas para él. Por eso la página escribe en `label` lo que muestra el gráfico.
    <div className="w-chart" role="img" aria-label={label}>
      <Frame
        s={s}
        height={height}
        format={(v) => v.toFixed(2)}
        timeLabels={timeLabels}
        overlay={gaps.map((gap) => (
          <span
            key={gap.start}
            className="w-chart__note"
            style={{ left: pctX(s.x(gap.start - 1)) }}
          >
            {gap.label}
          </span>
        ))}
      >
        {/* La banda va del último tick antes del hueco al primero después, así se ven los dos bordes. */}
        {gaps.map((gap) => (
          <rect
            key={gap.start}
            x={s.x(gap.start - 1)}
            y={0}
            width={s.x(gap.end) - s.x(gap.start - 1)}
            height={H}
            fill="color-mix(in srgb, var(--b-chart-gap) 14%, transparent)"
            stroke="var(--b-chart-gap)"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={segments(values, s)}
          fill="none"
          stroke="var(--b-chart-line)"
          strokeWidth="1.75"
          vectorEffect="non-scaling-stroke"
        />
      </Frame>
    </div>
  );
}

// Decimal con coma y signo menos tipográfico (−), como el resto de las cifras de resultados.
const comma = (v: number, digits: number) => v.toFixed(digits).replace('.', ',').replace('-', '−');

/** Curva de resultado acumulado (puntos porcentuales) con línea de cero y la peor caída marcada. */
export function EquityChart({
  values,
  timeLabels,
  label,
  height = 220,
}: {
  readonly values: readonly number[];
  readonly timeLabels: readonly AxisLabel[];
  readonly label: string;
  readonly height?: number;
}) {
  const s = scaleFor(values, true);
  const worst = worstDrawdown(values);
  const bottom = values[worst.at] ?? 0;
  return (
    <div className="w-chart" role="img" aria-label={label}>
      <Frame
        s={s}
        height={height}
        format={(v) => comma(v, 1)}
        timeLabels={timeLabels}
        overlay={
          <span
            className="w-chart__note w-chart__note--loss"
            style={{ left: pctX(s.x(worst.at)), top: pctY(s.y(bottom)) }}
          >
            Peor caída: −{comma(worst.drop, 1)}&nbsp;pts
          </span>
        }
      >
        <line
          x1={0}
          x2={W}
          y1={s.y(0)}
          y2={s.y(0)}
          stroke="var(--b-text-muted)"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={segments(values, s)}
          fill="none"
          stroke="var(--b-chart-line)"
          strokeWidth="1.75"
          vectorEffect="non-scaling-stroke"
        />
        {/* Peor caída: segmento vertical en el valle, desde la altura del máximo previo. */}
        <line
          x1={s.x(worst.at)}
          x2={s.x(worst.at)}
          y1={s.y(worst.peak)}
          y2={s.y(bottom)}
          stroke="var(--b-tone-rojo-fg)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </Frame>
    </div>
  );
}
