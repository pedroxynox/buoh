import { Readable } from 'node:stream';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import {
  loadConfig,
  logLocation,
  ObjectReadError,
  openHealthStores,
  openStores,
  S3ObjectStore,
  withLog,
} from '../src/index.js';

// El prefijo de las claves de `S3ObjectStore` (ADR-0018 §6): los objetos de un log de producción
// viven bajo `logs/<n>/`. Sin red: un cliente falso anota cada petición. La prueba contra un
// almacenamiento S3-compatible está en integration/successive-logs.test.ts. Las credenciales son
// sintéticas.

/** Un cliente S3 falso: anota el tipo y la clave de cada petición y responde con `answer`. */
function fakeClient(answer: (command: unknown) => unknown) {
  const sent: { key: unknown; type: string }[] = [];
  const client = {
    send: (command: { input: { Key?: unknown } }) => {
      sent.push({ key: command.input.Key, type: command.constructor.name });
      try {
        return Promise.resolve(answer(command));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { client: client as never, sent };
}

/** El cuerpo de una respuesta de GetObject, como el del SDK: un flujo de bytes. */
const body = (bytes: Uint8Array): AsyncIterable<Uint8Array> => Readable.from([bytes]);

const notFound = () =>
  new S3ServiceException({
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
    message: 'sintético',
    name: 'NotFound',
  });

describe('S3ObjectStore con prefijo de claves', () => {
  it('escribe y lee cada clave bajo el prefijo, y quien lo usa sigue pidiendo sha256/<hash>', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { client, sent } = fakeClient((command) =>
      command instanceof HeadObjectCommand
        ? { ContentLength: bytes.byteLength }
        : command instanceof GetObjectCommand
          ? { Body: body(bytes) }
          : {},
    );
    const store = new S3ObjectStore(client, 'buoh-captura', 'logs/000002/');
    expect(store.keyPrefix).toBe('logs/000002/');
    expect(await store.putIfAbsent('sha256/abc', bytes, 'application/json')).toBe('created');
    expect(await store.get('sha256/abc', 10)).toEqual(bytes);
    expect(sent).toEqual([
      { key: 'logs/000002/sha256/abc', type: PutObjectCommand.name },
      { key: 'logs/000002/sha256/abc', type: HeadObjectCommand.name },
      { key: 'logs/000002/sha256/abc', type: GetObjectCommand.name },
    ]);
  });

  it('sin prefijo, la clave es la que recibe', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const store = new S3ObjectStore(client, 'buoh-local');
    expect(store.keyPrefix).toBe('');
    await store.putIfAbsent('sha256/abc', new Uint8Array([1]), 'application/json');
    expect(sent).toEqual([{ key: 'sha256/abc', type: PutObjectCommand.name }]);
  });

  it('una clave que no está bajo el prefijo es not_found, aunque exista en otro lugar del bucket', async () => {
    const { client } = fakeClient((command) => {
      if ((command as { input: { Key: string } }).input.Key.startsWith('logs/000003/')) {
        throw notFound();
      }
      return { ContentLength: 1 };
    });
    const store = new S3ObjectStore(client, 'buoh-captura', 'logs/000003/');
    await expect(store.get('sha256/abc', 10)).rejects.toBeInstanceOf(ObjectReadError);
    await expect(store.get('sha256/abc', 10)).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('rechaza un prefijo que no son segmentos de minúsculas, cifras, _ y -, cada uno con su /', () => {
    const { client } = fakeClient(() => ({}));
    for (const prefix of [
      'logs/000001',
      '/logs/000001/',
      'logs//',
      '../',
      'Logs/000001/',
      'a b/',
    ]) {
      expect(() => new S3ObjectStore(client, 'buoh-captura', prefix)).toThrow(TypeError);
    }
    expect(new S3ObjectStore(client, 'buoh-captura', 'logs/000001/').keyPrefix).toBe(
      'logs/000001/',
    );
  });
});

describe('los almacenes de un log toman su prefijo de la configuración', () => {
  const config = loadConfig({
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
    BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
    BUOH_POSTGRES_SSLMODE: 'require',
    BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
    BUOH_S3_BUCKET: 'buoh-captura',
    BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
  });

  it('fromConfig, openStores y openHealthStores, sin abrir ninguna conexión', async () => {
    const located = withLog(config, logLocation(2));
    expect(S3ObjectStore.fromConfig(located.s3).keyPrefix).toBe('logs/000002/');
    expect(S3ObjectStore.fromConfig(config.s3).keyPrefix).toBe('');
    const stores = openStores(located);
    const health = openHealthStores(located);
    try {
      expect(stores.objects.keyPrefix).toBe('logs/000002/');
      expect((health.objects as S3ObjectStore).keyPrefix).toBe('logs/000002/');
    } finally {
      await stores.close();
      await health.close();
    }
  });
});
