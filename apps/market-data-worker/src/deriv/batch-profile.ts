import { canonicalJson, sha256Hex, type ContractDuration, type JsonValue } from '@buoh/contracts';
import { BATCH_RULE_SET, utf8 } from '@buoh/domain';

import type { LogQualityProfileRow } from './log-profile.js';
import { DERIV_SOURCE } from './profile.js';

/**
 * Los perfiles de las secuencias por lotes del PR 5 de ADR-0021 §9: los horarios, las cotizaciones
 * y las velas (§3). Cada perfil dice qué pide su secuencia y cada cuánto, y con qué reglas se deriva
 * (las de los lotes 4.0.0). Sus bytes son su JCS, y cambiar una lista, la apuesta o el ritmo crea
 * otro perfil, con otro `profile_id` (§3: «La lista y la apuesta van en el perfil»). La historia de
 * R_100 y la del oro, las otras dos secuencias por lotes, tienen sus perfiles con el PR 6.
 */

/**
 * El conector de los lotes (ADR-0021 §3): la misma fuente, `deriv_options`, con otras peticiones
 * que la captura en vivo (`deriv-options-ws-1.1.0`), así que es otro conector (ADR-0012 §1).
 */
export const DERIV_BATCH_CONNECTOR_VERSION = 'deriv-options-lotes-1.0.0';

/** Las clases de las secuencias por lotes que tienen perfil desde el PR 5. */
export type BatchProfileKind = 'candles' | 'quotes' | 'schedules';

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

const minutes = (duration: number): ContractDuration => ({ duration, duration_unit: 'm' });

/**
 * Los mercados de las cotizaciones (ADR-0021 §3): los siete de `F2-MARKET-001` y R_100, por
 * símbolo en unidades UTF-16. Los multiplicadores son los que aceptó `proposal` en `MULTUP`, sin
 * cuenta y con 10 USD, el 2026-11-25 de 14:40 a 14:55 UTC (PR 4b; de 17 candidatos de 10 a 1000 en
 * R_100 y el oro, y de menos en los demás), y otra vez de 20:53 a 21:05 UTC (PR 5a), con los 17 en
 * los ocho mercados, entonces también en `MULTDOWN`, con los mismos. Las duraciones son
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

const header = (name: string): ProfileHeader => ({
  profile_id: `${DERIV_SOURCE}-lotes-v1-${name}`,
  quality_rule_version: BATCH_RULE_SET.quality_rule_version,
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
 * velas de 1 minuto son 720, por debajo de las 1000 de una página.
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

const PROFILES = {
  candles: derivCandlesProfile,
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
