import type { SourceEvent } from '@buoh/contracts';
import { deriveMarketData, type PipelineProfile } from '@buoh/domain';

import type { ClosedSourceSegment } from '../source-log/ports.js';

// Dónde termina cada dataset vivo (ADR-0020 §7). Un dataset es un rango contiguo de segmentos
// cerrados de un solo log, que empieza en el segmento siguiente al último del anterior. Este módulo
// decide su último segmento; publicarlo es de quien lo llama.

/** Elementos como mucho de un dataset: sus source events más los ticks que recupera la historia. */
export const DATASET_ELEMENT_CEILING = 16_000;
/** Los finales posibles después del objetivo: uno cada 6 segmentos, unos 30 minutos. */
export const DATASET_END_STEP_SEGMENTS = 6;
/** Las marcas de un dataset: las 00:00, 06:00, 12:00 y 18:00 UTC. */
const MARK_MS = 6 * 3_600_000;

/** Lo que el plan necesita de cada segmento cerrado: su índice, sus eventos y la hora del primero. */
export type PlanSegment = Pick<
  ClosedSourceSegment,
  'event_count' | 'first_event_time_utc' | 'segment_index'
>;

export interface PlanDatasetInput {
  /** Elementos como mucho; por defecto, `DATASET_ELEMENT_CEILING`. */
  readonly ceiling?: number | undefined;
  /** Los segmentos cerrados del log desde `from`, en orden y contiguos. */
  readonly closedSegments: readonly PlanSegment[];
  /** El primer segmento del dataset. */
  readonly from: number;
  /** El log terminó: su sucesor ya tiene escrituras (ADR-0018 §6), así que no recibe más segmentos. */
  readonly logTerminated: boolean;
  /** El perfil con el que se publica; su derivación decide si un final es limpio. */
  readonly profile: PipelineProfile;
  /** Lee los source events de un segmento cerrado, verificados. */
  readonly readSegment: (index: number) => Promise<readonly SourceEvent[]>;
}

/** Lo que dejó abierto la derivación del dataset en su último segmento. */
export interface DatasetOpenState {
  readonly open_condition_types: readonly string[];
  readonly pending_continuity_symbols: readonly string[];
}

export type DatasetPlan =
  | {
      /** Si su derivación termina sin continuidad pendiente ni `connection_lost` abierta. */
      readonly clean: boolean;
      /** Sus source events más el `recovered_event_count` de sus resultados `complete`. */
      readonly elements: number;
      readonly from: number;
      readonly open: DatasetOpenState;
      /** Los source events de cada segmento, de `from` a `to`. */
      readonly segments: readonly (readonly SourceEvent[])[];
      readonly status: 'due';
      readonly to: number;
    }
  /**
   * Todavía no: el log no tiene cerrado un segmento que empiece en la marca o después
   * (`mark_not_reached`), o le faltan los segmentos del final posible siguiente (`awaiting_segments`).
   */
  | { readonly reason: 'awaiting_segments' | 'mark_not_reached'; readonly status: 'not_due' }
  /** Un log terminado sin segmentos desde `from`: no queda nada que publicar. */
  | { readonly status: 'nothing_due' }
  /**
   * El primer segmento pasa el techo por sí solo: no se carga (`publication_segment_too_large`).
   */
  | {
      readonly elements: number;
      readonly segment_index: number;
      readonly status: 'segment_too_large';
    };

/** Los elementos de un segmento: sus source events más los ticks que recuperan sus resultados. */
function elementsOf(events: readonly SourceEvent[]): number {
  let recovered = 0;
  for (const event of events) {
    if (event.kind === 'history_recovery_result' && event.status === 'complete') {
      recovered += event.recovered_event_count;
    }
  }
  return events.length + recovered;
}

/** La primera marca posterior a `instantUtc`: múltiplos de 6 horas desde la medianoche UTC. */
function nextMark(instantUtc: string): number {
  return (Math.floor(Date.parse(instantUtc) / MARK_MS) + 1) * MARK_MS;
}

/**
 * Decide dónde termina el dataset que empieza en `from` (ADR-0020 §7):
 *
 * - su marca *M* es la primera posterior a la hora del primer evento de `from`, y su objetivo *t*, el
 *   último segmento que empieza antes de *M*. Se conoce cuando el log tiene cerrado uno que empieza en
 *   *M* o después, o, en un log terminado, es su último segmento;
 * - los finales posibles son *t* y uno cada 6 segmentos después, mientras quepan en el techo, y en un
 *   log terminado también su último segmento, que es el último;
 * - termina en el primero tras el cual su derivación (`deriveMarketData`, desde el estado vacío en
 *   `from`) no deja continuidad pendiente ni `connection_lost` abierta. Una `event_gap_unresolved`
 *   abierta no cuenta;
 * - si ninguno es limpio, termina en el último segmento que cabe en el techo, o en el último del log
 *   si está terminado, con lo que quedó abierto.
 *
 * Lee los segmentos de uno en uno, solo hasta donde lo necesita, y nunca más allá del techo. Lanza lo
 * que lance la derivación, como una que aborta.
 */
export async function planDataset(input: PlanDatasetInput): Promise<DatasetPlan> {
  const ceiling = input.ceiling ?? DATASET_ELEMENT_CEILING;
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

  const mark = nextMark(first.first_event_time_utc);
  const startsBefore = rows.filter((row) => Date.parse(row.first_event_time_utc) < mark);
  const reachedMark = startsBefore.length < rows.length;

  // Los segmentos leídos, de `from` en adelante, mientras quepan en el techo.
  const segments: (readonly SourceEvent[])[] = [];
  const cumulative: number[] = [];
  // Si el segmento siguiente ya no cabe en el techo, y sus elementos.
  const reading = { ceilingReached: false, overflowElements: 0 };
  const readUpTo = async (index: number): Promise<void> => {
    while (!reading.ceilingReached && input.from + segments.length <= Math.min(index, lastClosed)) {
      const events = await input.readSegment(input.from + segments.length);
      const total = (cumulative.at(-1) ?? 0) + elementsOf(events);
      if (total > ceiling) {
        reading.ceilingReached = true;
        reading.overflowElements = elementsOf(events);
        return;
      }
      segments.push(events);
      cumulative.push(total);
    }
  };

  const derive = (to: number) => {
    const derived = deriveMarketData(segments.slice(0, to - input.from + 1), input.profile);
    return {
      clean:
        derived.pendingContinuitySymbols.length === 0 &&
        !derived.openConditionTypes.includes('connection_lost'),
      open: {
        open_condition_types: derived.openConditionTypes,
        pending_continuity_symbols: derived.pendingContinuitySymbols,
      },
    };
  };
  const due = (to: number, state: ReturnType<typeof derive>): DatasetPlan => ({
    clean: state.clean,
    elements: cumulative[to - input.from] ?? 0,
    from: input.from,
    open: state.open,
    segments: segments.slice(0, to - input.from + 1),
    status: 'due',
    to,
  });

  const tooLarge = (): DatasetPlan => ({
    elements: reading.overflowElements,
    segment_index: input.from,
    status: 'segment_too_large',
  });
  if (!reachedMark && !input.logTerminated) {
    // Todos los segmentos cerrados empiezan antes de la marca, así que el objetivo es uno de ellos o
    // uno posterior. Si el techo llega antes, ningún final posible cabe: el dataset ya está decidido.
    // Para no leer los segmentos en cada ejecución, solo los lee si sus source events, que dan las
    // filas, ya pasan el techo; si lo pasan solo con los ticks recuperados, espera a la marca
    // (precisión del PR 3a de ADR-0020 §7).
    const events = rows.reduce((sum, row) => sum + row.event_count, 0);
    if (events <= ceiling) {
      return { reason: 'mark_not_reached', status: 'not_due' };
    }
    // Los source events pasan el techo, así que leer hasta el último cerrado lo alcanza.
    await readUpTo(lastClosed);
    if (segments.length === 0) {
      return tooLarge();
    }
    const lastRead = input.from + segments.length - 1;
    return due(lastRead, derive(lastRead));
  }
  await readUpTo(input.from);
  if (segments.length === 0) {
    return tooLarge();
  }
  // Con la marca alcanzada, el primer segmento siempre empieza antes que ella; en un log terminado
  // sin alcanzarla, el objetivo es su último segmento.
  const target = reachedMark ? (startsBefore.at(-1)?.segment_index ?? input.from) : lastClosed;

  for (let candidate = target; ; candidate += DATASET_END_STEP_SEGMENTS) {
    await readUpTo(candidate);
    const lastRead = input.from + segments.length - 1;
    if (candidate > lastRead) {
      if (reading.ceilingReached) {
        // Ninguno de los finales posibles que caben fue limpio: el último segmento que cabe.
        return due(lastRead, derive(lastRead));
      }
      if (!input.logTerminated) {
        return { reason: 'awaiting_segments', status: 'not_due' };
      }
      // En un log terminado, su último segmento es el último final posible.
      return due(lastRead, derive(lastRead));
    }
    const state = derive(candidate);
    if (state.clean) {
      return due(candidate, state);
    }
  }
}
