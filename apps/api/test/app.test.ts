import { apiErrorSchema, apiHealthSchema } from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { API_ROUTES, NO_QUERY, type ApiRoute } from '../src/routes.js';
import { EXPECTED_JSON_HEADERS, testApp, testRequestId, useDeterminismGuards } from './support.js';

// La API de ADR-0019 §6, §9 y §11: contratos, errores, cabeceras y registros.
useDeterminismGuards();

const SECRET = 'secreto-de-prueba-7f3a91';
const CLIENT_ADDRESS = '203.0.113.7';

/** Una ruta de prueba, con la consulta vacía y la respuesta de la salud. */
function route(url: string, handler: ApiRoute['handler'], extra: Partial<ApiRoute> = {}): ApiRoute {
  return {
    method: 'GET',
    url,
    operationId: url,
    summary: url,
    querystring: NO_QUERY,
    responses: { 200: apiHealthSchema },
    handler,
    ...extra,
  };
}

const TEST_ROUTES: readonly ApiRoute[] = [
  ...API_ROUTES,
  route('/api/prueba/falla', () => {
    throw new Error(SECRET);
  }),
  route('/api/prueba/estado-propio', () => {
    // Un error que no es de Fastify, con su propio estado: la API no se fía de él.
    throw Object.assign(new Error(SECRET), { code: 'E_PROPIO', statusCode: 401 });
  }),
  route('/api/prueba/fastify-415', () => {
    throw Object.assign(new Error(SECRET), {
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      statusCode: 415,
    });
  }),
  route('/api/prueba/fastify-404', () => {
    throw Object.assign(new Error(SECRET), { code: 'FST_ERR_NOT_FOUND', statusCode: 404 });
  }),
  route('/api/prueba/fastify-503', () => {
    throw Object.assign(new Error(SECRET), { code: 'FST_ERR_PRUEBA', statusCode: 503 });
  }),
  route('/api/prueba/salida-invalida', () => ({
    status: 200,
    body: { status: 'ok', extra: SECRET },
  })),
  route('/api/prueba/estado-no-declarado', () => ({ status: 202, body: { status: 'ok' } })),
  route('/api/prueba/consulta', (request) => ({ status: 200, body: request.query }), {
    querystring: z.strictObject({ n: z.string().regex(/^\d{1,3}$/u) }),
    responses: { 200: z.strictObject({ n: z.string() }) },
  }),
];

function expectSecurityHeaders(response: LightMyRequestResponse): void {
  for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
    expect(response.headers[name], name).toBe(value);
  }
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.headers['access-control-allow-credentials']).toBeUndefined();
}

function expectError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  const body = apiErrorSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'request_id']);
}

describe('GET /api/salud', () => {
  it('responde { status: "ok" } con las cabeceras de seguridad', async () => {
    const { app } = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/salud' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expectSecurityHeaders(response);
  });

  it('responde a HEAD con las mismas cabeceras y sin cuerpo', async () => {
    const { app } = testApp();
    const response = await app.inject({ method: 'HEAD', url: '/api/salud' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expectSecurityHeaders(response);
  });

  it('rechaza cualquier parámetro de consulta con invalid_request', async () => {
    const { app } = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/salud?x=1' });
    expectError(response, 400, 'invalid_request');
    expectSecurityHeaders(response);
  });
});

describe('rutas que no existen', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/api/v1/sesion'],
    ['GET', '/api/salud/'],
    ['POST', '/api/salud'],
    ['DELETE', '/api/salud'],
    ['OPTIONS', '/api/salud'],
  ] as const)('%s %s responde not_found con las cabeceras', async (method, url) => {
    const { app } = testApp();
    const response = await app.inject({
      method,
      url,
      headers: { origin: 'https://otro-sitio.example', 'access-control-request-method': 'POST' },
    });
    expectError(response, 404, 'not_found');
    expectSecurityHeaders(response);
  });
});

describe('errores', () => {
  it('un fallo de la ruta responde internal, sin el mensaje ni la traza', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/falla' });
    expectError(response, 500, 'internal');
    expectSecurityHeaders(response);
    expect(response.body).not.toContain(SECRET);
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'Error',
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('no se fía del statusCode de un error que no es de Fastify', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/estado-propio' });
    expectError(response, 500, 'internal');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'E_PROPIO',
    });
    expect(JSON.stringify(lines) + response.body).not.toContain(SECRET);
  });

  it('un error de Fastify conserva su estado 4xx: invalid_request, o not_found con un 404', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    expectError(
      await app.inject({ method: 'GET', url: '/api/prueba/fastify-415' }),
      415,
      'invalid_request',
    );
    expectError(
      await app.inject({ method: 'GET', url: '/api/prueba/fastify-404' }),
      404,
      'not_found',
    );
    expect(lines.filter((line) => line.event === 'api_error')).toEqual([]);
  });

  it('un error de Fastify con un estado 5xx responde internal', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/fastify-503' });
    expectError(response, 500, 'internal');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'FST_ERR_PRUEBA',
    });
  });

  it('una salida que no cumple su contrato responde internal, nunca a medias', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/salida-invalida' });
    expectError(response, 500, 'internal');
    expect(response.body).not.toContain(SECRET);
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'ResponseContractError',
    });
  });

  it('un estado que la ruta no declara responde internal', async () => {
    const { app } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/estado-no-declarado' });
    expectError(response, 500, 'internal');
  });

  it('valida la consulta con su contrato y entrega a la ruta lo validado', async () => {
    const { app } = testApp(TEST_ROUTES);
    const valid = await app.inject({ method: 'GET', url: '/api/prueba/consulta?n=12' });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ n: '12' });
    for (const url of [
      '/api/prueba/consulta',
      '/api/prueba/consulta?n=abc',
      '/api/prueba/consulta?n=1234',
      '/api/prueba/consulta?n=1&otro=2',
    ]) {
      expectError(await app.inject({ method: 'GET', url }), 400, 'invalid_request');
    }
  });
});

describe('cierre', () => {
  it('una petición que llega durante el cierre sigue el camino normal, con sus cabeceras', async () => {
    const { app } = testApp();
    await app.ready();
    const closing = app.close();
    const response = await app.inject({ method: 'GET', url: '/api/salud' });
    await closing;
    expect(response.statusCode).toBe(200);
    expectSecurityHeaders(response);
  });
});

describe('identificador de la petición', () => {
  it('lo genera la API y no acepta el del cliente', async () => {
    const { app } = testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/salud?x=1',
      headers: { 'request-id': 'del-cliente', 'x-request-id': 'del-cliente' },
    });
    expect(apiErrorSchema.parse(response.json()).error.request_id).toBe(testRequestId(1));
    expect(JSON.stringify(response.headers)).not.toContain('del-cliente');
  });
});

describe('registro', () => {
  it('deja una sola línea por petición, con los campos de ApiLogLine y nada más', async () => {
    const { app, lines } = testApp();
    await app.inject({ method: 'GET', url: '/api/salud' });
    await app.inject({ method: 'GET', url: '/no-existe' });
    expect(lines).toEqual([
      {
        event: 'api_request',
        method: 'GET',
        route: '/api/salud',
        status: 200,
        duration_ms: 5,
        request_id: testRequestId(1),
      },
      {
        event: 'api_request',
        method: 'GET',
        route: null,
        status: 404,
        duration_ms: 5,
        request_id: testRequestId(2),
      },
    ]);
  });

  it('no deja en el registro ni en la respuesta cabeceras, cookies, consulta, dirección ni navegador', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const headers = {
      authorization: `Bearer ${SECRET}`,
      cookie: `__Host-Http-buoh_sesion=${SECRET}`,
      'user-agent': `navegador-${SECRET}`,
      'x-csrf-token': SECRET,
      'x-forwarded-for': CLIENT_ADDRESS,
    };
    const responses = [
      await app.inject({ method: 'GET', url: '/api/salud', headers }),
      await app.inject({ method: 'GET', url: `/api/salud?token=${SECRET}`, headers }),
      await app.inject({ method: 'GET', url: `/api/${SECRET}`, headers }),
      await app.inject({ method: 'GET', url: '/api/prueba/falla', headers }),
    ];
    const logged = JSON.stringify(lines);
    for (const value of [SECRET, CLIENT_ADDRESS]) {
      expect(logged).not.toContain(value);
      for (const response of responses) {
        expect(response.body).not.toContain(value);
        expect(JSON.stringify(response.headers)).not.toContain(value);
      }
    }
    for (const line of lines) {
      if (line.event === 'api_request') {
        expect(Object.keys(line).sort()).toEqual([
          'duration_ms',
          'event',
          'method',
          'request_id',
          'route',
          'status',
        ]);
      }
    }
  });
});
