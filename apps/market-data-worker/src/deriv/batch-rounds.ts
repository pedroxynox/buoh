import {
  BATCH_CANDLES_SEQUENCE,
  BATCH_QUOTES_SEQUENCE,
  BATCH_SCHEDULES_SEQUENCE,
  HISTORY_GOLD_SEQUENCE,
  HISTORY_R_100_SEQUENCE,
  type LogSequence,
} from '../successive-logs.js';
import {
  derivCandlesProfile,
  derivQuotesProfile,
  derivSchedulesProfile,
  type BatchProfileKind,
} from './batch-profile.js';
import {
  candleRequests,
  quoteRequests,
  scheduleRequests,
  type BatchRequest,
} from './batch-requests.js';

/**
 * Las vueltas de los lotes (ADR-0021 §3; precisión del PR 5c1 de su §9): qué le toca pedir a cada
 * secuencia por lotes en una ejecución de `buoh-operaciones`, con lo que ya pidió (`BatchCursor`).
 * Es pura: la hora y el cursor llegan de fuera.
 *
 * - **Horarios:** una vuelta por día UTC, la de ese día: `trading_times` del día y del siguiente,
 *   `active_symbols` y `contracts_for` de los ocho mercados (`scheduleRequests`), desde la primera
 *   ejecución del día.
 * - **Velas:** una vuelta por día UTC, la del día anterior, ya completo: el `trading_times` de ese
 *   día y sus 14 páginas (`candleRequests`), desde la primera ejecución del día.
 * - **Cotizaciones:** una vuelta por media hora UTC, la que empieza en el minuto 0 o 30: sus 126
 *   `proposal` (`quoteRequests`), repartidas entre las seis ejecuciones de esa media hora: en la
 *   ejecución *k* (de 0 a 5, por los minutos desde su comienzo), hasta la ⌈126 (*k* + 1) / 6⌉. Así
 *   una ejecución que se salta o que para la recupera la siguiente.
 *
 * Una vuelta que cambia antes de terminar la anterior no la sigue: lo que faltaba de la anterior
 * queda como `abandoned`, sin pedirse nunca. Una cotización vale en su momento, y un horario o una
 * vela que no llegaron en su día se ven como un hueco de sus datos.
 */

/** Cada cuánto corre `buoh-operaciones` (ADR-0018 §11): la cadencia de las vueltas repartidas. */
export const BATCH_RUN_INTERVAL_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/** Lo que ya pidió una secuencia: la vuelta y la primera petición que le falta pedir. */
export interface BatchCursor {
  readonly next: number;
  readonly round: string;
}

/** Lo que le toca pedir a una secuencia en una ejecución. */
export interface BatchRound {
  /**
   * Lo que faltaba de la vuelta del cursor, si era otra y no había terminado: su nombre y cuántas
   * peticiones quedaron sin pedir.
   */
  readonly abandoned: { readonly remaining: number; readonly round: string } | null;
  /** La primera petición que falta pedir de esta vuelta. */
  readonly from: number;
  /** Las peticiones de la vuelta entera, en el orden en que se piden. */
  readonly requests: readonly BatchRequest[];
  /**
   * La vuelta: en los horarios, el día UTC, `AAAA-MM-DD`; en las velas, el día de las velas, el
   * anterior; en las cotizaciones, la hora UTC de comienzo de su media hora, con milisegundos.
   */
  readonly round: string;
  /** Hasta qué petición, sin incluirla, toca pedir en esta ejecución. */
  readonly until: number;
}

/**
 * El perfil de los lotes de cada secuencia por lotes: las tres del PR 5 (ADR-0021 §3) y las dos
 * historias del PR 6c, que no van por vueltas (`batchRound` las rechaza).
 */
export const BATCH_SEQUENCE_PROFILES: ReadonlyMap<LogSequence, BatchProfileKind> = new Map([
  [BATCH_SCHEDULES_SEQUENCE, 'schedules'],
  [BATCH_QUOTES_SEQUENCE, 'quotes'],
  [BATCH_CANDLES_SEQUENCE, 'candles'],
  [HISTORY_R_100_SEQUENCE, 'history_r_100'],
  [HISTORY_GOLD_SEQUENCE, 'history_frxxauusd'],
]);

/** El perfil de los lotes de la secuencia; lanza `TypeError` con una que no tiene ninguno. */
export function batchProfileKindOf(sequence: LogSequence): BatchProfileKind {
  const kind = BATCH_SEQUENCE_PROFILES.get(sequence);
  if (kind === undefined) {
    throw new TypeError(`La secuencia ${sequence.name} no tiene perfil de los lotes.`);
  }
  return kind;
}

const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** La vuelta y sus peticiones a la hora `nowMs`, y hasta cuál toca pedir. */
function roundAt(
  kind: BatchProfileKind,
  nowMs: number,
): { readonly requests: readonly BatchRequest[]; readonly round: string; readonly until: number } {
  switch (kind) {
    case 'schedules': {
      const round = utcDay(nowMs);
      const requests = scheduleRequests(derivSchedulesProfile(), round);
      return { requests, round, until: requests.length };
    }
    case 'candles': {
      const round = utcDay(nowMs - DAY_MS);
      const requests = candleRequests(derivCandlesProfile(), round);
      return { requests, round, until: requests.length };
    }
    case 'quotes': {
      const profile = derivQuotesProfile();
      const intervalMs = profile.interval_minutes * 60_000;
      const parts = Math.max(1, Math.floor(intervalMs / BATCH_RUN_INTERVAL_MS));
      const start = Math.floor(nowMs / intervalMs) * intervalMs;
      const part = Math.min(parts - 1, Math.floor((nowMs - start) / BATCH_RUN_INTERVAL_MS));
      const requests = quoteRequests(profile);
      return {
        requests,
        round: new Date(start).toISOString(),
        until: Math.ceil((requests.length * (part + 1)) / parts),
      };
    }
    case 'history_frxxauusd':
    case 'history_r_100':
      // La historia la pide su comando, bloque a bloque (precisión del PR 6c de ADR-0021 §9).
      throw new TypeError('La historia no va por vueltas.');
  }
}

/**
 * Lo que le toca pedir a la secuencia por lotes a la hora `nowUtc`, con su cursor (`null` si no
 * pidió nada todavía). Con el cursor de la misma vuelta, sigue desde su `next`; con el de otra, empieza
 * la vuelta nueva desde 0 y deja la anterior como `abandoned` si le faltaban peticiones. Si `from` no
 * es menor que `until`, no hay nada que pedir.
 */
export function batchRound(
  sequence: LogSequence,
  nowUtc: string,
  cursor: BatchCursor | null,
): BatchRound {
  const nowMs = Date.parse(nowUtc);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`${nowUtc} no es una hora UTC.`);
  }
  const { requests, round, until } = roundAt(batchProfileKindOf(sequence), nowMs);
  if (cursor !== null && (!Number.isSafeInteger(cursor.next) || cursor.next < 0)) {
    throw new TypeError('El cursor de una vuelta es un entero de 0 en adelante.');
  }
  const same = cursor !== null && cursor.round === round;
  const remaining = cursor === null || same ? 0 : Math.max(0, requests.length - cursor.next);
  return {
    abandoned: cursor !== null && remaining > 0 ? { remaining, round: cursor.round } : null,
    from: same ? Math.min(cursor.next, requests.length) : 0,
    requests,
    round,
    until,
  };
}
