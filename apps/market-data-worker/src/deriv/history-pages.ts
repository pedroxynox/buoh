import type { SourceEvent } from '@buoh/contracts';

import type { HistoryProfile } from './batch-profile.js';
import { RATE_LIMIT } from './batch-client.js';
import { historyBlocks, type BatchRequest, type HistoryBlock } from './batch-requests.js';

/**
 * Las respuestas de la historia en su log (precisión del PR 6c de ADR-0021 §9): qué petición de la
 * historia respondió cada frame, para saber dónde termina el dataset de un bloque y desde qué
 * petición sigue el comando de la historia. Una respuesta cuenta si respondió, con datos o con un
 * error, como en el comando de los lotes; un `RateLimit` no, porque esa petición se vuelve a pedir.
 * Las peticiones se piden de una en una y en su orden (`runBatchExchange`), así que las respuestas
 * de un log van en el orden de las peticiones. Es pura.
 */

/** La petición de la historia que respondió un frame. */
export type HistoryAnswer =
  | { readonly date: string; readonly kind: 'schedule' }
  | { readonly end: number; readonly kind: 'tranche'; readonly start: number };

type JsonRecord = Readonly<Record<string, unknown>>;

const recordOf = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const epochOf = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^[0-9]{1,12}$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/**
 * La petición de la historia de `symbol` que respondió el texto de un frame, por su `echo_req`, o
 * `null` si no es una respuesta de la historia de `symbol` o es un `RateLimit`. Una página de ticks
 * responde con `history`, o con `ticks_history` y un error; un horario, con `trading_times`.
 */
export function historyAnswerOf(payload: string, symbol: string): HistoryAnswer | null {
  let root: JsonRecord | null;
  try {
    root = recordOf(JSON.parse(payload));
  } catch {
    return null;
  }
  const echo = recordOf(root?.['echo_req']);
  if (root === null || echo === null) {
    return null;
  }
  if (recordOf(root['error'])?.['code'] === RATE_LIMIT) {
    return null;
  }
  const msgType = root['msg_type'];
  if (msgType === 'trading_times') {
    const date = echo['trading_times'];
    return typeof date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date)
      ? { date, kind: 'schedule' }
      : null;
  }
  if (
    (msgType === 'history' || msgType === 'ticks_history') &&
    echo['ticks_history'] === symbol &&
    echo['style'] === 'ticks'
  ) {
    const start = epochOf(echo['start']);
    const end = epochOf(echo['end']);
    return start === null || end === null ? null : { end, kind: 'tranche', start };
  }
  return null;
}

/** Las respuestas de la historia de un perfil en unos source events, en su orden. */
export function historyAnswersIn(
  events: readonly SourceEvent[],
  profile: Pick<HistoryProfile, 'symbol'>,
): HistoryAnswer[] {
  const answers: HistoryAnswer[] = [];
  for (const event of events) {
    if (event.kind === 'raw_source_frame') {
      const answer = historyAnswerOf(event.payload_utf8, profile.symbol);
      if (answer !== null) {
        answers.push(answer);
      }
    }
  }
  return answers;
}

/** Las peticiones de una historia, en el orden en que se piden, con sus bloques. */
export interface HistoryPlan {
  readonly blocks: readonly HistoryBlock[];
  /** El índice de la primera petición de cada bloque. */
  readonly firsts: readonly number[];
  readonly profile: HistoryProfile;
  readonly requests: readonly BatchRequest[];
}

/** Las peticiones de la historia de un perfil (`historyBlocks`), en una sola lista. */
export function historyPlan(profile: HistoryProfile): HistoryPlan {
  const blocks = historyBlocks(profile);
  const firsts: number[] = [];
  const requests: BatchRequest[] = [];
  for (const block of blocks) {
    firsts.push(requests.length);
    requests.push(...block.requests);
  }
  return { blocks, firsts, profile, requests };
}

/** El bloque de un comienzo de tramo, o `-1` si el segundo no es de la historia. */
function blockIndexOf(plan: HistoryPlan, start: number): number {
  const { block_seconds, end_epoch, start_epoch } = plan.profile;
  if (start < start_epoch || start > end_epoch) {
    return -1;
  }
  return Math.floor((start - start_epoch) / block_seconds);
}

/** El índice de la petición del tramo de `start` a `end`, o `null` si no es un tramo de la historia. */
export function trancheIndexOf(plan: HistoryPlan, start: number, end: number): number | null {
  const block = blockIndexOf(plan, start);
  const first = plan.firsts[block];
  const found = plan.blocks[block];
  if (first === undefined || found === undefined) {
    return null;
  }
  const offset = (start - found.start) / plan.profile.tranche_seconds;
  const request = found.requests[1 + offset];
  return Number.isInteger(offset) &&
    request?.operation === 'ticks_history' &&
    request.start === start &&
    request.end === end
    ? first + 1 + offset
    : null;
}

/** Si el tramo de `start` a `end` es el último de su bloque. */
export function closesHistoryBlock(plan: HistoryPlan, start: number, end: number): boolean {
  const index = trancheIndexOf(plan, start, end);
  if (index === null) {
    return false;
  }
  return (plan.firsts[blockIndexOf(plan, start) + 1] ?? plan.requests.length) === index + 1;
}

/** El índice del bloque de una petición. */
export function blockOfRequest(plan: HistoryPlan, index: number): number {
  let low = 0;
  let high = plan.firsts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((plan.firsts[middle] ?? 0) <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * La primera petición que falta pedir, desde las respuestas del final del log en su orden, o `null`
 * si no tienen ningún tramo de la historia. Sigue a la del último tramo respondido y, si después
 * llegó la respuesta del horario que le seguía, a la de ese horario: así ninguna página se pide dos
 * veces, ni ningún horario después de una página. Sin ninguna página, el horario del primer bloque se
 * puede pedir otra vez, y cuenta el último del día (reglas 4.1.0).
 */
export function historyResumeIndex(
  plan: HistoryPlan,
  answers: readonly HistoryAnswer[],
): number | null {
  let next: number | null = null;
  for (const answer of answers) {
    if (answer.kind === 'tranche') {
      const index = trancheIndexOf(plan, answer.start, answer.end);
      next = index === null ? next : index + 1;
      continue;
    }
    const request = next === null ? undefined : plan.requests[next];
    if (next !== null && request?.operation === 'trading_times' && request.date === answer.date) {
      next += 1;
    }
  }
  return next;
}
