import { randomBytes, randomInt } from 'node:crypto';

import { type Scheduler } from '../deriv/ports.js';
import { openWsSocket } from '../deriv/socket.js';
import { createUuidV7Generator } from '../ids.js';
import { smokeCommand } from '../smoke.js';

/** Temporizador real; solo los comandos operativos lo usan (ADR-0004 §4). */
const realScheduler: Scheduler = {
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Valores de un entero aleatorio de 32 bits: dividido por este número, queda en [0, 1). */
const RANDOM_RANGE = 2 ** 32;

/**
 * `pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120]
 * [--interrupt-after-seconds <n>]` (ADR-0012 §10 y ADR-0015 §9). Escribe una sola línea JSON
 * saneada en stdout; las alertas van a stderr. Salida 0: pasa; 1: falla; 2: error de uso.
 */
const { exitCode, line } = await smokeCommand(process.argv.slice(2), {
  connect: openWsSocket,
  fetch: globalThis.fetch,
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  // El azar de la espera entre intentos (ADR-0015 §3), de `node:crypto`.
  random: () => randomInt(RANDOM_RANGE) / RANDOM_RANGE,
  scheduler: realScheduler,
  zlibVersion: process.versions.zlib,
});
console.log(line);
process.exitCode = exitCode;
