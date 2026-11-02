import { Readable } from 'node:stream';

import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import {
  deleteKeys,
  isObjectLocked,
  logDeletion,
  logLocation,
  openLogDeletion,
  RETENTION_CONCURRENCY,
  RETENTION_DEADLINE_MS,
  RETENTION_PAGE_KEYS,
  type DeletionProgress,
  type LogLocation,
  type ObjectDeletion,
} from '../src/index.js';

// Los objetos de la retención (ADR-0018 §7 y §11, paso 3) sin red: el cliente real del SDK con un
// manejador HTTP falso, para que cada respuesta, también la de error, pase por su deserializador,
// como las de R2. El código del 409 de la regla de bloqueo es el que dio R2 en las comprobaciones
// previas (ADR-0018 §10; runbook, «Comprobaciones previas de R2»). Las credenciales son sintéticas.
// La retención entera, con el borrado del esquema, está en test/operations.test.ts y en
// integration/operations.test.ts.

/** Una respuesta HTTP sintética, como la que el manejador del SDK le pasa a su deserializador. */
interface FakeResponse {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly statusCode: number;
}

/** Lo que el SDK pidió: el método, la ruta y la consulta. */
interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
}

/** Un cliente S3 real con un manejador HTTP falso que responde con `answer` y anota cada petición. */
function clientAnswering(answer: (request: SeenRequest) => FakeResponse) {
  const requests: SeenRequest[] = [];
  let destroyed = 0;
  const client = new S3Client({
    credentials: { accessKeyId: 'clave-sintética', secretAccessKey: 'secreto-sintético' },
    endpoint: 'http://r2-sintetico.invalid',
    forcePathStyle: true,
    maxAttempts: 1,
    region: 'auto',
    requestHandler: {
      destroy: () => {
        destroyed += 1;
      },
      handle: (request: { method: string; path: string; query?: Record<string, unknown> }) => {
        const seen = { method: request.method, path: request.path, query: { ...request.query } };
        requests.push(seen);
        const { body, headers = {}, statusCode } = answer(seen);
        return Promise.resolve({
          response: {
            body: Readable.from(body === undefined ? [] : [new TextEncoder().encode(body)]),
            headers,
            statusCode,
          },
        });
      },
      httpHandlerConfigs: () => ({}),
      updateHttpClientConfig: () => undefined,
    } as never,
  });
  return { client, destroyed: () => destroyed, requests };
}

/** El cuerpo XML de un error de S3 o de R2, con su código. */
const errorResponse = (statusCode: number, code: string): FakeResponse => ({
  body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>sintético</Message></Error>`,
  headers: { 'content-type': 'application/xml' },
  statusCode,
});

/** Una página de `ListObjectsV2` con esas claves completas. */
const listing = (keys: readonly string[]): FakeResponse => ({
  body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>buoh-captura</Name><KeyCount>${String(keys.length)}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key><Size>10</Size></Contents>`).join('')}</ListBucketResult>`,
  headers: { 'content-type': 'application/xml' },
  statusCode: 200,
});

const LOG_1 = logLocation(1);

describe('logDeletion: los objetos de un log para borrarlos (ADR-0018 §7)', () => {
  it('lista solo bajo el prefijo del log, con el número de claves pedido y después de la clave dada, y las da sin el prefijo', async () => {
    const { client, requests } = clientAnswering(() =>
      listing(['logs/000001/sha256/aaa', 'logs/000001/sha256/bbb', 'logs/000002/sha256/ccc']),
    );
    const objects = logDeletion(client, 'buoh-captura', LOG_1);

    // Una clave de otro prefijo en la respuesta no se da: nunca se borraría.
    expect(await objects.list(null, 1000)).toEqual(['sha256/aaa', 'sha256/bbb']);
    expect(await objects.list('sha256/bbb', 1)).toEqual(['sha256/aaa', 'sha256/bbb']);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/buoh-captura/'],
      ['GET', '/buoh-captura/'],
    ]);
    expect(requests[0]?.query).toMatchObject({
      'list-type': '2',
      'max-keys': '1000',
      prefix: 'logs/000001/',
    });
    expect(requests[0]?.query).not.toHaveProperty('start-after');
    expect(requests[1]?.query).toMatchObject({
      'max-keys': '1',
      prefix: 'logs/000001/',
      'start-after': 'logs/000001/sha256/bbb',
    });
  });

  it('borra cada clave bajo el prefijo del log, una por petición: 204 es deleted, también si ya no estaba', async () => {
    const { client, requests } = clientAnswering(() => ({ statusCode: 204 }));
    const objects = logDeletion(client, 'buoh-captura', LOG_1);
    expect(await objects.delete('sha256/aaa')).toBe('deleted');
    expect(requests).toEqual([
      {
        method: 'DELETE',
        path: '/buoh-captura/logs/000001/sha256/aaa',
        query: { 'x-id': 'DeleteObject' },
      },
    ]);
  });

  it('409 ObjectLockedByBucketPolicy, la regla de bloqueo del bucket, es locked; cualquier otro error rechaza', async () => {
    const locked = clientAnswering(() => errorResponse(409, 'ObjectLockedByBucketPolicy'));
    expect(await logDeletion(locked.client, 'buoh-captura', LOG_1).delete('sha256/aaa')).toBe(
      'locked',
    );
    for (const [status, code] of [
      [409, 'OperationAborted'],
      [403, 'ObjectLockedByBucketPolicy'],
      [403, 'AccessDenied'],
      [500, 'InternalError'],
    ] as const) {
      const { client } = clientAnswering(() => errorResponse(status, code));
      await expect(
        logDeletion(client, 'buoh-captura', LOG_1).delete('sha256/aaa'),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === status &&
          error.name === code,
      );
    }
    const { client } = clientAnswering(() => errorResponse(500, 'InternalError'));
    await expect(logDeletion(client, 'buoh-captura', LOG_1).list(null, 1)).rejects.toSatisfy(
      (error: unknown) => error instanceof S3ServiceException && error.name === 'InternalError',
    );
  });

  it('solo trabaja bajo el prefijo de un log de producción: con otro, como uno vacío, que sería el bucket entero, lanza TypeError sin pedir nada', () => {
    const { client, requests } = clientAnswering(() => ({ statusCode: 204 }));
    for (const prefix of [
      '',
      'logs/',
      'logs/1/',
      'logs/0000001/',
      'logs/000001',
      'manifests/000001/',
      'logs/000001/sha256/',
      '/logs/000001/',
    ]) {
      const location: LogLocation = { number: 1, prefix, schema: 'buoh_log_000001' };
      expect(() => logDeletion(client, 'buoh-captura', location)).toThrow(TypeError);
      expect(() =>
        openLogDeletion(
          {
            accessKeyId: 'clave-sintética',
            bucket: 'buoh-captura',
            endpoint: 'http://r2-sintetico.invalid',
            region: 'auto',
            secretAccessKey: 'secreto-sintético',
          },
          location,
        ),
      ).toThrow(TypeError);
    }
    expect(requests).toEqual([]);
  });

  it('close libera el cliente, y con él sus conexiones', () => {
    const { client, destroyed } = clientAnswering(() => ({ statusCode: 204 }));
    logDeletion(client, 'buoh-captura', LOG_1).close();
    expect(destroyed()).toBe(1);
  });
});

describe('isObjectLocked: el rechazo de la regla de bloqueo de R2 (ADR-0018 §10)', () => {
  it('es el 409 con ObjectLockedByBucketPolicy, y nada más', () => {
    const s3Error = (status: number, name: string) =>
      new S3ServiceException({
        $fault: 'client',
        $metadata: { httpStatusCode: status },
        message: 'sintético',
        name,
      });
    expect(isObjectLocked(s3Error(409, 'ObjectLockedByBucketPolicy'))).toBe(true);
    expect(isObjectLocked(s3Error(409, 'OperationAborted'))).toBe(false);
    expect(isObjectLocked(s3Error(403, 'ObjectLockedByBucketPolicy'))).toBe(false);
    expect(
      isObjectLocked(Object.assign(new Error('sintético'), { name: 'ObjectLockedByBucketPolicy' })),
    ).toBe(false);
    expect(isObjectLocked(null)).toBe(false);
  });
});

describe('deleteKeys: los borrados de una página (ADR-0018 §7)', () => {
  const progress = (): DeletionProgress => ({ deleted: 0, locked: 0, stopped: false });
  const keys = (count: number) =>
    Array.from({ length: count }, (_, index) => `sha256/${String(index).padStart(4, '0')}`);

  /** Borrados falsos que esperan a que se los deje terminar, para contar cuántos van a la vez. */
  function pendingDeletes(result: (key: string) => ObjectDeletion | Error = () => 'deleted') {
    const started: string[] = [];
    const waiting = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const objects = {
      delete: (key: string) => {
        started.push(key);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<ObjectDeletion>((resolve, reject) => {
          waiting.set(key, () => {
            inFlight -= 1;
            const value = result(key);
            if (value instanceof Error) {
              reject(value);
            } else {
              resolve(value);
            }
          });
        });
      },
    };
    /**
     * Deja terminar los borrados que esperan, o solo los de `only`, y da tiempo a que empiecen los
     * siguientes.
     */
    const release = async (only?: readonly string[]) => {
      for (const [key, finish] of [...waiting]) {
        if (only === undefined || only.includes(key)) {
          waiting.delete(key);
          finish();
        }
      }
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
    };
    return { maxInFlight: () => maxInFlight, objects, release, started };
  }

  it(`lleva como mucho ${String(RETENTION_CONCURRENCY)} borrados a la vez y cuenta los borrados y los bloqueados`, async () => {
    expect(RETENTION_CONCURRENCY).toBe(8);
    expect(RETENTION_PAGE_KEYS).toBe(1000);
    expect(RETENTION_DEADLINE_MS).toBe(60_000);
    const page = keys(20);
    const fake = pendingDeletes((key) => (key.endsWith('7') ? 'locked' : 'deleted'));
    const state = progress();
    const done = deleteKeys(fake.objects, page, state);
    await Promise.resolve();
    expect(fake.started).toHaveLength(RETENTION_CONCURRENCY);
    while (fake.started.length < page.length || state.deleted + state.locked < page.length) {
      await fake.release();
    }
    await done;
    expect(fake.maxInFlight()).toBe(RETENTION_CONCURRENCY);
    expect(fake.started).toEqual(page);
    expect(state).toEqual({ deleted: 18, locked: 2, stopped: false });
  });

  it('con menos claves que borrados a la vez, uno por clave, y sin claves, ninguno', async () => {
    const few = pendingDeletes();
    const state = progress();
    const done = deleteKeys(few.objects, keys(3), state);
    await Promise.resolve();
    expect(few.started).toHaveLength(3);
    await few.release();
    await done;
    expect(state.deleted).toBe(3);

    const none = pendingDeletes();
    await deleteKeys(none.objects, [], progress());
    expect(none.started).toEqual([]);
  });

  it('el primer error que no es la regla de bloqueo para los borrados: ninguno empieza otro, y rechaza con él', async () => {
    const failure = Object.assign(new Error('connect ETIMEDOUT 10.0.0.9:443'), {
      code: 'ETIMEDOUT',
    });
    const fake = pendingDeletes((key) => (key === 'sha256/0002' ? failure : 'deleted'));
    const state = progress();
    const done = deleteKeys(fake.objects, keys(30), state);
    const outcome = done.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    // El que falla termina primero; los otros 7 después, y ninguno empieza otro.
    await fake.release(['sha256/0002']);
    expect(await outcome).toBe(failure);
    expect(state.stopped).toBe(true);
    await fake.release();
    expect(fake.started).toHaveLength(RETENTION_CONCURRENCY);
    expect(state).toMatchObject({ deleted: 7, locked: 0 });
  });

  it('con progress.stopped puesto, como al vencer el plazo, ningún borrado empieza otro', async () => {
    const fake = pendingDeletes();
    const state = progress();
    const done = deleteKeys(fake.objects, keys(30), state);
    await Promise.resolve();
    state.stopped = true;
    await fake.release();
    await done;
    expect(fake.started).toHaveLength(RETENTION_CONCURRENCY);
    expect(state.deleted).toBe(RETENTION_CONCURRENCY);
  });
});
