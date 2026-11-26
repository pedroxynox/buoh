import { sha256Hex } from '@buoh/contracts';
import {
  BATCH_SOURCE_SCHEMA_OPERATIONS,
  batchSourceSchemaBytes,
  SOURCE_LIMITS,
  type BatchSourceSchemaOperation,
} from '@buoh/domain';

import { ObjectReadError } from '../errors.js';
import { contentKey } from '../object-keys.js';
import type { ObjectStore } from '../ports.js';
import {
  schemaEntryName,
  SOURCE_SCHEMA_ENTRY,
  type ExpectedSchemaArchive,
  type SchemaEntryName,
} from './schema-release.js';

/**
 * Lo más que puede medir el esquema de fuente que guardó la ingesta: el máximo de una entrada de
 * `schemas.zip` (ADR-0004 §7), porque la carga rechaza una entrada mayor. La release fijada no da
 * el tamaño de cada entrada, solo su SHA-256. Un objeto mayor bajo esa clave tiene otros bytes.
 */
export const SOURCE_SCHEMA_MAX_BYTES = SOURCE_LIMITS.schema_entry.maximum;

/**
 * El esquema de fuente guardado en el almacenamiento de un log: sus bytes, que no está o que la
 * clave tiene otros bytes.
 */
export type StoredSourceSchema =
  | { readonly status: 'found'; readonly bytes: Uint8Array }
  | { readonly status: 'missing' }
  | { readonly status: 'mismatch' };

/**
 * El esquema de fuente que guardó `ingest` en el almacenamiento del log (ADR-0015 §7), con la clave
 * de su SHA-256 fijado en la release (`SOURCE_SCHEMA_ENTRY`): `found`, con sus bytes; `missing`, si
 * la clave no tiene objeto; o `mismatch`, si tiene otros bytes, mayores que cualquier entrada de
 * esquemas o con otro SHA-256. Con él arman el perfil de medición `data:health` y el gráfico de la
 * API (ADR-0019 §8). Si el almacenamiento no responde, rechaza con su error, sin convertirlo. Con
 * `entry`, la de otra entrada de la release, como las de un log de los lotes
 * (`readStoredBatchSourceSchema`).
 */
export async function readStoredSourceSchema(
  objects: Pick<ObjectStore, 'get'>,
  expected: ExpectedSchemaArchive,
  entry: SchemaEntryName = SOURCE_SCHEMA_ENTRY,
): Promise<StoredSourceSchema> {
  const pinned = expected.entries_sha256[entry];
  let bytes: Uint8Array;
  try {
    bytes = await objects.get(contentKey(pinned), SOURCE_SCHEMA_MAX_BYTES);
  } catch (error) {
    if (error instanceof ObjectReadError) {
      return error.reason === 'not_found' ? { status: 'missing' } : { status: 'mismatch' };
    }
    throw error;
  }
  return sha256Hex(bytes) === pinned ? { bytes, status: 'found' } : { status: 'mismatch' };
}

/**
 * Las entradas de la release que guarda el comando de los lotes en cada log de los lotes antes de su
 * primer evento (precisión del PR 5d2 de ADR-0021 §9): el esquema de respuesta de cada operación de
 * `BATCH_SOURCE_SCHEMA_OPERATIONS`, cada uno con la clave de su SHA-256 fijado, como `ingest` guarda
 * el de `ticks` en un log en vivo.
 */
export const BATCH_SOURCE_SCHEMA_ENTRIES: readonly SchemaEntryName[] = Object.freeze(
  BATCH_SOURCE_SCHEMA_OPERATIONS.map((operation) => schemaEntryName(operation, 'response')),
);

/**
 * El esquema de fuente de un log de los lotes: las entradas de `BATCH_SOURCE_SCHEMA_ENTRIES` que
 * guardó el comando de los lotes, leídas como `readStoredSourceSchema`, reunidas en el documento de
 * `batchSourceSchemaBytes`, el esquema de fuente de sus datasets. `missing` o `mismatch` con la
 * primera entrada que no está o que tiene otros bytes. Si el almacenamiento no responde, rechaza con
 * su error.
 */
export async function readStoredBatchSourceSchema(
  objects: Pick<ObjectStore, 'get'>,
  expected: ExpectedSchemaArchive,
): Promise<StoredSourceSchema> {
  const parts: Partial<Record<BatchSourceSchemaOperation, Uint8Array>> = {};
  for (const operation of BATCH_SOURCE_SCHEMA_OPERATIONS) {
    const stored = await readStoredSourceSchema(
      objects,
      expected,
      schemaEntryName(operation, 'response'),
    );
    if (stored.status !== 'found') {
      return stored;
    }
    parts[operation] = stored.bytes;
  }
  return {
    bytes: batchSourceSchemaBytes(parts as Record<BatchSourceSchemaOperation, Uint8Array>),
    status: 'found',
  };
}
