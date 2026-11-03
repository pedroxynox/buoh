import { describe, expect, it } from 'vitest';

import { ApiConfigError, DEFAULT_PORT, loadApiConfig } from '../src/config.js';

// La configuración de la API (ADR-0019 §7 y §10): sin `staging`, el origen público, las tres
// claves de 32 bytes que genera Render, la conexión como buoh_api en production y errores con
// nombres, nunca valores.

const KEY_1 = Buffer.alloc(32, 0x01).toString('base64');
const KEY_2 = Buffer.alloc(32, 0x02).toString('base64');
const KEY_3 = Buffer.alloc(32, 0x03).toString('base64');

/** Una configuración completa de `test`, con los servicios locales. */
const TEST_ENV: Readonly<Record<string, string>> = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_API_ORIGIN: 'http://127.0.0.1:10000',
  BUOH_API_PASSWORD_PEPPER: KEY_1,
  BUOH_API_TOTP_KEY: KEY_2,
  BUOH_API_TOKEN_KEY: KEY_3,
  BUOH_POSTGRES_PASSWORD: 'contraseña-local',
};

/** Una configuración completa de `production`, como la que da Render a `buoh-api`. */
const PRODUCTION_ENV: Readonly<Record<string, string>> = {
  ...TEST_ENV,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_API_ORIGIN: 'https://buoh-api.onrender.com',
  BUOH_POSTGRES_HOST: 'dpg-interno',
  BUOH_POSTGRES_PORT: '5432',
  BUOH_POSTGRES_DB: 'buoh',
  BUOH_POSTGRES_USER: 'buoh_api',
  BUOH_POSTGRES_SSLMODE: 'require',
};

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
  it('en production escucha en 0.0.0.0, con su origen, sus claves y buoh_api con TLS', () => {
    expect(loadApiConfig(PRODUCTION_ENV)).toEqual({
      environment: 'production',
      host: '0.0.0.0',
      port: DEFAULT_PORT,
      origin: 'https://buoh-api.onrender.com',
      keys: {
        passwordPepper: Buffer.alloc(32, 0x01),
        totpKey: Buffer.alloc(32, 0x02),
        tokenKey: Buffer.alloc(32, 0x03),
      },
      postgres: {
        database: 'buoh',
        host: 'dpg-interno',
        password: 'contraseña-local',
        port: 5432,
        sslMode: 'require',
        user: 'buoh_api',
      },
    });
  });

  it('fuera de production escucha en 127.0.0.1, admite http y usa los servicios locales', () => {
    for (const environment of ['development', 'test'] as const) {
      expect(
        loadApiConfig({ ...TEST_ENV, BUOH_DEPLOYMENT_ENVIRONMENT: environment, PORT: '3001' }),
      ).toMatchObject({
        environment,
        host: '127.0.0.1',
        port: 3001,
        origin: 'http://127.0.0.1:10000',
        postgres: { host: '127.0.0.1', port: 5432, sslMode: 'disable', user: 'buoh' },
      });
    }
  });

  it('usa el puerto 10000 de Render si no hay PORT', () => {
    expect(DEFAULT_PORT).toBe(10_000);
    expect(loadApiConfig(TEST_ENV).port).toBe(10_000);
    expect(loadApiConfig({ ...TEST_ENV, PORT: '65535' }).port).toBe(65_535);
  });

  it('rechaza staging, que no existe en la Fase 2, y un entorno ausente o desconocido', () => {
    for (const environment of ['staging', 'prod', 'Production', '', undefined]) {
      expect(rejected({ ...TEST_ENV, BUOH_DEPLOYMENT_ENVIRONMENT: environment })).toEqual([
        'BUOH_DEPLOYMENT_ENVIRONMENT',
      ]);
    }
  });

  it('rechaza un puerto que no es un número de 1 a 65535', () => {
    for (const port of ['0', '65536', '080', '1e3', ' 80', '-1', 'abc', '']) {
      expect(rejected({ ...TEST_ENV, PORT: port })).toEqual(['PORT']);
    }
  });

  it('exige cada clave como 32 bytes en base64 canónico, como las de generateValue de Render', () => {
    for (const name of ['BUOH_API_PASSWORD_PEPPER', 'BUOH_API_TOTP_KEY', 'BUOH_API_TOKEN_KEY']) {
      for (const value of [
        undefined,
        '',
        Buffer.alloc(31, 0x05).toString('base64'),
        Buffer.alloc(33, 0x05).toString('base64'),
        Buffer.alloc(32, 0x05).toString('base64url'),
        Buffer.alloc(32, 0x05).toString('base64').replace('=', ''),
        Buffer.alloc(32, 0x05).toString('hex'),
        ` ${Buffer.alloc(32, 0x05).toString('base64')}`,
        // La misma clave con los dos bits finales distintos de cero: no es la escritura canónica.
        `${Buffer.alloc(32, 0x05).toString('base64').slice(0, 42)}V=`,
      ]) {
        expect(rejected({ ...TEST_ENV, [name]: value }), `${name}=${String(value)}`).toEqual([
          name,
        ]);
      }
    }
  });

  it('rechaza dos claves iguales, y nombra las dos', () => {
    expect(rejected({ ...TEST_ENV, BUOH_API_TOTP_KEY: KEY_1 })).toEqual([
      'BUOH_API_PASSWORD_PEPPER',
      'BUOH_API_TOTP_KEY',
    ]);
    expect(rejected({ ...TEST_ENV, BUOH_API_TOTP_KEY: KEY_1, BUOH_API_TOKEN_KEY: KEY_1 })).toEqual([
      'BUOH_API_PASSWORD_PEPPER',
      'BUOH_API_TOKEN_KEY',
      'BUOH_API_TOTP_KEY',
    ]);
  });

  it('exige el origen público exacto: esquema, servidor y puerto, sin ruta, y https en production', () => {
    for (const origin of [
      undefined,
      '',
      'buoh-api.onrender.com',
      'https://buoh-api.onrender.com/',
      'https://buoh-api.onrender.com/api',
      'https://buoh-api.onrender.com?x=1',
      'https://Buoh-Api.onrender.com',
      'https://buoh-api.onrender.com:443',
      'https://usuario@buoh-api.onrender.com',
      'ftp://buoh-api.onrender.com',
    ]) {
      expect(rejected({ ...TEST_ENV, BUOH_API_ORIGIN: origin }), String(origin)).toEqual([
        'BUOH_API_ORIGIN',
      ]);
    }
    expect(
      rejected({ ...PRODUCTION_ENV, BUOH_API_ORIGIN: 'http://buoh-api.onrender.com' }),
    ).toEqual(['BUOH_API_ORIGIN']);
    expect(loadApiConfig({ ...TEST_ENV, BUOH_API_ORIGIN: 'https://localhost:8443' }).origin).toBe(
      'https://localhost:8443',
    );
  });

  it('en production solo se conecta como buoh_api, con TLS', () => {
    for (const user of ['buoh', 'buoh_dueno', 'postgres', undefined]) {
      expect(rejected({ ...PRODUCTION_ENV, BUOH_POSTGRES_USER: user }), String(user)).toEqual([
        'BUOH_POSTGRES_USER',
      ]);
    }
    for (const sslMode of ['disable', undefined]) {
      expect(rejected({ ...PRODUCTION_ENV, BUOH_POSTGRES_SSLMODE: sslMode })).toEqual([
        'BUOH_POSTGRES_SSLMODE',
      ]);
    }
    expect(rejected({ ...PRODUCTION_ENV, BUOH_POSTGRES_PASSWORD: undefined })).toEqual([
      'BUOH_POSTGRES_PASSWORD',
    ]);
  });

  it('nombra todas las variables rechazadas, ordenadas, sin sus valores', () => {
    const secretValue = 'valor-secreto-9c1d';
    let message = '';
    try {
      loadApiConfig({
        BUOH_DEPLOYMENT_ENVIRONMENT: secretValue,
        PORT: secretValue,
        BUOH_API_TOKEN_KEY: secretValue,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConfigError);
      expect((error as ApiConfigError).variables).toEqual([
        'BUOH_API_ORIGIN',
        'BUOH_API_PASSWORD_PEPPER',
        'BUOH_API_TOKEN_KEY',
        'BUOH_API_TOTP_KEY',
        'BUOH_DEPLOYMENT_ENVIRONMENT',
        'BUOH_POSTGRES_PASSWORD',
        'PORT',
      ]);
      message = (error as Error).message;
    }
    expect(message).toBe(
      'Configuración inválida o ausente: BUOH_API_ORIGIN, BUOH_API_PASSWORD_PEPPER, BUOH_API_TOKEN_KEY, BUOH_API_TOTP_KEY, BUOH_DEPLOYMENT_ENVIRONMENT, BUOH_POSTGRES_PASSWORD, PORT.',
    );
    expect(message).not.toContain(secretValue);
  });
});
