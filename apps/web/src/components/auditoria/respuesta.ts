/**
 * La forma de la respuesta de `GET /api/v1/datos/eventos` (`DataEvents`), comprobada en el navegador
 * antes de dibujarla (ADR-0019 §5 y §8; CONTRIBUTING, «Reglas de implementación»). Como las de la
 * salud y de Mercados, no usa los esquemas de `@buoh/contracts`, cuya entrada principal carga módulos
 * de Node, y repite sus reglas: objetos estrictos, los valores y formatos de cada campo, y las reglas
 * entre campos (los logs de mayor a menor, los eventos del más nuevo al más viejo y, salvo las
 * publicaciones, de un log leído, la lista cortada solo si está llena, el motivo solo en una resolución y la clave de cada condición).
 * Lo que no pasa es una respuesta inesperada, nunca un evento inventado. `test/auditoria.test.tsx`
 * la contrasta con el esquema.
 */
import type { DataEvent, DataEvents } from '@buoh/contracts';

/** Cuántos eventos trae como mucho (`DATA_EVENTS_LIMIT` de los contratos). */
export const DATA_EVENTS_LIMIT = 200;

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/** Los patrones de los escalares del contrato (`packages/contracts/src/scalars.ts` y `api.ts`). */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DERIVED_ID = /^sha256:[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONDITION_KEY =
  /^(?:connection_lost|event_gap_unresolved|persistence_unavailable|source_limit_exceeded):sha256:[0-9a-f]{64}$/u;
/** Un código saneado, como el motivo de una incidencia o de una resolución. */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

type IncidentEvent = Extract<DataEvent, { kind: 'incident' }>;
type ConditionEvent = Extract<DataEvent, { kind: 'condition' }>;

const SEVERITIES = {
  info: true,
  warning: true,
  error: true,
  critical: true,
} as const satisfies Record<IncidentEvent['severity'], true>;

const STAGES = {
  raw_object_write: true,
  source_event_index: true,
  normalized_object_write: true,
  incident_write: true,
  manifest_write: true,
  manifest_commit: true,
} as const satisfies Record<
  Extract<IncidentEvent, { incident_type: 'persistence_unavailable' }>['evidence']['stage'],
  true
>;

type LimitEvidence = Extract<IncidentEvent, { incident_type: 'source_limit_exceeded' }>['evidence'];

const RESOURCES = {
  websocket_frame: true,
  in_memory_queue_events: true,
  in_memory_queue_bytes: true,
  schema_archive: true,
  schema_entry: true,
  schema_entries: true,
  schema_expanded: true,
} as const satisfies Record<LimitEvidence['resource'], true>;

const UNITS = {
  bytes: true,
  events: true,
  entries: true,
} as const satisfies Record<LimitEvidence['unit'], true>;

const CONDITION_TYPES = {
  connection_lost: true,
  event_gap_unresolved: true,
  persistence_unavailable: true,
  source_limit_exceeded: true,
} as const satisfies Record<ConditionEvent['condition_type'], true>;

/** Los campos de cada objeto del contrato, que son estrictos: ni uno de más ni uno de menos. */
const RESPONSE_KEYS = [
  'events',
  'logs',
  'truncated',
] as const satisfies readonly (keyof DataEvents)[];
const BASE_KEYS = ['at_utc', 'kind', 'log', 'source'] as const;
const CATALOG_KEYS = [
  ...BASE_KEYS,
  'content_sha256',
  'entry_count',
  'snapshot_id',
  'version',
] as const satisfies readonly (keyof Extract<DataEvent, { kind: 'catalog_version' }>)[];
const PUBLICATION_KEYS = [
  ...BASE_KEYS,
  'dataset_id',
  'publication_id',
  'state',
] as const satisfies readonly (keyof Extract<DataEvent, { kind: 'publication' }>)[];
const INCIDENT_KEYS = [
  ...BASE_KEYS,
  'evidence',
  'incident_id',
  'incident_type',
  'severity',
  'symbol',
] as const satisfies readonly (keyof IncidentEvent)[];
const CONDITION_KEYS = [
  ...BASE_KEYS,
  'action',
  'condition_event_id',
  'condition_key',
  'condition_type',
  'resolution_reason',
  'symbol',
] as const satisfies readonly (keyof ConditionEvent)[];

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

function isLog(value: unknown): value is number {
  return isInteger(value, 1, MAX_LOG_NUMBER);
}

function isSymbol(value: unknown): boolean {
  return value === null || isNonEmpty(value);
}

function hasBase(value: Record<string, unknown>): boolean {
  return isLog(value.log) && isUtc(value.at_utc) && isNonEmpty(value.source);
}

function isEvidence(type: unknown, evidence: unknown): boolean {
  if (!isRecord(evidence)) {
    return false;
  }
  switch (type) {
    case 'persistence_unavailable':
      return (
        hasExactly(evidence, ['reason', 'stage']) &&
        isKeyOf(STAGES, evidence.stage) &&
        matches(CODE, evidence.reason)
      );
    case 'source_limit_exceeded':
      return (
        hasExactly(evidence, ['maximum_value', 'observed_value', 'resource', 'unit']) &&
        isKeyOf(RESOURCES, evidence.resource) &&
        isKeyOf(UNITS, evidence.unit) &&
        isInteger(evidence.observed_value, 0, Number.MAX_SAFE_INTEGER) &&
        isInteger(evidence.maximum_value, 0, Number.MAX_SAFE_INTEGER)
      );
    case 'invalid_source_frame':
      return (
        hasExactly(evidence, ['raw_payload_sha256', 'reason']) &&
        matches(CODE, evidence.reason) &&
        matches(SHA256, evidence.raw_payload_sha256)
      );
    default:
      return false;
  }
}

function isEvent(value: unknown): value is DataEvent {
  if (!isRecord(value) || !hasBase(value)) {
    return false;
  }
  switch (value.kind) {
    case 'catalog_version':
      return (
        hasExactly(value, CATALOG_KEYS) &&
        isInteger(value.version, 1, Number.MAX_SAFE_INTEGER) &&
        matches(DERIVED_ID, value.snapshot_id) &&
        matches(SHA256, value.content_sha256) &&
        isInteger(value.entry_count, 1, Number.MAX_SAFE_INTEGER)
      );
    case 'publication':
      return (
        hasExactly(value, PUBLICATION_KEYS) &&
        matches(DERIVED_ID, value.dataset_id) &&
        matches(UUID_V7, value.publication_id) &&
        (value.state === 'active' || value.state === 'superseded')
      );
    case 'incident':
      return (
        hasExactly(value, INCIDENT_KEYS) &&
        matches(DERIVED_ID, value.incident_id) &&
        isKeyOf(SEVERITIES, value.severity) &&
        isSymbol(value.symbol) &&
        isEvidence(value.incident_type, value.evidence)
      );
    case 'condition':
      return (
        hasExactly(value, CONDITION_KEYS) &&
        matches(DERIVED_ID, value.condition_event_id) &&
        matches(CONDITION_KEY, value.condition_key) &&
        isKeyOf(CONDITION_TYPES, value.condition_type) &&
        isSymbol(value.symbol) &&
        (value.action === 'opened' || value.action === 'resolved') &&
        (value.resolution_reason === null || matches(CODE, value.resolution_reason)) &&
        // Solo una resolución lleva su motivo, y la clave es la de su tipo de condición.
        (value.resolution_reason !== null) === (value.action === 'resolved') &&
        value.condition_key.startsWith(`${value.condition_type}:sha256:`)
      );
    default:
      return false;
  }
}

/** La respuesta como `DataEvents` si cumple el contrato, o `null`. */
export function readDataEvents(value: unknown): DataEvents | null {
  if (!isRecord(value) || !hasExactly(value, RESPONSE_KEYS)) {
    return null;
  }
  const { events, logs, truncated } = value;
  if (
    !Array.isArray(logs) ||
    !logs.every(isLog) ||
    !Array.isArray(events) ||
    events.length > DATA_EVENTS_LIMIT ||
    !events.every(isEvent) ||
    typeof truncated !== 'boolean'
  ) {
    return null;
  }
  const valid =
    // Los logs van de mayor a menor, sin repetir; solo se corta una lista llena; cada evento que no
    // es una publicación es de un log leído (las publicaciones no vencen: ADR-0020 §10), y van del
    // más nuevo al más viejo.
    logs.every((log, index) => index === 0 || log < (logs[index - 1] ?? 0)) &&
    (!truncated || events.length === DATA_EVENTS_LIMIT) &&
    events.every(
      (event, index) =>
        (event.kind === 'publication' || logs.includes(event.log)) &&
        (index === 0 || (events[index - 1]?.at_utc ?? '') >= event.at_utc),
    );
  return valid ? (value as unknown as DataEvents) : null;
}
