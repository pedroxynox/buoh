import { z } from 'zod';

import { qualityIncidentTypeSchema } from './enums.js';
import { canonicalJson, sha256Hex, type JsonValue } from './identity.js';
import {
  decimalStringSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  schemaVersionSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

export const marketTickStructuralSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    observation_id: uuidV7Schema,
    source: nonEmptyStringSchema,
    connector_version: nonEmptyStringSchema,
    symbol: symbolSchema,
    event_time_utc: utcTimestampMsSchema,
    received_at_utc: utcTimestampMsSchema,
    quote_decimal: decimalStringSchema,
    pip_size: z.number().int().min(0).max(18),
    origin: z.enum(['stream', 'history_recovery']),
    raw_payload_sha256: sha256HexSchema,
    tick_fingerprint_sha256: sha256HexSchema,
    quality_flags: z.array(qualityIncidentTypeSchema),
  })
  .meta({ id: 'MarketTick', title: 'MarketTick' });

export function deriveTickFingerprint(
  tick: Pick<
    z.infer<typeof marketTickStructuralSchema>,
    'event_time_utc' | 'pip_size' | 'quote_decimal' | 'source' | 'symbol'
  >,
): string {
  const identity: JsonValue = {
    event_time_utc: tick.event_time_utc,
    pip_size: tick.pip_size,
    quote_decimal: tick.quote_decimal,
    source: tick.source,
    symbol: tick.symbol,
  };
  return sha256Hex(canonicalJson(identity));
}

export const marketTickSchema = marketTickStructuralSchema.superRefine((value, context) => {
  const decimalPoint = value.quote_decimal.indexOf('.');
  const decimalPlaces = decimalPoint === -1 ? 0 : value.quote_decimal.length - decimalPoint - 1;

  if (decimalPlaces !== value.pip_size) {
    context.addIssue({
      code: 'custom',
      message: 'quote_decimal debe contener exactamente pip_size decimales.',
      path: ['quote_decimal'],
    });
  }

  if (!isSortedUnique(value.quality_flags)) {
    context.addIssue({
      code: 'custom',
      message: 'quality_flags debe ser único y estar ordenado.',
      path: ['quality_flags'],
    });
  }

  if (deriveTickFingerprint(value) !== value.tick_fingerprint_sha256) {
    context.addIssue({
      code: 'custom',
      message: 'tick_fingerprint_sha256 no corresponde a la identidad canónica.',
      path: ['tick_fingerprint_sha256'],
    });
  }
});

export type MarketTick = z.infer<typeof marketTickSchema>;
