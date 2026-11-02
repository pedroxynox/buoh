import { describe, expect, it } from 'vitest';

import { migrateCommand, type MigrateCommandDeps } from '../src/migrate-command.js';
import type { PostgresConfig } from '../src/postgres/config.js';
import { MigrationApplyError, MigrationIntegrityError } from '../src/postgres/migrate.js';

// `db:migrate` de la API (ADR-0019 §7) sin PostgreSQL: un pool falso. Su línea tiene la forma de la
// del worker, la que lee `buoh-operaciones`, y sus errores salen saneados: un código o un nombre,
// nunca el mensaje, que puede llevar el rol, la base o el servidor.

const SECRET = 'contraseña-sintética-que-no-sale-77d1';
const HOST = 'dpg-servidor-sintetico';
const ENV = { BUOH_DEPLOYMENT_ENVIRONMENT: 'test', BUOH_POSTGRES_PASSWORD: SECRET };
const PRODUCTION = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_HOST: HOST,
  BUOH_POSTGRES_OWNER_ROLE: 'buoh_dueno',
  BUOH_POSTGRES_PASSWORD: SECRET,
  BUOH_POSTGRES_SSLMODE: 'require',
  BUOH_POSTGRES_USER: 'buoh',
};

/** Las piezas del comando, con un pool que anota si se cerró y quién escucha sus errores. */
function deps(run: MigrateCommandDeps['migrate']) {
  const seen: {
    ended: boolean;
    errorListeners: number;
    options: unknown;
    postgres: PostgresConfig | null;
  } = { ended: false, errorListeners: 0, options: null, postgres: null };
  const value: MigrateCommandDeps = {
    createPool: (postgres) => {
      seen.postgres = postgres;
      return {
        connect: () => Promise.reject(new Error('no se usa')),
        end: () => {
          seen.ended = true;
          return Promise.resolve();
        },
        on: () => {
          seen.errorListeners += 1;
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
  Object.assign(new Error(`permission denied, role "buoh", host ${HOST}, password ${SECRET}`), {
    code,
    name: 'error',
  });

function expectSanitized(line: string): void {
  for (const value of [SECRET, HOST, 'permission denied', 'buoh_dueno']) {
    expect(line).not.toContain(value);
  }
}

describe('migrateCommand', () => {
  it('aplica las migraciones y escribe una línea JSON: salida 0, status migrated', async () => {
    const { deps: d, seen } = deps(() =>
      Promise.resolve({ applied: ['0001_auditoria.sql'], current: ['0001_auditoria.sql'] }),
    );
    const result = await migrateCommand(ENV, d);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.line)).toEqual({
      applied: ['0001_auditoria.sql'],
      current: ['0001_auditoria.sql'],
      status: 'migrated',
    });
    expect(seen.options).toEqual({});
    expect(seen.ended).toBe(true);
    expect(seen.errorListeners).toBe(1);
  });

  it('en production migra como BUOH_POSTGRES_OWNER_ROLE, con la conexión cifrada', async () => {
    const { deps: d, seen } = deps(() => Promise.resolve({ applied: [], current: [] }));
    const result = await migrateCommand(PRODUCTION, d);
    expect(result.exitCode).toBe(0);
    expect(seen.options).toEqual({ ownerRole: 'buoh_dueno' });
    expect(seen.postgres).toEqual({
      database: 'buoh',
      host: HOST,
      password: SECRET,
      port: 5432,
      sslMode: 'require',
      user: 'buoh',
    });
  });

  it('una configuración inválida es la salida 2, con los nombres de las variables y sin abrir el pool', async () => {
    for (const [env, variables] of [
      [{ ...PRODUCTION, BUOH_POSTGRES_OWNER_ROLE: undefined }, ['BUOH_POSTGRES_OWNER_ROLE']],
      [{ ...PRODUCTION, BUOH_POSTGRES_SSLMODE: 'disable' }, ['BUOH_POSTGRES_SSLMODE']],
      [{ ...ENV, BUOH_POSTGRES_OWNER_ROLE: 'buoh"; DROP' }, ['BUOH_POSTGRES_OWNER_ROLE']],
      [
        { BUOH_DEPLOYMENT_ENVIRONMENT: 'production', BUOH_POSTGRES_PORT: SECRET },
        [
          'BUOH_POSTGRES_OWNER_ROLE',
          'BUOH_POSTGRES_PASSWORD',
          'BUOH_POSTGRES_PORT',
          'BUOH_POSTGRES_SSLMODE',
        ],
      ],
      [{ ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: 'staging' }, ['BUOH_DEPLOYMENT_ENVIRONMENT']],
    ] as const) {
      const { deps: d, seen } = deps(() => Promise.reject(new Error('no se migra')));
      const result = await migrateCommand(env, d);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.line)).toEqual({
        code: 'ConfigError',
        message: `Configuración inválida o ausente: ${variables.join(', ')}.`,
        status: 'failed',
      });
      expect(seen.postgres).toBeNull();
      expectSanitized(result.line);
    }
  });

  it('PostgreSQL que no responde o rechaza una migración: salida 1, MIGRATION_FAILED con el código y, si la rechazó, el archivo; nunca el mensaje', async () => {
    for (const [error, expected] of [
      [serverError('28P01'), { code: 'MIGRATION_FAILED', reason: '28P01', status: 'failed' }],
      [
        Object.assign(new Error(`connect ECONNREFUSED ${HOST}:5432`), { code: 'ECONNREFUSED' }),
        { code: 'MIGRATION_FAILED', reason: 'ECONNREFUSED', status: 'failed' },
      ],
      [
        new Error(`The server does not support SSL connections (${HOST})`),
        { code: 'MIGRATION_FAILED', reason: 'Error', status: 'failed' },
      ],
      [
        new MigrationApplyError('0001_auditoria.sql', serverError('42501')),
        {
          code: 'MIGRATION_FAILED',
          migration: '0001_auditoria.sql',
          reason: '42501',
          status: 'failed',
        },
      ],
    ] as const) {
      const { deps: d, seen } = deps(() => Promise.reject(error));
      const result = await migrateCommand(ENV, d);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.line)).toEqual(expected);
      expect(seen.ended).toBe(true);
      expectSanitized(result.line);
    }
  });

  it('migraciones que no cuadran: salida 1, MIGRATION_INVALID con el motivo y el archivo', async () => {
    const { deps: d } = deps(() =>
      Promise.reject(new MigrationIntegrityError('migration_changed', '0001_auditoria.sql')),
    );
    const result = await migrateCommand(ENV, d);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toEqual({
      code: 'MIGRATION_INVALID',
      migration: '0001_auditoria.sql',
      reason: 'migration_changed',
      status: 'failed',
    });
  });
});
