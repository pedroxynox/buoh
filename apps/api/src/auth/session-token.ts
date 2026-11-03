import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Las sesiones y su token CSRF (ADR-0019 §2). Una sesión tiene un identificador de 32 bytes
 * aleatorios, que viaja en la cookie `__Host-Http-buoh_sesion` en base64url. El servidor solo guarda
 * su HMAC-SHA-256 con `BUOH_API_TOKEN_KEY`, que vive fuera de la base, y la etiqueta de las sesiones,
 * así que quien pueda insertar filas no fabrica una sesión válida. La fila, además, tiene su propio
 * identificador UUIDv7 (el `session_id` de la base), que es el que nombran la auditoría y los
 * cierres. El token CSRF es el HMAC-SHA-256 del mismo identificador de 32 bytes, con la etiqueta de
 * CSRF, distinta de la de las sesiones y de la de los enlaces (`tokens.ts`), como los tokens con
 * HMAC atados a la sesión de OWASP. El servidor no lo guarda: lo calcula al comprobarlo, en tiempo
 * constante, y al devolverlo.
 */
export const SESSION_SECRET_BYTES = 32;
const KEY_BYTES = 32;
const SESSION_LABEL = Buffer.from('buoh/sesion/v1\u0000', 'utf8');
const CSRF_LABEL = Buffer.from('buoh/csrf/v1\u0000', 'utf8');
const CSRF_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

/** El nombre de la cookie de la sesión (ADR-0019 §2). El prefijo `__Host-` exige `Secure` y `Path=/`. */
export const SESSION_COOKIE_NAME = '__Host-Http-buoh_sesion';

/** El identificador de 32 bytes aleatorios de una sesión, en base64url: el valor de la cookie. */
export function newSessionSecret(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(SESSION_SECRET_BYTES);
  if (bytes.byteLength !== SESSION_SECRET_BYTES) {
    throw new TypeError(`El identificador de sesión son ${String(SESSION_SECRET_BYTES)} bytes.`);
  }
  return Buffer.from(bytes).toString('base64url');
}

/** Los 32 bytes de un identificador de sesión en base64url canónico, o `null` si no lo es. */
export function sessionSecretBytes(secret: string): Buffer | null {
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== SESSION_SECRET_BYTES || bytes.toString('base64url') !== secret) {
    return null;
  }
  return bytes;
}

function requireKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new TypeError(`La clave de las sesiones debe tener ${String(KEY_BYTES)} bytes.`);
  }
}

/** El HMAC que se guarda de una sesión: HMAC-SHA-256(clave, etiqueta de sesión ‖ bytes del id). */
export function sessionTokenDigest(key: Uint8Array, secret: string): Buffer {
  requireKey(key);
  const bytes = sessionSecretBytes(secret);
  if (bytes === null) {
    throw new TypeError('El identificador de sesión no son 32 bytes en base64url canónico.');
  }
  return createHmac('sha256', key).update(SESSION_LABEL).update(bytes).digest();
}

/** El token CSRF de una sesión: HMAC-SHA-256(clave, etiqueta de CSRF ‖ bytes del id), en hex. */
export function csrfTokenFor(key: Uint8Array, secret: string): string {
  requireKey(key);
  const bytes = sessionSecretBytes(secret);
  if (bytes === null) {
    throw new TypeError('El identificador de sesión no son 32 bytes en base64url canónico.');
  }
  return createHmac('sha256', key).update(CSRF_LABEL).update(bytes).digest('hex');
}

/**
 * Comprueba un token CSRF contra el identificador de su sesión, en tiempo constante. `false` si el
 * token no tiene el formato o no corresponde; nunca lanza.
 */
export function isValidCsrfToken(key: Uint8Array, secret: string, token: unknown): boolean {
  if (typeof token !== 'string' || !CSRF_TOKEN_PATTERN.test(token)) {
    return false;
  }
  let expected: string;
  try {
    expected = csrfTokenFor(key, secret);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
}

/** La cabecera `Set-Cookie` de la sesión (ADR-0019 §2): `HttpOnly`, `Secure`, `SameSite=Strict`. */
export function buildSessionCookie(secret: string, maxAgeSeconds: number): string {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError('El Max-Age de la cookie es un entero no negativo.');
  }
  return `${SESSION_COOKIE_NAME}=${secret}; Max-Age=${String(maxAgeSeconds)}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

/** La cabecera `Set-Cookie` que borra la sesión del navegador, al cerrarla. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

/** El identificador de la sesión de la cabecera `Cookie`, o `null` si no está. */
export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) {
      continue;
    }
    if (part.slice(0, equals).trim() === SESSION_COOKIE_NAME) {
      return part.slice(equals + 1).trim();
    }
  }
  return null;
}
