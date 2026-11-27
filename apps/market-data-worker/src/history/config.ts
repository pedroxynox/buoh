import { z } from 'zod';

import { loadBatchConfig } from '../batch/command.js';
import { ConfigError, POSTGRES_SSL_MODES, type WorkerConfig } from '../config.js';
import { BATCH_ROLE, MIN_ROLE_PASSWORD_LENGTH, PUBLICATION_ROLE } from '../postgres/roles.js';

// La configuración del comando de la historia (precisión del PR 6c de ADR-0021 §9), para su proceso
// temporal. Como en `buoh-operaciones` (ADR-0018 §11), cada credencial tiene su propio nombre y el
// proceso no tiene ninguna variable `BUOH_POSTGRES_*` ni `BUOH_S3_*`: con `buoh_lotes` y el token
// `lotes` descarga en sus logs, como `batch`, y le da a `datasets:publish` solo `buoh_publicacion` y
// el token `operaciones`, como el paso 6. No recibe la credencial dueña: los logs de las historias los
// prepara `buoh-operaciones`. No hace falta ninguna credencial nueva.

const nonEmpty = z.string().min(1);
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
const rolePassword = z
  .string()
  .min(MIN_ROLE_PASSWORD_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);

const historyEnvironmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: z.literal('production'),
  /** La base de producción, sin usuario ni contraseña: los de cada rol van aparte. */
  BUOH_HISTORIA_POSTGRES_DB: nonEmpty,
  BUOH_HISTORIA_POSTGRES_HOST: nonEmpty,
  BUOH_HISTORIA_POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535),
  /** Nunca `disable`, como en `buoh-operaciones`. */
  BUOH_HISTORIA_POSTGRES_SSLMODE: z.enum(POSTGRES_SSL_MODES).exclude(['disable']),
  /** La contraseña de `buoh_lotes` (ADR-0021 §3), la que tiene en `buoh-operaciones`. */
  BUOH_LOTES_POSTGRES_PASSWORD: rolePassword,
  BUOH_LOTES_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_LOTES_S3_BUCKET: bucket,
  BUOH_LOTES_S3_ENDPOINT: z.url(),
  BUOH_LOTES_S3_REGION: nonEmpty,
  BUOH_LOTES_S3_SECRET_ACCESS_KEY: nonEmpty,
  /** La contraseña de `buoh_publicacion` (ADR-0020 §5), la que tiene en `buoh-operaciones`. */
  BUOH_PUBLICACION_POSTGRES_PASSWORD: rolePassword,
  /** El token `operaciones` de R2, con el que publica el paso 6. */
  BUOH_OPERACIONES_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_OPERACIONES_S3_BUCKET: bucket,
  BUOH_OPERACIONES_S3_ENDPOINT: z.url(),
  BUOH_OPERACIONES_S3_REGION: nonEmpty,
  BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY: nonEmpty,
});

/**
 * Las variables que el proceso no tiene: las que lee el worker, que solo da a `datasets:publish`, y
 * las de la credencial dueña, que no recibe.
 */
const REJECTED_VARIABLES = /^BUOH_(?:DUENO|POSTGRES|S3)_/u;

export interface HistoryConfig {
  /** La del log de cada historia: `buoh_lotes` y el token `lotes`, como `batch` (`loadBatchConfig`). */
  readonly download: WorkerConfig;
  /** El entorno explícito de `datasets:publish`: `buoh_publicacion` y el token `operaciones`. */
  readonly publish: Readonly<Record<string, string>>;
}

/**
 * Lee la configuración del comando de la historia de `env`. Una variable inválida o ausente, o una
 * `BUOH_POSTGRES_*`, `BUOH_S3_*` o `BUOH_DUENO_*` presente, lanza un solo `ConfigError` con los
 * nombres, nunca los valores.
 */
export function loadHistoryConfig(
  env: Readonly<Record<string, string | undefined>>,
): HistoryConfig {
  const parsed = historyEnvironmentSchema.safeParse(env);
  const rejected = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && REJECTED_VARIABLES.test(name)) {
      rejected.add(name);
    }
  }
  if (!parsed.success || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
  }
  const value = parsed.data;
  const database = {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_DB: value.BUOH_HISTORIA_POSTGRES_DB,
    BUOH_POSTGRES_HOST: value.BUOH_HISTORIA_POSTGRES_HOST,
    BUOH_POSTGRES_PORT: String(value.BUOH_HISTORIA_POSTGRES_PORT),
    BUOH_POSTGRES_SSLMODE: value.BUOH_HISTORIA_POSTGRES_SSLMODE,
  };
  const download = loadBatchConfig({
    ...database,
    BUOH_POSTGRES_PASSWORD: value.BUOH_LOTES_POSTGRES_PASSWORD,
    BUOH_POSTGRES_USER: BATCH_ROLE,
    BUOH_S3_ACCESS_KEY_ID: value.BUOH_LOTES_S3_ACCESS_KEY_ID,
    BUOH_S3_BUCKET: value.BUOH_LOTES_S3_BUCKET,
    BUOH_S3_ENDPOINT: value.BUOH_LOTES_S3_ENDPOINT,
    BUOH_S3_REGION: value.BUOH_LOTES_S3_REGION,
    BUOH_S3_SECRET_ACCESS_KEY: value.BUOH_LOTES_S3_SECRET_ACCESS_KEY,
  });
  return {
    download,
    publish: {
      ...database,
      BUOH_POSTGRES_PASSWORD: value.BUOH_PUBLICACION_POSTGRES_PASSWORD,
      BUOH_POSTGRES_USER: PUBLICATION_ROLE,
      BUOH_S3_ACCESS_KEY_ID: value.BUOH_OPERACIONES_S3_ACCESS_KEY_ID,
      BUOH_S3_BUCKET: value.BUOH_OPERACIONES_S3_BUCKET,
      BUOH_S3_ENDPOINT: value.BUOH_OPERACIONES_S3_ENDPOINT,
      BUOH_S3_REGION: value.BUOH_OPERACIONES_S3_REGION,
      BUOH_S3_SECRET_ACCESS_KEY: value.BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY,
    },
  };
}
