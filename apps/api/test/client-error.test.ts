import type { Socket } from 'node:net';

import { apiErrorSchema } from '@buoh/contracts';
import { describe, expect, it, vi } from 'vitest';

import { clientErrorResponse } from '../src/errors.js';
import { EXPECTED_JSON_HEADERS, testApp, testRequestId, useDeterminismGuards } from './support.js';

// Las respuestas que el servidor HTTP escribe antes de crear la petición también llevan las
// cabeceras de seguridad (ADR-0019 §9 y F2-API-001).
useDeterminismGuards();

function parseRawResponse(raw: string) {
  const [head = '', body = ''] = raw.split('\r\n\r\n');
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const headers = Object.fromEntries(
    headerLines.map((line) => {
      const separator = line.indexOf(': ');
      return [line.slice(0, separator), line.slice(separator + 2)];
    }),
  );
  return { statusLine, headers, body };
}

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
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['connection']).toBe('close');
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body));
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
  it('escribe la respuesta saneada, registra el código y cierra el socket', () => {
    const { app, lines } = testApp();
    const socket = fakeSocket();
    const error = connectionError('HPE_INVALID_METHOD');
    app.server.emit('clientError', error, socket as unknown as Socket);
    expect(socket.write).toHaveBeenCalledTimes(1);
    const written = String(socket.write.mock.calls[0]?.[0]);
    expect(parseRawResponse(written).headers['content-security-policy']).toBe(
      EXPECTED_JSON_HEADERS['content-security-policy'],
    );
    expect(socket.destroy).toHaveBeenCalledWith(error);
    expect(lines).toEqual([{ event: 'api_client_error', error: 'HPE_INVALID_METHOD' }]);
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
