import type { PasswordRejectionReason } from '@buoh/contracts';

/**
 * La política de la contraseña de buoh (ADR-0019 §1; NIST SP 800-63B-4, §3.1.1): de 15 a 128
 * caracteres, contados después de normalizarla a NFC, uno por punto de código; sin reglas de
 * composición; y fuera de la lista de bloqueo, que suma a las contraseñas comunes las palabras del
 * contexto: `buoh`, `deriv` y el nombre de usuario con sus variantes. Como pide NIST (§3.1.1.2), se
 * compara la contraseña entera, sin distinguir mayúsculas, y nunca las palabras que contiene.
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

/**
 * Las palabras del contexto: las del servicio y el nombre de usuario, también sin `-` ni `_`, con
 * espacios en su lugar o con uno cambiado por el otro, y cada parte del nombre.
 */
function contextWords(username: string): ReadonlySet<string> {
  return new Set([
    'buoh',
    'deriv',
    username,
    username.replace(/[-_]/gu, ''),
    username.replace(/[-_]/gu, ' '),
    username.replace(/_/gu, '-'),
    username.replace(/-/gu, '_'),
    ...username.split(/[-_]/u),
  ]);
}

/**
 * Comprueba una contraseña nueva. Devuelve la contraseña en NFC, la que se guarda, o el primer
 * motivo por el que no vale, en este orden: la longitud, las contraseñas comunes y el contexto.
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
  if (contextWords(context.username).has(lowered)) {
    return { ok: false, reason: 'context_words' };
  }
  return { ok: true, normalized };
}
