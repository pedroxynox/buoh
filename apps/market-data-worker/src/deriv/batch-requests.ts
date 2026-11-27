import { canonicalJson, type ContractDuration, type JsonValue } from '@buoh/contracts';

import { DATASET_ELEMENT_CEILING } from '../datasets/plan.js';
import {
  DERIV_HISTORY_DAYS,
  isCandleHistoryProfile,
  type AnyHistoryProfile,
  type CandleHistoryProfile,
  type CandlesProfile,
  type HistoryProfile,
  type QuotesProfile,
  type SchedulesProfile,
} from './batch-profile.js';
import type { BatchOperation } from './schema-release.js';
import type { DerivSchemaSet } from './schema-archive.js';

/**
 * Las peticiones de los lotes (ADR-0021 §3), con el conector `deriv-options-lotes-1.0.0`: las de
 * los horarios, las cotizaciones y las velas de sus perfiles (`batch-profile.ts`). Cada una es de
 * las que las reglas de los lotes 4.0.0 reconocen como del paso de los lotes (contratos de dominio,
 * «Semántica ejecutable de las reglas de los lotes 4.0.0»), así que su respuesta da su registro.
 */
export type BatchRequest =
  | { readonly operation: 'active_symbols' }
  | { readonly operation: 'contracts_for'; readonly symbol: string }
  | {
      readonly contract_type: 'MULTDOWN' | 'MULTUP';
      readonly multiplier: number;
      readonly operation: 'proposal';
      readonly stake: number;
      readonly symbol: string;
    }
  | {
      readonly contract_type: 'CALL' | 'PUT';
      readonly duration: ContractDuration;
      readonly operation: 'proposal';
      readonly stake: number;
      readonly symbol: string;
    }
  | {
      readonly count: number;
      /** Último segundo pedido, incluido: epoch entero en segundos. */
      readonly end: number;
      readonly granularity: number;
      readonly operation: 'ticks_history';
      /** Primer segundo pedido, incluido: epoch entero en segundos. */
      readonly start: number;
      readonly symbol: string;
    }
  | {
      /** Una página de ticks de la historia (PR 6a): sin `granularity`, con `style: ticks`. */
      readonly count: number;
      /** Último segundo pedido, incluido: epoch entero en segundos. */
      readonly end: number;
      readonly operation: 'ticks_history';
      /** Primer segundo pedido, incluido: epoch entero en segundos. */
      readonly start: number;
      readonly symbol: string;
    }
  | {
      /** El día UTC, `AAAA-MM-DD`. */
      readonly date: string;
      readonly operation: 'trading_times';
    };

/**
 * `msg_type` de la respuesta que espera una petición. Una página de velas responde con `candles`, y
 * una de ticks de la historia, con `history`; un error a `ticks_history`, con `ticks_history` y un
 * objeto `error` (reglas 4.0.0, «Un log»).
 */
export function expectedBatchMsgType(request: BatchRequest): string {
  if (request.operation === 'ticks_history') {
    return 'granularity' in request ? 'candles' : 'history';
  }
  return request.operation;
}

/** Cuerpo de la petición con su `req_id`. */
export function batchRequestBody(request: BatchRequest, reqId: number): Record<string, JsonValue> {
  switch (request.operation) {
    case 'active_symbols':
      return { active_symbols: 'brief', req_id: reqId };
    case 'contracts_for':
      return { contracts_for: request.symbol, req_id: reqId };
    case 'proposal': {
      const contract =
        'multiplier' in request
          ? { multiplier: request.multiplier }
          : {
              duration: request.duration.duration,
              duration_unit: request.duration.duration_unit,
            };
      return {
        amount: request.stake,
        basis: 'stake',
        contract_type: request.contract_type,
        currency: 'USD',
        ...contract,
        proposal: 1,
        req_id: reqId,
        underlying_symbol: request.symbol,
      };
    }
    case 'ticks_history':
      // Como en la captura, el esquema de la petición pide `end` como texto y `start` entero.
      return 'granularity' in request
        ? {
            count: request.count,
            end: String(request.end),
            granularity: request.granularity,
            req_id: reqId,
            start: request.start,
            style: 'candles',
            ticks_history: request.symbol,
          }
        : {
            count: request.count,
            end: String(request.end),
            req_id: reqId,
            start: request.start,
            style: 'ticks',
            ticks_history: request.symbol,
          };
    case 'trading_times':
      return { req_id: reqId, trading_times: request.date };
  }
}

/**
 * Texto de la petición, o `null` si no cumple su esquema de petición en la release fijada: el
 * conector valida cada petición propia antes de enviarla, como la captura (ADR-0012 §2).
 */
export function encodeBatchRequest(
  schemas: DerivSchemaSet<BatchOperation>,
  request: BatchRequest,
  reqId: number,
): string | null {
  const body = batchRequestBody(request, reqId);
  return schemas.schema(request.operation, 'request').validate(body) ? canonicalJson(body) : null;
}

const DAY_SECONDS = 86_400;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** El epoch en segundos de las 00:00 UTC de un día `AAAA-MM-DD` real; si no, lanza. */
export function dayStartEpoch(date: string): number {
  const match = DATE.exec(date);
  const epoch =
    match === null
      ? Number.NaN
      : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new TypeError(`${date} no es un día UTC AAAA-MM-DD.`);
  }
  return epoch / 1000;
}

function dayOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Las peticiones de los horarios de un día, en orden: `trading_times` del día y de los
 * `days_ahead` siguientes, `active_symbols` y `contracts_for` de cada símbolo.
 */
export function scheduleRequests(profile: SchedulesProfile, date: string): BatchRequest[] {
  const start = dayStartEpoch(date);
  const days = Array.from({ length: profile.days_ahead + 1 }, (_, offset) =>
    dayOf(start + offset * DAY_SECONDS),
  );
  return [
    ...days.map((day): BatchRequest => ({ date: day, operation: 'trading_times' })),
    { operation: 'active_symbols' },
    ...profile.symbols.map((symbol): BatchRequest => ({ operation: 'contracts_for', symbol })),
  ];
}

/**
 * Las peticiones de una vuelta de cotizaciones, en orden: por mercado, `MULTUP` y `MULTDOWN` con
 * cada multiplicador y `CALL` y `PUT` con cada duración.
 */
export function quoteRequests(profile: QuotesProfile): BatchRequest[] {
  const stake = Number(profile.stake);
  if (!/^[1-9][0-9]*$/u.test(profile.stake) || !Number.isSafeInteger(stake)) {
    throw new TypeError('La apuesta del perfil tiene que ser un entero positivo.');
  }
  if (profile.currency !== 'USD') {
    throw new TypeError('Las reglas de los lotes 4.0.0 solo reconocen apuestas en USD.');
  }
  return profile.markets.flatMap(({ durations, multipliers, symbol }) => [
    ...(['MULTUP', 'MULTDOWN'] as const).flatMap((contract_type) =>
      multipliers.map((multiplier): BatchRequest => ({
        contract_type,
        multiplier,
        operation: 'proposal',
        stake,
        symbol,
      })),
    ),
    ...(['CALL', 'PUT'] as const).flatMap((contract_type) =>
      durations.map((duration): BatchRequest => ({
        contract_type,
        duration,
        operation: 'proposal',
        stake,
        symbol,
      })),
    ),
  ]);
}

/**
 * Las peticiones de las velas de un día UTC, en orden: el `trading_times` de ese día, con el que las
 * reglas 4.0.0 buscan las velas que faltan dentro del horario (precisión del PR 5d1 de ADR-0021 §9),
 * y las páginas: por símbolo, de las 00:00:00 al último segundo del día en tramos contiguos de
 * `page_seconds`, cada uno con su primer y su último segundo incluidos.
 */
export function candleRequests(profile: CandlesProfile, date: string): BatchRequest[] {
  if (profile.granularity_seconds !== 60) {
    throw new TypeError('Las reglas de los lotes 4.0.0 solo reconocen velas de 60 s.');
  }
  if (
    profile.page_seconds <= 0 ||
    DAY_SECONDS % profile.page_seconds !== 0 ||
    profile.page_seconds % profile.granularity_seconds !== 0 ||
    profile.page_seconds / profile.granularity_seconds > profile.count
  ) {
    throw new TypeError(
      'Las páginas tienen que partir el día en tramos de velas enteras que quepan en una página.',
    );
  }
  const start = dayStartEpoch(date);
  const pages = DAY_SECONDS / profile.page_seconds;
  return [
    { date, operation: 'trading_times' },
    ...profile.symbols.flatMap((symbol) =>
      Array.from({ length: pages }, (_, page): BatchRequest => ({
        count: profile.count,
        end: start + (page + 1) * profile.page_seconds - 1,
        granularity: profile.granularity_seconds,
        operation: 'ticks_history',
        start: start + page * profile.page_seconds,
        symbol,
      })),
    ),
  ];
}

/** Un bloque de la historia: su primer segundo y sus peticiones, en el orden en que se piden. */
export interface HistoryBlock {
  readonly requests: readonly BatchRequest[];
  readonly start: number;
}

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Los bloques de una historia (precisión del PR 6a de ADR-0021 §9), del más antiguo al más
 * reciente, porque Deriv borra primero lo más antiguo: cada uno, el `trading_times` de su día y sus
 * tramos contiguos, que no se solapan, con su primer y su último segundo incluidos, hasta
 * `end_epoch`, donde el último bloque y el último tramo pueden quedar cortos. Lanza si los bloques no
 * parten el día, si los tramos no parten el bloque o si un bloque puede pasar del techo de un
 * dataset: sus tramos con `count` ticks como mucho cada uno, y uno por segundo como mucho, más el
 * horario.
 */
export function historyBlocks(profile: HistoryProfile): HistoryBlock[] {
  const { block_seconds, count, end_epoch, start_epoch, symbol, tranche_seconds } = profile;
  if (
    symbol === '' ||
    !positiveInteger(count) ||
    !positiveInteger(tranche_seconds) ||
    !positiveInteger(block_seconds) ||
    DAY_SECONDS % block_seconds !== 0 ||
    block_seconds % tranche_seconds !== 0
  ) {
    throw new TypeError('Los bloques tienen que partir el día UTC, y los tramos, cada bloque.');
  }
  if (
    (block_seconds / tranche_seconds) * Math.min(count, tranche_seconds) + 1 >
    DATASET_ELEMENT_CEILING
  ) {
    throw new TypeError('Un bloque de la historia no puede pasar del techo de un dataset.');
  }
  if (
    !Number.isSafeInteger(start_epoch) ||
    !Number.isSafeInteger(end_epoch) ||
    start_epoch < 0 ||
    start_epoch % block_seconds !== 0 ||
    end_epoch < start_epoch
  ) {
    throw new TypeError('La historia empieza en un comienzo de bloque y no termina antes.');
  }
  const blocks: HistoryBlock[] = [];
  for (let block = start_epoch; block <= end_epoch; block += block_seconds) {
    const last = Math.min(block + block_seconds - 1, end_epoch);
    const requests: BatchRequest[] = [{ date: dayOf(block), operation: 'trading_times' }];
    for (let start = block; start <= last; start += tranche_seconds) {
      requests.push({
        count,
        end: Math.min(start + tranche_seconds - 1, last),
        operation: 'ticks_history',
        start,
        symbol,
      });
    }
    blocks.push({ requests, start: block });
  }
  return blocks;
}

/**
 * Los bloques de la historia de las velas (precisión del PR 6d de ADR-0021 §9), del día más antiguo
 * al más reciente, como los de los ticks: un día UTC cada uno, con las peticiones de las velas de ese
 * día (`candleRequests`), su `trading_times` y sus páginas. Lanza si la historia no empieza al
 * comienzo de un día y termina al final de otro, no posterior, o si un día puede pasar del techo de un
 * dataset: sus velas, una por minuto y símbolo, más un horario por símbolo.
 */
export function candleHistoryBlocks(profile: CandleHistoryProfile): HistoryBlock[] {
  const { block_seconds, end_epoch, granularity_seconds, start_epoch, symbols } = profile;
  if (block_seconds !== DAY_SECONDS) {
    throw new TypeError('Un bloque de la historia de las velas es un día UTC.');
  }
  if (
    !Number.isSafeInteger(start_epoch) ||
    !Number.isSafeInteger(end_epoch) ||
    start_epoch < 0 ||
    start_epoch % DAY_SECONDS !== 0 ||
    (end_epoch + 1) % DAY_SECONDS !== 0 ||
    end_epoch < start_epoch
  ) {
    throw new TypeError('La historia de las velas va de un comienzo de día a un final de día.');
  }
  if (
    symbols.length === 0 ||
    symbols.length * (DAY_SECONDS / granularity_seconds + 1) > DATASET_ELEMENT_CEILING
  ) {
    throw new TypeError(
      'Un día de la historia de las velas no puede pasar del techo de un dataset.',
    );
  }
  const blocks: HistoryBlock[] = [];
  for (let day = start_epoch; day <= end_epoch; day += DAY_SECONDS) {
    blocks.push({ requests: candleRequests(profile, dayOf(day)), start: day });
  }
  return blocks;
}

/** Los bloques de una historia, de ticks (`historyBlocks`) o de velas (`candleHistoryBlocks`). */
export function historyBlocksOf(profile: AnyHistoryProfile): HistoryBlock[] {
  return isCandleHistoryProfile(profile) ? candleHistoryBlocks(profile) : historyBlocks(profile);
}

/** Lo que se deja de margen con el borde de lo que guarda Deriv, que avanza mientras se pide. */
export const HISTORY_WINDOW_MARGIN_SECONDS = 3_600;

/**
 * La primera petición de la historia que Deriv todavía guarda a la hora `nowMs`: la primera del
 * primer bloque que empieza al menos `HISTORY_WINDOW_MARGIN_SECONDS` después del borde de
 * `DERIV_HISTORY_DAYS` días. Un tramo más antiguo daría los últimos ticks del símbolo, fuera de lo
 * pedido, que las reglas 4.0.0 rechazan (`history_inconsistent`), así que no se pide; con las velas,
 * Deriv da las últimas 1000, que hacen la página `candles_inconsistent` (precisión del PR 6e de
 * ADR-0021 §9). Si no queda ninguno, el número de peticiones.
 */
export function historyRequestsFrom(blocks: readonly HistoryBlock[], nowMs: number): number {
  const edge = Math.floor(nowMs / 1000) - DERIV_HISTORY_DAYS * DAY_SECONDS;
  let index = 0;
  for (const block of blocks) {
    if (block.start >= edge + HISTORY_WINDOW_MARGIN_SECONDS) {
      return index;
    }
    index += block.requests.length;
  }
  return index;
}
