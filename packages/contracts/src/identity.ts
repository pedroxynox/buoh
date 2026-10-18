import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: JsonValue): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new TypeError('El valor no puede representarse como JSON canónico.');
  }
  return result;
}

export function deriveEventId(valueWithoutId: JsonValue): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(valueWithoutId))}`;
}

export function deriveDatasetId(manifestCore: JsonValue): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(manifestCore))}`;
}

export function canonicalSequence(records: readonly JsonValue[]): string {
  if (records.length === 0) {
    return '';
  }
  return `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
}
