import { createHash, randomBytes, randomInt, randomUUID, webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { useDeterminismGuards } from './support.js';

// Las guardas de determinismo de las pruebas de la API (ADR-0019 §13) están puestas.
useDeterminismGuards();

describe('guardas de determinismo', () => {
  it('prohíben el azar de node:crypto y dejan sus funciones deterministas', () => {
    expect(() => randomUUID()).toThrow('no está permitido');
    expect(() => randomBytes(16)).toThrow('no está permitido');
    expect(() => randomInt(10)).toThrow('no está permitido');
    expect(createHash('sha256').update('buoh').digest('hex')).toHaveLength(64);
  });

  it('prohíben el azar de Web Crypto, también por el webcrypto de node:crypto', () => {
    for (const source of [globalThis.crypto, webcrypto]) {
      expect(() => source.randomUUID()).toThrow('no está permitido');
      expect(() => source.getRandomValues(new Uint8Array(16))).toThrow('no está permitido');
      expect(() =>
        source.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      ).toThrow('no está permitido');
    }
  });

  it('prohíben el reloj real y la red', () => {
    expect(new Date().toISOString()).toBe('2099-12-31T23:59:59.999Z');
    expect(() => fetch('https://example.invalid')).toThrow('no está permitida');
  });
});
