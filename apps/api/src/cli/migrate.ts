import { migrateCommand } from '../migrate-command.js';
import { migrate } from '../postgres/migrate.js';
import { createPool } from '../postgres/pool.js';

/**
 * `node apps/api/dist/cli/migrate.js` (`pnpm --filter @buoh/api run db:migrate`): aplica las
 * migraciones del esquema `buoh_api` (ADR-0019 §7) y escribe una sola línea JSON en stdout. Salida 0:
 * migrado; 1: no pudo migrar; 2: configuración inválida (`migrateCommand`).
 */
const { exitCode, line } = await migrateCommand(process.env, { createPool, migrate });
process.stdout.write(`${line}\n`);
process.exitCode = exitCode;
