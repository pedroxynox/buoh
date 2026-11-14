import { migrateCommand } from '../migrate-command.js';
import { createPool } from '../postgres/metadata-store.js';
import { migrateDatasets } from '../postgres/migrate.js';

/**
 * Las migraciones de `buoh_datasets` (ADR-0020 §5), con su propia secuencia: el paso 1 de
 * `buoh-operaciones` las corre en un proceso aparte con la credencial dueña, como `db:migrate` las de
 * cada log. Siempre en `buoh_datasets`, que crea el dueño si no existe, sea cual sea
 * `BUOH_POSTGRES_SCHEMA`. Escribe una sola línea JSON saneada en stdout (`migrateCommand`). Salida 0:
 * aplicadas; 1: fallaron; 2: configuración inválida.
 */
const { exitCode, line } = await migrateCommand(process.env, {
  createPool: (postgres) => createPool(postgres),
  migrate: migrateDatasets,
});
console.log(line);
process.exitCode = exitCode;
