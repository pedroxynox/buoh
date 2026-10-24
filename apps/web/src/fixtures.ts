/**
 * Datos ficticios del prototipo (ADR-0008 §2). Están fijados aquí: no se generan al azar,
 * no se leen relojes reales y no representan resultados de ninguna estrategia real.
 */
import type {
  ExecutionMode,
  QualityIncidentType,
  ServiceHealth,
  StrategyLifecycle,
} from '@buoh/contracts';
import type { Severity } from '@buoh/design-system';
import type { PerformanceContext } from '@buoh/design-system/react';

/** Instante de referencia de toda la demostración. */
export const DEMO_NOW_UTC = '2026-10-20T14:32:05.000Z';

export const GLOBAL_STATUS: { readonly mode: ExecutionMode; readonly health: ServiceHealth } = {
  mode: 'shadow',
  health: 'healthy',
};

export interface SourceStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly phase: string;
  readonly health: ServiceHealth;
  readonly instruments: number;
  readonly lastDataUtc: string;
  readonly note: string;
}

export const SOURCES: readonly SourceStatus[] = [
  {
    id: 'deriv',
    name: 'Deriv',
    kind: 'WebSocket público, sin credenciales',
    phase: '1',
    health: 'healthy',
    instruments: 4,
    lastDataUtc: '2026-10-20T14:32:04.000Z',
    note: 'Catálogo versionado y ticks con frames crudos preservados.',
  },
  {
    id: 'deriv-mt5',
    name: 'Deriv MT5',
    kind: 'Puente MQL5 en la terminal, contraseña de inversor',
    phase: '1B',
    health: 'recovering',
    instruments: 3,
    lastDataUtc: '2026-10-20T14:31:22.000Z',
    note: 'Reconectando: se comprueba la continuidad antes de volver a saludable.',
  },
  {
    id: 'vantage',
    name: 'Vantage',
    kind: 'Puente MQL5 en la terminal, contraseña de inversor',
    phase: '1B',
    health: 'paused',
    instruments: 2,
    lastDataUtc: '2026-10-18T21:00:00.000Z',
    note: 'En pausa a pedido: mercado de forex cerrado el fin de semana.',
  },
];

export interface Instrument {
  readonly symbol: string;
  readonly name: string;
  readonly source: string;
  readonly cadence: string;
  readonly lastPrice: string;
  readonly freshness: string;
  readonly schedule: string;
  readonly quality: { readonly tone: 'aurora' | 'naranja' | 'rojo'; readonly label: string };
}

export const INSTRUMENTS: readonly Instrument[] = [
  {
    symbol: 'R_100',
    name: 'Volatility 100 Index (ejemplo)',
    source: 'Deriv',
    cadence: '1 tick/s',
    lastPrice: '1042.87',
    freshness: 'hace 1 s',
    schedule: '24/7',
    quality: { tone: 'naranja', label: '1 hueco' },
  },
  {
    symbol: 'R_75',
    name: 'Volatility 75 Index (ejemplo)',
    source: 'Deriv',
    cadence: '1 tick/s',
    lastPrice: '38214.5531',
    freshness: 'hace 1 s',
    schedule: '24/7',
    quality: { tone: 'aurora', label: 'Sin incidencias' },
  },
  {
    symbol: '1HZ100V',
    name: 'Volatility 100 (1s) Index (ejemplo)',
    source: 'Deriv',
    cadence: '1 tick/s',
    lastPrice: '1689.04',
    freshness: 'hace 2 s',
    schedule: '24/7',
    quality: { tone: 'aurora', label: 'Sin incidencias' },
  },
  {
    symbol: 'Volatility 100 Index',
    name: 'Volatility 100 en MT5 (ejemplo)',
    source: 'Deriv MT5',
    cadence: 'compra y venta',
    lastPrice: '1042.91 / 1043.05',
    freshness: 'hace 43 s',
    schedule: '24/7',
    quality: { tone: 'naranja', label: 'Reconectando' },
  },
  {
    symbol: 'EURUSD',
    name: 'Euro / Dólar (ejemplo)',
    source: 'Vantage',
    cadence: 'compra y venta',
    lastPrice: '1.08412 / 1.08419',
    freshness: 'hace 1 d 17 h',
    schedule: 'lun–vie',
    quality: { tone: 'rojo', label: 'Fuente en pausa' },
  },
];

/** Serie de precios calculada con una fórmula fija (sin aleatoriedad). `null` marca un hueco. */
export function priceSeries(): readonly (number | null)[] {
  const values: (number | null)[] = [];
  for (let i = 0; i < 180; i += 1) {
    const value = 1040 + 3.1 * Math.sin(i / 11) + 1.4 * Math.sin(i / 3.3) + 0.012 * i;
    values.push(i >= 118 && i < 131 ? null : Math.round(value * 100) / 100);
  }
  return values;
}

export const PRICE_GAPS = [{ start: 118, end: 131, label: 'Hueco de 13 s · conexión perdida' }];

export interface IncidentRow {
  readonly type: QualityIncidentType;
  readonly severity: Severity;
  readonly symbol: string;
  readonly source: string;
  readonly whenUtc: string;
  readonly status: 'abierta' | 'resuelta';
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

export const INCIDENTS: readonly IncidentRow[] = [
  {
    type: 'connection_lost',
    severity: 'warning',
    symbol: 'R_100',
    source: 'Deriv',
    whenUtc: '2026-10-20T14:29:58.000Z',
    status: 'resuelta',
    detail: 'Cerrada por el servidor; reconexión en 4 s.',
  },
  {
    type: 'event_gap_unresolved',
    severity: 'error',
    symbol: 'R_100',
    source: 'Deriv',
    whenUtc: '2026-10-20T14:30:11.000Z',
    status: 'abierta',
    detail: '13 s sin ticks que la historia no pudo recuperar.',
  },
  {
    type: 'delivery_delayed',
    severity: 'info',
    symbol: '1HZ100V',
    source: 'Deriv',
    whenUtc: '2026-10-20T13:02:40.000Z',
    status: 'resuelta',
    detail: 'Tick recibido 2,4 s después de su hora de fuente.',
  },
  {
    type: 'invalid_source_frame',
    severity: 'warning',
    symbol: 'sin símbolo',
    source: 'Deriv',
    whenUtc: '2026-10-20T11:47:03.000Z',
    status: 'resuelta',
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

export const DATASETS: readonly DatasetRow[] = [
  {
    id: 'sha256:6f2c…a91d',
    source: 'Deriv',
    period: '19 oct 2026, 00:00 – 24:00 UTC',
    ticks: '345 512',
    incidents: 3,
    rules: '2.0.0',
    verified: true,
  },
  {
    id: 'sha256:b07e…44c2',
    source: 'Deriv',
    period: '18 oct 2026, 00:00 – 24:00 UTC',
    ticks: '345 588',
    incidents: 1,
    rules: '2.0.0',
    verified: true,
  },
  {
    id: 'sha256:19aa…e310',
    source: 'Deriv',
    period: '17 oct 2026, 00:00 – 24:00 UTC',
    ticks: '344 901',
    incidents: 6,
    rules: '2.0.0',
    verified: false,
  },
];

export interface StrategyRow {
  readonly name: string;
  readonly version: string;
  readonly lifecycle: StrategyLifecycle;
  readonly symbol: string;
  readonly hypothesis: string;
}

export const STRATEGIES: readonly StrategyRow[] = [
  {
    name: 'Retorno a la media corta',
    version: 'v3',
    lifecycle: 'active',
    symbol: 'R_100',
    hypothesis:
      'Tras tres ticks en la misma dirección, el siguiente revierte más de la mitad de las veces.',
  },
  {
    name: 'Ruptura de rango',
    version: 'v1',
    lifecycle: 'reviewed',
    symbol: 'R_75',
    hypothesis: 'Una salida del rango de 60 s continúa durante los siguientes 10 ticks.',
  },
  {
    name: 'Cruce de medias 20/50',
    version: 'v2',
    lifecycle: 'retired',
    symbol: '1HZ100V',
    hypothesis: 'Descartada: la ventaja desapareció fuera de muestra.',
  },
];

export const LIFECYCLE_LABELS: Readonly<Record<StrategyLifecycle, string>> = {
  draft: 'Borrador',
  reviewed: 'Revisada',
  active: 'Activa',
  paused: 'En pausa',
  retired: 'Retirada',
};

export interface SampleSplit {
  readonly name: string;
  readonly period: string;
  readonly sample: string;
  readonly result: string;
  readonly drawdown: string;
}

/** Ejemplo honesto: la ventaja de entrenamiento se reduce fuera de muestra. */
export const BACKTEST_SPLITS: readonly SampleSplit[] = [
  {
    name: 'Entrenamiento',
    period: '1 jul – 31 ago 2026',
    sample: '4 210 operaciones',
    result: '+3,2 %',
    drawdown: '−2,1 %',
  },
  {
    name: 'Validación',
    period: '1 – 30 sep 2026',
    sample: '1 980 operaciones',
    result: '+0,9 %',
    drawdown: '−2,8 %',
  },
  {
    name: 'Prueba fuera de muestra',
    period: '1 – 15 oct 2026',
    sample: '1 015 operaciones',
    result: '−0,4 %',
    drawdown: '−3,6 %',
  },
];

export const BACKTEST_CONTEXT: PerformanceContext = {
  source: 'backtest',
  period: '1 – 15 oct 2026 (fuera de muestra)',
  sample: '1 015 operaciones hipotéticas',
  costs: 'Pago de Deriv y 300 ms de latencia supuestos',
  losses: '493 operaciones perdedoras (48,6 %)',
  drawdown: '−3,6 %',
  version: 'Retorno a la media corta v3',
  limitations:
    'Datos de un solo índice sintético; sin efecto de slippage; resultados pasados no anticipan resultados futuros.',
};

export const SHADOW_CONTEXT: PerformanceContext = {
  source: 'shadow',
  period: '14 – 20 oct 2026',
  sample: '212 señales hipotéticas',
  costs: 'Pago de Deriv supuesto; sin comisiones extra',
  losses: '109 señales perdedoras (51,4 %)',
  drawdown: '−1,9 %',
  version: 'Retorno a la media corta v3',
  limitations:
    'Ninguna orden se envió; 2 señales se descartaron por datos degradados y no cuentan.',
};

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

export interface SignalRow {
  readonly id: string;
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

export const SIGNALS: readonly SignalRow[] = [
  {
    id: 'sig-0193',
    strategy: 'Retorno a la media corta',
    version: 'v3',
    symbol: 'R_100',
    condition: 'Tres ticks seguidos al alza',
    direction: 'Hipótesis: baja en los próximos 5 ticks',
    issuedUtc: '2026-10-20T14:31:48.000Z',
    expiresUtc: '2026-10-20T14:31:53.000Z',
    mode: 'shadow',
    quality: 'completa',
    status: 'vencida',
    evidenceHref: '/laboratorio/',
  },
  {
    id: 'sig-0194',
    strategy: 'Retorno a la media corta',
    version: 'v3',
    symbol: 'R_100',
    condition: 'Tres ticks seguidos a la baja',
    direction: 'Hipótesis: sube en los próximos 5 ticks',
    issuedUtc: '2026-10-20T14:32:02.000Z',
    expiresUtc: '2026-10-20T14:32:07.000Z',
    mode: 'shadow',
    quality: 'completa',
    status: 'vigente',
    evidenceHref: '/laboratorio/',
  },
  {
    id: 'sig-0192',
    strategy: 'Retorno a la media corta',
    version: 'v3',
    symbol: 'R_100',
    condition: 'Tres ticks seguidos al alza',
    direction: 'Hipótesis: baja en los próximos 5 ticks',
    issuedUtc: '2026-10-20T14:30:15.000Z',
    expiresUtc: '2026-10-20T14:30:20.000Z',
    mode: 'shadow',
    quality: 'degradada',
    status: 'descartada',
    evidenceHref: '/datos/',
  },
];

export interface AuditRow {
  readonly whenUtc: string;
  readonly actor: string;
  readonly event: string;
  readonly reference: string;
}

export const AUDIT: readonly AuditRow[] = [
  {
    whenUtc: '2026-10-20T14:30:11.000Z',
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
    whenUtc: '2026-10-19T18:20:44.000Z',
    actor: 'Propietario',
    event: 'Versión aprobada para shadow: Retorno a la media corta v3',
    reference: 'str-v3',
  },
  {
    whenUtc: '2026-10-19T18:02:10.000Z',
    actor: 'Propietario',
    event: 'Estrategia retirada: Cruce de medias 20/50 v2',
    reference: 'str-c2',
  },
];
