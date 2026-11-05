/**
 * El gráfico de un símbolo en una ventana de tiempo, el que lee la API para la web (ADR-0019 §8;
 * concepto de interfaz §9): los ticks del flujo, cada uno en su hora de fuente, y los huecos que
 * marca el log, con su motivo. Lee solo los segmentos cerrados que tocan la ventana, cada uno
 * verificado por su hash, y el abierto, y toma de los puntos de control el estado vivo del principio
 * y del final de la ventana: nunca deriva el log entero.
 *
 * Un hueco es un período sin ticks del flujo que el log registra, con su motivo:
 * - **una conexión perdida** (`connection_lost`): tras un cierre no pedido, el rango que decide la
 *   historia (ADR-0015 §4), el de cada `HistoryRecoveryResult`. Con `complete`, la historia trae los
 *   ticks que faltan, que el gráfico no dibuja porque todavía no son `MarketTick` (ADR-0015 §4,
 *   «Ticks recuperados»); con `partial` o `unavailable`, el hueco queda sin resolver, con el motivo
 *   de su incidencia `event_gap_unresolved`. Mientras la historia no lo decide, el hueco pendiente
 *   del estado vivo del final (`liveDerivationView`), sin fin si todavía no llegó un tick después;
 * - **una parada pedida** (`capture_stopped`): tras un cierre `requested`, como el de un despliegue,
 *   hasta el primer tick posterior. No se recupera (ADR-0015, «Despliegue o reinicio programado»).
 *   Si la cubre un hueco de conexión, como cuando la parada llega con la continuidad pendiente, cuenta
 *   ese.
 *
 * Los dos van del high-watermark del símbolo + 1 ms al primer tick posterior − 1 ms, como los rangos
 * del dominio (`pendingGapOf`). El gráfico nunca deduce un hueco de la distancia entre dos ticks.
 */
import type { LiveDerivationState, SourceEvent } from '@buoh/contracts';
import {
  foldLiveDerivation,
  liveDerivationView,
  normalizeRawFrame,
  type PipelineProfile,
} from '@buoh/domain';

import type { LiveCheckpointBase, LiveCheckpointLookup } from './live-checkpoint.js';
import type { ClosedSegmentFinder, ClosedSourceSegment } from './ports.js';
import {
  failureReason,
  LogIntegrityError,
  LogNotDerivableError,
  LogReadError,
  type SourceEventLog,
} from './source-event-log.js';

/** Lo que un source event aporta al gráfico de un símbolo, en el orden del log. */
export type ChartItem =
  | {
      readonly kind: 'tick';
      /** La hora de fuente del tick, en milisegundos desde la época. */
      readonly time_ms: number;
      readonly quote_decimal: string;
      /** `tick_fingerprint_sha256`: decide entre dos ticks distintos del mismo instante. */
      readonly fingerprint: string;
    }
  /** Un cierre pedido de una conexión que tenía el símbolo. */
  | { readonly kind: 'stop' }
  /** Un `HistoryRecoveryResult` del símbolo. */
  | {
      readonly kind: 'recovery';
      readonly status: 'complete' | 'partial' | 'unavailable';
      readonly from_ms: number;
      readonly to_ms: number;
      /** `recovered_event_count`, o `null` con `unavailable`, que no lo lleva. */
      readonly recovered_ticks: number | null;
      /** El motivo de `partial` y `unavailable`, o `null` con `complete`. */
      readonly reason: string | null;
    };

/**
 * Lo que aportan al gráfico de `symbol` unos source events: sus ticks, normalizados con el perfil
 * de medición como en la derivación (`normalizeRawFrame`), sus cierres pedidos y sus resultados de
 * historia. Un frame que no da un tick del símbolo, como un `pong`, no aporta nada. Lanza lo que
 * lance el normalizador.
 */
export function chartItemsOf(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
  symbol: string,
): ChartItem[] {
  const items: ChartItem[] = [];
  for (const event of events) {
    switch (event.kind) {
      case 'raw_source_frame': {
        const result = normalizeRawFrame(event, profile);
        if (result.ok && result.tick.symbol === symbol) {
          items.push({
            fingerprint: result.tick.tick_fingerprint_sha256,
            kind: 'tick',
            quote_decimal: result.tick.quote_decimal,
            time_ms: Date.parse(result.tick.event_time_utc),
          });
        }
        break;
      }
      case 'connection_closed':
        if (event.closure_type === 'requested' && event.affected_symbols.includes(symbol)) {
          items.push({ kind: 'stop' });
        }
        break;
      case 'history_recovery_result':
        if (event.symbol === symbol) {
          items.push({
            from_ms: Date.parse(event.from_event_time_utc),
            kind: 'recovery',
            reason: event.status === 'complete' ? null : event.reason,
            recovered_ticks: event.status === 'unavailable' ? null : event.recovered_event_count,
            status: event.status,
            to_ms: Date.parse(event.to_event_time_utc),
          });
        }
        break;
      case 'connection_opened':
        break;
    }
  }
  return items;
}

/** Un hueco del gráfico, con su motivo. */
export interface ChartGap {
  /** El primer instante sin ticks: el high-watermark + 1 ms. */
  readonly from_ms: number;
  /** El último: el primer tick posterior − 1 ms, o `null` si todavía no llegó ninguno. */
  readonly to_ms: number | null;
  readonly cause: 'capture_stopped' | 'connection_lost';
  /**
   * Lo que dice el log de los ticks que faltan: `recovered`, `partial` o `unavailable`, del resultado
   * de la historia; `pending`, mientras no llega; `not_requested`, en una parada pedida.
   */
  readonly history: 'not_requested' | 'partial' | 'pending' | 'recovered' | 'unavailable';
  /** El motivo de `partial` y `unavailable`, el de su `event_gap_unresolved`; si no, `null`. */
  readonly reason: string | null;
  /** Los ticks que trajo la historia (`recovered_event_count`), con `recovered` y `partial`. */
  readonly recovered_ticks: number | null;
}

/** El gráfico de una ventana: sus ticks, en orden de hora, y sus huecos, en orden de inicio. */
export interface ChartWindow {
  readonly gaps: readonly ChartGap[];
  readonly ticks: readonly { readonly quote_decimal: string; readonly time_ms: number }[];
}

/** Lo que hace falta saber del estado vivo al principio de la ventana. */
export interface ChartBoundary {
  /** El high-watermark del símbolo, o `null` si el log todavía no tenía ningún tick suyo. */
  readonly watermark_ms: number | null;
  /**
   * Si la captura estaba parada a pedido: sin conexión en el log, sin continuidad pendiente del
   * símbolo y con algún tick antes.
   */
  readonly stopped: boolean;
}

/** El principio de la ventana para el gráfico, del estado vivo del final del segmento anterior. */
export function chartBoundaryOf(state: LiveDerivationState, symbol: string): ChartBoundary {
  const watermark = state.watermarks.find((item) => item.symbol === symbol)?.event_time_utc;
  const pending = state.pending_continuity.some((item) => item.symbol === symbol);
  const watermarkMs = watermark === undefined ? null : Date.parse(watermark);
  return {
    stopped: !state.connected_in_log && !pending && watermarkMs !== null,
    watermark_ms: watermarkMs,
  };
}

function overlaps(left: ChartGap, right: ChartGap): boolean {
  return (
    left.from_ms <= (right.to_ms ?? Number.POSITIVE_INFINITY) &&
    right.from_ms <= (left.to_ms ?? Number.POSITIVE_INFINITY)
  );
}

/**
 * El gráfico de la ventana `[from_ms, to_ms]` con lo que aportan sus segmentos, en el orden del log
 * (`chartItemsOf`), el principio de la ventana (`chartBoundaryOf`) y los huecos pendientes del
 * símbolo al final (`liveDerivationView`):
 * - un tick por instante de la ventana. Si llegó más de uno, como el que repite la suscripción al
 *   reconectar, el de menor `tick_fingerprint_sha256`, el primero en el orden canónico de un dataset;
 * - los huecos de los resultados de la historia; si dos tienen el mismo rango, como un `partial` y
 *   el `complete` que lo resuelve después, el último;
 * - los huecos pendientes;
 * - y las paradas pedidas que no cubre ninguno de esos.
 *
 * Solo quedan los huecos que tocan la ventana, aunque empiecen antes. Es una función pura.
 */
export function assembleChartWindow(input: {
  readonly from_ms: number;
  readonly to_ms: number;
  readonly start: ChartBoundary;
  readonly items: readonly ChartItem[];
  readonly pending: readonly { readonly from_ms: number; readonly to_ms: number | null }[];
}): ChartWindow {
  const { from_ms: from, to_ms: to } = input;
  const byTime = new Map<
    number,
    { readonly fingerprint: string; readonly quote_decimal: string }
  >();
  const recoveries = new Map<string, Extract<ChartItem, { kind: 'recovery' }>>();
  const stops: { readonly from_ms: number; readonly to_ms: number | null }[] = [];
  let watermark = input.start.watermark_ms;
  let stop: { readonly from_ms: number; readonly watermark_ms: number } | null =
    input.start.stopped && watermark !== null
      ? { from_ms: watermark + 1, watermark_ms: watermark }
      : null;
  for (const item of input.items) {
    switch (item.kind) {
      case 'tick': {
        if (item.time_ms >= from && item.time_ms <= to) {
          const best = byTime.get(item.time_ms);
          if (best === undefined || item.fingerprint < best.fingerprint) {
            byTime.set(item.time_ms, item);
          }
        }
        // La parada termina con el primer tick posterior al high-watermark del cierre: el que
        // repite la suscripción al reconectar no la termina.
        if (stop !== null && item.time_ms > stop.watermark_ms) {
          stops.push({ from_ms: stop.from_ms, to_ms: Math.max(item.time_ms - 1, stop.from_ms) });
          stop = null;
        }
        watermark = watermark === null ? item.time_ms : Math.max(watermark, item.time_ms);
        break;
      }
      case 'stop':
        if (stop === null && watermark !== null) {
          stop = { from_ms: watermark + 1, watermark_ms: watermark };
        }
        break;
      case 'recovery': {
        const key = `${String(item.from_ms)}:${String(item.to_ms)}`;
        recoveries.delete(key);
        recoveries.set(key, item);
        break;
      }
    }
  }
  if (stop !== null) {
    stops.push({ from_ms: stop.from_ms, to_ms: null });
  }

  const lost: ChartGap[] = [
    ...[...recoveries.values()].map((item): ChartGap => ({
      cause: 'connection_lost',
      from_ms: item.from_ms,
      history: item.status === 'complete' ? 'recovered' : item.status,
      reason: item.reason,
      recovered_ticks: item.recovered_ticks,
      to_ms: item.to_ms,
    })),
    ...input.pending.map((gap): ChartGap => ({
      cause: 'connection_lost',
      from_ms: gap.from_ms,
      history: 'pending',
      reason: null,
      recovered_ticks: null,
      to_ms: gap.to_ms,
    })),
  ];
  const stopped = stops
    .map((gap): ChartGap => ({
      cause: 'capture_stopped',
      from_ms: gap.from_ms,
      history: 'not_requested',
      reason: null,
      recovered_ticks: null,
      to_ms: gap.to_ms,
    }))
    .filter((gap) => !lost.some((other) => overlaps(gap, other)));
  const gaps = [...lost, ...stopped]
    .filter((gap) => gap.from_ms <= to && (gap.to_ms ?? to) >= from)
    .sort(
      (left, right) =>
        left.from_ms - right.from_ms ||
        (left.to_ms ?? Number.POSITIVE_INFINITY) - (right.to_ms ?? Number.POSITIVE_INFINITY),
    );
  const ticks = [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([time, tick]) => ({ quote_decimal: tick.quote_decimal, time_ms: time }));
  return { gaps, ticks };
}

/**
 * Lo que el gráfico aporta de cada segmento cerrado, que no cambia: la API lo guarda en memoria, con
 * un tope, por el índice del segmento y su `logical_content_sha256` (ADR-0019 §8).
 */
export interface ChartSegmentCache {
  get(key: string): readonly ChartItem[] | undefined;
  set(key: string, items: readonly ChartItem[]): void;
}

/** La clave de un segmento cerrado en la caché del gráfico. */
export function chartSegmentKey(segment: ClosedSourceSegment): string {
  return `${String(segment.segment_index)}:${segment.logical_content_sha256}`;
}

/**
 * Lo más que pliega el lector del gráfico desde un punto de control: una hora de segmentos de 5
 * minutos. `ingest` escribe uno al cerrar cada segmento (ADR-0017 §5), así que solo falta alguno si
 * la escritura se atrasa o falló.
 */
export const CHART_FOLD_LIMIT = 12;

/**
 * Lo que se busca antes de la ventana: un tick puede llegar antes de su hora de fuente, por la
 * recepción, si el reloj de la fuente va adelantado.
 */
export const CHART_SEGMENT_MARGIN_MS = 60_000;

/** Los segmentos cerrados que se leen a la vez. */
const READ_CONCURRENCY = 4;

/**
 * El log no tiene un punto de control válido lo bastante cerca de la ventana: leerla obligaría a
 * plegar más de `CHART_FOLD_LIMIT` segmentos, y la API no deriva el log entero (ADR-0019 §8). Pasa si
 * `ingest` dejó de escribir los puntos de control o si los rechaza la búsqueda, y `data:health` lo
 * avisa (`checkpoint_rejected`).
 */
export class ChartCheckpointError extends Error {
  constructor() {
    super('El log no tiene un punto de control válido cerca de la ventana del gráfico.');
    this.name = 'ChartCheckpointError';
  }
}

export interface ReadChartWindowInput {
  /** El log abierto en solo lectura (`SourceEventLog.open`): da la foto de su segmento abierto. */
  readonly log: SourceEventLog;
  /** Los segmentos cerrados de la ventana, del mismo log. */
  readonly segments: ClosedSegmentFinder;
  /** Los puntos de control del log, con el perfil de medición y el símbolo del gráfico. */
  readonly lookup: LiveCheckpointLookup;
  /** La ventana, con milisegundos (`toISOString()`). */
  readonly fromUtc: string;
  readonly toUtc: string;
  readonly cache?: ChartSegmentCache;
}

/** Lo que lance el pliegue o el normalizador: el log no se puede derivar. */
function derived<T>(derive: () => T): T {
  try {
    return derive();
  } catch (error) {
    throw new LogNotDerivableError(error);
  }
}

function fold(
  state: LiveDerivationState,
  events: readonly SourceEvent[],
  profile: PipelineProfile,
): LiveDerivationState {
  return derived(() => foldLiveDerivation(state, events, profile));
}

/** Un punto de control por debajo de `below` que deja plegar como mucho `CHART_FOLD_LIMIT`. */
function requireNear(base: LiveCheckpointBase, below: number): void {
  if (below - 1 - base.segment_index > CHART_FOLD_LIMIT) {
    throw new ChartCheckpointError();
  }
}

/** `map` con como mucho `limit` llamadas a la vez, y los resultados en orden. */
async function mapLimited<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await map(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/**
 * El gráfico del símbolo del perfil en la ventana `[fromUtc, toUtc]` (ADR-0019 §8), sin derivar el
 * log entero:
 *
 * 1. toma la foto del segmento abierto (`openSegment`) antes de esperar nada, así que un segmento que
 *    se cierre mientras lee no entra dos veces;
 * 2. busca los segmentos cerrados cuyo último evento es posterior al principio de la ventana, menos
 *    `CHART_SEGMENT_MARGIN_MS`, hasta el anterior al abierto;
 * 3. busca los puntos de control válidos de antes de esos segmentos y de antes del abierto. Si
 *    alguno obliga a plegar más de `CHART_FOLD_LIMIT` segmentos, falla con `ChartCheckpointError`;
 * 4. lee lo que aporta cada segmento cerrado (`chartItemsOf`), de la caché o de su objeto,
 *    verificado por su hash (`readClosedSegment`), cuatro a la vez;
 * 5. pliega desde cada punto de control hasta el principio de la ventana y hasta el final, con la
 *    foto del abierto: el principio dice si la captura estaba parada, y el final, los huecos
 *    pendientes;
 * 6. arma el gráfico (`assembleChartWindow`).
 *
 * Lanza `LogReadError` si un almacén no responde, `LogIntegrityError` si el contenido no pasa sus
 * comprobaciones, `LogNotDerivableError` si el pliegue falla y `ChartCheckpointError`. No escribe
 * nada.
 */
export async function readChartWindow(input: ReadChartWindowInput): Promise<ChartWindow> {
  const { log, lookup } = input;
  const { profile, symbol } = lookup;
  const from = Date.parse(input.fromUtc);
  const to = Date.parse(input.toUtc);
  const open = log.openSegment();
  const since = new Date(from - CHART_SEGMENT_MARGIN_MS).toISOString();
  let found: ClosedSourceSegment[];
  try {
    found = await input.segments.listClosedSegmentsSince(log.source, since);
  } catch (error) {
    throw new LogReadError(failureReason(error), { cause: error });
  }
  const rows = found.filter((row) => row.segment_index < open.segment_index);
  const first = rows[0]?.segment_index ?? open.segment_index;
  if (
    rows.some((row, index) => row.segment_index !== first + index) ||
    first + rows.length !== open.segment_index
  ) {
    throw new LogIntegrityError(
      `Los segmentos ${String(first)}–${String(open.segment_index - 1)} no están todos cerrados.`,
    );
  }

  const startBase = await lookup.lastValid(log, first);
  const endBase =
    first === open.segment_index ? startBase : await lookup.lastValid(log, open.segment_index);
  requireNear(startBase, first);
  requireNear(endBase, open.segment_index);

  // De los que se leen y van después del punto de control del final se guardan los eventos, que
  // se pliegan además; los de la caché, se leen al plegar.
  const folded = new Map<number, readonly SourceEvent[]>();
  const items = await mapLimited(rows, READ_CONCURRENCY, async (row) => {
    const key = chartSegmentKey(row);
    const cached = input.cache?.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const { events, segment } = await log.readClosedSegment(row.segment_index);
    // La clave de la caché es la de la fila de la ventana: el objeto leído tiene que ser el suyo.
    if (segment.logical_content_sha256 !== row.logical_content_sha256) {
      throw new LogIntegrityError(`El segmento ${String(row.segment_index)} cambió de contenido.`);
    }
    if (row.segment_index > endBase.segment_index) {
      folded.set(row.segment_index, events);
    }
    const chart = derived(() => chartItemsOf(events, profile, symbol));
    input.cache?.set(key, chart);
    return chart;
  });

  let startState = startBase.state;
  for (let index = startBase.segment_index + 1; index < first; index += 1) {
    startState = fold(startState, (await log.readClosedSegment(index)).events, profile);
  }
  let endState = endBase.state;
  for (let index = endBase.segment_index + 1; index < open.segment_index; index += 1) {
    const events = folded.get(index) ?? (await log.readClosedSegment(index)).events;
    endState = fold(endState, events, profile);
  }
  endState = fold(endState, open.events, profile);

  const pending = liveDerivationView(endState)
    .pendingGaps.filter((gap) => gap.symbol === symbol)
    .map((gap) => ({
      from_ms: Date.parse(gap.from_event_time_utc),
      to_ms: gap.to_event_time_utc === null ? null : Date.parse(gap.to_event_time_utc),
    }));
  return assembleChartWindow({
    from_ms: from,
    items: [...items.flat(), ...derived(() => chartItemsOf(open.events, profile, symbol))],
    pending,
    start: chartBoundaryOf(startState, symbol),
    to_ms: to,
  });
}
