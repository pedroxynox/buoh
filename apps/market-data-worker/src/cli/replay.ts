import { replayCommand } from '../replay-command.js';
import { openStores } from '../runtime.js';

/**
 * `pnpm run data:replay -- --dataset <id> [--verify-only]`. Escribe un informe JSON en stdout.
 * Salida 0: reproducido/verificado; 1: integridad, contrato o recomputación; 2: uso o configuración.
 * En `production`, lee los datasets vivos de `buoh_datasets` y del prefijo `datasets/` (ADR-0020 §8).
 */
const { exitCode, line } = await replayCommand(process.argv.slice(2), process.env, {
  maxRssBytes: () => process.resourceUsage().maxRSS * 1024,
  openStores: (config) => openStores(config),
});
console.log(line);
process.exitCode = exitCode;
