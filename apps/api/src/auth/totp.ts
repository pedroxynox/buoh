import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * El código de 6 cifras de buoh (ADR-0019 §1): TOTP de RFC 6238 sobre HOTP de RFC 4226, con
 * SHA-1, 6 cifras y pasos de 30 s, que es lo que leen todas las apps de autenticación.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_MS = 30_000;
/** Pasos aceptados a cada lado del actual, por el desfase del reloj y el tiempo de escribirlo. */
export const TOTP_WINDOW_STEPS = 1;
/** Bytes del secreto TOTP: 160 bits, por encima de los 112 que pide NIST (ADR-0019 §1). */
export const TOTP_SECRET_BYTES = 20;

const CODE_PATTERN = /^[0-9]{6}$/u;

/** El código HOTP de `counter` con SHA-1 y 6 cifras (RFC 4226 §5.3). */
export function hotp(secret: Uint8Array, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError('El contador de HOTP es un entero no negativo.');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** El paso TOTP de un instante, en milisegundos desde 1970 (RFC 6238 §4, con T0 = 0). */
export function totpStep(epochMs: number): number {
  return Math.floor(epochMs / TOTP_PERIOD_MS);
}

/**
 * El paso que acepta `code` a la hora `nowMs`, o `null`. Prueba el paso actual y uno a cada lado,
 * y solo los posteriores a `lastUsedStep`, el último aceptado con esa credencial: así cada paso
 * vale una sola vez, y nunca uno anterior al último aceptado (ADR-0019 §1). Si dos pasos coinciden,
 * devuelve el mayor, para que ninguno de los dos vuelva a valer.
 */
export function matchTotpCode(input: {
  readonly secret: Uint8Array;
  readonly code: string;
  readonly nowMs: number;
  readonly lastUsedStep: number | null;
}): number | null {
  if (!CODE_PATTERN.test(input.code)) {
    return null;
  }
  const expected = Buffer.from(input.code, 'ascii');
  const current = totpStep(input.nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    if (step < 0 || (input.lastUsedStep !== null && step <= input.lastUsedStep)) {
      continue;
    }
    if (timingSafeEqual(Buffer.from(hotp(input.secret, step), 'ascii'), expected)) {
      matched = step;
    }
  }
  return matched;
}
