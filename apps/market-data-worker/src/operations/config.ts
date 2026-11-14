import { z } from 'zod';

import { ConfigError, POSTGRES_SSL_MODES, type WorkerConfig } from '../config.js';
import {
  MIN_ROLE_PASSWORD_LENGTH,
  POSTGRES_ROLES,
  PUBLICATION_ROLE,
  type LoginRole,
} from '../postgres/roles.js';

// La configuración de `buoh-operaciones` (ADR-0018 §11): cada credencial tiene su propio nombre, para
// que ningún proceso tome la de otro por error, y el servicio no tiene ninguna variable con los
// nombres `BUOH_POSTGRES_*` ni `BUOH_S3_*` que lee el worker: solo se los da, cada uno con sus
// valores, a los procesos de `db:migrate` y de `data:health`.

const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(65_535);
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
/** Una contraseña de un rol de ejecución: ASCII imprimible sin espacios, de 16 caracteres o más. */
const rolePassword = z
  .string()
  .min(MIN_ROLE_PASSWORD_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);

const operationsEnvironmentSchema = z.object({
  /** El servicio solo existe en producción. */
  BUOH_DEPLOYMENT_ENVIRONMENT: z.literal('production'),
  /** La credencial dueña: el usuario por defecto de Render, miembro de `buoh_dueno` (§8). */
  BUOH_DUENO_POSTGRES_DB: nonEmpty,
  BUOH_DUENO_POSTGRES_HOST: nonEmpty,
  BUOH_DUENO_POSTGRES_PASSWORD: nonEmpty,
  BUOH_DUENO_POSTGRES_PORT: port,
  /** El cifrado de todas las conexiones del servicio y de sus procesos (§9): nunca `disable`. */
  BUOH_DUENO_POSTGRES_SSLMODE: z.enum(POSTGRES_SSL_MODES).exclude(['disable']),
  BUOH_DUENO_POSTGRES_USER: nonEmpty,
  /** Las contraseñas que el servicio pone a los roles de ejecución (§8). */
  BUOH_AGENTE_POSTGRES_PASSWORD: rolePassword,
  BUOH_INGESTA_POSTGRES_PASSWORD: rolePassword,
  BUOH_SALUD_POSTGRES_PASSWORD: rolePassword,
  /**
   * La contraseña de `buoh_api` (ADR-0019 §7), la que Render genera en `buoh-api` y le llega por
   * `fromService`. La trajo el PR 6 de ADR-0019 §14, junto con la compilación de la API; antes iba
   * en un objeto aparte (opcional), para que la prueba del Blueprint no la pidiera. Con ella, el
   * paso 1 crea el rol de la API, migra su esquema y le da sus privilegios; sin ella, no toca la API.
   */
  BUOH_API_POSTGRES_PASSWORD: rolePassword.optional(),
  /**
   * La contraseña de `buoh_api_lectura` (ADR-0019 §7 y §8), la que Render genera en `buoh-api` y le
   * llega por `fromService`, desde el primer PR de las lecturas de F2.4. Es opcional, como la de
   * `buoh_api`: con ella, el paso 1 crea el rol de lectura de la API y le pone esa contraseña; sin
   * ella, no lo toca.
   */
  BUOH_API_LECTURA_POSTGRES_PASSWORD: rolePassword.optional(),
  /**
   * La contraseña de `buoh_publicacion` (ADR-0020 §5), que Render genera en el propio servicio
   * (`generateValue`) desde el PR 4 de su §13. Es opcional, como las de la API: con ella, el paso 1
   * crea `buoh_datasets` y el rol, y corren los pasos 6 y 7; sin ella, no toca los datasets.
   */
  BUOH_PUBLICACION_POSTGRES_PASSWORD: rolePassword.optional(),
  /** El token `salud` de R2, de solo lectura, para el proceso de `data:health` (§10). */
  BUOH_SALUD_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_SALUD_S3_BUCKET: bucket,
  BUOH_SALUD_S3_ENDPOINT: z.url(),
  BUOH_SALUD_S3_REGION: nonEmpty,
  BUOH_SALUD_S3_SECRET_ACCESS_KEY: nonEmpty,
  /** El token `operaciones` de R2, el del propio servicio: la verificación por partes (§10). */
  BUOH_OPERACIONES_S3_ACCESS_KEY_ID: nonEmpty,
  BUOH_OPERACIONES_S3_BUCKET: bucket,
  BUOH_OPERACIONES_S3_ENDPOINT: z.url(),
  BUOH_OPERACIONES_S3_REGION: nonEmpty,
  BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY: nonEmpty,
});

/** Las variables que el worker lee y que el servicio no tiene (ADR-0018 §11). */
const WORKER_VARIABLES = /^BUOH_(?:POSTGRES|S3)_/u;

/** Un commit de Git en hexadecimal, como el que Render da en `RENDER_GIT_COMMIT`. */
export const CODE_VERSION = /^[0-9a-f]{7,64}$/u;

export interface OperationsConfig {
  /**
   * La contraseña que debe tener `buoh_api` (ADR-0019 §7), o `null` mientras el servicio no la
   * tiene: entonces el paso 1 no crea el rol ni migra el esquema de la API.
   */
  readonly apiPassword: string | null;
  /**
   * La contraseña que debe tener `buoh_api_lectura` (ADR-0019 §7 y §8), o `null` mientras el
   * servicio no la tiene: entonces el paso 1 no crea el rol de lectura de la API.
   */
  readonly apiReaderPassword: string | null;
  /**
   * El commit del código que corre, el de `RENDER_GIT_COMMIT`, que Render pone en cada servicio, o
   * `null` sin él. Un log que la publicación detuvo sigue detenido mientras el código es el mismo
   * (ADR-0020 §8): repetir con el mismo código no cambia nada.
   */
  readonly codeVersion: string | null;
  /** La conexión dueña, con el esquema `public`: los de los logs van con su nombre. */
  readonly owner: WorkerConfig['postgres'];
  /** La contraseña que debe tener cada rol de ejecución que inicia sesión. */
  readonly passwords: Readonly<Record<LoginRole, string>>;
  /**
   * La contraseña que debe tener `buoh_publicacion` (ADR-0020 §5), o `null` mientras el servicio
   * no la tiene: entonces no toca `buoh_datasets` ni corren los pasos 6 y 7.
   */
  readonly publicationPassword: string | null;
  /** El almacenamiento de objetos con el token `salud`, sin prefijo: lo pone `data:health`. */
  readonly healthObjects: Omit<WorkerConfig['s3'], 'keyPrefix'>;
  /**
   * El almacenamiento de objetos con el token `operaciones`, sin prefijo: la verificación por partes
   * lee cada log bajo el suyo.
   */
  readonly operationsObjects: Omit<WorkerConfig['s3'], 'keyPrefix'>;
}

/**
 * Lee la configuración de `buoh-operaciones` de `env` (ADR-0018 §11). Una variable inválida o ausente
 * lanza `ConfigError` con los nombres, nunca los valores, igual que una variable `BUOH_POSTGRES_*` o
 * `BUOH_S3_*` presente: el servicio no tiene ninguna, para que sus procesos solo reciban las que les
 * da.
 */
export function loadOperationsConfig(
  env: Readonly<Record<string, string | undefined>>,
): OperationsConfig {
  const parsed = operationsEnvironmentSchema.safeParse(env);
  const rejected = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && WORKER_VARIABLES.test(name)) {
      rejected.add(name);
    }
  }
  if (!parsed.success || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
  }
  const value = parsed.data;
  return {
    apiPassword: value.BUOH_API_POSTGRES_PASSWORD ?? null,
    apiReaderPassword: value.BUOH_API_LECTURA_POSTGRES_PASSWORD ?? null,
    codeVersion: CODE_VERSION.test(env['RENDER_GIT_COMMIT'] ?? '')
      ? (env['RENDER_GIT_COMMIT'] ?? null)
      : null,
    healthObjects: {
      accessKeyId: value.BUOH_SALUD_S3_ACCESS_KEY_ID,
      bucket: value.BUOH_SALUD_S3_BUCKET,
      endpoint: value.BUOH_SALUD_S3_ENDPOINT,
      region: value.BUOH_SALUD_S3_REGION,
      secretAccessKey: value.BUOH_SALUD_S3_SECRET_ACCESS_KEY,
    },
    operationsObjects: {
      accessKeyId: value.BUOH_OPERACIONES_S3_ACCESS_KEY_ID,
      bucket: value.BUOH_OPERACIONES_S3_BUCKET,
      endpoint: value.BUOH_OPERACIONES_S3_ENDPOINT,
      region: value.BUOH_OPERACIONES_S3_REGION,
      secretAccessKey: value.BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY,
    },
    owner: {
      database: value.BUOH_DUENO_POSTGRES_DB,
      host: value.BUOH_DUENO_POSTGRES_HOST,
      password: value.BUOH_DUENO_POSTGRES_PASSWORD,
      port: value.BUOH_DUENO_POSTGRES_PORT,
      schema: 'public',
      sslMode: value.BUOH_DUENO_POSTGRES_SSLMODE,
      user: value.BUOH_DUENO_POSTGRES_USER,
    },
    passwords: {
      [POSTGRES_ROLES.agent]: value.BUOH_AGENTE_POSTGRES_PASSWORD,
      [POSTGRES_ROLES.health]: value.BUOH_SALUD_POSTGRES_PASSWORD,
      [POSTGRES_ROLES.ingest]: value.BUOH_INGESTA_POSTGRES_PASSWORD,
    },
    publicationPassword: value.BUOH_PUBLICACION_POSTGRES_PASSWORD ?? null,
  };
}

/**
 * El entorno explícito del proceso de `db:migrate` sobre el esquema de un log (ADR-0018 §11): solo
 * la credencial dueña, con los nombres `BUOH_POSTGRES_*` que lee el worker, el esquema y el rol
 * dueño. No lleva nada más del servicio.
 */
export function migrateEnvironment(
  config: OperationsConfig,
  schema: string,
): Record<string, string> {
  return {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_DB: config.owner.database,
    BUOH_POSTGRES_HOST: config.owner.host,
    BUOH_POSTGRES_OWNER_ROLE: POSTGRES_ROLES.owner,
    BUOH_POSTGRES_PASSWORD: config.owner.password,
    BUOH_POSTGRES_PORT: String(config.owner.port),
    BUOH_POSTGRES_SCHEMA: schema,
    BUOH_POSTGRES_SSLMODE: config.owner.sslMode,
    BUOH_POSTGRES_USER: config.owner.user,
  };
}

/**
 * El entorno explícito del proceso de `db:migrate` de la API sobre el esquema `buoh_api`
 * (ADR-0019 §7): solo la credencial dueña, con los nombres `BUOH_POSTGRES_*` que lee la API, y el
 * rol dueño. No lleva la contraseña de `buoh_api` ni nada más del servicio.
 */
export function apiMigrateEnvironment(config: OperationsConfig): Record<string, string> {
  return {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_DB: config.owner.database,
    BUOH_POSTGRES_HOST: config.owner.host,
    BUOH_POSTGRES_OWNER_ROLE: POSTGRES_ROLES.owner,
    BUOH_POSTGRES_PASSWORD: config.owner.password,
    BUOH_POSTGRES_PORT: String(config.owner.port),
    BUOH_POSTGRES_SSLMODE: config.owner.sslMode,
    BUOH_POSTGRES_USER: config.owner.user,
  };
}

/**
 * El entorno explícito del proceso de `data:health` (ADR-0018 §11): solo el rol `buoh_salud` y el
 * token `salud`, con los nombres `BUOH_*` que lee el worker. No hereda las credenciales del
 * servicio.
 */
export function healthEnvironment(config: OperationsConfig): Record<string, string> {
  return {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_DB: config.owner.database,
    BUOH_POSTGRES_HOST: config.owner.host,
    BUOH_POSTGRES_PASSWORD: config.passwords[POSTGRES_ROLES.health],
    BUOH_POSTGRES_PORT: String(config.owner.port),
    BUOH_POSTGRES_SSLMODE: config.owner.sslMode,
    BUOH_POSTGRES_USER: POSTGRES_ROLES.health,
    BUOH_S3_ACCESS_KEY_ID: config.healthObjects.accessKeyId,
    BUOH_S3_BUCKET: config.healthObjects.bucket,
    BUOH_S3_ENDPOINT: config.healthObjects.endpoint,
    BUOH_S3_REGION: config.healthObjects.region,
    BUOH_S3_SECRET_ACCESS_KEY: config.healthObjects.secretAccessKey,
  };
}

/**
 * El entorno explícito del proceso de `datasets:publish` (ADR-0020 §8, paso 6): solo el rol
 * `buoh_publicacion` y el token `operaciones`, con los nombres `BUOH_*` que lee el worker, sin
 * esquema, porque la orden trabaja siempre sobre `buoh_datasets` y los logs. Necesita la contraseña
 * de `buoh_publicacion`.
 */
export function publishEnvironment(config: OperationsConfig): Record<string, string> {
  if (config.publicationPassword === null) {
    throw new TypeError('Sin la contraseña de buoh_publicacion no se publica.');
  }
  return {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_DB: config.owner.database,
    BUOH_POSTGRES_HOST: config.owner.host,
    BUOH_POSTGRES_PASSWORD: config.publicationPassword,
    BUOH_POSTGRES_PORT: String(config.owner.port),
    BUOH_POSTGRES_SSLMODE: config.owner.sslMode,
    BUOH_POSTGRES_USER: PUBLICATION_ROLE,
    BUOH_S3_ACCESS_KEY_ID: config.operationsObjects.accessKeyId,
    BUOH_S3_BUCKET: config.operationsObjects.bucket,
    BUOH_S3_ENDPOINT: config.operationsObjects.endpoint,
    BUOH_S3_REGION: config.operationsObjects.region,
    BUOH_S3_SECRET_ACCESS_KEY: config.operationsObjects.secretAccessKey,
  };
}

/**
 * El entorno explícito del proceso de `data:replay` del paso 7 (ADR-0020 §8): el de `data:health`,
 * con `buoh_salud` y el token `salud`, sin esquema: en `production`, `data:replay` lee siempre
 * `buoh_datasets` y el prefijo `datasets/`.
 */
export function replayEnvironment(config: OperationsConfig): Record<string, string> {
  return healthEnvironment(config);
}
