import { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiLogLine } from '../src/log.js';
import type { ApiRoute } from '../src/routes.js';

/**
 * Guardas de determinismo, como en las suites del dominio: la API no puede leer el reloj real, los
 * UUID aleatorios ni la red. El reloj y los identificadores le llegan inyectados. Las funciones
 * aleatorias de `node:crypto` las prohíbe `test/setup.ts` en todas las pruebas. `Math.random` no se
 * prohíbe: avvio, el cargador de plugins de Fastify, lo usa para numerar sus pasos de arranque,
 * que no llegan a ninguna respuesta ni al registro.
 */
export function useDeterminismGuards(): void {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('crypto.randomUUID no está permitido en las pruebas de la API.');
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

/** Una API de prueba, con un registro que se guarda, un reloj que avanza 5 ms y UUID fijos. */
export function testApp(routes?: readonly ApiRoute[]) {
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
    ...(routes === undefined ? {} : { routes }),
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

export function parseRawResponse(raw: string): RawResponse {
  const end = raw.indexOf('\r\n\r\n');
  const [statusLine = '', ...headerLines] = (end === -1 ? raw : raw.slice(0, end)).split('\r\n');
  const headers = new Map<string, string>();
  const headerCounts = new Map<string, number>();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    headers.set(name, line.slice(colon + 1).trim());
    headerCounts.set(name, (headerCounts.get(name) ?? 0) + 1);
  }
  return { statusLine, headers, headerCounts, body: end === -1 ? '' : raw.slice(end + 4) };
}

/**
 * Envía un mensaje HTTP crudo al servidor de `app` por una conexión en memoria, sin abrir ningún
 * puerto, y devuelve lo que responde. Así llegan al analizador HTTP de Node los mensajes que
 * `inject` no puede enviar, como uno sin `Host`. Termina cuando el servidor cierra la conexión: el
 * mensaje pide `Connection: close`, es HTTP/1.0 o es uno que el servidor rechaza.
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
