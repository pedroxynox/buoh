import { z } from 'zod';

import {
  compareDecimalsOfSameScale,
  decimalPlaces,
  frameProvenanceFields,
} from './batch-records.js';
import { qualityIncidentTypeSchema } from './enums.js';
import { canonicalJson, sha256Hex, type JsonValue } from './identity.js';
import {
  decimalStringSchema,
  isSortedUnique,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
} from './scalars.js';

/**
 * `MarketCandle` 1.0.0 (contratos de dominio, «MarketCandle»; ADR-0021 §4): una vela de 1 minuto
 * que calcula Deriv (`ticks_history` con `style: candles`), con la procedencia de `MarketTick`.
 * Nunca se mezcla con las velas que arma buoh con sus ticks.
 */
export const marketCandleStructuralSchema = z
  .strictObject({
    schema_version: z.literal('1.0.0'),
    observation_id: frameProvenanceFields.observation_id,
    source: frameProvenanceFields.source,
    connector_version: frameProvenanceFields.connector_version,
    symbol: symbolSchema,
    open_time_utc: utcTimestampMsSchema,
    granularity_seconds: z.literal(60),
    open_decimal: decimalStringSchema,
    high_decimal: decimalStringSchema,
    low_decimal: decimalStringSchema,
    close_decimal: decimalStringSchema,
    pip_size: z.number().int().min(0).max(18),
    received_at_utc: frameProvenanceFields.received_at_utc,
    raw_payload_sha256: frameProvenanceFields.raw_payload_sha256,
    candle_fingerprint_sha256: sha256HexSchema,
    quality_flags: z.array(qualityIncidentTypeSchema),
  })
  .meta({ id: 'MarketCandle', title: 'MarketCandle' });

type StructuralCandle = z.infer<typeof marketCandleStructuralSchema>;

/**
 * Identidad de la vela sin la observación ni la recepción: la misma vela en dos páginas tiene la
 * misma huella, como un tick repetido (`deriveTickFingerprint`).
 */
export function deriveCandleFingerprint(
  candle: Pick<
    StructuralCandle,
    | 'close_decimal'
    | 'granularity_seconds'
    | 'high_decimal'
    | 'low_decimal'
    | 'open_decimal'
    | 'open_time_utc'
    | 'pip_size'
    | 'source'
    | 'symbol'
  >,
): string {
  const identity: JsonValue = {
    close_decimal: candle.close_decimal,
    granularity_seconds: candle.granularity_seconds,
    high_decimal: candle.high_decimal,
    low_decimal: candle.low_decimal,
    open_decimal: candle.open_decimal,
    open_time_utc: candle.open_time_utc,
    pip_size: candle.pip_size,
    source: candle.source,
    symbol: candle.symbol,
  };
  return sha256Hex(canonicalJson(identity));
}

const PRICE_FIELDS = ['open_decimal', 'high_decimal', 'low_decimal', 'close_decimal'] as const;

export const marketCandleSchema = marketCandleStructuralSchema.superRefine((value, context) => {
  const scaled = PRICE_FIELDS.filter((field) => decimalPlaces(value[field]) !== value.pip_size);
  for (const field of scaled) {
    context.addIssue({
      code: 'custom',
      message: `${field} debe contener exactamente pip_size decimales.`,
      path: [field],
    });
  }

  // Con la misma escala, los cuatro se comparan exactos, como enteros.
  if (scaled.length === 0) {
    const {
      close_decimal: close,
      high_decimal: high,
      low_decimal: low,
      open_decimal: open,
    } = value;
    if (compareDecimalsOfSameScale(high, open) < 0 || compareDecimalsOfSameScale(high, close) < 0) {
      context.addIssue({
        code: 'custom',
        message: 'high_decimal no puede ser menor que la apertura ni que el cierre.',
        path: ['high_decimal'],
      });
    }
    if (compareDecimalsOfSameScale(low, open) > 0 || compareDecimalsOfSameScale(low, close) > 0) {
      context.addIssue({
        code: 'custom',
        message: 'low_decimal no puede ser mayor que la apertura ni que el cierre.',
        path: ['low_decimal'],
      });
    }
  }

  const openMs = Date.parse(value.open_time_utc);
  const granularityMs = value.granularity_seconds * 1000;
  if (openMs % granularityMs !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'open_time_utc debe ser un múltiplo de granularity_seconds en UTC.',
      path: ['open_time_utc'],
    });
  }

  // Solo velas cerradas: el fin del intervalo, sin incluir, no puede ser posterior a la recepción.
  if (openMs + granularityMs > Date.parse(value.received_at_utc)) {
    context.addIssue({
      code: 'custom',
      message: 'La vela no estaba cerrada al recibirse: su fin es posterior a received_at_utc.',
      path: ['open_time_utc'],
    });
  }

  if (!isSortedUnique(value.quality_flags)) {
    context.addIssue({
      code: 'custom',
      message: 'quality_flags debe ser único y estar ordenado.',
      path: ['quality_flags'],
    });
  }

  if (deriveCandleFingerprint(value) !== value.candle_fingerprint_sha256) {
    context.addIssue({
      code: 'custom',
      message: 'candle_fingerprint_sha256 no corresponde a la identidad canónica.',
      path: ['candle_fingerprint_sha256'],
    });
  }
});

export type MarketCandle = z.infer<typeof marketCandleSchema>;
