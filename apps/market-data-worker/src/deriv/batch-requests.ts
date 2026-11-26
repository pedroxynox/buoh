import { canonicalJson, type ContractDuration, type JsonValue } from '@buoh/contracts';

import type { CandlesProfile, QuotesProfile, SchedulesProfile } from './batch-profile.js';
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
      /** El día UTC, `AAAA-MM-DD`. */
      readonly date: string;
      readonly operation: 'trading_times';
    };

/**
 * `msg_type` de la respuesta que espera cada petición. Una página de velas responde con `candles`;
 * un error a `ticks_history`, con `ticks_history` y un objeto `error` (reglas 4.0.0, «Un log»).
 * Las páginas de ticks de la historia, del PR 6, responden con `history`: serán otra petición.
 */
export const EXPECTED_BATCH_MSG_TYPE = {
  active_symbols: 'active_symbols',
  contracts_for: 'contracts_for',
  proposal: 'proposal',
  ticks_history: 'candles',
  trading_times: 'trading_times',
} as const satisfies Record<BatchOperation, string>;

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
      return {
        count: request.count,
        end: String(request.end),
        granularity: request.granularity,
        req_id: reqId,
        start: request.start,
        style: 'candles',
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
