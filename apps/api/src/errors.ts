import { STATUS_CODES } from 'node:http';

import { apiErrorSchema, type ApiErrorCode } from '@buoh/contracts';

import { JSON_CONTENT_TYPE, JSON_RESPONSE_HEADERS } from './headers.js';

/** Un fallo clasificado: el estado HTTP y el código de su contrato (ADR-0019 §6). */
export interface ApiFailure {
  readonly status: number;
  readonly code: ApiErrorCode;
}

export const INTERNAL_FAILURE: ApiFailure = { status: 500, code: 'internal' };
export const NOT_FOUND_FAILURE: ApiFailure = { status: 404, code: 'not_found' };

/**
 * Clasifica el error de una petición. Solo confía en el estado de los errores de Fastify, cuyo
 * código empieza por `FST_`, como la validación de la entrada (`FST_ERR_VALIDATION`), un cuerpo
 * demasiado grande o un tipo de contenido que no se admite. Cualquier otro error es `internal`,
 * aunque traiga su propio `statusCode`.
 */
export function classifyError(error: unknown): ApiFailure {
  if (error instanceof Error) {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (
      typeof code === 'string' &&
      code.startsWith('FST_') &&
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return statusCode === 404
        ? NOT_FOUND_FAILURE
        : { status: statusCode, code: 'invalid_request' };
    }
  }
  return INTERNAL_FAILURE;
}

/** El cuerpo JSON de un error, validado con su contrato. */
export function errorBody(code: ApiErrorCode, requestId: string): string {
  return JSON.stringify(apiErrorSchema.parse({ error: { code, request_id: requestId } }));
}

/**
 * La respuesta HTTP completa de un error que el servidor rechaza antes de crear la petición, como
 * un mensaje HTTP mal formado: Fastify la escribe en el socket sin pasar por sus ganchos, así que
 * lleva aquí las cabeceras de seguridad. `null` si la conexión ya se cortó.
 */
export function clientErrorResponse(error: unknown, requestId: string): string | null {
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (code === 'ECONNRESET') {
    return null;
  }
  const status =
    code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  const body = errorBody('invalid_request', requestId);
  const headers: Record<string, string> = {
    ...JSON_RESPONSE_HEADERS,
    connection: 'close',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': JSON_CONTENT_TYPE,
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
  return `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}\r\n${lines.join('')}\r\n${body}`;
}
