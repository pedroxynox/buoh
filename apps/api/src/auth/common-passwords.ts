import { readFileSync } from 'node:fs';

import {
  codePointLength,
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
} from './password-policy.js';

/** La lista de bloqueo de las contraseñas (ADR-0019 §1; origen en `data/README.md`). */
export const COMMON_PASSWORDS_FILE = new URL('../../data/contrasenas-comunes.txt', import.meta.url);

/**
 * Lee la lista de bloqueo: una contraseña por línea, en NFC y en minúsculas, de 15 a 128
 * caracteres. Una línea con otro formato lanza `TypeError`, para que una lista dañada no arranque.
 */
export function loadCommonPasswords(file: URL = COMMON_PASSWORDS_FILE): ReadonlySet<string> {
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) {
    throw new TypeError('La lista de bloqueo tiene que terminar con un salto de línea.');
  }
  const passwords = new Set<string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const characters = codePointLength(line);
    if (
      line.normalize('NFC').toLowerCase() !== line ||
      characters < PASSWORD_MIN_CHARACTERS ||
      characters > PASSWORD_MAX_CHARACTERS
    ) {
      throw new TypeError('La lista de bloqueo tiene una línea con otro formato.');
    }
    passwords.add(line);
  }
  return passwords;
}
