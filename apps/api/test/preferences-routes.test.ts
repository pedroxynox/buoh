import {
  accountPreferencesSchema,
  apiErrorSchema,
  type AccountPreferences,
  type Theme,
} from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { PreferenceService } from '../src/accounts/preferences.js';
import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { apiRoutes } from '../src/routes.js';
import {
  EXPECTED_JSON_HEADERS,
  routeDeps,
  testApp,
  testRequestId,
  useDeterminismGuards,
} from './support.js';

// Las preferencias de la cuenta (ADR-0019 §7; F2-UI-001): `GET /api/v1/preferencias` y
// `POST /api/v1/preferencias`, con un servicio de preferencias y otro de sesiones falsos. Las dos
// necesitan una sesión; la lectura no renueva la inactividad sin el token CSRF, y el cambio exige el
// origen propio y el token, y la renueva. La lectura y la escritura contra PostgreSQL están en
// integration/preferences.test.ts.
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
const URL = '/api/v1/preferencias';
const ORIGIN = 'https://buoh.test';
/** Las cabeceras de una petición de la propia web que cambia algo (CSRF, ADR-0019 §2). */
const SAME_ORIGIN = {
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

/** Las sesiones falsas: solo vale la cookie `SID` y el token `CSRF`; anotan cada llamada. */
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

/** Unas preferencias en memoria, de una sola cuenta, que anotan qué cuenta las pide. */
function fakePreferences(calls: string[], initial: Theme = 'night'): PreferenceService {
  let theme = initial;
  return {
    get: (session) => {
      calls.push(`get:${session.accountId}`);
      return Promise.resolve({ theme });
    },
    set: (session, next) => {
      calls.push(`set:${session.accountId}:${next}`);
      theme = next;
      return Promise.resolve({ theme });
    },
  };
}

function appWith(
  options: { readonly ready?: boolean; readonly preferences?: PreferenceService } = {},
) {
  const calls: string[] = [];
  const built = testApp(
    apiRoutes(
      routeDeps({
        readiness: { isReady: () => options.ready ?? true },
        sessions: fakeSessions(calls),
        preferences: options.preferences ?? fakePreferences(calls),
      }),
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

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: URL,
  headers: { ...COOKIE, ...SAME_ORIGIN, 'x-csrf-token': CSRF, ...headers },
  payload: JSON.stringify(body),
});

describe('GET /api/v1/preferencias (ADR-0019 §7)', () => {
  it('con sesión devuelve las preferencias de su cuenta, sin renovar la inactividad', async () => {
    const { app, calls, lines } = appWith();
    const response = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expect(response.statusCode).toBe(200);
    expect(accountPreferencesSchema.parse(response.json())).toEqual({ theme: 'night' });
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
    expect(calls).toEqual(['authenticate', `get:${ACCOUNT}`]);
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

  it('con el token CSRF renueva la inactividad', async () => {
    const { app, calls } = appWith();
    await app.inject({ method: 'GET', url: URL, headers: { ...COOKIE, 'x-csrf-token': CSRF } });
    expect(calls).toEqual(['authenticate', 'renewActivity', `get:${ACCOUNT}`]);
  });

  it('sin sesión responde unauthenticated sin leer nada', async () => {
    const { app, calls } = appWith();
    expectError(await app.inject({ method: 'GET', url: URL }), 401, 'unauthenticated');
    expect(calls.filter((call) => !call.startsWith('authenticate'))).toEqual([]);
  });

  it('sin las migraciones de la API responde not_ready sin mirar la sesión', async () => {
    const { app, calls } = appWith({ ready: false });
    expectError(await app.inject({ method: 'GET', url: URL, headers: COOKIE }), 503, 'not_ready');
    expect(calls).toEqual([]);
  });

  it('si PostgreSQL no responde, postgres_unavailable con el código y sin el mensaje', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED dpg-sintetico:5432'), {
      code: 'ECONNREFUSED',
    });
    const { app, lines } = appWith({
      preferences: { get: () => Promise.reject(failure), set: () => Promise.reject(failure) },
    });
    const response = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expectError(response, 503, 'postgres_unavailable');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'ECONNREFUSED',
    });
    expect(JSON.stringify(lines)).not.toContain('dpg-sintetico');
  });

  it('una salida que no cumple AccountPreferences es internal', async () => {
    const { app } = appWith({
      preferences: {
        get: () => Promise.resolve({ theme: 'noche' } as unknown as AccountPreferences),
        set: () => Promise.reject(new Error('sin cambio')),
      },
    });
    expectError(await app.inject({ method: 'GET', url: URL, headers: COOKIE }), 500, 'internal');
  });

  it('no admite parámetros de consulta', async () => {
    const { app, calls } = appWith();
    expectError(
      await app.inject({ method: 'GET', url: `${URL}?theme=day`, headers: COOKIE }),
      400,
      'invalid_request',
    );
    expect(calls).toEqual([]);
  });
});

describe('POST /api/v1/preferencias (ADR-0019 §7)', () => {
  it('guarda el tema de la cuenta de la sesión, lo devuelve y renueva la inactividad', async () => {
    const { app, calls } = appWith();
    const response = await app.inject(post({ theme: 'day' }));
    expect(response.statusCode).toBe(200);
    expect(accountPreferencesSchema.parse(response.json())).toEqual({ theme: 'day' });
    expect(calls).toEqual(['authenticate', `set:${ACCOUNT}:day`, 'renewActivity']);
    const read = await app.inject({ method: 'GET', url: URL, headers: COOKIE });
    expect(read.json()).toEqual({ theme: 'day' });
  });

  it('sin el token CSRF, o con otro, responde csrf_rejected sin guardar nada', async () => {
    for (const token of [undefined, 'b'.repeat(64)]) {
      const { app, calls } = appWith();
      const request = post({ theme: 'day' });
      const headers: Record<string, string> = { ...request.headers };
      if (token === undefined) {
        delete headers['x-csrf-token'];
      } else {
        headers['x-csrf-token'] = token;
      }
      expectError(await app.inject({ ...request, headers }), 403, 'csrf_rejected');
      expect(calls).toEqual(['authenticate']);
    }
  });

  it('desde otro origen responde csrf_rejected antes de mirar la sesión', async () => {
    const { app, calls } = appWith();
    expectError(
      await app.inject(post({ theme: 'day' }, { origin: 'https://otro.test' })),
      403,
      'csrf_rejected',
    );
    expect(calls).toEqual([]);
  });

  it('sin sesión responde unauthenticated sin guardar nada', async () => {
    const { app, calls } = appWith();
    const request = post({ theme: 'day' });
    const headers: Record<string, string> = { ...request.headers };
    delete headers['cookie'];
    expectError(await app.inject({ ...request, headers }), 401, 'unauthenticated');
    expect(calls.filter((call) => !call.startsWith('authenticate'))).toEqual([]);
  });

  it('un tema que no existe, uno en español, un campo de más o un cuerpo vacío son invalid_request', async () => {
    for (const body of [{ theme: 'sepia' }, { theme: 'dia' }, { theme: 'day', extra: 1 }, {}]) {
      const { app, calls } = appWith();
      expectError(await app.inject(post(body)), 400, 'invalid_request');
      expect(calls).not.toContain(`set:${ACCOUNT}:day`);
    }
  });

  it('sin las migraciones de la API responde not_ready sin guardar nada', async () => {
    const { app, calls } = appWith({ ready: false });
    expectError(await app.inject(post({ theme: 'day' })), 503, 'not_ready');
    expect(calls).toEqual([]);
  });
});
