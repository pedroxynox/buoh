import { readdir, readFile } from 'node:fs/promises';

import { sha256Hex } from '@buoh/contracts';
import { type Pool } from 'pg';

const MIGRATIONS_DIRECTORY = new URL('../../migrations/', import.meta.url);
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
/** Clave fija de `pg_advisory_xact_lock` para serializar migraciones concurrentes. */
const MIGRATION_LOCK_KEY = 4_100_013;

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
        throw new TypeError(`Migración fuera de secuencia: ${name}`);
      }
      const sql = await readFile(new URL(name, MIGRATIONS_DIRECTORY), 'utf8');
      return { name, sha256: sha256Hex(sql), sql };
    }),
  );
}

/**
 * Aplica migraciones en orden, cada una en su transacción. Una migración ya aplicada cuyo contenido
 * cambió aborta: las migraciones son append-only igual que los datos.
 */
export async function migrate(pool: Pool): Promise<{ applied: string[]; current: string[] }> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
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
        throw new TypeError(`La base contiene una migración desconocida: ${name}`);
      }
    }
    for (const migration of migrations) {
      const digest = known.get(migration.name);
      if (digest !== undefined) {
        if (digest !== migration.sha256) {
          throw new TypeError(`La migración aplicada ${migration.name} cambió de contenido.`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO buoh_schema_migrations (name, sha256) VALUES ($1, $2)', [
        migration.name,
        migration.sha256,
      ]);
      applied.push(migration.name);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { applied, current: migrations.map((migration) => migration.name) };
}
