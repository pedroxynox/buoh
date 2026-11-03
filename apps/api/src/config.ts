import { z } from 'zod';

import { ApiConfigError, apiEnvironmentSchema, type ApiEnvironment } from './environment.js';
import { loadPostgresConfig, type PostgresConfig } from './postgres/config.js';

export { ApiConfigError, apiEnvironmentSchema, type ApiEnvironment } from './environment.js';

/** Render da a cada servicio web su puerto en `PORT`, y 10000 si no lo cambia. */
export const DEFAULT_PORT = 10_000;

/** El único usuario de PostgreSQL de la API en `production` (ADR-0019 §7). */
export const API_POSTGRES_USER = 'buoh_api';

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
 * Lee la configuración de `env`. `BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria y no admite
 * `staging`. Son obligatorias también:
 * - `BUOH_API_ORIGIN`, un origen exacto, y en `production` con `https`;
 * - las tres claves, cada una de 32 bytes en base64 canónico y distinta de las otras dos;
 * - la conexión a PostgreSQL de `loadPostgresConfig`, y en `production` con el usuario `buoh_api`.
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
  };
}
