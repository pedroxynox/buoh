import { randomBytes, randomInt } from 'node:crypto';

import { DERIV_SOURCE } from '../deriv/profile.js';
import { openWsSocket } from '../deriv/socket.js';
import { createUuidV7Generator } from '../ids.js';
import { ingestCommand } from '../ingest.js';
import { pendingMigrations } from '../postgres/migrate.js';
import { openLockedSourceLog, PostgresSessionLockProvider } from '../postgres/session-lock.js';
import { openStores } from '../runtime.js';
import { realScheduler } from './scheduler.js';

/** Valores de un entero aleatorio de 32 bits: dividido por este número, queda en [0, 1). */
const RANDOM_RANGE = 2 ** 32;

/** Las señales que paran la captura (ADR-0015 §3, «Parada»). */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * `pnpm --filter @buoh/market-data-worker run ingest -- --live [--symbol R_100]` (ADR-0015 §7): la
 * captura viva continua sobre PostgreSQL y el almacenamiento de objetos de la configuración, con el
 * esquema y el bucket propios de la captura. `SIGINT` o `SIGTERM` la paran; para a las 23 horas del
 * evento durable más antiguo del log. Escribe una sola línea JSON saneada en stdout al terminar; las
 * alertas van a stderr. Salida 0: terminó `completed`; 1: `failed`; 2: error de uso, de configuración
 * o migraciones pendientes.
 */
const { exitCode, line } = await ingestCommand(process.argv.slice(2), process.env, {
  connect: openWsSocket,
  fetch: globalThis.fetch,
  lockProvider: (config) =>
    new PostgresSessionLockProvider({ postgres: config.postgres, source: DERIV_SOURCE }),
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  openLog: openLockedSourceLog,
  openStores: (config) => {
    const stores = openStores(config);
    return { ...stores, pendingMigrations: () => pendingMigrations(stores.pool) };
  },
  // El azar de la espera entre intentos (ADR-0015 §3), de `node:crypto`.
  random: () => randomInt(RANDOM_RANGE) / RANDOM_RANGE,
  scheduler: realScheduler,
  signals: (onSignal) => {
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }
    return () => {
      for (const signal of STOP_SIGNALS) {
        process.off(signal, onSignal);
      }
    };
  },
  zlibVersion: process.versions.zlib,
});
console.log(line);
process.exitCode = exitCode;
