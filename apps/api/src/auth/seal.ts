import { createCipheriv, createDecipheriv } from 'node:crypto';

import { TOTP_SECRET_BYTES } from './totp.js';

/**
 * El secreto TOTP guardado (ADR-0019 §1): AES-256-GCM con la clave `BUOH_API_TOTP_KEY`, que vive
 * fuera de la base, y la cuenta y la credencial como datos asociados, para que un secreto copiado a
 * otra fila no se abra. Se guarda como la versión del formato (1), el nonce de 12 bytes, el secreto
 * cifrado y la etiqueta de 16 bytes: 49 bytes.
 */
export const SEAL_VERSION = 1;
export const SEAL_NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
export const SEALED_TOTP_SECRET_BYTES = 1 + SEAL_NONCE_BYTES + TOTP_SECRET_BYTES + TAG_BYTES;

/** Un secreto guardado que no se abre: otra clave, otra fila, un byte cambiado u otro formato. */
export class SealedSecretError extends Error {
  constructor() {
    super('El secreto TOTP guardado no se puede abrir.');
    this.name = 'SealedSecretError';
  }
}

/** Los datos asociados: la versión, la cuenta y la credencial a las que pertenece el secreto. */
function associatedData(accountId: string, credentialId: string): Buffer {
  return Buffer.from(`buoh/totp/v1\u0000${accountId}\u0000${credentialId}`, 'utf8');
}

function assertLength(value: Uint8Array, bytes: number, what: string): void {
  if (value.byteLength !== bytes) {
    throw new TypeError(`${what} debe tener ${String(bytes)} bytes.`);
  }
}

/** Cifra el secreto TOTP de una credencial. El nonce, de 12 bytes aleatorios, lo da quien llama. */
export function sealTotpSecret(input: {
  readonly key: Uint8Array;
  readonly secret: Uint8Array;
  readonly accountId: string;
  readonly credentialId: string;
  readonly nonce: Uint8Array;
}): Buffer {
  assertLength(input.key, KEY_BYTES, 'La clave');
  assertLength(input.nonce, SEAL_NONCE_BYTES, 'El nonce');
  assertLength(input.secret, TOTP_SECRET_BYTES, 'El secreto TOTP');
  const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(input.accountId, input.credentialId));
  const encrypted = Buffer.concat([cipher.update(input.secret), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), input.nonce, encrypted, cipher.getAuthTag()]);
}

/** Abre el secreto TOTP de una credencial, o lanza `SealedSecretError`. */
export function openTotpSecret(input: {
  readonly key: Uint8Array;
  readonly sealed: Uint8Array;
  readonly accountId: string;
  readonly credentialId: string;
}): Buffer {
  assertLength(input.key, KEY_BYTES, 'La clave');
  const sealed = Buffer.from(input.sealed);
  if (sealed.length !== SEALED_TOTP_SECRET_BYTES || sealed[0] !== SEAL_VERSION) {
    throw new SealedSecretError();
  }
  const nonce = sealed.subarray(1, 1 + SEAL_NONCE_BYTES);
  const encrypted = sealed.subarray(1 + SEAL_NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(input.accountId, input.credentialId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new SealedSecretError();
  }
}
