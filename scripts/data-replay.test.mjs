import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('data:replay usa el script que separa stdout de la compilación', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts['data:replay'], 'node scripts/data-replay.mjs');
});

test('stdout lleva solo una línea JSON aunque antes se compile el worker (runbook F1.3)', () => {
  // Un dataset_id inválido termina antes de abrir PostgreSQL o el almacenamiento: no hace falta
  // ningún servicio ni red.
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'data-replay.mjs'), '--dataset', 'no-es-un-id'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `stdout: ${result.stdout}`);
  const report = JSON.parse(lines[0] ?? '');
  assert.equal(report.code, 'UsageError');
  assert.equal(report.status, 'failed');
});
