import { z } from 'zod';

const SCHEMA_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONDITION_KEY_PATTERN =
  /^(?:connection_lost|event_gap_unresolved|persistence_unavailable|source_limit_exceeded):sha256:[0-9a-f]{64}$/u;

export const schemaVersionSchema = z.string().regex(SCHEMA_VERSION_PATTERN);

const utcTimestampMsStructuralSchema = z.iso.datetime({ offset: false, precision: 3 });

export const utcTimestampMsSchema = utcTimestampMsStructuralSchema.refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'Debe ser un instante UTC real con milisegundos exactos.');

export const decimalStringSchema = z.string().regex(DECIMAL_PATTERN);
export const sha256HexSchema = z.string().regex(SHA256_PATTERN);
export const datasetIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const uuidV7Schema = z.string().regex(UUID_V7_PATTERN);
export const derivedEventIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const eventRefSchema = z.union([uuidV7Schema, derivedEventIdSchema]);
export const conditionKeySchema = z.string().regex(CONDITION_KEY_PATTERN);
export const symbolSchema = z.string().min(1);
export const nonEmptyStringSchema = z.string().min(1);
export const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const absoluteUriSchema = z.url();

export function isSortedUnique(values: readonly string[]): boolean {
  return values.slice(1).every((value, index) => {
    const previous = values[index];
    return previous !== undefined && previous < value;
  });
}

export function compareUtc(left: string, right: string): number {
  return left.localeCompare(right);
}

export type SchemaVersion = z.infer<typeof schemaVersionSchema>;
export type UtcTimestampMs = z.infer<typeof utcTimestampMsSchema>;
export type Sha256Hex = z.infer<typeof sha256HexSchema>;
export type DatasetId = z.infer<typeof datasetIdSchema>;
export type UuidV7 = z.infer<typeof uuidV7Schema>;
export type DerivedEventId = z.infer<typeof derivedEventIdSchema>;
export type EventRef = z.infer<typeof eventRefSchema>;
