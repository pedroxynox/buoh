// `pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120]
// [--interrupt-after-seconds <n>]` (runbook, «Smoke público de Deriv»). Compila el worker y ejecuta
// su CLI de smoke. Los mensajes de la compilación van
// a stderr, para que stdout lleve solo la línea JSON del resultado. El emulador de shell de pnpm no
// respeta `1>&2` (ADR-0003), así que la redirección se hace aquí y funciona igual en Linux, macOS y
// Windows.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'];
/** Primera señal recibida: después de ella no se empieza ningún paso más. */
let interrupted = null;

/** Ejecuta Node con `args`, le reenvía SIGINT y SIGTERM y espera a que termine. */
function run(args, stdio) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio });
    const forward = (signal) => {
      interrupted ??= signal;
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      for (const name of FORWARDED_SIGNALS) process.off(name, forward);
      resolve({ code, signal });
    });
  });
}

/**
 * Termina con el código del proceso hijo. Si una señal detuvo al hijo o a este script, termina con
 * esa misma señal, como el lanzador de turbo, para no confundirlo con la salida 1 del smoke
 * (falla).
 */
function finish({ code, signal }) {
  const stopSignal = interrupted ?? signal;
  if (stopSignal !== null) {
    process.exitCode = 1;
    process.kill(process.pid, stopSignal);
    return;
  }
  process.exit(code ?? 1);
}

const build = await run(
  [turbo, 'run', 'build', '--filter=@buoh/market-data-worker', '--output-logs=errors-only'],
  ['ignore', 2, 2],
);
if (interrupted !== null || build.signal !== null || build.code !== 0) {
  finish(build);
} else {
  finish(
    await run(
      [
        join(root, 'apps', 'market-data-worker', 'dist', 'cli', 'smoke.js'),
        ...process.argv.slice(2),
      ],
      'inherit',
    ),
  );
}
