/**
 * La API sirve la web exportada en el mismo origen que `/api/` (ADR-0019 §9; `F2-API-001`, HTML):
 * el HTML con su política de contenido y los hashes de sus scripts en línea, los recursos de
 * `_next/static/` inmutables, los demás sin caché, y el JSON de la API con sus propias cabeceras. El
 * límite general cuenta `/api/`, no los recursos estáticos.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inlineScriptHashes, loadWebAssets, type WebAssets } from '../src/web.js';
import { EXPECTED_COMMON_HEADERS, EXPECTED_JSON_HEADERS, readyRoutes, testApp } from './support.js';

// Hashes SHA-256 en base64, calculados aparte (no con la implementación) de los scripts del fixture.
const HASH_1 = 'CihokcEcBW4atb/CW/XWsvWwbTjqwQlE9nj9ii5ww5M='; // console.log(1)
const HASH_2 = '8q5r0Gb3oV+3DObfp/Z4GOXgHcQVy/ejxH8MgPcPxTI='; // console.log(2)

/** La política de contenido del HTML de la portada, tal como la fija ADR-0019 §9, con su hash. */
const INDEX_CSP =
  "default-src 'none'; " +
  `script-src 'self' 'sha256-${HASH_1}'; ` +
  "style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

/**
 * La de los archivos que no son HTML: la del JSON, que estrecha la de §9 para que toda respuesta
 * lleve una política (`F2-API-001`; precisión del PR 7a de ADR-0019 §9).
 */
const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";

describe('inlineScriptHashes', () => {
  it('calcula el hash de cada script en línea y descarta los que tienen src', () => {
    const html =
      '<script>console.log(1)</script><script src="/a.js">x</script><script id="x">console.log(2)</script>';
    expect(inlineScriptHashes(html)).toEqual([HASH_1, HASH_2]);
  });

  it('no repite un hash igual', () => {
    const html = '<script>console.log(1)</script><script>console.log(1)</script>';
    expect(inlineScriptHashes(html)).toEqual([HASH_1]);
  });

  it('sin scripts en línea, ninguno', () => {
    expect(inlineScriptHashes('<p>hola</p><script src="/a.js"></script>')).toEqual([]);
  });
});

describe('la API sirve la web (ADR-0019 §9)', () => {
  let root: string;
  let web: WebAssets;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'buoh-web-'));
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><body>inicio<script>console.log(1)</script>' +
        '<script src="/_next/static/chunks/a.js" async></script></body></html>',
    );
    mkdirSync(join(root, 'acceso'), { recursive: true });
    writeFileSync(
      join(root, 'acceso', 'index.html'),
      '<html><body>acceso<script>console.log(2)</script></body></html>',
    );
    mkdirSync(join(root, '_next', 'static', 'chunks'), { recursive: true });
    writeFileSync(join(root, '_next', 'static', 'chunks', 'a.js'), 'export const x = 1;\n');
    writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(root, '404.html'), '<html><body>esta ruta no existe</body></html>');
    const loaded = loadWebAssets(root);
    if (loaded === null) {
      throw new Error('El fixture de la web no cargó.');
    }
    web = loaded;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const app = () => testApp(readyRoutes(), () => 0, web).app;
  const expectCommon = (response: LightMyRequestResponse) => {
    for (const [name, value] of Object.entries(EXPECTED_COMMON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
  };

  it('la portada lleva el HTML con su política de contenido exacta y sin caché', async () => {
    const response = await app().inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/iu);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['content-security-policy']).toBe(INDEX_CSP);
    expectCommon(response);
    expect(response.body).toContain('inicio');
  });

  it('cada sección tiene su HTML, con y sin barra final, con el hash de sus scripts', async () => {
    for (const url of ['/acceso/', '/acceso']) {
      const response = await app().inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-security-policy'], url).toContain(`'sha256-${HASH_2}'`);
    }
  });

  it('el HTML nunca deja `unsafe-inline` ni `unsafe-eval` en script-src', async () => {
    const response = await app().inject({ method: 'GET', url: '/' });
    const scriptSrc = /script-src ([^;]*);/u.exec(
      response.headers['content-security-policy'] ?? '',
    );
    expect(scriptSrc?.[1]).toBe(`'self' 'sha256-${HASH_1}'`);
    expect(scriptSrc?.[1]).not.toContain('unsafe-inline');
    expect(scriptSrc?.[1]).not.toContain('unsafe-eval');
  });

  it('los recursos con huella se cachean como inmutables, con la política estricta', async () => {
    const response = await app().inject({ method: 'GET', url: '/_next/static/chunks/a.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-security-policy']).toBe(STRICT_CSP);
    expectCommon(response);
  });

  it('los demás archivos sin huella no se cachean, con la política estricta', async () => {
    const response = await app().inject({ method: 'GET', url: '/icon.svg' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['content-security-policy']).toBe(STRICT_CSP);
    expectCommon(response);
  });

  it('una ruta de la web que no existe responde el 404.html, no el JSON', async () => {
    const response = await app().inject({ method: 'GET', url: '/no-existe/' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/text\/html/iu);
    expect(response.body).toContain('esta ruta no existe');
    expectCommon(response);
  });

  it('una ruta /api/ desconocida sigue siendo not_found en JSON', async () => {
    const response = await app().inject({ method: 'GET', url: '/api/v1/desconocida' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
  });

  it('el JSON de la API conserva sus cabeceras aunque la API sirva la web', async () => {
    const response = await app().inject({ method: 'GET', url: '/api/salud' });
    expect(response.statusCode).toBe(200);
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
  });

  it('el límite general cuenta /api/ pero no los recursos estáticos de la web', async () => {
    const limited = testApp(readyRoutes(), () => 30, web).app;
    expect((await limited.inject({ method: 'GET', url: '/api/salud' })).statusCode).toBe(429);
    expect((await limited.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect(
      (await limited.inject({ method: 'GET', url: '/_next/static/chunks/a.js' })).statusCode,
    ).toBe(200);
  });

  it('sin web, una ruta desconocida es not_found en JSON, como el esqueleto', async () => {
    const response = await testApp().app.inject({ method: 'GET', url: '/acceso/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
