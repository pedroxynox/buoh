import type { Socket } from 'node:net';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import {
  classifyError,
  clientErrorResponse,
  errorBody,
  INTERNAL_FAILURE,
  NOT_FOUND_FAILURE,
  type ApiFailure,
} from './errors.js';
import { JSON_CONTENT_TYPE, JSON_RESPONSE_HEADERS } from './headers.js';
import { errorName, type ApiLog } from './log.js';
import { API_ROUTES, type ApiRoute } from './routes.js';
import {
  ResponseContractError,
  zodSerializerCompiler,
  zodValidatorCompiler,
} from './zod-compiler.js';

/** Lo que cambia en las pruebas: el registro, el reloj, los identificadores y las rutas. */
export interface ApiAppOptions {
  readonly log: ApiLog;
  /** Milisegundos de un reloj monótono, para la duración de cada petición. */
  readonly now: () => number;
  /** El identificador de cada petición, un UUID que genera la API, nunca el cliente. */
  readonly requestId: () => string;
  readonly routes?: readonly ApiRoute[];
}

/**
 * La aplicación Fastify de la API (ADR-0019 §6, §9 y §11):
 * - valida cada entrada y cada salida con los contratos (`zod-compiler.ts`), y una respuesta con
 *   un estado que su ruta no declara es `internal`;
 * - todo error responde con `ApiError`, sin el mensaje ni la traza;
 * - toda respuesta lleva las cabeceras de seguridad de `headers.ts`, también los errores, el 404 y
 *   los que el servidor HTTP rechaza antes de crear la petición;
 * - cada petición deja una línea en el registro, con los campos de `ApiLogLine` y nada más.
 */
export function buildApp(options: ApiAppOptions): FastifyInstance {
  const routes = options.routes ?? API_ROUTES;
  const routesByUrl = new Map(routes.map((route) => [route.url, route]));
  const startedAt = new WeakMap<FastifyRequest, number>();

  const app = Fastify({
    logger: false,
    genReqId: () => options.requestId(),
    requestIdHeader: false,
    // Mientras se cierra, Fastify respondería 503 directamente en el socket, sin las cabeceras de
    // seguridad: así, una petición que llega en ese momento sigue el camino normal.
    return503OnClosing: false,
    // El aviso GHSA-3qgw-9275-xf8w de Fastify solo afecta a un handlerTimeout distinto de 0.
    handlerTimeout: 0,
    clientErrorHandler: (error: Error, socket: Socket) => {
      if (socket.destroyed) {
        return;
      }
      const response = clientErrorResponse(error, options.requestId());
      if (response === null) {
        return;
      }
      options.log({ event: 'api_client_error', error: errorName(error) });
      if (socket.writable) {
        socket.write(response);
      }
      socket.destroy(error);
    },
  });

  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(zodSerializerCompiler);

  app.addHook('onRequest', (request, _reply, done) => {
    startedAt.set(request, options.now());
    done();
  });

  // Solo los cuerpos que no son texto pasan por aquí, es decir, las salidas de las rutas. Los
  // errores salen ya como texto validado (`errorBody`).
  app.addHook('preSerialization', (request, reply, payload, done) => {
    const route = matchedRoute(request);
    if (route?.responses[reply.statusCode] === undefined) {
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
    options.log({
      event: 'api_request',
      method: request.method,
      route: matchedRoute(request)?.url ?? null,
      status: reply.statusCode,
      duration_ms: Math.max(0, Math.round(options.now() - started)),
      request_id: request.id,
    });
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = classifyError(error);
    if (failure === INTERNAL_FAILURE) {
      options.log({ event: 'api_error', request_id: request.id, error: errorName(error) });
    }
    return sendError(reply, failure, request.id);
  });

  app.setNotFoundHandler((request, reply) => sendError(reply, NOT_FOUND_FAILURE, request.id));

  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.url,
      schema: { querystring: route.querystring, response: route.responses },
      handler: async (request, reply) => {
        const result = await route.handler(request);
        return reply.code(result.status).send(result.body);
      },
    });
  }

  return app;

  function matchedRoute(request: FastifyRequest): ApiRoute | undefined {
    const url: unknown = request.routeOptions.url;
    return typeof url === 'string' ? routesByUrl.get(url) : undefined;
  }
}

function sendError(reply: FastifyReply, failure: ApiFailure, requestId: string): FastifyReply {
  return reply
    .code(failure.status)
    .type(JSON_CONTENT_TYPE)
    .send(errorBody(failure.code, requestId));
}
