import { deriveTickFingerprint, type MarketTick, type RawSourceFrame } from '@buoh/contracts';

import {
  getMember,
  JsonLexemeError,
  parseJsonPreservingNumbers,
  toPlainJson,
  type JsonNode,
} from './json-lexeme.js';
import { CONTRACT_SCHEMA_VERSION, type PipelineProfile } from './profile.js';

/** Motivos estables de `invalid_source_frame.evidence.reason` del normalizador 1.0.0. */
export type InvalidFrameReason =
  | 'event_time_out_of_range'
  | 'payload_not_json'
  | 'quote_exponent_not_supported'
  | 'quote_precision_exceeds_pip_size'
  | 'schema_validation_failed'
  | 'symbol_not_allowed';

export type UnflaggedTick = Omit<MarketTick, 'quality_flags'>;

export type NormalizationResult =
  | { readonly ok: true; readonly tick: UnflaggedTick }
  | { readonly ok: false; readonly reason: InvalidFrameReason; readonly symbol: string };

export class SymbolAttributionError extends Error {
  constructor(observationId: string) {
    super(
      `No se puede atribuir símbolo al frame inválido ${observationId}: el perfil admite varios símbolos y el payload no declara uno permitido.`,
    );
    this.name = 'SymbolAttributionError';
  }
}

/**
 * Atribuye símbolo a un frame inválido: `tick.symbol` del payload si es un símbolo permitido;
 * si no, el único símbolo del perfil. Con varios símbolos y sin atribución posible, aborta.
 */
function attributeSymbol(
  root: JsonNode | undefined,
  frame: RawSourceFrame,
  profile: PipelineProfile,
) {
  const allowed = profile.quality_profile.allowed_symbols;
  const declared = getMember(getMember(root, 'tick'), 'symbol');
  if (declared?.type === 'string' && allowed.includes(declared.value)) {
    return declared.value;
  }
  const [only] = allowed;
  if (allowed.length === 1 && only !== undefined) {
    return only;
  }
  throw new SymbolAttributionError(frame.observation_id);
}

/** Convierte el lexema numérico a decimal canónico con exactamente `pipSize` decimales. */
function toQuoteDecimal(
  lexeme: string,
  pipSize: number,
): { ok: true; value: string } | { ok: false; reason: InvalidFrameReason } {
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
 * Normalizador 1.0.0: valida el payload exacto contra el esquema de fuente fijado y proyecta un
 * `MarketTick` sin flags. Nunca modifica el raw.
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
  if (!/^(?:0|[1-9]\d*)$/u.test(pipNode.lexeme) || Number(pipNode.lexeme) > 18) {
    return invalid('schema_validation_failed');
  }
  if (!/^-?(?:0|[1-9]\d*)$/u.test(epochNode.lexeme)) {
    return invalid('event_time_out_of_range');
  }
  const eventTime = epochSecondsToUtc(Number(epochNode.lexeme));
  if (eventTime === null) {
    return invalid('event_time_out_of_range');
  }

  const pipSize = Number(pipNode.lexeme);
  const quote = toQuoteDecimal(quoteNode.lexeme, pipSize);
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
