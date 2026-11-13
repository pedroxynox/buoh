/**
 * El tema por cuenta en la web servida por la API (`F2-UI-001`; concepto de interfaz §13): la forma
 * de la respuesta de las preferencias, contrastada con el esquema de `@buoh/contracts`; cómo se pone
 * el tema en la página; el botón del menú; y las dos lecturas de la API, la que lee sin el token
 * CSRF y la que guarda con él.
 */
import { accountPreferencesSchema } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/components/auth/api';
import {
  applyTheme,
  otherTheme,
  readAccountPreferences,
  THEME_ATTRIBUTE,
  themeToggleLabel,
} from '../src/components/tema';

describe('la respuesta de las preferencias, como el contrato', () => {
  const values: unknown[] = [
    { theme: 'night' },
    { theme: 'day' },
    { theme: 'noche' },
    { theme: 'dia' },
    { theme: 'Night' },
    { theme: '' },
    { theme: null },
    { theme: 1 },
    {},
    { theme: 'day', extra: 1 },
    { other: 'day' },
    [],
    ['day'],
    null,
    'day',
    1,
    { theme: ['day'] },
  ];

  it('acepta y rechaza lo mismo que el esquema', () => {
    let accepted = 0;
    for (const value of values) {
      const expected = accountPreferencesSchema.safeParse(value).success;
      expect(readAccountPreferences(value) !== null, JSON.stringify(value)).toBe(expected);
      accepted += expected ? 1 : 0;
    }
    expect(accepted).toBe(2);
    expect(readAccountPreferences({ theme: 'day' })).toEqual({ theme: 'day' });
  });
});

describe('el tema en la página', () => {
  function fakeRoot() {
    const attributes = new Map<string, string>();
    return {
      attributes,
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      style: { colorScheme: '' },
    };
  }

  it('pone el data-theme del sistema de diseño y el esquema de color de cada tema', () => {
    const root = fakeRoot();
    applyTheme(root, 'day');
    expect(root.attributes.get('data-theme')).toBe('dia');
    expect(root.style.colorScheme).toBe('light');
    applyTheme(root, 'night');
    expect(root.attributes.get('data-theme')).toBe('noche');
    expect(root.style.colorScheme).toBe('dark');
    expect(THEME_ATTRIBUTE).toEqual({ night: 'noche', day: 'dia' });
  });

  it('el botón del menú elige el otro tema y lo dice', () => {
    expect([otherTheme('night'), otherTheme('day')]).toEqual(['day', 'night']);
    expect([themeToggleLabel('night'), themeToggleLabel('day')]).toEqual([
      'Usar el tema día',
      'Usar el tema noche',
    ]);
  });
});

describe('las lecturas de las preferencias', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown) {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return requests;
  }

  it('la lectura: GET al mismo origen, sin cuerpo ni token; sin la forma del contrato, «unexpected»', async () => {
    const requests = stubFetch(200, { theme: 'day' });
    await expect(api.preferences()).resolves.toEqual({ theme: 'day' });
    expect(requests[0]?.path).toBe('/api/v1/preferencias');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/iu);
    expect(requests[0]?.init?.body).toBeUndefined();
    stubFetch(200, { theme: 'dia' });
    await expect(api.preferences()).rejects.toMatchObject({ failure: { code: 'unexpected' } });
  });

  it('el cambio: POST con el tema en JSON y el token CSRF, y un error con su código', async () => {
    const requests = stubFetch(200, { theme: 'day' });
    await expect(api.setTheme('day', 'c'.repeat(64))).resolves.toEqual({ theme: 'day' });
    expect(requests[0]?.path).toBe('/api/v1/preferencias');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(requests[0]?.init?.body).toBe('{"theme":"day"}');
    expect(requests[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-csrf-token': 'c'.repeat(64),
    });
    stubFetch(403, {
      error: { code: 'csrf_rejected', request_id: '7c2a4f9e-1f5b-4c3d-9a8e-2b6d0f1e3a5c' },
    });
    await expect(api.setTheme('night', 'c'.repeat(64))).rejects.toMatchObject({
      failure: { code: 'csrf_rejected' },
    });
  });
});
