// `pnpm run data:replay -- --dataset <id> [--verify-only]` (runbook, «Entorno local y replay»).
// Compila el worker y ejecuta su CLI de replay. Los mensajes de la compilación van a stderr, para
// que stdout lleve solo la línea JSON del informe. El emulador de shell de pnpm no respeta `1>&2`
// (ADR-0003), así que la redirección se hace aquí y funciona igual en Linux, macOS y Windows.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');

/** Ejecuta Node con `args` y devuelve su código de salida (1 si terminó por una señal). */
function run(args, stdio) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

const built = run(
  [turbo, 'run', 'build', '--filter=@buoh/market-data-worker', '--output-logs=errors-only'],
  ['ignore', process.stderr, process.stderr],
);
if (built !== 0) process.exit(built);

process.exit(
  run(
    [
      join(root, 'apps', 'market-data-worker', 'dist', 'cli', 'replay.js'),
      ...process.argv.slice(2),
    ],
    'inherit',
  ),
);
