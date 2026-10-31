import { type Pool } from 'pg';

import { ConfigError, loadConfig, POSTGRES_IDENTIFIER, type WorkerConfig } from './config.js';
import {
  MigrationApplyError,
  MigrationIntegrityError,
  type MigrateOptions,
} from './postgres/migrate.js';
import { failureReason } from './source-log/source-event-log.js';

/**
 * Las piezas de `db:migrate` que cambian en las pruebas: el pool y las migraciones. En el comando,
 * `createPool` y `migrate`.
 */
export interface MigrateCommandDeps {
  readonly createPool: (postgres: WorkerConfig['postgres']) => Pick<Pool, 'connect' | 'end'>;
  readonly migrate: (
    pool: Pick<Pool, 'connect'>,
    options: MigrateOptions,
  ) => Promise<{ applied: string[]; current: string[] }>;
}

/**
 * `pnpm --filter @buoh/market-data-worker run db:migrate` (ADR-0018 §8): aplica las migraciones
 * pendientes del esquema de `BUOH_POSTGRES_SCHEMA`, con las credenciales de `BUOH_POSTGRES_*`. En
 * producción son las del rol dueño, separadas de las de ejecución, y `BUOH_POSTGRES_OWNER_ROLE`,
 * opcional, nombra el rol del que son las tablas (`buoh_dueno`).
 *
 * Devuelve una sola línea JSON saneada, como `ingest`: nunca el mensaje de un error, que puede
 * llevar el rol, la base o el host, sino su código o su nombre (`failureReason`).
 * - 0: `status: migrated`, con las aplicadas (`applied`) y todas las del worker (`current`).
 * - 1: `status: failed`. `code: MIGRATION_INVALID` si las migraciones no cuadran, con `reason` y
 *   `migration`; `code: MIGRATION_FAILED` si PostgreSQL no responde o rechaza una migración, con el
 *   motivo saneado y, si la rechazó, `migration`.
 * - 2: configuración inválida (`code: ConfigError`), con los nombres de las variables.
 */
export async function migrateCommand(
  env: Readonly<Record<string, string | undefined>>,
  deps: MigrateCommandDeps,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let config: WorkerConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return configFailure(error);
    }
    throw error;
  }
  const ownerRole = env['BUOH_POSTGRES_OWNER_ROLE'];
  if (ownerRole !== undefined && !POSTGRES_IDENTIFIER.test(ownerRole)) {
    return configFailure(new ConfigError(['BUOH_POSTGRES_OWNER_ROLE']));
  }
  const pool = deps.createPool(config.postgres);
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

function configFailure(error: ConfigError): { readonly exitCode: 2; readonly line: string } {
  return {
    exitCode: 2,
    line: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
  };
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
      reason: failureReason(error.cause),
      status: 'failed',
    };
  }
  return { code: 'MIGRATION_FAILED', reason: failureReason(error), status: 'failed' };
}
