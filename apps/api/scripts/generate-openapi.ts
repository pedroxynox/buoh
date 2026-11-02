import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from '../src/openapi.js';
import { API_ROUTES } from '../src/routes.js';

/**
 * `pnpm run openapi:generate` escribe `generated/openapi.json` desde la tabla de rutas y los
 * contratos (ADR-0019 §6). Con `--check` (`pnpm run openapi:check`, dentro de `verify:core`) no
 * escribe nada: compara byte a byte y termina con 1 si el archivo falta o no coincide.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageRoot, 'generated/openapi.json');
const checkOnly = process.argv.includes('--check');
const content = `${JSON.stringify(buildOpenApiDocument(API_ROUTES), null, 2)}\n`;

if (checkOnly) {
  let current: string | null = null;
  try {
    current = await readFile(output, 'utf8');
  } catch {
    console.error('Falta el OpenAPI generado: apps/api/generated/openapi.json');
  }
  if (current !== content) {
    if (current !== null) {
      console.error('OpenAPI desactualizado: apps/api/generated/openapi.json');
    }
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content, 'utf8');
  console.log('generated apps/api/generated/openapi.json');
}
