import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('corre la CLI de salud con los límites de V8 de los procesos del worker (ADR-0017 §9)', async () => {
  const { WORKER_NODE_FLAGS } = await import(
    pathToFileURL(join(root, 'apps', 'market-data-worker', 'dist', 'node-flags.js')).href
  );
  // Cada proceso de Node que arranca deja en stderr su script y sus opciones (`execArgv`).
  const dir = mkdtempSync(join(tmpdir(), 'buoh-data-health-'));
  const reporter = join(dir, 'exec-argv.mjs');
  writeFileSync(
    reporter,
    "process.stderr.write(JSON.stringify({ event: 'exec_argv', execArgv: process.execArgv, script: process.argv[1] ?? null }) + '\\n');\n",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'data-health.mjs'), '--symbol', 'R_100'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(reporter).href}` },
      },
    );

    assert.equal(result.status, 2, result.stderr);
    const cli = jsonLines(result.stderr).filter(
      (line) =>
        line.event === 'exec_argv' &&
        line.script === join(root, 'apps', 'market-data-worker', 'dist', 'cli', 'health.js'),
    );
    assert.equal(cli.length, 1, result.stderr);
    assert.deepEqual(cli[0].execArgv, [...WORKER_NODE_FLAGS]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
