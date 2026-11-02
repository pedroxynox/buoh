import { describe, expect, it } from 'vitest';

import { ApiConfigError, DEFAULT_PORT, loadApiConfig } from '../src/config.js';

// La configuración de la API (ADR-0019 §10): sin `staging`, y errores con nombres, nunca valores.

function rejected(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigError) {
      return error.variables;
    }
    throw error;
  }
  throw new Error('La configuración no se rechazó.');
}

describe('loadApiConfig', () => {
  it('escucha en 0.0.0.0 en production y en 127.0.0.1 fuera de ella', () => {
    expect(loadApiConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: 'production' })).toEqual({
      environment: 'production',
      host: '0.0.0.0',
      port: DEFAULT_PORT,
    });
    for (const environment of ['development', 'test'] as const) {
      expect(loadApiConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: environment, PORT: '3001' })).toEqual({
        environment,
        host: '127.0.0.1',
        port: 3001,
      });
    }
  });

  it('usa el puerto 10000 de Render si no hay PORT', () => {
    expect(DEFAULT_PORT).toBe(10_000);
    expect(loadApiConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).port).toBe(10_000);
    expect(loadApiConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: 'test', PORT: '65535' }).port).toBe(65_535);
  });

  it('rechaza staging, que no existe en la Fase 2, y un entorno ausente o desconocido', () => {
    for (const environment of ['staging', 'prod', 'Production', '', undefined]) {
      expect(rejected({ BUOH_DEPLOYMENT_ENVIRONMENT: environment })).toEqual([
        'BUOH_DEPLOYMENT_ENVIRONMENT',
      ]);
    }
  });

  it('rechaza un puerto que no es un número de 1 a 65535', () => {
    for (const port of ['0', '65536', '080', '1e3', ' 80', '-1', 'abc', '']) {
      expect(rejected({ BUOH_DEPLOYMENT_ENVIRONMENT: 'test', PORT: port })).toEqual(['PORT']);
    }
  });

  it('nombra todas las variables rechazadas, ordenadas, sin sus valores', () => {
    const secretValue = 'valor-secreto-9c1d';
    let message = '';
    try {
      loadApiConfig({ BUOH_DEPLOYMENT_ENVIRONMENT: secretValue, PORT: secretValue });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConfigError);
      expect((error as ApiConfigError).variables).toEqual(['BUOH_DEPLOYMENT_ENVIRONMENT', 'PORT']);
      message = (error as Error).message;
    }
    expect(message).toBe('Configuración inválida o ausente: BUOH_DEPLOYMENT_ENVIRONMENT, PORT.');
    expect(message).not.toContain(secretValue);
  });
});
