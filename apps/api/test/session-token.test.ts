import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildSessionCookie,
  clearSessionCookie,
  csrfTokenFor,
  isValidCsrfToken,
  newSessionSecret,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  sessionSecretBytes,
  sessionTokenDigest,
} from '../src/auth/session-token.js';
import { useDeterminismGuards } from './support.js';

// Las sesiones y su token CSRF (ADR-0019 §2). Los valores esperados se calculan aparte, con
// node:crypto y las etiquetas, para no copiar la implementación.
useDeterminismGuards();

const KEY = Buffer.alloc(32, 0x22);
const BYTES = Buffer.from([...Array(32).keys()]);
/** Los bytes 0 a 31 en base64url, 43 caracteres. */
const SESSION_ID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION_LABEL = Buffer.from('buoh/sesion/v1\u0000', 'utf8');
const CSRF_LABEL = Buffer.from('buoh/csrf/v1\u0000', 'utf8');

describe('newSessionSecret', () => {
  it('son 32 bytes aleatorios en base64url sin relleno', () => {
    const requested: number[] = [];
    const id = newSessionSecret((size) => {
      requested.push(size);
      return BYTES;
    });
    expect(requested).toEqual([32]);
    expect(id).toBe(SESSION_ID);
    expect(sessionSecretBytes(id)).toEqual(BYTES);
  });

  it('rechaza una entropía que no son 32 bytes', () => {
    expect(() => newSessionSecret(() => Buffer.alloc(31))).toThrow(TypeError);
  });
});

describe('sessionSecretBytes', () => {
  it('acepta solo 32 bytes en base64url canónico', () => {
    expect(sessionSecretBytes(SESSION_ID)).toEqual(BYTES);
    for (const bad of [
      SESSION_ID.slice(0, 42),
      `${SESSION_ID}A`,
      `${SESSION_ID.slice(0, 42)}B`,
      `${SESSION_ID.slice(0, 41)}+A`,
      `${SESSION_ID}=`,
      '',
    ]) {
      expect(sessionSecretBytes(bad), bad).toBeNull();
    }
  });
});

describe('sessionTokenDigest y csrfTokenFor', () => {
  it('la huella de la sesión es el HMAC-SHA-256 con la etiqueta de las sesiones', () => {
    const expected = createHmac('sha256', KEY).update(SESSION_LABEL).update(BYTES).digest();
    expect(sessionTokenDigest(KEY, SESSION_ID)).toEqual(expected);
    expect(sessionTokenDigest(KEY, SESSION_ID)).toHaveLength(32);
  });

  it('el token CSRF es el HMAC-SHA-256 con la etiqueta de CSRF, en hexadecimal', () => {
    const expected = createHmac('sha256', KEY).update(CSRF_LABEL).update(BYTES).digest('hex');
    expect(csrfTokenFor(KEY, SESSION_ID)).toBe(expected);
    expect(csrfTokenFor(KEY, SESSION_ID)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('la huella de la sesión y el token CSRF usan etiquetas distintas, así que no coinciden', () => {
    expect(sessionTokenDigest(KEY, SESSION_ID).toString('hex')).not.toBe(
      csrfTokenFor(KEY, SESSION_ID),
    );
  });

  it('cambian con otra clave o con otro identificador, y rechazan un identificador o una clave inválidos', () => {
    const digest = sessionTokenDigest(KEY, SESSION_ID).toString('hex');
    expect(sessionTokenDigest(Buffer.alloc(32, 0x23), SESSION_ID).toString('hex')).not.toBe(digest);
    expect(
      sessionTokenDigest(
        KEY,
        newSessionSecret(() => Buffer.alloc(32, 0x01)),
      ).toString('hex'),
    ).not.toBe(digest);
    expect(() => sessionTokenDigest(KEY, 'no-vale')).toThrow(TypeError);
    expect(() => sessionTokenDigest(Buffer.alloc(16), SESSION_ID)).toThrow(TypeError);
    expect(() => csrfTokenFor(KEY, 'no-vale')).toThrow(TypeError);
  });
});

describe('isValidCsrfToken', () => {
  it('acepta el token de su sesión y rechaza otro, otra clave, el formato malo y lo que no es texto', () => {
    const token = csrfTokenFor(KEY, SESSION_ID);
    expect(isValidCsrfToken(KEY, SESSION_ID, token)).toBe(true);
    expect(
      isValidCsrfToken(KEY, SESSION_ID, csrfTokenFor(Buffer.alloc(32, 0x23), SESSION_ID)),
    ).toBe(false);
    expect(isValidCsrfToken(Buffer.alloc(32, 0x23), SESSION_ID, token)).toBe(false);
    for (const bad of [
      token.toUpperCase(),
      token.slice(0, 63),
      `${token}a`,
      '',
      undefined,
      123,
      null,
    ]) {
      expect(isValidCsrfToken(KEY, SESSION_ID, bad), String(bad)).toBe(false);
    }
    // Un identificador de sesión inválido no lanza: devuelve false.
    expect(isValidCsrfToken(KEY, 'no-vale', token)).toBe(false);
  });
});

describe('la cookie de la sesión', () => {
  it('la pone con HttpOnly, Secure, SameSite=Strict, Path=/ y su Max-Age', () => {
    expect(buildSessionCookie(SESSION_ID, 86_400)).toBe(
      `${SESSION_COOKIE_NAME}=${SESSION_ID}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(() => buildSessionCookie(SESSION_ID, -1)).toThrow(TypeError);
  });

  it('la borra con Max-Age=0', () => {
    expect(clearSessionCookie()).toBe(
      `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
  });

  it('lee el identificador de la cabecera Cookie, entre otras cookies, o null si no está', () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${SESSION_ID}`)).toBe(SESSION_ID);
    expect(readSessionCookie(`otra=1; ${SESSION_COOKIE_NAME}=${SESSION_ID}; mas=2`)).toBe(
      SESSION_ID,
    );
    expect(readSessionCookie('otra=1; mas=2')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
  });
});
