import { z } from 'zod';

import { ApiConfigError, apiEnvironmentSchema, type ApiEnvironment } from '../environment.js';

/** El esquema de la API en `buoh-postgres` (ADR-0019 §7), aparte de los logs. Su dueño es `buoh_dueno`. */
export const API_SCHEMA = 'buoh_api';

/**
 * Un nombre de rol que la API admite: de 1 a 63 caracteres entre minúsculas, cifras y `_`, sin
 * empezar con una cifra, como en el worker. Con él, el nombre nunca necesita comillas ni cambia al
 * pasar sin ellas.
 */
export const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/**
 * El cifrado de la conexión, con los nombres de `sslmode` (ADR-0018 §9): `disable`, sin TLS;
 * `require`, con TLS y sin verificar el certificado, el de la dirección interna de Render; y
 * `verify-full`, con la autoridad y el nombre del servidor verificados. Ni `require` ni `verify-full`
 * vuelven a una conexión sin cifrar si el servidor no admite TLS.
 */
export const POSTGRES_SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

const nonEmpty = z.string().min(1);
const PORT_PATTERN = /^[1-9]\d{0,4}$/u;

const postgresEnvironmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: apiEnvironmentSchema,
  BUOH_POSTGRES_DB: nonEmpty.default('buoh'),
  BUOH_POSTGRES_HOST: nonEmpty.default('127.0.0.1'),
  BUOH_POSTGRES_PASSWORD: nonEmpty,
  BUOH_POSTGRES_PORT: z
    .string()
    .regex(PORT_PATTERN)
    .refine((value) => Number(value) <= 65_535)
    .optional(),
  BUOH_POSTGRES_SSLMODE: z.enum(POSTGRES_SSL_MODES).optional(),
  BUOH_POSTGRES_USER: nonEmpty.default('buoh'),
});

/** Una conexión a PostgreSQL. La contraseña nunca sale en un registro ni en un error. */
export interface PostgresConfig {
  readonly database: string;
  readonly host: string;
  readonly password: string;
  readonly port: number;
  readonly sslMode: PostgresSslMode;
  readonly user: string;
}

/**
 * Lee la conexión a PostgreSQL de `env` (ADR-0019 §7). `BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria
 * y no admite `staging`. En `production`, `BUOH_POSTGRES_SSLMODE` es obligatoria y no admite
 * `disable`: una conexión sin cifrar es un error de configuración. Fuera de `production` es
 * `disable` por defecto, la de los servicios locales. En todos los entornos, como en el worker, la
 * base, el servidor, el puerto y el usuario tienen por defecto los de los servicios locales
 * (`infra/.env.example`), y la contraseña siempre es obligatoria. Una variable inválida o ausente
 * lanza `ApiConfigError` con los nombres de todas las rechazadas, nunca sus valores.
 */
export function loadPostgresConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly environment: ApiEnvironment;
  readonly postgres: PostgresConfig;
} {
  const parsed = postgresEnvironmentSchema.safeParse(env);
  const rejected = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  const sslMode = env['BUOH_POSTGRES_SSLMODE'];
  if (
    env['BUOH_DEPLOYMENT_ENVIRONMENT'] === 'production' &&
    (sslMode === undefined || sslMode === 'disable')
  ) {
    rejected.add('BUOH_POSTGRES_SSLMODE');
  }
  if (!parsed.success || rejected.size > 0) {
    throw new ApiConfigError([...rejected].sort());
  }
  const value = parsed.data;
  return {
    environment: value.BUOH_DEPLOYMENT_ENVIRONMENT,
    postgres: {
      database: value.BUOH_POSTGRES_DB,
      host: value.BUOH_POSTGRES_HOST,
      password: value.BUOH_POSTGRES_PASSWORD,
      port: value.BUOH_POSTGRES_PORT === undefined ? 5432 : Number(value.BUOH_POSTGRES_PORT),
      sslMode: value.BUOH_POSTGRES_SSLMODE ?? 'disable',
      user: value.BUOH_POSTGRES_USER,
    },
  };
}
