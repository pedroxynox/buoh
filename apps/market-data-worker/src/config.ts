import { deploymentEnvironmentSchema, type DeploymentEnvironment } from '@buoh/contracts';
import { z } from 'zod';

/**
 * Configuración por variables de entorno `BUOH_*`. Los secretos solo llegan por entorno y nunca se
 * incluyen en mensajes de error: un fallo informa nombres de variables, no valores.
 */
const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(65_535);

/** Esquema PostgreSQL sin `BUOH_POSTGRES_SCHEMA`. `ingest` no lo admite (ADR-0015 §7). */
export const DEFAULT_POSTGRES_SCHEMA = 'public';
/** Bucket sin `BUOH_S3_BUCKET`, el de los datos sintéticos. `ingest` no lo admite (ADR-0015 §7). */
export const DEFAULT_S3_BUCKET = 'buoh-local';

/**
 * Un nombre de PostgreSQL que buoh admite para un esquema o un rol: de 1 a 63 caracteres entre
 * minúsculas, cifras y `_`, sin empezar con una cifra. Con él, el nombre nunca necesita comillas ni
 * cambia al pasar sin ellas.
 */
export const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/**
 * Cifrado de la conexión a PostgreSQL, con los nombres de `sslmode` (ADR-0018 §9): `disable`, sin
 * TLS; `require`, con TLS y sin verificar el certificado, el de la conexión interna de Render, cuyo
 * certificado es autofirmado; y `verify-full`, con TLS, la autoridad y el nombre del servidor
 * verificados. Ni `require` ni `verify-full` vuelven a una conexión sin cifrar si el servidor no
 * admite TLS.
 */
export const POSTGRES_SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

/** Entornos desplegados: en ellos `BUOH_POSTGRES_SSLMODE` es obligatoria y no admite `disable`. */
const DEPLOYED_ENVIRONMENTS: ReadonlySet<string> = new Set<DeploymentEnvironment>([
  'production',
  'staging',
]);

/** Si el valor de `BUOH_DEPLOYMENT_ENVIRONMENT` es un entorno desplegado: `production` o `staging`. */
export function isDeployedEnvironment(environment: string | undefined): boolean {
  return DEPLOYED_ENVIRONMENTS.has(environment ?? '');
}

const environmentSchema = z.object({
  BUOH_DEPLOYMENT_ENVIRONMENT: deploymentEnvironmentSchema,
  BUOH_POSTGRES_DB: nonEmpty.default('buoh'),
  BUOH_POSTGRES_HOST: nonEmpty.default('127.0.0.1'),
  BUOH_POSTGRES_PASSWORD: nonEmpty,
  BUOH_POSTGRES_PORT: port.default(5432),
  BUOH_POSTGRES_SSLMODE: z.enum(POSTGRES_SSL_MODES).optional(),
  /** Esquema PostgreSQL; las pruebas de integración usan uno propio. */
  BUOH_POSTGRES_SCHEMA: z.string().regex(POSTGRES_IDENTIFIER).default(DEFAULT_POSTGRES_SCHEMA),
  BUOH_POSTGRES_USER: nonEmpty.default('buoh'),
  BUOH_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
    .default(DEFAULT_S3_BUCKET),
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
    /** El cifrado de la conexión (`BUOH_POSTGRES_SSLMODE`); `disable` por defecto fuera de un despliegue. */
    readonly sslMode: PostgresSslMode;
    readonly user: string;
  };
  readonly s3: {
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly endpoint: string;
    /**
     * El prefijo de las claves del log en el bucket: vacío en la configuración, y el del log
     * activo en `production` (`logs/<n>/`, `withLog`; ADR-0018 §6).
     */
    readonly keyPrefix: string;
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

/**
 * Lee la configuración `BUOH_*` de `env`. Una variable inválida o ausente lanza `ConfigError` con
 * los nombres, nunca los valores. En `production` y `staging`, `BUOH_POSTGRES_SSLMODE` es
 * obligatoria y no admite `disable` (ADR-0018 §9): una conexión sin cifrar es un error de
 * configuración. Fuera de un despliegue, por defecto es `disable`, la de los servicios locales.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const parsed = environmentSchema.safeParse(env);
  const rejected = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  const deployed = isDeployedEnvironment(env['BUOH_DEPLOYMENT_ENVIRONMENT']);
  const sslMode = env['BUOH_POSTGRES_SSLMODE'];
  if (deployed && (sslMode === undefined || sslMode === 'disable')) {
    rejected.add('BUOH_POSTGRES_SSLMODE');
  }
  if (!parsed.success || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
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
      sslMode: value.BUOH_POSTGRES_SSLMODE ?? 'disable',
      user: value.BUOH_POSTGRES_USER,
    },
    s3: {
      accessKeyId: value.BUOH_S3_ACCESS_KEY_ID,
      bucket: value.BUOH_S3_BUCKET,
      endpoint: value.BUOH_S3_ENDPOINT,
      keyPrefix: '',
      region: value.BUOH_S3_REGION,
      secretAccessKey: value.BUOH_S3_SECRET_ACCESS_KEY,
    },
  };
}
