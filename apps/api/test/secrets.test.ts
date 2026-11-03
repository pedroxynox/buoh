import { describe, expect, it } from 'vitest';

import { openTotpSecret, SealedSecretError, sealTotpSecret } from '../src/auth/seal.js';
import { linkTokenDigest, newLinkToken } from '../src/auth/tokens.js';
import { useDeterminismGuards } from './support.js';

// El secreto TOTP cifrado con AES-256-GCM y BUOH_API_TOTP_KEY, con la cuenta y la credencial como
// datos asociados (ADR-0019 §1), y el token de un enlace, del que el servidor solo guarda su HMAC
// con BUOH_API_TOKEN_KEY y la etiqueta de los enlaces (§3). Los valores esperados se calcularon
// aparte, con node:crypto directamente, y son el formato guardado en la base.
useDeterminismGuards();

const TOTP_KEY = Buffer.alloc(32, 0x11);
const NONCE = Buffer.from('000102030405060708090a0b', 'hex');
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const ACCOUNT = '01900000-0000-7000-8000-00000000a001';
const CREDENTIAL = '01900000-0000-7000-8000-00000000c001';
/** Versión 1, el nonce, el secreto cifrado y la etiqueta de 16 bytes. */
const SEALED =
  '01000102030405060708090a0b22d185274e9502cc2d88e2adf79bc210fe99395837bdf18a7fe22db0b71619de7a41698f';

describe('sealTotpSecret y openTotpSecret', () => {
  it('guardan la versión, el nonce, el secreto cifrado y la etiqueta, y lo recuperan', () => {
    const sealed = sealTotpSecret({
      key: TOTP_KEY,
      secret: SECRET,
      accountId: ACCOUNT,
      credentialId: CREDENTIAL,
      nonce: NONCE,
    });
    expect(sealed.toString('hex')).toBe(SEALED);
    expect(sealed.includes(SECRET)).toBe(false);
    expect(
      openTotpSecret({
        key: TOTP_KEY,
        sealed: Buffer.from(SEALED, 'hex'),
        accountId: ACCOUNT,
        credentialId: CREDENTIAL,
      }),
    ).toEqual(SECRET);
  });

  it('no abren un secreto de otra cuenta, de otra credencial o con otra clave', () => {
    const sealed = Buffer.from(SEALED, 'hex');
    const otherId = '01900000-0000-7000-8000-00000000ffff';
    for (const input of [
      { key: TOTP_KEY, sealed, accountId: otherId, credentialId: CREDENTIAL },
      { key: TOTP_KEY, sealed, accountId: ACCOUNT, credentialId: otherId },
      { key: TOTP_KEY, sealed, accountId: CREDENTIAL, credentialId: ACCOUNT },
      { key: Buffer.alloc(32, 0x12), sealed, accountId: ACCOUNT, credentialId: CREDENTIAL },
    ]) {
      expect(() => openTotpSecret(input)).toThrow(SealedSecretError);
    }
  });

  it('no abren un secreto con cualquier byte cambiado, ni uno cortado, alargado o de otra versión', () => {
    const sealed = Buffer.from(SEALED, 'hex');
    for (let index = 0; index < sealed.length; index += 1) {
      const changed = Buffer.from(sealed);
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      expect(
        () =>
          openTotpSecret({
            key: TOTP_KEY,
            sealed: changed,
            accountId: ACCOUNT,
            credentialId: CREDENTIAL,
          }),
        String(index),
      ).toThrow(SealedSecretError);
    }
    for (const bad of [
      sealed.subarray(0, sealed.length - 1),
      Buffer.concat([sealed, Buffer.from([0])]),
      Buffer.alloc(0),
    ]) {
      expect(() =>
        openTotpSecret({
          key: TOTP_KEY,
          sealed: bad,
          accountId: ACCOUNT,
          credentialId: CREDENTIAL,
        }),
      ).toThrow(SealedSecretError);
    }
  });

  it('exigen una clave de 32 bytes, un nonce de 12 y un secreto de 20', () => {
    const base = {
      key: TOTP_KEY,
      secret: SECRET,
      accountId: ACCOUNT,
      credentialId: CREDENTIAL,
      nonce: NONCE,
    };
    expect(() => sealTotpSecret({ ...base, key: Buffer.alloc(31) })).toThrow(TypeError);
    expect(() => sealTotpSecret({ ...base, nonce: Buffer.alloc(16) })).toThrow(TypeError);
    expect(() => sealTotpSecret({ ...base, secret: Buffer.alloc(16) })).toThrow(TypeError);
  });
});

describe('tokens de los enlaces', () => {
  const TOKEN_KEY = Buffer.alloc(32, 0x22);
  const BYTES = Buffer.from([...Array(32).keys()]);
  const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

  it('un token son 32 bytes aleatorios en base64url sin relleno', () => {
    const requested: number[] = [];
    const token = newLinkToken((size) => {
      requested.push(size);
      return BYTES;
    });
    expect(requested).toEqual([32]);
    expect(token).toBe(TOKEN);
  });

  it('su huella es el HMAC-SHA-256 con la clave y la etiqueta de los enlaces', () => {
    expect(linkTokenDigest(TOKEN_KEY, TOKEN).toString('hex')).toBe(
      'cbbd8bd526acf3a93983e2a9e7a604cd9c7cc4cefd8a05785e45c4939d64dd61',
    );
  });

  it('la huella cambia con otra clave o con otro token, y no es el SHA-256 sin clave', () => {
    const digest = linkTokenDigest(TOKEN_KEY, TOKEN).toString('hex');
    expect(linkTokenDigest(Buffer.alloc(32, 0x23), TOKEN).toString('hex')).not.toBe(digest);
    expect(
      linkTokenDigest(TOKEN_KEY, 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8').toString('hex'),
    ).not.toBe(digest);
    // El SHA-256 sin clave de los bytes del token, calculado aparte.
    expect(digest).not.toBe('630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd');
  });

  it('rechaza un token que no son 32 bytes en base64url canónico, o una clave que no es de 32 bytes', () => {
    for (const token of [
      TOKEN.slice(0, 42),
      `${TOKEN}A`,
      `${TOKEN.slice(0, 42)}B`,
      `${TOKEN.slice(0, 42)}+`,
    ]) {
      expect(() => linkTokenDigest(TOKEN_KEY, token), token).toThrow(TypeError);
    }
    expect(() => linkTokenDigest(Buffer.alloc(16), TOKEN)).toThrow(TypeError);
    expect(() => newLinkToken(() => Buffer.alloc(31))).toThrow(TypeError);
  });
});
