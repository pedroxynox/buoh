import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { isSameOriginJsonRequest } from './csrf.js';
import { clientAddress } from './routes.js';
import {
  classifyError,
  clientErrorResponse,
  CSRF_REJECTED_FAILURE,
  errorBody,
  isServerFailure,
  NOT_FOUND_FAILURE,
  rawErrorResponse,
  type ApiFailure,
} from './errors.js';
import { JSON_CONTENT_TYPE, JSON_RESPONSE_HEADERS } from './headers.js';
import { errorName, type ApiLog } from './log.js';
import type { ApiRoute } from './routes.js';
import {
  ResponseContractError,
  zodSerializerCompiler,
  zodValidatorCompiler,
} from './zod-compiler.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** La ruta de la tabla que atiende la petición, con su método. No existe en el 404. */
    readonly apiRoute?: ApiRoute;
  }
  interface FastifyRequest {
    /** La cuenta de la sesión, que un manejador autenticado deja para la línea del registro (§11). */
    buohAccountId?: string;
  }
}

/** Lo que cambia en las pruebas: el registro, el reloj, los identificadores, el origen y las rutas. */
export interface ApiAppOptions {
  readonly log: ApiLog;
  /** Milisegundos de un reloj monótono, para la duración de cada petición. */
  readonly now: () => number;
  /** El identificador de cada petición, un UUID que genera la API, nunca el cliente. */
  readonly requestId: () => string;
  /** El origen público de la API (`BUOH_API_ORIGIN`), el único que puede cambiar algo (CSRF). */
  readonly origin: string;
  /** La tabla de rutas con sus manejadores (`apiRoutes`). */
  readonly routes: readonly ApiRoute[];
  /**
   * El límite general de peticiones por dirección (ADR-0019 §1): los segundos que faltan, o 0 si la
   * petición pasa. Se consulta en cada petición, antes de las comprobaciones de CSRF.
   */
  readonly rateLimit: (address: string) => number;
}

/** Una petición HTTP/1.1 sin `Host` es un 400 (RFC 9112 §3.2). */
const MISSING_HOST: ApiFailure = { status: 400, code: 'invalid_request' };

const EXPECTATION_FAILED = 417;

/**
 * La aplicación Fastify de la API (ADR-0019 §6, §9 y §11):
 * - valida cada entrada y cada salida con los contratos (`zod-compiler.ts`). Una respuesta con un
 *   estado que su ruta no declara, o con un cuerpo que no es un objeto ni una lista, es `internal`;
 * - todo error responde con `ApiError`, sin el mensaje ni la traza;
 * - una ruta `POST` cambia algo, así que antes de leer su cuerpo exige el `Origin`, el
 *   `Sec-Fetch-Site` y el `Content-Type` de la propia web (`csrf.ts`), o responde `csrf_rejected`;
 * - toda respuesta lleva las cabeceras de seguridad de `headers.ts`, también los errores, el 404 y
 *   las que no pasan por los ganchos de Fastify: la del servidor HTTP antes de crear la petición,
 *   la de una ruta que Fastify no puede leer y la de un `Expect` desconocido;
 * - cada petición deja una línea en el registro, con los campos de `ApiLogLine` y nada más.
 */
export function buildApp(options: ApiAppOptions): FastifyInstance {
  const { routes } = options;
  const startedAt = new WeakMap<FastifyRequest, number>();

  const logRequest = (
    method: string,
    route: string | null,
    status: number,
    started: number,
    requestId: string,
    accountId?: string,
  ): void => {
    options.log({
      event: 'api_request',
      method,
      route,
      status,
      duration_ms: Math.max(0, Math.round(options.now() - started)),
      request_id: requestId,
      ...(accountId === undefined ? {} : { account_id: accountId }),
    });
  };

  const app = Fastify({
    logger: false,
    genReqId: () => options.requestId(),
    requestIdHeader: false,
    // Mientras se cierra, Fastify respondería 503 directamente en el socket, sin las cabeceras de
    // seguridad: así, una petición que llega en ese momento sigue el camino normal.
    return503OnClosing: false,
    // El aviso GHSA-3qgw-9275-xf8w de Fastify solo afecta a un handlerTimeout distinto de 0.
    handlerTimeout: 0,
    // Node respondería él mismo a una petición HTTP/1.1 sin `Host`, con un 400 vacío y sin las
    // cabeceras de seguridad: así llega a Fastify, y `onRequest` la rechaza con el mismo estado.
    http: { requireHostHeader: false },
    clientErrorHandler: (error: Error, socket: Socket) => {
      if (socket.destroyed) {
        return;
      }
      const requestId = options.requestId();
      const response = clientErrorResponse(error, requestId);
      if (response === null) {
        return;
      }
      options.log({ event: 'api_client_error', request_id: requestId, error: errorName(error) });
      if (socket.writable) {
        socket.write(response);
      }
      socket.destroy(error);
    },
    // Fastify responde aquí, antes de buscar la ruta y sin sus ganchos, a una ruta con un `%` mal
    // codificado (400), a un parámetro demasiado largo (414) y al fallo de una restricción
    // asíncrona (500): la respuesta lleva aquí sus cabeceras y su línea del registro.
    frameworkErrors: (error, request, reply) => {
      const started = options.now();
      const failure = classifyError(error);
      if (isServerFailure(failure)) {
        options.log({ event: 'api_error', request_id: request.id, error: errorName(error) });
      }
      sendError(reply.headers(JSON_RESPONSE_HEADERS), failure, request.id);
      logRequest(request.method, null, failure.status, started, request.id);
    },
  });

  // Node respondería él mismo a un `Expect` distinto de `100-continue`, con un 417 vacío y sin las
  // cabeceras de seguridad. La petición no llega a Fastify. Como en Node, la conexión sigue
  // abierta: si la cerrara, una petición que llega detrás correría en su ruta sin respuesta ni
  // línea en el registro.
  app.server.on('checkExpectation', (request: IncomingMessage, response: ServerResponse) => {
    const started = options.now();
    const requestId = options.requestId();
    const { status, headers, body } = rawErrorResponse(
      lacksHost(request) ? MISSING_HOST.status : EXPECTATION_FAILED,
      requestId,
    );
    response.writeHead(status, headers);
    response.end(body);
    logRequest(request.method ?? '', null, status, started, requestId);
  });

  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(zodSerializerCompiler);

  app.addHook('onRequest', (request, reply, done) => {
    startedAt.set(request, options.now());
    if (lacksHost(request.raw)) {
      // Responder desde el gancho, sin llamar a `done`, deja la petición sin llegar a la ruta.
      sendError(reply, MISSING_HOST, request.id);
      return;
    }
    const retryAfterSeconds = options.rateLimit(clientAddress(request));
    if (retryAfterSeconds > 0) {
      sendError(reply, { status: 429, code: 'rate_limited', retryAfterSeconds }, request.id);
      return;
    }
    // Las peticiones que cambian algo (`POST` y `DELETE`) exigen el origen propio antes de leer el
    // cuerpo: así un cuerpo de otro sitio nunca llega a analizarse. La tercera condición de CSRF, el
    // token de la sesión, la comprueba el manejador (`routes.ts`).
    const method = request.routeOptions.config.apiRoute?.method;
    if (
      (method === 'POST' || method === 'DELETE') &&
      !isSameOriginJsonRequest(request.headers, options.origin)
    ) {
      sendError(reply, CSRF_REJECTED_FAILURE, request.id);
      return;
    }
    done();
  });

  // Solo los cuerpos que no son texto pasan por aquí, es decir, las salidas de las rutas. Los
  // errores salen ya como texto validado (`errorBody`).
  app.addHook('preSerialization', (request, reply, payload, done) => {
    if (request.routeOptions.config.apiRoute?.responses[reply.statusCode] === undefined) {
      done(new ResponseContractError());
      return;
    }
    done(null, payload);
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.headers(JSON_RESPONSE_HEADERS);
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const started = startedAt.get(request) ?? options.now();
    logRequest(
      request.method,
      request.routeOptions.config.apiRoute?.url ?? null,
      reply.statusCode,
      started,
      request.id,
      request.buohAccountId,
    );
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = classifyError(error);
    if (isServerFailure(failure)) {
      options.log({ event: 'api_error', request_id: request.id, error: errorName(error) });
    }
    return sendError(reply, failure, request.id);
  });

  app.setNotFoundHandler((request, reply) => sendError(reply, NOT_FOUND_FAILURE, request.id));

  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.url,
      // Los ganchos leen la ruta de la petición de aquí, también en el HEAD que Fastify añade a
      // cada GET, y no de su URL, que pueden compartir dos métodos.
      config: { apiRoute: route },
      schema: {
        querystring: route.querystring,
        ...(route.body === undefined ? {} : { body: route.body }),
        response: route.responses,
      },
      handler: async (request, reply) => {
        const result = await route.handler(request);
        if (!isMessageBody(result.body)) {
          throw new ResponseContractError();
        }
        if (result.setCookie !== undefined) {
          reply.header('set-cookie', result.setCookie);
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }

  return app;
}

function sendError(reply: FastifyReply, failure: ApiFailure, requestId: string): FastifyReply {
  return reply.code(failure.status).type(JSON_CONTENT_TYPE).send(errorBody(failure, requestId));
}

/** Una petición HTTP/1.1 sin `Host`, la misma comprobación que hace Node. */
function lacksHost(request: IncomingMessage): boolean {
  return (
    request.httpVersionMajor === 1 &&
    request.httpVersionMinor === 1 &&
    request.headers.host === undefined
  );
}

/**
 * Un objeto plano o una lista. Fastify enviaría tal cual, sin el serializador de la ruta, un texto,
 * un `Buffer`, un *stream* o la falta de cuerpo, y los mensajes de la API son objetos (§6).
 */
function isMessageBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return true;
  }
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(body);
  return prototype === Object.prototype || prototype === null;
}
