import { randomBytes } from 'node:crypto';

import { batchCommand } from '../batch/command.js';
import { openBatchLog } from '../batch/log.js';
import { DERIV_SOURCE } from '../deriv/profile.js';
import { openWsSocket } from '../deriv/socket.js';
import { createUuidV7Generator } from '../ids.js';
import { SourceLock } from '../postgres/source-lock.js';
import { openStartupReads } from '../runtime.js';
import { realScheduler } from './scheduler.js';

/**
 * `batch -- --json [--state <json>]` (ADR-0021 §3; precisión del PR 5c1 de su §9): en
 * `production`, pide a Deriv lo que le toca a cada secuencia por lotes y lo guarda en su log, con
 * el bloqueo de cada una y la política de segmentos 2.0.0 (`openBatchLog`). Escribe en stdout una
 * sola línea JSON con lo que hizo y el estado nuevo; en stderr, el error de uso o de configuración.
 * Salida 0: ninguna secuencia falló; 1: alguna falló o no se cargaron los esquemas; 2: uso o
 * configuración.
 */
const now = (): string => new Date().toISOString();
const { exitCode, stderr, stdout } = await batchCommand(process.argv.slice(2), process.env, {
  acquireLock: (config, sequence) =>
    SourceLock.acquire({ postgres: config.postgres, sequence, source: DERIV_SOURCE }),
  connect: openWsSocket,
  fetch: globalThis.fetch,
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now,
  openLog: openBatchLog,
  openReads: (config, sequence) =>
    openStartupReads(config, { now, sequence, source: DERIV_SOURCE }),
  scheduler: realScheduler,
});
if (stderr !== null) {
  process.stderr.write(`${stderr}\n`);
}
if (stdout !== null) {
  process.stdout.write(`${stdout}\n`);
}
process.exitCode = exitCode;
