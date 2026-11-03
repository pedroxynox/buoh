import { apiErrorSchema, apiHealthSchema } from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NO_QUERY, type ApiRoute } from '../src/routes.js';
import {
  EXPECTED_JSON_HEADERS,
  readyRoutes,
  TEST_ORIGIN,
  testApp,
  testRequestId,
  useDeterminismGuards,
} from './support.js';

// La API de ADR-0019 §6, §9 y §11: contratos, errores, cabeceras y registros.
useDeterminismGuards();

const SECRET = 'secreto-de-prueba-7f3a91';
const CLIENT_ADDRESS = '203.0.113.7';

/** Una ruta GET de prueba, con la consulta vacía y la respuesta de la salud. */
function route(
  url: string,
  handler: ApiRoute['handler'],
  extra: Partial<Pick<ApiRoute, 'operationId' | 'querystring' | 'responses'>> = {},
): ApiRoute {
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

/** Un error de prueba con su código y su estado, y el secreto en el mensaje. */
function codedError(code: string, statusCode: number): Error {
  return Object.assign(new Error(SECRET), { code, statusCode });
}

const TEST_ROUTES: readonly ApiRoute[] = [
  ...readyRoutes(),
  route('/api/prueba/falla', () => {
    throw new Error(SECRET);
  }),
  route('/api/prueba/estado-propio', () => {
    // Un error que no es de Fastify, con su propio estado: la API no se fía de él.
    throw codedError('E_PROPIO', 401);
  }),
  route('/api/prueba/fastify-415', () => {
    throw codedError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415);
  }),
  route('/api/prueba/fastify-404', () => {
    throw codedError('FST_ERR_NOT_FOUND', 404);
  }),
  route('/api/prueba/fastify-500', () => {
    throw codedError('FST_ERR_PRUEBA_500', 500);
  }),
  route('/api/prueba/fastify-503', () => {
    throw codedError('FST_ERR_PRUEBA_503', 503);
  }),
  route('/api/prueba/nombre-con-datos', () => {
    // Un código y un nombre que no son identificadores: llevan datos, y ninguno llega al registro.
    throw Object.assign(new Error(SECRET), { code: `E_${SECRET}`, name: `Error ${SECRET}` });
  }),
  route('/api/prueba/salida-invalida', () => ({
    status: 200,
    body: { status: 'ok', extra: SECRET },
  })),
  route('/api/prueba/estado-no-declarado', () => ({ status: 202, body: { status: 'ok' } })),
  route('/api/prueba/texto', () => ({ status: 200, body: `{"status":"ok","extra":"${SECRET}"}` })),
  route('/api/prueba/texto-no-declarado', () => ({ status: 202, body: SECRET })),
  route('/api/prueba/buffer', () => ({ status: 200, body: Buffer.from(SECRET) })),
  route('/api/prueba/sin-cuerpo', () => ({ status: 200, body: undefined })),
  route('/api/prueba/parametro/:id', () => ({ status: 200, body: { status: 'ok' } })),
  route('/api/prueba/consulta', (request) => ({ status: 200, body: request.query }), {
    // La consulta y la respuesta cambian lo que validan: la ruta recibe el número, y la respuesta
    // sale con el campo que añade su esquema.
    querystring: z.strictObject({
      n: z
        .string()
        .regex(/^\d{1,3}$/u)
        .transform(Number),
    }),
    responses: { 200: z.strictObject({ n: z.number(), origen: z.string().default('esquema') }) },
  }),
];

/**
 * Dos métodos en una misma URL, como tendrá `/api/v1/sesion` (ADR-0019 §2): el GET que responde el
 * 201 del POST no puede salir con el contrato del POST.
 */
const TWO_METHOD_ROUTES: readonly ApiRoute[] = [
  route('/api/prueba/dos-metodos', () => ({ status: 201, body: { status: 'ok', extra: SECRET } })),
  {
    method: 'POST',
    url: '/api/prueba/dos-metodos',
    operationId: 'postDosMetodos',
    summary: 'postDosMetodos',
    querystring: NO_QUERY,
    body: z.strictObject({}),
    responses: { 201: apiHealthSchema },
    handler: () => ({ status: 201, body: { status: 'ok' } }),
  },
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
    ['GET', '/api/v1/desconocido'],
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

describe('rutas que Fastify no puede leer', () => {
  it.each([
    ['un % mal codificado', `/api/${SECRET}%zz`, 400],
    ['un parámetro de más de 100 caracteres', `/api/prueba/parametro/${SECRET.repeat(5)}`, 414],
  ] as const)(
    '%s responde invalid_request con las cabeceras, sin repetir la ruta, y deja su línea',
    async (_name, url, status) => {
      const { app, lines } = testApp(TEST_ROUTES);
      const response = await app.inject({ method: 'GET', url });
      expectError(response, status, 'invalid_request');
      expectSecurityHeaders(response);
      expect(response.body).not.toContain(SECRET);
      expect(lines).toEqual([
        {
          event: 'api_request',
          method: 'GET',
          route: null,
          status,
          duration_ms: 5,
          request_id: testRequestId(1),
        },
      ]);
    },
  );
});

describe('rutas que Fastify no puede elegir', () => {
  it('el fallo de una restricción asíncrona responde internal, con su api_error y su línea', async () => {
    const { app, lines } = testApp();
    // La API no usa restricciones; esta, de prueba, falla en cada petición antes de elegir la ruta.
    app.addConstraintStrategy({
      name: 'prueba',
      // Falla antes de buscar en su almacén, que por eso no guarda nada.
      storage: () => ({ get: () => null, set: () => undefined }),
      deriveConstraint: (
        _request: unknown,
        _context: unknown,
        done?: (error: Error | null, value?: unknown) => void,
      ) => {
        done?.(new Error(SECRET));
      },
    });
    app.route({
      method: 'GET',
      url: '/api/prueba/restringida',
      constraints: { prueba: 'x' },
      handler: () => ({ status: 'ok' }),
    });
    const response = await app.inject({ method: 'GET', url: '/api/salud' });
    expectError(response, 500, 'internal');
    expectSecurityHeaders(response);
    expect(lines).toEqual([
      { event: 'api_error', request_id: testRequestId(1), error: 'FST_ERR_ASYNC_CONSTRAINT' },
      {
        event: 'api_request',
        method: 'GET',
        route: null,
        status: 500,
        duration_ms: 5,
        request_id: testRequestId(1),
      },
    ]);
    expect(JSON.stringify(lines) + response.body).not.toContain(SECRET);
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

  it.each([500, 503])('un error de Fastify con el estado %i responde internal', async (status) => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({
      method: 'GET',
      url: `/api/prueba/fastify-${String(status)}`,
    });
    expectError(response, 500, 'internal');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: `FST_ERR_PRUEBA_${String(status)}`,
    });
  });

  it('un error con datos en su código y en su nombre se registra como Error', async () => {
    const { app, lines } = testApp(TEST_ROUTES);
    const response = await app.inject({ method: 'GET', url: '/api/prueba/nombre-con-datos' });
    expectError(response, 500, 'internal');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'Error',
    });
    expect(JSON.stringify(lines) + response.body).not.toContain(SECRET);
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

  it.each([
    '/api/prueba/texto',
    '/api/prueba/texto-no-declarado',
    '/api/prueba/buffer',
    '/api/prueba/sin-cuerpo',
  ])(
    '%s: un cuerpo que no es un objeto ni una lista responde internal, sin salir tal cual',
    async (url) => {
      const { app, lines } = testApp(TEST_ROUTES);
      const response = await app.inject({ method: 'GET', url });
      expectError(response, 500, 'internal');
      expectSecurityHeaders(response);
      expect(response.body).not.toContain(SECRET);
      expect(lines).toContainEqual({
        event: 'api_error',
        request_id: testRequestId(1),
        error: 'ResponseContractError',
      });
    },
  );

  it('cada método de una misma URL responde con su propio contrato', async () => {
    const { app, lines } = testApp(TWO_METHOD_ROUTES);
    const get = await app.inject({ method: 'GET', url: '/api/prueba/dos-metodos' });
    expectError(get, 500, 'internal');
    expect(get.body).not.toContain(SECRET);
    const post = await app.inject({
      method: 'POST',
      url: '/api/prueba/dos-metodos',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toEqual({ status: 'ok' });
    expect(lines.filter((line) => line.event === 'api_request')).toMatchObject([
      { method: 'GET', route: '/api/prueba/dos-metodos', status: 500 },
      { method: 'POST', route: '/api/prueba/dos-metodos', status: 201 },
    ]);
  });

  it('valida la consulta con su contrato y entrega a la ruta y al cliente lo validado', async () => {
    const { app } = testApp(TEST_ROUTES);
    const valid = await app.inject({ method: 'GET', url: '/api/prueba/consulta?n=12' });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ n: 12, origen: 'esquema' });
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

describe('configuración de Fastify', () => {
  it('deja handlerTimeout en 0, fuera del aviso GHSA-3qgw-9275-xf8w', () => {
    const { app } = testApp();
    expect((app.initialConfig as { readonly handlerTimeout?: unknown }).handlerTimeout).toBe(0);
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
      await app.inject({ method: 'GET', url: `/api/${SECRET}%zz`, headers }),
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
