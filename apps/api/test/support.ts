import { afterEach, beforeEach, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiLogLine } from '../src/log.js';
import type { ApiRoute } from '../src/routes.js';

/**
 * Guardas de determinismo, como en las suites del dominio: la API no puede leer el reloj real, los
 * UUID aleatorios ni la red. El reloj y los identificadores le llegan inyectados. `Math.random` no
 * se prohíbe: avvio, el cargador de plugins de Fastify, lo usa para numerar sus pasos de arranque,
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
