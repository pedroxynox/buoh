/**
 * La forma de la respuesta de `GET /api/v1/datos/datasets` (`DataDatasets`), comprobada en el
 * navegador antes de dibujarla (ADR-0020 §10; CONTRIBUTING, «Reglas de implementación»). Como las de
 * la salud, de Mercados y de la Auditoría, no usa los esquemas de `@buoh/contracts`, cuya entrada
 * principal carga módulos de Node, y repite sus reglas: objetos estrictos, los valores y formatos de
 * cada campo, y las reglas entre campos (los datasets del más nuevo al más viejo y sin repetir, la
 * lista cortada solo si está llena, los segmentos y el período en orden, el período `null`
 * exactamente sin ticks, las listas en orden y sin repetir, «limpio» como dice su regla, las
 * incidencias que suman su conteo y el código de cada verificación). Lo que no pasa es una respuesta
 * inesperada, nunca un dataset inventado. `test/datos.test.tsx` la contrasta con el esquema.
 */
import type { DataDataset, DataDatasets } from '@buoh/contracts';

/** Cuántos datasets trae como mucho (`DATA_DATASETS_LIMIT` de los contratos). */
export const DATA_DATASETS_LIMIT = 200;

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/** Los patrones de los escalares del contrato (`packages/contracts/src/scalars.ts` y `api.ts`). */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATASET_ID = /^sha256:[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RULE_VERSION = /^\d+\.\d+\.\d+$/u;
/** El código saneado de un fallo de `data:replay` (`ReplayErrorCode`). */
const REPLAY_CODE = /^[A-Z][A-Z0-9_]{0,62}$/u;

type Incident = DataDataset['incidents'][number];
type Verification = NonNullable<DataDataset['verifications']['verify_only']>;

const INCIDENT_TYPES = {
  invalid_source_frame: true,
  duplicate_exact: true,
  source_time_conflict: true,
  out_of_order: true,
  delivery_delayed: true,
  connection_lost: true,
  event_gap_unresolved: true,
  persistence_unavailable: true,
  source_limit_exceeded: true,
} as const satisfies Record<Incident['incident_type'], true>;

const SEVERITIES = {
  info: true,
  warning: true,
  error: true,
  critical: true,
} as const satisfies Record<Incident['severity'], true>;

const CONDITION_TYPES = {
  connection_lost: true,
  event_gap_unresolved: true,
  persistence_unavailable: true,
  source_limit_exceeded: true,
} as const satisfies Record<DataDataset['open_condition_types'][number], true>;

const STATUSES = {
  passed: true,
  failed: true,
  incomplete: true,
} as const satisfies Record<Verification['status'], true>;

/** Los campos de cada objeto del contrato, que son estrictos: ni uno de más ni uno de menos. */
const RESPONSE_KEYS = ['datasets', 'truncated'] as const satisfies readonly (keyof DataDatasets)[];
const DATASET_KEYS = [
  'dataset_id',
  'publication_id',
  'published_at_utc',
  'source',
  'symbols',
  'log',
  'first_segment',
  'last_segment',
  'event_time_from_utc',
  'event_time_to_utc',
  'source_event_count',
  'raw_frame_count',
  'normalized_tick_count',
  'incident_count',
  'condition_event_count',
  'quality_rule_version',
  'quality_profile_id',
  'clean',
  'pending_continuity_symbols',
  'open_condition_types',
  'incidents',
  'verifications',
] as const satisfies readonly (keyof DataDataset)[];
const INCIDENT_KEYS = [
  'incident_type',
  'severity',
  'count',
] as const satisfies readonly (keyof Incident)[];
const VERIFICATIONS_KEYS = [
  'verify_only',
  'recompute',
] as const satisfies readonly (keyof DataDataset['verifications'])[];
const VERIFICATION_KEYS = [
  'status',
  'verified_at_utc',
  'error_code',
] as const satisfies readonly (keyof Verification)[];

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

const isCount = (value: unknown): value is number => isInteger(value, 0, Number.MAX_SAFE_INTEGER);

/** En el orden de las unidades UTF-16 y sin repetir, como `isSortedUnique` de los contratos. */
function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function isStringList(value: unknown, item: (entry: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.every(item);
}

function isIncident(value: unknown): value is Incident {
  return (
    isRecord(value) &&
    hasExactly(value, INCIDENT_KEYS) &&
    isKeyOf(INCIDENT_TYPES, value.incident_type) &&
    isKeyOf(SEVERITIES, value.severity) &&
    isInteger(value.count, 1, Number.MAX_SAFE_INTEGER)
  );
}

function isVerification(value: unknown): value is Verification | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactly(value, VERIFICATION_KEYS) ||
    !isKeyOf(STATUSES, value.status) ||
    !isUtc(value.verified_at_utc) ||
    !(value.error_code === null || matches(REPLAY_CODE, value.error_code))
  ) {
    return false;
  }
  // Una verificación que pasó no lleva código; una que falló, sí.
  return (
    (value.status !== 'passed' || value.error_code === null) &&
    (value.status !== 'failed' || value.error_code !== null)
  );
}

function isDataset(value: unknown): value is DataDataset {
  if (!isRecord(value) || !hasExactly(value, DATASET_KEYS)) {
    return false;
  }
  const verifications = value.verifications;
  if (
    !matches(DATASET_ID, value.dataset_id) ||
    !matches(UUID_V7, value.publication_id) ||
    !isUtc(value.published_at_utc) ||
    !isNonEmpty(value.source) ||
    !isStringList(value.symbols, isNonEmpty) ||
    value.symbols.length === 0 ||
    !isInteger(value.log, 1, MAX_LOG_NUMBER) ||
    !isCount(value.first_segment) ||
    !isCount(value.last_segment) ||
    !(value.event_time_from_utc === null || isUtc(value.event_time_from_utc)) ||
    !(value.event_time_to_utc === null || isUtc(value.event_time_to_utc)) ||
    !isCount(value.source_event_count) ||
    !isCount(value.raw_frame_count) ||
    !isCount(value.normalized_tick_count) ||
    !isCount(value.incident_count) ||
    !isCount(value.condition_event_count) ||
    !matches(RULE_VERSION, value.quality_rule_version) ||
    !isNonEmpty(value.quality_profile_id) ||
    typeof value.clean !== 'boolean' ||
    !isStringList(value.pending_continuity_symbols, isNonEmpty) ||
    !isStringList(value.open_condition_types, (entry) => isKeyOf(CONDITION_TYPES, entry)) ||
    !Array.isArray(value.incidents) ||
    !value.incidents.every(isIncident) ||
    !isRecord(verifications) ||
    !hasExactly(verifications, VERIFICATIONS_KEYS) ||
    !isVerification(verifications.verify_only) ||
    !isVerification(verifications.recompute)
  ) {
    return false;
  }
  const from = value.event_time_from_utc;
  const to = value.event_time_to_utc;
  const incidents = value.incidents;
  const clean =
    value.pending_continuity_symbols.length === 0 &&
    !value.open_condition_types.includes('connection_lost');
  return (
    value.last_segment >= value.first_segment &&
    // El período es null exactamente sin ticks, entero o nada, y en orden.
    (from === null) === (to === null) &&
    (value.normalized_tick_count === 0) === (from === null) &&
    (from === null || to === null || from <= to) &&
    value.raw_frame_count <= value.source_event_count &&
    isSortedUnique(value.symbols) &&
    isSortedUnique(value.pending_continuity_symbols) &&
    isSortedUnique(value.open_condition_types) &&
    value.clean === clean &&
    isSortedUnique(incidents.map((item) => `${item.incident_type} ${item.severity}`)) &&
    incidents.reduce((sum, item) => sum + item.count, 0) === value.incident_count
  );
}

/** La respuesta como `DataDatasets` si cumple el contrato, o `null`. */
export function readDataDatasets(value: unknown): DataDatasets | null {
  if (!isRecord(value) || !hasExactly(value, RESPONSE_KEYS)) {
    return null;
  }
  const { datasets, truncated } = value;
  if (
    !Array.isArray(datasets) ||
    datasets.length > DATA_DATASETS_LIMIT ||
    !datasets.every(isDataset) ||
    typeof truncated !== 'boolean'
  ) {
    return null;
  }
  const ids = new Set(datasets.map((dataset) => dataset.dataset_id));
  const valid =
    // Solo se corta una lista llena; cada dataset sale una vez, del más nuevo al más viejo.
    (!truncated || datasets.length === DATA_DATASETS_LIMIT) &&
    ids.size === datasets.length &&
    datasets.every(
      (dataset, index) =>
        index === 0 || (datasets[index - 1]?.published_at_utc ?? '') >= dataset.published_at_utc,
    );
  return valid ? (value as unknown as DataDatasets) : null;
}
