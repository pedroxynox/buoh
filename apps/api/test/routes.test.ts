import { apiErrorSchema, type LinkSecret } from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import { LinkError, PasswordRejectedError } from '../src/accounts/errors.js';
import type { LinkService } from '../src/accounts/service.js';
import { PasswordHasherBusyError } from '../src/auth/password-hash.js';
import { API_ROUTE_SPECS, apiRoutes } from '../src/routes.js';
import {
  EXPECTED_JSON_HEADERS,
  routeDeps,
  TEST_ORIGIN,
  testApp,
  testRequestId,
  useDeterminismGuards,
} from './support.js';

// Las rutas de los enlaces (ADR-0019 §2, §3 y §6) y la espera de la API (§7), con un servicio de
// cuentas falso: su contrato HTTP, la protección contra CSRF sin sesión y los códigos de error.
useDeterminismGuards();

const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PASSWORD = 'una contraseña larga de prueba 9f2c';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRET_RESPONSE: LinkSecret = {
  purpose: 'enrollment',
  username: 'pedro',
  expires_at_utc: '2026-11-03T12:15:00.000Z',
  totp: {
    secret: TOTP_SECRET,
    uri: `otpauth://totp/buoh:pedro?secret=${TOTP_SECRET}&issuer=buoh&algorithm=SHA1&digits=6&period=30`,
  },
};

/** Un servicio de cuentas falso que guarda lo que recibe y responde lo que le dice la prueba. */
function fakeLinks(behavior: {
  readonly issueSecret?: () => Promise<LinkSecret>;
  readonly useLink?: () => Promise<{ result: 'account_enrolled' | 'credential_reset' }>;
}) {
  const calls: { method: string; input: unknown }[] = [];
  const links: LinkService = {
    issueSecret: (input) => {
      calls.push({ method: 'issueSecret', input });
      return behavior.issueSecret?.() ?? Promise.resolve(SECRET_RESPONSE);
    },
    useLink: (input) => {
      calls.push({ method: 'useLink', input });
      return behavior.useLink?.() ?? Promise.resolve({ result: 'account_enrolled' });
    },
  };
  return { links, calls };
}

function appWith(
  behavior: Parameters<typeof fakeLinks>[0] = {},
  ready = true,
): ReturnType<typeof testApp> & { calls: ReturnType<typeof fakeLinks>['calls'] } {
  const { links, calls } = fakeLinks(behavior);
  const built = testApp(apiRoutes(routeDeps({ readiness: { isReady: () => ready }, links })));
  return { ...built, calls };
}

const SAME_ORIGIN = {
  origin: TEST_ORIGIN,
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

function post(
  app: ReturnType<typeof testApp>['app'],
  url: string,
  body: unknown,
  headers: Record<string, string | undefined> = SAME_ORIGIN,
) {
  const defined = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return app.inject({
    method: 'POST',
    url,
    headers: defined,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function expectError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
  for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
    expect(response.headers[name], name).toBe(value);
  }
}

describe('la tabla de rutas', () => {
  it('sirve exactamente las rutas del OpenAPI, en su orden', () => {
    const { links } = fakeLinks({});
    const served = apiRoutes(routeDeps({ readiness: { isReady: () => true }, links }));
    const withoutHandlers = served.map((route) =>
      Object.fromEntries(Object.entries(route).filter(([key]) => key !== 'handler')),
    );
    expect(withoutHandlers).toEqual(API_ROUTE_SPECS);
    expect(API_ROUTE_SPECS.map((route) => `${route.method} ${route.url}`)).toEqual([
      'GET /api/salud',
      'POST /api/v1/enlace/secreto',
      'POST /api/v1/enlace',
      'POST /api/v1/sesion',
      'GET /api/v1/sesion',
      'DELETE /api/v1/sesion',
      'DELETE /api/v1/sesiones',
      'GET /api/v1/auditoria',
      'GET /api/v1/datos/salud',
      'GET /api/v1/datos/eventos',
      'GET /api/v1/datos/grafico',
      'GET /api/v1/datos/catalogo',
    ]);
  });
});

describe('GET /api/salud y la espera de las migraciones', () => {
  it('responde 503 not_ready mientras faltan las migraciones, y 200 cuando están', async () => {
    expectError(
      await appWith({}, false).app.inject({ method: 'GET', url: '/api/salud' }),
      503,
      'not_ready',
    );
    const ready = await appWith({}, true).app.inject({ method: 'GET', url: '/api/salud' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });
  });

  it('sin migraciones, las rutas de los enlaces responden not_ready sin llamar al servicio', async () => {
    const { app, calls } = appWith({}, false);
    expectError(await post(app, '/api/v1/enlace/secreto', { token: TOKEN }), 503, 'not_ready');
    expectError(
      await post(app, '/api/v1/enlace', { token: TOKEN, password: PASSWORD, code: '123456' }),
      503,
      'not_ready',
    );
    expect(calls).toEqual([]);
  });
});

describe('CSRF sin sesión: Origin, Sec-Fetch-Site y Content-Type (ADR-0019 §2)', () => {
  it.each([
    ['sin Origin', { ...SAME_ORIGIN, origin: undefined }],
    ['con otro Origin', { ...SAME_ORIGIN, origin: 'https://otro-sitio.example' }],
    ['con Origin null', { ...SAME_ORIGIN, origin: 'null' }],
    ['con el origen con otra barra', { ...SAME_ORIGIN, origin: `${TEST_ORIGIN}/` }],
    ['con el origen en http', { ...SAME_ORIGIN, origin: TEST_ORIGIN.replace('https', 'http') }],
    ['con Sec-Fetch-Site cross-site', { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['con Sec-Fetch-Site same-site', { ...SAME_ORIGIN, 'sec-fetch-site': 'same-site' }],
    ['con Sec-Fetch-Site none', { ...SAME_ORIGIN, 'sec-fetch-site': 'none' }],
    ['sin Content-Type', { ...SAME_ORIGIN, 'content-type': undefined }],
    ['con text/plain', { ...SAME_ORIGIN, 'content-type': 'text/plain' }],
    ['con un formulario', { ...SAME_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }],
    ['con multipart', { ...SAME_ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }],
    ['con otro tipo JSON', { ...SAME_ORIGIN, 'content-type': 'application/json-patch+json' }],
    [
      'con otro juego de caracteres',
      { ...SAME_ORIGIN, 'content-type': 'application/json; charset=latin1' },
    ],
  ] as const)('%s responde 403 csrf_rejected sin llamar al servicio', async (_name, headers) => {
    const { app, calls, lines } = appWith();
    for (const url of ['/api/v1/enlace/secreto', '/api/v1/enlace']) {
      const response = await post(
        app,
        url,
        { token: TOKEN, password: PASSWORD, code: '123456' },
        headers,
      );
      expectError(response, 403, 'csrf_rejected');
    }
    expect(calls).toEqual([]);
    expect(lines.filter((line) => line.event === 'api_request')).toMatchObject([
      { method: 'POST', route: '/api/v1/enlace/secreto', status: 403 },
      { method: 'POST', route: '/api/v1/enlace', status: 403 },
    ]);
  });

  it('se comprueba antes de leer el cuerpo: un JSON roto de otro sitio es csrf_rejected', async () => {
    const { app } = appWith();
    expectError(
      await post(app, '/api/v1/enlace/secreto', '{roto', {
        ...SAME_ORIGIN,
        origin: 'https://otro-sitio.example',
      }),
      403,
      'csrf_rejected',
    );
    expectError(await post(app, '/api/v1/enlace/secreto', '{roto'), 400, 'invalid_request');
  });

  it.each([
    ['Sec-Fetch-Site ausente', { ...SAME_ORIGIN, 'sec-fetch-site': undefined }],
    ['charset=utf-8', { ...SAME_ORIGIN, 'content-type': 'application/json; charset=utf-8' }],
    [
      'mayúsculas en el tipo',
      { ...SAME_ORIGIN, 'content-type': 'Application/JSON; Charset="UTF-8"' },
    ],
  ] as const)('acepta la petición de la propia web con %s', async (_name, headers) => {
    const { app, calls } = appWith();
    const response = await post(app, '/api/v1/enlace/secreto', { token: TOKEN }, headers);
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('un cuerpo de más de 1 MiB responde 413 invalid_request sin llamar al servicio', async () => {
    const { app, calls } = appWith();
    for (const url of ['/api/v1/enlace/secreto', '/api/v1/enlace']) {
      expectError(
        await post(app, url, { token: TOKEN, password: 'x'.repeat(1024 * 1024), code: '123456' }),
        413,
        'invalid_request',
      );
    }
    expect(calls).toEqual([]);
  });

  it('no envía cabeceras CORS', async () => {
    const { app } = appWith();
    const response = await post(app, '/api/v1/enlace/secreto', { token: TOKEN });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('POST /api/v1/enlace/secreto', () => {
  it('pasa el token al servicio y responde su secreto, una vez, con las cabeceras de seguridad', async () => {
    const { app, calls, lines } = appWith();
    const response = await post(app, '/api/v1/enlace/secreto', { token: TOKEN });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SECRET_RESPONSE);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([{ method: 'issueSecret', input: { token: TOKEN } }]);
    // El token y el secreto nunca llegan al registro.
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(TOTP_SECRET);
  });

  it.each([
    ['sin token', {}],
    ['con un token corto', { token: TOKEN.slice(0, 42) }],
    ['con un token que no es canónico', { token: `${TOKEN.slice(0, 42)}B` }],
    ['con campos de más', { token: TOKEN, password: PASSWORD }],
    ['con una lista', [TOKEN]],
  ])('%s responde invalid_request sin llamar al servicio', async (_name, body) => {
    const { app, calls } = appWith();
    expectError(await post(app, '/api/v1/enlace/secreto', body), 400, 'invalid_request');
    expect(calls).toEqual([]);
  });

  it('un enlace que no vale responde 400 invalid_link', async () => {
    const { app } = appWith({ issueSecret: () => Promise.reject(new LinkError('invalid_link')) });
    expectError(await post(app, '/api/v1/enlace/secreto', { token: TOKEN }), 400, 'invalid_link');
  });

  it('un secreto que no cumple su contrato responde internal, sin salir', async () => {
    const { app } = appWith({
      issueSecret: () =>
        Promise.resolve({
          ...SECRET_RESPONSE,
          totp: { secret: TOTP_SECRET, uri: SECRET_RESPONSE.totp.uri.replace('pedro', 'otro') },
        }),
    });
    const response = await post(app, '/api/v1/enlace/secreto', { token: TOKEN });
    expectError(response, 500, 'internal');
    expect(response.body).not.toContain(TOTP_SECRET);
  });

  it('con PostgreSQL caído responde 503 postgres_unavailable y registra solo el código', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
      code: 'ECONNREFUSED',
    });
    const { app, lines } = appWith({ issueSecret: () => Promise.reject(down) });
    expectError(
      await post(app, '/api/v1/enlace/secreto', { token: TOKEN }),
      503,
      'postgres_unavailable',
    );
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'ECONNREFUSED',
    });
    expect(JSON.stringify(lines)).not.toContain('10.1.2.3');
  });
});

describe('POST /api/v1/enlace', () => {
  const use = { token: TOKEN, password: PASSWORD, code: '123456' };

  it('pasa al servicio el token, la contraseña, el código y el identificador de la petición', async () => {
    const { app, calls, lines } = appWith({
      useLink: () => Promise.resolve({ result: 'credential_reset' }),
    });
    const response = await post(app, '/api/v1/enlace', use);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'credential_reset' });
    expect(calls).toEqual([{ method: 'useLink', input: { ...use, requestId: testRequestId(1) } }]);
    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it.each([
    ['un código de 5 cifras', { ...use, code: '12345' }],
    ['un código con letras', { ...use, code: '12345a' }],
    ['sin contraseña', { token: TOKEN, code: '123456' }],
    ['una contraseña vacía', { ...use, password: '' }],
    ['una contraseña de más de 1024', { ...use, password: 'x'.repeat(1025) }],
    ['el nombre de usuario', { ...use, username: 'pedro' }],
  ])('con %s responde invalid_request sin llamar al servicio', async (_name, body) => {
    const { app, calls } = appWith();
    expectError(await post(app, '/api/v1/enlace', body), 400, 'invalid_request');
    expect(calls).toEqual([]);
  });

  it.each([
    [new LinkError('invalid_link'), 400, 'invalid_link'],
    [new LinkError('invalid_code'), 400, 'invalid_code'],
  ] as const)('%s responde %i %s', async (error, status, code) => {
    const { app } = appWith({ useLink: () => Promise.reject(error) });
    expectError(await post(app, '/api/v1/enlace', use), status, code);
  });

  it('una contraseña que no cumple la política responde 422 con su motivo', async () => {
    const { app } = appWith({
      useLink: () => Promise.reject(new PasswordRejectedError('context_words')),
    });
    const response = await post(app, '/api/v1/enlace', use);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'password_rejected', request_id: testRequestId(1), reason: 'context_words' },
    });
  });

  it('con demasiados hashes esperando responde 429 rate_limited con un segundo', async () => {
    const { app } = appWith({ useLink: () => Promise.reject(new PasswordHasherBusyError()) });
    const response = await post(app, '/api/v1/enlace', use);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'rate_limited', request_id: testRequestId(1), retry_after_seconds: 1 },
    });
  });

  it('un fallo inesperado del servicio responde internal y registra su nombre', async () => {
    const { app, lines } = appWith({ useLink: () => Promise.reject(new TypeError(PASSWORD)) });
    const response = await post(app, '/api/v1/enlace', use);
    expectError(response, 500, 'internal');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'TypeError',
    });
    expect(JSON.stringify(lines) + response.body).not.toContain(PASSWORD);
  });
});

// Los enlaces cuentan sus fallos por la dirección del cliente (ADR-0019 §1, precisión del PR 7a):
// la de `CF-Connecting-IP`, nunca una de `X-Forwarded-For`, y si falta, la de la conexión. Con el
// limitador de verdad: 10 fallos cada 15 minutos por dirección.
describe('los enlaces y la dirección del cliente (ADR-0019 §1)', () => {
  const CONNECTION = '192.0.2.44';

  function linkApp() {
    const { links } = fakeLinks({
      issueSecret: () => Promise.reject(new LinkError('invalid_link')),
    });
    return testApp(
      apiRoutes(routeDeps({ readiness: { isReady: () => true }, links, clock: () => 1_000_000 })),
    ).app;
  }

  function secretFrom(app: ReturnType<typeof linkApp>, headers: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/enlace/secreto',
      headers: { ...SAME_ORIGIN, ...headers },
      payload: JSON.stringify({ token: TOKEN }),
      remoteAddress: CONNECTION,
    });
  }

  it('diez enlaces que no valen desde una dirección la hacen esperar, aunque cambie X-Forwarded-For', async () => {
    const app = linkApp();
    for (let i = 1; i <= 10; i += 1) {
      expectError(
        await secretFrom(app, {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': `198.51.100.${String(i)}, 10.31.76.${String(i)}`,
        }),
        400,
        'invalid_link',
      );
    }
    expectError(
      await secretFrom(app, {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.99',
      }),
      429,
      'rate_limited',
    );
    // Otra dirección, y la de la conexión cuando falta la cabecera, cuentan aparte.
    expectError(await secretFrom(app, { 'cf-connecting-ip': '203.0.113.8' }), 400, 'invalid_link');
    expectError(await secretFrom(app, {}), 400, 'invalid_link');
  });
});
