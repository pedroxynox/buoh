import { randomBytes } from 'node:crypto';

import { openBatchLog, openHistorySegments } from '../batch/log.js';
import { DERIV_SOURCE } from '../deriv/profile.js';
import { openWsSocket } from '../deriv/socket.js';
import { historyCommand } from '../history/command.js';
import { createUuidV7Generator } from '../ids.js';
import { runWorkerChild } from '../operations/child.js';
import { SourceLock } from '../postgres/source-lock.js';
import { openStartupReads } from '../runtime.js';
import { realScheduler } from './scheduler.js';

/**
 * `pnpm --filter @buoh/market-data-worker run history` (precisión del PR 6c de ADR-0021 §9): el
 * proceso temporal que descarga y publica la historia de R_100, la del oro y, desde el PR 6d, la de
 * las velas, en `production`. Escribe en stdout una línea JSON por bloque, por publicación y al
 * empezar y al terminar; en stderr, el error de uso o de configuración. Salida 0: las tres historias
 * pedidas y publicadas; 1: paró por sus fallos, sin los esquemas o sin el bloqueo; 2: uso o
 * configuración.
 */
const now = (): string => new Date().toISOString();
const { exitCode, stderr } = await historyCommand(process.argv.slice(2), process.env, {
  acquireLock: (config, sequence) =>
    SourceLock.acquire({ postgres: config.postgres, sequence, source: DERIV_SOURCE }),
  connect: openWsSocket,
  fetch: globalThis.fetch,
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now,
  openLog: openBatchLog,
  openReads: (config, sequence) =>
    openStartupReads(config, { now, sequence, source: DERIV_SOURCE }),
  openSegments: openHistorySegments,
  runChild: runWorkerChild,
  scheduler: realScheduler,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  write: (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
});
if (stderr !== null) {
  process.stderr.write(`${stderr}\n`);
}
process.exitCode = exitCode;
