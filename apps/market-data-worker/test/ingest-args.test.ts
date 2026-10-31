import { describe, expect, it } from 'vitest';

import {
  checkIngestConfig,
  IngestConfigError,
  INGEST_USAGE,
  loadConfig,
  parseIngestArgs,
  UsageError,
} from '../src/index.js';

// Los argumentos y la configuración de `ingest` (ADR-0015 §7), sin red ni servicios: las dos
// comprobaciones corren antes de abrir ningún almacén o conexión. Ninguna credencial es real.

describe('parseIngestArgs', () => {
  it('exige --live, y sin él es un error de uso que lo pide y da el uso', () => {
    expect(() => parseIngestArgs([])).toThrow(UsageError);
    expect(() => parseIngestArgs(['--symbol', 'R_100'])).toThrow(/--live/u);
    expect(() => parseIngestArgs([])).toThrow(INGEST_USAGE);
  });

  it('usa R_100 por defecto, tolera el separador -- que reenvía pnpm y admite otro símbolo', () => {
    expect(parseIngestArgs(['--live'])).toEqual({ symbol: 'R_100' });
    expect(parseIngestArgs(['--', '--live'])).toEqual({ symbol: 'R_100' });
    expect(parseIngestArgs(['--live', '--symbol', '1HZ100V'])).toEqual({ symbol: '1HZ100V' });
  });

  it('el símbolo sigue la regla del smoke: rechaza lo que nunca es un código', () => {
    for (const symbol of ['', 'R 100', 'R-100', 'R_100;', 'x'.repeat(65)]) {
      expect(() => parseIngestArgs(['--live', '--symbol', symbol])).toThrow(UsageError);
      expect(() => parseIngestArgs(['--live', '--symbol', symbol])).toThrow(/--symbol/u);
    }
  });

  it('rechaza las opciones del smoke, las desconocidas y los argumentos sueltos', () => {
    for (const args of [
      ['--duration-seconds', '120'],
      ['--interrupt-after-seconds', '30'],
      ['--verbose'],
      ['R_100'],
    ]) {
      expect(() => parseIngestArgs(['--live', ...args])).toThrow(UsageError);
    }
  });
});

/** Las variables mínimas, con valores sintéticos, de una captura con su esquema y su bucket. */
const BASE = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
  BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
  BUOH_POSTGRES_SCHEMA: 'buoh_captura',
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
};

/** Las variables que `checkIngestConfig` rechaza con `env`, o `[]` si la admite. */
function rejected(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  try {
    checkIngestConfig(loadConfig(env), env);
    return [];
  } catch (error) {
    if (error instanceof IngestConfigError) {
      return error.variables;
    }
    throw error;
  }
}

/**
 * Las variables de `production` (ADR-0018 §4): con el cifrado que exige loadConfig en un despliegue
 * (§9), el bucket de la captura y sin `BUOH_POSTGRES_SCHEMA`.
 */
const PRODUCTION = {
  ...BASE,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
};

describe('checkIngestConfig (ADR-0015 §7 y ADR-0018 §4)', () => {
  it('admite development y test con un esquema y un bucket propios', () => {
    expect(rejected(BASE)).toEqual([]);
    expect(rejected({ ...BASE, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' })).toEqual([]);
  });

  it('admite production con el bucket de la captura y sin BUOH_POSTGRES_SCHEMA: el esquema sale del log activo', () => {
    expect(rejected(PRODUCTION)).toEqual([]);
    expect(rejected({ ...PRODUCTION, BUOH_POSTGRES_SSLMODE: 'verify-full' })).toEqual([]);
  });

  it('en production rechaza BUOH_POSTGRES_SCHEMA, con cualquier valor, también el de un log', () => {
    for (const schema of ['buoh_log_000001', 'buoh_captura', 'public']) {
      expect(rejected({ ...PRODUCTION, BUOH_POSTGRES_SCHEMA: schema })).toEqual([
        'BUOH_POSTGRES_SCHEMA',
      ]);
    }
  });

  it('en production rechaza el bucket buoh-local, también sin la variable', () => {
    expect(rejected({ ...PRODUCTION, BUOH_S3_BUCKET: 'buoh-local' })).toEqual(['BUOH_S3_BUCKET']);
    expect(rejected({ ...PRODUCTION, BUOH_S3_BUCKET: undefined })).toEqual(['BUOH_S3_BUCKET']);
  });

  it('rechaza BUOH_DEPLOYMENT_ENVIRONMENT staging: no existe en la Fase 2', () => {
    expect(
      rejected({
        ...BASE,
        BUOH_DEPLOYMENT_ENVIRONMENT: 'staging',
        BUOH_POSTGRES_SSLMODE: 'require',
      }),
    ).toEqual(['BUOH_DEPLOYMENT_ENVIRONMENT']);
  });

  it('rechaza el esquema public, también sin la variable, porque es su valor por defecto', () => {
    expect(rejected({ ...BASE, BUOH_POSTGRES_SCHEMA: 'public' })).toEqual(['BUOH_POSTGRES_SCHEMA']);
    expect(rejected({ ...BASE, BUOH_POSTGRES_SCHEMA: undefined })).toEqual([
      'BUOH_POSTGRES_SCHEMA',
    ]);
  });

  it('rechaza el bucket buoh-local, también sin la variable, porque es su valor por defecto', () => {
    expect(rejected({ ...BASE, BUOH_S3_BUCKET: 'buoh-local' })).toEqual(['BUOH_S3_BUCKET']);
    expect(rejected({ ...BASE, BUOH_S3_BUCKET: undefined })).toEqual(['BUOH_S3_BUCKET']);
  });

  it('nombra todas las variables rechazadas, en orden, y su mensaje solo lleva sus nombres, nunca un valor', () => {
    const env = {
      ...BASE,
      BUOH_DEPLOYMENT_ENVIRONMENT: 'staging',
      BUOH_POSTGRES_HOST: 'db.interno.invalid',
      BUOH_POSTGRES_SCHEMA: undefined,
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_S3_BUCKET: undefined,
      BUOH_S3_ENDPOINT: 'https://objetos.interno.invalid',
    };
    let error: unknown = null;
    try {
      checkIngestConfig(loadConfig(env), env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IngestConfigError);
    const { message, name, variables } = error as IngestConfigError;
    expect(name).toBe('IngestConfigError');
    expect(variables).toEqual([
      'BUOH_DEPLOYMENT_ENVIRONMENT',
      'BUOH_POSTGRES_SCHEMA',
      'BUOH_S3_BUCKET',
    ]);
    for (const variable of variables) {
      expect(message).toContain(variable);
    }
    for (const value of [
      'staging',
      'production',
      'public',
      'buoh-local',
      'db.interno.invalid',
      'objetos.interno.invalid',
      'contraseña-sintética',
      'clave-sintética',
      'secreto-sintético',
    ]) {
      expect(message).not.toContain(value);
    }
  });
});
