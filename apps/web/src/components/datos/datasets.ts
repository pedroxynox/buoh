/**
 * Los textos de los datasets publicados en la sección Datos (concepto de interfaz §14): el período,
 * cómo terminó, sus incidencias y el resultado de cada verificación, con los valores de la base.
 */
import type { DataDataset } from '@buoh/contracts';
import { formatUtc } from '@buoh/prototype-data';

type IncidentType = DataDataset['incidents'][number]['incident_type'];
type ConditionType = DataDataset['open_condition_types'][number];
type Verification = DataDataset['verifications']['verify_only'];

/** El nombre de cada tipo de incidencia, en singular y en plural. */
const INCIDENT_NAMES: Readonly<Record<IncidentType, readonly [string, string]>> = {
  invalid_source_frame: ['mensaje no válido', 'mensajes no válidos'],
  duplicate_exact: ['duplicado exacto', 'duplicados exactos'],
  source_time_conflict: ['conflicto de hora de fuente', 'conflictos de hora de fuente'],
  out_of_order: ['tick fuera de orden', 'ticks fuera de orden'],
  delivery_delayed: ['entrega retrasada', 'entregas retrasadas'],
  connection_lost: ['conexión perdida', 'conexiones perdidas'],
  event_gap_unresolved: ['hueco sin resolver', 'huecos sin resolver'],
  persistence_unavailable: ['persistencia no disponible', 'persistencias no disponibles'],
  source_limit_exceeded: ['límite de fuente superado', 'límites de fuente superados'],
};

/** El nombre de cada condición abierta y si es femenino, para «abierta» o «abierto». */
const CONDITION_NAMES: Readonly<Record<ConditionType, readonly [string, boolean]>> = {
  connection_lost: ['conexión perdida', true],
  event_gap_unresolved: ['hueco sin resolver', false],
  persistence_unavailable: ['persistencia no disponible', true],
  source_limit_exceeded: ['límite de fuente superado', false],
};

/** Una lista en español: «a», «a y b», «a, b y c». */
function spanishList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`;
}

/** El período de sus ticks, en UTC, o «Sin ticks». */
export function datasetPeriod(dataset: DataDataset): string {
  return dataset.event_time_from_utc === null || dataset.event_time_to_utc === null
    ? 'Sin ticks'
    : `${formatUtc(dataset.event_time_from_utc)} – ${formatUtc(dataset.event_time_to_utc)}`;
}

/**
 * Cómo terminó (ADR-0020 §7): «Limpio», o lo que su derivación dejó abierto, la continuidad
 * pendiente de cada símbolo y las condiciones abiertas.
 */
export function datasetEnd(dataset: DataDataset): string {
  if (dataset.clean && dataset.open_condition_types.length === 0) {
    return 'Limpio';
  }
  const parts: string[] = [];
  if (dataset.pending_continuity_symbols.length > 0) {
    parts.push(`continuidad pendiente de ${spanishList(dataset.pending_continuity_symbols)}`);
  }
  const open = dataset.open_condition_types;
  if (open.length === 1 && open[0] !== undefined) {
    const [name, feminine] = CONDITION_NAMES[open[0]];
    parts.push(`${name} ${feminine ? 'abierta' : 'abierto'}`);
  } else if (open.length > 1) {
    parts.push(`${spanishList(open.map((type) => CONDITION_NAMES[type][0]))} abiertos`);
  }
  return `${dataset.clean ? 'Limpio, con' : 'Con algo abierto:'} ${spanishList(parts)}`;
}

/** Cuántas incidencias tiene y de qué tipos, o «Ninguna». */
export function datasetIncidents(dataset: DataDataset): string {
  if (dataset.incident_count === 0) {
    return 'Ninguna';
  }
  const byType = new Map<IncidentType, number>();
  for (const item of dataset.incidents) {
    byType.set(item.incident_type, (byType.get(item.incident_type) ?? 0) + item.count);
  }
  const parts = [...byType].map(([type, count]) => {
    const [one, many] = INCIDENT_NAMES[type];
    return `${String(count)} ${count === 1 ? one : many}`;
  });
  return `${String(dataset.incident_count)}: ${parts.join(', ')}`;
}

/** El último resultado de un modo de la verificación (ADR-0020 §8, paso 7). */
export function verificationText(verification: Verification): string {
  if (verification === null) {
    return 'Pendiente';
  }
  switch (verification.status) {
    case 'passed':
      return 'Pasó';
    case 'failed':
      return `Falló: ${verification.error_code ?? ''}`;
    case 'incomplete':
      return verification.error_code === null
        ? 'Sin resultado'
        : `Sin resultado: ${verification.error_code}`;
  }
}
