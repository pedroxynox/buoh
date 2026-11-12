/**
 * Los textos de los eventos de datos de la Auditoría (concepto de interfaz §12): una frase en español
 * para cada clase de evento y su detalle, con los valores oficiales del registro. Un motivo que la web
 * no conoce se muestra con su código, nunca se inventa.
 */
import type { DataEvent } from '@buoh/contracts';

type IncidentEvent = Extract<DataEvent, { kind: 'incident' }>;
type ConditionEvent = Extract<DataEvent, { kind: 'condition' }>;
type Stage = Extract<
  IncidentEvent,
  { incident_type: 'persistence_unavailable' }
>['evidence']['stage'];
type LimitEvidence = Extract<IncidentEvent, { incident_type: 'source_limit_exceeded' }>['evidence'];

/** Los tipos de condición, con los nombres de la causa de la salud (concepto de interfaz §10). */
export const CONDITION_TEXT: Readonly<Record<ConditionEvent['condition_type'], string>> = {
  connection_lost: 'Conexión perdida',
  event_gap_unresolved: 'Hueco sin resolver',
  persistence_unavailable: 'Persistencia no disponible',
  source_limit_exceeded: 'Límite de fuente superado',
};

const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  raw_object_write: 'guardar el mensaje de Deriv en el almacenamiento',
  source_event_index: 'anotar el evento en PostgreSQL',
  normalized_object_write: 'guardar los datos normalizados',
  incident_write: 'guardar una incidencia',
  manifest_write: 'guardar el manifiesto de un dataset',
  manifest_commit: 'confirmar la publicación de un dataset',
};

const RESOURCE_TEXT: Readonly<Record<LimitEvidence['resource'], string>> = {
  websocket_frame: 'Mensaje de Deriv',
  in_memory_queue_events: 'Cola en memoria',
  in_memory_queue_bytes: 'Cola en memoria',
  schema_archive: 'Archivo de esquemas de Deriv',
  schema_entry: 'Esquema de Deriv',
  schema_entries: 'Archivo de esquemas de Deriv',
  schema_expanded: 'Esquemas de Deriv descomprimidos',
};

const UNIT_TEXT: Readonly<Record<LimitEvidence['unit'], string>> = {
  bytes: 'bytes',
  events: 'eventos',
  entries: 'entradas',
};

/** Los motivos de una respuesta pedida inválida (migración `0004` del worker; ADR-0012 §6). */
const RESPONSE_REASON_TEXT: Readonly<Record<string, string>> = {
  catalog_duplicate_symbol: 'El catálogo trae un símbolo repetido',
  catalog_empty: 'El catálogo llegó vacío',
  catalog_entry_invalid: 'Una entrada del catálogo no es válida',
  catalog_exponent_not_supported: 'El catálogo trae un número con exponente',
  history_inconsistent: 'Una página de la historia es incoherente',
  schema_validation_failed: 'La respuesta no cumple su esquema',
  source_error_response: 'Deriv respondió con un error',
};

/** Los motivos con que el registro operativo resuelve una condición. */
const RESOLUTION_TEXT: Readonly<Record<string, string>> = {
  persistence_restored: 'La escritura volvió a confirmarse',
  input_reopened: 'La entrada se reabrió con una conexión nueva',
};

function known(table: Readonly<Record<string, string>>, code: string): string {
  return Object.hasOwn(table, code) ? (table[code] ?? code) : code;
}

const INCIDENT_TEXT: Readonly<Record<IncidentEvent['incident_type'], string>> = {
  persistence_unavailable: 'Persistencia no disponible',
  source_limit_exceeded: 'Límite de fuente superado',
  invalid_source_frame: 'Respuesta de Deriv no válida',
};

/** El evento en una frase corta. */
export function dataEventTitle(event: DataEvent): string {
  switch (event.kind) {
    case 'catalog_version':
      return `Versión ${String(event.version)} del catálogo`;
    case 'publication':
      return 'Dataset publicado';
    case 'incident':
      return INCIDENT_TEXT[event.incident_type];
    case 'condition':
      return `${event.action === 'opened' ? 'Condición abierta' : 'Condición resuelta'}: ${CONDITION_TEXT[event.condition_type]}`;
  }
}

function incidentDetail(event: IncidentEvent): string {
  switch (event.incident_type) {
    case 'persistence_unavailable':
      return `No se pudo ${STAGE_TEXT[event.evidence.stage]}: ${event.evidence.reason}`;
    case 'source_limit_exceeded': {
      const { maximum_value: maximum, observed_value: observed, resource, unit } = event.evidence;
      return `${RESOURCE_TEXT[resource]}: ${String(observed)} ${UNIT_TEXT[unit]}, con un máximo de ${String(maximum)}`;
    }
    case 'invalid_source_frame':
      return known(RESPONSE_REASON_TEXT, event.evidence.reason);
  }
}

function conditionDetail(event: ConditionEvent): string {
  return event.action === 'opened'
    ? 'Mientras siga abierta, la salud no es «Saludable»'
    : known(RESOLUTION_TEXT, event.resolution_reason ?? '');
}

/** Lo que dice el registro del evento, con sus valores y, si lo tiene, su símbolo. */
export function dataEventDetail(event: DataEvent): string {
  switch (event.kind) {
    case 'catalog_version':
      return `${String(event.entry_count)} instrumentos · contenido ${event.content_sha256.slice(0, 12)}…`;
    case 'publication':
      return `${event.dataset_id.slice(0, 19)}… · ${event.state === 'active' ? 'activo' : 'sustituido'}`;
    case 'incident':
      return `${incidentDetail(event)}${event.symbol === null ? '' : ` · ${event.symbol}`}`;
    case 'condition':
      return `${conditionDetail(event)}${event.symbol === null ? '' : ` · ${event.symbol}`}`;
  }
}

/** El identificador del evento, para la clave de su fila. */
export function dataEventId(event: DataEvent): string {
  switch (event.kind) {
    case 'catalog_version':
      return event.snapshot_id;
    case 'publication':
      return event.publication_id;
    case 'incident':
      return event.incident_id;
    case 'condition':
      return event.condition_event_id;
  }
}

/** Una lista de números en español: «4», «4 y 3», «4, 3 y 2». */
export function spanishList(values: readonly number[]): string {
  const texts = values.map(String);
  if (texts.length <= 1) {
    return texts.join('');
  }
  return `${texts.slice(0, -1).join(', ')} y ${texts.at(-1) ?? ''}`;
}
