import { randomBytes } from 'node:crypto';

import { healthCommand } from '../health/command.js';
import { createUuidV7Generator } from '../ids.js';
import { openHealthStores } from '../runtime.js';
import { realScheduler } from './scheduler.js';

/**
 * `pnpm run data:health -- --json [--symbol R_100]` (ADR-0015 §8): la salud de datos de la fuente
 * de Deriv, observada desde fuera del proceso que ingiere, sin tomar el bloqueo ni escribir nada.
 * Escribe en stdout una sola línea JSON con el `HealthReport`; en stderr, la alerta saneada o el
 * error de uso. Salida 0: `healthy`; 1: otra salud; 2: error de uso o de configuración.
 */
const { exitCode, stderr, stdout } = await healthCommand(process.argv.slice(2), process.env, {
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  openStores: (config) => openHealthStores(config),
  scheduler: realScheduler,
});
if (stderr !== null) {
  process.stderr.write(`${stderr}\n`);
}
if (stdout !== null) {
  process.stdout.write(`${stdout}\n`);
}
process.exitCode = exitCode;
