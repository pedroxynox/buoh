import { describe, expect, it } from 'vitest';

import { ApiConfigError } from '../src/config.js';
import { API_SCHEMA, loadPostgresConfig } from '../src/postgres/config.js';
import { isPostgresUnavailable } from '../src/postgres/errors.js';
import {
  createPool,
  POOL_MAX_CONNECTIONS,
  postgresSslOption,
  SERVICE_POOL_TIMEOUTS,
} from '../src/postgres/pool.js';

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

describe('createPool con los plazos del servicio', () => {
  const config = {
    database: 'buoh',
    host: '127.0.0.1',
    password: SECRET,
    port: 5432,
    sslMode: 'require',
    user: 'buoh_api',
  } as const;

  it('la API y la orden cuenta esperan una conexión 5 s, una consulta 10 s y una transacción parada 30 s', async () => {
    expect(SERVICE_POOL_TIMEOUTS).toEqual({
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    const pool = createPool(config, SERVICE_POOL_TIMEOUTS);
    try {
      expect(pool.options).toMatchObject({
        connectionTimeoutMillis: 5000,
        statement_timeout: 10_000,
        idle_in_transaction_session_timeout: 30_000,
        max: 3,
      });
    } finally {
      await pool.end();
    }
  });

  it('db:migrate no lleva esos plazos: su bloqueo puede esperar a otra migración', async () => {
    const pool = createPool(config);
    try {
      expect(pool.options).not.toHaveProperty('statement_timeout');
      expect(pool.options).not.toHaveProperty('connectionTimeoutMillis');
    } finally {
      await pool.end();
    }
  });
});

describe('isPostgresUnavailable', () => {
  const coded = (code: string) => Object.assign(new Error(`mensaje con datos ${code}`), { code });

  it('reconoce que PostgreSQL no responde: la red, la conexión, la autenticación y la parada del servidor', () => {
    for (const code of [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      '08006',
      '08001',
      '28P01',
      '28000',
      '53300',
      '57P01',
      '57P02',
      '57P03',
      '57014',
    ]) {
      expect(isPostgresUnavailable(coded(code)), code).toBe(true);
    }
    for (const message of [
      'Connection terminated',
      'Connection terminated unexpectedly',
      'Client has encountered a connection error and is not queryable',
      'Client was closed and is not queryable',
      'Query read timeout',
      'timeout exceeded when trying to connect',
      'timeout expired',
      'The server does not support SSL connections',
    ]) {
      expect(isPostgresUnavailable(new Error(message)), message).toBe(true);
    }
  });

  it('no confunde con eso un error de la consulta ni un fallo propio', () => {
    for (const code of ['42501', '23505', '22P02', '42P01', '23001', 'E_PROPIO']) {
      expect(isPostgresUnavailable(coded(code)), code).toBe(false);
    }
    for (const error of [new Error('otra cosa'), new TypeError('x'), 'ECONNREFUSED', null]) {
      expect(isPostgresUnavailable(error)).toBe(false);
    }
  });
});
