import { gunzipSync } from 'node:zlib';

import { sha256Hex } from '@buoh/contracts';
import { SEGMENT_POLICY } from '@buoh/domain';

import { type WorkerConfig } from '../config.js';
import { ObjectReadError } from '../errors.js';
import { contentKey } from '../object-keys.js';
import { HEALTH_CONNECTION_TIMEOUT_MS, HEALTH_REQUEST_TIMEOUT_MS } from '../runtime.js';
import { S3ObjectStore } from '../s3/object-store.js';
import { type ClosedSourceSegment } from '../source-log/ports.js';
import { type LogLocation } from '../successive-logs.js';

// La verificación por partes de `buoh-operaciones` (ADR-0018 §11, paso 4): la verificación
// periódica de ADR-0017 §4. Cada ejecución vuelve a leer los segmentos cerrados que le tocan de los
// logs que no han vencido y compara sus hashes con `closed_source_segments`, así que cada segmento
// se relee una vez al día y un objeto antiguo que falta o cambió se encuentra, aunque los lectores en
// vivo ya no lo lean.

/** Las ejecuciones de un día, una cada 5 minutos: el segmento *i* toca en la de *i* mod 288. */
export const VERIFICATION_SLOTS = 288;

/**
 * El plazo de la verificación de una ejecución. Lo normal son unos 40 segmentos pequeños en unos
 * segundos; con un almacenamiento lento, lo que queda espera a su ejecución del día siguiente, para
 * que la de 5 minutos después, con su salud, no se retrase.
 */
export const VERIFICATION_DEADLINE_MS = 60_000;

/** La ejecución del día de una hora UTC: 12 *h* + ⌊*m* / 5⌋, de 0 a 287 (ADR-0018 §11). */
export function verificationSlot(isoUtc: string): number {
  const time = new Date(isoUtc);
  if (Number.isNaN(time.getTime())) {
    throw new TypeError('La hora de la ejecución no es una hora UTC válida.');
  }
  return 12 * time.getUTCHours() + Math.floor(time.getUTCMinutes() / 5);
}

/** Lo que la verificación necesita de una fila de `closed_source_segments`. */
export type DueSegment = Pick<
  ClosedSourceSegment,
  | 'compression'
  | 'logical_content_sha256'
  | 'object_bytes_sha256'
  | 'object_size_bytes'
  | 'segment_index'
>;

/** Los objetos de un log, bajo su prefijo, con la lectura de `ObjectStore`. */
export interface LogObjects {
  /** Lee el objeto entero. Rechaza con `ObjectReadError` si no existe o si pasa de `maxBytes`. */
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  /** Libera el cliente. */
  close(): void;
}

/** Por qué un segmento no coincide con su fila. */
export type SegmentMismatch =
  | 'logical_sha256_mismatch'
  | 'object_missing'
  | 'object_sha256_mismatch'
  | 'object_too_large'
  | 'segment_not_decompressible';

/**
 * Vuelve a leer el objeto del segmento (`sha256/<object_bytes_sha256>`, como mucho
 * `object_size_bytes`) y compara su SHA-256 con `object_bytes_sha256` y el de su contenido, ya
 * descomprimido, con `logical_content_sha256`. Da `null` si coinciden o el motivo si no: un objeto
 * que no existe o que es mayor que su fila también es contenido que el índice confirmó y cambió.
 * Rechaza con el error del almacenamiento si no responde.
 */
export async function verifySegment(
  objects: Pick<LogObjects, 'get'>,
  segment: DueSegment,
): Promise<SegmentMismatch | null> {
  let physical: Uint8Array;
  try {
    physical = await objects.get(
      contentKey(segment.object_bytes_sha256),
      segment.object_size_bytes,
    );
  } catch (error) {
    if (error instanceof ObjectReadError) {
      return error.reason === 'not_found' ? 'object_missing' : 'object_too_large';
    }
    throw error;
  }
  if (sha256Hex(physical) !== segment.object_bytes_sha256) {
    return 'object_sha256_mismatch';
  }
  let logical: Uint8Array;
  try {
    logical =
      segment.compression === 'gzip'
        ? new Uint8Array(gunzipSync(physical, { maxOutputLength: SEGMENT_POLICY.maximum_bytes }))
        : physical;
  } catch {
    return 'segment_not_decompressible';
  }
  return sha256Hex(logical) === segment.logical_content_sha256 ? null : 'logical_sha256_mismatch';
}

/**
 * Los objetos del log con el token de la verificación, bajo el prefijo del log, con los plazos de
 * cada conexión y de la espera de las cabeceras de `data:health` (5000 ms y 10 000 ms). La lectura
 * del cuerpo no tiene plazo en el cliente: la acota el de la verificación, que al vencer cierra el
 * cliente (`close`), y con él sus conexiones.
 */
export function openLogObjects(
  objects: Omit<WorkerConfig['s3'], 'keyPrefix'>,
  log: LogLocation,
): LogObjects {
  const store = S3ObjectStore.fromConfig(
    { ...objects, keyPrefix: log.prefix },
    {
      connectionTimeout: HEALTH_CONNECTION_TIMEOUT_MS,
      requestTimeout: HEALTH_REQUEST_TIMEOUT_MS,
    },
  );
  return {
    close: () => {
      store.destroy();
    },
    get: (key, maxBytes) => store.get(key, maxBytes),
  };
}
