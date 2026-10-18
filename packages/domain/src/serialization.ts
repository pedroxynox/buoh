import { canonicalJson, canonicalSequence, type JsonValue } from '@buoh/contracts';

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Bytes NDJSON lógicos: cada registro en JCS, unidos por `\n`, newline final; vacío = 0 bytes. */
export function ndjsonBytes(records: readonly unknown[]): Uint8Array {
  return utf8(canonicalSequence(records as readonly JsonValue[]));
}

/** Documento JCS sin newline, tal como se almacena un manifiesto. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value as JsonValue));
}

function compareJcsKeys(left: string, right: string): number {
  // RFC 8785 ordena claves por unidades UTF-16, que es el orden por defecto de JavaScript.
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderPretty(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const inner = `${indent}  `;
    return `[\n${value.map((item) => inner + renderPretty(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareJcsKeys);
    if (keys.length === 0) {
      return '{}';
    }
    const inner = `${indent}  `;
    const record = value as Record<string, unknown>;
    return `{\n${keys
      .map((key) => `${inner}${JSON.stringify(key)}: ${renderPretty(record[key], inner)}`)
      .join(',\n')}\n${indent}}`;
  }
  return canonicalJson(value as JsonValue);
}

/** Representación legible de los vectores: claves en orden JCS, sangría de 2 y newline final. */
export function prettyCanonicalJson(value: unknown): string {
  return `${renderPretty(value, '')}\n`;
}
