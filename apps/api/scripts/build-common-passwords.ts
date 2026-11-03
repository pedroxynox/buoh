import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  codePointLength,
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
} from '../src/auth/password-policy.js';

/**
 * Construye la lista de bloqueo de las contraseñas (ADR-0019 §1), `data/contrasenas-comunes.txt`,
 * desde una copia local de su lista de origen, que no entra en Git (8,5 MB):
 *
 *   pnpm --filter @buoh/api exec tsx scripts/build-common-passwords.ts <ruta de la copia>
 *
 * La copia es `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` de SecLists
 * en el commit fijado en `data/README.md`, y su SHA-256 tiene que ser el de abajo. Cada línea pasa a
 * NFC y a minúsculas, y se quedan las de 15 a 128 caracteres, únicas y ordenadas por unidades de
 * UTF-16. No abre la red.
 */
const SOURCE_SHA256 = '424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51';
const output = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'contrasenas-comunes.txt',
);

const sourcePath = process.argv[2];
if (sourcePath === undefined) {
  console.error(
    'Uso: build-common-passwords.ts <ruta de xato-net-10-million-passwords-1000000.txt>',
  );
  process.exit(2);
}
const source = await readFile(sourcePath);
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== SOURCE_SHA256) {
  console.error(`La copia no es la lista fijada: su SHA-256 es ${digest}.`);
  process.exit(1);
}
const kept = new Set<string>();
for (const line of source.toString('utf8').split('\n')) {
  const normalized = line.normalize('NFC').toLowerCase();
  const characters = codePointLength(normalized);
  if (characters >= PASSWORD_MIN_CHARACTERS && characters <= PASSWORD_MAX_CHARACTERS) {
    kept.add(normalized);
  }
}
const sorted = [...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
await writeFile(output, `${sorted.join('\n')}\n`, 'utf8');
console.log(`${String(sorted.length)} contraseñas en data/contrasenas-comunes.txt`);
