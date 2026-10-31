import { readdir, readFile } from 'node:fs/promises';

import { sha256Hex } from '@buoh/contracts';
import pg, { type Pool } from 'pg';

import { POSTGRES_IDENTIFIER } from '../config.js';

const MIGRATIONS_DIRECTORY = new URL('../../migrations/', import.meta.url);
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
/** Clave fija de `pg_advisory_xact_lock` para serializar migraciones concurrentes. */
const MIGRATION_LOCK_KEY = 4_100_013;

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

export async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith('.sql'))
    .sort();
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
      const sql = await readFile(new URL(name, MIGRATIONS_DIRECTORY), 'utf8');
      return { name, sha256: sha256Hex(sql), sql };
    }),
  );
}

/** La tabla no existe (`undefined_table`): el esquema nunca recibió `db:migrate`. */
const UNDEFINED_TABLE = '42P01';

/**
 * Las migraciones del worker que el esquema del pool todavía no tiene, en orden, sin aplicar nada:
 * las que faltan en `buoh_schema_migrations`, o todas si esa tabla no existe. La usa `ingest`, que
 * no arranca sin ellas (runbook, «Captura viva continua»). Cualquier otro error de la consulta, como
 * un PostgreSQL que no responde, la rechaza con él.
 */
export async function pendingMigrations(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const migrations = await loadMigrations();
  let applied: ReadonlySet<string>;
  try {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM buoh_schema_migrations ORDER BY name',
    );
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
  const { ownerRole } = options;
  if (ownerRole !== undefined && !POSTGRES_IDENTIFIER.test(ownerRole)) {
    throw new TypeError('ownerRole debe ser un nombre de rol de minúsculas, cifras y _.');
  }
  const migrations = await loadMigrations();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    if (ownerRole !== undefined) {
      await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(ownerRole)}`);
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
    client.release();
  }
  return { applied, current: migrations.map((migration) => migration.name) };
}
