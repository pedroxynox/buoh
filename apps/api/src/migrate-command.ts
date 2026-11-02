import { type Pool } from 'pg';

import { ApiConfigError } from './config.js';
import { errorName } from './log.js';
import { loadPostgresConfig, POSTGRES_IDENTIFIER, type PostgresConfig } from './postgres/config.js';
import {
  MigrationApplyError,
  MigrationIntegrityError,
  type MigrateOptions,
} from './postgres/migrate.js';

/** El pool de `db:migrate`: conexiones, cierre y el aviso de error de una conexión inactiva. */
export type MigratePool = Pick<Pool, 'connect' | 'end'> & {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

/** Lo que cambia en las pruebas: el pool y las migraciones. En el comando, `createPool` y `migrate`. */
export interface MigrateCommandDeps {
  readonly createPool: (postgres: PostgresConfig) => MigratePool;
  readonly migrate: (
    pool: Pick<Pool, 'connect'>,
    options: MigrateOptions,
  ) => Promise<{ applied: string[]; current: string[] }>;
}

/**
 * `pnpm --filter @buoh/api run db:migrate` (ADR-0019 §7): aplica las migraciones pendientes del
 * esquema `buoh_api`, con las credenciales de `BUOH_POSTGRES_*`. En producción son las del rol
 * dueño, que le da `buoh-operaciones` en un proceso aparte, y `BUOH_POSTGRES_OWNER_ROLE` nombra el
 * rol del que son el esquema y las tablas (`buoh_dueno`). En `production` es obligatoria.
 *
 * Escribe una sola línea JSON saneada, con la forma de la del `db:migrate` del worker, que es la
 * que lee `buoh-operaciones`: nunca el mensaje de un error, que puede llevar el rol, la base o el
 * servidor, sino su código o su nombre (`errorName`).
 * - 0: `status: migrated`, con las aplicadas (`applied`) y todas las de la API (`current`).
 * - 1: `status: failed`. `code: MIGRATION_INVALID` si las migraciones no cuadran, con `reason` y
 *   `migration`; `code: MIGRATION_FAILED` si PostgreSQL no responde, corta la conexión o rechaza el
 *   SQL, con el motivo saneado y, si rechazó una migración, `migration`.
 * - 2: configuración inválida (`code: ConfigError`), con los nombres de las variables rechazadas.
 */
export async function migrateCommand(
  env: Readonly<Record<string, string | undefined>>,
  deps: MigrateCommandDeps,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  const rejected = new Set<string>();
  let config: ReturnType<typeof loadPostgresConfig> | null = null;
  try {
    config = loadPostgresConfig(env);
  } catch (error) {
    if (!(error instanceof ApiConfigError)) {
      throw error;
    }
    for (const variable of error.variables) {
      rejected.add(variable);
    }
  }
  const ownerRole = env['BUOH_POSTGRES_OWNER_ROLE'];
  if (
    ownerRole === undefined
      ? env['BUOH_DEPLOYMENT_ENVIRONMENT'] === 'production'
      : !POSTGRES_IDENTIFIER.test(ownerRole)
  ) {
    rejected.add('BUOH_POSTGRES_OWNER_ROLE');
  }
  if (config === null || rejected.size > 0) {
    const error = new ApiConfigError([...rejected].sort());
    return {
      exitCode: 2,
      line: JSON.stringify({ code: 'ConfigError', message: error.message, status: 'failed' }),
    };
  }
  const pool = deps.createPool(config.postgres);
  // El error de una conexión inactiva del pool no tumba el proceso sin su línea: la consulta
  // siguiente falla y su motivo sale en ella.
  pool.on('error', () => undefined);
  try {
    const result = await deps.migrate(pool, ownerRole === undefined ? {} : { ownerRole });
    return {
      exitCode: 0,
      line: JSON.stringify({
        applied: result.applied,
        current: result.current,
        status: 'migrated',
      }),
    };
  } catch (error) {
    return { exitCode: 1, line: JSON.stringify(migrationFailure(error)) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** El resultado saneado de una migración fallida: códigos y nombres de archivo, nunca mensajes. */
function migrationFailure(error: unknown): Record<string, string> {
  if (error instanceof MigrationIntegrityError) {
    return {
      code: 'MIGRATION_INVALID',
      migration: error.migration,
      reason: error.reason,
      status: 'failed',
    };
  }
  if (error instanceof MigrationApplyError) {
    return {
      code: 'MIGRATION_FAILED',
      migration: error.migration,
      reason: errorName(error.cause),
      status: 'failed',
    };
  }
  return { code: 'MIGRATION_FAILED', reason: errorName(error), status: 'failed' };
}
