import { deploymentEnvironmentSchema, type DeploymentEnvironment } from '@buoh/contracts';
import { z } from 'zod';

/**
 * Configuración por variables de entorno `BUOH_*`. Los secretos solo llegan por entorno y nunca se
 * incluyen en mensajes de error: un fallo informa nombres de variables, no valores.
 */
const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(65_535);

const environmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: deploymentEnvironmentSchema,
  BUOH_POSTGRES_DB: nonEmpty.default('buoh'),
  BUOH_POSTGRES_HOST: nonEmpty.default('127.0.0.1'),
  BUOH_POSTGRES_PASSWORD: nonEmpty,
  BUOH_POSTGRES_PORT: port.default(5432),
  /** Esquema PostgreSQL; las pruebas de integración usan uno propio. */
  BUOH_POSTGRES_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/u)
    .default('public'),
  BUOH_POSTGRES_USER: nonEmpty.default('buoh'),
  BUOH_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
    .default('buoh-local'),
  BUOH_S3_ENDPOINT: z.url().default('http://127.0.0.1:8333'),
  BUOH_S3_REGION: nonEmpty.default('us-east-1'),
  BUOH_S3_SECRET_ACCESS_KEY: nonEmpty,
});

export interface WorkerConfig {
  readonly environment: DeploymentEnvironment;
  readonly postgres: {
    readonly database: string;
    readonly host: string;
    readonly password: string;
    readonly port: number;
    readonly schema: string;
    readonly user: string;
  };
  readonly s3: {
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly region: string;
    readonly secretAccessKey: string;
  };
}

export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Configuración inválida o ausente: ${variables.join(', ')}.`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort(),
    );
  }
  const value = parsed.data;
  return {
    environment: value.BUOH_DEPLOYMENT_ENVIRONMENT,
    postgres: {
      database: value.BUOH_POSTGRES_DB,
      host: value.BUOH_POSTGRES_HOST,
      password: value.BUOH_POSTGRES_PASSWORD,
      port: value.BUOH_POSTGRES_PORT,
      schema: value.BUOH_POSTGRES_SCHEMA,
      user: value.BUOH_POSTGRES_USER,
    },
    s3: {
      accessKeyId: value.BUOH_S3_ACCESS_KEY_ID,
      bucket: value.BUOH_S3_BUCKET,
      endpoint: value.BUOH_S3_ENDPOINT,
      region: value.BUOH_S3_REGION,
      secretAccessKey: value.BUOH_S3_SECRET_ACCESS_KEY,
    },
  };
}
