import { InMemoryObjectStore, ObjectReadError } from '@buoh/market-data-worker/lectura';
import { describe, expect, it } from 'vitest';

import {
  LruCache,
  ObjectBytesCache,
  OBJECT_CACHE_BYTES,
  OBJECT_CACHE_MAX_OBJECT_BYTES,
  readOnlyObjects,
} from '../src/data/market.js';
import { StorageUnavailableError } from '../src/errors.js';
import { useDeterminismGuards } from './support.js';

// Las piezas del lector de R2 de la API que no necesitan PostgreSQL (ADR-0019 §8): las dos cachés,
// con su tope, y el almacenamiento en solo lectura, que guarda los objetos pequeños de contenido y
// convierte un fallo de R2 en `StorageUnavailableError`.
useDeterminismGuards();

const KEY = (n: number) => `sha256/${n.toString(16).padStart(64, '0')}`;

describe('LruCache', () => {
  it('guarda hasta su tope y saca la que hace más que no se usa', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
  });
});

describe('ObjectBytesCache', () => {
  it('guarda hasta su tope de bytes, sin objetos mayores que el máximo, y saca los más viejos', () => {
    const cache = new ObjectBytesCache(10, 4);
    cache.set('a', new Uint8Array(4));
    cache.set('b', new Uint8Array(4));
    cache.set('grande', new Uint8Array(5));
    expect(cache.get('grande')).toBeUndefined();
    expect(cache.get('a')?.byteLength).toBe(4);
    cache.set('c', new Uint8Array(4));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.byteLength).toBe(4);
    expect(cache.bytes).toBe(8);
  });

  it('caben los source events de unos 18 segmentos del abierto, y ningún segmento cerrado', () => {
    expect(OBJECT_CACHE_BYTES / 700 / 160).toBeGreaterThan(18);
    // Un segmento cerrado de producción pesa unos 12 KB comprimido.
    expect(OBJECT_CACHE_MAX_OBJECT_BYTES).toBeLessThan(12_000);
  });
});

describe('readOnlyObjects', () => {
  it('lee una vez cada objeto pequeño de contenido, por log, y nunca escribe', async () => {
    const store = new InMemoryObjectStore('buoh-captura');
    await store.putIfAbsent(KEY(1), new Uint8Array([1, 2, 3]));
    let reads = 0;
    const counted = {
      bucket: store.bucket,
      get: (key: string, max: number) => {
        reads += 1;
        return store.get(key, max);
      },
    };
    const cache = new ObjectBytesCache(1024, 16);
    const log2 = readOnlyObjects(counted, cache, 'logs/000002/');
    expect([...(await log2.get(KEY(1), 3))]).toEqual([1, 2, 3]);
    expect([...(await log2.get(KEY(1), 3))]).toEqual([1, 2, 3]);
    expect(reads).toBe(1);
    // El mismo hash en otro log es otro objeto.
    await readOnlyObjects(counted, cache, 'logs/000003/').get(KEY(1), 3);
    expect(reads).toBe(2);
    // Lo guardado respeta el tamaño de la fila, como el almacén.
    await expect(log2.get(KEY(1), 2)).rejects.toBeInstanceOf(ObjectReadError);
    await expect(log2.putIfAbsent(KEY(2), new Uint8Array([1]), 'application/json')).rejects.toThrow(
      TypeError,
    );
    expect(store.objects.has(KEY(2))).toBe(false);
  });

  it('una clave que no es de contenido no se guarda', async () => {
    const store = new InMemoryObjectStore('buoh-captura');
    await store.putIfAbsent('manifests/x.json', new Uint8Array([1]));
    let reads = 0;
    const objects = readOnlyObjects(
      {
        bucket: store.bucket,
        get: (key: string, max: number) => {
          reads += 1;
          return store.get(key, max);
        },
      },
      new ObjectBytesCache(1024, 16),
      'logs/000002/',
    );
    await objects.get('manifests/x.json', 1);
    await objects.get('manifests/x.json', 1);
    expect(reads).toBe(2);
  });

  it('un objeto que falta sigue siendo ObjectReadError; cualquier otro fallo de R2, StorageUnavailableError con su motivo', async () => {
    const store = new InMemoryObjectStore('buoh-captura');
    const cache = new ObjectBytesCache(1024, 16);
    await expect(readOnlyObjects(store, cache, '').get(KEY(9), 10)).rejects.toMatchObject({
      name: 'ObjectReadError',
      reason: 'not_found',
    });
    const failing = readOnlyObjects(
      {
        bucket: 'buoh-captura',
        get: () =>
          Promise.reject(
            Object.assign(new Error('https://cuenta.r2.cloudflarestorage.com no responde'), {
              name: 'TimeoutError',
            }),
          ),
      },
      cache,
      '',
    );
    const error = await failing.get(KEY(1), 10).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as StorageUnavailableError).reason).toBe('TimeoutError');
    expect((error as Error).message).not.toContain('cuenta');
  });
});
