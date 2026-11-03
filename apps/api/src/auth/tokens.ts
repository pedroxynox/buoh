import { createHmac } from 'node:crypto';

/**
 * Los tokens de los enlaces de alta y de restablecimiento (ADR-0019 §3): 32 bytes aleatorios, que
 * viajan en base64url sin relleno. El servidor solo guarda su HMAC-SHA-256 con `BUOH_API_TOKEN_KEY`,
 * que vive fuera de la base, y la etiqueta de los enlaces, así que quien pueda insertar filas no
 * puede fabricar un enlace válido. Las sesiones y el CSRF del PR 4b usan otras etiquetas.
 */
export const LINK_TOKEN_BYTES = 32;
const KEY_BYTES = 32;
const LINK_LABEL = Buffer.from('buoh/enlace/v1\u0000', 'utf8');

/** Un token nuevo, con los 32 bytes aleatorios que da `randomBytes`. */
export function newLinkToken(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(LINK_TOKEN_BYTES);
  if (bytes.byteLength !== LINK_TOKEN_BYTES) {
    throw new TypeError(`Un token son ${String(LINK_TOKEN_BYTES)} bytes aleatorios.`);
  }
  return Buffer.from(bytes).toString('base64url');
}

/** Los bytes de un token, si es exactamente la escritura en base64url de 32 bytes. */
function tokenBytes(token: string): Buffer {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== LINK_TOKEN_BYTES || bytes.toString('base64url') !== token) {
    throw new TypeError('El token no son 32 bytes en base64url canónico.');
  }
  return bytes;
}

/** La huella que se guarda de un token de enlace: HMAC-SHA-256(clave, etiqueta ‖ bytes del token). */
export function linkTokenDigest(key: Uint8Array, token: string): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    throw new TypeError(`La clave de los tokens debe tener ${String(KEY_BYTES)} bytes.`);
  }
  return createHmac('sha256', key).update(LINK_LABEL).update(tokenBytes(token)).digest();
}
