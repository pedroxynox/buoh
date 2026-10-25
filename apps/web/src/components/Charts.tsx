import type { ReactNode } from 'react';

/**
 * Gráficos propios (guía §8). El SVG dibuja solo líneas y áreas y se estira al contenedor;
 * los textos van en HTML encima, para que se lean al mismo tamaño en móvil y en escritorio.
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

/** Mayor caída desde un máximo previo, en las mismas unidades que la serie. */
export function worstDrawdown(values: readonly number[]): {
  readonly drop: number;
  readonly at: number;
  readonly peak: number;
} {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = { drop: 0, at: 0, peak: 0 };
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    if (peak - v > worst.drop) {
      worst = { drop: peak - v, at: i, peak };
    }
  });
  return worst;
}

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
