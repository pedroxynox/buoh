interface Scale {
  readonly x: (i: number) => number;
  readonly y: (v: number) => number;
  readonly min: number;
  readonly max: number;
}

const W = 1000;
const PAD = { top: 18, right: 64, bottom: 24, left: 12 } as const;

function scaleFor(values: readonly (number | null)[], height: number, includeZero = false): Scale {
  const finite = values.filter((v): v is number => v !== null);
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const span = max - min === 0 ? 1 : max - min;
  min -= span * 0.08;
  max += span * 0.08;
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  return {
    x: (i) => PAD.left + (i / Math.max(values.length - 1, 1)) * innerW,
    y: (v) => PAD.top + (1 - (v - min) / (max - min)) * innerH,
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
    d += `${pen ? 'L' : 'M'}${s.x(i).toFixed(1)} ${s.y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function GridLines({
  s,
  height,
  digits,
  decimalComma = false,
}: {
  readonly s: Scale;
  readonly height: number;
  readonly digits: number;
  /** Las cotizaciones conservan el punto de la fuente; los porcentajes usan coma. */
  readonly decimalComma?: boolean;
}) {
  const steps = 4;
  const lines = Array.from({ length: steps + 1 }, (_, k) => s.min + ((s.max - s.min) * k) / steps);
  return (
    <g>
      {lines.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={s.y(v)}
            y2={s.y(v)}
            stroke="var(--b-chart-grid)"
            strokeWidth="1"
          />
          <text
            x={W - PAD.right + 8}
            y={s.y(v) + 4}
            fill="var(--b-text-muted)"
            fontSize="11"
            fontFamily="var(--b-font-mono)"
          >
            {decimalComma ? v.toFixed(digits).replace('.', ',') : v.toFixed(digits)}
          </text>
        </g>
      ))}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={height - PAD.bottom}
        y2={height - PAD.bottom}
        stroke="var(--b-border)"
      />
    </g>
  );
}

export interface ChartGap {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/** Gráfico de precios con los huecos marcados como cortes (guía §8). */
export function PriceChart({
  values,
  gaps,
  label,
  height = 260,
}: {
  readonly values: readonly (number | null)[];
  readonly gaps: readonly ChartGap[];
  readonly label: string;
  readonly height?: number;
}) {
  const s = scaleFor(values, height);
  return (
    <svg
      className="w-chart"
      viewBox={`0 0 ${String(W)} ${String(height)}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <GridLines s={s} height={height} digits={2} />
      {gaps.map((gap) => (
        <g key={gap.start}>
          <rect
            x={s.x(gap.start)}
            y={PAD.top}
            width={s.x(gap.end) - s.x(gap.start)}
            height={height - PAD.top - PAD.bottom}
            fill="color-mix(in srgb, var(--b-chart-gap) 14%, transparent)"
            stroke="var(--b-chart-gap)"
            strokeDasharray="4 4"
          />
          <text
            x={s.x(gap.start)}
            y={PAD.top - 6}
            fill="var(--b-chart-gap)"
            fontSize="11"
            fontWeight="600"
          >
            {gap.label}
          </text>
        </g>
      ))}
      <path d={segments(values, s)} fill="none" stroke="var(--b-chart-line)" strokeWidth="1.6" />
    </svg>
  );
}

/** Curva de resultado acumulado (%) con línea de cero y la peor caída marcada. */
export function EquityChart({
  values,
  label,
  height = 220,
}: {
  readonly values: readonly number[];
  readonly label: string;
  readonly height?: number;
}) {
  const s = scaleFor(values, height, true);
  let peak = Number.NEGATIVE_INFINITY;
  let worst = { drop: 0, at: 0, peakValue: 0 };
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    if (peak - v > worst.drop) {
      worst = { drop: peak - v, at: i, peakValue: peak };
    }
  });
  const worstValue = values[worst.at] ?? 0;
  return (
    <svg
      className="w-chart"
      viewBox={`0 0 ${String(W)} ${String(height)}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <GridLines s={s} height={height} digits={1} decimalComma />
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={s.y(0)}
        y2={s.y(0)}
        stroke="var(--b-text-muted)"
        strokeDasharray="2 4"
      />
      <path d={segments(values, s)} fill="none" stroke="var(--b-chart-line)" strokeWidth="1.6" />
      <line
        x1={s.x(worst.at)}
        x2={s.x(worst.at)}
        y1={s.y(worst.peakValue)}
        y2={s.y(worstValue)}
        stroke="var(--b-tone-rojo-fg)"
        strokeWidth="2"
      />
      <text
        x={s.x(worst.at) + 6}
        y={s.y(worstValue) + 14}
        fill="var(--b-tone-rojo-fg)"
        fontSize="11"
        fontWeight="600"
      >
        Peor caída: −{worst.drop.toFixed(1).replace('.', ',')} pts
      </text>
    </svg>
  );
}
