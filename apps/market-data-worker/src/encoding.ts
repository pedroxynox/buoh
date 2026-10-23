import { gunzipSync, gzipSync } from 'node:zlib';

import { type StorageObjectRef } from '@buoh/contracts';
import { type ObjectEncoder } from '@buoh/domain';

/** Segmento raw sin comprimir (ADR-0004 §7); también acota la descompresión en replay. */
export const MAX_SOURCE_SEGMENT_BYTES = 67_108_864;

/** Nombre declarado en `StorageObjectRef.writer_name` para gzip. */
export const GZIP_WRITER_NAME = 'node:zlib';
const GZIP_LEVEL = 9;

/**
 * Codificación física de F1.3 (ADR-0004 §6): source events en gzip determinista para el mismo
 * writer (`node:zlib`, nivel 9, sin nombre ni fecha en la cabecera); el resto en NDJSON/JSON sin
 * compresión. Parquet queda para un incremento posterior. Pura: la versión de zlib se inyecta.
 */
export function createStorageEncoder(zlibVersion: string): ObjectEncoder {
  if (zlibVersion.length === 0) {
    throw new TypeError('La versión de zlib es obligatoria para declarar el writer.');
  }
  return ({ logical_bytes, role }) =>
    role === 'source_events'
      ? {
          bytes: new Uint8Array(gzipSync(logical_bytes, { level: GZIP_LEVEL })),
          compression: 'gzip',
          writer_name: GZIP_WRITER_NAME,
          writer_version: zlibVersion,
        }
      : { bytes: logical_bytes, compression: 'none' };
}

/** Content-Type de almacenamiento; no forma parte del contrato. */
export function storageContentType(object: StorageObjectRef): string {
  return object.compression === 'gzip' ? 'application/gzip' : object.media_type;
}

/**
 * Decodifica bytes físicos a bytes lógicos sin superar `maxLogicalBytes`. Parquet no está
 * soportado en F1.3 y se rechaza en lugar de interpretarse parcialmente.
 */
export function decodeObject(
  object: StorageObjectRef,
  bytes: Uint8Array,
  maxLogicalBytes: number = MAX_SOURCE_SEGMENT_BYTES,
): Uint8Array {
  if (object.media_type === 'application/vnd.apache.parquet') {
    throw new TypeError(`Formato físico no soportado en F1.3: ${object.media_type}`);
  }
  if (object.compression === 'none') {
    return bytes;
  }
  return new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxLogicalBytes }));
}
