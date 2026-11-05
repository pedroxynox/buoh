/**
 * Mercados con datos reales en la web servida por la API (`F2-UI-001`; concepto de interfaz §9 y
 * §11): la forma de las respuestas del gráfico y del catálogo, contrastada con los esquemas de
 * `@buoh/contracts`; los ticks en su hora, la línea cortada solo en los huecos del log, las bandas,
 * las velas y sus alternativas; la vista con cada estado; el almacén con su refresco; y las dos
 * lecturas de la API, sin el token CSRF. Los gráficos de prueba son sintéticos: ningún precio es de
 * mercado.
 */
import {
  dataCatalogSchema,
  dataChartSchema,
  type DataCatalog,
  type DataChart,
} from '@buoh/contracts';
import { formatUtc } from '@buoh/prototype-data';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type ApiFailure } from '../src/components/auth/api';
import { MercadosView, type ChartKind } from '../src/components/MercadosReal';
import {
  candleMinutes,
  candlesOf,
  describeTickChart,
  gapBandOf,
  gapCauseText,
  gapsOf,
  qualityText,
  tickPath,
  ticksOf,
  timeScaleFor,
  type ChartGapRange,
  type ChartTick,
} from '../src/components/mercados/grafico';
import { readDataCatalog, readDataChart } from '../src/components/mercados/respuesta';
import {
  CATALOG_REFRESH_MS,
  CHART_REFRESH_MS,
  createMercadosStore,
  LOADING,
  type ChartHours,
  type Load,
  type MercadosState,
  type MercadosStoreDeps,
} from '../src/components/mercados/store';
import { showsFictitiousDataInApi } from '../src/navigation';

const HOUR_MS = 3_600_000;
const FROM = '2026-11-08T11:00:00.000Z';
const TO = '2026-11-08T12:00:00.000Z';
const FROM_MS = Date.parse(FROM);
const TO_MS = Date.parse(TO);
const at = (seconds: number, ms = 0) => new Date(FROM_MS + seconds * 1000 + ms).toISOString();

/**
 * Una hora de gráfico: tres ticks, una parada pedida, dos ticks, una conexión perdida que la historia
 * recuperó, un tick y otra conexión perdida que sigue, sin la historia todavía.
 */
const CHART: DataChart = {
  log: 2,
  source: 'deriv_options',
  symbol: 'R_100',
  from_utc: FROM,
  to_utc: TO,
  log_started_at_utc: '2026-11-08T00:00:01.000Z',
  ticks: {
    offsets_ms: [0, 2000, 4000, 60_000, 62_000, 70_000],
    quotes: ['1234.56', '1234.60', '1234.58', '1233.10', '1233.12', '1235.00'],
  },
  gaps: [
    {
      from_utc: at(4, 1),
      to_utc: at(59, 999),
      cause: 'capture_stopped',
      history: 'not_requested',
      reason: null,
      recovered_ticks: null,
    },
    {
      from_utc: at(62, 1),
      to_utc: at(69, 999),
      cause: 'connection_lost',
      history: 'recovered',
      reason: null,
      recovered_ticks: 4,
    },
    {
      from_utc: at(70, 1),
      to_utc: null,
      cause: 'connection_lost',
      history: 'pending',
      reason: null,
      recovered_ticks: null,
    },
  ],
};

const EMPTY: DataChart = {
  log: null,
  source: 'deriv_options',
  symbol: 'R_100',
  from_utc: FROM,
  to_utc: TO,
  log_started_at_utc: null,
  ticks: { offsets_ms: [], quotes: [] },
  gaps: [],
};

const ENTRY = {
  underlying_symbol: 'R_100',
  underlying_symbol_name: 'Volatility 100 Index',
  underlying_symbol_type: 'stockindex',
  market: 'synthetic_index',
  submarket: 'random_index',
  subgroup: 'synthetics',
  pip_size: '0.01',
  exchange_is_open: 1,
  is_trading_suspended: 0,
} as const;

const CATALOG: DataCatalog = {
  log: 2,
  catalog: {
    source: 'deriv_options',
    version: 3,
    received_at_utc: '2026-11-08T00:00:02.500Z',
    source_schema_release: 'production_v20260901_0',
    content_sha256: 'c'.repeat(64),
    entries: [
      {
        ...ENTRY,
        underlying_symbol: '1HZ100V',
        underlying_symbol_name: 'Volatility 100 (1s) Index',
      },
      ENTRY,
      {
        ...ENTRY,
        underlying_symbol: 'frxEURUSD',
        underlying_symbol_name: 'EUR/USD',
        exchange_is_open: 0,
        market: 'forex',
      },
    ],
  },
};

describe('la forma de las respuestas, como los esquemas de @buoh/contracts', () => {
  const chartSamples: unknown[] = [
    CHART,
    EMPTY,
    { ...EMPTY, log: 1 },
    { ...EMPTY, log: 1, log_started_at_utc: at(30) },
    {
      ...CHART,
      from_utc: '2026-11-07T12:00:00.000Z',
      ticks: { offsets_ms: [24 * HOUR_MS], quotes: ['-1.5'] },
    },
    {
      ...EMPTY,
      log: 1,
      gaps: [
        {
          from_utc: '2026-11-08T10:30:00.001Z',
          to_utc: at(9, 999),
          cause: 'connection_lost',
          history: 'partial',
          reason: 'history_page_limit',
          recovered_ticks: 3,
        },
        {
          from_utc: at(10, 1),
          to_utc: at(20, 999),
          cause: 'connection_lost',
          history: 'unavailable',
          reason: 'history_timeout',
          recovered_ticks: null,
        },
        {
          from_utc: at(21, 1),
          to_utc: null,
          cause: 'capture_stopped',
          history: 'not_requested',
          reason: null,
          recovered_ticks: null,
        },
      ],
    },
  ];
  const catalogSamples: unknown[] = [
    CATALOG,
    { log: null, catalog: null },
    { log: 4, catalog: null },
  ];

  it('acepta lo que aceptan los esquemas, sin cambiar nada', () => {
    for (const sample of chartSamples) {
      expect(dataChartSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(true);
      expect(readDataChart(structuredClone(sample))).toEqual(sample);
    }
    for (const sample of catalogSamples) {
      expect(dataCatalogSchema.safeParse(sample).success).toBe(true);
      expect(readDataCatalog(structuredClone(sample))).toEqual(sample);
    }
  });

  it('rechaza lo que rechazan, regla por regla', () => {
    const gap = CHART.gaps[1];
    const invalidCharts: unknown[] = [
      null,
      [],
      { ...CHART, extra: 1 },
      { ...CHART, log: 0 },
      { ...CHART, log: 1_000_000 },
      { ...CHART, source: '' },
      { ...CHART, symbol: '' },
      { ...CHART, from_utc: '2026-11-08T11:00:00Z' },
      { ...CHART, to_utc: '2026-11-08T12:30:00.000Z' },
      { ...CHART, from_utc: '2026-11-07T11:00:00.000Z' },
      { ...CHART, from_utc: TO },
      { ...CHART, ticks: { offsets_ms: [0, 0], quotes: ['1', '2'] } },
      { ...CHART, ticks: { offsets_ms: [2000, 0], quotes: ['1', '2'] } },
      { ...CHART, ticks: { offsets_ms: [0], quotes: [] } },
      { ...CHART, ticks: { offsets_ms: [HOUR_MS + 1], quotes: ['1'] } },
      { ...CHART, ticks: { offsets_ms: [-1], quotes: ['1'] } },
      { ...CHART, ticks: { offsets_ms: [0.5], quotes: ['1'] } },
      { ...CHART, ticks: { offsets_ms: [0], quotes: ['1e3'] } },
      { ...CHART, ticks: { offsets_ms: [0], quotes: [1] } },
      { ...CHART, ticks: { offsets_ms: [0], quotes: ['1'], extra: [] } },
      { ...EMPTY, ticks: CHART.ticks },
      { ...EMPTY, gaps: [gap] },
      { ...EMPTY, log_started_at_utc: FROM },
      { ...CHART, gaps: [CHART.gaps[1], CHART.gaps[0]] },
      { ...CHART, gaps: [{ ...gap, cause: 'capture_stopped' }] },
      { ...CHART, gaps: [{ ...gap, history: 'not_requested', recovered_ticks: null }] },
      { ...CHART, gaps: [{ ...gap, reason: 'history_timeout' }] },
      { ...CHART, gaps: [{ ...gap, history: 'partial' }] },
      { ...CHART, gaps: [{ ...gap, recovered_ticks: null }] },
      { ...CHART, gaps: [{ ...gap, to_utc: null }] },
      {
        ...CHART,
        gaps: [
          { ...gap, history: 'unavailable', reason: 'x', recovered_ticks: null, to_utc: null },
        ],
      },
      { ...CHART, gaps: [{ ...gap, to_utc: at(1) }] },
      { ...CHART, gaps: [{ ...gap, reason: 'la historia no llegó', history: 'partial' }] },
      {
        ...CHART,
        gaps: [
          { ...gap, from_utc: '2026-11-08T12:00:00.001Z', to_utc: '2026-11-08T12:00:05.000Z' },
        ],
      },
      {
        ...CHART,
        gaps: [
          { ...gap, from_utc: '2026-11-08T10:00:00.001Z', to_utc: '2026-11-08T10:59:59.999Z' },
        ],
      },
      { ...CHART, gaps: [{ ...gap, extra: 1 }] },
    ];
    for (const sample of invalidCharts) {
      expect(dataChartSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(false);
      expect(readDataChart(sample), JSON.stringify(sample)).toBeNull();
    }
    const catalog = CATALOG.catalog;
    if (catalog === null) {
      throw new Error('el catálogo de prueba no puede ser null');
    }
    const invalidCatalogs: unknown[] = [
      { log: null, catalog },
      { log: 2, catalog: { ...catalog, version: 0 } },
      { log: 2, catalog: { ...catalog, content_sha256: 'C'.repeat(64) } },
      { log: 2, catalog: { ...catalog, received_at_utc: '2026-11-08' } },
      { log: 2, catalog: { ...catalog, entries: [] } },
      { log: 2, catalog: { ...catalog, entries: [ENTRY, ENTRY] } },
      { log: 2, catalog: { ...catalog, entries: [...catalog.entries].reverse() } },
      { log: 2, catalog: { ...catalog, entries: [{ ...ENTRY, pip_size: 0.01 }] } },
      { log: 2, catalog: { ...catalog, entries: [{ ...ENTRY, exchange_is_open: 2 }] } },
      { log: 2, catalog: { ...catalog, entries: [{ ...ENTRY, underlying_symbol: '' }] } },
      { log: 2, catalog: { ...catalog, extra: 1 } },
      { log: 2, catalog: null, extra: 1 },
    ];
    for (const sample of invalidCatalogs) {
      expect(dataCatalogSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(false);
      expect(readDataCatalog(sample), JSON.stringify(sample)).toBeNull();
    }
  });

  /** Un generador de números al azar con semilla: las mismas mutaciones en cada ejecución. */
  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const POOL: unknown[] = [
    null,
    0,
    -1,
    1,
    1.5,
    3,
    HOUR_MS,
    24 * HOUR_MS + 1,
    '',
    'x',
    'R_100',
    true,
    [],
    {},
    FROM,
    TO,
    at(30),
    '2026-11-08T11:00:00Z',
    '1234.56',
    '1e3',
    'connection_lost',
    'capture_stopped',
    'recovered',
    'partial',
    'unavailable',
    'pending',
    'not_requested',
    'history_timeout',
    'c'.repeat(64),
  ];

  /** Cambia una cosa al azar: borra, añade o reemplaza un campo, o reordena una lista. */
  function mutate(value: unknown, random: () => number): unknown {
    const copy = structuredClone(value);
    const holders: (Record<string, unknown> | unknown[])[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        holders.push(node);
        node.forEach(walk);
      } else if (typeof node === 'object' && node !== null) {
        holders.push(node as Record<string, unknown>);
        Object.values(node).forEach(walk);
      }
    };
    walk(copy);
    const holder = holders[Math.floor(random() * holders.length)];
    const pick = POOL[Math.floor(random() * POOL.length)];
    if (holder === undefined) {
      return pick;
    }
    if (Array.isArray(holder)) {
      const choice = random();
      if (holder.length > 0 && choice < 0.3) {
        holder.splice(Math.floor(random() * holder.length), 1);
      } else if (holder.length > 0 && choice < 0.6) {
        holder.push(structuredClone(holder[Math.floor(random() * holder.length)]));
      } else if (choice < 0.8) {
        holder.reverse();
      } else {
        holder[Math.floor(random() * Math.max(holder.length, 1))] = pick;
      }
      return copy;
    }
    const keys = Object.keys(holder);
    const choice = random();
    const key = keys[Math.floor(random() * keys.length)];
    if (key !== undefined && choice < 0.2) {
      Reflect.deleteProperty(holder, key);
    } else if (choice < 0.3) {
      holder.extra = pick;
    } else if (key !== undefined) {
      holder[key] = pick;
    }
    return copy;
  }

  it('da lo mismo que los esquemas en miles de respuestas cambiadas al azar', () => {
    const random = seeded(97);
    let accepted = 0;
    for (let round = 0; round < 4000; round += 1) {
      const base = chartSamples[round % chartSamples.length];
      const value = mutate(round % 7 === 0 ? mutate(base, random) : base, random);
      const expected = dataChartSchema.safeParse(value).success;
      expect(readDataChart(value) !== null, JSON.stringify(value)).toBe(expected);
      accepted += expected ? 1 : 0;
    }
    for (let round = 0; round < 2000; round += 1) {
      const base = catalogSamples[round % catalogSamples.length];
      const value = mutate(base, random);
      expect(readDataCatalog(value) !== null, JSON.stringify(value)).toBe(
        dataCatalogSchema.safeParse(value).success,
      );
    }
    // Las mutaciones no son todas inválidas: también prueban lo que se acepta.
    expect(accepted).toBeGreaterThan(100);
  });

  it('con las horas pedidas, rechaza una ventana de otro largo', () => {
    expect(readDataChart(CHART, 1)).toEqual(CHART);
    expect(readDataChart(CHART, 6)).toBeNull();
  });
});

const ticks = ticksOf(CHART);
const gaps = gapsOf(CHART);

describe('los ticks, la línea y los huecos, en su hora', () => {
  it('cada tick en su hora de fuente, con su cotización exacta', () => {
    expect(ticks.map((tick) => [new Date(tick.timeMs).toISOString(), tick.quote])).toEqual([
      [at(0), '1234.56'],
      [at(2), '1234.60'],
      [at(4), '1234.58'],
      [at(60), '1233.10'],
      [at(62), '1233.12'],
      [at(70), '1235.00'],
    ]);
    expect(gaps.map((gap) => gap.toMs === null)).toEqual([false, false, true]);
  });

  it('la línea se corta solo donde empieza un hueco del log, nunca por la distancia entre dos ticks', () => {
    const scale = timeScaleFor(FROM_MS, TO_MS, [0, 10]);
    if (scale === null) {
      throw new Error('sin escala');
    }
    const tick = (seconds: number, value: number): ChartTick => ({
      quote: String(value),
      timeMs: FROM_MS + seconds * 1000,
      value,
    });
    const point = (seconds: number, value: number) =>
      `${scale.x(FROM_MS + seconds * 1000).toFixed(2)} ${scale.y(value).toFixed(2)}`;
    const far = [tick(0, 1), tick(1800, 2)];
    // Media hora entre dos ticks, sin un hueco del log: la línea los une.
    expect(tickPath(far, [], scale)).toBe(`M${point(0, 1)}L${point(1800, 2)}`);
    const lost: ChartGapRange = {
      cause: 'connection_lost',
      fromMs: FROM_MS + 1001,
      history: 'pending',
      reason: null,
      recoveredTicks: null,
      toMs: FROM_MS + 1_799_999,
    };
    expect(tickPath(far, [lost], scale)).toBe(
      `M${point(0, 1)}L${point(0, 1)}M${point(1800, 2)}L${point(1800, 2)}`,
    );
    const three = [tick(0, 1), tick(2, 2), tick(4, 3)];
    const after = { ...lost, fromMs: FROM_MS + 2001, toMs: FROM_MS + 3999 };
    expect(tickPath(three, [after], scale)).toBe(
      `M${point(0, 1)}L${point(2, 2)}M${point(4, 3)}L${point(4, 3)}`,
    );
  });

  it('la banda de un hueco se recorta a la ventana, y la de uno que sigue llega a su final', () => {
    const scale = timeScaleFor(FROM_MS, TO_MS, [1]);
    if (scale === null) {
      throw new Error('sin escala');
    }
    const early: ChartGapRange = {
      cause: 'connection_lost',
      fromMs: FROM_MS - 600_000,
      history: 'recovered',
      reason: null,
      recoveredTicks: 2,
      toMs: FROM_MS + 360_000,
    };
    expect(gapBandOf(early, FROM_MS, TO_MS, scale)).toEqual({ width: 100, x: 0 });
    const open = { ...early, fromMs: TO_MS - 360_000, toMs: null };
    const band = gapBandOf(open, FROM_MS, TO_MS, scale);
    expect(band.x).toBeCloseTo(900);
    expect(band.width).toBeCloseTo(100);
  });

  it('la alternativa en texto: período, ticks, el primero y el último, los extremos exactos y cada hueco', () => {
    const text = describeTickChart({ fromMs: FROM_MS, gaps, ticks, title: 'Precio', toMs: TO_MS });
    expect(text).toBe(
      `Precio, del ${formatUtc(FROM)} al ${formatUtc(TO)}: 6 ticks, el primero a 1234.56 y el último a 1235.00, entre 1233.10 y 1235.00. 3 huecos: del ${formatUtc(at(4, 1))} al ${formatUtc(at(59, 999))}: Captura parada, como en un despliegue o un reinicio. No se recupera. del ${formatUtc(at(62, 1))} al ${formatUtc(at(69, 999))}: Conexión perdida. La historia la recuperó con 4 ticks, que todavía no se dibujan. desde el ${formatUtc(at(70, 1))}, y sigue: Conexión perdida. La historia todavía no llegó.`,
    );
    expect(
      describeTickChart({ fromMs: FROM_MS, gaps: [], ticks: [], title: 'Precio', toMs: TO_MS }),
    ).toBe(`Precio, del ${formatUtc(FROM)} al ${formatUtc(TO)}: no llegó ningún tick. Sin huecos.`);
  });

  it('lo que dice cada hueco y la calidad de la ventana', () => {
    const base: ChartGapRange = {
      cause: 'connection_lost',
      fromMs: FROM_MS,
      history: 'partial',
      reason: 'history_page_limit',
      recoveredTicks: 3,
      toMs: FROM_MS + 1000,
    };
    expect(gapCauseText(base)).toBe(
      'Conexión perdida. La historia trajo 3 ticks, pero no la cubre entera (history_page_limit).',
    );
    expect(
      gapCauseText({
        ...base,
        history: 'unavailable',
        reason: 'history_timeout',
        recoveredTicks: null,
      }),
    ).toBe('Conexión perdida. La historia no la pudo recuperar (history_timeout).');
    expect(qualityText([])).toBe('Sin huecos');
    expect(qualityText([base])).toBe('1 hueco sin recuperar');
    expect(qualityText(gaps)).toBe('3 huecos, 2 sin recuperar');
    expect(qualityText([{ ...base, history: 'recovered', reason: null }])).toBe(
      '1 hueco recuperado',
    );
  });
});

describe('las velas (concepto de interfaz §9)', () => {
  it('el intervalo: el menor con el que la ventana dura como mucho 120', () => {
    expect([1, 2, 3, 10, 11, 24, 30, 31].map((hours) => candleMinutes(hours * HOUR_MS))).toEqual([
      1, 1, 5, 5, 15, 15, 15, 60,
    ]);
  });

  it('cada vela resume su intervalo alineado en UTC, y la que toca un hueco lo lleva', () => {
    const candles = candlesOf(ticks, gaps, 1);
    expect(
      candles.map((candle) => ({
        close: candle.close.quote,
        gaps: candle.gaps.map((gap) => gap.cause + ':' + gap.history),
        high: candle.high.quote,
        low: candle.low.quote,
        open: candle.open.quote,
        start: new Date(candle.startMs).toISOString(),
        ticks: candle.ticks,
      })),
    ).toEqual([
      {
        close: '1234.58',
        gaps: ['capture_stopped:not_requested'],
        high: '1234.60',
        low: '1234.56',
        open: '1234.56',
        start: at(0),
        ticks: 3,
      },
      {
        close: '1235.00',
        gaps: ['connection_lost:recovered', 'connection_lost:pending'],
        high: '1235.00',
        low: '1233.10',
        open: '1233.10',
        start: at(60),
        ticks: 3,
      },
    ]);
    // Un intervalo sin ticks no tiene vela: con velas de 5 minutos, los seis ticks son una sola.
    expect(candlesOf(ticks, [], 5).map((candle) => [candle.ticks, candle.gaps.length])).toEqual([
      [6, 0],
    ]);
  });
});

const RECEIVED_MS = Date.parse('2026-11-08T12:00:03.000Z');

function ready<T>(data: T, refreshFailure: ApiFailure | null = null): Load<T> {
  return {
    checkedAtMs: RECEIVED_MS,
    data,
    kind: 'ready',
    receivedAtMs: RECEIVED_MS,
    refreshFailure,
  };
}

function render(
  chart: Load<DataChart>,
  catalog: Load<DataCatalog> = LOADING,
  kind: ChartKind = 'ticks',
  hours: ChartHours = 1,
): string {
  const state: MercadosState = { catalog, chart, hours };
  return renderToStaticMarkup(
    <MercadosView state={state} kind={kind} onHours={() => undefined} onKind={() => undefined} />,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const decode = (value: string) =>
  value.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');

describe('la vista de Mercados', () => {
  it('cargando: esqueletos, la ventana elegida y ningún dato ficticio', () => {
    const html = render(LOADING);
    expect(text(html)).toContain('Cargando el gráfico de R_100');
    expect(text(html)).toContain('Cargando el catálogo de Deriv');
    expect(text(html)).toContain('Última hora · se actualiza sola cada minuto');
    expect(html).toMatch(/aria-pressed="true"[^>]*>1\u00a0h</u);
    expect(text(html)).not.toMatch(/ficticio|ejemplo|Vantage|Deriv MT5/u);
  });

  it('con la ventana de 24 horas, se actualiza cada 5 minutos', () => {
    expect(text(render(LOADING, LOADING, 'ticks', 24))).toContain(
      'Últimas 24 horas · se actualiza sola cada 5 minutos',
    );
  });

  it('sin sesión: el error con su texto fijo y el enlace para entrar', () => {
    const html = render({ failure: { code: 'unauthenticated' }, kind: 'failed' });
    expect(text(html)).toContain('No se pudo leer el gráfico');
    expect(html).toContain('href="/acceso"');
  });

  it('el gráfico de ticks: su alternativa, los metadatos, la calidad y la lista de huecos', () => {
    const html = render(ready(CHART));
    const label = /role="img" aria-label="([^"]*)"/u.exec(html)?.[1];
    expect(label === undefined ? undefined : decode(label)).toBe(
      describeTickChart({
        fromMs: FROM_MS,
        gaps,
        ticks,
        title: 'Precio de Volatility 100 (R_100)',
        toMs: TO_MS,
      }),
    );
    const plain = text(html);
    for (const fragment of [
      'Símbolo R_100',
      'Fuente Deriv · WebSocket público',
      'Zona horaria UTC',
      'Intervalo Cada tick, en su hora de fuente',
      `Período Del ${formatUtc(FROM)} al ${formatUtc(TO)}`,
      'Frescura Último tick a las 11:01:10 UTC; leído a las 12:00:03 UTC',
      'Calidad 3 huecos, 2 sin recuperar',
      'Log activo Log 2',
      'Captura parada',
      'Conexión perdida, recuperada',
      'Conexión perdida, pendiente',
    ]) {
      expect(plain).toContain(fragment);
    }
    expect(html).toContain('stroke="var(--b-chart-gap)"');
  });

  it('las velas: el dibujo oculto y su tabla, con las incompletas marcadas', () => {
    const html = render(ready(CHART), LOADING, 'candles');
    expect(html).toContain('class="w-chart" aria-hidden="true"');
    const rows = html.match(/<tr>/gu) ?? [];
    // La cabecera y dos velas.
    expect(rows).toHaveLength(3);
    const plain = text(html);
    expect(plain).toContain('Velas de 1 minuto');
    expect(plain).toContain(`velas de 1 minuto, del ${formatUtc(FROM)} al ${formatUtc(TO)}`);
    expect(plain).toContain('Incompleta: Captura parada');
    expect(plain).toContain(
      'Incompleta: Conexión perdida, recuperada, Conexión perdida, pendiente',
    );
  });

  it('sin log activo, sin ticks y con el log empezado dentro de la ventana', () => {
    expect(text(render(ready(EMPTY)))).toContain(
      'Todavía no hay ningún log de captura activo, así que no hay datos que dibujar.',
    );
    const stopped: DataChart = {
      ...EMPTY,
      log: 3,
      log_started_at_utc: at(600),
      gaps: [
        {
          from_utc: at(601),
          to_utc: null,
          cause: 'capture_stopped',
          history: 'not_requested',
          reason: null,
          recovered_ticks: null,
        },
      ],
    };
    const plain = text(render(ready(stopped)));
    expect(plain).toContain('no llegó ningún tick');
    expect(plain).toContain(`desde el ${formatUtc(at(601))}, y sigue`);
    expect(plain).toContain(`El log 3 empezó el ${formatUtc(at(600))}`);
  });

  it('una actualización fallida conserva lo anterior y lo dice', () => {
    const plain = text(render(ready(CHART, { code: 'storage_unavailable' })));
    expect(plain).toContain('No se pudo actualizar');
    expect(plain).toContain('El almacenamiento de los datos no responde ahora mismo.');
    expect(plain).toContain('Lo que ves es de la lectura de las 12:00:03 UTC.');
  });

  it('el catálogo: su versión, su fecha, sus instrumentos y el que se captura', () => {
    const html = render(LOADING, ready(CATALOG));
    const plain = text(html);
    expect(plain).toContain('Versión 3, del log 2');
    expect(plain).toContain(`Recibida ${formatUtc('2026-11-08T00:00:02.500Z')}`);
    expect(plain).toContain('Instrumentos 3');
    expect(plain).toContain('R_100 Se captura');
    expect(plain).toContain('EUR/USD');
    expect(plain).toContain('Cerrado');
    expect(text(render(LOADING, ready({ log: 2, catalog: null })))).toContain(
      'El log 2 todavía no tiene ninguna versión del catálogo',
    );
    expect(text(render(LOADING, ready({ log: null, catalog: null })))).toContain('no hay catálogo');
  });

  it('Mercados ya no lleva la marca de datos ficticios en la web servida por la API', () => {
    expect(showsFictitiousDataInApi('/mercados/')).toBe(false);
    expect(showsFictitiousDataInApi('/mercados')).toBe(false);
  });
});

/** Un almacén con su reloj, sus temporizadores, la visibilidad y las respuestas que da la prueba. */
function fakeStore() {
  let nowMs = RECEIVED_MS;
  let handle = 0;
  let visible = true;
  let onVisible: (() => void) | null = null;
  const charts: {
    readonly hours: ChartHours;
    readonly settle: (value: DataChart | Error) => void;
  }[] = [];
  const catalogs: ((value: DataCatalog | Error) => void)[] = [];
  const timers = new Map<number, { readonly callback: () => void; readonly ms: number }>();
  const pending = <T,>(push: (settle: (value: T | Error) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      push((value) => {
        if (value instanceof Error) {
          reject(value);
        } else {
          resolve(value);
        }
      });
    });
  const deps: MercadosStoreDeps = {
    fetchChart: (hours) =>
      pending<DataChart>((settle) => {
        charts.push({ hours, settle });
      }),
    fetchCatalog: () =>
      pending<DataCatalog>((settle) => {
        catalogs.push(settle);
      }),
    now: () => nowMs,
    setTimer: (callback, ms) => {
      handle += 1;
      timers.set(handle, { callback, ms });
      return handle;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    visible: () => visible,
    watchVisibility: (listener) => {
      onVisible = listener;
      return () => {
        onVisible = null;
      };
    },
  };
  return {
    catalogs,
    charts,
    store: createMercadosStore(deps),
    timers,
    elapse: (ms: number) => {
      nowMs += ms;
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) {
        timer.callback();
      }
    },
    setVisible: (value: boolean) => {
      visible = value;
      if (value) {
        onVisible?.();
      }
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('el almacén de Mercados', () => {
  it('lee el gráfico y el catálogo al abrir, y el gráfico otra vez según la ventana', async () => {
    const fake = fakeStore();
    const stop = fake.store.subscribe(() => undefined);
    expect(fake.charts.map((call) => call.hours)).toEqual([1]);
    expect(fake.catalogs).toHaveLength(1);
    fake.charts[0]?.settle(CHART);
    fake.catalogs[0]?.(CATALOG);
    await flush();
    expect(fake.store.snapshot().chart).toMatchObject({ data: CHART, kind: 'ready' });
    expect(fake.store.snapshot().catalog).toMatchObject({ data: CATALOG, kind: 'ready' });
    expect([...fake.timers.values()].map((timer) => timer.ms)).toEqual([CHART_REFRESH_MS[1]]);
    fake.elapse(CHART_REFRESH_MS[1]);
    expect(fake.charts).toHaveLength(2);
    // El catálogo no se vuelve a leer hasta que pasan sus 30 minutos.
    expect(fake.catalogs).toHaveLength(1);
    fake.charts[1]?.settle(CHART);
    await flush();
    fake.store.setHours(24);
    expect(fake.store.snapshot()).toMatchObject({ chart: LOADING, hours: 24 });
    expect(fake.charts.at(-1)?.hours).toBe(24);
    fake.charts.at(-1)?.settle(CHART);
    await flush();
    expect([...fake.timers.values()].map((timer) => timer.ms)).toEqual([CHART_REFRESH_MS[24]]);
    fake.elapse(CATALOG_REFRESH_MS);
    expect(fake.catalogs).toHaveLength(2);
    stop();
    expect(fake.timers.size).toBe(0);
  });

  it('una respuesta de la ventana anterior no se muestra', async () => {
    const fake = fakeStore();
    fake.store.subscribe(() => undefined);
    fake.store.setHours(6);
    expect(fake.charts.map((call) => call.hours)).toEqual([1, 6]);
    fake.charts[0]?.settle(CHART);
    await flush();
    expect(fake.store.snapshot().chart).toEqual(LOADING);
    // Ni programa la lectura siguiente: la de la ventana nueva sigue en curso.
    expect(fake.timers.size).toBe(0);
    const six = { ...CHART, from_utc: '2026-11-08T06:00:00.000Z' };
    fake.charts[1]?.settle(six);
    await flush();
    expect(fake.store.snapshot().chart).toMatchObject({ data: six, kind: 'ready' });
    expect([...fake.timers.values()].map((timer) => timer.ms)).toEqual([CHART_REFRESH_MS[6]]);
  });

  it('con la pestaña oculta no lee, y al volver a ella lee en el acto', async () => {
    const fake = fakeStore();
    fake.store.subscribe(() => undefined);
    fake.charts[0]?.settle(CHART);
    await flush();
    fake.setVisible(false);
    fake.elapse(CHART_REFRESH_MS[1]);
    expect(fake.charts).toHaveLength(1);
    fake.setVisible(true);
    expect(fake.charts).toHaveLength(2);
  });

  it('un fallo conserva lo anterior, salvo sin sesión, y el catálogo fallido se vuelve a pedir', async () => {
    const fake = fakeStore();
    fake.store.subscribe(() => undefined);
    fake.charts[0]?.settle(CHART);
    fake.catalogs[0]?.(new Error('sin red'));
    await flush();
    expect(fake.store.snapshot().catalog).toEqual({
      failure: { code: 'unexpected' },
      kind: 'failed',
    });
    fake.elapse(CHART_REFRESH_MS[1]);
    expect(fake.catalogs).toHaveLength(2);
    fake.charts[1]?.settle(new Error('sin red'));
    await flush();
    expect(fake.store.snapshot().chart).toMatchObject({
      data: CHART,
      kind: 'ready',
      refreshFailure: { code: 'unexpected' },
    });
    const { ApiCallError } = await import('../src/components/auth/api');
    fake.elapse(CHART_REFRESH_MS[1]);
    fake.charts[2]?.settle(new ApiCallError({ code: 'unauthenticated' }));
    await flush();
    expect(fake.store.snapshot().chart).toEqual({
      failure: { code: 'unauthenticated' },
      kind: 'failed',
    });
  });
});

describe('las lecturas de la API, sin el token CSRF', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown) {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return requests;
  }

  it('el gráfico: GET con las horas, mismo origen, sin cuerpo ni token', async () => {
    const requests = stubFetch(200, CHART);
    await expect(api.dataChart(1)).resolves.toEqual(CHART);
    expect(requests[0]?.path).toBe('/api/v1/datos/grafico?hours=1');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/iu);
    expect(requests[0]?.init?.body).toBeUndefined();
    // La respuesta de otra ventana, o sin la forma del contrato, es «unexpected».
    await expect(api.dataChart(6)).rejects.toMatchObject({ failure: { code: 'unexpected' } });
    stubFetch(200, { ...CHART, log: 'dos' });
    await expect(api.dataChart(1)).rejects.toMatchObject({ failure: { code: 'unexpected' } });
  });

  it('el catálogo: GET sin token, y un error con su código', async () => {
    const requests = stubFetch(200, CATALOG);
    await expect(api.dataCatalog()).resolves.toEqual(CATALOG);
    expect(requests[0]?.path).toBe('/api/v1/datos/catalogo');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/iu);
    stubFetch(503, {
      error: { code: 'storage_unavailable', request_id: '7c2a4f9e-1f5b-4c3d-9a8e-2b6d0f1e3a5c' },
    });
    await expect(api.dataCatalog()).rejects.toMatchObject({
      failure: { code: 'storage_unavailable' },
    });
  });
});
