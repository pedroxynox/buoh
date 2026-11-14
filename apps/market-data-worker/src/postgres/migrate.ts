import { readdir, readFile } from 'node:fs/promises';

import { sha256Hex } from '@buoh/contracts';
import pg, { type Pool } from 'pg';

import { POSTGRES_IDENTIFIER } from '../config.js';
import { DATASETS_SCHEMA } from '../datasets/location.js';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;

/**
 * Una secuencia de migraciones del worker: su directorio, la clave fija de `pg_advisory_xact_lock`
 * que serializa sus migraciones concurrentes y, si la tiene, el esquema fijo en el que se aplican.
 * Sin esquema, se aplican en el `search_path` del pool, como las de cada log.
 */
export interface MigrationSequence {
  readonly directory: URL;
  readonly lockKey: number;
  readonly schema?: string;
}

/** Las migraciones de cada log (ADR-0018 §6), en el esquema del `search_path` del pool. */
export const LOG_MIGRATIONS: MigrationSequence = {
  directory: new URL('../../migrations/', import.meta.url),
  lockKey: 4_100_013,
};

/**
 * Las migraciones de `buoh_datasets` (ADR-0020 §5), su propia secuencia, siempre en ese esquema, que
 * crean si no existe. Su clave no es la de los logs (4 100 013) ni las de la API (4 100 019 y
 * 4 100 020).
 */
export const DATASETS_MIGRATIONS: MigrationSequence = {
  directory: new URL('../../migrations-datasets/', import.meta.url),
  lockKey: 4_100_021,
  schema: DATASETS_SCHEMA,
};

/**
 * Las migraciones del worker o las ya aplicadas no cuadran: un archivo fuera de secuencia, una
 * migración aplicada que el worker no conoce o una cuyo contenido cambió. No se reintenta: hace
 * falta otro código o el esquema correcto. `reason` es el motivo y `migration` el archivo; ninguno
 * lleva datos del servidor. Es un `TypeError`, como antes.
 */
export class MigrationIntegrityError extends TypeError {
  readonly migration: string;
  readonly reason: 'migration_changed' | 'migration_out_of_sequence' | 'migration_unknown';

  constructor(reason: MigrationIntegrityError['reason'], migration: string, message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
    this.migration = migration;
    this.reason = reason;
  }
}

/**
 * PostgreSQL rechazó el SQL de una migración, por ejemplo por falta de privilegios (`42501`). La
 * transacción se deshace entera. `migration` es el archivo, y `cause`, el error de PostgreSQL, cuyo
 * mensaje no sale de aquí: quien lo informa usa su código (`failureReason`).
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
   * El rol dueño con el que se crean las tablas, si no es el usuario de la conexión (ADR-0018 §8):
   * `SET LOCAL ROLE`, dentro de la transacción de las migraciones. En producción, `buoh_dueno`. El
   * usuario tiene que ser miembro del rol con `SET`.
   */
  readonly ownerRole?: string;
}

export interface Migration {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
}

export async function loadMigrations(
  sequence: MigrationSequence = LOG_MIGRATIONS,
): Promise<Migration[]> {
  const names = (await readdir(sequence.directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name, index) => {
      const match = MIGRATION_FILE.exec(name);
      if (match?.[1] === undefined || Number(match[1]) !== index + 1) {
        throw new MigrationIntegrityError(
          'migration_out_of_sequence',
          name,
          `Migración fuera de secuencia: ${name}`,
        );
      }
      const sql = await readFile(new URL(name, sequence.directory), 'utf8');
      return { name, sha256: sha256Hex(sql), sql };
    }),
  );
}

/** La tabla no existe (`undefined_table`): el esquema nunca recibió `db:migrate`. */
const UNDEFINED_TABLE = '42P01';

/**
 * Las migraciones del worker que el esquema del pool todavía no tiene, en orden, sin aplicar nada:
 * las que faltan en `buoh_schema_migrations`, o todas si esa tabla no existe. La usa `ingest`, que
 * no arranca sin ellas (runbook, «Captura viva continua»). Con `schema`, mira la tabla de ese
 * esquema en lugar de la del `search_path` del pool, como la espera del arranque en `production`
 * con el esquema del log activo (ADR-0018 §4). Cualquier otro error de la consulta, como un
 * PostgreSQL que no responde, la rechaza con él.
 */
export async function pendingMigrations(
  pool: Pick<Pool, 'query'>,
  schema?: string,
): Promise<string[]> {
  if (schema !== undefined && !POSTGRES_IDENTIFIER.test(schema)) {
    throw new TypeError('El esquema debe ser un nombre de minúsculas, cifras y _.');
  }
  const migrations = await loadMigrations();
  const table =
    schema === undefined
      ? 'buoh_schema_migrations'
      : `${pg.escapeIdentifier(schema)}.buoh_schema_migrations`;
  let applied: ReadonlySet<string>;
  try {
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM ${table} ORDER BY name`);
    applied = new Set(rows.map((row) => row.name));
  } catch (error) {
    if ((error as { code?: unknown }).code !== UNDEFINED_TABLE) {
      throw error;
    }
    applied = new Set();
  }
  return migrations.map((migration) => migration.name).filter((name) => !applied.has(name));
}

/**
 * Aplica las migraciones pendientes en orden, todas en una transacción. Una migración ya aplicada
 * cuyo contenido cambió aborta: las migraciones son append-only igual que los datos. Con
 * `ownerRole`, las tablas son de ese rol (`SET LOCAL ROLE`), no del usuario de la conexión.
 */
export async function migrate(
  pool: Pick<Pool, 'connect'>,
  options: MigrateOptions = {},
): Promise<{ applied: string[]; current: string[] }> {
  return migrateSequence(pool, LOG_MIGRATIONS, options);
}

/**
 * Las migraciones de `buoh_datasets` (ADR-0020 §5), como `migrate`, pero siempre en ese esquema:
 * con `ownerRole`, lo crea ese rol si no existe, y las tablas, la tabla de migraciones y las
 * funciones quedan en él, sea cual sea el `search_path` del pool.
 */
export async function migrateDatasets(
  pool: Pick<Pool, 'connect'>,
  options: MigrateOptions = {},
): Promise<{ applied: string[]; current: string[] }> {
  return migrateSequence(pool, DATASETS_MIGRATIONS, options);
}

async function migrateSequence(
  pool: Pick<Pool, 'connect'>,
  sequence: MigrationSequence,
  options: MigrateOptions,
): Promise<{ applied: string[]; current: string[] }> {
  const { ownerRole } = options;
  if (ownerRole !== undefined && !POSTGRES_IDENTIFIER.test(ownerRole)) {
    throw new TypeError('ownerRole debe ser un nombre de rol de minúsculas, cifras y _.');
  }
  const migrations = await loadMigrations(sequence);
  const client = await pool.connect();
  // Mientras el cliente está fuera del pool, un corte de la conexión emite `error` en él, y sin
  // oyente tumbaría el proceso. La consulta en curso, o la siguiente, falla con ese error.
  const ignoreConnectionError = (): void => undefined;
  client.on('error', ignoreConnectionError);
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [sequence.lockKey]);
    if (ownerRole !== undefined) {
      await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(ownerRole)}`);
    }
    if (sequence.schema !== undefined) {
      // Las migraciones nombran sus tablas sin esquema, como las de la API.
      const schema = pg.escapeIdentifier(sequence.schema);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS buoh_schema_migrations (
         name text PRIMARY KEY,
         sha256 text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string; sha256: string }>(
      'SELECT name, sha256 FROM buoh_schema_migrations ORDER BY name',
    );
    const known = new Map(rows.map((row) => [row.name, row.sha256]));
    for (const name of known.keys()) {
      if (!migrations.some((migration) => migration.name === name)) {
        throw new MigrationIntegrityError(
          'migration_unknown',
          name,
          `La base contiene una migración desconocida: ${name}`,
        );
      }
    }
    for (const migration of migrations) {
      const digest = known.get(migration.name);
      if (digest !== undefined) {
        if (digest !== migration.sha256) {
          throw new MigrationIntegrityError(
            'migration_changed',
            migration.name,
            `La migración aplicada ${migration.name} cambió de contenido.`,
          );
        }
        continue;
      }
      try {
        await client.query(migration.sql);
      } catch (error) {
        throw new MigrationApplyError(migration.name, error);
      }
      await client.query('INSERT INTO buoh_schema_migrations (name, sha256) VALUES ($1, $2)', [
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
