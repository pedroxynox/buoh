import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

import type { WorkerConfig } from '../config.js';
import { HEALTH_CONNECTION_TIMEOUT_MS, HEALTH_REQUEST_TIMEOUT_MS } from '../runtime.js';
import { createS3Client, isObjectLocked } from '../s3/object-store.js';
import type { LogLocation } from '../successive-logs.js';

// La retención de `buoh-operaciones` (ADR-0018 §7 y §11, paso 3): borra el log que venció, primero
// los objetos de su prefijo, por partes, y, cuando el listado del prefijo vuelve vacío, su esquema.
// Un objeto que la regla de bloqueo del bucket todavía protege se intenta otra vez en una ejecución
// siguiente.

/**
 * El plazo del borrado de una ejecución. Lo que queda sigue en la ejecución siguiente: un log de un
 * día tiene unos 45 000 objetos, y uno de una semana, unos 315 000.
 */
export const RETENTION_DEADLINE_MS = 60_000;

/** Las claves de cada página del listado: el máximo de `ListObjectsV2`. */
export const RETENTION_PAGE_KEYS = 1000;

/** Los borrados que van a la vez, uno por objeto (`DeleteObject`). */
export const RETENTION_CONCURRENCY = 8;

/** El prefijo de un log de producción: `logs/` y su número en seis cifras (`logLocation`). */
const LOG_PREFIX = /^logs\/[0-9]{6}\/$/u;

/** Lo que pasó al borrar un objeto. */
export type ObjectDeletion = 'deleted' | 'locked';

/** Los objetos de un log para borrarlos, siempre bajo su prefijo. */
export interface LogDeletion {
  /**
   * Hasta `max` claves del prefijo del log, sin el prefijo, en orden, y después de `startAfter` si
   * se da. Rechaza con el error del almacenamiento si no responde, y con
   * `ListingOutsidePrefixError` si trae una clave fuera del prefijo.
   */
  list(startAfter: string | null, max: number): Promise<string[]>;
  /**
   * Borra el objeto de la clave, bajo el prefijo del log: `deleted`, también si ya no estaba, o
   * `locked` si la regla de bloqueo del bucket todavía lo protege (409 con
   * `ObjectLockedByBucketPolicy`). Rechaza con cualquier otro error.
   */
  delete(key: string): Promise<ObjectDeletion>;
  /** Libera el cliente, y con él sus conexiones. */
  close(): void;
}

/**
 * El almacenamiento listó una clave fuera del prefijo del log que se le pidió. El motivo saneado es
 * su código, `listing_outside_prefix`: la retención para sin borrar el esquema.
 */
export class ListingOutsidePrefixError extends Error {
  readonly code = 'listing_outside_prefix';

  constructor() {
    super('El listado del prefijo de un log trajo una clave fuera de él.');
    this.name = 'ListingOutsidePrefixError';
  }
}

/** Lanza `TypeError` si el prefijo no es el de un log de producción, por ejemplo uno vacío. */
function assertLogPrefix(log: LogLocation): void {
  if (!LOG_PREFIX.test(log.prefix)) {
    throw new TypeError('La retención solo borra bajo el prefijo de un log: logs/ y seis cifras.');
  }
}

/**
 * Los objetos del log en el bucket, con el cliente dado. Solo trabaja bajo el prefijo de un log de
 * producción: con otro, por ejemplo uno vacío, que sería el bucket entero, lanza `TypeError`. Las
 * claves que lista son las de ese prefijo, sin él, y las que borra van siempre bajo él. Borra un
 * objeto por petición (`DeleteObject`): R2 respondió así a la regla de bloqueo en las comprobaciones
 * previas (ADR-0018 §10), mientras que `DeleteObjects` exige una suma de comprobación del cuerpo.
 */
export function logDeletion(client: S3Client, bucket: string, log: LogLocation): LogDeletion {
  assertLogPrefix(log);
  return {
    close: () => {
      client.destroy();
    },
    delete: async (key) => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: log.prefix + key }));
        return 'deleted';
      } catch (error) {
        if (isObjectLocked(error)) {
          return 'locked';
        }
        throw error;
      }
    },
    list: async (startAfter, max) => {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: max,
          Prefix: log.prefix,
          ...(startAfter === null ? {} : { StartAfter: log.prefix + startAfter }),
        }),
      );
      return (page.Contents ?? []).map((item) => {
        // Una clave fuera del prefijo, de un almacén que no respetó `Prefix`, no se descarta: un
        // listado que pareciera vacío dejaría borrar el esquema con objetos en el prefijo.
        if (item.Key?.startsWith(log.prefix) !== true) {
          throw new ListingOutsidePrefixError();
        }
        return item.Key.slice(log.prefix.length);
      });
    },
  };
}

/**
 * Los objetos del log con el token de la retención, el `operaciones` (`logDeletion`), con los plazos
 * de cada conexión y de la espera de las cabeceras de `data:health` (5000 ms y 10 000 ms). Con un
 * prefijo que no es el de un log lanza `TypeError` sin abrir nada.
 */
export function openLogDeletion(
  objects: Omit<WorkerConfig['s3'], 'keyPrefix'>,
  log: LogLocation,
): LogDeletion {
  assertLogPrefix(log);
  const client = createS3Client(objects, {
    connectionTimeout: HEALTH_CONNECTION_TIMEOUT_MS,
    requestTimeout: HEALTH_REQUEST_TIMEOUT_MS,
  });
  return logDeletion(client, objects.bucket, log);
}

/** Lo que llevan borrado los borrados de una ejecución, y si tienen que parar. */
export interface DeletionProgress {
  deleted: number;
  locked: number;
  /** Lo pone quien llama al vencer el plazo, y un borrado que falla: ninguno empieza otro. */
  stopped: boolean;
}

/**
 * Borra las claves con `RETENTION_CONCURRENCY` borrados a la vez, y anota en `progress` cada uno
 * que termina. Rechaza con el primer error que no es la regla de bloqueo, y desde ahí, o desde que
 * `progress.stopped` se pone, ningún borrado empieza otro.
 */
export async function deleteKeys(
  objects: Pick<LogDeletion, 'delete'>,
  keys: readonly string[],
  progress: DeletionProgress,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    try {
      while (!progress.stopped) {
        const key = keys[next];
        next += 1;
        if (key === undefined) {
          return;
        }
        if ((await objects.delete(key)) === 'locked') {
          progress.locked += 1;
        } else {
          progress.deleted += 1;
        }
      }
    } catch (error) {
      progress.stopped = true;
      throw error;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RETENTION_CONCURRENCY, keys.length) }, () => worker()),
  );
}
