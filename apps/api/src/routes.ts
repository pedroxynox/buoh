import {
  apiHealthSchema,
  auditEventsResponseSchema,
  dataHealthSchema,
  emptyRequestSchema,
  linkSecretRequestSchema,
  linkSecretSchema,
  linkUseRequestSchema,
  linkUseSchema,
  sessionInfoSchema,
  sessionLoginRequestSchema,
  sessionsClosedResultSchema,
  type LinkSecretRequest,
  type LinkUseRequest,
  type SessionLoginRequest,
} from '@buoh/contracts';
import type { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { z, type ZodType } from 'zod';

import {
  LinkError,
  LoginError,
  PasswordRejectedError,
  RateLimitedError,
} from './accounts/errors.js';
import type { LinkService } from './accounts/service.js';
import {
  SESSION_MAX_MS,
  type AuthenticatedSession,
  type SessionService,
} from './accounts/sessions.js';
import type { RateLimiter } from './accounts/limits.js';
import { PasswordHasherBusyError } from './auth/password-hash.js';
import { buildSessionCookie, clearSessionCookie, readSessionCookie } from './auth/session-token.js';
import type { DataReader } from './data/reader.js';
import { ApiRequestError, CSRF_REJECTED_FAILURE, NOT_READY_FAILURE } from './errors.js';
import type { Readiness } from './readiness.js';

/**
 * Lo que devuelve el manejador de una ruta: el estado, el cuerpo, que validará su esquema, y una
 * cabecera `Set-Cookie` opcional (el inicio y el cierre de sesión). El cuerpo es un objeto o una
 * lista. Cualquier otro (un texto, un `Buffer`, un *stream* o ninguno) es `internal`, porque Fastify
 * lo enviaría sin pasar por el serializador.
 */
export interface ApiRouteResult {
  readonly status: number;
  readonly body: unknown;
  /** El valor de una cabecera `Set-Cookie`, si la respuesta pone o borra la cookie de la sesión. */
  readonly setCookie?: string;
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
 * (ADR-0019 §6), así que una ruta no puede existir sin su contrato. Una ruta que cambia algo (`POST`
 * o `DELETE`) lleva el esquema de su cuerpo y pasa las dos primeras comprobaciones contra CSRF antes
 * de leerlo (`csrf.ts`); si tiene sesión, el manejador exige además el token CSRF.
 */
export type ApiRouteSpec =
  | (ApiRouteSpecBase & { readonly method: 'GET'; readonly body?: undefined })
  | (ApiRouteSpecBase & { readonly method: 'POST' | 'DELETE'; readonly body: ZodType });

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
const UNAUTHENTICATED = 'La petición necesita una sesión y no la trae o no vale (unauthenticated).';
const RATE_LIMITED = 'Hay que esperar, con los segundos que faltan (rate_limited).';

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
    429: RATE_LIMITED,
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
    429: RATE_LIMITED,
    503: NOT_READY,
  },
} as const satisfies ApiRouteSpec;

const SESION = {
  method: 'POST',
  url: '/api/v1/sesion',
  operationId: 'postSesion',
  summary:
    'Inicia sesión con el nombre, la contraseña y un código de 6 cifras; pone la cookie de la sesión y devuelve su token CSRF (ADR-0019 §1 y §2).',
  querystring: NO_QUERY,
  body: sessionLoginRequestSchema,
  responses: { 201: sessionInfoSchema },
  errors: {
    400: 'La petición no cumple su contrato (invalid_request).',
    401: 'El nombre, la contraseña o el código no valen (invalid_credentials).',
    403: `${CSRF} O la credencial está deshabilitada por sus 100 fallos (credential_disabled).`,
    413: BODY_TOO_LARGE,
    429: RATE_LIMITED,
    503: NOT_READY,
  },
} as const satisfies ApiRouteSpec;

const SESION_INFO = {
  method: 'GET',
  url: '/api/v1/sesion',
  operationId: 'getSesion',
  summary:
    'El token CSRF de la sesión actual, que la web recupera al abrir cada página (ADR-0019 §2).',
  querystring: NO_QUERY,
  responses: { 200: sessionInfoSchema },
  errors: { 401: UNAUTHENTICATED, 503: NOT_READY },
} as const satisfies ApiRouteSpec;

const SESION_CIERRE = {
  method: 'DELETE',
  url: '/api/v1/sesion',
  operationId: 'deleteSesion',
  summary: 'Cierra la sesión actual y borra su cookie (ADR-0019 §2).',
  querystring: NO_QUERY,
  body: emptyRequestSchema,
  responses: { 200: sessionsClosedResultSchema },
  errors: { 401: UNAUTHENTICATED, 403: CSRF, 413: BODY_TOO_LARGE, 503: NOT_READY },
} as const satisfies ApiRouteSpec;

const SESIONES_CIERRE = {
  method: 'DELETE',
  url: '/api/v1/sesiones',
  operationId: 'deleteSesiones',
  summary: 'Cierra las demás sesiones de la cuenta, menos la actual (ADR-0019 §2).',
  querystring: NO_QUERY,
  body: emptyRequestSchema,
  responses: { 200: sessionsClosedResultSchema },
  errors: { 401: UNAUTHENTICATED, 403: CSRF, 413: BODY_TOO_LARGE, 503: NOT_READY },
} as const satisfies ApiRouteSpec;

const AUDITORIA = {
  method: 'GET',
  url: '/api/v1/auditoria',
  operationId: 'getAuditoria',
  summary: 'Las entradas de auditoría de la cuenta, de la más nueva a la más vieja (ADR-0019 §5).',
  querystring: NO_QUERY,
  responses: { 200: auditEventsResponseSchema },
  errors: { 401: UNAUTHENTICATED, 503: NOT_READY },
} as const satisfies ApiRouteSpec;

const DATOS_SALUD = {
  method: 'GET',
  url: '/api/v1/datos/salud',
  operationId: 'getDatosSalud',
  summary:
    'La salud de los datos: el log activo y la última observación que guardó buoh-operaciones en él, con su hora (ADR-0019 §8).',
  querystring: NO_QUERY,
  responses: { 200: dataHealthSchema },
  errors: {
    401: UNAUTHENTICATED,
    503: 'Faltan las migraciones de la API o la credencial de lectura de los datos (not_ready), o PostgreSQL no responde (postgres_unavailable).',
  },
} as const satisfies ApiRouteSpec;

/** Las rutas de la API, en el orden en que se registran. De esta lista sale el OpenAPI. */
export const API_ROUTE_SPECS: readonly ApiRouteSpec[] = [
  SALUD,
  ENLACE_SECRETO,
  ENLACE,
  SESION,
  SESION_INFO,
  SESION_CIERRE,
  SESIONES_CIERRE,
  AUDITORIA,
  DATOS_SALUD,
];

/**
 * Lo que necesitan las rutas: la espera, las cuentas, las sesiones, los límites, el reloj y las
 * lecturas del sistema de datos.
 */
export interface ApiRouteDeps {
  readonly readiness: Readiness;
  readonly links: LinkService;
  readonly sessions: SessionService;
  readonly limiter: RateLimiter;
  /** Milisegundos de pared, para el límite por dirección de los enlaces (ADR-0019 §1). */
  readonly clock: () => number;
  /**
   * Las lecturas del sistema de datos, con `buoh_api_lectura` (ADR-0019 §8), o `null` sin su
   * credencial: entonces sus rutas responden `not_ready`.
   */
  readonly data: DataReader | null;
}

function requireReady(readiness: Readiness): void {
  if (!readiness.isReady()) {
    throw new ApiRequestError(NOT_READY_FAILURE);
  }
}

/**
 * La dirección del cliente (ADR-0019 §1): la de `CF-Connecting-IP`, que pone Cloudflare delante de
 * Render con la dirección que se le conecta, y que el cliente no puede elegir: Cloudflare rechaza la
 * petición que ya la trae con un valor. Si falta, o no es una sola dirección IP, la de la conexión,
 * que en Render es un proxy suyo: el runbook de la API comprueba que no pase en producción.
 * `X-Forwarded-For` no cuenta: sus primeras direcciones las elige el cliente, y en Render la última
 * es una interna que cambia en cada petición.
 */
export function clientAddress(request: FastifyRequest): string {
  const connecting = request.headers['cf-connecting-ip'];
  if (typeof connecting === 'string' && isIP(connecting) !== 0) {
    return connecting;
  }
  return request.ip;
}

/** Los fallos esperados de las cuentas y del inicio de sesión, con su código (ADR-0019 §6). */
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
  if (error instanceof RateLimitedError) {
    return new ApiRequestError({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof LoginError) {
    return error.code === 'credential_disabled'
      ? new ApiRequestError({ status: 403, code: 'credential_disabled' })
      : new ApiRequestError({ status: 401, code: 'invalid_credentials' });
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

/** Una sesión válida de la cookie, o `unauthenticated`. Deja la cuenta para la línea del registro. */
async function requireSession(
  request: FastifyRequest,
  deps: ApiRouteDeps,
): Promise<AuthenticatedSession> {
  const session = await deps.sessions.authenticate(readSessionCookie(request.headers.cookie));
  if (session === null) {
    throw new ApiRequestError({ status: 401, code: 'unauthenticated' });
  }
  request.buohAccountId = session.accountId;
  return session;
}

/** La tercera condición contra CSRF: el token de la sesión en `X-CSRF-Token` (ADR-0019 §2). */
function requireCsrf(
  request: FastifyRequest,
  session: AuthenticatedSession,
  deps: ApiRouteDeps,
): void {
  if (!deps.sessions.validateCsrf(session.sessionSecret, request.headers['x-csrf-token'])) {
    throw new ApiRequestError(CSRF_REJECTED_FAILURE);
  }
}

/**
 * En una ruta de lectura, una petición con el token CSRF válido es del propietario y renueva la
 * inactividad de la sesión; una actualización automática, sin el token, no (ADR-0019 §2).
 */
async function renewIfOwnerRequest(
  request: FastifyRequest,
  session: AuthenticatedSession,
  deps: ApiRouteDeps,
): Promise<void> {
  if (deps.sessions.validateCsrf(session.sessionSecret, request.headers['x-csrf-token'])) {
    await deps.sessions.renewActivity(session);
  }
}

/** La tabla de rutas con sus manejadores. */
export function apiRoutes(deps: ApiRouteDeps): readonly ApiRoute[] {
  /** Un enlace que no vale cuenta como un fallo por dirección (ADR-0019 §1). */
  const linkCall = async <T>(call: () => Promise<T>, address: string, now: number): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LinkError) {
        deps.limiter.recordAddressFailure(address, now);
      }
      throw asRequestError(error);
    }
  };

  const guardAddress = (request: FastifyRequest): { address: string; now: number } => {
    const address = clientAddress(request);
    const now = deps.clock();
    const wait = deps.limiter.addressFailureWait(address, now);
    if (wait > 0) {
      throw new ApiRequestError({ status: 429, code: 'rate_limited', retryAfterSeconds: wait });
    }
    return { address, now };
  };

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
        const { address, now } = guardAddress(request);
        const body = request.body as LinkSecretRequest;
        const secret = await linkCall(
          () => deps.links.issueSecret({ token: body.token }),
          address,
          now,
        );
        return { status: 200, body: secret };
      },
    },
    {
      ...ENLACE,
      handler: async (request) => {
        requireReady(deps.readiness);
        const { address, now } = guardAddress(request);
        const body = request.body as LinkUseRequest;
        const result = await linkCall(
          () =>
            deps.links.useLink({
              token: body.token,
              password: body.password,
              code: body.code,
              requestId: request.id,
            }),
          address,
          now,
        );
        return { status: 200, body: result };
      },
    },
    {
      ...SESION,
      handler: async (request) => {
        requireReady(deps.readiness);
        const body = request.body as SessionLoginRequest;
        const { sessionSecret, csrfToken } = await accountsCall(() =>
          deps.sessions.login({
            username: body.username,
            password: body.password,
            code: body.code,
            address: clientAddress(request),
            requestId: request.id,
          }),
        );
        return {
          status: 201,
          body: { csrf_token: csrfToken },
          setCookie: buildSessionCookie(sessionSecret, Math.floor(SESSION_MAX_MS / 1000)),
        };
      },
    },
    {
      ...SESION_INFO,
      handler: async (request) => {
        requireReady(deps.readiness);
        const session = await requireSession(request, deps);
        // Abrir una página renueva la inactividad (ADR-0019 §2).
        await deps.sessions.renewActivity(session);
        return {
          status: 200,
          body: { csrf_token: deps.sessions.csrfToken(session.sessionSecret) },
        };
      },
    },
    {
      ...SESION_CIERRE,
      handler: async (request) => {
        requireReady(deps.readiness);
        const session = await requireSession(request, deps);
        requireCsrf(request, session, deps);
        const closed = await deps.sessions.logout({ session, requestId: request.id });
        return { status: 200, body: { closed }, setCookie: clearSessionCookie() };
      },
    },
    {
      ...SESIONES_CIERRE,
      handler: async (request) => {
        requireReady(deps.readiness);
        const session = await requireSession(request, deps);
        requireCsrf(request, session, deps);
        const closed = await deps.sessions.closeOthers({ session, requestId: request.id });
        await deps.sessions.renewActivity(session);
        return { status: 200, body: { closed } };
      },
    },
    {
      ...AUDITORIA,
      handler: async (request) => {
        requireReady(deps.readiness);
        const session = await requireSession(request, deps);
        await renewIfOwnerRequest(request, session, deps);
        const events = await deps.sessions.listAudit(session);
        return { status: 200, body: { events } };
      },
    },
    {
      ...DATOS_SALUD,
      handler: async (request) => {
        requireReady(deps.readiness);
        // Los datos del sistema no son de una cuenta, pero solo los lee una sesión (ADR-0019 §8).
        const session = await requireSession(request, deps);
        await renewIfOwnerRequest(request, session, deps);
        if (deps.data === null) {
          throw new ApiRequestError(NOT_READY_FAILURE);
        }
        return { status: 200, body: await deps.data.health() };
      },
    },
  ];
}
