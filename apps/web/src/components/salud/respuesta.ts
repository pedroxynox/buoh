/**
 * La forma de la respuesta de `GET /api/v1/datos/salud` (`DataHealth`, ADR-0019 §8), comprobada en
 * el navegador antes de dibujarla: la web valida en runtime lo que recibe (CONTRIBUTING, «Reglas de
 * implementación»). No usa el esquema de `@buoh/contracts`, cuya entrada principal carga módulos de
 * Node (`node:crypto`, `node:fs`) que no van al navegador. Repite sus reglas: objetos estrictos, los
 * valores y formatos de cada campo, y las reglas del `HealthReport` (la lista de condiciones única y
 * ordenada, y `healthy` solo conectada, sin condiciones y con raw durable). Lo que no pasa es una
 * respuesta inesperada, nunca un estado inventado.
 */
import type { ConditionType, DataHealth, HealthReport, ServiceHealth } from '@buoh/contracts';

/** Los seis estados de `service_health`; `satisfies` obliga a tenerlos todos (contratos de dominio). */
const SERVICE_HEALTHS = {
  starting: true,
  healthy: true,
  degraded: true,
  recovering: true,
  paused: true,
  failed: true,
} as const satisfies Record<ServiceHealth, true>;

const CONNECTION_STATES = {
  disconnected: true,
  connecting: true,
  connected: true,
} as const satisfies Record<HealthReport['connection_state'], true>;

const CONDITION_TYPES = {
  connection_lost: true,
  event_gap_unresolved: true,
  persistence_unavailable: true,
  source_limit_exceeded: true,
} as const satisfies Record<ConditionType, true>;

/** Los campos de cada objeto del contrato, que son estrictos: ni uno de más ni uno de menos. */
const DATA_HEALTH_KEYS = ['log', 'observation'];
const COMPLETED_KEYS = ['alerts', 'observed_at_utc', 'report', 'status'];
const FAILED_KEYS = ['code', 'observed_at_utc', 'reason', 'status'];
const ALERT_KEYS = ['event', 'reason'];
const REPORT_KEYS = [
  'backlog_bytes',
  'backlog_count',
  'connection_state',
  'execution_mode',
  'last_event_time_utc',
  'last_observation_id',
  'last_published_dataset_id',
  'last_received_at_utc',
  'open_condition_types',
  'schema_version',
  'service_health',
  'source',
] as const satisfies readonly (keyof HealthReport)[];

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/** Los patrones de los escalares del contrato (`packages/contracts/src/scalars.ts`). */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SCHEMA_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATASET_ID = /^sha256:[0-9a-f]{64}$/u;

/** Un código saneado de `buoh-operaciones`: nunca un mensaje (contratos de dominio, `DataHealth`). */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

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

/** Un instante UTC real con milisegundos, que se vuelve a escribir idéntico (`UtcTimestampMs`). */
function isUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MS.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function isReport(value: unknown): value is HealthReport {
  if (!isRecord(value) || !hasExactly(value, REPORT_KEYS)) {
    return false;
  }
  const conditions = value.open_condition_types;
  const shaped =
    matches(SCHEMA_VERSION, value.schema_version) &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    value.execution_mode === 'disabled' &&
    isKeyOf(SERVICE_HEALTHS, value.service_health) &&
    isKeyOf(CONNECTION_STATES, value.connection_state) &&
    isCount(value.backlog_count) &&
    isCount(value.backlog_bytes) &&
    (value.last_observation_id === null || matches(UUID_V7, value.last_observation_id)) &&
    (value.last_received_at_utc === null || isUtc(value.last_received_at_utc)) &&
    (value.last_event_time_utc === null || isUtc(value.last_event_time_utc)) &&
    (value.last_published_dataset_id === null ||
      matches(DATASET_ID, value.last_published_dataset_id)) &&
    Array.isArray(conditions) &&
    conditions.every((type) => isKeyOf(CONDITION_TYPES, type));
  if (!shaped || !isSortedUnique(conditions)) {
    return false;
  }
  // `healthy` exige la conexión, ninguna condición abierta y raw durable (contrato `HealthReport`).
  return (
    value.service_health !== 'healthy' ||
    (value.connection_state === 'connected' &&
      conditions.length === 0 &&
      value.last_observation_id !== null &&
      value.last_received_at_utc !== null)
  );
}

function isAlert(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactly(value, ALERT_KEYS) &&
    matches(CODE, value.event) &&
    (value.reason === null || matches(CODE, value.reason))
  );
}

function isObservation(value: unknown): boolean {
  if (!isRecord(value) || !isUtc(value.observed_at_utc)) {
    return false;
  }
  if (value.status === 'completed') {
    return (
      hasExactly(value, COMPLETED_KEYS) &&
      isReport(value.report) &&
      Array.isArray(value.alerts) &&
      value.alerts.every(isAlert)
    );
  }
  if (value.status === 'failed') {
    return (
      hasExactly(value, FAILED_KEYS) &&
      matches(CODE, value.reason) &&
      (value.code === null || matches(CODE, value.code))
    );
  }
  return false;
}

/**
 * La respuesta como `DataHealth` si cumple el contrato, o `null`. Sin log activo no hay observación,
 * como comprueba el contrato.
 */
export function readDataHealth(value: unknown): DataHealth | null {
  if (!isRecord(value) || !hasExactly(value, DATA_HEALTH_KEYS)) {
    return null;
  }
  const { log, observation } = value;
  const validLog =
    log === null ||
    (typeof log === 'number' && Number.isInteger(log) && log >= 1 && log <= MAX_LOG_NUMBER);
  if (!validLog) {
    return null;
  }
  if (observation === null) {
    return value as DataHealth;
  }
  return log !== null && isObservation(observation) ? (value as DataHealth) : null;
}
