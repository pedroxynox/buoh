import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import fastifyStatic from '@fastify/static';
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
import type { WebAssets } from './web.js';
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
   * petición pasa. Se consulta en cada petición a `/api/`, antes de las comprobaciones de CSRF; los
   * recursos estáticos de la web, públicos y cacheados, no cuentan.
   */
  readonly rateLimit: (address: string) => number;
  /**
   * La web exportada que sirve la API en el mismo origen (ADR-0019 §9), ya leída con sus cabeceras.
   * Sin ella, la API responde solo JSON, como el esqueleto y las pruebas que no sirven la web.
   */
  readonly web?: WebAssets;
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
  const { routes, web } = options;
  const startedAt = new WeakMap<FastifyRequest, number>();
  // Las respuestas de archivos estáticos ya llevan sus cabeceras (comunes, política de contenido y
  // caché); `onSend` no les pone las del JSON.
  const staticReplies = new WeakSet<FastifyReply>();

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
    // El límite general cuenta las peticiones a `/api/`, no los recursos estáticos de la web, que
    // son públicos, no llevan datos y se cachean (ADR-0019 §1 y §9).
    if (pathOf(request.url).startsWith('/api/')) {
      const retryAfterSeconds = options.rateLimit(clientAddress(request));
      if (retryAfterSeconds > 0) {
        sendError(reply, { status: 429, code: 'rate_limited', retryAfterSeconds }, request.id);
        return;
      }
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
  // errores salen ya como texto validado (`errorBody`), y los archivos estáticos son un flujo, que
  // Fastify no serializa.
  app.addHook('preSerialization', (request, reply, payload, done) => {
    const route = request.routeOptions.config.apiRoute;
    if (route === undefined) {
      done(null, payload);
      return;
    }
    if (route.responses[reply.statusCode] === undefined) {
      done(new ResponseContractError());
      return;
    }
    done(null, payload);
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    // Un archivo estático ya tiene sus cabeceras; no lleva las del JSON (ADR-0019 §9).
    if (!staticReplies.has(reply)) {
      reply.headers(JSON_RESPONSE_HEADERS);
    }
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

  if (web !== undefined) {
    registerWeb(app, web, staticReplies);
  }

  return app;
}

/**
 * Sirve la web exportada en el mismo origen que `/api/` (ADR-0019 §9). `@fastify/static` solo añade
 * `reply.sendFile` (`serve: false`): la ruta comodín resuelve cada petición contra el mapa de la web
 * y le pone las cabeceras precalculadas de ese archivo. Una ruta `/api/` que ninguna ruta propia
 * atendió es `not_found` en JSON; cualquier otra ruta desconocida es el `404.html` de la web.
 */
function registerWeb(
  app: FastifyInstance,
  web: WebAssets,
  staticReplies: WeakSet<FastifyReply>,
): void {
  app.register(fastifyStatic, {
    root: web.root,
    serve: false,
    cacheControl: false,
    decorateReply: true,
  });
  app.route({
    method: 'GET',
    url: '/*',
    handler: (request, reply) => {
      const path = pathOf(request.url);
      if (path.startsWith('/api/')) {
        return sendError(reply, NOT_FOUND_FAILURE, request.id);
      }
      const asset = web.byPath.get(path);
      if (asset !== undefined) {
        staticReplies.add(reply);
        return reply.headers(asset.headers).sendFile(asset.relPath);
      }
      if (web.notFound !== null) {
        staticReplies.add(reply);
        return reply.code(404).headers(web.notFound.headers).sendFile(web.notFound.relPath);
      }
      return sendError(reply, NOT_FOUND_FAILURE, request.id);
    },
  });
}

function sendError(reply: FastifyReply, failure: ApiFailure, requestId: string): FastifyReply {
  return reply.code(failure.status).type(JSON_CONTENT_TYPE).send(errorBody(failure, requestId));
}

/** La ruta de una URL sin su consulta, para distinguir `/api/` de la web estática. */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
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
