import {
  apiHealthSchema,
  linkSecretRequestSchema,
  linkSecretSchema,
  linkUseRequestSchema,
  linkUseSchema,
  type LinkSecretRequest,
  type LinkUseRequest,
} from '@buoh/contracts';
import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

import { LinkError, PasswordRejectedError } from './accounts/errors.js';
import type { LinkService } from './accounts/service.js';
import { PasswordHasherBusyError } from './auth/password-hash.js';
import { ApiRequestError, NOT_READY_FAILURE } from './errors.js';
import type { Readiness } from './readiness.js';

/**
 * Lo que devuelve el manejador de una ruta: el estado y el cuerpo, que validará su esquema. El
 * cuerpo es un objeto o una lista. Cualquier otro (un texto, un `Buffer`, un *stream* o ninguno)
 * es `internal`, porque Fastify lo enviaría sin pasar por el serializador.
 */
export interface ApiRouteResult {
  readonly status: number;
  readonly body: unknown;
}

interface ApiRouteSpecBase {
  readonly url: string;
  readonly operationId: string;
  readonly summary: string;
  /** El esquema de la consulta. `NO_QUERY` si la ruta no admite parámetros de consulta. */
  readonly querystring: ZodType;
  /** El esquema de cada respuesta correcta, por estado. Los errores son siempre `ApiError`. */
  readonly responses: Readonly<Record<number, ZodType>>;
  /**
   * Los estados de error propios de la ruta, con su descripción para el OpenAPI, además de los de
   * todas: 400 y 500. Una descripción aquí sustituye a la de todas.
   */
  readonly errors?: Readonly<Record<number, string>>;
}

/**
 * Una ruta de la API, sin su manejador. Fastify registra la tabla y el OpenAPI sale de ella
 * (ADR-0019 §6), así que una ruta no puede existir sin su contrato. Una ruta `POST` cambia algo:
 * lleva el esquema de su cuerpo y pasa las comprobaciones contra CSRF (`csrf.ts`).
 */
export type ApiRouteSpec =
  | (ApiRouteSpecBase & { readonly method: 'GET'; readonly body?: undefined })
  | (ApiRouteSpecBase & { readonly method: 'POST'; readonly body: ZodType });

/** Una ruta de la API con su manejador. */
export type ApiRoute = ApiRouteSpec & {
  readonly handler: (request: FastifyRequest) => ApiRouteResult | Promise<ApiRouteResult>;
};

/** Una consulta vacía: cualquier parámetro de consulta es `invalid_request`. */
export const NO_QUERY = z.strictObject({});

/** Fastify rechaza un cuerpo de más de su límite, 1 MiB, antes de validarlo. */
const BODY_TOO_LARGE = 'El cuerpo pasa del límite de 1 MiB (invalid_request).';
const NOT_READY =
  'Faltan las migraciones de la API (not_ready), o PostgreSQL no responde (postgres_unavailable).';
const CSRF =
  'La petición no llega de la propia web: Origin, Sec-Fetch-Site o Content-Type (csrf_rejected).';

const SALUD = {
  method: 'GET',
  url: '/api/salud',
  operationId: 'getSalud',
  summary:
    'El proceso de la API responde y tiene sus migraciones (la ruta de salud de Render, ADR-0019 §7).',
  querystring: NO_QUERY,
  responses: { 200: apiHealthSchema },
  errors: { 503: 'Faltan las migraciones de la API (not_ready).' },
} as const satisfies ApiRouteSpec;

const ENLACE_SECRETO = {
  method: 'POST',
  url: '/api/v1/enlace/secreto',
  operationId: 'postEnlaceSecreto',
  summary:
    'Un secreto TOTP nuevo para un enlace de alta o de restablecimiento; el anterior deja de valer (ADR-0019 §3).',
  querystring: NO_QUERY,
  body: linkSecretRequestSchema,
  responses: { 200: linkSecretSchema },
  errors: {
    400: 'La petición no cumple su contrato (invalid_request), o el enlace no existe, venció, ya se usó o lo anuló otro (invalid_link).',
    403: CSRF,
    413: BODY_TOO_LARGE,
    503: NOT_READY,
  },
} as const satisfies ApiRouteSpec;

const ENLACE = {
  method: 'POST',
  url: '/api/v1/enlace',
  operationId: 'postEnlace',
  summary:
    'Usa un enlace con la contraseña nueva y un código de su último secreto TOTP: da de alta la cuenta o restablece su credencial (ADR-0019 §3).',
  querystring: NO_QUERY,
  body: linkUseRequestSchema,
  responses: { 200: linkUseSchema },
  errors: {
    400: 'La petición no cumple su contrato (invalid_request), el enlace no vale (invalid_link) o el código no corresponde a su último secreto TOTP (invalid_code).',
    403: CSRF,
    413: BODY_TOO_LARGE,
    422: 'La contraseña nueva no cumple la política, con su motivo (password_rejected).',
    429: 'Hay demasiadas contraseñas esperando su hash, con los segundos que faltan (rate_limited).',
    503: NOT_READY,
  },
} as const satisfies ApiRouteSpec;

/** Las rutas de la API, en el orden en que se registran. De esta lista sale el OpenAPI. */
export const API_ROUTE_SPECS: readonly ApiRouteSpec[] = [SALUD, ENLACE_SECRETO, ENLACE];

/** Lo que necesitan las rutas: si la API está lista y el servicio de las cuentas. */
export interface ApiRouteDeps {
  readonly readiness: Readiness;
  readonly links: LinkService;
}

function requireReady(readiness: Readiness): void {
  if (!readiness.isReady()) {
    throw new ApiRequestError(NOT_READY_FAILURE);
  }
}

/** Los fallos esperados de las cuentas, con su código (ADR-0019 §6). Los demás siguen igual. */
function asRequestError(error: unknown): unknown {
  if (error instanceof LinkError) {
    return new ApiRequestError({ status: 400, code: error.code });
  }
  if (error instanceof PasswordRejectedError) {
    return new ApiRequestError({ status: 422, code: 'password_rejected', reason: error.reason });
  }
  if (error instanceof PasswordHasherBusyError) {
    return new ApiRequestError({ status: 429, code: 'rate_limited', retryAfterSeconds: 1 });
  }
  return error;
}

async function accountsCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw asRequestError(error);
  }
}

/** La tabla de rutas con sus manejadores. */
export function apiRoutes(deps: ApiRouteDeps): readonly ApiRoute[] {
  return [
    {
      ...SALUD,
      handler: () => {
        requireReady(deps.readiness);
        return { status: 200, body: { status: 'ok' } };
      },
    },
    {
      ...ENLACE_SECRETO,
      handler: async (request) => {
        requireReady(deps.readiness);
        const body = request.body as LinkSecretRequest;
        const secret = await accountsCall(() => deps.links.issueSecret({ token: body.token }));
        return { status: 200, body: secret };
      },
    },
    {
      ...ENLACE,
      handler: async (request) => {
        requireReady(deps.readiness);
        const body = request.body as LinkUseRequest;
        const result = await accountsCall(() =>
          deps.links.useLink({
            token: body.token,
            password: body.password,
            code: body.code,
            requestId: request.id,
          }),
        );
        return { status: 200, body: result };
      },
    },
  ];
}
