import { apiErrorSchema, auditEventSchema } from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import { LoginError, RateLimitedError } from '../src/accounts/errors.js';
import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { apiRoutes } from '../src/routes.js';
import { routeDeps, TEST_ORIGIN, testApp, testRequestId, useDeterminismGuards } from './support.js';

// Las rutas de las sesiones (ADR-0019 §2 y §5), con un servicio de sesiones falso: la autenticación
// por cookie, el token CSRF de las peticiones que cambian algo, la cookie del inicio y el cierre, la
// renovación de la actividad, la auditoría y la cuenta en el registro.
useDeterminismGuards();

/** El identificador de 32 bytes de la cookie (base64url). */
const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION_UUID = '01900000-0000-7000-8000-00000000b001';
const CSRF = 'a'.repeat(64);
const ACCOUNT = '01900000-0000-7000-8000-00000000a001';
const SESSION: AuthenticatedSession = {
  sessionId: SESSION_UUID,
  sessionSecret: SID,
  accountId: ACCOUNT,
  lastActivityMs: 0,
};
const PASSWORD = 'una contraseña larga de prueba';
const ADDRESS = '203.0.113.7';

interface FakeBehavior {
  readonly login?: SessionService['login'];
  readonly authenticate?: (sessionId: string | null) => Promise<AuthenticatedSession | null>;
  readonly events?: Awaited<ReturnType<SessionService['listAudit']>>;
}

function fakeSessions(behavior: FakeBehavior = {}) {
  const calls: { method: string; arg: unknown }[] = [];
  const service: SessionService = {
    login: (input) => {
      calls.push({ method: 'login', arg: input });
      return behavior.login?.(input) ?? Promise.resolve({ sessionSecret: SID, csrfToken: CSRF });
    },
    authenticate: (sessionId) => {
      calls.push({ method: 'authenticate', arg: sessionId });
      return (
        behavior.authenticate?.(sessionId) ?? Promise.resolve(sessionId === SID ? SESSION : null)
      );
    },
    renewActivity: (session) => {
      calls.push({ method: 'renewActivity', arg: session });
      return Promise.resolve();
    },
    logout: (input) => {
      calls.push({ method: 'logout', arg: input });
      return Promise.resolve(1);
    },
    closeOthers: (input) => {
      calls.push({ method: 'closeOthers', arg: input });
      return Promise.resolve(3);
    },
    listAudit: (session) => {
      calls.push({ method: 'listAudit', arg: session });
      return Promise.resolve(behavior.events ?? []);
    },
    csrfToken: () => CSRF,
    validateCsrf: (_sessionId, token) => token === CSRF,
    flushPendingFailures: () => Promise.resolve(),
  };
  return { service, calls };
}

function appWith(behavior: FakeBehavior = {}, rateLimit: (address: string) => number = () => 0) {
  const { service, calls } = fakeSessions(behavior);
  const built = testApp(apiRoutes(routeDeps({ sessions: service })), rateLimit);
  return { ...built, calls };
}

const JSON_HEADERS = { origin: TEST_ORIGIN, 'content-type': 'application/json' } as const;

function inject(
  app: ReturnType<typeof testApp>['app'],
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  headers: Record<string, string | undefined>,
  payload?: string,
) {
  const defined = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return app.inject({
    method,
    url,
    headers: defined,
    ...(payload === undefined ? {} : { payload }),
  });
}

function expectError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
}

describe('POST /api/v1/sesion (inicio de sesión)', () => {
  const body = JSON.stringify({ username: 'pedro', password: PASSWORD, code: '123456' });

  it('inicia sesión: pasa los datos y la dirección, pone la cookie y devuelve el token CSRF', async () => {
    const { app, calls, lines } = appWith();
    const response = await inject(
      app,
      'POST',
      '/api/v1/sesion',
      {
        ...JSON_HEADERS,
        'x-forwarded-for': `10.0.0.1, ${ADDRESS}`,
      },
      body,
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ csrf_token: CSRF });
    expect(response.headers['set-cookie']).toBe(
      `${SESSION_COOKIE_NAME}=${SID}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(calls).toEqual([
      {
        method: 'login',
        arg: {
          username: 'pedro',
          password: PASSWORD,
          code: '123456',
          address: ADDRESS,
          requestId: testRequestId(1),
        },
      },
    ]);
    // Ni la contraseña ni la cookie llegan al registro.
    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
    expect(JSON.stringify(lines)).not.toContain(SID);
  });

  it('traduce los fallos del inicio de sesión a sus códigos', async () => {
    expectError(
      await inject(
        appWith({ login: () => Promise.reject(new LoginError('invalid_credentials')) }).app,
        'POST',
        '/api/v1/sesion',
        JSON_HEADERS,
        body,
      ),
      401,
      'invalid_credentials',
    );
    expectError(
      await inject(
        appWith({ login: () => Promise.reject(new LoginError('credential_disabled')) }).app,
        'POST',
        '/api/v1/sesion',
        JSON_HEADERS,
        body,
      ),
      403,
      'credential_disabled',
    );
    const limited = await inject(
      appWith({ login: () => Promise.reject(new RateLimitedError(42)) }).app,
      'POST',
      '/api/v1/sesion',
      JSON_HEADERS,
      body,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: 'rate_limited', request_id: testRequestId(1), retry_after_seconds: 42 },
    });
  });

  it('sin el origen propio responde csrf_rejected sin iniciar sesión', async () => {
    const { app, calls } = appWith();
    expectError(
      await inject(
        app,
        'POST',
        '/api/v1/sesion',
        { ...JSON_HEADERS, origin: 'https://otro-sitio.example' },
        body,
      ),
      403,
      'csrf_rejected',
    );
    expect(calls).toEqual([]);
  });
});

describe('GET /api/v1/sesion (token CSRF)', () => {
  it('sin cookie válida responde unauthenticated', async () => {
    expectError(await inject(appWith().app, 'GET', '/api/v1/sesion', {}), 401, 'unauthenticated');
  });

  it('con cookie válida devuelve el token, renueva la actividad y deja la cuenta en el registro', async () => {
    const { app, calls, lines } = appWith();
    const response = await inject(app, 'GET', '/api/v1/sesion', {
      cookie: `${SESSION_COOKIE_NAME}=${SID}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ csrf_token: CSRF });
    expect(calls.map((call) => call.method)).toEqual(['authenticate', 'renewActivity']);
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'api_request',
        route: '/api/v1/sesion',
        account_id: ACCOUNT,
      }),
    );
  });
});

describe('DELETE /api/v1/sesion (cerrar sesión)', () => {
  it('exige la cookie y el token CSRF, cierra la sesión y borra la cookie', async () => {
    // Sin cookie: unauthenticated.
    expectError(
      await inject(appWith().app, 'DELETE', '/api/v1/sesion', JSON_HEADERS, '{}'),
      401,
      'unauthenticated',
    );
    // Con cookie pero sin el token CSRF: csrf_rejected.
    expectError(
      await inject(
        appWith().app,
        'DELETE',
        '/api/v1/sesion',
        { ...JSON_HEADERS, cookie: `${SESSION_COOKIE_NAME}=${SID}` },
        '{}',
      ),
      403,
      'csrf_rejected',
    );
    // Con la cookie y el token: cierra y borra la cookie.
    const { app, calls } = appWith();
    const response = await inject(
      app,
      'DELETE',
      '/api/v1/sesion',
      { ...JSON_HEADERS, cookie: `${SESSION_COOKIE_NAME}=${SID}`, 'x-csrf-token': CSRF },
      '{}',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: 1 });
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(calls.some((call) => call.method === 'logout')).toBe(true);
  });
});

describe('DELETE /api/v1/sesiones (cerrar las demás)', () => {
  it('con la cookie y el token cierra las otras, renueva la actual y dice cuántas', async () => {
    const { app, calls } = appWith();
    const response = await inject(
      app,
      'DELETE',
      '/api/v1/sesiones',
      { ...JSON_HEADERS, cookie: `${SESSION_COOKIE_NAME}=${SID}`, 'x-csrf-token': CSRF },
      '{}',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: 3 });
    expect(calls.map((call) => call.method)).toEqual([
      'authenticate',
      'closeOthers',
      'renewActivity',
    ]);
  });
});

describe('GET /api/v1/auditoria', () => {
  const event = auditEventSchema.parse({
    schema_version: '1.0.0',
    audit_event_id: '01900000-0000-7000-8000-000000000001',
    occurred_at_utc: '2026-11-03T12:00:00.000Z',
    account_id: ACCOUNT,
    actor: 'account',
    action: 'session_started',
    reason: 'password_and_totp',
    objects: [{ kind: 'session', id: '01900000-0000-7000-8000-00000000b001' }],
    request_id: testRequestId(1),
  });

  it('sin cookie responde unauthenticated', async () => {
    expectError(
      await inject(appWith().app, 'GET', '/api/v1/auditoria', {}),
      401,
      'unauthenticated',
    );
  });

  it('devuelve las entradas de la cuenta; renueva solo con el token CSRF', async () => {
    const { app, calls } = appWith({ events: [event] });
    const plain = await inject(app, 'GET', '/api/v1/auditoria', {
      cookie: `${SESSION_COOKIE_NAME}=${SID}`,
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ events: [event] });
    // Sin el token CSRF (una actualización automática) no renueva.
    expect(calls.map((call) => call.method)).toEqual(['authenticate', 'listAudit']);

    const withToken = appWith({ events: [event] });
    await inject(withToken.app, 'GET', '/api/v1/auditoria', {
      cookie: `${SESSION_COOKIE_NAME}=${SID}`,
      'x-csrf-token': CSRF,
    });
    expect(withToken.calls.map((call) => call.method)).toEqual([
      'authenticate',
      'renewActivity',
      'listAudit',
    ]);
  });
});

describe('el límite general de peticiones', () => {
  it('responde rate_limited cuando el limitador lo pide, en cualquier ruta', async () => {
    const { app } = appWith({}, () => 7);
    const response = await app.inject({ method: 'GET', url: '/api/salud' });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'rate_limited', request_id: testRequestId(1), retry_after_seconds: 7 },
    });
  });
});
