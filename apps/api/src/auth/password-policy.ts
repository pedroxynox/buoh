import type { PasswordRejectionReason } from '@buoh/contracts';

/**
 * La política de la contraseña de buoh (ADR-0019 §1; NIST SP 800-63B-4, §3.1.1): de 15 a 128
 * caracteres, contados después de normalizarla a NFC, uno por punto de código; sin reglas de
 * composición; fuera de la lista de bloqueo, sin distinguir mayúsculas; y con 15 caracteres o más
 * que no sean palabras del contexto: `buoh`, `deriv` y el nombre de usuario con sus variantes.
 */
export const PASSWORD_MIN_CHARACTERS = 15;
export const PASSWORD_MAX_CHARACTERS = 128;

export type PasswordCheck =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: PasswordRejectionReason };

/**
 * Los caracteres de un texto como los cuenta NIST: uno por punto de código, así que un emoji fuera
 * del plano básico es uno, aunque ocupe dos unidades de UTF-16.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Las palabras que no cuentan para la longitud: las del servicio y las del nombre de usuario. */
function contextWords(username: string): string[] {
  const words = new Set(['buoh', 'deriv']);
  for (const variant of [
    username,
    username.replace(/[-_]/gu, ''),
    username.replace(/[-_]/gu, ' '),
    username.replace(/_/gu, '-'),
    username.replace(/-/gu, '_'),
    ...username.split(/[-_]/u),
  ]) {
    if (variant.length >= 3) {
      words.add(variant);
    }
  }
  // Las más largas primero, para que una variante entera no se quede a medias.
  return [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Comprueba una contraseña nueva. Devuelve la contraseña en NFC, la que se guarda, o el primer
 * motivo por el que no vale, en este orden: la longitud, la lista de bloqueo y el contexto.
 */
export function checkPassword(
  password: string,
  context: { readonly username: string; readonly commonPasswords: ReadonlySet<string> },
): PasswordCheck {
  const normalized = password.normalize('NFC');
  const characters = codePointLength(normalized);
  if (characters < PASSWORD_MIN_CHARACTERS) {
    return { ok: false, reason: 'too_short' };
  }
  if (characters > PASSWORD_MAX_CHARACTERS) {
    return { ok: false, reason: 'too_long' };
  }
  const lowered = normalized.toLowerCase();
  if (context.commonPasswords.has(lowered)) {
    return { ok: false, reason: 'common_password' };
  }
  let rest = lowered;
  for (const word of contextWords(context.username)) {
    rest = rest.split(word).join('');
  }
  if (codePointLength(rest) < PASSWORD_MIN_CHARACTERS) {
    return { ok: false, reason: 'context_words' };
  }
  return { ok: true, normalized };
}
