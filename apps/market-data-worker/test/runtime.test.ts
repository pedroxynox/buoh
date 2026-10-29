import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, openStores, type OperationalAlert } from '../src/index.js';

// `openStores` (src/runtime.ts) sin servicios: crear el pool de PostgreSQL y el cliente S3 no abre
// ninguna conexión, y la prueba emite en el pool el error de una conexión libre igual que pg-pool,
// que antes ya la descartó. Las credenciales, el host, el rol y la base son sintéticos.

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida.');
  });
  vi.stubGlobal('WebSocket', function forbidden() {
    throw new Error('El WebSocket global no está permitido.');
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const HOST = 'pg-sintetico.invalid';
const ROLE = 'rol_sintetico';
const DATABASE = 'base_sintetica';

const CONFIG = loadConfig({
  BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
  BUOH_POSTGRES_DB: DATABASE,
  BUOH_POSTGRES_HOST: HOST,
  BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
  BUOH_POSTGRES_SCHEMA: 'buoh_captura',
  BUOH_POSTGRES_USER: ROLE,
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
});

/**
 * El error de una conexión libre que PostgreSQL cerró, como lo emite pg-pool: el `DatabaseError`
 * del servidor, con su mensaje, su severidad y su código, y la conexión en `client`.
 */
function idleConnectionError() {
  const client = { database: DATABASE, host: HOST, port: 5432, user: ROLE };
  const error = Object.assign(
    new Error(
      `terminating connection due to administrator command (host ${HOST}, rol ${ROLE}, base ${DATABASE})`,
    ),
    { client, code: '57P01', severity: 'FATAL' },
  );
  return { client, error };
}

describe('openStores: una conexión libre de PostgreSQL que se pierde', () => {
  it('deja una sola alerta postgres_connection_lost con el código, sin el mensaje, la severidad ni la conexión, y no lanza', async () => {
    forbidAmbientEffects();
    const alerts: Parameters<OperationalAlert>[0][] = [];
    const stores = openStores(CONFIG, { alert: (payload) => alerts.push(payload) });
    try {
      const { client, error } = idleConnectionError();
      expect(() => stores.pool.emit('error', error, client)).not.toThrow();
      expect(alerts).toStrictEqual([{ event: 'postgres_connection_lost', reason: '57P01' }]);
      const written = JSON.stringify(alerts);
      for (const text of [error.message, 'FATAL', HOST, ROLE, DATABASE]) {
        expect(written).not.toContain(text);
      }
    } finally {
      await stores.close();
    }
  });

  it('sin alerta inyectada, la escribe en stderr como una línea JSON', async () => {
    forbidAmbientEffects();
    const stores = openStores(CONFIG);
    try {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { client, error } = idleConnectionError();
      stores.pool.emit('error', error, client);
      const calls = write.mock.calls.map(([chunk]) => chunk);
      write.mockRestore();
      expect(calls).toStrictEqual(['{"event":"postgres_connection_lost","reason":"57P01"}\n']);
    } finally {
      await stores.close();
    }
  });
});
