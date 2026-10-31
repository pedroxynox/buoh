import { randomBytes } from 'node:crypto';

import { DERIV_SOURCE } from '../deriv/profile.js';
import { createUuidV7Generator } from '../ids.js';
import { stderrAlert } from '../operational/registry.js';
import { runWorkerChild } from '../operations/child.js';
import { openOwnerDatabase } from '../operations/owner-database.js';
import { operationsCommand } from '../operations/run.js';
import { openLogObjects } from '../operations/verification.js';
import { realScheduler } from './scheduler.js';

/**
 * `buoh-operaciones` (ADR-0018 §11): una ejecución del cron job de Render, cada 5 minutos. Crea y
 * ajusta los roles, migra los logs, les da los privilegios y prepara el siguiente, pone las
 * contraseñas de los roles de ejecución, corre `data:health` sobre el log activo, con su informe
 * guardado en ese log, vuelve a leer los segmentos cerrados que le tocan y, una vez al día, mide el
 * espacio. Escribe en stdout una línea JSON por paso y otra al final; en stderr, las alertas
 * saneadas, también las de sus procesos. Salida 0: todo terminó; 1: un paso falló; 2:
 * configuración inválida.
 */
const { exitCode, lines } = await operationsCommand(process.env, {
  alert: stderrAlert,
  forwardChildStderr: (text) => {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  },
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  openDatabase: (config) => openOwnerDatabase(config, { source: DERIV_SOURCE }),
  openObjects: (config, log) => openLogObjects(config.operationsObjects, log),
  runChild: runWorkerChild,
  scheduler: realScheduler,
});
for (const line of lines) {
  process.stdout.write(`${line}\n`);
}
process.exitCode = exitCode;
