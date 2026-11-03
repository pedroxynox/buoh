import type { Pool } from 'pg';

import type { MigrationState } from '../readiness.js';
import { loadMigrations, MIGRATIONS_TABLE, type Migration } from './migrate.js';

/** El esquema o la tabla de las migraciones todavía no existen: faltan migraciones. */
const MISSING = new Set(['3F000', '42P01']);

/**
 * El estado de las migraciones de esta versión de la API en la base (ADR-0019 §7). Una migración
 * aplicada que esta versión no conoce no cuenta: durante un despliegue, la versión anterior sigue
 * funcionando con las migraciones de la nueva, que solo añaden. Cualquier otro error de PostgreSQL,
 * como `42501` si `buoh_api` todavía no tiene sus privilegios, sale tal cual.
 */
export async function migrationState(
  pool: Pick<Pool, 'query'>,
  migrations?: readonly Migration[],
): Promise<MigrationState> {
  const expected = migrations ?? (await loadMigrations());
  let rows: { name: string; sha256: string }[];
  try {
    ({ rows } = await pool.query<{ name: string; sha256: string }>(
      `SELECT name, sha256 FROM buoh_api.${MIGRATIONS_TABLE}`,
    ));
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && MISSING.has(code)) {
      return 'migrations_pending';
    }
    throw error;
  }
  const applied = new Map(rows.map((row) => [row.name, row.sha256]));
  for (const migration of expected) {
    const digest = applied.get(migration.name);
    if (digest === undefined) {
      return 'migrations_pending';
    }
    if (digest !== migration.sha256) {
      return 'migration_changed';
    }
  }
  return 'ready';
}
