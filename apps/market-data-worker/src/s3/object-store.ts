import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

import { type WorkerConfig } from '../config.js';
import { ObjectReadError } from '../errors.js';
import { type ObjectStore } from '../ports.js';

function statusOf(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

/**
 * El código con el que R2 rechaza, con 409, escribir o borrar una clave que protege una regla de
 * bloqueo del bucket. R2 comprueba la regla antes que `If-None-Match`, así que una clave protegida
 * que ya existe responde así en lugar de 412, y el objeto no cambia (ADR-0018 §10). El SDK lo deja
 * en `name`.
 */
const OBJECT_LOCKED = 'ObjectLockedByBucketPolicy';

/** Si la escritura condicional falló porque la clave ya existe: 412, o el 409 de la regla de bloqueo. */
function keyExists(error: unknown): boolean {
  const status = statusOf(error);
  return (
    status === 412 ||
    (status === 409 && error instanceof S3ServiceException && error.name === OBJECT_LOCKED)
  );
}

async function readCapped(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  key: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ObjectReadError('too_large', key);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Los plazos de cada petición del cliente S3, en milisegundos, con los nombres del SDK: el de la
 * conexión y el de la petición entera. Sin ellos ninguna tiene plazo; `data:health` los pide
 * (`openHealthStores`).
 */
export interface S3Timeouts {
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
}

/** Un prefijo de claves: vacío, o segmentos de minúsculas, cifras, `_` y `-`, cada uno con su `/`. */
const KEY_PREFIX = /^(?:[a-z0-9][a-z0-9_-]*\/)*$/u;

/**
 * Adaptador S3-compatible (SeaweedFS en local; Cloudflare R2 en producción, ADR-0016). Con
 * `keyPrefix`, cada clave que recibe vive en el bucket bajo ese prefijo, como los objetos de un log
 * de producción bajo `logs/<n>/` (ADR-0018 §6): quien lo usa sigue pidiendo `sha256/<hash>`, y las
 * filas del log no cambian.
 */
export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  /** El prefijo de las claves en el bucket; vacío sin prefijo. */
  readonly keyPrefix: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string, keyPrefix = '') {
    if (!KEY_PREFIX.test(keyPrefix)) {
      throw new TypeError(
        'El prefijo de las claves son segmentos de minúsculas, cifras, _ y -, cada uno con su /.',
      );
    }
    this.#client = client;
    this.bucket = bucket;
    this.keyPrefix = keyPrefix;
  }

  /**
   * El cliente de la configuración. Con `timeouts`, cada petición tiene plazo: el SDK pasa esas
   * opciones a su manejador HTTP por defecto (`NodeHttpHandler`, de `@smithy/node-http-handler`, que
   * ya trae `@aws-sdk/client-s3`), y `throwOnRequestTimeout` hace que una petición vencida falle con
   * `TimeoutError` (`ETIMEDOUT`) en lugar de seguir esperando con un aviso en la consola.
   */
  static fromConfig(config: WorkerConfig['s3'], timeouts?: S3Timeouts): S3ObjectStore {
    return new S3ObjectStore(
      new S3Client({
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        endpoint: config.endpoint,
        forcePathStyle: true,
        maxAttempts: 1,
        region: config.region,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        ...(timeouts === undefined
          ? {}
          : { requestHandler: { ...timeouts, throwOnRequestTimeout: true } }),
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
      config.bucket,
      config.keyPrefix,
    );
  }

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<'created' | 'exists'> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: this.bucket,
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          IfNoneMatch: '*',
          Key: this.keyPrefix + key,
        }),
      );
      return 'created';
    } catch (error) {
      // La clave ya existe, sin regla de bloqueo (412) o con ella (409 `ObjectLockedByBucketPolicy`):
      // el objeto no cambió, y el llamador verifica sus bytes antes de confiar en ella. Cualquier
      // otro 409, como uno por escrituras simultáneas en la misma clave, sigue siendo un error.
      if (keyExists(error)) {
        return 'exists';
      }
      throw error;
    }
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array> {
    const stored = this.keyPrefix + key;
    try {
      const head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: stored }),
      );
      if ((head.ContentLength ?? 0) > maxBytes) {
        throw new ObjectReadError('too_large', stored);
      }
      const object = await this.#client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: stored }),
      );
      const body = object.Body as AsyncIterable<Uint8Array> | undefined;
      return body === undefined ? new Uint8Array() : await readCapped(body, maxBytes, stored);
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new ObjectReadError('not_found', stored);
      }
      throw error;
    }
  }

  destroy(): void {
    this.#client.destroy();
  }
}
