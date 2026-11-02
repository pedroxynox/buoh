import { readdir, readFile } from 'node:fs/promises';

import { sha256Hex } from '@buoh/contracts';
import pg, { type Pool } from 'pg';

import { API_SCHEMA, POSTGRES_IDENTIFIER } from './config.js';

// Las migraciones de la API (ADR-0019 §7), con las reglas de las del worker: solo añaden, se
// aplican en orden en una transacción y una migración aplicada no puede cambiar.

export const MIGRATIONS_DIRECTORY = new URL('../../migrations/', import.meta.url);
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
/**
 * La clave de `pg_advisory_xact_lock` de las migraciones de la API. Es distinta de la de los logs
 * (4 100 013): las de la API y las de un log no se esperan entre sí.
 */
export const MIGRATION_LOCK_KEY = 4_100_019;
/** La tabla de las migraciones aplicadas, en el esquema de la API. `buoh_api` solo la lee. */
export const MIGRATIONS_TABLE = 'buoh_schema_migrations';

/**
 * Las migraciones de la API o las ya aplicadas no cuadran: un archivo fuera de secuencia, una
 * migración aplicada que la API no conoce o una cuyo contenido cambió. No se reintenta. `reason` es
 * el motivo y `migration` el archivo; ninguno lleva datos del servidor.
 */
export class MigrationIntegrityError extends TypeError {
  readonly migration: string;
  readonly reason: 'migration_changed' | 'migration_out_of_sequence' | 'migration_unknown';

  constructor(reason: MigrationIntegrityError['reason'], migration: string) {
    super(`Las migraciones no cuadran (${reason}): ${migration}.`);
    this.name = 'MigrationIntegrityError';
    this.migration = migration;
    this.reason = reason;
  }
}

/**
 * PostgreSQL rechazó el SQL de una migración. La transacción se deshace entera. `cause` es el error
 * de PostgreSQL, cuyo mensaje no sale de aquí: quien lo informa usa su código (`errorName`).
 */
export class MigrationApplyError extends Error {
  readonly migration: string;

  constructor(migration: string, cause: unknown) {
    super(`PostgreSQL rechazó la migración ${migration}.`, { cause });
    this.name = 'MigrationApplyError';
    this.migration = migration;
  }
}

export interface MigrateOptions {
  /**
   * El rol dueño del esquema y de sus tablas, si no es el usuario de la conexión: `SET LOCAL ROLE`
   * dentro de la transacción. En producción, `buoh_dueno` (ADR-0019 §7). El usuario tiene que ser
   * miembro del rol con `SET`.
   */
  readonly ownerRole?: string;
}

export interface Migration {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
}

/**
 * Las migraciones de `directory`, en orden: `0001_…sql`, `0002_…sql` y así, sin huecos, cada una con
 * el SHA-256 de su texto.
 */
export async function loadMigrations(directory: URL = MIGRATIONS_DIRECTORY): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name, index) => {
      const match = MIGRATION_FILE.exec(name);
      if (match?.[1] === undefined || Number(match[1]) !== index + 1) {
        throw new MigrationIntegrityError('migration_out_of_sequence', name);
      }
      const sql = await readFile(new URL(name, directory), 'utf8');
      return { name, sha256: sha256Hex(sql), sql };
    }),
  );
}

/**
 * Aplica las migraciones pendientes de la API en orden, todas en una transacción, con un bloqueo
 * para que dos procesos no migren a la vez. Crea el esquema `buoh_api` si no existe. Con
 * `ownerRole`, el esquema y las tablas son de ese rol, no del usuario de la conexión. Una migración
 * aplicada que la API no conoce, o cuyo contenido cambió, aborta sin aplicar nada.
 */
export async function migrate(
  pool: Pick<Pool, 'connect'>,
  options: MigrateOptions = {},
): Promise<{ applied: string[]; current: string[] }> {
  const { ownerRole } = options;
  if (ownerRole !== undefined && !POSTGRES_IDENTIFIER.test(ownerRole)) {
    throw new TypeError('ownerRole debe ser un nombre de rol de minúsculas, cifras y _.');
  }
  const migrations = await loadMigrations();
  const client = await pool.connect();
  // Mientras el cliente está fuera del pool, un corte de la conexión emite `error` en él, y sin
  // oyente tumbaría el proceso. La consulta en curso, o la siguiente, falla con ese error.
  const ignoreConnectionError = (): void => undefined;
  client.on('error', ignoreConnectionError);
  const applied: string[] = [];
  const schema = pg.escapeIdentifier(API_SCHEMA);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    if (ownerRole !== undefined) {
      await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(ownerRole)}`);
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    // Las migraciones nombran sus tablas sin esquema: van al de la API.
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name text PRIMARY KEY,
         sha256 text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string; sha256: string }>(
      `SELECT name, sha256 FROM ${MIGRATIONS_TABLE} ORDER BY name`,
    );
    const known = new Map(rows.map((row) => [row.name, row.sha256]));
    for (const name of known.keys()) {
      if (!migrations.some((migration) => migration.name === name)) {
        throw new MigrationIntegrityError('migration_unknown', name);
      }
    }
    for (const migration of migrations) {
      const digest = known.get(migration.name);
      if (digest !== undefined) {
        if (digest !== migration.sha256) {
          throw new MigrationIntegrityError('migration_changed', migration.name);
        }
        continue;
      }
      try {
        await client.query(migration.sql);
      } catch (error) {
        throw new MigrationApplyError(migration.name, error);
      }
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, sha256) VALUES ($1, $2)`, [
        migration.name,
        migration.sha256,
      ]);
      applied.push(migration.name);
    }
    await client.query('COMMIT');
  } catch (error) {
    // Con la conexión rota, el ROLLBACK también falla: el error que cuenta es el primero.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.off('error', ignoreConnectionError);
    client.release();
  }
  return { applied, current: migrations.map((migration) => migration.name) };
}
