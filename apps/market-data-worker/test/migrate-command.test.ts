import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  migrate,
  migrateCommand,
  MigrationApplyError,
  MigrationIntegrityError,
  type MigrateCommandDeps,
  type WorkerConfig,
} from '../src/index.js';

// `db:migrate` (ADR-0018 §8, F2-ROLE-001) sin PostgreSQL: un pool falso. Sus errores salen saneados,
// como los de `ingest`: un código o un nombre, nunca el mensaje, que puede llevar el rol, la base o
// el host. La prueba contra PostgreSQL, con el rol dueño, está en integration/roles.test.ts.

const SECRET = 'contraseña-sintética-que-no-sale';
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_PASSWORD: SECRET,
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
};

/**
 * Las piezas del comando, con un pool que anota si se cerró y quién escucha sus errores, y un
 * `migrate` dado.
 */
function deps(run: MigrateCommandDeps['migrate']) {
  const seen: {
    ended: boolean;
    errorListeners: ((error: Error) => void)[];
    options: unknown;
    postgres: WorkerConfig['postgres'] | null;
  } = {
    ended: false,
    errorListeners: [],
    options: null,
    postgres: null,
  };
  const value: MigrateCommandDeps = {
    createPool: (postgres) => {
      seen.postgres = postgres;
      return {
        connect: () => Promise.reject(new Error('no se usa')),
        end: () => {
          seen.ended = true;
          return Promise.resolve();
        },
        on: (_event: 'error', listener: (error: Error) => void) => {
          seen.errorListeners.push(listener);
        },
      };
    },
    migrate: (pool, options) => {
      seen.options = options;
      return run(pool, options);
    },
  };
  return { deps: value, seen };
}

/** Un error de PostgreSQL con su código y un mensaje con datos de la conexión. */
const serverError = (code: string) =>
  Object.assign(new Error(`permission denied for schema, role "buoh", password ${SECRET}`), {
    code,
  });

describe('migrateCommand', () => {
  it('aplica las migraciones y escribe una línea JSON: salida 0, status migrated', async () => {
    const { deps: d, seen } = deps(() =>
      Promise.resolve({ applied: ['0005_x.sql'], current: ['0001_y.sql', '0005_x.sql'] }),
    );
    const result = await migrateCommand(ENV, d);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.line)).toEqual({
      applied: ['0005_x.sql'],
      current: ['0001_y.sql', '0005_x.sql'],
      status: 'migrated',
    });
    expect(seen.options).toEqual({});
    expect(seen.ended).toBe(true);
  });

  it('con BUOH_POSTGRES_OWNER_ROLE, migra como ese rol', async () => {
    const { deps: d, seen } = deps(() => Promise.resolve({ applied: [], current: [] }));
    const result = await migrateCommand({ ...ENV, BUOH_POSTGRES_OWNER_ROLE: 'buoh_dueno' }, d);
    expect(result.exitCode).toBe(0);
    expect(seen.options).toEqual({ ownerRole: 'buoh_dueno' });
  });

  it('una configuración inválida es la salida 2, con los nombres de las variables y sin abrir el pool', async () => {
    for (const env of [
      { ...ENV, BUOH_POSTGRES_PASSWORD: undefined },
      { ...ENV, BUOH_POSTGRES_OWNER_ROLE: 'Dueño; DROP' },
      { ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: 'production' },
    ]) {
      const { deps: d, seen } = deps(() => Promise.reject(new Error('no se llama')));
      const result = await migrateCommand(env, d);
      expect(result.exitCode).toBe(2);
      const line = JSON.parse(result.line) as Record<string, unknown>;
      expect(line).toMatchObject({ code: 'ConfigError', status: 'failed' });
      expect(result.line).not.toContain(SECRET);
      expect(result.line).not.toContain('Dueño');
      expect(seen.postgres).toBeNull();
    }
  });

  it('en production y staging exige BUOH_POSTGRES_OWNER_ROLE, para que las tablas no sean del usuario de la conexión', async () => {
    for (const environment of ['production', 'staging']) {
      const deployed = {
        ...ENV,
        BUOH_DEPLOYMENT_ENVIRONMENT: environment,
        BUOH_POSTGRES_SSLMODE: 'require',
      };
      const missing = deps(() => Promise.reject(new Error('no se llama')));
      const result = await migrateCommand(deployed, missing.deps);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.line)).toEqual({
        code: 'ConfigError',
        message: 'Configuración inválida o ausente: BUOH_POSTGRES_OWNER_ROLE.',
        status: 'failed',
      });
      expect(missing.seen.postgres).toBeNull();
      const present = deps(() => Promise.resolve({ applied: [], current: [] }));
      const migrated = await migrateCommand(
        { ...deployed, BUOH_POSTGRES_OWNER_ROLE: 'buoh_dueno' },
        present.deps,
      );
      expect(migrated.exitCode).toBe(0);
      expect(present.seen.options).toEqual({ ownerRole: 'buoh_dueno' });
    }
  });

  it('BUOH_POSTGRES_OWNER_ROLE inválida se nombra junto con las demás variables rechazadas', async () => {
    const { deps: d, seen } = deps(() => Promise.reject(new Error('no se llama')));
    const result = await migrateCommand(
      { ...ENV, BUOH_POSTGRES_OWNER_ROLE: 'Dueño; DROP', BUOH_POSTGRES_PASSWORD: undefined },
      d,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toEqual({
      code: 'ConfigError',
      message:
        'Configuración inválida o ausente: BUOH_POSTGRES_OWNER_ROLE, BUOH_POSTGRES_PASSWORD.',
      status: 'failed',
    });
    expect(seen.postgres).toBeNull();
  });

  it('escucha error en el pool: el corte de una conexión inactiva no tumba el proceso, y sale la línea', async () => {
    const { deps: d, seen } = deps(() => {
      for (const listener of seen.errorListeners) {
        listener(new Error('Connection terminated unexpectedly'));
      }
      return Promise.reject(serverError('57P01'));
    });
    const result = await migrateCommand(ENV, d);
    expect(seen.errorListeners).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toEqual({
      code: 'MIGRATION_FAILED',
      reason: '57P01',
      status: 'failed',
    });
  });

  it('PostgreSQL que no responde o rechaza una migración: salida 1, MIGRATION_FAILED con el código y, si la rechazó, el archivo; nunca el mensaje', async () => {
    const unavailable = deps(() => Promise.reject(serverError('ECONNREFUSED')));
    const refused = await migrateCommand(ENV, unavailable.deps);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.line)).toEqual({
      code: 'MIGRATION_FAILED',
      reason: 'ECONNREFUSED',
      status: 'failed',
    });
    expect(unavailable.seen.ended).toBe(true);

    const denied = deps(() =>
      Promise.reject(new MigrationApplyError('0003_z.sql', serverError('42501'))),
    );
    const rejected = await migrateCommand(ENV, denied.deps);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.line)).toEqual({
      code: 'MIGRATION_FAILED',
      migration: '0003_z.sql',
      reason: '42501',
      status: 'failed',
    });
    for (const line of [refused.line, rejected.line]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('permission denied');
    }
  });

  it('migraciones que no cuadran: salida 1, MIGRATION_INVALID con el motivo y el archivo', async () => {
    const { deps: d } = deps(() =>
      Promise.reject(
        new MigrationIntegrityError('migration_changed', '0002_w.sql', 'cambió de contenido'),
      ),
    );
    const result = await migrateCommand(ENV, d);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toEqual({
      code: 'MIGRATION_INVALID',
      migration: '0002_w.sql',
      reason: 'migration_changed',
      status: 'failed',
    });
  });
});

describe('migrate con ownerRole', () => {
  /** Un pool cuyo cliente anota cada consulta y responde sin filas. */
  function recordingPool(fail?: (text: string) => Error | undefined) {
    const queries: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: (text: string) => {
        queries.push(text);
        const error = fail?.(text);
        return error === undefined ? Promise.resolve({ rows: [] }) : Promise.reject(error);
      },
      release: () => undefined,
    });
    return { pool: { connect: () => Promise.resolve(client) } as never, queries };
  }

  it('toma el bloqueo de las migraciones y, dentro de la misma transacción, SET LOCAL ROLE antes de crear nada', async () => {
    const { pool, queries } = recordingPool();
    const result = await migrate(pool, { ownerRole: 'buoh_dueno' });
    expect(queries.slice(0, 3)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'SET LOCAL ROLE "buoh_dueno"',
    ]);
    expect(queries[3]).toMatch(/^CREATE TABLE IF NOT EXISTS buoh_schema_migrations/u);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(result.applied).toEqual(result.current);
  });

  it('un corte de la conexión durante la transacción no tumba el proceso: migrate falla con ese error y, al soltar el cliente, deja de escucharlo', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const queries: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: (text: string) => {
        queries.push(text);
        if (!text.startsWith('CREATE TABLE IF')) {
          return Promise.resolve({ rows: [] });
        }
        // Como pg: el socket avisa con `error` en el cliente, fuera de la consulta, y la consulta
        // en curso falla con ese error.
        return new Promise((_resolve, reject) => {
          setImmediate(() => {
            client.emit('error', lost);
            reject(lost);
          });
        });
      },
      release: () => undefined,
    });
    await expect(migrate({ connect: () => Promise.resolve(client) } as never)).rejects.toBe(lost);
    expect(client.listenerCount('error')).toBe(0);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('rechaza un ownerRole que no es un nombre de minúsculas, cifras y _, sin abrir la conexión', async () => {
    const { pool, queries } = recordingPool();
    await expect(migrate(pool, { ownerRole: 'buoh"; DROP' })).rejects.toThrow(TypeError);
    expect(queries).toEqual([]);
  });

  it('una migración rechazada sale como MigrationApplyError con su archivo, y la transacción se deshace aunque el ROLLBACK falle', async () => {
    let applied = 0;
    const { pool, queries } = recordingPool((text) => {
      if (text.startsWith('ROLLBACK')) {
        return new Error('conexión rota');
      }
      if (
        !text.startsWith('BEGIN') &&
        !text.startsWith('SELECT') &&
        !text.startsWith('CREATE TABLE IF') &&
        !text.startsWith('INSERT')
      ) {
        applied += 1;
        return applied === 2 ? serverError('42501') : undefined;
      }
      return undefined;
    });
    const rejection = migrate(pool);
    await expect(rejection).rejects.toBeInstanceOf(MigrationApplyError);
    await expect(rejection).rejects.toMatchObject({ migration: '0002_log_raw_first.sql' });
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
