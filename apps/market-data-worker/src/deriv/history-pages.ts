import type { SourceEvent } from '@buoh/contracts';

import { isCandleHistoryProfile, type AnyHistoryProfile } from './batch-profile.js';
import { RATE_LIMIT } from './batch-client.js';
import { historyBlocksOf, type BatchRequest, type HistoryBlock } from './batch-requests.js';

/**
 * Las respuestas de la historia en su log (precisión del PR 6c de ADR-0021 §9): qué petición de la
 * historia respondió cada frame, para saber dónde termina el dataset de un bloque y desde qué
 * petición sigue el comando de la historia. Una respuesta cuenta si respondió, con datos o con un
 * error, como en el comando de los lotes; un `RateLimit` no, porque esa petición se vuelve a pedir.
 * Las peticiones se piden de una en una y en su orden (`runBatchExchange`), así que las respuestas
 * de un log van en el orden de las peticiones. Desde el PR 6d, también las de la historia de las
 * velas, cuyas páginas son de varios símbolos. Es pura.
 */

/** La petición de la historia que respondió un frame: un horario, o una página de un símbolo. */
export type HistoryAnswer =
  | { readonly date: string; readonly kind: 'schedule' }
  | {
      readonly end: number;
      readonly kind: 'tranche';
      readonly start: number;
      readonly symbol: string;
    };

type JsonRecord = Readonly<Record<string, unknown>>;

const recordOf = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const epochOf = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^[0-9]{1,12}$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** Lo que distingue las páginas de una historia: de ticks de un símbolo, o de velas de varios. */
type HistoryPages =
  | { readonly style: 'candles'; readonly granularity: number; readonly symbols: readonly string[] }
  | { readonly style: 'ticks'; readonly symbols: readonly string[] };

function pagesOf(profile: AnyHistoryProfile): HistoryPages {
  return isCandleHistoryProfile(profile)
    ? { granularity: profile.granularity_seconds, style: 'candles', symbols: profile.symbols }
    : { style: 'ticks', symbols: [profile.symbol] };
}

/**
 * La petición de la historia del perfil que respondió el texto de un frame, por su `echo_req`, o
 * `null` si no es una respuesta de esa historia o es un `RateLimit`. Una página de ticks responde con
 * `history`, y una de velas, con `candles`, o las dos con `ticks_history` y un error; un horario,
 * con `trading_times`.
 */
export function historyAnswerOf(payload: string, profile: AnyHistoryProfile): HistoryAnswer | null {
  const pages = pagesOf(profile);
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
  const symbol = echo['ticks_history'];
  const page =
    pages.style === 'ticks'
      ? msgType === 'history' && echo['style'] === 'ticks'
      : msgType === 'candles' &&
        echo['style'] === 'candles' &&
        epochOf(echo['granularity']) === pages.granularity;
  const error =
    msgType === 'ticks_history' &&
    echo['style'] === pages.style &&
    (pages.style === 'ticks' || epochOf(echo['granularity']) === pages.granularity);
  if ((page || error) && typeof symbol === 'string' && pages.symbols.includes(symbol)) {
    const start = epochOf(echo['start']);
    const end = epochOf(echo['end']);
    return start === null || end === null ? null : { end, kind: 'tranche', start, symbol };
  }
  return null;
}

/** Las respuestas de la historia de un perfil en unos source events, en su orden. */
export function historyAnswersIn(
  events: readonly SourceEvent[],
  profile: AnyHistoryProfile,
): HistoryAnswer[] {
  const answers: HistoryAnswer[] = [];
  for (const event of events) {
    if (event.kind === 'raw_source_frame') {
      const answer = historyAnswerOf(event.payload_utf8, profile);
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
  readonly profile: AnyHistoryProfile;
  readonly requests: readonly BatchRequest[];
}

/** Las peticiones de la historia de un perfil (`historyBlocksOf`), en una sola lista. */
export function historyPlan(profile: AnyHistoryProfile): HistoryPlan {
  const blocks = historyBlocksOf(profile);
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

/**
 * El índice de la petición de la página de `symbol` de `start` a `end`, o `null` si no es una página
 * de la historia. Un bloque tiene como mucho unas 17 peticiones, así que se busca en el suyo.
 */
export function trancheIndexOf(
  plan: HistoryPlan,
  symbol: string,
  start: number,
  end: number,
): number | null {
  const block = blockIndexOf(plan, start);
  const first = plan.firsts[block];
  const found = plan.blocks[block];
  if (first === undefined || found === undefined) {
    return null;
  }
  const offset = found.requests.findIndex(
    (request) =>
      request.operation === 'ticks_history' &&
      request.symbol === symbol &&
      request.start === start &&
      request.end === end,
  );
  return offset < 0 ? null : first + offset;
}

/** Si la página de `symbol` de `start` a `end` es la última de su bloque. */
export function closesHistoryBlock(
  plan: HistoryPlan,
  symbol: string,
  start: number,
  end: number,
): boolean {
  const index = trancheIndexOf(plan, symbol, start, end);
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
      const index = trancheIndexOf(plan, answer.symbol, answer.start, answer.end);
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
