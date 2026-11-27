/**
 * Los textos de los datasets publicados en la sección Datos (concepto de interfaz §14): el nombre y
 * el intervalo de cada secuencia, el período, los registros, cómo terminó, sus incidencias y el
 * resultado de cada verificación, con los valores de la base.
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
  contract_rejected: ['contrato rechazado', 'contratos rechazados'],
  candle_repeated: ['vela repetida', 'velas repetidas'],
  candle_missing: ['tramo sin velas', 'tramos sin velas'],
  tick_gap: ['tramo sin ticks', 'tramos sin ticks'],
};

/**
 * El nombre de cada secuencia que se conoce (ADR-0021 §1 y §3). Una que la web no conoce se muestra
 * con su nombre tal cual.
 */
const SEQUENCE_NAMES: Readonly<Record<string, string>> = {
  R_100: 'R_100 en vivo',
  frxXAUUSD: 'Oro en vivo (frxXAUUSD)',
  lotes_horarios: 'Lotes: horarios y contratos',
  lotes_cotizaciones: 'Lotes: cotizaciones',
  lotes_velas: 'Lotes: velas de 1 minuto',
  lotes_historia_r_100: 'Historia: R_100, un año de ticks',
  lotes_historia_frxxauusd: 'Historia: oro (frxXAUUSD), un año de ticks',
};

/**
 * Cuánto cubre cada dataset de una secuencia y cuándo llega uno nuevo (ADR-0020 §7; ADR-0021 §9,
 * precisión del PR 5d2), o `null` si la web no conoce la secuencia.
 */
const SEQUENCE_INTERVALS: Readonly<Record<string, string>> = {
  R_100:
    'Cada dataset tiene unas 6 horas de captura, cortadas cerca de las 00:00, 06:00, 12:00 o 18:00 UTC, y uno nuevo suele llegar poco después de esas horas.',
  lotes_horarios:
    'Cada dataset tiene una semana de horarios y de contratos ofrecidos, cortada el lunes a las 00:00 UTC.',
  lotes_cotizaciones:
    'Cada dataset tiene unas 3 horas de cotizaciones, cortadas cada 3 horas desde la medianoche UTC.',
  lotes_velas:
    'Cada dataset tiene un día de velas de 1 minuto, cortado a la medianoche UTC, con el horario de ese día.',
  lotes_historia_r_100:
    'Cada dataset tiene un bloque de hasta 6 horas de ticks del año anterior a la captura en vivo, con el horario de su día.',
  lotes_historia_frxxauusd:
    'Cada dataset tiene un bloque de hasta 4 horas de ticks del año anterior a la captura en vivo, con el horario de su día.',
};

/** El nombre de la secuencia, o su nombre tal cual si la web no la conoce. */
export function sequenceTitle(sequence: string): string {
  return Object.hasOwn(SEQUENCE_NAMES, sequence)
    ? (SEQUENCE_NAMES[sequence] ?? sequence)
    : sequence;
}

/** Cuánto cubre cada dataset de la secuencia, o `null` si la web no la conoce. */
export function sequenceInterval(sequence: string): string | null {
  return Object.hasOwn(SEQUENCE_INTERVALS, sequence)
    ? (SEQUENCE_INTERVALS[sequence] ?? null)
    : null;
}

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

/**
 * El período, en UTC: el de sus ticks, o, en un dataset de los lotes, el de sus velas, por su hora de
 * apertura. Sin ninguno, «Sin ticks», o «Sin ticks ni velas» en uno de los lotes, cuyas cotizaciones
 * y horarios se recorren por su recepción y no tienen período en el manifiesto.
 */
export function datasetPeriod(dataset: DataDataset): string {
  if (dataset.event_time_from_utc !== null && dataset.event_time_to_utc !== null) {
    return `${formatUtc(dataset.event_time_from_utc)} – ${formatUtc(dataset.event_time_to_utc)}`;
  }
  const { batch } = dataset;
  if (batch === null) {
    return 'Sin ticks';
  }
  return batch.candle_time_from_utc === null || batch.candle_time_to_utc === null
    ? 'Sin ticks ni velas'
    : `Velas de ${formatUtc(batch.candle_time_from_utc)} – ${formatUtc(batch.candle_time_to_utc)}`;
}

/** Un conteo con su nombre en singular o en plural. */
function counted(count: number, [one, many]: readonly [string, string]): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * Cuántos registros tiene: sus ticks y, en un dataset de los lotes, sus velas, horarios, ofertas de
 * contratos y cotizaciones, los que tiene. «Ninguno» si no tiene ninguno.
 */
export function datasetRecords(dataset: DataDataset): string {
  const { batch } = dataset;
  if (batch === null) {
    return counted(dataset.normalized_tick_count, ['tick', 'ticks']);
  }
  const parts = (
    [
      [dataset.normalized_tick_count, ['tick', 'ticks']],
      [batch.market_candle_count, ['vela', 'velas']],
      [batch.trading_session_count, ['horario', 'horarios']],
      [batch.contract_offer_count, ['oferta de contratos', 'ofertas de contratos']],
      [batch.contract_quote_count, ['cotización', 'cotizaciones']],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, names]) => counted(count, names));
  return parts.length === 0 ? 'Ninguno' : spanishList(parts);
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
  const parts = [...byType].map(([type, count]) => counted(count, INCIDENT_NAMES[type]));
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
