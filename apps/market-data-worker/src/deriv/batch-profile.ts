import { canonicalJson, sha256Hex, type ContractDuration, type JsonValue } from '@buoh/contracts';
import { BATCH_HISTORY_RULE_SET, BATCH_RULE_SET, utf8, type BatchRuleSet } from '@buoh/domain';

import type { LogQualityProfileRow } from './log-profile.js';
import { DERIV_SOURCE } from './profile.js';

/**
 * Los perfiles de las secuencias por lotes del PR 5 de ADR-0021 §9: los horarios, las cotizaciones
 * y las velas (§3). Cada perfil dice qué pide su secuencia y cada cuánto, y con qué reglas se deriva
 * (las de los lotes 4.0.0). Sus bytes son su JCS, y cambiar una lista, la apuesta o el ritmo crea
 * otro perfil, con otro `profile_id` (§3: «La lista y la apuesta van en el perfil»). La historia de
 * R_100 y la del oro, las otras dos secuencias por lotes, tienen sus perfiles desde el PR 6a
 * (`derivHistoryProfile`), con las reglas 4.1.0 desde el 6b, y sus secuencias desde el 6c.
 */

/**
 * El conector de los lotes (ADR-0021 §3): la misma fuente, `deriv_options`, con otras peticiones
 * que la captura en vivo (`deriv-options-ws-1.1.0`), así que es otro conector (ADR-0012 §1).
 */
export const DERIV_BATCH_CONNECTOR_VERSION = 'deriv-options-lotes-1.0.0';

/**
 * Las clases de las secuencias por lotes con perfil: las tres de las vueltas del PR 5 y, desde el
 * PR 6c de ADR-0021 §9, las dos historias (`HistoryProfileKind`).
 */
export type BatchProfileKind = RoundProfileKind | HistoryProfileKind;

/** Las clases de las secuencias por lotes que van por vueltas (PR 5 de ADR-0021 §9). */
export type RoundProfileKind = 'candles' | 'quotes' | 'schedules';

/** Las clases de las dos historias (precisión del PR 6c de ADR-0021 §9). */
export type HistoryProfileKind = 'history_frxxauusd' | 'history_r_100';

/** La clase de la historia de cada símbolo. */
export const HISTORY_PROFILE_KINDS: Readonly<Record<HistorySymbol, HistoryProfileKind>> = {
  R_100: 'history_r_100',
  frxXAUUSD: 'history_frxxauusd',
};

/** Si la clase es la de una historia. */
export function isHistoryProfileKind(kind: BatchProfileKind): kind is HistoryProfileKind {
  return kind === 'history_frxxauusd' || kind === 'history_r_100';
}

/** El perfil de la historia de una clase de historia. */
export function historyProfileOf(kind: HistoryProfileKind): HistoryProfile {
  return derivHistoryProfile(kind === 'history_r_100' ? 'R_100' : 'frxXAUUSD');
}

/** Un mercado de las cotizaciones, con lo que se le pide en cada vuelta. */
export interface QuoteMarket {
  /** Duraciones de `CALL` y `PUT`, de menor a mayor; vacío si el mercado no ofrece sube/baja. */
  readonly durations: ContractDuration[];
  /** Multiplicadores de `MULTUP` y `MULTDOWN`, de menor a mayor. */
  readonly multipliers: number[];
  readonly symbol: string;
}

interface ProfileHeader {
  readonly profile_id: string;
  readonly quality_rule_version: string;
  readonly source: string;
}

export type SchedulesProfile = ProfileHeader & {
  /** Días siguientes al de la vuelta cuyos `trading_times` también se piden. */
  readonly days_ahead: number;
  readonly symbols: string[];
};

export type QuotesProfile = ProfileHeader & {
  readonly currency: string;
  readonly interval_minutes: number;
  readonly markets: QuoteMarket[];
  /** La apuesta, en decimal canónico entero. */
  readonly stake: string;
};

export type CandlesProfile = ProfileHeader & {
  /** Velas que se piden como mucho en una página. */
  readonly count: number;
  readonly granularity_seconds: number;
  /** Segundos de velas de cada página. */
  readonly page_seconds: number;
  readonly symbols: string[];
};

/**
 * Una historia de la descarga de un año (ADR-0021 §4; precisión del PR 6a de su §9): los ticks de
 * un símbolo desde `start_epoch` hasta `end_epoch`, los dos incluidos, en bloques de
 * `block_seconds` dentro de un día UTC. Cada bloque pide el `trading_times` de su día y después sus
 * tramos contiguos de `tranche_seconds`, con `count` ticks como mucho por página.
 */
export type HistoryProfile = ProfileHeader & {
  readonly block_seconds: number;
  readonly count: number;
  /** El segundo anterior al del primer tick en vivo: así la historia y la captura no se solapan. */
  readonly end_epoch: number;
  /**
   * El umbral del tramo sin ticks dentro del horario (precisión del PR 6b de ADR-0021 §9): un tramo
   * de segundos seguidos sin ticks que dura al menos esto es un `tick_gap` de las reglas 4.1.0.
   */
  readonly maximum_tick_gap_ms: number;
  /** El primer comienzo de bloque desde 365 días antes del primer tick en vivo. */
  readonly start_epoch: number;
  readonly symbol: string;
  readonly tranche_seconds: number;
};

/** Los símbolos con historia (ADR-0021 §4): los dos que se capturan en vivo. */
export type HistorySymbol = 'R_100' | 'frxXAUUSD';

/**
 * Los días que Deriv guarda de historia: el 2026-11-27, `ticks_history` de R_100 y del oro dio
 * ticks desde hace 365 días y, para un tramo más antiguo, los últimos ticks, fuera del tramo pedido
 * (precisión del PR 6a de ADR-0021 §9).
 */
export const DERIV_HISTORY_DAYS = 365;

const DAY_SECONDS = 86_400;

/**
 * El epoch en segundos del primer tick en vivo de cada símbolo, el que leyó el agente en la captura
 * con su acceso el 2026-11-27 (ADR-0021 §4): el primero del log 1 de R_100, de las
 * 2026-11-01T00:06:08Z, y el primero del log 1 del oro, de las 2026-11-25T05:09:43Z.
 */
const FIRST_LIVE_TICK_EPOCH: Readonly<Record<HistorySymbol, number>> = {
  R_100: 1_793_491_568,
  frxXAUUSD: 1_795_583_383,
};

/**
 * El umbral del tramo sin ticks de R_100 (precisión del PR 6b de ADR-0021 §9): manda un tick cada
 * 2 s, así que uno que falta ya es un tramo, como en su captura en vivo (`maximum_event_gap_ms`).
 * El 2026-11-27, en 4 días de su historia, la separación más larga fue de 2 s en 3 y de 4 s en el
 * 2026-11-20, con 4 ticks que faltan también en su captura.
 */
const R100_MAXIMUM_TICK_GAP_MS = 2_000;

/**
 * El umbral del tramo sin ticks del oro (precisión del PR 6b de ADR-0021 §9): su ritmo no es fijo.
 * El 2026-11-27, en 8 días de su historia con ticks, la separación más larga dentro del horario fue
 * de 10 s como mucho, salvo antes del cierre diario, de 22 a 30 s en 3 días, y una de 61 s a las
 * 00:05 del 2026-08-12. El umbral es el doble de esos 30 s.
 */
const GOLD_MAXIMUM_TICK_GAP_MS = 60_000;

/**
 * Los tramos y los bloques de cada historia. Una página trae como mucho `count` ticks, los últimos
 * del tramo (el 2026-11-27 Deriv dio 2000 con `count` de 5000 y 1000 con 1000), y un tick por
 * segundo como mucho: R_100 manda uno cada 2 s, 900 por tramo de 1800 s, y el oro uno por segundo,
 * 900 por tramo de 900 s. Así ningún bloque pasa de 16 000 elementos, el techo de un dataset
 * (`historyBlocks`).
 */
const HISTORY_SHAPE: Readonly<
  Record<
    HistorySymbol,
    { block_seconds: number; maximum_tick_gap_ms: number; name: string; tranche_seconds: number }
  >
> = {
  R_100: {
    block_seconds: 21_600,
    maximum_tick_gap_ms: R100_MAXIMUM_TICK_GAP_MS,
    name: 'historia-r_100',
    tranche_seconds: 1_800,
  },
  frxXAUUSD: {
    block_seconds: 14_400,
    maximum_tick_gap_ms: GOLD_MAXIMUM_TICK_GAP_MS,
    name: 'historia-frxxauusd',
    tranche_seconds: 900,
  },
};

const minutes = (duration: number): ContractDuration => ({ duration, duration_unit: 'm' });

/**
 * Los mercados de las cotizaciones (ADR-0021 §3): los siete de `F2-MARKET-001` y R_100, por
 * símbolo en unidades UTF-16. Los multiplicadores son los que aceptó `proposal` en `MULTUP`, sin
 * cuenta y con 10 USD, el 2026-11-25 de 14:40 a 14:55 UTC (PR 4b; de 17 candidatos de 10 a 1000 en
 * R_100 y el oro y de 8, de 50 a 800, en la plata y las tres divisas, sin número registrado en
 * Bitcoin y Ethereum), y otra vez de 20:53 a 21:05 UTC (PR 5a), con los 17 en los ocho mercados,
 * entonces también en `MULTDOWN`, con los mismos. Las duraciones son
 * las de la lista fija de §3 (5 ticks, 15 s y 1, 5, 15, 60 y 240 minutos) que caben en la duración
 * mínima y máxima que publica `contracts_for` para cada mercado. Bitcoin y Ethereum no ofrecen
 * sube/baja.
 */
function quoteMarkets(): QuoteMarket[] {
  const forex = (symbol: string): QuoteMarket => ({
    durations: [minutes(15), minutes(60), minutes(240)],
    multipliers: [50, 100, 150, 250, 500],
    symbol,
  });
  const metal = (symbol: string): QuoteMarket => ({
    durations: [minutes(5), minutes(15), minutes(60), minutes(240)],
    multipliers: [50, 100, 150, 250, 500],
    symbol,
  });
  return [
    {
      durations: [
        { duration: 5, duration_unit: 't' },
        { duration: 15, duration_unit: 's' },
        minutes(1),
        minutes(5),
        minutes(15),
        minutes(60),
        minutes(240),
      ],
      multipliers: [40, 100, 200, 300, 400],
      symbol: 'R_100',
    },
    { durations: [], multipliers: [50, 100, 150, 200, 300], symbol: 'cryBTCUSD' },
    { durations: [], multipliers: [50, 100, 150, 200], symbol: 'cryETHUSD' },
    forex('frxEURUSD'),
    forex('frxGBPUSD'),
    forex('frxUSDJPY'),
    metal('frxXAGUSD'),
    metal('frxXAUUSD'),
  ];
}

/** Los siete mercados reales de `F2-MARKET-001`, por símbolo: los de las velas. */
function realMarkets(): string[] {
  return [
    'cryBTCUSD',
    'cryETHUSD',
    'frxEURUSD',
    'frxGBPUSD',
    'frxUSDJPY',
    'frxXAGUSD',
    'frxXAUUSD',
  ];
}

const header = (name: string, rules: BatchRuleSet = BATCH_RULE_SET): ProfileHeader => ({
  profile_id: `${DERIV_SOURCE}-lotes-v1-${name}`,
  quality_rule_version: rules.quality_rule_version,
  source: DERIV_SOURCE,
});

/**
 * Los horarios (§3): una vez al día, `trading_times` del día y de los `days_ahead` siguientes,
 * `active_symbols`, el catálogo de los lotes, y `contracts_for` de cada símbolo. Sus símbolos son
 * los de las cotizaciones, y son también los que buscan en `trading_times` las reglas 4.0.0.
 */
export function derivSchedulesProfile(): SchedulesProfile {
  return {
    ...header('horarios'),
    days_ahead: 1,
    symbols: quoteMarkets().map((market) => market.symbol),
  };
}

/**
 * Las cotizaciones (§3): cada `interval_minutes`, `proposal` de cada mercado con una apuesta fija de
 * `stake` en `currency`, en `MULTUP` y `MULTDOWN` con cada multiplicador y en `CALL` y `PUT` con cada
 * duración. Son 126 peticiones por vuelta.
 */
export function derivQuotesProfile(): QuotesProfile {
  return {
    ...header('cotizaciones'),
    currency: 'USD',
    interval_minutes: 30,
    markets: quoteMarkets(),
    stake: '10',
  };
}

/**
 * Las velas (§3): una vez al día, las de `granularity_seconds` del día UTC anterior de los siete
 * mercados reales, en páginas de `page_seconds`, con `count` como mucho por página. Doce horas de
 * velas de 1 minuto son 720, por debajo de las 1000 de una página. Antes de las páginas, el
 * `trading_times` de ese día, en el que las reglas 4.0.0 buscan `symbols` (precisión del PR 5d1).
 */
export function derivCandlesProfile(): CandlesProfile {
  return {
    ...header('velas'),
    count: 1000,
    granularity_seconds: 60,
    page_seconds: 43_200,
    symbols: realMarkets(),
  };
}

/**
 * La historia de un símbolo (ADR-0021 §4): sus ticks desde un año antes de su primer tick en vivo
 * hasta el segundo anterior, por bloques y tramos (`HISTORY_SHAPE`). Lo que Deriv ya no guarda
 * (`DERIV_HISTORY_DAYS`) no se pide (`historyRequestsFrom`).
 */
export function derivHistoryProfile(symbol: HistorySymbol): HistoryProfile {
  const shape = HISTORY_SHAPE[symbol];
  const first = FIRST_LIVE_TICK_EPOCH[symbol];
  const from = first - DERIV_HISTORY_DAYS * DAY_SECONDS;
  return {
    ...header(shape.name, BATCH_HISTORY_RULE_SET),
    block_seconds: shape.block_seconds,
    count: 1000,
    end_epoch: first - 1,
    maximum_tick_gap_ms: shape.maximum_tick_gap_ms,
    start_epoch: Math.ceil(from / shape.block_seconds) * shape.block_seconds,
    symbol,
    tranche_seconds: shape.tranche_seconds,
  };
}

const PROFILES = {
  candles: derivCandlesProfile,
  history_frxxauusd: () => derivHistoryProfile('frxXAUUSD'),
  history_r_100: () => derivHistoryProfile('R_100'),
  quotes: derivQuotesProfile,
  schedules: derivSchedulesProfile,
} as const satisfies Record<BatchProfileKind, () => ProfileHeader>;

/** El JCS del perfil de una clase. Los perfiles solo tienen texto, enteros y listas de ellos. */
function profileJcs(kind: BatchProfileKind): string {
  return canonicalJson(PROFILES[kind]() as unknown as JsonValue);
}

/** Los bytes del perfil de una clase: su JCS. */
export function batchProfileBytes(kind: BatchProfileKind): Uint8Array {
  return utf8(profileJcs(kind));
}

/** La fila de `log_quality_profile` de un log de los lotes, con el SHA-256 del JCS de su perfil. */
export function derivBatchLogProfileRow(kind: BatchProfileKind): LogQualityProfileRow {
  return {
    profile_id: PROFILES[kind]().profile_id,
    quality_profile_sha256: sha256Hex(profileJcs(kind)),
  };
}

/**
 * Los símbolos que buscan en `trading_times` las reglas de los lotes con el perfil de una clase,
 * como en su publicación (`buildBatchDatasetPublication`): sus `symbols`, el `symbol` de una
 * historia, o ninguno en las cotizaciones.
 */
export function batchTradingTimesSymbols(kind: BatchProfileKind): readonly string[] {
  const profile: ProfileHeader & {
    readonly symbol?: string;
    readonly symbols?: readonly string[];
  } = PROFILES[kind]();
  return profile.symbols ?? (profile.symbol === undefined ? [] : [profile.symbol]);
}

/**
 * Lo que la configuración de las reglas de los lotes (`createBatchLogConfig`) lee del perfil de una
 * clase, además de su esquema de fuente, como en su publicación (`buildBatchDatasetPublication`):
 * sus símbolos de `trading_times`, sus reglas y, en una historia, el umbral del tramo sin ticks de su
 * símbolo (precisión del PR 6b de ADR-0021 §9).
 */
export function batchLogConfigOptions(kind: BatchProfileKind): {
  readonly maximum_tick_gap_ms?: Readonly<Record<string, number>>;
  readonly quality_rule_version: BatchRuleSet['quality_rule_version'];
  readonly trading_times_symbols: readonly string[];
} {
  const trading_times_symbols = batchTradingTimesSymbols(kind);
  if (!isHistoryProfileKind(kind)) {
    return { quality_rule_version: BATCH_RULE_SET.quality_rule_version, trading_times_symbols };
  }
  const profile = historyProfileOf(kind);
  return {
    maximum_tick_gap_ms: { [profile.symbol]: profile.maximum_tick_gap_ms },
    quality_rule_version: BATCH_HISTORY_RULE_SET.quality_rule_version,
    trading_times_symbols,
  };
}
