import { randomBytes } from 'node:crypto';

import { DERIV_SOURCE } from '../deriv/profile.js';
import { healthCommand } from '../health/command.js';
import { createUuidV7Generator } from '../ids.js';
import { locateActiveLog, openHealthStores } from '../runtime.js';
import { realScheduler } from './scheduler.js';

/**
 * `pnpm run data:health -- --json [--symbol R_100] [--log <n>]` (ADR-0015 §8): la salud de datos
 * de la fuente de Deriv, observada desde fuera del proceso que ingiere, sin tomar el bloqueo ni
 * escribir nada, desde el último punto de control válido del log (ADR-0017 §4); en `production`,
 * del log activo, o el de `--log`, en la secuencia del símbolo (ADR-0018 §6; ADR-0021 §1). Escribe
 * en stdout una sola línea JSON con el `HealthReport`; en stderr, una línea por cada alerta saneada (los puntos de control
 * rechazados y después la de la regla) o el error de uso. Salida 0: `healthy`; 1: otra salud; 2:
 * error de uso o de configuración.
 */
const now = (): string => new Date().toISOString();
const { exitCode, stderr, stdout } = await healthCommand(process.argv.slice(2), process.env, {
  locateLog: (config, requested, sequence) =>
    locateActiveLog(config, { now, number: requested, sequence, source: DERIV_SOURCE }),
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now,
  openStores: (config, sequence) => openHealthStores(config, { sequence }),
  scheduler: realScheduler,
});
if (stderr !== null) {
  process.stderr.write(`${stderr}\n`);
}
if (stdout !== null) {
  process.stdout.write(`${stdout}\n`);
}
process.exitCode = exitCode;
