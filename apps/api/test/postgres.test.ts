import { describe, expect, it } from 'vitest';

import { ApiConfigError } from '../src/config.js';
import { API_SCHEMA, loadPostgresConfig } from '../src/postgres/config.js';
import { createPool, POOL_MAX_CONNECTIONS, postgresSslOption } from '../src/postgres/pool.js';

// La conexión de la API a PostgreSQL (ADR-0019 §7): cifrada en `production`, con un pool de 3 sobre
// el esquema `buoh_api`, y errores de configuración con nombres, nunca valores.

const SECRET = 'contraseña-sintética-3c81e0';

function rejected(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadPostgresConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigError) {
      expect(error.message).not.toContain(SECRET);
      return error.variables;
    }
    throw error;
  }
  throw new Error('La configuración no se rechazó.');
}

describe('loadPostgresConfig', () => {
  it('fuera de production usa los servicios locales, sin cifrado, salvo la contraseña', () => {
    for (const environment of ['development', 'test'] as const) {
      expect(
        loadPostgresConfig({
          BUOH_DEPLOYMENT_ENVIRONMENT: environment,
          BUOH_POSTGRES_PASSWORD: SECRET,
        }),
      ).toEqual({
        environment,
        postgres: {
          database: 'buoh',
          host: '127.0.0.1',
          password: SECRET,
          port: 5432,
          sslMode: 'disable',
          user: 'buoh',
        },
      });
    }
  });

  it('en production toma cada valor de su variable y exige cifrado', () => {
    const env = {
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'dpg-sintetico',
      BUOH_POSTGRES_PASSWORD: SECRET,
      BUOH_POSTGRES_PORT: '6543',
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: 'buoh_api',
    };
    expect(loadPostgresConfig(env).postgres).toEqual({
      database: 'buoh',
      host: 'dpg-sintetico',
      password: SECRET,
      port: 6543,
      sslMode: 'require',
      user: 'buoh_api',
    });
    expect(rejected({ ...env, BUOH_POSTGRES_SSLMODE: undefined })).toEqual([
      'BUOH_POSTGRES_SSLMODE',
    ]);
    expect(rejected({ ...env, BUOH_POSTGRES_SSLMODE: 'disable' })).toEqual([
      'BUOH_POSTGRES_SSLMODE',
    ]);
    expect(
      loadPostgresConfig({ ...env, BUOH_POSTGRES_SSLMODE: 'verify-full' }).postgres.sslMode,
    ).toBe('verify-full');
  });

  it('rechaza staging, un cifrado desconocido, un puerto que no es de 1 a 65535 y la falta de la contraseña', () => {
    const base = { BUOH_DEPLOYMENT_ENVIRONMENT: 'test', BUOH_POSTGRES_PASSWORD: SECRET };
    expect(rejected({ ...base, BUOH_DEPLOYMENT_ENVIRONMENT: 'staging' })).toEqual([
      'BUOH_DEPLOYMENT_ENVIRONMENT',
    ]);
    expect(rejected({ ...base, BUOH_POSTGRES_SSLMODE: 'prefer' })).toEqual([
      'BUOH_POSTGRES_SSLMODE',
    ]);
    for (const port of ['0', '65536', '080', ' 5432', 'abc', '']) {
      expect(rejected({ ...base, BUOH_POSTGRES_PORT: port }), port).toEqual(['BUOH_POSTGRES_PORT']);
    }
    expect(rejected({ BUOH_DEPLOYMENT_ENVIRONMENT: 'test' })).toEqual(['BUOH_POSTGRES_PASSWORD']);
  });

  it('nombra todas las variables rechazadas, ordenadas, sin sus valores', () => {
    expect(
      rejected({
        BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
        BUOH_POSTGRES_HOST: '',
        BUOH_POSTGRES_PORT: SECRET,
      }),
    ).toEqual([
      'BUOH_POSTGRES_HOST',
      'BUOH_POSTGRES_PASSWORD',
      'BUOH_POSTGRES_PORT',
      'BUOH_POSTGRES_SSLMODE',
    ]);
  });
});

describe('createPool', () => {
  it('abre como mucho 3 conexiones, sobre el esquema buoh_api, con el cifrado de su modo', async () => {
    expect(POOL_MAX_CONNECTIONS).toBe(3);
    const pool = createPool({
      database: 'buoh',
      host: '127.0.0.1',
      password: SECRET,
      port: 5432,
      sslMode: 'require',
      user: 'buoh_api',
    });
    try {
      expect(pool.options).toMatchObject({
        database: 'buoh',
        host: '127.0.0.1',
        max: 3,
        options: `-c search_path=${API_SCHEMA}`,
        port: 5432,
        ssl: { rejectUnauthorized: false },
        user: 'buoh_api',
      });
    } finally {
      await pool.end();
    }
  });

  it('nunca deja el cifrado a PGSSLMODE: disable no cifra, require no verifica y verify-full verifica', () => {
    expect(API_SCHEMA).toBe('buoh_api');
    expect(postgresSslOption('disable')).toEqual({ ssl: false });
    expect(postgresSslOption('require')).toEqual({ ssl: { rejectUnauthorized: false } });
    expect(postgresSslOption('verify-full')).toEqual({ ssl: true });
  });
});
