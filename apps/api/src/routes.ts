import { apiHealthSchema } from '@buoh/contracts';
import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

/**
 * Lo que devuelve el manejador de una ruta: el estado y el cuerpo, que validará su esquema. El
 * cuerpo es un objeto o una lista. Cualquier otro (un texto, un `Buffer`, un *stream* o ninguno)
 * es `internal`, porque Fastify lo enviaría sin pasar por el serializador.
 */
export interface ApiRouteResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Una ruta de la API. Fastify registra esta tabla, y el OpenAPI sale de ella (ADR-0019 §6), así
 * que una ruta no puede existir sin su contrato.
 */
export interface ApiRoute {
  readonly method: 'GET';
  readonly url: string;
  readonly operationId: string;
  readonly summary: string;
  /** El esquema de la consulta. `NO_QUERY` si la ruta no admite parámetros de consulta. */
  readonly querystring: ZodType;
  /** El esquema de cada respuesta correcta, por estado. Los errores son siempre `ApiError`. */
  readonly responses: Readonly<Record<number, ZodType>>;
  readonly handler: (request: FastifyRequest) => ApiRouteResult | Promise<ApiRouteResult>;
}

/** Una consulta vacía: cualquier parámetro de consulta es `invalid_request`. */
export const NO_QUERY = z.strictObject({});

/** Las rutas de la API. */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: 'GET',
    url: '/api/salud',
    operationId: 'getSalud',
    summary: 'El proceso de la API responde (la ruta de salud de Render, ADR-0019 §7).',
    querystring: NO_QUERY,
    responses: { 200: apiHealthSchema },
    handler: () => ({ status: 200, body: { status: 'ok' } }),
  },
];
