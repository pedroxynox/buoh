import type { SourceEvent } from '@buoh/contracts';
import { deriveBatchLog, type BatchLogConfig } from '@buoh/domain';

import type { RoundProfileKind } from '../deriv/batch-profile.js';
import { closesHistoryBlock, historyAnswersIn, type HistoryPlan } from '../deriv/history-pages.js';
import { cutTimeOf } from '../log-cut.js';
import type { ClosedSourceSegment } from '../source-log/ports.js';
import { DATASET_ELEMENT_CEILING, type DatasetPlan } from './plan.js';

// Dónde termina cada dataset de una secuencia por lotes (ADR-0021 §3; precisión del PR 5d2 de su
// §9). Como en los datasets vivos (ADR-0020 §7), un dataset es un rango contiguo de segmentos
// cerrados de un solo log, que empieza en el segmento siguiente al último del anterior; aquí termina
// en la marca de su clase, sin buscar un final limpio, porque las reglas de los lotes no derivan
// condiciones ni continuidad. Publicarlo es de quien lo llama.

/**
 * Segmentos como mucho de un dataset de los lotes: los de un dataset vivo de 6 horas, en segmentos de
 * 5 minutos, con los que se midió en producción que la publicación (como mucho 20,2 s) y la
 * verificación en los dos modos (como mucho 40,8 s) caben en los 60 s de su paso (evidencia de los
 * datasets vivos, «Memoria y duración de cada proceso»).
 */
export const BATCH_DATASET_SEGMENT_CEILING = 72;

/** Las marcas de las cotizaciones: cada 3 horas desde la medianoche UTC, unos 72 segmentos. */
const QUOTES_MARK_MS = 3 * 3_600_000;
/** Las marcas de las velas: cada medianoche UTC, un día de velas con su horario. */
const CANDLES_MARK_MS = 24 * 3_600_000;

/** Lo que el plan necesita de cada segmento cerrado: su índice, su hora y sus respuestas. */
export type BatchPlanSegment = Pick<
  ClosedSourceSegment,
  'first_event_time_utc' | 'raw_frame_count' | 'segment_index'
>;

export interface PlanBatchDatasetInput {
  /** Elementos como mucho; por defecto, `DATASET_ELEMENT_CEILING`. */
  readonly ceiling?: number | undefined;
  /** Los segmentos cerrados del log desde `from`, en orden y contiguos. */
  readonly closedSegments: readonly BatchPlanSegment[];
  /** Los elementos de un segmento (`batchElementsOf`). */
  readonly elementsOf: (events: readonly SourceEvent[]) => number;
  /** El primer segmento del dataset. */
  readonly from: number;
  /** La clase de la secuencia, que decide sus marcas (`nextBatchMark`). */
  readonly kind: RoundProfileKind;
  /** El log terminó: su sucesor ya tiene escrituras (ADR-0018 §6), así que no recibe más segmentos. */
  readonly logTerminated: boolean;
  /** Lee los source events de un segmento cerrado, verificados. */
  readonly readSegment: (index: number) => Promise<readonly SourceEvent[]>;
  /** Segmentos como mucho; por defecto, `BATCH_DATASET_SEGMENT_CEILING`. Solo para pruebas. */
  readonly segmentCeiling?: number;
}

/**
 * La primera marca posterior a `instantUtc` de la clase (precisión del PR 5d2 de ADR-0021 §9): de las
 * cotizaciones, cada 3 horas desde la medianoche UTC; de las velas, la medianoche UTC siguiente; y de
 * los horarios, el lunes siguiente a las 00:00 UTC, como el corte de un log (`cutTimeOf`).
 */
export function nextBatchMark(kind: RoundProfileKind, instantUtc: string): number {
  const at = Date.parse(instantUtc);
  if (Number.isNaN(at)) {
    throw new TypeError('La hora de un segmento es una hora UTC válida.');
  }
  switch (kind) {
    case 'quotes':
      return (Math.floor(at / QUOTES_MARK_MS) + 1) * QUOTES_MARK_MS;
    case 'candles':
      return (Math.floor(at / CANDLES_MARK_MS) + 1) * CANDLES_MARK_MS;
    case 'schedules':
      return Date.parse(cutTimeOf(instantUtc));
  }
}

/**
 * Los elementos de un segmento de los lotes (ADR-0021 §3): los registros que dan sus respuestas con
 * las reglas de los lotes (ticks, velas, horarios, ofertas y cotizaciones) más sus respuestas que no
 * dan ninguno, como un error. Cuenta el segmento solo, así que un registro repetido en otro segmento,
 * que en el dataset es una incidencia, cuenta en los dos: la suma de los segmentos no baja de los
 * elementos del dataset.
 */
export function batchElementsOf(events: readonly SourceEvent[], config: BatchLogConfig): number {
  const derived = deriveBatchLog(events, config);
  const records = [
    ...derived.ticks,
    ...derived.candles,
    ...derived.sessions,
    ...derived.offers,
    ...derived.quotes,
  ];
  const answered = new Set(records.map((record) => record.observation_id));
  const empty = events.filter(
    (event) => event.kind === 'raw_source_frame' && !answered.has(event.observation_id),
  ).length;
  return records.length + empty;
}

/**
 * Decide dónde termina el dataset de los lotes que empieza en `from` (precisión del PR 5d2 de
 * ADR-0021 §9):
 *
 * - su marca *M* es la primera de su clase posterior a la hora del primer evento de `from`
 *   (`nextBatchMark`), y su final, el último segmento que empieza antes de *M*. Se conoce cuando el
 *   log tiene cerrado uno que empieza en *M* o después, o, en un log terminado, es su último
 *   segmento;
 * - termina antes si llega a `BATCH_DATASET_SEGMENT_CEILING` segmentos, o en el último segmento que
 *   cabe en el techo de elementos (`elementsOf`). El resto va al dataset siguiente.
 *
 * Mientras no se conoce su final, no lee nada, salvo si sus respuestas ya pasan el techo: cada una
 * cuenta al menos un elemento. Lee los segmentos de uno en uno, solo hasta su final, y nunca más
 * allá del techo. Su derivación no deja nada abierto: es `clean`, sin condiciones ni continuidad.
 */
export async function planBatchDataset(input: PlanBatchDatasetInput): Promise<DatasetPlan> {
  const ceiling = input.ceiling ?? DATASET_ELEMENT_CEILING;
  const segmentCeiling = input.segmentCeiling ?? BATCH_DATASET_SEGMENT_CEILING;
  const rows = input.closedSegments;
  rows.forEach((row, offset) => {
    if (row.segment_index !== input.from + offset) {
      throw new TypeError(
        `Los segmentos cerrados tienen que ser contiguos desde ${String(input.from)}.`,
      );
    }
    if (Number.isNaN(Date.parse(row.first_event_time_utc))) {
      throw new TypeError(`El segmento ${String(row.segment_index)} no tiene una hora válida.`);
    }
  });
  const first = rows[0];
  if (first === undefined) {
    return input.logTerminated
      ? { status: 'nothing_due' }
      : { reason: 'awaiting_segments', status: 'not_due' };
  }
  const lastClosed = input.from + rows.length - 1;
  const mark = nextBatchMark(input.kind, first.first_event_time_utc);
  const startsBefore = rows.filter((row) => Date.parse(row.first_event_time_utc) < mark);

  let end: number;
  if (startsBefore.length < rows.length) {
    // La marca se alcanzó, y el primer segmento siempre empieza antes que ella.
    end = startsBefore.at(-1)?.segment_index ?? input.from;
  } else if (input.logTerminated || rows.length >= segmentCeiling) {
    end = lastClosed;
  } else {
    const responses = rows.reduce((sum, row) => sum + row.raw_frame_count, 0);
    if (responses <= ceiling) {
      return { reason: 'mark_not_reached', status: 'not_due' };
    }
    // Las respuestas ya pasan el techo, así que leer hasta el último cerrado lo alcanza.
    end = lastClosed;
  }
  end = Math.min(end, input.from + segmentCeiling - 1);

  const segments: (readonly SourceEvent[])[] = [];
  let elements = 0;
  for (let index = input.from; index <= end; index += 1) {
    const events = await input.readSegment(index);
    const added = input.elementsOf(events);
    if (elements + added > ceiling) {
      if (segments.length === 0) {
        return { elements: added, segment_index: input.from, status: 'segment_too_large' };
      }
      break;
    }
    segments.push(events);
    elements += added;
  }
  return {
    clean: true,
    elements,
    from: input.from,
    open: { open_condition_types: [], pending_continuity_symbols: [] },
    segments,
    status: 'due',
    to: input.from + segments.length - 1,
  };
}

export interface PlanHistoryDatasetInput extends Omit<PlanBatchDatasetInput, 'kind'> {
  /** Las peticiones de la historia de la secuencia, con sus bloques (`historyPlan`). */
  readonly plan: HistoryPlan;
}

/**
 * Decide dónde termina el dataset de una historia que empieza en `from` (precisión del PR 6c de
 * ADR-0021 §9): un bloque cada uno. El comando de la historia cierra el segmento al terminar cada
 * bloque y antes de seguir uno que dejó a medias, así que ningún segmento mezcla dos bloques, y el
 * dataset termina en el primer segmento desde `from` con la respuesta del último tramo de un bloque
 * (`closesHistoryBlock`), sea una página o un error de Deriv. Termina antes, sin ella, en el último
 * segmento de un log terminado, en `BATCH_DATASET_SEGMENT_CEILING` segmentos o en el último que cabe
 * en el techo de elementos. Sin ninguno de esos finales, todavía no (`awaiting_segments`). Lee los
 * segmentos de uno en uno, solo hasta su final. Su derivación no deja nada abierto, como la de
 * `planBatchDataset`.
 */
export async function planHistoryDataset(input: PlanHistoryDatasetInput): Promise<DatasetPlan> {
  const ceiling = input.ceiling ?? DATASET_ELEMENT_CEILING;
  const segmentCeiling = input.segmentCeiling ?? BATCH_DATASET_SEGMENT_CEILING;
  const rows = input.closedSegments;
  rows.forEach((row, offset) => {
    if (row.segment_index !== input.from + offset) {
      throw new TypeError(
        `Los segmentos cerrados tienen que ser contiguos desde ${String(input.from)}.`,
      );
    }
  });
  if (rows.length === 0) {
    return input.logTerminated
      ? { status: 'nothing_due' }
      : { reason: 'awaiting_segments', status: 'not_due' };
  }
  const last = input.from + Math.min(rows.length, segmentCeiling) - 1;
  const segments: (readonly SourceEvent[])[] = [];
  let elements = 0;
  let closed = false;
  for (let index = input.from; index <= last && !closed; index += 1) {
    const events = await input.readSegment(index);
    const added = input.elementsOf(events);
    if (elements + added > ceiling) {
      if (segments.length === 0) {
        return { elements: added, segment_index: input.from, status: 'segment_too_large' };
      }
      closed = true;
      break;
    }
    segments.push(events);
    elements += added;
    closed = historyAnswersIn(events, input.plan.profile).some(
      (answer) =>
        answer.kind === 'tranche' && closesHistoryBlock(input.plan, answer.start, answer.end),
    );
  }
  // Sin el último tramo, un log terminado ya está entero; en el techo, el resto va al siguiente.
  if (!closed && !input.logTerminated && segments.length < segmentCeiling) {
    return { reason: 'awaiting_segments', status: 'not_due' };
  }
  return {
    clean: true,
    elements,
    from: input.from,
    open: { open_condition_types: [], pending_continuity_symbols: [] },
    segments,
    status: 'due',
    to: input.from + segments.length - 1,
  };
}
