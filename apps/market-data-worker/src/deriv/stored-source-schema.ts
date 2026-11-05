import { sha256Hex } from '@buoh/contracts';
import { SOURCE_LIMITS } from '@buoh/domain';

import { ObjectReadError } from '../errors.js';
import { contentKey } from '../object-keys.js';
import type { ObjectStore } from '../ports.js';
import { SOURCE_SCHEMA_ENTRY, type ExpectedSchemaArchive } from './schema-release.js';

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
 * API (ADR-0019 §8). Si el almacenamiento no responde, rechaza con su error, sin convertirlo.
 */
export async function readStoredSourceSchema(
  objects: Pick<ObjectStore, 'get'>,
  expected: ExpectedSchemaArchive,
): Promise<StoredSourceSchema> {
  const pinned = expected.entries_sha256[SOURCE_SCHEMA_ENTRY];
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
