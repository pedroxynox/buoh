import type { Socket } from 'node:net';

import { apiErrorSchema } from '@buoh/contracts';
import { describe, expect, it, vi } from 'vitest';

import { clientErrorResponse } from '../src/errors.js';
import type { ApiLogLine } from '../src/log.js';
import {
  EXPECTED_JSON_HEADERS,
  parseRawResponse,
  rawExchange,
  testApp,
  testRequestId,
  useDeterminismGuards,
  type RawResponse,
} from './support.js';

// Las respuestas que no pasan por los ganchos de Fastify también llevan las cabeceras de seguridad
// y `ApiError`, y dejan su línea en el registro (ADR-0019 §9 y §11, y F2-API-001): la del servidor
// HTTP antes de crear la petición, la de una ruta que Fastify no puede leer, la de un `Expect`
// desconocido y la de una petición HTTP/1.1 sin `Host`.
useDeterminismGuards();

const SECRET = 'secreto-de-prueba-5d20c4';

function connectionError(code: string): Error {
  return Object.assign(new Error(`detalle del parser ${code}`), { code });
}

function fakeSocket(state: { destroyed?: boolean; writable?: boolean } = {}) {
  return {
    destroyed: state.destroyed ?? false,
    writable: state.writable ?? true,
    write: vi.fn(),
    destroy: vi.fn(),
  };
}

/** Las cabeceras de seguridad de una respuesta JSON cruda, cada una una sola vez. */
function expectRawSecurityHeaders(response: RawResponse): void {
  for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
    expect(response.headerCounts.get(name), name).toBe(1);
  }
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(response.body));
}

describe('clientErrorResponse', () => {
  it.each([
    ['HPE_INVALID_METHOD', 'HTTP/1.1 400 Bad Request'],
    ['ERR_HTTP_REQUEST_TIMEOUT', 'HTTP/1.1 408 Request Timeout'],
    ['HPE_HEADER_OVERFLOW', 'HTTP/1.1 431 Request Header Fields Too Large'],
  ])('%s responde %s con ApiError y las cabeceras', (code, statusLine) => {
    const raw = clientErrorResponse(connectionError(code), testRequestId(7));
    expect(raw).not.toBeNull();
    const response = parseRawResponse(raw ?? '');
    expect(response.statusLine).toBe(statusLine);
    expectRawSecurityHeaders(response);
    expect(response.headers.get('connection')).toBe('close');
    expect(apiErrorSchema.parse(JSON.parse(response.body))).toEqual({
      error: { code: 'invalid_request', request_id: testRequestId(7) },
    });
    expect(raw).not.toContain('detalle del parser');
  });

  it('no responde a una conexión que el cliente ya cortó', () => {
    expect(clientErrorResponse(connectionError('ECONNRESET'), testRequestId(1))).toBeNull();
  });
});

describe('el servidor HTTP de la API', () => {
  it('escribe la respuesta saneada, registra el código y el identificador, y cierra el socket', () => {
    const { app, lines } = testApp();
    const socket = fakeSocket();
    const error = connectionError('HPE_INVALID_METHOD');
    app.server.emit('clientError', error, socket as unknown as Socket);
    expect(socket.write).toHaveBeenCalledTimes(1);
    const written = parseRawResponse(String(socket.write.mock.calls[0]?.[0]));
    expect(written.headers.get('content-security-policy')).toBe(
      EXPECTED_JSON_HEADERS['content-security-policy'],
    );
    expect(apiErrorSchema.parse(JSON.parse(written.body)).error.request_id).toBe(testRequestId(1));
    expect(socket.destroy).toHaveBeenCalledWith(error);
    expect(lines).toEqual([
      { event: 'api_client_error', request_id: testRequestId(1), error: 'HPE_INVALID_METHOD' },
    ]);
  });

  it('no escribe en un socket destruido ni en uno que no se puede escribir', () => {
    const { app } = testApp();
    const destroyed = fakeSocket({ destroyed: true });
    app.server.emit(
      'clientError',
      connectionError('HPE_INVALID_METHOD'),
      destroyed as unknown as Socket,
    );
    expect(destroyed.write).not.toHaveBeenCalled();
    expect(destroyed.destroy).not.toHaveBeenCalled();

    const closed = fakeSocket({ writable: false });
    app.server.emit(
      'clientError',
      connectionError('HPE_INVALID_METHOD'),
      closed as unknown as Socket,
    );
    expect(closed.write).not.toHaveBeenCalled();
    expect(closed.destroy).toHaveBeenCalledTimes(1);
  });
});

/** La línea `api_request` de la primera petición de `testApp`, que dura 5 ms. */
function requestLine(route: string | null, status: number): ApiLogLine {
  return {
    event: 'api_request',
    method: 'GET',
    route,
    status,
    duration_ms: 5,
    request_id: testRequestId(1),
  };
}

describe('mensajes HTTP crudos, por una conexión en memoria', () => {
  it.each([
    [
      'una ruta con un % mal codificado',
      `GET /api/${SECRET}%zz HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
      'HTTP/1.1 400 Bad Request',
      requestLine(null, 400),
    ],
    [
      'una petición HTTP/1.1 sin Host',
      'GET /api/salud HTTP/1.1\r\nConnection: close\r\n\r\n',
      'HTTP/1.1 400 Bad Request',
      requestLine('/api/salud', 400),
    ],
    [
      'un Expect distinto de 100-continue',
      'GET /api/salud HTTP/1.1\r\nHost: a\r\nExpect: x-desconocido\r\nConnection: close\r\n\r\n',
      'HTTP/1.1 417 Expectation Failed',
      requestLine(null, 417),
    ],
    [
      'un Expect desconocido sin Host',
      'GET /api/salud HTTP/1.1\r\nExpect: x-desconocido\r\nConnection: close\r\n\r\n',
      'HTTP/1.1 400 Bad Request',
      requestLine(null, 400),
    ],
    [
      'una cabecera mal formada',
      `GET /api/salud HTTP/1.1\r\nHost: a\r\nCabecera ${SECRET}\r\n\r\n`,
      'HTTP/1.1 400 Bad Request',
      {
        event: 'api_client_error',
        request_id: testRequestId(1),
        error: 'HPE_INVALID_HEADER_TOKEN',
      },
    ],
  ] as const)(
    '%s responde ApiError con las cabeceras y deja su línea',
    async (_name, message, statusLine, line) => {
      const { app, lines } = testApp();
      const raw = await rawExchange(app, message);
      const response = parseRawResponse(raw);
      expect(response.statusLine).toBe(statusLine);
      expectRawSecurityHeaders(response);
      expect(apiErrorSchema.parse(JSON.parse(response.body))).toEqual({
        error: { code: 'invalid_request', request_id: testRequestId(1) },
      });
      expect(lines).toEqual([line]);
      expect(raw + JSON.stringify(lines)).not.toContain(SECRET);
    },
  );

  it('una petición correcta lleva cada cabecera de seguridad una sola vez', async () => {
    const { app, lines } = testApp();
    const response = parseRawResponse(
      await rawExchange(app, 'GET /api/salud HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n'),
    );
    expect(response.statusLine).toBe('HTTP/1.1 200 OK');
    expectRawSecurityHeaders(response);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
    expect(lines).toEqual([requestLine('/api/salud', 200)]);
  });

  it('HTTP/1.0 no necesita Host, como en Node', async () => {
    const { app } = testApp();
    const response = parseRawResponse(await rawExchange(app, 'GET /api/salud HTTP/1.0\r\n\r\n'));
    expect(response.statusLine).toBe('HTTP/1.1 200 OK');
    expectRawSecurityHeaders(response);
  });
});
