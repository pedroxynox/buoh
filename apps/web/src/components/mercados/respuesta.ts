/**
 * La forma de las respuestas de `GET /api/v1/datos/grafico` (`DataChart`) y `GET
 * /api/v1/datos/catalogo` (`DataCatalog`), comprobada en el navegador antes de dibujarlas (ADR-0019
 * §8; CONTRIBUTING, «Reglas de implementación»). Como la de la salud (`salud/respuesta.ts`), no usa
 * los esquemas de `@buoh/contracts`, cuya entrada principal carga módulos de Node, y repite sus
 * reglas: objetos estrictos, los valores y formatos de cada campo, y las reglas entre campos (las
 * horas enteras de la ventana, los ticks en orden y dentro de ella, lo que lleva cada clase de hueco,
 * que sin log no hay datos y las entradas del catálogo en orden). Lo que no pasa es una respuesta
 * inesperada, nunca un gráfico inventado. `test/mercados.test.tsx` las contrasta con los esquemas.
 */
import type { DataCatalog, DataChart, DataChartGap } from '@buoh/contracts';

/** La ventana más larga del gráfico, en horas (`DATA_CHART_MAX_HOURS` de los contratos). */
export const CHART_MAX_HOURS = 24;

const HOUR_MS = 3_600_000;

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/** Los patrones de los escalares del contrato (`packages/contracts/src/scalars.ts` y `api.ts`). */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** Un código saneado de las operaciones, como el motivo de un hueco sin resolver. */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

const CAUSES = {
  connection_lost: true,
  capture_stopped: true,
} as const satisfies Record<DataChartGap['cause'], true>;

const HISTORIES = {
  recovered: true,
  partial: true,
  unavailable: true,
  pending: true,
  not_requested: true,
} as const satisfies Record<DataChartGap['history'], true>;

/** Los campos de cada objeto del contrato, que son estrictos: ni uno de más ni uno de menos. */
const CHART_KEYS = [
  'from_utc',
  'gaps',
  'log',
  'log_started_at_utc',
  'source',
  'symbol',
  'ticks',
  'to_utc',
] as const satisfies readonly (keyof DataChart)[];
const TICKS_KEYS = [
  'offsets_ms',
  'quotes',
] as const satisfies readonly (keyof DataChart['ticks'])[];
const GAP_KEYS = [
  'cause',
  'from_utc',
  'history',
  'reason',
  'recovered_ticks',
  'to_utc',
] as const satisfies readonly (keyof DataChartGap)[];
const CATALOG_RESPONSE_KEYS = ['catalog', 'log'] as const satisfies readonly (keyof DataCatalog)[];
const CATALOG_KEYS = [
  'content_sha256',
  'entries',
  'received_at_utc',
  'source',
  'source_schema_release',
  'version',
] as const satisfies readonly (keyof NonNullable<DataCatalog['catalog']>)[];
const ENTRY_KEYS = [
  'exchange_is_open',
  'is_trading_suspended',
  'market',
  'pip_size',
  'subgroup',
  'submarket',
  'underlying_symbol',
  'underlying_symbol_name',
  'underlying_symbol_type',
] as const satisfies readonly (keyof NonNullable<DataCatalog['catalog']>['entries'][number])[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, index) => own[index] === key);
}

function isKeyOf<T extends object>(table: T, value: unknown): value is keyof T {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** Un instante UTC real con milisegundos, que se vuelve a escribir idéntico (`UtcTimestampMs`). */
function isUtc(value: unknown): value is string {
  if (!matches(UTC_MS, value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isLog(value: unknown): value is number | null {
  return value === null || isInteger(value, 1, MAX_LOG_NUMBER);
}

/** Único y en orden estricto por el `<` de JavaScript, como `isSortedUnique` de los contratos. */
function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function isGap(value: unknown): value is DataChartGap {
  if (!isRecord(value) || !hasExactly(value, GAP_KEYS)) {
    return false;
  }
  const { cause, from_utc: from, history, reason, recovered_ticks: recovered, to_utc: to } = value;
  if (
    !isUtc(from) ||
    !(to === null || isUtc(to)) ||
    !isKeyOf(CAUSES, cause) ||
    !isKeyOf(HISTORIES, history) ||
    !(reason === null || matches(CODE, reason)) ||
    !(recovered === null || isInteger(recovered, 0, Number.MAX_SAFE_INTEGER))
  ) {
    return false;
  }
  // Una parada pedida no se recupera, y solo ella; solo un hueco sin resolver lleva su motivo; solo
  // la historia que trajo ticks los cuenta; y solo un hueco que sigue no tiene fin.
  const unresolved = history === 'partial' || history === 'unavailable';
  const brought = history === 'recovered' || history === 'partial';
  return (
    (cause === 'capture_stopped') === (history === 'not_requested') &&
    (reason !== null) === unresolved &&
    (recovered !== null) === brought &&
    (to === null ? history === 'pending' || history === 'not_requested' : to >= from)
  );
}

/**
 * La respuesta como `DataChart` si cumple el contrato, o `null`. Con `hours`, además, la ventana
 * tiene que ser la pedida.
 */
export function readDataChart(value: unknown, hours?: number): DataChart | null {
  if (!isRecord(value) || !hasExactly(value, CHART_KEYS)) {
    return null;
  }
  const {
    from_utc: from,
    gaps,
    log,
    log_started_at_utc: started,
    source,
    symbol,
    to_utc: to,
  } = value;
  const ticks = value.ticks;
  if (
    !isLog(log) ||
    !isNonEmpty(source) ||
    !isNonEmpty(symbol) ||
    !isUtc(from) ||
    !isUtc(to) ||
    !(started === null || isUtc(started)) ||
    !isRecord(ticks) ||
    !hasExactly(ticks, TICKS_KEYS) ||
    !Array.isArray(gaps) ||
    !gaps.every(isGap)
  ) {
    return null;
  }
  const offsets: unknown = ticks.offsets_ms;
  const quotes: unknown = ticks.quotes;
  const maxOffset = CHART_MAX_HOURS * HOUR_MS;
  if (
    !Array.isArray(offsets) ||
    !offsets.every((offset) => isInteger(offset, 0, maxOffset)) ||
    !Array.isArray(quotes) ||
    !quotes.every((quote) => matches(DECIMAL, quote))
  ) {
    return null;
  }
  const length = Date.parse(to) - Date.parse(from);
  const ordered = offsets as readonly number[];
  if (
    length <= 0 ||
    length % HOUR_MS !== 0 ||
    length > maxOffset ||
    (hours !== undefined && length !== hours * HOUR_MS) ||
    ordered.length !== quotes.length ||
    ordered.some((offset, index) => index > 0 && offset <= (ordered[index - 1] ?? -1)) ||
    ordered.some((offset) => offset > length)
  ) {
    return null;
  }
  if (log === null && (ordered.length > 0 || gaps.length > 0 || started !== null)) {
    return null;
  }
  // Cada hueco toca la ventana, aunque empiece antes, y van en orden de inicio.
  const touching = gaps.every(
    (gap, index) =>
      gap.from_utc <= to &&
      (gap.to_utc === null || gap.to_utc >= from) &&
      (index === 0 || (gaps[index - 1]?.from_utc ?? '') <= gap.from_utc),
  );
  return touching ? (value as unknown as DataChart) : null;
}

function isEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactly(value, ENTRY_KEYS) &&
    isNonEmpty(value.underlying_symbol) &&
    typeof value.underlying_symbol_name === 'string' &&
    typeof value.underlying_symbol_type === 'string' &&
    typeof value.market === 'string' &&
    typeof value.submarket === 'string' &&
    typeof value.subgroup === 'string' &&
    matches(DECIMAL, value.pip_size) &&
    (value.exchange_is_open === 0 || value.exchange_is_open === 1) &&
    (value.is_trading_suspended === 0 || value.is_trading_suspended === 1)
  );
}

/** La respuesta como `DataCatalog` si cumple el contrato, o `null`. */
export function readDataCatalog(value: unknown): DataCatalog | null {
  if (!isRecord(value) || !hasExactly(value, CATALOG_RESPONSE_KEYS) || !isLog(value.log)) {
    return null;
  }
  const catalog = value.catalog;
  if (catalog === null) {
    return value as unknown as DataCatalog;
  }
  if (value.log === null || !isRecord(catalog) || !hasExactly(catalog, CATALOG_KEYS)) {
    return null;
  }
  const entries: unknown = catalog.entries;
  const valid =
    isNonEmpty(catalog.source) &&
    isInteger(catalog.version, 1, Number.MAX_SAFE_INTEGER) &&
    isUtc(catalog.received_at_utc) &&
    isNonEmpty(catalog.source_schema_release) &&
    matches(SHA256, catalog.content_sha256) &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every(isEntry) &&
    isSortedUnique(
      entries.map((entry) => (entry as { underlying_symbol: string }).underlying_symbol),
    );
  return valid ? (value as unknown as DataCatalog) : null;
}
