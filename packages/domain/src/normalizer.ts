import { deriveTickFingerprint, type MarketTick, type RawSourceFrame } from '@buoh/contracts';

import {
  getMember,
  JsonLexemeError,
  parseJsonPreservingNumbers,
  toPlainJson,
  type JsonNode,
} from './json-lexeme.js';
import { CONTRACT_SCHEMA_VERSION, type PipelineProfile } from './profile.js';

/**
 * Motivos estables de `invalid_source_frame.evidence.reason`. `source_error_response` solo existe
 * desde el normalizador 2.0.0.
 */
export type InvalidFrameReason =
  | 'event_time_out_of_range'
  | 'payload_not_json'
  | 'quote_exponent_not_supported'
  | 'quote_precision_exceeds_pip_size'
  | 'schema_validation_failed'
  | 'source_error_response'
  | 'symbol_not_allowed';

export type UnflaggedTick = Omit<MarketTick, 'quality_flags'>;

export type NormalizationResult =
  | { readonly ok: true; readonly tick: UnflaggedTick }
  /** `symbol = null` solo con reglas 2.0.0, cuando ningún dato del frame permite atribuirlo. */
  | { readonly ok: false; readonly reason: InvalidFrameReason; readonly symbol: string | null }
  /** Reglas 2.0.0: mensaje de otro tipo (ping, catálogo, historia…); se conserva raw, sin incidencia. */
  | { readonly ok: false; readonly msg_type: string; readonly reason: 'non_tick' };

export class SymbolAttributionError extends Error {
  constructor(observationId: string) {
    super(
      `No se puede atribuir símbolo al frame inválido ${observationId}: el perfil admite varios símbolos y el payload no declara uno permitido.`,
    );
    this.name = 'SymbolAttributionError';
  }
}

/**
 * Atribuye símbolo a un frame inválido, en este orden: `tick.symbol` del payload si es un símbolo
 * permitido; con reglas 2.0.0, `echo_req.ticks` (la copia de la petición que devuelve la fuente) si
 * es permitido; el único símbolo del perfil. Sin atribución posible, las reglas 1.0.0 abortan y las
 * 2.0.0 devuelven `null`.
 */
function attributeSymbol(
  root: JsonNode | undefined,
  frame: RawSourceFrame,
  profile: PipelineProfile,
): string | null {
  const allowed = profile.quality_profile.allowed_symbols;
  const candidates = [getMember(getMember(root, 'tick'), 'symbol')];
  if (profile.rules.classifies_msg_type) {
    candidates.push(getMember(getMember(root, 'echo_req'), 'ticks'));
  }
  for (const candidate of candidates) {
    if (candidate?.type === 'string' && allowed.includes(candidate.value)) {
      return candidate.value;
    }
  }
  const [only] = allowed;
  if (allowed.length === 1 && only !== undefined) {
    return only;
  }
  if (profile.rules.classifies_msg_type) {
    return null;
  }
  throw new SymbolAttributionError(frame.observation_id);
}

/** Resultado de `canonicalQuoteDecimal`: el decimal canónico o el motivo de su rechazo. */
export type QuoteDecimalResult =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly reason: Extract<
        InvalidFrameReason,
        'quote_exponent_not_supported' | 'quote_precision_exceeds_pip_size'
      >;
    };

/**
 * Cotización en decimal canónico (ADR-0004 §4): el lexema de un número JSON con exactamente
 * `pipSize` decimales, completados con ceros y sin aritmética binaria. Rechaza un exponente y más
 * decimales que `pipSize`. Es la regla de `quote_decimal` en el normalizador, y la usa también quien
 * compara con un tick una cotización de otra respuesta, como la recuperación de historia del worker
 * (ADR-0015 §4).
 */
export function canonicalQuoteDecimal(lexeme: string, pipSize: number): QuoteDecimalResult {
  if (/[eE]/u.test(lexeme)) {
    return { ok: false, reason: 'quote_exponent_not_supported' };
  }
  const [integerPart = '', fraction = ''] = lexeme.split('.');
  if (fraction.length > pipSize) {
    return { ok: false, reason: 'quote_precision_exceeds_pip_size' };
  }
  const padded = fraction.padEnd(pipSize, '0');
  return { ok: true, value: pipSize === 0 ? integerPart : `${integerPart}.${padded}` };
}

/**
 * `pip_size` válido (ADR-0004 §4): el lexema de un entero de 0 a 18, sin signo, fracción, exponente
 * ni ceros a la izquierda. Es la regla del normalizador para un tick; la respuesta de historia usa
 * `pipSizeFromNumberLexeme`.
 */
export function isPipSizeLexeme(lexeme: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(lexeme) && Number(lexeme) <= 18;
}

/**
 * `pip_size` de una respuesta de historia (ADR-0015 §4), que solo tiene que dar los decimales de sus
 * cotizaciones: el lexema de un valor entero de 0 a 18, como el de `isPipSizeLexeme` o seguido de
 * una fracción de ceros (`2.0`, como lo manda el canal real en la historia). Devuelve ese entero, o
 * `null` con signo, otra fracción, exponente o ceros a la izquierda. La regla de un tick no cambia.
 */
export function pipSizeFromNumberLexeme(lexeme: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.0+)?$/u.test(lexeme)) {
    return null;
  }
  const value = Number(lexeme);
  return value <= 18 ? value : null;
}

/**
 * Epoch en segundos enteros (ADR-0004 §4): el lexema de un entero, sin fracción, exponente ni ceros
 * a la izquierda, para no inventar fracciones. No comprueba el rango de la hora. Es una regla del
 * normalizador que comparte la recuperación de historia.
 */
export function isEpochSecondsLexeme(lexeme: string): boolean {
  return /^-?(?:0|[1-9]\d*)$/u.test(lexeme);
}

function epochSecondsToUtc(seconds: number): string | null {
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    return null;
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  const iso = date.toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso) ? iso : null;
}

/**
 * Normalizador 1.0.0/2.0.0 (según `profile.rules`): valida el payload exacto contra el esquema de
 * fuente fijado y proyecta un `MarketTick` sin flags. Nunca modifica el raw.
 */
export function normalizeRawFrame(
  frame: RawSourceFrame,
  profile: PipelineProfile,
): NormalizationResult {
  let root: JsonNode | undefined;
  try {
    root = parseJsonPreservingNumbers(frame.payload_utf8);
  } catch (error) {
    if (!(error instanceof JsonLexemeError)) {
      throw error;
    }
    return {
      ok: false,
      reason: 'payload_not_json',
      symbol: attributeSymbol(undefined, frame, profile),
    };
  }

  const invalid = (reason: InvalidFrameReason): NormalizationResult => ({
    ok: false,
    reason,
    symbol: attributeSymbol(root, frame, profile),
  });

  if (profile.rules.classifies_msg_type) {
    // Reglas 2.0.0: los tipos de respuesta declarados por el perfil (ping, catálogo, historia…) se
    // conservan raw sin tick ni incidencia; cualquier otro mensaje sigue siendo candidato a tick.
    const msgType = getMember(root, 'msg_type');
    if (msgType?.type === 'string' && profile.nonTickMsgTypes.has(msgType.value)) {
      return { msg_type: msgType.value, ok: false, reason: 'non_tick' };
    }
    // Un objeto `error` de la fuente en un mensaje no declarado como respuesta es inválido.
    if (getMember(root, 'error')?.type === 'object') {
      return invalid('source_error_response');
    }
  }

  if (!profile.validateSourcePayload(toPlainJson(root))) {
    return invalid('schema_validation_failed');
  }

  // El esquema garantiza la forma; los lexemas se leen del árbol, no de valores binarios.
  const tick = getMember(root, 'tick');
  const symbolNode = getMember(tick, 'symbol');
  const epochNode = getMember(tick, 'epoch');
  const pipNode = getMember(tick, 'pip_size');
  const quoteNode = getMember(tick, 'quote');
  if (
    symbolNode?.type !== 'string' ||
    epochNode?.type !== 'number' ||
    pipNode?.type !== 'number' ||
    quoteNode?.type !== 'number'
  ) {
    return invalid('schema_validation_failed');
  }

  if (!profile.quality_profile.allowed_symbols.includes(symbolNode.value)) {
    return invalid('symbol_not_allowed');
  }

  // ADR-0004 §4: epoch entero en segundos, sin fracciones inventadas; pip_size 0..18. Se exigen
  // aquí además del esquema de fuente para no depender de un esquema más laxo.
  if (!isPipSizeLexeme(pipNode.lexeme)) {
    return invalid('schema_validation_failed');
  }
  if (!isEpochSecondsLexeme(epochNode.lexeme)) {
    return invalid('event_time_out_of_range');
  }
  const eventTime = epochSecondsToUtc(Number(epochNode.lexeme));
  if (eventTime === null) {
    return invalid('event_time_out_of_range');
  }

  const pipSize = Number(pipNode.lexeme);
  const quote = canonicalQuoteDecimal(quoteNode.lexeme, pipSize);
  if (!quote.ok) {
    return invalid(quote.reason);
  }

  const identity = {
    event_time_utc: eventTime,
    pip_size: pipSize,
    quote_decimal: quote.value,
    source: frame.source,
    symbol: symbolNode.value,
  };

  return {
    ok: true,
    tick: {
      ...identity,
      connector_version: frame.connector_version,
      observation_id: frame.observation_id,
      origin: 'stream',
      raw_payload_sha256: frame.raw_payload_sha256,
      received_at_utc: frame.received_at_utc,
      schema_version: CONTRACT_SCHEMA_VERSION,
      tick_fingerprint_sha256: deriveTickFingerprint(identity),
    },
  };
}
