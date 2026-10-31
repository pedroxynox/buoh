import { migrateCommand } from '../migrate-command.js';
import { migrate } from '../postgres/migrate.js';
import { createPool } from '../postgres/metadata-store.js';

/**
 * `pnpm --filter @buoh/market-data-worker run db:migrate`: aplica las migraciones pendientes y
 * escribe una sola línea JSON saneada en stdout (`migrateCommand`). Salida 0: aplicadas; 1:
 * fallaron; 2: configuración inválida.
 */
const { exitCode, line } = await migrateCommand(process.env, {
  createPool: (postgres) => createPool(postgres),
  migrate,
});
console.log(line);
process.exitCode = exitCode;
