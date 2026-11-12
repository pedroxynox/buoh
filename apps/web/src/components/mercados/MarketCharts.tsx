import { Badge } from '@buoh/design-system/react';
import { formatUtc, formatUtcTime } from '@buoh/prototype-data';

import { CHART_HEIGHT } from '../chart-geometry';
import { priceText, type AxisLabel } from '../chart-text';
import { Frame } from '../Charts';
import {
  describeTickChart,
  gapBandOf,
  gapShortText,
  gapText,
  isFalling,
  isUnresolved,
  tickPath,
  timeScaleFor,
  type Candle,
  type ChartGapRange,
  type ChartTick,
  type TimeScale,
} from './grafico';

/**
 * Los gráficos de Mercados con datos reales (concepto de interfaz §9 y §11): el de ticks, con su
 * alternativa en texto, y el de velas, con su alternativa en tabla. El eje horizontal es el tiempo
 * UTC de la ventana, y cada hueco del log es una banda que ocupa lo que duró. La geometría y los
 * textos están en `grafico.ts`.
 */

const iso = (timeMs: number) => new Date(timeMs).toISOString();

/** Las etiquetas del eje de tiempo: el principio, la mitad y el final de la ventana, en HH:MM. */
function timeLabels(fromMs: number, toMs: number): AxisLabel[] {
  return [fromMs, Math.round((fromMs + toMs) / 2), toMs].map((timeMs) => ({
    index: timeMs,
    label: formatUtcTime(iso(timeMs)).slice(0, 5),
  }));
}

/** Las bandas de los huecos: el relleno y el borde discontinuo del color del hueco. */
function GapBands({
  gaps,
  fromMs,
  toMs,
  scale,
}: {
  readonly gaps: readonly ChartGapRange[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly scale: TimeScale;
}) {
  return (
    <>
      {gaps.map((gap, index) => {
        const band = gapBandOf(gap, fromMs, toMs, scale);
        return (
          <rect
            key={`${String(gap.fromMs)}-${String(index)}`}
            x={band.x}
            y={0}
            width={band.width}
            height={CHART_HEIGHT}
            fill="color-mix(in srgb, var(--b-chart-gap) 14%, transparent)"
            stroke="var(--b-chart-gap)"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </>
  );
}

/**
 * El gráfico de ticks: la línea une cada tick con el siguiente, salvo si entre los dos empieza un
 * hueco del log. Su alternativa en texto es su nombre para el lector de pantalla (`role="img"`). Sin
 * ningún tick, en su lugar se lee esa alternativa, con los huecos y su motivo.
 */
export function TickChart({
  title,
  fromMs,
  toMs,
  ticks,
  gaps,
  height = 240,
}: {
  readonly title: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly ticks: readonly ChartTick[];
  readonly gaps: readonly ChartGapRange[];
  readonly height?: number;
}) {
  const description = describeTickChart({ fromMs, gaps, ticks, title, toMs });
  const scale = timeScaleFor(
    fromMs,
    toMs,
    ticks.map((tick) => tick.value),
  );
  if (scale === null) {
    return <p className="w-chart-empty">{description}</p>;
  }
  return (
    <div className="w-chart" role="img" aria-label={description}>
      <Frame s={scale} height={height} format={priceText} timeLabels={timeLabels(fromMs, toMs)}>
        <GapBands gaps={gaps} fromMs={fromMs} toMs={toMs} scale={scale} />
        <path
          d={tickPath(ticks, gaps, scale)}
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
 * Una vela: la mecha del máximo al mínimo, partida por el cuerpo, y el cuerpo de la apertura al
 * cierre, hueco si sube y lleno si baja. Si su intervalo toca un hueco, su borde es discontinuo y del
 * color del hueco (concepto de interfaz §9, «Velas»).
 */
function CandleShape({
  candle,
  scale,
  bodyWidth,
}: {
  readonly candle: Candle;
  readonly scale: TimeScale;
  readonly bodyWidth: number;
}) {
  const center = scale.x((candle.startMs + candle.endMs) / 2);
  const top = scale.y(Math.max(candle.open.value, candle.close.value));
  const bottom = scale.y(Math.min(candle.open.value, candle.close.value));
  const incomplete = candle.gaps.length > 0;
  const stroke = incomplete ? 'var(--b-chart-gap)' : 'var(--b-chart-line)';
  const dash = incomplete ? '3 2' : undefined;
  return (
    <g>
      <line
        x1={center}
        x2={center}
        y1={scale.y(candle.high.value)}
        y2={top}
        stroke={stroke}
        strokeDasharray={dash}
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={center}
        x2={center}
        y1={bottom}
        y2={scale.y(candle.low.value)}
        stroke={stroke}
        strokeDasharray={dash}
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={center - bodyWidth / 2}
        y={top}
        width={bodyWidth}
        height={Math.max(bottom - top, 0.6)}
        fill={isFalling(candle) ? 'var(--b-chart-line)' : 'none'}
        stroke={stroke}
        strokeDasharray={dash}
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** Lo que dice la fila de una vela incompleta: los huecos que tocan su intervalo. */
function candleGapText(candle: Candle): string {
  if (candle.gaps.length === 0) {
    return '—';
  }
  return `Incompleta: ${[...new Set(candle.gaps.map(gapShortText))].join(', ')}`;
}

/**
 * El gráfico de velas de `minutes` minutos y su alternativa: una tabla con una fila por vela, junto
 * al gráfico. El dibujo queda oculto para el lector de pantalla, que lee la tabla. Sin ningún tick,
 * en su lugar se lee la alternativa en texto del gráfico de ticks.
 */
export function CandleChart({
  title,
  fromMs,
  toMs,
  ticks,
  candles,
  gaps,
  minutes,
  height = 240,
}: {
  readonly title: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly ticks: readonly ChartTick[];
  readonly candles: readonly Candle[];
  readonly gaps: readonly ChartGapRange[];
  readonly minutes: number;
  readonly height?: number;
}) {
  const scale = timeScaleFor(
    fromMs,
    toMs,
    candles.flatMap((candle) => [candle.high.value, candle.low.value]),
  );
  if (scale === null) {
    return (
      <p className="w-chart-empty">{describeTickChart({ fromMs, gaps, ticks, title, toMs })}</p>
    );
  }
  const interval = scale.x(fromMs + minutes * 60_000) - scale.x(fromMs);
  const bodyWidth = Math.max(interval * 0.7, 1);
  const caption = `${title}: velas de ${String(minutes)} ${minutes === 1 ? 'minuto' : 'minutos'}, del ${formatUtc(iso(fromMs))} al ${formatUtc(iso(toMs))}.`;
  return (
    <div className="w-stack">
      <div className="w-chart" aria-hidden="true">
        <Frame s={scale} height={height} format={priceText} timeLabels={timeLabels(fromMs, toMs)}>
          <GapBands gaps={gaps} fromMs={fromMs} toMs={toMs} scale={scale} />
          {candles.map((candle) => (
            <CandleShape key={candle.startMs} candle={candle} scale={scale} bodyWidth={bodyWidth} />
          ))}
        </Frame>
      </div>
      <details>
        <summary>
          {`Tabla de las velas (${String(candles.length)}), la alternativa del gráfico`}
        </summary>
        <div className="w-table-wrap">
          <table className="b-table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Inicio (UTC)</th>
                <th scope="col">Apertura</th>
                <th scope="col">Máximo</th>
                <th scope="col">Mínimo</th>
                <th scope="col">Cierre</th>
                <th scope="col">Ticks</th>
                <th scope="col">Hueco</th>
              </tr>
            </thead>
            <tbody>
              {candles.map((candle) => (
                <tr key={candle.startMs}>
                  <td className="b-num">{formatUtc(iso(candle.startMs))}</td>
                  <td className="b-num">{candle.open.quote}</td>
                  <td className="b-num">{candle.high.quote}</td>
                  <td className="b-num">{candle.low.quote}</td>
                  <td className="b-num">{candle.close.quote}</td>
                  <td className="b-num">{String(candle.ticks)}</td>
                  <td>{candleGapText(candle)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** La lista de los huecos de la ventana, cada uno con su período y lo que pasó. */
export function GapList({ gaps }: { readonly gaps: readonly ChartGapRange[] }) {
  if (gaps.length === 0) {
    return null;
  }
  return (
    <ul className="w-stack w-small">
      {gaps.map((gap, index) => (
        <li key={`${String(gap.fromMs)}-${String(index)}`}>
          <Badge icon="gap" {...(isUnresolved(gap) ? { tone: 'naranja' as const } : {})}>
            {gapShortText(gap)}
          </Badge>{' '}
          {gapText(gap)}
        </li>
      ))}
    </ul>
  );
}
