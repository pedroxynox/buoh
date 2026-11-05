import { z } from 'zod';

import { ApiConfigError, apiEnvironmentSchema, type ApiEnvironment } from './environment.js';
import { loadPostgresConfig, type PostgresConfig } from './postgres/config.js';

export { ApiConfigError, apiEnvironmentSchema, type ApiEnvironment } from './environment.js';

/** Render da a cada servicio web su puerto en `PORT`, y 10000 si no lo cambia. */
export const DEFAULT_PORT = 10_000;

/** El único usuario de PostgreSQL de la API en `production` (ADR-0019 §7). */
export const API_POSTGRES_USER = 'buoh_api';

/**
 * El usuario de las lecturas del sistema de datos (ADR-0019 §7 y §8), en todos los entornos: el rol
 * que `buoh-operaciones` crea, miembro de `buoh_lectura`. Solo su contraseña es configurable.
 */
export const API_READER_POSTGRES_USER = 'buoh_api_lectura';

/** La contraseña de `buoh_api_lectura`, que Render genera en `buoh-api` (`generateValue`). */
const READER_PASSWORD_VARIABLE = 'BUOH_API_LECTURA_POSTGRES_PASSWORD';

/**
 * El endpoint y las claves del token `api` de R2, de solo lectura sobre `buoh-captura` (ADR-0019 §8 y
 * §10), que el propietario pega en `buoh-api` (`sync: false`).
 */
const STORAGE_SECRET_VARIABLES = {
  endpoint: 'BUOH_API_S3_ENDPOINT',
  accessKeyId: 'BUOH_API_S3_ACCESS_KEY_ID',
  secretAccessKey: 'BUOH_API_S3_SECRET_ACCESS_KEY',
} as const;
/** El bucket y la región, con su valor en el Blueprint. */
const STORAGE_BUCKET_VARIABLE = 'BUOH_API_S3_BUCKET';
const STORAGE_REGION_VARIABLE = 'BUOH_API_S3_REGION';
/** Un nombre de bucket de S3 y de R2, como el que admite el worker en `BUOH_S3_BUCKET`. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;

const PORT_PATTERN = /^[1-9]\d{0,4}$/u;
/** 32 bytes en base64 con relleno, como los valores de `generateValue` de Render. */
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const KEY_BYTES = 32;

const environmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: apiEnvironmentSchema,
  PORT: z
    .string()
    .regex(PORT_PATTERN)
    .refine((value) => Number(value) <= 65_535)
    .optional(),
});

/** Las tres claves del servidor, que viven fuera de la base (ADR-0019 §1, §2 y §10). */
export interface ApiKeys {
  /** La entrada `secret` de Argon2id, `BUOH_API_PASSWORD_PEPPER`. */
  readonly passwordPepper: Buffer;
  /** La clave AES-256-GCM de los secretos TOTP, `BUOH_API_TOTP_KEY`. */
  readonly totpKey: Buffer;
  /** La clave de los HMAC de los enlaces y, desde el PR 4b, de las sesiones y del CSRF, `BUOH_API_TOKEN_KEY`. */
  readonly tokenKey: Buffer;
}

/**
 * La configuración de la API y de la orden `cuenta` (ADR-0019 §7 y §10), que corren con el mismo
 * entorno: el del servicio `buoh-api`.
 */
export interface ApiConfig {
  readonly environment: ApiEnvironment;
  /** `0.0.0.0` en `production`, donde Render envía el tráfico a la instancia; si no, `127.0.0.1`. */
  readonly host: string;
  readonly port: number;
  /** El origen público de la API, `BUOH_API_ORIGIN`: el de los enlaces y el que exige el CSRF. */
  readonly origin: string;
  readonly keys: ApiKeys;
  readonly postgres: PostgresConfig;
  /**
   * La conexión de las lecturas del sistema de datos (ADR-0019 §8): la de `postgres`, con el usuario
   * `buoh_api_lectura` y su contraseña, `BUOH_API_LECTURA_POSTGRES_PASSWORD`. `null` sin ella:
   * entonces las rutas de datos responden 503 `not_ready`, y lo demás de la API no cambia. Es
   * opcional para que un despliegue no falle si Render deja la variable pendiente de aprobar.
   */
  readonly reader: PostgresConfig | null;
  /**
   * El almacenamiento de objetos de la captura, con el token `api` de R2 (ADR-0019 §8). `null` sin
   * su endpoint ni sus claves: entonces las rutas que leen R2 responden 503 `not_ready`, y lo demás
   * de la API no cambia. Así el despliegue que las trae no falla antes de que el propietario pegue
   * el token.
   */
  readonly storage: StorageConfig | null;
}

/** El token `api` de R2 y dónde leer (ADR-0019 §8 y §10). */
export interface StorageConfig {
  /** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` en production: un origen, sin ruta. */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `buoh-captura` en production. */
  readonly bucket: string;
  /** `auto` en R2. */
  readonly region: string;
}

const KEY_VARIABLES = {
  passwordPepper: 'BUOH_API_PASSWORD_PEPPER',
  totpKey: 'BUOH_API_TOTP_KEY',
  tokenKey: 'BUOH_API_TOKEN_KEY',
} as const satisfies Record<keyof ApiKeys, string>;

/** Una clave: 32 bytes en base64 canónico, la escritura única de esos bytes. */
function parseKey(value: string | undefined): Buffer | null {
  if (value === undefined || !KEY_PATTERN.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === KEY_BYTES && bytes.toString('base64') === value ? bytes : null;
}

/** Un origen exacto, como lo envía el navegador en `Origin`: `http` o `https`, sin ruta. */
function parseOrigin(value: string | undefined): string | null {
  if (value === undefined || !URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
    ? value
    : null;
}

/**
 * El token `api` de R2 de `env`: `null` si no hay ninguna de sus tres variables. Con alguna, tienen
 * que estar las tres, no vacías, el endpoint como un origen exacto (con `https` en `production`), y
 * el bucket y la región; si no, suma a `rejected` las que faltan o no valen.
 */
function loadStorage(
  env: Readonly<Record<string, string | undefined>>,
  production: boolean,
  rejected: Set<string>,
): StorageConfig | null {
  const values = Object.values(STORAGE_SECRET_VARIABLES).map((name) => env[name]);
  if (values.every((value) => value === undefined)) {
    return null;
  }
  for (const name of Object.values(STORAGE_SECRET_VARIABLES)) {
    if (env[name] === undefined || env[name] === '') {
      rejected.add(name);
    }
  }
  const endpoint = parseOrigin(env[STORAGE_SECRET_VARIABLES.endpoint]);
  if (endpoint === null || (production && !endpoint.startsWith('https://'))) {
    rejected.add(STORAGE_SECRET_VARIABLES.endpoint);
  }
  const bucket = env[STORAGE_BUCKET_VARIABLE];
  if (bucket === undefined || !BUCKET_PATTERN.test(bucket)) {
    rejected.add(STORAGE_BUCKET_VARIABLE);
  }
  const region = env[STORAGE_REGION_VARIABLE];
  if (region === undefined || region === '') {
    rejected.add(STORAGE_REGION_VARIABLE);
  }
  const accessKeyId = env[STORAGE_SECRET_VARIABLES.accessKeyId];
  const secretAccessKey = env[STORAGE_SECRET_VARIABLES.secretAccessKey];
  if (
    endpoint === null ||
    accessKeyId === undefined ||
    accessKeyId === '' ||
    secretAccessKey === undefined ||
    secretAccessKey === '' ||
    bucket === undefined ||
    region === undefined
  ) {
    return null;
  }
  return { endpoint, accessKeyId, secretAccessKey, bucket, region };
}

/**
 * Lee la configuración de `env`. `BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria y no admite
 * `staging`. Son obligatorias también:
 * - `BUOH_API_ORIGIN`, un origen exacto, y en `production` con `https`;
 * - las tres claves, cada una de 32 bytes en base64 canónico y distinta de las otras dos;
 * - la conexión a PostgreSQL de `loadPostgresConfig`, y en `production` con el usuario `buoh_api`.
 *
 * `BUOH_API_LECTURA_POSTGRES_PASSWORD`, la contraseña de las lecturas del sistema de datos, es
 * opcional, pero no puede estar vacía. El token `api` de R2 (`BUOH_API_S3_ENDPOINT`,
 * `BUOH_API_S3_ACCESS_KEY_ID` y `BUOH_API_S3_SECRET_ACCESS_KEY`) también es opcional, pero va entero,
 * con `BUOH_API_S3_BUCKET` y `BUOH_API_S3_REGION` (`loadStorage`).
 *
 * Una variable inválida o ausente lanza `ApiConfigError` con los nombres de todas las rechazadas,
 * ordenados, nunca sus valores.
 */
export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const rejected = new Set<string>();
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      rejected.add(String(issue.path[0]));
    }
  }
  const production = env['BUOH_DEPLOYMENT_ENVIRONMENT'] === 'production';

  const origin = parseOrigin(env['BUOH_API_ORIGIN']);
  if (origin === null || (production && !origin.startsWith('https://'))) {
    rejected.add('BUOH_API_ORIGIN');
  }

  const keys: Partial<Record<keyof ApiKeys, Buffer>> = {};
  for (const [field, variable] of Object.entries(KEY_VARIABLES) as [keyof ApiKeys, string][]) {
    const key = parseKey(env[variable]);
    if (key === null) {
      rejected.add(variable);
    } else {
      keys[field] = key;
    }
  }
  const present = Object.entries(keys) as [keyof ApiKeys, Buffer][];
  for (const [index, [field, key]] of present.entries()) {
    for (const [otherField, other] of present.slice(index + 1)) {
      if (key.equals(other)) {
        rejected.add(KEY_VARIABLES[field]);
        rejected.add(KEY_VARIABLES[otherField]);
      }
    }
  }

  let postgres: PostgresConfig | null = null;
  try {
    postgres = loadPostgresConfig(env).postgres;
  } catch (error) {
    if (!(error instanceof ApiConfigError)) {
      throw error;
    }
    for (const variable of error.variables) {
      rejected.add(variable);
    }
  }
  if (production && postgres !== null && postgres.user !== API_POSTGRES_USER) {
    rejected.add('BUOH_POSTGRES_USER');
  }

  const readerPassword = env[READER_PASSWORD_VARIABLE];
  if (readerPassword === '') {
    rejected.add(READER_PASSWORD_VARIABLE);
  }
  const storage = loadStorage(env, production, rejected);

  const { passwordPepper, totpKey, tokenKey } = keys;
  if (
    !parsed.success ||
    rejected.size > 0 ||
    origin === null ||
    postgres === null ||
    passwordPepper === undefined ||
    totpKey === undefined ||
    tokenKey === undefined
  ) {
    throw new ApiConfigError([...rejected].sort());
  }
  const environment = parsed.data.BUOH_DEPLOYMENT_ENVIRONMENT;
  return {
    environment,
    host: environment === 'production' ? '0.0.0.0' : '127.0.0.1',
    port: parsed.data.PORT === undefined ? DEFAULT_PORT : Number(parsed.data.PORT),
    origin,
    keys: { passwordPepper, totpKey, tokenKey },
    postgres,
    reader:
      readerPassword === undefined
        ? null
        : { ...postgres, password: readerPassword, user: API_READER_POSTGRES_USER },
    storage,
  };
}
