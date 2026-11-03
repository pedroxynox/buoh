import { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, vi } from 'vitest';

import { createRateLimiter } from '../src/accounts/limits.js';
import type { LinkService } from '../src/accounts/service.js';
import type { SessionService } from '../src/accounts/sessions.js';
import { buildApp } from '../src/app.js';
import type { ApiLogLine } from '../src/log.js';
import { apiRoutes, type ApiRoute, type ApiRouteDeps } from '../src/routes.js';

/**
 * Guardas de determinismo, como en las suites del dominio: la API no puede leer el reloj real, el
 * azar de Web Crypto ni la red. El reloj y los identificadores le llegan inyectados. Las funciones
 * aleatorias de `node:crypto` las prohíbe `test/setup.ts` en todas las pruebas. `Math.random` no se
 * prohíbe: avvio, el cargador de plugins de Fastify, lo usa para numerar sus pasos de arranque,
 * que no llegan a ninguna respuesta ni al registro.
 */
export function useDeterminismGuards(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
    // Web Crypto: en Node 24, el `webcrypto` de `node:crypto` es este mismo objeto.
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('crypto.randomUUID no está permitido en las pruebas de la API.');
    });
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('crypto.getRandomValues no está permitido en las pruebas de la API.');
    });
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(() => {
      throw new Error('crypto.subtle.generateKey no está permitido en las pruebas de la API.');
    });
    vi.stubGlobal('fetch', () => {
      throw new Error('La red no está permitida en las pruebas de la API.');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

/**
 * Las cabeceras de seguridad de una respuesta JSON, como las fija ADR-0019 §9. Van escritas aquí,
 * y no se importan de `src/headers.ts`, para que las pruebas no copien la implementación.
 */
export const EXPECTED_JSON_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};

/** El UUID versión 4 número `n` de una prueba. */
export function testRequestId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** El origen público de la API en las pruebas (`BUOH_API_ORIGIN`). */
export const TEST_ORIGIN = 'https://buoh.test';

/** Un servicio de cuentas que la prueba no debe usar: cualquier llamada falla. */
const UNUSED_LINKS: LinkService = {
  issueSecret: () => Promise.reject(new Error('El servicio de cuentas no se usa en esta prueba.')),
  useLink: () => Promise.reject(new Error('El servicio de cuentas no se usa en esta prueba.')),
};

/** Un servicio de sesiones que la prueba no ejercita: sin sesión válida y sin token. */
const UNUSED_SESSIONS: SessionService = {
  login: () => Promise.reject(new Error('El servicio de sesiones no se usa en esta prueba.')),
  authenticate: () => Promise.resolve(null),
  renewActivity: () => Promise.resolve(),
  logout: () => Promise.resolve(0),
  closeOthers: () => Promise.resolve(0),
  listAudit: () => Promise.resolve([]),
  csrfToken: () => '0'.repeat(64),
  validateCsrf: () => false,
  flushPendingFailures: () => Promise.resolve(),
};

/** Las dependencias de las rutas, con servicios que esta prueba no ejercita salvo lo que cambie. */
export function routeDeps(overrides: Partial<ApiRouteDeps> = {}): ApiRouteDeps {
  return {
    readiness: { isReady: () => true },
    links: UNUSED_LINKS,
    sessions: UNUSED_SESSIONS,
    limiter: createRateLimiter(),
    clock: () => Date.now(),
    ...overrides,
  };
}

/** Las rutas de la API, ya lista y con servicios que esta prueba no ejercita. */
export function readyRoutes(): readonly ApiRoute[] {
  return apiRoutes(routeDeps());
}

/** Una API de prueba, con un registro que se guarda, un reloj que avanza 5 ms y UUID fijos. */
export function testApp(
  routes: readonly ApiRoute[] = readyRoutes(),
  rateLimit: (address: string) => number = () => 0,
) {
  const lines: ApiLogLine[] = [];
  let clock = 1_000;
  let nextId = 1;
  const app = buildApp({
    log: (line) => {
      lines.push(line);
    },
    now: () => {
      clock += 5;
      return clock;
    },
    requestId: () => testRequestId(nextId++),
    origin: TEST_ORIGIN,
    routes,
    rateLimit,
  });
  return { app, lines };
}

/** Una respuesta HTTP cruda, con los nombres de las cabeceras en minúsculas. */
export interface RawResponse {
  readonly statusLine: string;
  readonly headers: ReadonlyMap<string, string>;
  /** Cuántas veces llega cada cabecera. */
  readonly headerCounts: ReadonlyMap<string, number>;
  readonly body: string;
}

/** Una respuesta HTTP cruda. Su cuerpo es todo lo que sigue a las cabeceras. */
export function parseRawResponse(raw: string): RawResponse {
  const end = raw.indexOf('\r\n\r\n');
  const { statusLine, headers, headerCounts } = parseHead(end === -1 ? raw : raw.slice(0, end));
  return { statusLine, headers, headerCounts, body: end === -1 ? '' : raw.slice(end + 4) };
}

/** Las respuestas HTTP crudas de una conexión, una tras otra, cada cuerpo con su `content-length`. */
export function parseRawResponses(raw: string): RawResponse[] {
  const responses: RawResponse[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const end = rest.indexOf('\r\n\r\n');
    const head = parseHead(end === -1 ? rest : rest.slice(0, end));
    const start = end === -1 ? rest.length : end + 4;
    const length = Number(head.headers.get('content-length') ?? '0');
    responses.push({ ...head, body: rest.slice(start, start + length) });
    rest = rest.slice(start + length);
  }
  return responses;
}

function parseHead(head: string): Omit<RawResponse, 'body'> {
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const headers = new Map<string, string>();
  const headerCounts = new Map<string, number>();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    headers.set(name, line.slice(colon + 1).trim());
    headerCounts.set(name, (headerCounts.get(name) ?? 0) + 1);
  }
  return { statusLine, headers, headerCounts };
}

/**
 * Envía un mensaje HTTP crudo al servidor de `app` por una conexión en memoria, sin abrir ningún
 * puerto, y devuelve lo que responde. Así llegan al analizador HTTP de Node los mensajes que
 * `inject` no puede enviar, como uno sin `Host`. Termina cuando el servidor cierra la conexión:
 * porque el mensaje pide `Connection: close` o es HTTP/1.0, o porque el analizador no puede seguir
 * leyéndolo, como con una cabecera mal formada. Un 400 de la API no la cierra.
 */
export async function rawExchange(app: FastifyInstance, message: string): Promise<string> {
  await app.ready();
  return await new Promise((resolve) => {
    const written: Buffer[] = [];
    let sent = false;
    const socket = new Duplex({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.from(message, 'latin1'));
        }
      },
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk);
        callback();
      },
    });
    const closed = () => {
      resolve(Buffer.concat(written).toString('latin1'));
    };
    socket.once('finish', closed);
    socket.once('close', closed);
    app.server.emit('connection', socket);
  });
}
