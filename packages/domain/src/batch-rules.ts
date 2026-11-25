import {
  contractOfferSchema,
  contractQuoteSchema,
  dataQualityIncidentSchema,
  deriveEventId,
  tradingDateSchema,
  tradingSessionSchema,
  type ContractOffer,
  type ContractQuote,
  type ContractTypeOffer,
  type DataQualityIncident,
  type RawSourceFrame,
  type TradingInterval,
  type TradingSession,
} from '@buoh/contracts';

import {
  getMember,
  parseJsonPreservingNumbers,
  toPlainJson,
  type JsonNode,
} from './json-lexeme.js';
import { epochSecondsToUtc, isEpochSecondsLexeme } from './normalizer.js';

/**
 * Reglas de los lotes 4.0.0 (contratos de dominio, «Semántica ejecutable de las reglas de los
 * lotes 4.0.0»; ADR-0021 §3 y §4). Son un conjunto propio, no la versión siguiente de las reglas en
 * vivo: el número sigue la serie para que una `quality_rule_version` nombre un solo conjunto. Sus
 * incidencias usan el esquema 3.0.0. Este módulo convierte una respuesta de `trading_times`,
 * `contracts_for` o `proposal`; las velas y los ticks de la historia llegan con el PR 4d.
 */
export const BATCH_RULE_SET = {
  incident_schema_version: '3.0.0',
  quality_rule_version: '4.0.0',
} as const;

/** El esquema de respuesta de la operación en la release fijada, compilado por quien llama. */
export interface BatchResponseSchema {
  readonly validate: (value: unknown) => boolean;
}

/**
 * Motivos de `invalid_source_frame` de las reglas de los lotes. Los dos primeros, como en las
 * respuestas pedidas: un objeto `error` y el esquema de la release. Los demás, de cada operación.
 */
export type BatchInvalidReason =
  | 'contracts_for_duplicate_entry'
  | 'contracts_for_inconsistent'
  | 'proposal_inconsistent'
  | 'proposal_request_unsupported'
  | 'schema_validation_failed'
  | 'source_error_response'
  | 'trading_date_unknown'
  | 'trading_times_inconsistent';

/** Lo que da una respuesta: sus registros, en orden canónico, y sus incidencias. */
export interface BatchConversion<T> {
  readonly incidents: readonly DataQualityIncident[];
  readonly records: readonly T[];
}

/** El rechazo de un multiplicador (ADR-0024 §4): el único error de `proposal` que lo es. */
const MULTIPLIER_REJECTION = { code: 'ContractBuyValidationError', field: 'multiplier' } as const;

const CALLPUT_TYPES = new Set(['CALL', 'PUT']);
const MULTIPLIER_TYPES = new Set(['MULTUP', 'MULTDOWN']);
const CALLPUT_EXPIRIES = new Set(['daily', 'intraday', 'tick']);
const DURATION_UNITS = new Set(['d', 'h', 'm', 's', 't']);
const MAXIMUM_DURATION = 99_999_999;
const DAY_SECONDS = 86_400;

/** Los campos que manda el paso de los lotes en `proposal`; otro hace que la cotización no sea suya. */
const PROPOSAL_REQUEST_KEYS = new Set([
  'amount',
  'basis',
  'contract_type',
  'currency',
  'duration',
  'duration_unit',
  'multiplier',
  'proposal',
  'req_id',
  'underlying_symbol',
]);

function stringOf(node: JsonNode | undefined): string | null {
  return node?.type === 'string' && node.value.length > 0 ? node.value : null;
}

/** El lexema de un número sin exponente: ya es un `DecimalString` (la gramática de JSON lo asegura). */
function decimalOf(node: JsonNode | undefined): string | null {
  return node?.type === 'number' && !/[eE]/u.test(node.lexeme) ? node.lexeme : null;
}

function isPositive(decimal: string): boolean {
  return !decimal.startsWith('-') && /[1-9]/u.test(decimal);
}

/** Un entero positivo del lexema, sin signo ni fracción, hasta el máximo de `proposal`. */
function positiveIntegerOf(node: JsonNode | undefined): number | null {
  if (node?.type !== 'number' || !/^[1-9]\d{0,7}$/u.test(node.lexeme)) {
    return null;
  }
  const value = Number(node.lexeme);
  return value <= MAXIMUM_DURATION ? value : null;
}

function parseFrame(frame: RawSourceFrame, msgType: string): JsonNode {
  let root: JsonNode;
  try {
    root = parseJsonPreservingNumbers(frame.payload_utf8);
  } catch (error) {
    throw new TypeError(
      `El frame ${frame.observation_id} no es JSON; solo se convierten respuestas ya correlacionadas.`,
      { cause: error },
    );
  }
  if (stringOf(getMember(root, 'msg_type')) !== msgType) {
    throw new TypeError(`El frame ${frame.observation_id} no es una respuesta a ${msgType}.`);
  }
  return root;
}

function incidentOf(body: Record<string, unknown>): DataQualityIncident {
  const full = {
    ...body,
    quality_rule_version: BATCH_RULE_SET.quality_rule_version,
    related_refs: [],
    schema_version: BATCH_RULE_SET.incident_schema_version,
  };
  return dataQualityIncidentSchema.parse({
    ...full,
    incident_id: deriveEventId(full),
  });
}

/** `invalid_source_frame` de una respuesta, con el símbolo pedido si se sabe. */
export function deriveBatchInvalidIncident(
  frame: RawSourceFrame,
  reason: BatchInvalidReason,
  symbol: string | null,
): DataQualityIncident {
  return incidentOf({
    evidence: { raw_payload_sha256: frame.raw_payload_sha256, reason },
    incident_type: 'invalid_source_frame',
    observed_at_utc: frame.received_at_utc,
    observed_ref: frame.observation_id,
    severity: 'error',
    source: frame.source,
    symbol,
  });
}

function invalid<T>(
  frame: RawSourceFrame,
  reason: BatchInvalidReason,
  symbol: string | null,
): BatchConversion<T> {
  return { incidents: [deriveBatchInvalidIncident(frame, reason, symbol)], records: [] };
}

/** Las dos comprobaciones comunes: un objeto `error` y el esquema de la release. */
function commonFailure(root: JsonNode, schema: BatchResponseSchema): BatchInvalidReason | null {
  if (getMember(root, 'error')?.type === 'object') {
    return 'source_error_response';
  }
  return schema.validate(toPlainJson(root)) ? null : 'schema_validation_failed';
}

const provenance = (frame: RawSourceFrame) =>
  ({
    connector_version: frame.connector_version,
    observation_id: frame.observation_id,
    raw_payload_sha256: frame.raw_payload_sha256,
    received_at_utc: frame.received_at_utc,
    source: frame.source,
  }) as const;

// --- trading_times -----------------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/u;

function secondsOfDay(time: string): number | null {
  const match = TIME_PATTERN.exec(time);
  return match === null ? null : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Los intervalos de un día desde `times.open` y `times.close`. `--` en las dos, un día sin
 * cotización. Un cierre `23:59:59` es el fin del día. Dos intervalos que se tocan son uno. `null`
 * si las listas no son coherentes.
 */
function intervalsOf(times: JsonNode | undefined, date: string): TradingInterval[] | null {
  const open = getMember(times, 'open');
  const close = getMember(times, 'close');
  if (
    open?.type !== 'array' ||
    close?.type !== 'array' ||
    open.items.length !== close.items.length
  ) {
    return null;
  }
  const opens = open.items.map(stringOf);
  const closes = close.items.map(stringOf);
  if (opens.length === 1 && opens[0] === '--' && closes[0] === '--') {
    return [];
  }
  const spans: [number, number][] = [];
  for (const [index, openText] of opens.entries()) {
    const closeText = closes[index] ?? null;
    const from = openText === null ? null : secondsOfDay(openText);
    // Un cierre `23:59:59` es el fin del día: la sesión sigue a las 00:00 del día siguiente.
    const to =
      closeText === '23:59:59' ? DAY_SECONDS : closeText === null ? null : secondsOfDay(closeText);
    if (from === null || to === null || to <= from) {
      return null;
    }
    const previous = spans.at(-1);
    if (previous?.[1] === from) {
      previous[1] = to;
    } else {
      spans.push([from, to]);
    }
  }
  const dayStart = Date.parse(`${date}T00:00:00.000Z`);
  const iso = (seconds: number) => new Date(dayStart + seconds * 1000).toISOString();
  return spans.map(([from, to]) => ({ closes_at_utc: iso(to), opens_at_utc: iso(from) }));
}

/**
 * Convierte una respuesta de `trading_times` en un `TradingSession` por cada símbolo de `symbols`
 * que trae. Un símbolo que no trae no da registro: su día queda sin horario. Uno repetido o con
 * horas incoherentes da su incidencia, y los demás siguen. Pura.
 */
export function deriveTradingSessions(
  frame: RawSourceFrame,
  schema: BatchResponseSchema,
  symbols: readonly string[],
): BatchConversion<TradingSession> {
  const root = parseFrame(frame, 'trading_times');
  const common = commonFailure(root, schema);
  if (common !== null) {
    return invalid(frame, common, null);
  }
  const requested = stringOf(getMember(getMember(root, 'echo_req'), 'trading_times'));
  const date =
    requested !== null && tradingDateSchema.safeParse(requested).success ? requested : null;
  if (date === null) {
    return invalid(frame, 'trading_date_unknown', null);
  }

  const bySymbol = new Map<string, JsonNode[]>();
  const markets = getMember(getMember(root, 'trading_times'), 'markets');
  for (const market of markets?.type === 'array' ? markets.items : []) {
    const submarkets = getMember(market, 'submarkets');
    for (const submarket of submarkets?.type === 'array' ? submarkets.items : []) {
      const listed = getMember(submarket, 'symbols');
      for (const entry of listed?.type === 'array' ? listed.items : []) {
        const symbol = stringOf(getMember(entry, 'underlying_symbol'));
        if (symbol !== null) {
          bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), entry]);
        }
      }
    }
  }

  const records: TradingSession[] = [];
  const incidents: DataQualityIncident[] = [];
  for (const symbol of [...new Set(symbols)].sort((left, right) => (left < right ? -1 : 1))) {
    const entries = bySymbol.get(symbol) ?? [];
    if (entries.length === 0) {
      continue;
    }
    const intervals =
      entries.length === 1 ? intervalsOf(getMember(entries[0], 'times'), date) : null;
    const parsed =
      intervals === null
        ? null
        : tradingSessionSchema.safeParse({
            ...provenance(frame),
            intervals,
            schema_version: '1.0.0',
            symbol,
            trading_date: date,
          });
    if (parsed?.success === true) {
      records.push(parsed.data);
    } else {
      incidents.push(deriveBatchInvalidIncident(frame, 'trading_times_inconsistent', symbol));
    }
  }
  return { incidents, records };
}

// --- contracts_for -----------------------------------------------------------------------------

const DURATION_PATTERN = /^([1-9]\d{0,7})([dhmst])$/u;

function durationOf(node: JsonNode | undefined) {
  const match = DURATION_PATTERN.exec(stringOf(node) ?? '');
  return match === null
    ? null
    : { duration: Number(match[1]), duration_unit: match[2] as 'd' | 'h' | 'm' | 's' | 't' };
}

/**
 * Proyecta una entrada de `contracts_for` de uno de los cuatro tipos de buoh. `undefined` si es de
 * otro tipo, que no entra; `null` si es de los cuatro pero incoherente.
 */
function offerOf(item: JsonNode, symbol: string): ContractTypeOffer | null | undefined {
  const type = stringOf(getMember(item, 'contract_type'));
  if (type === null || (!CALLPUT_TYPES.has(type) && !MULTIPLIER_TYPES.has(type))) {
    return undefined;
  }
  const category = stringOf(getMember(item, 'contract_category'));
  const expiry = stringOf(getMember(item, 'expiry_type'));
  if (stringOf(getMember(item, 'underlying_symbol')) !== symbol || expiry === null) {
    return null;
  }
  if (MULTIPLIER_TYPES.has(type)) {
    return category === 'multiplier' && expiry === 'no_expiry'
      ? {
          contract_category: 'multiplier',
          contract_type: type as 'MULTDOWN' | 'MULTUP',
          expiry_type: 'no_expiry',
        }
      : null;
  }
  const minimum = durationOf(getMember(item, 'min_contract_duration'));
  const maximum = durationOf(getMember(item, 'max_contract_duration'));
  if (
    category !== 'callput' ||
    !CALLPUT_EXPIRIES.has(expiry) ||
    minimum === null ||
    maximum === null
  ) {
    return null;
  }
  return {
    contract_category: 'callput',
    contract_type: type as 'CALL' | 'PUT',
    expiry_type: expiry as 'daily' | 'intraday' | 'tick',
    max_contract_duration: maximum,
    min_contract_duration: minimum,
  };
}

/**
 * Convierte una respuesta de `contracts_for` en el `ContractOffer` de su símbolo: los cuatro tipos
 * de buoh que ofrece y, en sube/baja, las duraciones de cada vencimiento, sin los multiplicadores.
 * Una entrada de los cuatro incoherente, o dos del mismo tipo y vencimiento, no dan registro: sigue
 * valiendo el anterior. Pura.
 */
export function deriveContractOffer(
  frame: RawSourceFrame,
  schema: BatchResponseSchema,
): BatchConversion<ContractOffer> {
  const root = parseFrame(frame, 'contracts_for');
  const symbol = stringOf(getMember(getMember(root, 'echo_req'), 'contracts_for'));
  const common = commonFailure(root, schema);
  if (common !== null) {
    return invalid(frame, common, symbol);
  }
  const available = getMember(getMember(root, 'contracts_for'), 'available');
  if (symbol === null || available?.type !== 'array') {
    return invalid(frame, 'contracts_for_inconsistent', symbol);
  }

  const offers: ContractTypeOffer[] = [];
  for (const item of available.items) {
    const offer = offerOf(item, symbol);
    if (offer === null) {
      return invalid(frame, 'contracts_for_inconsistent', symbol);
    }
    if (offer !== undefined) {
      offers.push(offer);
    }
  }
  const pairs = new Set(offers.map((offer) => `${offer.contract_type}\u0000${offer.expiry_type}`));
  if (pairs.size !== offers.length) {
    return invalid(frame, 'contracts_for_duplicate_entry', symbol);
  }
  // El orden del contrato: `contract_type` y `expiry_type`, con el `<` de JavaScript.
  offers.sort((left, right) =>
    left.contract_type !== right.contract_type
      ? left.contract_type < right.contract_type
        ? -1
        : 1
      : left.expiry_type < right.expiry_type
        ? -1
        : 1,
  );
  const parsed = contractOfferSchema.safeParse({
    ...provenance(frame),
    offers,
    schema_version: '1.0.0',
    symbol,
  });
  return parsed.success
    ? { incidents: [], records: [parsed.data] }
    : invalid(frame, 'contracts_for_inconsistent', symbol);
}

// --- proposal ----------------------------------------------------------------------------------

type QuotedContract =
  | {
      readonly contract_category: 'callput';
      readonly contract_type: 'CALL' | 'PUT';
      readonly duration: { duration: number; duration_unit: 'd' | 'h' | 'm' | 's' | 't' };
    }
  | {
      readonly contract_category: 'multiplier';
      readonly contract_type: 'MULTDOWN' | 'MULTUP';
      readonly multiplier_decimal: string;
    };

/**
 * El contrato pedido, de `echo_req`, si es uno de los que pide el paso de los lotes: apuesta en USD
 * con `basis: stake`, un sube/baja con su duración o un multiplicador, y ningún otro campo.
 */
function requestOf(
  echo: JsonNode | undefined,
): { contract: QuotedContract; stake: string; symbol: string } | null {
  if (
    echo?.type !== 'object' ||
    [...echo.entries.keys()].some((key) => !PROPOSAL_REQUEST_KEYS.has(key))
  ) {
    return null;
  }
  const symbol = stringOf(getMember(echo, 'underlying_symbol'));
  const type = stringOf(getMember(echo, 'contract_type'));
  const stake = decimalOf(getMember(echo, 'amount'));
  if (
    symbol === null ||
    type === null ||
    stake === null ||
    !isPositive(stake) ||
    stringOf(getMember(echo, 'basis')) !== 'stake' ||
    stringOf(getMember(echo, 'currency')) !== 'USD'
  ) {
    return null;
  }
  const hasDuration = echo.entries.has('duration') || echo.entries.has('duration_unit');
  if (CALLPUT_TYPES.has(type)) {
    const duration = positiveIntegerOf(getMember(echo, 'duration'));
    const unit = stringOf(getMember(echo, 'duration_unit'));
    if (
      duration === null ||
      unit === null ||
      !DURATION_UNITS.has(unit) ||
      echo.entries.has('multiplier')
    ) {
      return null;
    }
    return {
      contract: {
        contract_category: 'callput',
        contract_type: type as 'CALL' | 'PUT',
        duration: { duration, duration_unit: unit as 'd' | 'h' | 'm' | 's' | 't' },
      },
      stake,
      symbol,
    };
  }
  const multiplier = decimalOf(getMember(echo, 'multiplier'));
  if (
    !MULTIPLIER_TYPES.has(type) ||
    multiplier === null ||
    !isPositive(multiplier) ||
    hasDuration
  ) {
    return null;
  }
  return {
    contract: {
      contract_category: 'multiplier',
      contract_type: type as 'MULTDOWN' | 'MULTUP',
      multiplier_decimal: multiplier,
    },
    stake,
    symbol,
  };
}

/**
 * Convierte una respuesta de `proposal` en un `ContractQuote`, o en su incidencia. El rechazo de un
 * multiplicador (`ContractBuyValidationError` con `details.field` `multiplier`) da
 * `contract_rejected`, con el contrato pedido; cualquier otro error, como `RateLimit` o un mercado
 * cerrado, da `invalid_source_frame` con `source_error_response`, que no cambia qué se ofrece
 * (ADR-0024 §4). Pura.
 */
export function deriveContractQuote(
  frame: RawSourceFrame,
  schema: BatchResponseSchema,
): BatchConversion<ContractQuote> {
  const root = parseFrame(frame, 'proposal');
  const echo = getMember(root, 'echo_req');
  const request = requestOf(echo);
  const symbol = request?.symbol ?? stringOf(getMember(echo, 'underlying_symbol'));

  const error = getMember(root, 'error');
  if (error?.type === 'object') {
    const code = stringOf(getMember(error, 'code'));
    const field = stringOf(getMember(getMember(error, 'details'), 'field'));
    if (
      request?.contract.contract_category === 'multiplier' &&
      code === MULTIPLIER_REJECTION.code &&
      field === MULTIPLIER_REJECTION.field
    ) {
      const incident = incidentOf({
        evidence: {
          contract_type: request.contract.contract_type,
          error_code: code,
          multiplier_decimal: request.contract.multiplier_decimal,
          raw_payload_sha256: frame.raw_payload_sha256,
        },
        incident_type: 'contract_rejected',
        observed_at_utc: frame.received_at_utc,
        observed_ref: frame.observation_id,
        severity: 'info',
        source: frame.source,
        symbol: request.symbol,
      });
      return { incidents: [incident], records: [] };
    }
    return invalid(frame, 'source_error_response', symbol);
  }
  if (!schema.validate(toPlainJson(root))) {
    return invalid(frame, 'schema_validation_failed', symbol);
  }
  if (request === null) {
    return invalid(frame, 'proposal_request_unsupported', symbol);
  }

  const proposal = getMember(root, 'proposal');
  const askPrice = decimalOf(getMember(proposal, 'ask_price'));
  const spotTime = getMember(proposal, 'spot_time');
  const quotedAt =
    spotTime?.type === 'number' && isEpochSecondsLexeme(spotTime.lexeme)
      ? epochSecondsToUtc(Number(spotTime.lexeme))
      : null;
  const quoted =
    request.contract.contract_category === 'callput'
      ? { payout_decimal: decimalOf(getMember(proposal, 'payout')) }
      : { commission_decimal: decimalOf(getMember(proposal, 'commission')) };
  // Un importe que falta, no es un decimal o es `null`, como `commission`, o una hora que no es un
  // instante, los rechaza el contrato: la cotización queda `proposal_inconsistent`.
  const parsed = contractQuoteSchema.safeParse({
    ...provenance(frame),
    ...request.contract,
    ...quoted,
    ask_price_decimal: askPrice,
    currency: 'USD',
    quoted_at_utc: quotedAt,
    schema_version: '1.0.0',
    stake_decimal: request.stake,
    symbol: request.symbol,
  });
  return parsed.success
    ? { incidents: [], records: [parsed.data] }
    : invalid(frame, 'proposal_inconsistent', request.symbol);
}

// --- orden -------------------------------------------------------------------------------------

/**
 * Orden canónico de los horarios, los contratos y las cotizaciones de un dataset de los lotes:
 * `received_at_utc`, `observation_id` y `symbol`, por unidades UTF-16 (el `<` de JavaScript).
 * Un frame da como mucho un registro por símbolo, así que nunca hay empate.
 */
export function compareBatchRecords(
  left: Pick<TradingSession, 'observation_id' | 'received_at_utc' | 'symbol'>,
  right: Pick<TradingSession, 'observation_id' | 'received_at_utc' | 'symbol'>,
): number {
  for (const key of ['received_at_utc', 'observation_id', 'symbol'] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  return 0;
}
