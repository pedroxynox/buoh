import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256Hex } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  loadMigrations,
  migrate,
  MigrationApplyError,
  MigrationIntegrityError,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIRECTORY,
} from '../src/postgres/migrate.js';

// Las migraciones de la API (ADR-0019 §7) sin PostgreSQL: un cliente que anota cada consulta. La
// prueba contra PostgreSQL está en integration/migrate.test.ts.

const MIGRATION_NAMES = ['0001_auditoria.sql', '0002_cuentas.sql'];

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

/**
 * Un pool cuyo cliente anota cada consulta y responde sin filas, o con `rows` a la lectura de las
 * migraciones aplicadas, o con el error de `fail`.
 */
function recordingPool(
  input: {
    readonly fail?: (text: string) => Error | undefined;
    readonly rows?: readonly { name: string; sha256: string }[];
  } = {},
) {
  const queries: Recorded[] = [];
  let released = 0;
  const client = Object.assign(new EventEmitter(), {
    query: (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      const error = input.fail?.(text);
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve({
        rows: text.startsWith('SELECT name, sha256') ? (input.rows ?? []) : [],
      });
    },
    release: () => {
      released += 1;
    },
  });
  return {
    client,
    pool: { connect: () => Promise.resolve(client) } as never,
    queries,
    released: () => released,
    texts: () => queries.map((query) => query.text.replace(/\s+/gu, ' ').trim()),
  };
}

async function applied(): Promise<{ name: string; sha256: string }[]> {
  return Promise.all(
    MIGRATION_NAMES.map(async (name) => ({
      name,
      sha256: sha256Hex(await readFile(new URL(name, MIGRATIONS_DIRECTORY), 'utf8')),
    })),
  );
}

describe('loadMigrations', () => {
  it('lee las migraciones de apps/api/migrations en orden, con el SHA-256 de su texto', async () => {
    expect((await readdir(MIGRATIONS_DIRECTORY)).sort()).toEqual(MIGRATION_NAMES);
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual(MIGRATION_NAMES);
    for (const migration of migrations) {
      expect(migration.sha256).toBe(sha256Hex(migration.sql));
    }
  });

  it('rechaza un archivo fuera de secuencia o con otro nombre, sin leer los demás', async () => {
    for (const names of [
      ['0001_a.sql', '0003_c.sql'],
      ['0002_b.sql'],
      ['0001_a.sql', '0002_B.sql'],
      ['0001_a.sql', '0002-b.sql'],
    ]) {
      const directory = await mkdtemp(join(tmpdir(), 'buoh-api-migraciones-'));
      try {
        for (const name of names) {
          await writeFile(join(directory, name), 'SELECT 1;\n');
        }
        const rejection = loadMigrations(pathToFileURL(`${directory}/`));
        await expect(rejection, names.join(' ')).rejects.toBeInstanceOf(MigrationIntegrityError);
        await expect(rejection).rejects.toMatchObject({ reason: 'migration_out_of_sequence' });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });
});

describe('migrate', () => {
  it('en una transacción con su bloqueo, como el rol dueño, crea el esquema buoh_api, aplica las pendientes y las anota', async () => {
    const recording = recordingPool();
    const result = await migrate(recording.pool, { ownerRole: 'buoh_dueno' });
    expect(result).toEqual({ applied: MIGRATION_NAMES, current: MIGRATION_NAMES });
    const texts = recording.texts();
    expect(texts.slice(0, 6)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'SET LOCAL ROLE "buoh_dueno"',
      'CREATE SCHEMA IF NOT EXISTS "buoh_api"',
      'SET LOCAL search_path TO "buoh_api"',
      'CREATE TABLE IF NOT EXISTS buoh_schema_migrations ( name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now() )',
    ]);
    expect(recording.queries[1]?.values).toEqual([MIGRATION_LOCK_KEY]);
    expect(MIGRATION_LOCK_KEY).not.toBe(4_100_013);
    const inserts = recording.queries.filter((query) =>
      query.text.startsWith('INSERT INTO buoh_schema_migrations'),
    );
    expect(inserts.map((query) => query.values)).toEqual(
      (await applied()).map((migration) => [migration.name, migration.sha256]),
    );
    expect(texts.at(-1)).toBe('COMMIT');
    expect(recording.released()).toBe(1);
    expect(recording.client.listenerCount('error')).toBe(0);
  });

  it('sin ownerRole, crea con el usuario de la conexión; con todas aplicadas, no aplica ninguna', async () => {
    const recording = recordingPool({ rows: await applied() });
    expect(await migrate(recording.pool)).toEqual({ applied: [], current: MIGRATION_NAMES });
    const texts = recording.texts();
    expect(texts.some((text) => text.startsWith('SET LOCAL ROLE'))).toBe(false);
    expect(texts.some((text) => text.startsWith('INSERT'))).toBe(false);
    expect(texts.at(-1)).toBe('COMMIT');
  });

  it('una migración aplicada que la API no conoce, o cuyo contenido cambió, aborta sin aplicar nada', async () => {
    for (const [rows, reason, migration] of [
      [
        [...(await applied()), { name: '0003_otra.sql', sha256: '0'.repeat(64) }],
        'migration_unknown',
        '0003_otra.sql',
      ],
      [
        [{ name: '0001_auditoria.sql', sha256: '0'.repeat(64) }],
        'migration_changed',
        '0001_auditoria.sql',
      ],
    ] as const) {
      const recording = recordingPool({ rows });
      const rejection = migrate(recording.pool);
      await expect(rejection).rejects.toBeInstanceOf(MigrationIntegrityError);
      await expect(rejection).rejects.toMatchObject({ migration, reason });
      const texts = recording.texts();
      expect(texts.some((text) => text.startsWith('INSERT'))).toBe(false);
      expect(texts.at(-1)).toBe('ROLLBACK');
    }
  });

  it('una migración que PostgreSQL rechaza sale como MigrationApplyError con su archivo, y la transacción se deshace aunque el ROLLBACK falle', async () => {
    const denied = Object.assign(new Error('permission denied for schema buoh_api'), {
      code: '42501',
    });
    const recording = recordingPool({
      fail: (text) =>
        text.startsWith('ROLLBACK')
          ? new Error('conexión rota')
          : text.includes('CREATE TABLE audit_events')
            ? denied
            : undefined,
    });
    const rejection = migrate(recording.pool);
    await expect(rejection).rejects.toBeInstanceOf(MigrationApplyError);
    await expect(rejection).rejects.toMatchObject({
      cause: denied,
      migration: '0001_auditoria.sql',
    });
    expect(recording.texts().at(-1)).toBe('ROLLBACK');
    expect(recording.released()).toBe(1);
  });

  it('un corte de la conexión durante la transacción no tumba el proceso, y al soltar el cliente deja de escucharlo', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const recording = recordingPool();
    const client = recording.client;
    const query = client.query;
    client.query = (text: string, values?: readonly unknown[]) => {
      if (!text.startsWith('CREATE SCHEMA')) {
        return query(text, values);
      }
      return new Promise((_resolve, reject) => {
        setImmediate(() => {
          client.emit('error', lost);
          reject(lost);
        });
      });
    };
    await expect(migrate(recording.pool)).rejects.toBe(lost);
    expect(client.listenerCount('error')).toBe(0);
    expect(recording.texts().at(-1)).toBe('ROLLBACK');
  });

  it('rechaza un ownerRole que no es un nombre de minúsculas, cifras y _, sin abrir la conexión', async () => {
    const recording = recordingPool();
    for (const ownerRole of ['buoh"; DROP', 'Buoh_dueno', '', '1buoh']) {
      await expect(migrate(recording.pool, { ownerRole }), ownerRole).rejects.toThrow(TypeError);
    }
    expect(recording.queries).toEqual([]);
  });
});
