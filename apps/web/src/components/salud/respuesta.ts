/**
 * La forma de la respuesta de `GET /api/v1/datos/salud` (`DataHealth`, ADR-0019 §8), comprobada en
 * el navegador antes de dibujarla: la web valida en runtime lo que recibe (CONTRIBUTING, «Reglas de
 * implementación»). No usa el esquema de `@buoh/contracts`, cuya entrada principal carga módulos de
 * Node (`node:crypto`, `node:fs`) que no van al navegador: comprueba los campos que dibujan la barra
 * superior y el Observatorio, con sus valores del contrato. Lo que no pasa es una respuesta
 * inesperada, nunca un estado inventado.
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

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/** Un instante UTC con milisegundos, como `UtcTimestampMs`. */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Un código saneado de `buoh-operaciones`: nunca un mensaje (contratos de dominio, `DataHealth`). */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKeyOf<T extends object>(table: T, value: unknown): value is keyof T {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function isUtc(value: unknown): value is string {
  return typeof value === 'string' && UTC_MS.test(value) && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCode(value: unknown): value is string {
  return typeof value === 'string' && CODE.test(value);
}

function isReport(value: unknown): value is HealthReport {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    value.execution_mode === 'disabled' &&
    isKeyOf(SERVICE_HEALTHS, value.service_health) &&
    isKeyOf(CONNECTION_STATES, value.connection_state) &&
    isCount(value.backlog_count) &&
    isCount(value.backlog_bytes) &&
    (value.last_observation_id === null || typeof value.last_observation_id === 'string') &&
    (value.last_received_at_utc === null || isUtc(value.last_received_at_utc)) &&
    (value.last_event_time_utc === null || isUtc(value.last_event_time_utc)) &&
    (value.last_published_dataset_id === null ||
      typeof value.last_published_dataset_id === 'string') &&
    Array.isArray(value.open_condition_types) &&
    value.open_condition_types.every((type) => isKeyOf(CONDITION_TYPES, type))
  );
}

function isAlert(value: unknown): boolean {
  return isRecord(value) && isCode(value.event) && (value.reason === null || isCode(value.reason));
}

function isObservation(value: unknown): boolean {
  if (!isRecord(value) || !isUtc(value.observed_at_utc)) {
    return false;
  }
  if (value.status === 'completed') {
    return isReport(value.report) && Array.isArray(value.alerts) && value.alerts.every(isAlert);
  }
  if (value.status === 'failed') {
    return isCode(value.reason) && (value.code === null || isCode(value.code));
  }
  return false;
}

/**
 * La respuesta como `DataHealth` si tiene su forma, o `null`. Sin log activo no hay observación,
 * como comprueba el contrato.
 */
export function readDataHealth(value: unknown): DataHealth | null {
  if (!isRecord(value)) {
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
