'use client';

import { Badge, Callout, Card } from '@buoh/design-system/react';
import type { DataCatalog, DataChart } from '@buoh/contracts';
import { formatUtc, formatUtcTime } from '@buoh/prototype-data';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { PageHeader } from './AppShell';
import { describeFailure, type ApiFailure } from './auth/api';
import {
  candleMinutes,
  candlesOf,
  gapsOf,
  isUnresolved,
  qualityText,
  ticksOf,
  type ChartGapRange,
} from './mercados/grafico';
import { CandleChart, GapList, TickChart } from './mercados/MarketCharts';
import {
  CHART_HOURS,
  CHART_REFRESH_MS,
  useMercados,
  type ChartHours,
  type Load,
  type MercadosState,
} from './mercados/store';
import { DataMeta } from './Pieces';
import { sourceLabel } from './salud/salud';

/** Cómo se dibuja el gráfico: sus ticks o sus velas (concepto de interfaz §9 y §11). */
export type ChartKind = 'ticks' | 'candles';

/** El símbolo que se captura en la Fase 2: su fila del catálogo lo dice. */
const CAPTURED_SYMBOL = 'R_100';

const iso = (timeMs: number) => new Date(timeMs).toISOString();

function hoursText(hours: number): string {
  return hours === 1 ? 'Última hora' : `Últimas ${String(hours)} horas`;
}

function refreshText(hours: ChartHours): string {
  const minutes = CHART_REFRESH_MS[hours] / 60_000;
  return minutes === 1 ? 'cada minuto' : `cada ${String(minutes)} minutos`;
}

function Loading({ text }: { readonly text: string }) {
  return (
    <>
      <div className="w-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="b-visually-hidden">{text}</p>
    </>
  );
}

function FailureCallout({
  title,
  failure,
}: {
  readonly title: string;
  readonly failure: ApiFailure;
}) {
  return (
    <Callout tone="rojo" icon="alertTriangle" title={title}>
      {describeFailure(failure)}
      {failure.code === 'unauthenticated' ? (
        <p>
          <Link className="w-link" href="/acceso">
            Iniciar sesión
          </Link>
        </p>
      ) : null}
    </Callout>
  );
}

/** El aviso de una actualización fallida que conserva lo de la lectura anterior (concepto §5). */
function RefreshFailure<T>({ load }: { readonly load: Load<T> }) {
  if (load.kind !== 'ready' || load.refreshFailure === null) {
    return null;
  }
  return (
    <Callout tone="naranja" icon="alertTriangle" title="No se pudo actualizar">
      {describeFailure(load.refreshFailure)}{' '}
      {`Lo que ves es de la lectura de las ${formatUtcTime(iso(load.receivedAtMs))}.`}
    </Callout>
  );
}

function Choice<T extends number | string>({
  label,
  options,
  value,
  text,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly text: (option: T) => string;
  readonly onChange: (option: T) => void;
}) {
  return (
    <div className="w-row" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          className={`b-button ${option === value ? 'b-button--primary' : 'b-button--secondary'}`}
          aria-pressed={option === value}
          onClick={() => {
            onChange(option);
          }}
        >
          {text(option)}
        </button>
      ))}
    </div>
  );
}

function QualityBadge({ gaps }: { readonly gaps: readonly ChartGapRange[] }) {
  const text = qualityText(gaps);
  if (gaps.length === 0) {
    return <Badge icon="check">{text}</Badge>;
  }
  return gaps.some(isUnresolved) ? (
    <Badge tone="naranja" icon="gap">
      {text}
    </Badge>
  ) : (
    <Badge icon="gap">{text}</Badge>
  );
}

/** Los metadatos de toda vista de datos (concepto de interfaz §1), para el gráfico. */
function chartMeta(
  chart: DataChart,
  kind: ChartKind,
  minutes: number,
  receivedAtMs: number,
  lastTickMs: number | null,
  gaps: readonly ChartGapRange[],
): (readonly [string, ReactNode])[] {
  const read = `leído a las ${formatUtcTime(iso(receivedAtMs))}`;
  return [
    [
      'Símbolo',
      <span key="s" className="b-num">
        {chart.symbol}
      </span>,
    ],
    ['Fuente', sourceLabel(chart.source)],
    ['Zona horaria', 'UTC'],
    [
      'Intervalo',
      kind === 'ticks'
        ? 'Cada tick, en su hora de fuente'
        : `Velas de ${String(minutes)} ${minutes === 1 ? 'minuto' : 'minutos'}`,
    ],
    ['Período', `Del ${formatUtc(chart.from_utc)} al ${formatUtc(chart.to_utc)}`],
    [
      'Frescura',
      lastTickMs === null
        ? `Ningún tick en esta ventana; ${read}`
        : `Último tick a las ${formatUtcTime(iso(lastTickMs))}; ${read}`,
    ],
    ['Calidad', <QualityBadge key="q" gaps={gaps} />],
    ['Log activo', chart.log === null ? 'Ninguno' : `Log ${String(chart.log)}`],
  ];
}

function ChartReady({
  chart,
  kind,
  receivedAtMs,
}: {
  readonly chart: DataChart;
  readonly kind: ChartKind;
  readonly receivedAtMs: number;
}) {
  const fromMs = Date.parse(chart.from_utc);
  const toMs = Date.parse(chart.to_utc);
  const ticks = ticksOf(chart);
  const gaps = gapsOf(chart);
  const minutes = candleMinutes(toMs - fromMs);
  const title = `Precio de Volatility 100 (${chart.symbol})`;
  const meta = (
    <DataMeta
      items={chartMeta(chart, kind, minutes, receivedAtMs, ticks.at(-1)?.timeMs ?? null, gaps)}
    />
  );
  if (chart.log === null) {
    return (
      <>
        {meta}
        <p className="w-chart-empty">
          Todavía no hay ningún log de captura activo, así que no hay datos que dibujar.
        </p>
      </>
    );
  }
  const started =
    chart.log_started_at_utc !== null && chart.log_started_at_utc > chart.from_utc
      ? chart.log_started_at_utc
      : null;
  return (
    <>
      {meta}
      {kind === 'ticks' ? (
        <TickChart title={title} fromMs={fromMs} toMs={toMs} ticks={ticks} gaps={gaps} />
      ) : (
        <CandleChart
          title={title}
          fromMs={fromMs}
          toMs={toMs}
          ticks={ticks}
          candles={candlesOf(ticks, gaps, minutes)}
          gaps={gaps}
          minutes={minutes}
        />
      )}
      <GapList gaps={gaps} />
      {started === null ? null : (
        <p className="b-muted w-small">
          {`El log ${String(chart.log)} empezó el ${formatUtc(started)}: antes, esta ventana no tiene datos suyos, como justo después del corte semanal.`}
        </p>
      )}
      <p className="b-muted w-small">
        Los huecos salen del registro de la captura, nunca de la distancia entre dos ticks, y no se
        rellenan. Los ticks que recuperó la historia todavía no se dibujan.
      </p>
    </>
  );
}

function ChartBody({ state, kind }: { readonly state: MercadosState; readonly kind: ChartKind }) {
  const { chart } = state;
  switch (chart.kind) {
    case 'loading':
      return <Loading text="Cargando el gráfico de R_100" />;
    case 'failed':
      return <FailureCallout title="No se pudo leer el gráfico" failure={chart.failure} />;
    case 'ready':
      return <ChartReady chart={chart.data} kind={kind} receivedAtMs={chart.receivedAtMs} />;
  }
}

function entryState(entry: NonNullable<DataCatalog['catalog']>['entries'][number]): string {
  if (entry.is_trading_suspended === 1) {
    return 'Suspendido';
  }
  return entry.exchange_is_open === 1 ? 'Abierto' : 'Cerrado';
}

function CatalogReady({
  data,
  receivedAtMs,
}: {
  readonly data: DataCatalog;
  readonly receivedAtMs: number;
}) {
  const { catalog, log } = data;
  if (catalog === null) {
    return (
      <p className="b-secondary w-small">
        {log === null
          ? 'Todavía no hay ningún log de captura activo, así que no hay catálogo.'
          : `El log ${String(log)} todavía no tiene ninguna versión del catálogo: llega con la primera conexión de la captura, como justo después del corte semanal.`}
      </p>
    );
  }
  return (
    <div className="w-stack">
      <DataMeta
        items={[
          ['Fuente', sourceLabel(catalog.source)],
          ['Versión', `${String(catalog.version)}, del log ${String(log ?? '—')}`],
          ['Recibida', formatUtc(catalog.received_at_utc)],
          ['Instrumentos', String(catalog.entries.length)],
          ['Esquemas de Deriv', catalog.source_schema_release],
          [
            'Contenido',
            <code key="h" className="b-num">
              {catalog.content_sha256}
            </code>,
          ],
          ['Leído', `a las ${formatUtcTime(iso(receivedAtMs))}`],
        ]}
      />
      <div className="w-table-wrap">
        <table className="b-table">
          <caption className="b-visually-hidden">
            {`Catálogo de Deriv, versión ${String(catalog.version)}: ${String(catalog.entries.length)} instrumentos con sus nombres oficiales.`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Símbolo oficial</th>
              <th scope="col">Nombre</th>
              <th scope="col">Tipo</th>
              <th scope="col">Mercado</th>
              <th scope="col">Submercado</th>
              <th scope="col">Grupo</th>
              <th scope="col">Tamaño del pip</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {catalog.entries.map((entry) => (
              <tr key={entry.underlying_symbol}>
                <td className="b-num">
                  {entry.underlying_symbol}
                  {entry.underlying_symbol === CAPTURED_SYMBOL ? (
                    <>
                      {' '}
                      <Badge icon="database">Se captura</Badge>
                    </>
                  ) : null}
                </td>
                <td>{entry.underlying_symbol_name}</td>
                <td>{entry.underlying_symbol_type}</td>
                <td>{entry.market}</td>
                <td>{entry.submarket}</td>
                <td>{entry.subgroup}</td>
                <td className="b-num">{entry.pip_size}</td>
                <td>{entryState(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CatalogBody({ catalog }: { readonly catalog: Load<DataCatalog> }) {
  switch (catalog.kind) {
    case 'loading':
      return <Loading text="Cargando el catálogo de Deriv" />;
    case 'failed':
      return <FailureCallout title="No se pudo leer el catálogo" failure={catalog.failure} />;
    case 'ready':
      return <CatalogReady data={catalog.data} receivedAtMs={catalog.receivedAtMs} />;
  }
}

/**
 * Mercados con los datos de producción (`F2-UI-001`; concepto de interfaz §11): el gráfico de R_100
 * de la ventana elegida, en ticks o en velas, con los huecos que marca el log y su motivo, y el
 * catálogo de Deriv con su versión y su fecha. Es una vista pura: la lectura llega en `state`.
 */
export function MercadosView({
  state,
  kind,
  onHours,
  onKind,
}: {
  readonly state: MercadosState;
  readonly kind: ChartKind;
  readonly onHours: (hours: ChartHours) => void;
  readonly onKind: (kind: ChartKind) => void;
}) {
  const chartGaps = state.chart.kind === 'ready' ? gapsOf(state.chart.data) : null;
  return (
    <>
      <PageHeader
        eyebrow="Mercados"
        title="¿Qué sigo y qué tan buenos son sus datos?"
        summary="El R_100 de Deriv con los datos de producción: sus ticks en su hora de fuente, con los huecos que marca la captura y su motivo, y el catálogo oficial de Deriv, con los nombres sin reinterpretar."
      />

      <Card
        title="Volatility 100 Index"
        subtitle={`${hoursText(state.hours)} · se actualiza sola ${refreshText(state.hours)}`}
        actions={chartGaps === null ? undefined : <QualityBadge gaps={chartGaps} />}
        headingLevel={2}
      >
        <div className="w-stack">
          <div className="w-row">
            <Choice
              label="Ventana"
              options={CHART_HOURS}
              value={state.hours}
              text={(hours) => `${String(hours)}\u00a0h`}
              onChange={onHours}
            />
            <Choice
              label="Vista"
              options={['ticks', 'candles'] as const}
              value={kind}
              text={(option) => (option === 'ticks' ? 'Ticks' : 'Velas')}
              onChange={onKind}
            />
          </div>
          <RefreshFailure load={state.chart} />
          <ChartBody state={state} kind={kind} />
        </div>
      </Card>

      <Card
        title="Catálogo de Deriv"
        subtitle="Los instrumentos activos según Deriv, con sus nombres oficiales"
        headingLevel={2}
      >
        <div className="w-stack">
          <RefreshFailure load={state.catalog} />
          <CatalogBody catalog={state.catalog} />
        </div>
      </Card>

      <p className="b-muted w-small">
        En la Fase 2, buoh solo captura R_100 de Deriv. Las demás fuentes llegan en su fase.
      </p>
    </>
  );
}

/** Mercados con los datos reales de la API. */
export function MercadosReal() {
  const [state, setHours] = useMercados();
  const [kind, setKind] = useState<ChartKind>('ticks');
  return <MercadosView state={state} kind={kind} onHours={setHours} onKind={setKind} />;
}
