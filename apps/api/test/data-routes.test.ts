import { apiErrorSchema, dataHealthSchema, type DataHealth } from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import type { DataReader } from '../src/data/reader.js';
import { apiRoutes } from '../src/routes.js';
import {
  EXPECTED_JSON_HEADERS,
  routeDeps,
  testApp,
  testRequestId,
  useDeterminismGuards,
} from './support.js';

// La salud de los datos (ADR-0019 §8): `GET /api/v1/datos/salud` con un lector y un servicio de
// sesiones falsos. Necesita una sesión, renueva su inactividad solo con el token CSRF, responde
// `not_ready` sin la credencial de lectura y valida la salida con `DataHealth`. La lectura contra
// PostgreSQL está en integration/data.test.ts.
useDeterminismGuards();

const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const CSRF = 'a'.repeat(64);
const ACCOUNT = '01900000-0000-7000-8000-00000000a001';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: ACCOUNT,
  lastActivityMs: 0,
};
const COOKIE = { cookie: `${SESSION_COOKIE_NAME}=${SID}` };
const URL = '/api/v1/datos/salud';

const HEALTH: DataHealth = {
  log: 2,
  observation: {
    status: 'completed',
    observed_at_utc: '2026-11-04T12:55:31.204Z',
    report: {
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: 'connected',
      execution_mode: 'disabled',
      last_event_time_utc: '2026-11-04T12:55:29.000Z',
      last_observation_id: '01900000-0000-7000-8000-000000000001',
      last_published_dataset_id: null,
      last_received_at_utc: '2026-11-04T12:55:29.412Z',
      open_condition_types: [],
      schema_version: '1.0.0',
      service_health: 'healthy',
      source: 'deriv_options',
    },
  },
};

/** Las sesiones falsas: solo vale la cookie `SID`; anotan cada llamada. */
function fakeSessions(calls: string[]): SessionService {
  return {
    login: () => Promise.reject(new Error('sin inicio de sesión en esta prueba')),
    authenticate: (secret) => {
      calls.push('authenticate');
      return Promise.resolve(secret === SID ? SESSION : null);
    },
    renewActivity: () => {
      calls.push('renewActivity');
      return Promise.resolve();
    },
    logout: () => Promise.resolve(0),
    closeOthers: () => Promise.resolve(0),
    listAudit: () => Promise.resolve([]),
    csrfToken: () => CSRF,
    validateCsrf: (_secret, token) => token === CSRF,
    flushPendingFailures: () => Promise.resolve(),
  };
}

/** Una API con el lector `health`, o sin lector (`null`), y si tiene sus migraciones. */
function appWith(health: DataReader['health'] | null, ready = true) {
  const calls: string[] = [];
  const data: DataReader | null =
    health === null
      ? null
      : {
          health: () => {
            calls.push('health');
            return health();
          },
        };
  const built = testApp(
    apiRoutes(
      routeDeps({ readiness: { isReady: () => ready }, sessions: fakeSessions(calls), data }),
    ),
  );
  return { ...built, calls };
}

function expectError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
  for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
    expect(response.headers[name], name).toBe(value);
  }
}

describe('GET /api/v1/datos/salud (ADR-0019 §8)', () => {
  it('con sesión devuelve el log activo y su última observación, con las cabeceras del JSON y la cuenta en el registro', async () => {
    const { app, calls, lines } = appWith(() => Promise.resolve(HEALTH));
    const response = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expect(response.statusCode).toBe(200);
    expect(dataHealthSchema.parse(response.json())).toEqual(HEALTH);
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
    expect(calls).toEqual(['authenticate', 'health']);
    expect(lines).toEqual([
      {
        event: 'api_request',
        method: 'GET',
        route: URL,
        status: 200,
        duration_ms: 5,
        request_id: testRequestId(1),
        account_id: ACCOUNT,
      },
    ]);
  });

  it('también sin log activo, o sin observación todavía, y con una que falló', async () => {
    for (const health of [
      { log: null, observation: null },
      { log: 3, observation: null },
      {
        log: 3,
        observation: {
          status: 'failed',
          observed_at_utc: '2026-11-09T00:00:31.000Z',
          reason: 'child_timeout',
        },
      },
    ] satisfies DataHealth[]) {
      const { app } = appWith(() => Promise.resolve(health));
      const response = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(health);
    }
  });

  it('renueva la inactividad solo con el token CSRF: una actualización automática no', async () => {
    const plain = appWith(() => Promise.resolve(HEALTH));
    await plain.app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expect(plain.calls).toEqual(['authenticate', 'health']);

    const owner = appWith(() => Promise.resolve(HEALTH));
    await owner.app.inject({
      method: 'GET',
      url: URL,
      headers: { ...COOKIE, 'x-csrf-token': CSRF },
    });
    expect(owner.calls).toEqual(['authenticate', 'renewActivity', 'health']);

    const wrong = appWith(() => Promise.resolve(HEALTH));
    await wrong.app.inject({
      method: 'GET',
      url: URL,
      headers: { ...COOKIE, 'x-csrf-token': 'b'.repeat(64) },
    });
    expect(wrong.calls).toEqual(['authenticate', 'health']);
  });

  it('sin sesión responde unauthenticated sin leer nada, también sin la credencial de lectura', async () => {
    for (const health of [() => Promise.resolve(HEALTH), null]) {
      const { app, calls } = appWith(health);
      expectError(await app.inject({ method: 'GET', url: URL }), 401, 'unauthenticated');
      expectError(
        await app.inject({
          method: 'GET',
          url: URL,
          headers: { cookie: `${SESSION_COOKIE_NAME}=otra` },
        }),
        401,
        'unauthenticated',
      );
      expect(calls).not.toContain('health');
    }
  });

  it('sin la credencial de lectura responde not_ready, con la sesión ya comprobada', async () => {
    const { app, calls } = appWith(null);
    expectError(await app.inject({ method: 'GET', url: URL, headers: COOKIE }), 503, 'not_ready');
    expect(calls).toEqual(['authenticate']);
  });

  it('sin las migraciones de la API responde not_ready sin mirar la sesión', async () => {
    const { app, calls } = appWith(() => Promise.resolve(HEALTH), false);
    expectError(await app.inject({ method: 'GET', url: URL, headers: COOKIE }), 503, 'not_ready');
    expect(calls).toEqual([]);
  });

  it('si PostgreSQL no responde, postgres_unavailable con el código en el registro y nunca el mensaje', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED dpg-sintetico:5432'), {
      code: 'ECONNREFUSED',
    });
    const { app, lines } = appWith(() => Promise.reject(failure));
    const response = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expectError(response, 503, 'postgres_unavailable');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'ECONNREFUSED',
    });
    expect(JSON.stringify(lines)).not.toContain('dpg-sintetico');
    expect(response.body).not.toContain('dpg-sintetico');
  });

  it('un informe guardado sin su forma, o una salida que no cumple DataHealth, es internal', async () => {
    class StoredHealthError extends TypeError {
      override readonly name = 'StoredHealthError';
    }
    const stored = appWith(() => Promise.reject(new StoredHealthError('informe con datos')));
    const response = await stored.app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expectError(response, 500, 'internal');
    expect(stored.lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'StoredHealthError',
    });
    expect(response.body).not.toContain('informe con datos');

    // Una observación sin log activo no cumple el contrato.
    const invalid = appWith(() =>
      Promise.resolve({ log: null, observation: HEALTH.observation } as unknown as DataHealth),
    );
    expectError(
      await invalid.app.inject({ method: 'GET', url: URL, headers: COOKIE }),
      500,
      'internal',
    );
  });

  it('no admite parámetros de consulta', async () => {
    const { app, calls } = appWith(() => Promise.resolve(HEALTH));
    expectError(
      await app.inject({ method: 'GET', url: `${URL}?log=1`, headers: COOKIE }),
      400,
      'invalid_request',
    );
    expect(calls).not.toContain('health');
  });
});
