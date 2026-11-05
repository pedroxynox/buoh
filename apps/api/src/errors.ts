import { STATUS_CODES } from 'node:http';

import { apiErrorSchema, type ApiErrorCode, type PasswordRejectionReason } from '@buoh/contracts';

import { JSON_CONTENT_TYPE, JSON_RESPONSE_HEADERS } from './headers.js';
import { isPostgresUnavailable } from './postgres/errors.js';

/** Los códigos de error que no llevan más campos (ADR-0019 §6). */
export type PlainApiErrorCode = Exclude<ApiErrorCode, 'rate_limited' | 'password_rejected'>;

/**
 * Un fallo clasificado: el estado HTTP y el código de su contrato (ADR-0019 §6). `rate_limited`
 * lleva además los segundos que faltan, y `password_rejected`, su motivo.
 */
export type ApiFailure =
  | { readonly status: number; readonly code: PlainApiErrorCode }
  | { readonly status: 429; readonly code: 'rate_limited'; readonly retryAfterSeconds: number }
  | {
      readonly status: 422;
      readonly code: 'password_rejected';
      readonly reason: PasswordRejectionReason;
    };

export const INTERNAL_FAILURE: ApiFailure = { status: 500, code: 'internal' };
export const STORAGE_UNAVAILABLE_FAILURE: ApiFailure = { status: 503, code: 'storage_unavailable' };

/**
 * El almacenamiento de objetos de la captura (R2) no respondió a una lectura (ADR-0019 §8): la API
 * responde `storage_unavailable` (503). `reason` es el motivo saneado del error, su código o su
 * nombre, como `TimeoutError` o `AccessDenied`, el que deja la línea `api_error`; nunca su mensaje,
 * que puede llevar el endpoint.
 */
export class StorageUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super('El almacenamiento de objetos no respondió.', options);
    this.name = 'StorageUnavailableError';
    this.reason = reason;
  }
}
export const NOT_FOUND_FAILURE: ApiFailure = { status: 404, code: 'not_found' };
export const CSRF_REJECTED_FAILURE: ApiFailure = { status: 403, code: 'csrf_rejected' };
export const NOT_READY_FAILURE: ApiFailure = { status: 503, code: 'not_ready' };
export const POSTGRES_UNAVAILABLE_FAILURE: ApiFailure = {
  status: 503,
  code: 'postgres_unavailable',
};

/**
 * Un fallo esperado que una ruta responde con su código, como `invalid_link` o `not_ready`. Su
 * mensaje es fijo y nunca sale: la respuesta solo lleva su código.
 */
export class ApiRequestError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(`La petición terminó con ${failure.code}.`);
    this.name = 'ApiRequestError';
    this.failure = failure;
  }
}

/**
 * Clasifica el error de una petición:
 * - un `ApiRequestError` tiene su propio fallo;
 * - de los errores de Fastify, cuyo código empieza por `FST_`, como la validación de la entrada
 *   (`FST_ERR_VALIDATION`), un cuerpo demasiado grande o un tipo de contenido que no se admite,
 *   solo se fía de un estado 4xx: `invalid_request`, o `not_found` con un 404;
 * - un error con el que PostgreSQL no se puede usar es `postgres_unavailable` (503);
 * - un `StorageUnavailableError`, del almacenamiento de objetos, es `storage_unavailable` (503);
 * - cualquier otro es `internal`, aunque traiga su propio `statusCode`.
 */
export function classifyError(error: unknown): ApiFailure {
  if (error instanceof ApiRequestError) {
    return error.failure;
  }
  if (error instanceof StorageUnavailableError) {
    return STORAGE_UNAVAILABLE_FAILURE;
  }
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
  if (isPostgresUnavailable(error)) {
    return POSTGRES_UNAVAILABLE_FAILURE;
  }
  return INTERNAL_FAILURE;
}

/** Si el fallo deja su línea `api_error`: los que no son de la petición, sino del servidor. */
export function isServerFailure(failure: ApiFailure): boolean {
  return (
    failure.code === 'internal' ||
    failure.code === 'postgres_unavailable' ||
    failure.code === 'storage_unavailable'
  );
}

/** El cuerpo JSON de un error, validado con su contrato. */
export function errorBody(failure: ApiFailure, requestId: string): string {
  const error =
    failure.code === 'rate_limited'
      ? {
          code: failure.code,
          request_id: requestId,
          retry_after_seconds: failure.retryAfterSeconds,
        }
      : failure.code === 'password_rejected'
        ? { code: failure.code, request_id: requestId, reason: failure.reason }
        : { code: failure.code, request_id: requestId };
  return JSON.stringify(apiErrorSchema.parse({ error }));
}

/** Un error `invalid_request` que la API escribe fuera de los ganchos de Fastify. */
export interface RawErrorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Un error `invalid_request` con su estado, para una respuesta que no pasa por los ganchos de
 * Fastify: lleva aquí las cabeceras de seguridad.
 */
export function rawErrorResponse(status: number, requestId: string): RawErrorResponse {
  const body = errorBody({ status, code: 'invalid_request' }, requestId);
  return {
    status,
    headers: {
      ...JSON_RESPONSE_HEADERS,
      'content-length': String(Buffer.byteLength(body)),
      'content-type': JSON_CONTENT_TYPE,
    },
    body,
  };
}

/**
 * La respuesta HTTP completa de un error que el servidor rechaza antes de crear la petición, como
 * un mensaje HTTP mal formado: Fastify la escribe en el socket sin pasar por sus ganchos. `null`
 * si la conexión ya se cortó.
 */
export function clientErrorResponse(error: unknown, requestId: string): string | null {
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (code === 'ECONNRESET') {
    return null;
  }
  const status =
    code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  const response = rawErrorResponse(status, requestId);
  // El analizador no puede seguir leyendo esta conexión, así que la respuesta la cierra.
  const headers = { ...response.headers, connection: 'close' };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
  return `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}\r\n${lines.join('')}\r\n${response.body}`;
}
