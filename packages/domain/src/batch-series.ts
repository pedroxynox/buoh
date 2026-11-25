import {
  deriveCandleFingerprint,
  deriveTickFingerprint,
  marketCandleSchema,
  marketTickSchema,
  type ContractOffer,
  type ContractQuote,
  type DataQualityIncident,
  type MarketCandle,
  type MarketTick,
  type RawSourceFrame,
  type SourceEvent,
  type TradingSession,
} from '@buoh/contracts';

import {
  commonFailure,
  compareBatchRecords,
  deriveBatchInvalidIncident,
  deriveContractOffer,
  deriveContractQuote,
  deriveTradingSessions,
  incidentOf,
  invalid,
  parseFrame,
  provenance,
  stringOf,
  type BatchConversion,
  type BatchResponseSchema,
} from './batch-rules.js';
import { deriveCatalogSnapshot, type CatalogResponseSchema } from './catalog.js';
import { readHistoryTicks } from './history-ticks.js';
import { compareIncidents, compareTicks } from './quality.js';
import { getMember, parseJsonPreservingNumbers, type JsonNode } from './json-lexeme.js';
import {
  canonicalQuoteDecimal,
  epochSecondsToUtc,
  isEpochSecondsLexeme,
  pipSizeFromNumberLexeme,
} from './normalizer.js';

/**
 * Las velas y los ticks de la historia de las reglas de los lotes 4.0.0, y la clasificación de los
 * frames de un log de los lotes (contratos de dominio, «Semántica ejecutable de las reglas de los
 * lotes 4.0.0»; ADR-0021 §3 y §4, PR 4d de su §9). Todo es puro.
 */

const CANDLE_SECONDS = 60;
const CANDLE_REQUEST_KEYS = new Set([
  'count',
  'end',
  'granularity',
  'req_id',
  'start',
  'style',
  'ticks_history',
]);
const TICKS_REQUEST_KEYS = new Set(['count', 'end', 'req_id', 'start', 'style', 'ticks_history']);

/** Un entero no negativo de `echo_req`, escrito como número o como texto (`end` llega como texto). */
function echoIntegerOf(node: JsonNode | undefined): number | null {
  const text =
    node?.type === 'number' ? node.lexeme : node?.type === 'string' ? node.value : undefined;
  if (text === undefined || !/^(?:0|[1-9]\d*)$/u.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

interface PageRequest {
  readonly end: number;
  readonly start: number;
  readonly symbol: string;
}

/**
 * La petición de una página, de `echo_req`, si es de las que pide el paso de los lotes: un símbolo,
 * `start` y `end` enteros, sin `end: latest`, y solo los campos de `keys`; si no, `null`.
 */
function pageRequestOf(echo: JsonNode | undefined, keys: ReadonlySet<string>): PageRequest | null {
  if (echo?.type !== 'object' || [...echo.entries.keys()].some((key) => !keys.has(key))) {
    return null;
  }
  const symbol = stringOf(getMember(echo, 'ticks_history'));
  const start = echoIntegerOf(getMember(echo, 'start'));
  const end = echoIntegerOf(getMember(echo, 'end'));
  return symbol === null || start === null || end === null || end < start
    ? null
    : { end, start, symbol };
}

// --- velas -------------------------------------------------------------------------------------

/**
 * Convierte una página de `ticks_history` con `style: candles` y `granularity: 60` en sus velas.
 * Sin velas, como con el mercado cerrado, no da nada. La última vela, si su minuto no había
 * terminado al recibirse la respuesta, no es un registro y no deja incidencia: es la vela en curso
 * que Deriv manda. Cualquier otra incoherencia hace la página entera `candles_inconsistent`.
 */
export function deriveMarketCandles(
  frame: RawSourceFrame,
  schema: BatchResponseSchema,
): BatchConversion<MarketCandle> {
  const root = parseFrame(frame, 'candles');
  const echo = getMember(root, 'echo_req');
  const symbol = stringOf(getMember(echo, 'ticks_history'));
  const common = commonFailure(root, schema);
  if (common !== null) {
    return invalid(frame, common, symbol);
  }
  const request = pageRequestOf(echo, CANDLE_REQUEST_KEYS);
  if (
    request === null ||
    stringOf(getMember(echo, 'style')) !== 'candles' ||
    echoIntegerOf(getMember(echo, 'granularity')) !== CANDLE_SECONDS
  ) {
    return invalid(frame, 'history_request_unsupported', symbol);
  }

  const candles = getMember(root, 'candles');
  const pipNode = getMember(root, 'pip_size');
  const pipSize = pipNode?.type === 'number' ? pipSizeFromNumberLexeme(pipNode.lexeme) : null;
  if (candles?.type !== 'array') {
    return invalid(frame, 'candles_inconsistent', request.symbol);
  }

  const firstMinute = request.start - (request.start % CANDLE_SECONDS);
  const receivedSeconds = Date.parse(frame.received_at_utc) / 1000;
  const records: MarketCandle[] = [];
  let previousEpoch: number | null = null;
  for (const [index, item] of candles.items.entries()) {
    const epochNode = getMember(item, 'epoch');
    const epoch =
      epochNode?.type === 'number' && isEpochSecondsLexeme(epochNode.lexeme)
        ? Number(epochNode.lexeme)
        : null;
    if (
      epoch === null ||
      epoch < firstMinute ||
      epoch > request.end ||
      (previousEpoch !== null && epoch <= previousEpoch)
    ) {
      return invalid(frame, 'candles_inconsistent', request.symbol);
    }
    previousEpoch = epoch;
    if (epoch + CANDLE_SECONDS > receivedSeconds) {
      // La vela en curso solo puede ser la última de la página.
      if (index === candles.items.length - 1) {
        break;
      }
      return invalid(frame, 'candles_inconsistent', request.symbol);
    }
    const [open, high, low, close] = (['open', 'high', 'low', 'close'] as const).map((field) => {
      const node = getMember(item, field);
      const quote =
        node?.type === 'number' && pipSize !== null
          ? canonicalQuoteDecimal(node.lexeme, pipSize)
          : null;
      return quote?.ok === true ? quote.value : null;
    });
    const openTime = epochSecondsToUtc(epoch);
    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      openTime === null ||
      pipSize === null
    ) {
      return invalid(frame, 'candles_inconsistent', request.symbol);
    }
    const identity = {
      close_decimal: close,
      granularity_seconds: CANDLE_SECONDS,
      high_decimal: high,
      low_decimal: low,
      open_decimal: open,
      open_time_utc: openTime,
      pip_size: pipSize,
      source: frame.source,
      symbol: request.symbol,
    } as const;
    const parsed = marketCandleSchema.safeParse({
      ...provenance(frame),
      ...identity,
      candle_fingerprint_sha256: deriveCandleFingerprint(identity),
      quality_flags: [],
      schema_version: '1.0.0',
    });
    if (!parsed.success) {
      return invalid(frame, 'candles_inconsistent', request.symbol);
    }
    records.push(parsed.data);
  }
  return { incidents: [], records };
}

// --- ticks de la historia ----------------------------------------------------------------------

/**
 * Convierte una página de `ticks_history` con `style: ticks` (o sin `style`) de la descarga de la
 * historia en `MarketTick` 1.1.0 con el origen `history_download` y la procedencia del frame. Una
 * página incoherente (`readHistoryTicks`, ADR-0015 §4) no da ningún tick: `history_inconsistent`.
 */
export function deriveHistoryDownloadTicks(
  frame: RawSourceFrame,
  schema: BatchResponseSchema,
): BatchConversion<MarketTick> {
  const root = parseFrame(frame, 'history');
  const echo = getMember(root, 'echo_req');
  const symbol = stringOf(getMember(echo, 'ticks_history'));
  const common = commonFailure(root, schema);
  if (common !== null) {
    return invalid(frame, common, symbol);
  }
  const request = pageRequestOf(echo, TICKS_REQUEST_KEYS);
  const style = getMember(echo, 'style');
  if (request === null || (style !== undefined && stringOf(style) !== 'ticks')) {
    return invalid(frame, 'history_request_unsupported', symbol);
  }
  const page = readHistoryTicks(root, { end: request.end, start: request.start });
  if (page === null) {
    return invalid(frame, 'history_inconsistent', request.symbol);
  }
  const records: MarketTick[] = [];
  for (const tick of page.ticks) {
    const eventTime = epochSecondsToUtc(tick.time);
    if (eventTime === null) {
      return invalid(frame, 'history_inconsistent', request.symbol);
    }
    const identity = {
      event_time_utc: eventTime,
      pip_size: page.pip_size,
      quote_decimal: tick.quote,
      source: frame.source,
      symbol: request.symbol,
    };
    records.push(
      marketTickSchema.parse({
        ...provenance(frame),
        ...identity,
        origin: 'history_download',
        quality_flags: [],
        schema_version: '1.1.0',
        tick_fingerprint_sha256: deriveTickFingerprint(identity),
      }),
    );
  }
  return { incidents: [], records };
}

// --- el log ------------------------------------------------------------------------------------

/** Los esquemas de respuesta de la release fijada que compila quien llama, y los símbolos del perfil. */
export interface BatchLogConfig {
  readonly schemas: {
    readonly active_symbols: CatalogResponseSchema;
    readonly contracts_for: BatchResponseSchema;
    readonly proposal: BatchResponseSchema;
    readonly ticks_history: BatchResponseSchema;
    readonly trading_times: BatchResponseSchema;
  };
  readonly trading_times_symbols: readonly string[];
}

/** Lo que derivan las reglas de los lotes de un log: cada clase en su orden canónico. */
export interface DerivedBatchLog {
  readonly candles: readonly MarketCandle[];
  readonly incidents: readonly DataQualityIncident[];
  readonly offers: readonly ContractOffer[];
  readonly quotes: readonly ContractQuote[];
  readonly sessions: readonly TradingSession[];
  readonly ticks: readonly MarketTick[];
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Velas: `open_time_utc` y `symbol`; tras quitar las repetidas, no hay dos con la misma pareja. */
function compareCandles(left: MarketCandle, right: MarketCandle): number {
  return (
    compareText(left.open_time_utc, right.open_time_utc) || compareText(left.symbol, right.symbol)
  );
}

/**
 * Convierte un frame de un log de los lotes según su `msg_type`. Un frame que no es JSON da
 * `payload_not_json`, y uno que no responde a una operación de los lotes, `unexpected_msg_type`. Un
 * error a `ticks_history`, que Deriv manda con `msg_type` `ticks_history`, da `source_error_response`.
 * La respuesta `active_symbols` válida no da registro: el raw la conserva.
 */
function convertFrame(
  frame: RawSourceFrame,
  config: BatchLogConfig,
): BatchConversion<unknown> & {
  readonly kind: keyof Omit<DerivedBatchLog, 'incidents'> | null;
} {
  let root: JsonNode;
  try {
    root = parseJsonPreservingNumbers(frame.payload_utf8);
  } catch {
    return {
      incidents: [deriveBatchInvalidIncident(frame, 'payload_not_json', null)],
      kind: null,
      records: [],
    };
  }
  const msgType = stringOf(getMember(root, 'msg_type'));
  const { schemas } = config;
  switch (msgType) {
    case 'trading_times':
      return {
        ...deriveTradingSessions(frame, schemas.trading_times, config.trading_times_symbols),
        kind: 'sessions',
      };
    case 'contracts_for':
      return { ...deriveContractOffer(frame, schemas.contracts_for), kind: 'offers' };
    case 'proposal':
      return { ...deriveContractQuote(frame, schemas.proposal), kind: 'quotes' };
    case 'candles':
      return { ...deriveMarketCandles(frame, schemas.ticks_history), kind: 'candles' };
    case 'history':
      return { ...deriveHistoryDownloadTicks(frame, schemas.ticks_history), kind: 'ticks' };
    case 'active_symbols': {
      const catalog = deriveCatalogSnapshot(frame, schemas.active_symbols);
      return catalog.ok
        ? { incidents: [], kind: null, records: [] }
        : {
            incidents: [deriveBatchInvalidIncident(frame, catalog.reason, null)],
            kind: null,
            records: [],
          };
    }
    case 'ticks_history':
      if (getMember(root, 'error')?.type === 'object') {
        const symbol = stringOf(getMember(getMember(root, 'echo_req'), 'ticks_history'));
        return {
          incidents: [deriveBatchInvalidIncident(frame, 'source_error_response', symbol)],
          kind: null,
          records: [],
        };
      }
      break;
    case null:
    default:
      break;
  }
  return {
    incidents: [deriveBatchInvalidIncident(frame, 'unexpected_msg_type', null)],
    kind: null,
    records: [],
  };
}

/**
 * Las reglas de los lotes 4.0.0 sobre los source events de un log, en su orden: cada respuesta da
 * sus registros y sus incidencias, y los eventos de conexión no dan nada. Una vela o un tick que
 * llegan otra vez, en otra página, no son un registro, porque cuenta el primero: la vela deja
 * `candle_repeated`, y el tick, `duplicate_exact` si es igual o `source_time_conflict` si tiene el
 * mismo instante con otro precio, como en las reglas en vivo, con la observación del primero en
 * `related_refs`. Devuelve cada clase en su orden canónico. Pura.
 */
export function deriveBatchLog(
  events: readonly SourceEvent[],
  config: BatchLogConfig,
): DerivedBatchLog {
  const candles: MarketCandle[] = [];
  const ticks: MarketTick[] = [];
  const sessions: TradingSession[] = [];
  const offers: ContractOffer[] = [];
  const quotes: ContractQuote[] = [];
  const incidents: DataQualityIncident[] = [];
  const firstCandle = new Map<string, MarketCandle>();
  const firstTickByFingerprint = new Map<string, MarketTick>();
  const firstTickByTime = new Map<string, MarketTick>();

  const repeated = (frame: RawSourceFrame, symbol: string, body: Record<string, unknown>) =>
    incidentOf({
      ...body,
      observed_at_utc: frame.received_at_utc,
      observed_ref: frame.observation_id,
      source: frame.source,
      symbol,
    });

  for (const event of events) {
    if (event.kind !== 'raw_source_frame') {
      continue;
    }
    const converted = convertFrame(event, config);
    incidents.push(...converted.incidents);
    switch (converted.kind) {
      case 'candles':
        for (const candle of converted.records as MarketCandle[]) {
          const key = JSON.stringify([candle.symbol, candle.open_time_utc]);
          const first = firstCandle.get(key);
          if (first === undefined) {
            firstCandle.set(key, candle);
            candles.push(candle);
            continue;
          }
          const exact = first.candle_fingerprint_sha256 === candle.candle_fingerprint_sha256;
          incidents.push(
            repeated(event, candle.symbol, {
              evidence: {
                candle_fingerprint_sha256: candle.candle_fingerprint_sha256,
                first_candle_fingerprint_sha256: first.candle_fingerprint_sha256,
                open_time_utc: candle.open_time_utc,
              },
              incident_type: 'candle_repeated',
              related_refs: [first.observation_id],
              severity: exact ? 'warning' : 'error',
            }),
          );
        }
        break;
      case 'ticks':
        for (const tick of converted.records as MarketTick[]) {
          const byFingerprint = firstTickByFingerprint.get(tick.tick_fingerprint_sha256);
          const timeKey = JSON.stringify([tick.symbol, tick.event_time_utc]);
          const byTime = firstTickByTime.get(timeKey);
          if (byFingerprint !== undefined) {
            incidents.push(
              repeated(event, tick.symbol, {
                evidence: { tick_fingerprint_sha256: tick.tick_fingerprint_sha256 },
                incident_type: 'duplicate_exact',
                related_refs: [byFingerprint.observation_id],
                severity: 'warning',
              }),
            );
          } else if (byTime !== undefined) {
            const fingerprints = [
              tick.tick_fingerprint_sha256,
              byTime.tick_fingerprint_sha256,
            ].sort(compareText);
            incidents.push(
              repeated(event, tick.symbol, {
                evidence: { event_time_utc: tick.event_time_utc, tick_fingerprints: fingerprints },
                incident_type: 'source_time_conflict',
                related_refs: [byTime.observation_id],
                severity: 'error',
              }),
            );
          } else {
            firstTickByFingerprint.set(tick.tick_fingerprint_sha256, tick);
            firstTickByTime.set(timeKey, tick);
            ticks.push(tick);
          }
        }
        break;
      case 'sessions':
        sessions.push(...(converted.records as TradingSession[]));
        break;
      case 'offers':
        offers.push(...(converted.records as ContractOffer[]));
        break;
      case 'quotes':
        quotes.push(...(converted.records as ContractQuote[]));
        break;
      case null:
        break;
    }
  }
  return {
    candles: candles.sort(compareCandles),
    incidents: incidents.sort(compareIncidents),
    offers: offers.sort(compareBatchRecords),
    quotes: quotes.sort(compareBatchRecords),
    sessions: sessions.sort(compareBatchRecords),
    ticks: ticks.sort(compareTicks),
  };
}
