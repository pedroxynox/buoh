import { type HistoryRecoveryResult } from '@buoh/contracts';
import {
  canonicalQuoteDecimal,
  checkRequestedResponse,
  isEpochSecondsLexeme,
  isPipSizeLexeme,
  type JsonNode,
  type RequestedResponseInvalidReason,
} from '@buoh/domain';

import { EXPECTED_MSG_TYPE } from './requests.js';

// Recuperación de historia (ADR-0015 §4). Las partes puras: el rango que se pide, la lectura de cada
// página, la página siguiente y la decisión del intento. `HistoryRecovery` sigue una recuperación:
// sus páginas y su resultado. `DerivConnection` hace el resto: envía las páginas, espera sus
// respuestas y persiste el resultado.

/** Páginas como máximo por intento: unas 27 horas de `R_100`. */
export const HISTORY_PAGE_LIMIT = 50;

/** El hueco que se recupera: el rango pendiente de las reglas (ADR-0015 §2) y sus dos extremos. */
export interface HistoryRecoveryRequest {
  readonly symbol: string;
  /** `PendingGap.from_event_time_utc`: high-watermark + 1 ms. */
  readonly from_event_time_utc: string;
  /** `PendingGap.to_event_time_utc`, ya conocido: primer tick posterior al cierre − 1 ms. */
  readonly to_event_time_utc: string;
  /** Cotización canónica recibida en el high-watermark (tick en from − 1 ms). */
  readonly start_quote: string;
  /** Cotización canónica del primer tick posterior al cierre (tick en to + 1 ms). */
  readonly end_quote: string;
}

/**
 * Cómo terminó `recoverHistory`: `abandoned` si la conexión no estaba suscrita o se cerró antes de
 * encolar el resultado, que entonces no se persiste; si no, `finished` con el resultado, si quedó
 * durable, los intentos y las páginas pedidas en el intento del resultado. Un resultado que no quedó
 * durable cierra la conexión.
 */
export type HistoryRecoveryOutcome =
  | { readonly status: 'abandoned' }
  | {
      readonly attempts: number;
      readonly durable: boolean;
      readonly pages: number;
      readonly result: HistoryRecoveryResult;
      readonly status: 'finished';
    };

/** Segundos que pide un intento o una página, los dos incluidos: epoch enteros. */
export interface HistoryRange {
  readonly end: number;
  readonly start: number;
}

/**
 * Rango del intento: `start` (S) es el segundo del high-watermark, from − 1 ms, y `end` (E), el del
 * primer tick posterior al cierre, to + 1 ms. Las horas tienen que estar en UTC con milisegundos y
 * dar segundos enteros con S < E; si no, el pedido es un error de programación (`TypeError`).
 */
export function historyRange(request: HistoryRecoveryRequest): HistoryRange {
  const from = utcMilliseconds(request.from_event_time_utc);
  const to = utcMilliseconds(request.to_event_time_utc);
  const start = (from - 1) / 1000;
  const end = (to + 1) / 1000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
    throw new TypeError(
      'El hueco tiene que empezar 1 ms después de un segundo y terminar 1 ms antes de otro posterior.',
    );
  }
  return { end, start };
}

function utcMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`La hora ${value} no está en UTC con milisegundos.`);
  }
  return milliseconds;
}

/** Tick de una página válida: su segundo y su cotización canónica con el `pip_size` de la página. */
export interface HistoryTick {
  readonly quote: string;
  readonly time: number;
}

/** Lo que dice la respuesta a una página. */
export type HistoryPage =
  | { readonly status: 'valid'; readonly ticks: readonly HistoryTick[] }
  | {
      /** Motivo de la incidencia de respuesta pedida, o `null` si ya la registran las reglas 2.0.0. */
      readonly incident: RequestedResponseInvalidReason | null;
      readonly status: 'error_response' | 'invalid';
    };

const member = (node: JsonNode | undefined, key: string): JsonNode | undefined =>
  node?.type === 'object' ? node.entries.get(key) : undefined;

const inconsistent: HistoryPage = { incident: 'history_inconsistent', status: 'invalid' };

/**
 * Lee el frame durable que trae el `req_id` de la página pedida con `page`, o devuelve `null` si no
 * le responde, como cualquier otro mensaje con ese `req_id`:
 *
 * - `ticks_history` con un objeto `error`: la petición fue rechazada. No deja incidencia de respuesta
 *   pedida, porque el perfil no declara `ticks_history` y las reglas 2.0.0 ya la registran como
 *   `source_error_response`;
 * - `history`: se comprueba como una respuesta pedida (ADR-0012 §6), con `error` y el esquema de
 *   respuesta. Después tiene que traer el objeto `history`, sus arrays `times` y `prices` y
 *   `pip_size` (si no, `schema_validation_failed`), y ser coherente (si no, `history_inconsistent`):
 *   `pip_size` entero de 0 a 18, `times` y `prices` de la misma longitud, tiempos enteros
 *   estrictamente crecientes dentro de `[start, end]` y precios que la regla de `quote_decimal`
 *   acepta con ese `pip_size`.
 */
export function readHistoryPage(
  root: JsonNode,
  page: HistoryRange,
  validateResponse: (value: unknown) => boolean,
): HistoryPage | null {
  const msgType = member(root, 'msg_type');
  const name = msgType?.type === 'string' ? msgType.value : null;
  if (name === 'ticks_history' && member(root, 'error')?.type === 'object') {
    return { incident: null, status: 'error_response' };
  }
  if (name !== EXPECTED_MSG_TYPE.ticks_history) {
    return null;
  }
  const common = checkRequestedResponse(root, validateResponse);
  if (common !== null) {
    return {
      incident: common,
      status: common === 'source_error_response' ? 'error_response' : 'invalid',
    };
  }
  const history = member(root, 'history');
  const times = member(history, 'times');
  const prices = member(history, 'prices');
  const pipSize = member(root, 'pip_size');
  if (
    history?.type !== 'object' ||
    times?.type !== 'array' ||
    prices?.type !== 'array' ||
    pipSize === undefined
  ) {
    return { incident: 'schema_validation_failed', status: 'invalid' };
  }
  // Con las reglas de lexema de un tick (ADR-0004 §4): `pip_size` y tiempos enteros.
  if (pipSize.type !== 'number' || !isPipSizeLexeme(pipSize.lexeme)) {
    return inconsistent;
  }
  if (times.items.length !== prices.items.length) {
    return inconsistent;
  }
  const decimals = Number(pipSize.lexeme);
  const ticks: HistoryTick[] = [];
  for (const [index, timeNode] of times.items.entries()) {
    const priceNode = prices.items[index];
    if (timeNode.type !== 'number' || !isEpochSecondsLexeme(timeNode.lexeme)) {
      return inconsistent;
    }
    const time = Number(timeNode.lexeme);
    const previous = ticks.at(-1);
    if (
      time < page.start ||
      time > page.end ||
      (previous !== undefined && time <= previous.time) ||
      priceNode?.type !== 'number'
    ) {
      return inconsistent;
    }
    const quote = canonicalQuoteDecimal(priceNode.lexeme, decimals);
    if (!quote.ok) {
      return inconsistent;
    }
    ticks.push({ quote: quote.value, time });
  }
  return { status: 'valid', ticks };
}

/**
 * `end` de la página siguiente después de las páginas válidas ya recibidas, o `null` si la
 * paginación termina: con una página vacía, al llegar a `start` o tras `HISTORY_PAGE_LIMIT` páginas.
 * La anterior a una página no vacía termina en su primer tick − 1 s.
 */
export function nextHistoryPageEnd(
  range: HistoryRange,
  pages: readonly (readonly HistoryTick[])[],
): number | null {
  const first = pages.at(-1)?.[0];
  if (first === undefined || first.time <= range.start || pages.length >= HISTORY_PAGE_LIMIT) {
    return null;
  }
  return first.time - 1;
}

/** Motivos de un resultado `partial` o `unavailable` (ADR-0015 §4). */
export type HistoryRecoveryReason =
  | 'history_boundary_mismatch'
  | 'history_boundary_missing'
  | 'history_error_response'
  | 'history_invalid'
  | 'history_page_limit'
  | 'history_timeout';

/** Página que falló y terminó la paginación. */
export type HistoryPageFailure = 'error_response' | 'invalid' | 'timeout';

const FAILURE_REASON = {
  error_response: 'history_error_response',
  invalid: 'history_invalid',
  timeout: 'history_timeout',
} as const satisfies Record<HistoryPageFailure, HistoryRecoveryReason>;

/** Decisión de un intento: los campos de `HistoryRecoveryResult` que dependen de sus páginas. */
export type HistoryRecoveryDecision =
  | { readonly recovered_event_count: number; readonly status: 'complete' }
  | {
      readonly reason: HistoryRecoveryReason;
      readonly recovered_event_count: number;
      readonly status: 'partial';
    }
  | { readonly reason: HistoryRecoveryReason; readonly status: 'unavailable' };

/**
 * Decide el intento con sus páginas válidas, en orden, y la que falló, si alguna. Se aplica la
 * primera regla que se cumple:
 *
 * 1. una página falló: `history_error_response`, `history_invalid` o `history_timeout`, y
 *    `unavailable` si era la primera;
 * 2. el tick de S o el de E está, pero con otra cotización canónica: `history_boundary_mismatch`;
 * 3. la paginación paró en el tope sin llegar a S: `history_page_limit`;
 * 4. falta el tick de S o el de E: `history_boundary_missing`;
 * 5. si no, `complete`.
 *
 * `recovered_event_count` cuenta los ticks de las páginas válidas entre S y E, sin incluirlos.
 */
export function decideHistoryRecovery(input: {
  readonly end_quote: string;
  readonly failure: HistoryPageFailure | null;
  readonly pages: readonly (readonly HistoryTick[])[];
  readonly range: HistoryRange;
  readonly start_quote: string;
}): HistoryRecoveryDecision {
  const { end, start } = input.range;
  const ticks = input.pages.flat();
  const recovered = ticks.filter((tick) => tick.time > start && tick.time < end).length;
  if (input.failure !== null) {
    const reason = FAILURE_REASON[input.failure];
    return input.pages.length === 0
      ? { reason, status: 'unavailable' }
      : { reason, recovered_event_count: recovered, status: 'partial' };
  }
  const partial = (reason: HistoryRecoveryReason): HistoryRecoveryDecision => ({
    reason,
    recovered_event_count: recovered,
    status: 'partial',
  });
  const atStart = ticks.find((tick) => tick.time === start);
  const atEnd = ticks.find((tick) => tick.time === end);
  if (
    (atStart !== undefined && atStart.quote !== input.start_quote) ||
    (atEnd !== undefined && atEnd.quote !== input.end_quote)
  ) {
    return partial('history_boundary_mismatch');
  }
  const lastFirst = input.pages.at(-1)?.[0];
  if (
    input.pages.length >= HISTORY_PAGE_LIMIT &&
    lastFirst !== undefined &&
    lastFirst.time > start
  ) {
    return partial('history_page_limit');
  }
  if (atStart === undefined || atEnd === undefined) {
    return partial('history_boundary_missing');
  }
  return { recovered_event_count: recovered, status: 'complete' };
}

/** Lo que una recuperación necesita de su conexión. */
export interface HistoryRecoveryHooks {
  /** Pide la página `page` por la conexión: devuelve su `req_id`, o `null` si no la envió. */
  readonly sendPage: (page: HistoryRange) => number | null;
  /** Encola la decisión del intento, para persistir su resultado detrás de lo que ya espera. */
  readonly queueResult: (decision: HistoryRecoveryDecision) => void;
}

/**
 * Una recuperación de historia en curso en una conexión: pide las páginas de su intento con
 * `sendPage`, recibe sus respuestas o vencimientos con `onPage` y, al terminar el intento, encola su
 * decisión con `queueResult`. Termina con `finish`, cuando el resultado pasó por la cola, o con
 * `abandon`.
 */
export class HistoryRecovery {
  readonly request: HistoryRecoveryRequest;
  readonly range: HistoryRange;
  readonly #hooks: HistoryRecoveryHooks;
  readonly #done = Promise.withResolvers<HistoryRecoveryOutcome>();
  /** Páginas válidas recibidas, en orden: cada una termina antes de la anterior. */
  #pages: (readonly HistoryTick[])[] = [];
  /** Páginas pedidas. */
  #requested = 0;
  /** `req_id` de la página que espera respuesta, o `null`. */
  #pendingReqId: number | null = null;
  /** `queued`: el resultado ya está en la cola; `abandoned` y `finished` son finales. */
  #state: 'abandoned' | 'finished' | 'queued' | 'running' = 'running';

  constructor(input: {
    readonly hooks: HistoryRecoveryHooks;
    /** `historyRange(request)`, ya comprobado. */
    readonly range: HistoryRange;
    readonly request: HistoryRecoveryRequest;
  }) {
    this.request = input.request;
    this.range = input.range;
    this.#hooks = input.hooks;
  }

  /** Se resuelve al terminar: `finished` con el resultado, o `abandoned`. */
  get outcome(): Promise<HistoryRecoveryOutcome> {
    return this.#done.promise;
  }

  /** Terminó con `abandoned`: su resultado no se persiste, aunque ya estuviera en la cola. */
  get abandoned(): boolean {
    return this.#state === 'abandoned';
  }

  /** Pide la primera página: termina en el fin del hueco y empieza, como todas, en su inicio. */
  start(): void {
    this.#requestPage(this.range.end);
  }

  /** Respuesta, o vencimiento, de la página `reqId`. Si ya no es la que espera, no hace nada. */
  onPage(reqId: number, page: HistoryPage | { readonly status: 'timeout' }): void {
    if (this.#state !== 'running' || this.#pendingReqId !== reqId) {
      return;
    }
    this.#pendingReqId = null;
    if (page.status !== 'valid') {
      this.#endAttempt(page.status);
      return;
    }
    this.#pages.push(page.ticks);
    const end = nextHistoryPageEnd(this.range, this.#pages);
    if (end === null) {
      this.#endAttempt(null);
    } else {
      this.#requestPage(end);
    }
  }

  /**
   * Termina con `abandoned` si su resultado no está en la cola, o aunque esté si `force`: la cola
   * falló y ya no lo procesará. Devuelve si la abandonó.
   */
  abandon(force = false): boolean {
    if (this.#state === 'abandoned' || this.#state === 'finished') {
      return false;
    }
    if (this.#state === 'queued' && !force) {
      return false;
    }
    this.#state = 'abandoned';
    this.#pendingReqId = null;
    this.#done.resolve({ status: 'abandoned' });
    return true;
  }

  /** El resultado pasó por la cola: termina con `finished`. */
  finish(durable: boolean, result: HistoryRecoveryResult): void {
    if (this.#state !== 'queued') {
      return;
    }
    this.#state = 'finished';
    this.#done.resolve({
      attempts: 1,
      durable,
      pages: this.#requested,
      result,
      status: 'finished',
    });
  }

  #requestPage(end: number): void {
    this.#requested += 1;
    this.#pendingReqId = this.#hooks.sendPage({ end, start: this.range.start });
  }

  #endAttempt(failure: HistoryPageFailure | null): void {
    const decision = decideHistoryRecovery({
      end_quote: this.request.end_quote,
      failure,
      pages: this.#pages,
      range: this.range,
      start_quote: this.request.start_quote,
    });
    this.#state = 'queued';
    this.#hooks.queueResult(decision);
  }
}
