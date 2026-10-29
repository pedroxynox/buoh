import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Las líneas de `text` que son un objeto JSON, en orden; las demás no cuentan. */
function jsonLines(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

test('data:health usa el script que separa stdout de la compilación', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts['data:health'], 'node scripts/data-health.mjs');
});

test('sin --json no abre ningún almacén: salida 2, stdout vacío y el error de uso en stderr (ADR-0015 §8, regla 1)', () => {
  // Termina en el análisis de argumentos, antes de leer la configuración: no hace falta ningún
  // servicio ni red.
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'data-health.mjs'), '--symbol', 'R_100'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  const errors = jsonLines(result.stderr);
  assert.equal(errors.length, 1, `stderr: ${result.stderr}`);
  const [error] = errors;
  assert.equal(error.code, 'UsageError');
  assert.equal(error.status, 'failed');
  assert.match(error.message, /--json/u);
});
