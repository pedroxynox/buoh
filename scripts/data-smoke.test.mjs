import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('data:smoke usa el script que separa stdout de la compilación', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts['data:smoke'], 'node scripts/data-smoke.mjs');
});

test('sin --live no abre conexiones: salida 2 y una sola línea JSON (ADR-0012 §10)', () => {
  // Termina en el análisis de argumentos, antes de cualquier red: así ningún verify ni CI se
  // conecta a Deriv.
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'data-smoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `stdout: ${result.stdout}`);
  const report = JSON.parse(lines[0] ?? '');
  assert.equal(report.code, 'UsageError');
  assert.equal(report.status, 'failed');
  assert.match(report.message, /--live/u);
});
