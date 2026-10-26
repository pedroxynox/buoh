import { randomBytes } from 'node:crypto';

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

/**
 * `pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120]` (ADR-0012 §10).
 * Escribe una sola línea JSON saneada en stdout. Salida 0: pasa; 1: falla; 2: error de uso.
 */
const { exitCode, line } = await smokeCommand(process.argv.slice(2), {
  connect: openWsSocket,
  fetch: globalThis.fetch,
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  scheduler: realScheduler,
  zlibVersion: process.versions.zlib,
});
console.log(line);
process.exitCode = exitCode;
