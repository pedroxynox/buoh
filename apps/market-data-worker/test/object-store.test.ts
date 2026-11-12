import { Readable } from 'node:stream';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import {
  failureReason,
  loadConfig,
  logLocation,
  ObjectReadError,
  openHealthStores,
  openStores,
  S3ObjectStore,
  withLog,
  writeVerified,
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

/** Una respuesta HTTP sintética, como la que el manejador del SDK le pasa a su deserializador. */
interface FakeResponse {
  readonly body?: Uint8Array;
  readonly headers?: Record<string, string>;
  readonly statusCode: number;
}

/** El cuerpo XML de un error de S3 o de R2, con su código. */
const errorResponse = (statusCode: number, code: string): FakeResponse => ({
  body: new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>sintético</Message></Error>`,
  ),
  headers: { 'content-type': 'application/xml' },
  statusCode,
});

/**
 * Un `S3ObjectStore` con el cliente real del SDK y un manejador HTTP falso, que responde por el método
 * de cada petición: así cada respuesta, también la de error, pasa por el deserializador del SDK, como
 * las de R2. Sin red: ninguna petición sale del proceso.
 */
function storeAnswering(answer: (method: string) => FakeResponse): {
  readonly methods: string[];
  readonly store: S3ObjectStore;
} {
  const methods: string[] = [];
  const client = new S3Client({
    credentials: { accessKeyId: 'clave-sintética', secretAccessKey: 'secreto-sintético' },
    endpoint: 'http://r2-sintetico.invalid',
    forcePathStyle: true,
    maxAttempts: 1,
    region: 'auto',
    requestHandler: {
      destroy: () => undefined,
      handle: (request: { method: string }) => {
        methods.push(request.method);
        const { body, headers = {}, statusCode } = answer(request.method);
        return Promise.resolve({
          response: { body: Readable.from(body === undefined ? [] : [body]), headers, statusCode },
        });
      },
      httpHandlerConfigs: () => ({}),
      updateHttpClientConfig: () => undefined,
    } as never,
  });
  return { methods, store: new S3ObjectStore(client, 'buoh-captura', 'logs/000001/') };
}

describe('putIfAbsent con una clave que ya existe (ADR-0018 §10)', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('412: la clave ya existe', async () => {
    const { store } = storeAnswering(() => errorResponse(412, 'PreconditionFailed'));
    expect(await store.putIfAbsent('sha256/abc', bytes, 'application/json')).toBe('exists');
  });

  it('409 ObjectLockedByBucketPolicy: la clave ya existe y la protege una regla de bloqueo de R2', async () => {
    const { store } = storeAnswering(() => errorResponse(409, 'ObjectLockedByBucketPolicy'));
    expect(await store.putIfAbsent('sha256/abc', bytes, 'application/json')).toBe('exists');
  });

  it('cualquier otro 409, u otro estado con ese código, sigue siendo un error', async () => {
    for (const [status, code] of [
      [409, 'ConditionalRequestConflict'],
      [409, 'OperationAborted'],
      [403, 'ObjectLockedByBucketPolicy'],
      [403, 'AccessDenied'],
      [500, 'InternalError'],
    ] as const) {
      const { store } = storeAnswering(() => errorResponse(status, code));
      await expect(store.putIfAbsent('sha256/abc', bytes, 'application/json')).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === status &&
          error.name === code,
      );
    }
  });

  it('con la regla de bloqueo, writeVerified acepta los mismos bytes y rechaza otros, como con 412', async () => {
    // Como al guardar otra vez el esquema de fuente al empezar una sesión del mismo log: R2 rechaza
    // la escritura con 409 y la relectura decide.
    const stored = new Uint8Array([7, 8, 9]);
    const answer = (method: string): FakeResponse =>
      method === 'PUT'
        ? errorResponse(409, 'ObjectLockedByBucketPolicy')
        : method === 'HEAD'
          ? { headers: { 'content-length': String(stored.byteLength) }, statusCode: 200 }
          : {
              body: stored,
              headers: { 'content-length': String(stored.byteLength) },
              statusCode: 200,
            };
    const same = storeAnswering(answer);
    await expect(
      writeVerified(same.store, 'sha256/abc', stored, 'application/json'),
    ).resolves.toBeUndefined();
    expect(same.methods).toEqual(['PUT', 'HEAD', 'GET']);

    const other = storeAnswering(answer);
    const rejected = await writeVerified(
      other.store,
      'sha256/abc',
      new Uint8Array([1, 2, 3]),
      'application/json',
    ).then(
      () => null,
      (error: unknown) => failureReason(error),
    );
    expect(rejected).toBe('object_verification_failed');
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

describe('S3ObjectStore con una señal por lectura (ADR-0019 §8)', () => {
  const KEY = `sha256/${'a'.repeat(64)}`;
  const timeout = () => Object.assign(new Error('plazo sintético'), { name: 'TimeoutError' });

  it('cada lectura pide una señal nueva, y sus dos peticiones llevan la misma', async () => {
    const received: unknown[] = [];
    const client = {
      send: (command: unknown, options?: { abortSignal?: unknown }) => {
        received.push(options?.abortSignal);
        return Promise.resolve(
          command instanceof HeadObjectCommand
            ? { ContentLength: 3 }
            : { Body: body(new Uint8Array([1, 2, 3])) },
        );
      },
    };
    const made: AbortSignal[] = [];
    const store = new S3ObjectStore(client as never, 'b', '', {
      readSignal: () => {
        const { signal } = new AbortController();
        made.push(signal);
        return signal;
      },
    });
    expect(await store.get(KEY, 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.get(KEY, 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(made).toHaveLength(2);
    expect(received).toEqual([made[0], made[0], made[1], made[1]]);
    // Sin la opción, el cliente no recibe ninguna señal.
    received.length = 0;
    await new S3ObjectStore(client as never, 'b').get(KEY, 10);
    expect(received).toEqual([undefined, undefined]);
  });

  it('si la señal se aborta mientras llega el cuerpo, corta el flujo y rechaza con su motivo', async () => {
    const stalled = new Readable({ read: () => undefined });
    stalled.push(new Uint8Array(10));
    const { client, sent } = fakeClient((command) =>
      command instanceof HeadObjectCommand ? { ContentLength: 1000 } : { Body: stalled },
    );
    const controller = new AbortController();
    const store = new S3ObjectStore(client, 'b', '', { readSignal: () => controller.signal });
    const reading = store.get(KEY, 5000);
    // El cuerpo ya empezó a llegar, y no termina.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.map((item) => item.type)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    controller.abort(timeout());
    await expect(reading).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stalled.destroyed).toBe(true);
  });

  it('una petición que el SDK corta rechaza con el motivo de la señal, y una señal ya abortada no pide nada', async () => {
    const controller = new AbortController();
    const cut = fakeClient(() => {
      controller.abort(timeout());
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    });
    const store = new S3ObjectStore(cut.client, 'b', '', { readSignal: () => controller.signal });
    await expect(store.get(KEY, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cut.sent).toHaveLength(1);
    await expect(store.get(KEY, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cut.sent).toHaveLength(1);
    expect(failureReason(await store.get(KEY, 10).catch((error: unknown) => error))).toBe(
      'TimeoutError',
    );
  });

  it('con la señal, un objeto que no existe sigue siendo not_found, y uno mayor, too_large', async () => {
    const readSignal = () => new AbortController().signal;
    const missing = fakeClient(() => {
      throw notFound();
    });
    await expect(
      new S3ObjectStore(missing.client, 'b', '', { readSignal }).get(KEY, 10),
    ).rejects.toMatchObject({ name: 'ObjectReadError', reason: 'not_found' });
    const large = fakeClient((command) =>
      command instanceof HeadObjectCommand
        ? { ContentLength: 3 }
        : { Body: body(new Uint8Array(30)) },
    );
    await expect(
      new S3ObjectStore(large.client, 'b', '', { readSignal }).get(KEY, 10),
    ).rejects.toMatchObject({ name: 'ObjectReadError', reason: 'too_large' });
  });
});
