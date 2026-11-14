import { randomBytes } from 'node:crypto';

import { publishDatasetCommand } from '../datasets/publish-command.js';
import { openPublicationStores } from '../datasets/publication-stores.js';
import { DERIV_SCHEMA_RELEASE } from '../deriv/schema-release.js';
import { createUuidV7Generator } from '../ids.js';

/**
 * `pnpm --filter @buoh/market-data-worker run datasets:publish -- [--skip <n>[,<n>...]]` (ADR-0020
 * §8, paso 6): publica como mucho un dataset vivo, el siguiente del log de menor número que no
 * venció y no está en `--skip`, en `buoh_datasets` y bajo el prefijo `datasets/`. Escribe en stdout
 * una sola línea JSON (`published`, `already_published`, `nothing_due` o `failed`), con su duración
 * y su memoria máxima, y en stderr las alertas saneadas del registro. Salida 0: publicado o nada
 * pendiente; 1: falló; 2: error de uso o de configuración.
 */
const started = performance.now();
const { exitCode, line } = await publishDatasetCommand(process.argv.slice(2), process.env, {
  elapsedMs: () => Math.round(performance.now() - started),
  maxRssBytes: () => process.resourceUsage().maxRSS * 1024,
  nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
  now: () => new Date().toISOString(),
  open: (config) => openPublicationStores(config, { schemas: DERIV_SCHEMA_RELEASE }),
  schemas: DERIV_SCHEMA_RELEASE,
  zlibVersion: process.versions.zlib,
});
console.log(line);
process.exitCode = exitCode;
