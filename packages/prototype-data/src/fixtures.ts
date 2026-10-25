/**
 * Datos ficticios del prototipo (ADR-0008 §2). Están fijados aquí: no se generan al azar,
 * no se leen relojes reales y no representan resultados de ninguna estrategia real.
 *
 * La historia que cuentan, al 20 oct 2026, 14:32:05 UTC:
 * - Deriv perdió la conexión a las 14:29:59 y volvió a las 14:30:11. La historia recuperó los
 *   ticks de R_75 y 1HZ100V, pero no los de R_100: queda un hueco sin resolver y Deriv está
 *   `degraded`, igual que la salud global (contratos de dominio, «Salud derivada»).
 * - «Impulso de tres ticks v1» opera sobre R_100 y se pausó sola al abrirse el hueco.
 * - «Ruptura de rango v2» opera sobre R_75, pasó su validación y está en shadow desde su aprobación.
 * - «Retorno a la media corta v3» falló fuera de muestra y está retirada: es el ejemplo honesto
 *   del laboratorio.
 */
import type {
  ExecutionMode,
  QualityIncidentType,
  ServiceHealth,
  StrategyLifecycle,
} from '@buoh/contracts';
import type { IconName, PerformanceContext, Severity, Tone } from '@buoh/design-system';

/** Espacio que no se corta entre un número y su unidad. */
const NB = '\u00a0';

/** Instante de referencia de toda la demostración. */
export const DEMO_NOW_UTC = '2026-10-20T14:32:05.000Z';

export interface SourceStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly phase: string;
  readonly health: ServiceHealth;
  readonly lastDataUtc: string;
  readonly note: string;
}

export const SOURCES: readonly SourceStatus[] = [
  {
    id: 'deriv',
    name: 'Deriv',
    kind: 'WebSocket público, sin credenciales',
    phase: '1',
    health: 'degraded',
    lastDataUtc: '2026-10-20T14:32:04.000Z',
    note: 'Hueco sin resolver en R_100 desde las 14:30:12. R_75 y 1HZ100V se recuperaron con la historia.',
  },
  {
    id: 'deriv-mt5',
    name: 'Deriv MT5',
    kind: 'Puente MQL5 en la terminal, contraseña de inversor',
    phase: '1B',
    health: 'healthy',
    lastDataUtc: '2026-10-20T14:32:04.000Z',
    note: 'Puente conectado al servidor demo. Precios de compra y venta.',
  },
  {
    id: 'vantage',
    name: 'Vantage',
    kind: 'Puente MQL5 en la terminal, contraseña de inversor',
    phase: '1B',
    health: 'healthy',
    lastDataUtc: '2026-10-20T14:32:04.000Z',
    note: 'Puente conectado al servidor demo. Mercado de forex abierto.',
  },
];

/**
 * Salud global. Supuesto del prototipo: es la más severa de sus fuentes. El contrato («Salud derivada»)
 * solo define la salud de cada fuente; la regla global se fijará cuando exista el reporte (F1.5).
 */
export const GLOBAL_STATUS: { readonly mode: ExecutionMode; readonly health: ServiceHealth } = {
  mode: 'shadow',
  health: 'degraded',
};

/** R_100 avanza un tick cada 2 s; la serie cubre los últimos 3 minutos. */
export const R100_TICK_SECONDS = 2;
export const R100_SERIES_START_UTC = '2026-10-20T14:29:06.000Z';
const R100_TICKS = 90;

/** Hora UTC del tick `index` de la serie de R_100. */
export function r100TickTimeUtc(index: number): string {
  return new Date(
    Date.parse(R100_SERIES_START_UTC) + index * R100_TICK_SECONDS * 1000,
  ).toISOString();
}

/** Ticks que faltan: índices `start` a `end - 1` (14:30:00 a 14:30:10). */
export const PRICE_GAPS: readonly {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}[] = [{ start: 27, end: 33, label: `Hueco: 6 ticks (12${NB}s) · conexión perdida` }];

/** Serie de precios calculada con una fórmula fija (sin aleatoriedad). `null` marca un tick que falta. */
export function priceSeries(): readonly (number | null)[] {
  const values: (number | null)[] = [];
  for (let i = 0; i < R100_TICKS; i += 1) {
    const missing = PRICE_GAPS.some((gap) => i >= gap.start && i < gap.end);
    const value = 1040 + 3.1 * Math.sin(i / 5.5) + 1.4 * Math.sin(i / 1.65) + 0.024 * i;
    values.push(missing ? null : Math.round(value * 100) / 100);
  }
  return values;
}

export const PRICE_TIME_LABELS = [0, 30, 60, R100_TICKS - 1].map((index) => ({
  index,
  label: r100TickTimeUtc(index).slice(11, 19),
}));

const R100_LAST = priceSeries().at(-1) ?? 0;

export interface QualityBadge {
  readonly tone: 'aurora' | 'naranja';
  readonly label: string;
  readonly icon: IconName;
}

export interface Instrument {
  readonly symbol: string;
  readonly name: string;
  readonly source: string;
  readonly cadence: string;
  readonly lastPrice: string;
  readonly freshness: string;
  readonly schedule: string;
  readonly quality: QualityBadge;
}

const CLEAN: QualityBadge = { tone: 'aurora', label: 'Sin incidencias', icon: 'check' };

export const INSTRUMENTS: readonly Instrument[] = [
  {
    symbol: 'R_100',
    name: 'Volatility 100 Index (ejemplo)',
    source: 'Deriv',
    cadence: `1 tick cada 2${NB}s`,
    lastPrice: R100_LAST.toFixed(2),
    freshness: `hace 1${NB}s`,
    schedule: '24/7',
    quality: { tone: 'naranja', label: '1 hueco sin resolver', icon: 'gap' },
  },
  {
    symbol: 'R_75',
    name: 'Volatility 75 Index (ejemplo)',
    source: 'Deriv',
    cadence: `1 tick cada 2${NB}s`,
    lastPrice: '38214.5531',
    freshness: `hace 1${NB}s`,
    schedule: '24/7',
    quality: { tone: 'aurora', label: 'Recuperado con la historia', icon: 'check' },
  },
  {
    symbol: '1HZ100V',
    name: 'Volatility 100 (1s) Index (ejemplo)',
    source: 'Deriv',
    cadence: `1 tick por segundo`,
    lastPrice: '1689.04',
    freshness: `hace 1${NB}s`,
    schedule: '24/7',
    quality: { tone: 'aurora', label: 'Recuperado con la historia', icon: 'check' },
  },
  {
    symbol: 'Volatility 100 Index',
    name: 'Volatility 100 en MT5 (ejemplo)',
    source: 'Deriv MT5',
    cadence: 'compra y venta',
    lastPrice: `1042.91${NB}/ 1043.05`,
    freshness: `hace 1${NB}s`,
    schedule: '24/7',
    quality: CLEAN,
  },
  {
    symbol: 'EURUSD',
    name: 'Euro / Dólar (ejemplo)',
    source: 'Vantage',
    cadence: 'compra y venta',
    lastPrice: `1.08412${NB}/ 1.08419`,
    freshness: `hace 1${NB}s`,
    schedule: 'lun–vie',
    quality: CLEAN,
  },
];

export function instrumentsOf(sourceName: string): number {
  return INSTRUMENTS.filter((instrument) => instrument.source === sourceName).length;
}

/**
 * `abierta` y `resuelta` son condiciones (se abren y cierran con eventos);
 * `registrada` es una incidencia puntual, que no tiene cierre (contratos de dominio).
 */
export interface IncidentRow {
  readonly type: QualityIncidentType;
  readonly severity: Severity;
  readonly symbol: string;
  readonly source: string;
  readonly whenUtc: string;
  readonly status: 'abierta' | 'resuelta' | 'registrada';
  readonly detail: string;
}

export const INCIDENT_LABELS: Readonly<Record<QualityIncidentType, string>> = {
  invalid_source_frame: 'Frame inválido',
  duplicate_exact: 'Duplicado exacto',
  source_time_conflict: 'Conflicto de tiempo de fuente',
  out_of_order: 'Fuera de orden',
  delivery_delayed: 'Entrega retrasada',
  connection_lost: 'Conexión perdida',
  event_gap_unresolved: 'Hueco sin resolver',
  persistence_unavailable: 'Persistencia no disponible',
  source_limit_exceeded: 'Límite de fuente superado',
};

export const INCIDENT_STATUS: Readonly<
  Record<IncidentRow['status'], { tone: 'naranja' | 'niebla'; label: string; icon: IconName }>
> = {
  abierta: { tone: 'naranja', label: 'Abierta', icon: 'alertTriangle' },
  resuelta: { tone: 'niebla', label: 'Resuelta', icon: 'check' },
  registrada: { tone: 'niebla', label: 'Registrada', icon: 'book' },
};

export const INCIDENTS: readonly IncidentRow[] = [
  {
    type: 'event_gap_unresolved',
    severity: 'error',
    symbol: 'R_100',
    source: 'Deriv',
    whenUtc: '2026-10-20T14:30:12.000Z',
    status: 'abierta',
    detail: `Faltan 6 ticks (14:30:00 a 14:30:10) que la historia no pudo recuperar.`,
  },
  {
    type: 'connection_lost',
    severity: 'warning',
    symbol: 'toda la conexión',
    source: 'Deriv',
    whenUtc: '2026-10-20T14:29:59.000Z',
    status: 'resuelta',
    detail: 'Cerrada por el servidor; reconexión a las 14:30:11 tras 3 intentos.',
  },
  {
    type: 'delivery_delayed',
    severity: 'warning',
    symbol: '1HZ100V',
    source: 'Deriv',
    whenUtc: '2026-10-20T13:02:40.000Z',
    status: 'registrada',
    detail: `Tick recibido 2,4${NB}s después de su hora de fuente.`,
  },
  {
    type: 'invalid_source_frame',
    severity: 'error',
    symbol: 'sin símbolo',
    source: 'Deriv',
    whenUtc: '2026-10-20T11:47:03.000Z',
    status: 'registrada',
    detail: 'JSON incompleto; el frame crudo se conserva.',
  },
];

export interface DatasetRow {
  readonly id: string;
  readonly source: string;
  readonly period: string;
  readonly ticks: string;
  readonly incidents: number;
  readonly rules: string;
  readonly verified: boolean;
}

/** Deriv: R_100 y R_75 dan 43 200 ticks al día y 1HZ100V 86 400 (172 800 en total). */
export const DATASETS: readonly DatasetRow[] = [
  {
    id: 'sha256:6f2c…a91d',
    source: 'Deriv',
    period: `19 oct 2026, 00:00 – 24:00${NB}UTC`,
    ticks: `172${NB}788`,
    incidents: 2,
    rules: '2.0.0',
    verified: true,
  },
  {
    id: 'sha256:b07e…44c2',
    source: 'Deriv',
    period: `18 oct 2026, 00:00 – 24:00${NB}UTC`,
    ticks: `172${NB}800`,
    incidents: 0,
    rules: '2.0.0',
    verified: true,
  },
  {
    id: 'sha256:19aa…e310',
    source: 'Deriv',
    period: `17 oct 2026, 00:00 – 24:00${NB}UTC`,
    ticks: `172${NB}731`,
    incidents: 4,
    rules: '2.0.0',
    verified: false,
  },
];

export interface StrategyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly lifecycle: StrategyLifecycle;
  readonly symbol: string;
  readonly hypothesis: string;
  /** Registro de la hipótesis, antes de ver cualquier tramo de prueba. */
  readonly registeredUtc: string;
  /** Aprobación para shadow; `null` si nunca pasó la validación. */
  readonly approvedForShadowUtc: string | null;
  /** Pausa automática, si la hubo. */
  readonly pausedUtc?: string;
  readonly note: string;
}

export const STRATEGIES: readonly StrategyRow[] = [
  {
    id: 'ruptura-v2',
    name: 'Ruptura de rango',
    version: 'v2',
    lifecycle: 'active',
    symbol: 'R_75',
    hypothesis: `Una salida del rango de 60${NB}s continúa durante los siguientes 10 ticks.`,
    registeredUtc: '2026-06-28T10:00:00.000Z',
    approvedForShadowUtc: '2026-10-16T09:00:00.000Z',
    note: 'En shadow desde su aprobación.',
  },
  {
    id: 'impulso-v1',
    name: 'Impulso de tres ticks',
    version: 'v1',
    lifecycle: 'paused',
    symbol: 'R_100',
    hypothesis: 'Tras tres ticks en la misma dirección, el cuarto sigue esa dirección.',
    registeredUtc: '2026-06-28T10:00:00.000Z',
    approvedForShadowUtc: '2026-10-16T09:00:00.000Z',
    pausedUtc: '2026-10-20T14:30:12.000Z',
    note: 'En pausa automática desde las 14:30:12 por datos degradados en R_100.',
  },
  {
    id: 'retorno-v3',
    name: 'Retorno a la media corta',
    version: 'v3',
    lifecycle: 'retired',
    symbol: 'R_100',
    hypothesis:
      'Tras tres ticks en la misma dirección, el siguiente revierte más de la mitad de las veces.',
    registeredUtc: '2026-06-28T10:00:00.000Z',
    approvedForShadowUtc: null,
    note: 'Retirada: perdió en la prueba fuera de muestra.',
  },
];

export const LIFECYCLE_PRESENTATION: Readonly<
  Record<StrategyLifecycle, { label: string; tone: 'niebla' | 'cielo' | 'aurora'; icon: IconName }>
> = {
  draft: { label: 'Borrador', tone: 'niebla', icon: 'layers' },
  reviewed: { label: 'Revisada', tone: 'cielo', icon: 'eye' },
  active: { label: 'Activa', tone: 'aurora', icon: 'radar' },
  paused: { label: 'En pausa', tone: 'niebla', icon: 'pauseCircle' },
  retired: { label: 'Retirada', tone: 'niebla', icon: 'archive' },
};

export interface SampleSplit {
  readonly name: string;
  readonly period: string;
  readonly sample: string;
  readonly result: string;
  readonly losses: string;
  readonly drawdown: string;
}

/** Ejemplo honesto: la ventaja de entrenamiento se reduce y se pierde fuera de muestra. */
export const BACKTEST_SPLITS: readonly SampleSplit[] = [
  {
    name: 'Entrenamiento',
    period: '1 jul – 31 ago 2026',
    sample: `4${NB}210 operaciones`,
    result: `+3,2${NB}%`,
    losses: `1${NB}978 (47,0${NB}%)`,
    drawdown: `−2,1${NB}%`,
  },
  {
    name: 'Validación',
    period: '1 – 30 sep 2026',
    sample: `1${NB}980 operaciones`,
    result: `+0,9${NB}%`,
    losses: `951 (48,0${NB}%)`,
    drawdown: `−2,8${NB}%`,
  },
  {
    name: 'Prueba fuera de muestra',
    period: '1 – 15 oct 2026',
    sample: `1${NB}015 operaciones`,
    result: `−0,4${NB}% (pérdida)`,
    losses: `493 (48,6${NB}%)`,
    drawdown: `−3,6${NB}%`,
  },
];

const BACKTEST_COSTS = `Pago de Deriv y 300${NB}ms de latencia supuestos`;
const BACKTEST_LIMITS =
  'Datos de un solo índice sintético; sin efecto de slippage; resultados pasados no anticipan resultados futuros.';

/** Contexto común de la tabla de tramos: origen, costes, versión y limitaciones. */
export const SPLITS_CONTEXT = {
  source: 'backtest',
  costs: BACKTEST_COSTS,
  version: 'Retorno a la media corta v3',
  limitations: BACKTEST_LIMITS,
} as const;

export const BACKTEST_CONTEXT: PerformanceContext = {
  source: 'backtest',
  period: '1 – 15 oct 2026 (fuera de muestra)',
  sample: `1${NB}015 operaciones hipotéticas`,
  costs: BACKTEST_COSTS,
  losses: `493 operaciones perdedoras (48,6${NB}%)`,
  drawdown: `−3,6${NB}%`,
  version: 'Retorno a la media corta v3',
  limitations: BACKTEST_LIMITS,
};

export interface ValidationSummary {
  readonly strategyId: string;
  readonly version: string;
  readonly window: string;
  /** Fin del tramo fuera de muestra: la aprobación nunca es anterior. */
  readonly windowEndUtc: string;
  readonly sample: string;
  readonly result: string;
  readonly losses: string;
  readonly drawdown: string;
}

/** Resumen fuera de muestra de las estrategias aprobadas (mismos tramos y costes que el ejemplo). */
export const APPROVED_VALIDATION: readonly ValidationSummary[] = [
  {
    strategyId: 'ruptura-v2',
    version: 'Ruptura de rango v2',
    window: '1 – 15 oct 2026',
    windowEndUtc: '2026-10-15T23:59:59.000Z',
    sample: '412 operaciones',
    result: `+0,9${NB}%`,
    losses: `194 (47,1${NB}%)`,
    drawdown: `−1,6${NB}%`,
  },
  {
    strategyId: 'impulso-v1',
    version: 'Impulso de tres ticks v1',
    window: '1 – 15 oct 2026',
    windowEndUtc: '2026-10-15T23:59:59.000Z',
    sample: '980 operaciones',
    result: `+0,5${NB}%`,
    losses: `468 (47,8${NB}%)`,
    drawdown: `−2,2${NB}%`,
  },
];

/** Contexto completo de la validación que aprobó una estrategia (mismos costes y límites que el ejemplo). */
export function validationContextOf(row: ValidationSummary): PerformanceContext {
  return {
    source: SPLITS_CONTEXT.source,
    period: row.window,
    sample: row.sample,
    costs: SPLITS_CONTEXT.costs,
    losses: row.losses,
    drawdown: row.drawdown,
    version: row.version,
    limitations: SPLITS_CONTEXT.limitations,
  };
}

/** El período shadow empieza con la aprobación de la estrategia. */
export const SHADOW_PERIOD_START_UTC = '2026-10-16T09:00:00.000Z';

export const SHADOW_CONTEXT: PerformanceContext = {
  source: 'shadow',
  period: `16 oct, 09:00 – 20 oct, 14:32${NB}UTC`,
  sample: '148 señales hipotéticas',
  costs: 'Pago de Deriv supuesto; sin comisiones extra',
  losses: `77 señales perdedoras (52,0${NB}%)`,
  drawdown: `−1,2${NB}%`,
  version: 'Ruptura de rango v2',
  limitations: 'Ninguna orden se envió; cuatro días de muestra no bastan para sacar conclusiones.',
};

/** Resultado neto hipotético del período de `SHADOW_CONTEXT`: una pérdida pequeña. */
export const SHADOW_RESULT = `−0,3${NB}%`;

/**
 * Curva de resultado acumulado hipotético fuera de muestra (fórmula fija). Termina en −0,4 y su
 * peor caída es de 3,6 puntos, coherente con `BACKTEST_CONTEXT`.
 */
export function equitySeries(): readonly number[] {
  const values: number[] = [];
  for (let i = 0; i <= 120; i += 1) {
    values.push(
      Math.round((1 * Math.sin(i / 9) - 0.011 * i + 0.5 * Math.sin(i / 2.7)) * 100) / 100,
    );
  }
  return values;
}

export const EQUITY_TIME_LABELS = [
  { index: 0, label: '1 oct' },
  { index: 60, label: '8 oct' },
  { index: 120, label: '15 oct' },
];

export interface SignalRow {
  readonly id: string;
  readonly strategyId: string;
  readonly strategy: string;
  readonly version: string;
  readonly symbol: string;
  readonly condition: string;
  readonly direction: string;
  readonly issuedUtc: string;
  readonly expiresUtc: string;
  readonly mode: ExecutionMode;
  readonly quality: 'completa' | 'degradada';
  readonly status: 'vigente' | 'vencida' | 'descartada';
  readonly evidenceHref: string;
}

/** De la más reciente a la más antigua. */
export const SIGNALS: readonly SignalRow[] = [
  {
    id: 'sig-0201',
    strategyId: 'ruptura-v2',
    strategy: 'Ruptura de rango',
    version: 'v2',
    symbol: 'R_75',
    condition: `Salida del rango de 60${NB}s por arriba`,
    direction: 'Hipótesis: sigue subiendo durante los próximos 10 ticks',
    issuedUtc: '2026-10-20T14:31:58.000Z',
    expiresUtc: '2026-10-20T14:32:18.000Z',
    mode: 'shadow',
    quality: 'completa',
    status: 'vigente',
    evidenceHref: '/laboratorio/#evidencia-ruptura-v2',
  },
  {
    id: 'sig-0200',
    strategyId: 'impulso-v1',
    strategy: 'Impulso de tres ticks',
    version: 'v1',
    symbol: 'R_100',
    condition: 'Tres ticks seguidos al alza',
    direction: 'Hipótesis: el próximo tick también sube',
    issuedUtc: '2026-10-20T14:29:58.000Z',
    expiresUtc: '2026-10-20T14:30:00.000Z',
    mode: 'shadow',
    quality: 'completa',
    status: 'descartada',
    evidenceHref: '/datos/',
  },
  {
    id: 'sig-0199',
    strategyId: 'ruptura-v2',
    strategy: 'Ruptura de rango',
    version: 'v2',
    symbol: 'R_75',
    condition: `Salida del rango de 60${NB}s por abajo`,
    direction: 'Hipótesis: sigue bajando durante los próximos 10 ticks',
    issuedUtc: '2026-10-20T14:27:30.000Z',
    expiresUtc: '2026-10-20T14:27:50.000Z',
    mode: 'shadow',
    quality: 'completa',
    status: 'vencida',
    evidenceHref: '/laboratorio/#evidencia-ruptura-v2',
  },
];

/** Presentación del estado de una señal, igual en web y móvil. */
export const SIGNAL_STATUS: Readonly<
  Record<
    SignalRow['status'],
    { readonly tone: Tone; readonly label: string; readonly icon: IconName }
  >
> = {
  vigente: { tone: 'aurora', label: 'Vigente', icon: 'clock' },
  vencida: { tone: 'niebla', label: 'Vencida', icon: 'circleSlash' },
  descartada: { tone: 'naranja', label: 'Descartada: falta su tick de resultado', icon: 'gap' },
};

export interface AuditRow {
  readonly whenUtc: string;
  readonly actor: string;
  readonly event: string;
  readonly reference: string;
}

export const AUDIT: readonly AuditRow[] = [
  {
    whenUtc: '2026-10-20T14:30:12.000Z',
    actor: 'Sistema',
    event: 'Pausa automática: Impulso de tres ticks v1 (datos degradados en R_100)',
    reference: 'str-impulso-v1',
  },
  {
    whenUtc: '2026-10-20T14:30:12.000Z',
    actor: 'Sistema',
    event: 'Incidencia abierta: hueco sin resolver en R_100',
    reference: 'inc-7f31',
  },
  {
    whenUtc: '2026-10-20T00:04:12.000Z',
    actor: 'Sistema',
    event: 'Dataset publicado y verificado',
    reference: 'sha256:6f2c…a91d',
  },
  {
    whenUtc: '2026-10-16T09:00:00.000Z',
    actor: 'Propietario',
    event: 'Aprobadas para shadow: Ruptura de rango v2 e Impulso de tres ticks v1',
    reference: 'str-aprob-1016',
  },
  {
    whenUtc: '2026-10-16T08:40:00.000Z',
    actor: 'Propietario',
    event: 'Retirada: Retorno a la media corta v3 (perdió fuera de muestra)',
    reference: 'str-retorno-v3',
  },
];
