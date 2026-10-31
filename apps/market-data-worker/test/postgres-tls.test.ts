import type * as PgModule from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigError,
  createPool,
  loadConfig,
  postgresSslOption,
  SourceLock,
  type WorkerConfig,
} from '../src/index.js';

/** La configuración con la que se crea cada pool y cada cliente de PostgreSQL, en orden. */
const created = vi.hoisted(() => ({ clients: [] as unknown[], pools: [] as unknown[] }));

// El pool real, que anota su configuración, y un cliente que la anota y no conecta: así la prueba no
// abre ninguna conexión.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof PgModule>();
  class RecordingPool extends actual.default.Pool {
    constructor(config?: ConstructorParameters<typeof actual.default.Pool>[0]) {
      created.pools.push(config);
      super(config);
    }
  }
  class RecordingClient extends actual.default.Client {
    constructor(config?: ConstructorParameters<typeof actual.default.Client>[0]) {
      created.clients.push(config);
      super(config);
    }

    override connect(): Promise<never> {
      return Promise.reject(Object.assign(new Error('sin red'), { code: 'ECONNREFUSED' }));
    }
  }
  return {
    ...actual,
    default: { ...actual.default, Client: RecordingClient, Pool: RecordingPool },
  };
});

afterEach(() => {
  created.clients.length = 0;
  created.pools.length = 0;
});

// El cifrado de la conexión a PostgreSQL (ADR-0018 §9), sin servidor: lo que reciben `pg.Pool` y
// `pg.Client`. Que `require` no conecte sin cifrar a un servidor sin TLS lo comprueba
// integration/roles.test.ts. Las credenciales y el host son sintéticos.

const BASE = {
  BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
  BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
};

/** El `ConfigError` con que falla `loadConfig(env)`; la prueba falla si no lanza uno. */
function configErrorOf(env: Readonly<Record<string, string | undefined>>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('loadConfig no lanzó ConfigError.');
}

describe('BUOH_POSTGRES_SSLMODE en loadConfig (ADR-0018 §9)', () => {
  it('fuera de un despliegue es disable por defecto, y admite require y verify-full', () => {
    for (const environment of ['development', 'test']) {
      const env = { ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: environment };
      expect(loadConfig(env).postgres.sslMode).toBe('disable');
      for (const mode of ['disable', 'require', 'verify-full'] as const) {
        expect(loadConfig({ ...env, BUOH_POSTGRES_SSLMODE: mode }).postgres.sslMode).toBe(mode);
      }
    }
  });

  it('en production y staging es obligatoria y no admite disable: ConfigError con el nombre de la variable, sin su valor', () => {
    for (const environment of ['production', 'staging']) {
      const env = { ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: environment };
      for (const sslMode of [undefined, 'disable']) {
        const error = configErrorOf(
          sslMode === undefined ? env : { ...env, BUOH_POSTGRES_SSLMODE: sslMode },
        );
        expect(error.variables).toEqual(['BUOH_POSTGRES_SSLMODE']);
        expect(error.message).not.toContain('disable');
      }
      for (const mode of ['require', 'verify-full'] as const) {
        expect(loadConfig({ ...env, BUOH_POSTGRES_SSLMODE: mode }).postgres.sslMode).toBe(mode);
      }
    }
  });

  it('un valor desconocido es un ConfigError, y se nombra junto con las demás variables rechazadas', () => {
    expect(
      configErrorOf({
        ...BASE,
        BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
        BUOH_POSTGRES_SSLMODE: 'prefer',
      }).variables,
    ).toEqual(['BUOH_POSTGRES_SSLMODE']);
    expect(
      configErrorOf({
        BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
        BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
      }).variables,
    ).toEqual(['BUOH_POSTGRES_SSLMODE', 'BUOH_S3_ACCESS_KEY_ID', 'BUOH_S3_SECRET_ACCESS_KEY']);
  });
});

describe('la opción ssl de pg en cada modo', () => {
  it('disable no cifra, require cifra sin verificar el certificado y verify-full lo verifica; siempre explícita, para que pg no lea PGSSLMODE', () => {
    expect(postgresSslOption('disable')).toEqual({ ssl: false });
    expect(postgresSslOption('require')).toEqual({ ssl: { rejectUnauthorized: false } });
    expect(postgresSslOption('verify-full')).toEqual({ ssl: true });
  });

  it('createPool y el cliente del bloqueo de la fuente (SourceLock.acquire) la aplican', async () => {
    const postgres = (sslMode: WorkerConfig['postgres']['sslMode']): WorkerConfig['postgres'] =>
      loadConfig({
        ...BASE,
        BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
        BUOH_POSTGRES_SSLMODE: sslMode,
      }).postgres;
    for (const mode of ['require', 'verify-full'] as const) {
      const pool = createPool(postgres(mode));
      await pool.end();
      await expect(
        SourceLock.acquire({ postgres: postgres(mode), source: 'synthetic' }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
    const local = loadConfig({ ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
    const pool = createPool(local);
    await pool.end();
    expect(created.pools).toEqual([
      expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
      expect.objectContaining({ ssl: true }),
      expect.objectContaining({ ssl: false }),
    ]);
    expect(created.clients).toEqual([
      expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
      expect.objectContaining({ ssl: true }),
    ]);
  });
});
