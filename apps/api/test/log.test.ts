import { describe, expect, it } from 'vitest';

import { errorName, jsonLines } from '../src/log.js';

// El registro de la API guarda el nombre de un error, nunca su mensaje (ADR-0019 §11).

const SECRET = 'secreto-de-prueba-a41e07';

function errorWith(fields: { readonly code?: unknown; readonly name?: string }): Error {
  return Object.assign(new Error(SECRET), fields);
}

describe('errorName', () => {
  it('da el código de un error, si es un identificador, también el SQLSTATE de PostgreSQL', () => {
    expect(errorName(errorWith({ code: 'FST_ERR_VALIDATION' }))).toBe('FST_ERR_VALIDATION');
    expect(errorName(errorWith({ code: 'ECONNRESET', name: 'OtroNombre' }))).toBe('ECONNRESET');
    expect(errorName(errorWith({ code: '42501', name: 'error' }))).toBe('42501');
    expect(errorName(errorWith({ code: '28P01', name: 'error' }))).toBe('28P01');
  });

  it('da el nombre de su clase si el código falta o lleva datos', () => {
    class ErrorPropio extends Error {
      override name = 'ErrorPropio';
    }
    expect(errorName(new ErrorPropio(SECRET))).toBe('ErrorPropio');
    for (const code of [`E_${SECRET}`, 'minusculas', 'E', `E_${'X'.repeat(64)}`, 42, null]) {
      expect(errorName(errorWith({ code, name: 'TypeError' })), String(code)).toBe('TypeError');
    }
  });

  it('da Error si el nombre también lleva datos, y NonError si no es un error', () => {
    for (const name of [`Error ${SECRET}`, 'Error: detalle', `E${'x'.repeat(64)}`, '']) {
      expect(errorName(errorWith({ code: `E ${SECRET}`, name })), name).toBe('Error');
    }
    expect(errorName(SECRET)).toBe('NonError');
    expect(errorName({ code: 'FST_ERR_VALIDATION', name: 'TypeError' })).toBe('NonError');
  });
});

describe('jsonLines', () => {
  it('escribe cada línea como un JSON terminado en un salto de línea', () => {
    const written: string[] = [];
    const log = jsonLines((text) => {
      written.push(text);
    });
    log({ event: 'api_listening', port: 10_000 });
    log({ event: 'api_config_error', variables: ['BUOH_DEPLOYMENT_ENVIRONMENT', 'PORT'] });
    expect(written).toEqual([
      '{"event":"api_listening","port":10000}\n',
      '{"event":"api_config_error","variables":["BUOH_DEPLOYMENT_ENVIRONMENT","PORT"]}\n',
    ]);
  });
});
