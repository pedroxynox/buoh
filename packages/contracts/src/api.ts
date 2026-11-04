import { z } from 'zod';

import { auditEventStructuralSchema } from './audit.js';
import { healthReportSchema } from './health.js';
import { utcTimestampMsSchema } from './scalars.js';

/**
 * Mensajes de la API de buoh (ADR-0019 §6; contratos de dominio, «Mensajes de la API»). Las rutas
 * van bajo `/api/v1/`, y la versión de un mensaje es la de su ruta: estos mensajes no llevan
 * `schema_version`. La API valida con ellos cada entrada y cada salida, y su OpenAPI se genera
 * desde ellos (`apps/api/generated/openapi.json`).
 */

/**
 * Códigos de error de la API, una lista cerrada. Cada PR de ADR-0019 §14 suma los que produce.
 * Los del esqueleto (PR 2):
 * - `invalid_request`: la petición no cumple su contrato (consulta, cuerpo o tipo de contenido), o
 *   el servidor HTTP la rechazó antes de llegar a una ruta;
 * - `not_found`: ninguna ruta atiende ese método y esa dirección;
 * - `internal`: un fallo del servidor, también una respuesta que no cumple su contrato.
 *
 * Los de los enlaces de alta y de restablecimiento (PR 4a):
 * - `csrf_rejected`: una petición que cambia algo sin el `Origin`, el `Sec-Fetch-Site` o el
 *   `Content-Type` de la propia web (ADR-0019 §2);
 * - `invalid_link`: el enlace no existe, venció, ya se usó o lo anuló otro más nuevo;
 * - `invalid_code`: el código de 6 cifras no corresponde al secreto TOTP del enlace;
 * - `password_rejected`: la contraseña nueva no cumple la política, con su motivo (§1);
 * - `rate_limited`: hay que esperar, con los segundos que faltan;
 * - `not_ready`: faltan las migraciones de la API (§7) y, en las rutas de datos (F2.4), también la
 *   credencial de lectura (§8);
 * - `postgres_unavailable`: PostgreSQL no responde.
 *
 * Los de las sesiones y el inicio de sesión (PR 4b):
 * - `unauthenticated`: la petición necesita una sesión y no la trae, o la que trae no vale (§2);
 * - `invalid_credentials`: el nombre, la contraseña o el código no valen; la respuesta nunca dice
 *   cuál (§1);
 * - `credential_disabled`: la credencial está deshabilitada por sus 100 fallos; solo lo recibe quien
 *   acierta la contraseña y el código (§1).
 */
export const API_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'internal',
  'csrf_rejected',
  'invalid_link',
  'invalid_code',
  'password_rejected',
  'rate_limited',
  'not_ready',
  'postgres_unavailable',
  'unauthenticated',
  'invalid_credentials',
  'credential_disabled',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

/**
 * Por qué se rechaza una contraseña nueva (ADR-0019 §1): menos de 15 caracteres o más de 128,
 * contados después de normalizarla a NFC; una contraseña común de la lista de bloqueo; o una que,
 * entera y sin distinguir mayúsculas, es una de las palabras del contexto: `buoh`, `deriv` o el
 * nombre de usuario con sus variantes. Como pide NIST, se compara la contraseña entera, nunca las
 * palabras que contiene.
 */
export const PASSWORD_REJECTION_REASONS = [
  'too_short',
  'too_long',
  'common_password',
  'context_words',
] as const;

export const passwordRejectionReasonSchema = z.enum(PASSWORD_REJECTION_REASONS);

const requestIdSchema = z.uuid();

/** Un error sin más campos que su código y el identificador de la petición. */
const plainErrorSchema = z.strictObject({
  code: z.enum([
    'invalid_request',
    'not_found',
    'internal',
    'csrf_rejected',
    'invalid_link',
    'invalid_code',
    'not_ready',
    'postgres_unavailable',
    'unauthenticated',
    'invalid_credentials',
    'credential_disabled',
  ]),
  request_id: requestIdSchema,
});

/** Hay que esperar: los segundos que faltan, de 1 a 3600, la espera más larga (ADR-0019 §1). */
const rateLimitedErrorSchema = z.strictObject({
  code: z.literal('rate_limited'),
  request_id: requestIdSchema,
  retry_after_seconds: z.number().int().min(1).max(3600),
});

/** La contraseña nueva no cumple la política, y la respuesta dice por qué (ADR-0019 §1). */
const passwordRejectedErrorSchema = z.strictObject({
  code: z.literal('password_rejected'),
  request_id: requestIdSchema,
  reason: passwordRejectionReasonSchema,
});

/**
 * El cuerpo de toda respuesta de error: el código y el identificador de la petición, nunca el
 * mensaje de un error interno ni su traza. `rate_limited` lleva además los segundos que faltan, y
 * `password_rejected`, su motivo.
 */
export const apiErrorSchema = z
  .strictObject({
    error: z.discriminatedUnion('code', [
      plainErrorSchema,
      rateLimitedErrorSchema,
      passwordRejectedErrorSchema,
    ]),
  })
  .meta({ id: 'ApiError', title: 'ApiError' });

/** La respuesta de `GET /api/salud` cuando el proceso responde (ADR-0019 §7). */
export const apiHealthSchema = z
  .strictObject({
    status: z.literal('ok'),
  })
  .meta({ id: 'ApiHealth', title: 'ApiHealth' });

/**
 * El nombre de usuario de una cuenta (ADR-0019 §3): de 3 a 32 caracteres entre minúsculas sin
 * acentos, cifras, `-` y `_`.
 */
export const usernameSchema = z.string().regex(/^[a-z0-9_-]{3,32}$/u);

/**
 * El token de un enlace de alta o de restablecimiento: 32 bytes aleatorios en base64url, sin
 * relleno. Son 43 caracteres, y el último solo lleva 4 bits seguidos de dos ceros, así que es uno
 * de los 16 caracteres cuyo valor es múltiplo de 4: así cada token tiene una sola escritura.
 */
export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);

/** Para qué sirve un enlace: dar de alta la cuenta o restablecer su credencial (ADR-0019 §3). */
export const linkPurposeSchema = z.enum(['enrollment', 'reset']);

/** Un código de 6 cifras de la app de autenticación (TOTP, ADR-0019 §1). */
export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/u);

/** El secreto TOTP en base32 (RFC 4648), sin relleno: 20 bytes son 32 caracteres. */
const totpSecretSchema = z.string().regex(/^[A-Z2-7]{32}$/u);

/** `POST /api/v1/enlace/secreto`: pide un secreto TOTP nuevo para un enlace (ADR-0019 §3). */
export const linkSecretRequestSchema = z
  .strictObject({ token: linkTokenSchema })
  .meta({ id: 'LinkSecretRequest', title: 'LinkSecretRequest' });

/**
 * La respuesta de `POST /api/v1/enlace/secreto`: el secreto TOTP nuevo, una sola vez, en texto y en
 * la URI `otpauth://` que lee la app de autenticación, con el propósito del enlace, su cuenta y su
 * vencimiento. La URI repite exactamente el usuario y el secreto, con SHA-1, 6 cifras y pasos de
 * 30 s (ADR-0019 §1).
 */
export const linkSecretSchema = z
  .strictObject({
    purpose: linkPurposeSchema,
    username: usernameSchema,
    expires_at_utc: utcTimestampMsSchema,
    totp: z.strictObject({
      secret: totpSecretSchema,
      uri: z.string().startsWith('otpauth://totp/buoh:'),
    }),
  })
  .superRefine((value, context) => {
    if (value.totp.uri !== totpUri(value.username, value.totp.secret)) {
      context.addIssue({
        code: 'custom',
        message: 'La URI no corresponde al usuario y al secreto.',
        path: ['totp', 'uri'],
      });
    }
  })
  .meta({ id: 'LinkSecret', title: 'LinkSecret' });

/**
 * La URI `otpauth://` de un secreto TOTP de buoh, con el formato de las apps de autenticación
 * (*Key Uri Format*): la etiqueta `buoh:<usuario>`, el emisor y los parámetros de ADR-0019 §1.
 */
export function totpUri(username: string, secret: string): string {
  return `otpauth://totp/buoh:${username}?secret=${secret}&issuer=buoh&algorithm=SHA1&digits=6&period=30`;
}

/**
 * La contraseña que llega en una petición: el uso de un enlace (`POST /api/v1/enlace`) y el inicio
 * de sesión (`POST /api/v1/sesion`). Admite hasta 1024 caracteres, contados por punto de código,
 * como en Zod y en el JSON Schema, y tiene que ser texto Unicode bien formado: un sustituto suelto
 * se convertiría en otro carácter al pasar a UTF-8. La política de §1, con su motivo, decide después
 * si vale (en el alta y el restablecimiento), y en el inicio de sesión solo cuenta si acierta.
 */
export const passwordFieldSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.isWellFormed(), 'La contraseña debe ser texto Unicode bien formado.');

/**
 * `POST /api/v1/enlace`: usa el enlace con la contraseña nueva y un código del último secreto TOTP
 * que dio `POST /api/v1/enlace/secreto` (ADR-0019 §3).
 */
export const linkUseRequestSchema = z
  .strictObject({
    token: linkTokenSchema,
    password: passwordFieldSchema,
    code: totpCodeSchema,
  })
  .meta({ id: 'LinkUseRequest', title: 'LinkUseRequest' });

/** La respuesta de `POST /api/v1/enlace`: la cuenta quedó dada de alta o su credencial, restablecida. */
export const linkUseSchema = z
  .strictObject({
    result: z.enum(['account_enrolled', 'credential_reset']),
  })
  .meta({ id: 'LinkUse', title: 'LinkUse' });

// --- PR 4b: sesiones, cierre y auditoría (ADR-0019 §2 y §5) ---

/** El token CSRF de una sesión: el HMAC-SHA-256 de su identificador, en hexadecimal (ADR-0019 §2). */
export const csrfTokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * `POST /api/v1/sesion`: inicia sesión con el nombre de usuario, la contraseña y un código de 6
 * cifras (ADR-0019 §1 y §2), los tres en el mismo formulario. Ante cualquier dato incorrecto, la
 * respuesta es siempre `invalid_credentials`, sin decir cuál falló.
 */
export const sessionLoginRequestSchema = z
  .strictObject({
    username: usernameSchema,
    password: passwordFieldSchema,
    code: totpCodeSchema,
  })
  .meta({ id: 'SessionLoginRequest', title: 'SessionLoginRequest' });

/**
 * La respuesta del inicio de sesión y de `GET /api/v1/sesion`: el token CSRF de la sesión, que la
 * web manda en `X-CSRF-Token` en cada petición que cambia algo (ADR-0019 §2). El identificador de la
 * sesión no va aquí: viaja en la cookie `__Host-Http-buoh_sesion`, que el navegador no deja leer
 * desde JavaScript. La web lo recupera con `GET /api/v1/sesion` al abrir cada página.
 */
export const sessionInfoSchema = z
  .strictObject({ csrf_token: csrfTokenSchema })
  .meta({ id: 'SessionInfo', title: 'SessionInfo' });

/** El cuerpo vacío de una petición que solo necesita la sesión y el token CSRF (los cierres). */
export const emptyRequestSchema = z
  .strictObject({})
  .meta({ id: 'EmptyRequest', title: 'EmptyRequest' });

/**
 * La respuesta de un cierre: cuántas sesiones se cerraron (ADR-0019 §2). «Cerrar sesión» cierra la
 * actual (1), y «Cerrar las demás sesiones», las otras (de 0 a 9).
 */
export const sessionsClosedResultSchema = z
  .strictObject({ closed: z.number().int().min(0).max(1000) })
  .meta({ id: 'SessionsClosedResult', title: 'SessionsClosedResult' });

/**
 * La respuesta de `GET /api/v1/auditoria`: las entradas de la cuenta de la sesión, de la más nueva a
 * la más vieja (ADR-0019 §5). Nunca trae entradas sin cuenta ni las de otra cuenta.
 */
export const auditEventsResponseSchema = z
  .strictObject({ events: z.array(auditEventStructuralSchema) })
  .meta({ id: 'AuditEvents', title: 'AuditEvents' });

// --- F2.4: las lecturas del sistema de datos (ADR-0019 §8) ---

/** El mayor número de un log de producción: seis cifras (ADR-0018 §6). */
const MAX_LOG_NUMBER = 999_999;

/**
 * Un código saneado de un informe de `buoh-operaciones` (ADR-0018 §11): letras, cifras, `_`, `.` y
 * `-`, de 1 a 64, como `child_timeout`, `health_command_failed`, `ConfigError` o un SQLSTATE. Nunca
 * un mensaje.
 */
const operationsCodeSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u);

/**
 * La respuesta de `GET /api/v1/datos/salud` (ADR-0019 §8): la salud de los datos, la última
 * observación que guardó `buoh-operaciones` en el log activo, con la hora en que la guardó, para que
 * se vea su frescura. La API no ejecuta `data:health`.
 * - `log`: el número del log activo, o `null` si no hay ninguno; entonces tampoco hay observación.
 * - `observation`: la última del log activo, o `null` si todavía no tiene ninguna, como justo
 *   después del corte semanal. Si la última falló, una anterior que terminó no la sustituye.
 *   - `completed` lleva el `HealthReport`, que puede no ser `healthy`, y las alertas que dejó
 *     `data:health`, con su evento y su motivo saneados: son la causa de un `paused` o un `failed`
 *     cuando no pudo observar el log, como `data_health_storage_unavailable`.
 *   - `failed` lleva el motivo por el que la salud no se pudo observar y, con
 *     `health_command_failed`, el código de la línea de error de `data:health`, o `null`.
 */
export const dataHealthSchema = z
  .strictObject({
    log: z.number().int().min(1).max(MAX_LOG_NUMBER).nullable(),
    observation: z
      .discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('completed'),
          observed_at_utc: utcTimestampMsSchema,
          // El esquema con sus reglas: el OpenAPI lo nombra HealthReport, como el estructural.
          report: healthReportSchema,
          alerts: z.array(
            z.strictObject({
              event: operationsCodeSchema,
              reason: operationsCodeSchema.nullable(),
            }),
          ),
        }),
        z.strictObject({
          status: z.literal('failed'),
          observed_at_utc: utcTimestampMsSchema,
          reason: operationsCodeSchema,
          code: operationsCodeSchema.nullable(),
        }),
      ])
      .nullable(),
  })
  .superRefine((value, context) => {
    if (value.log === null && value.observation !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Sin log activo no hay observación.',
        path: ['observation'],
      });
    }
  })
  .meta({ id: 'DataHealth', title: 'DataHealth' });

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiHealth = z.infer<typeof apiHealthSchema>;
export type PasswordRejectionReason = z.infer<typeof passwordRejectionReasonSchema>;
export type LinkPurpose = z.infer<typeof linkPurposeSchema>;
export type LinkSecretRequest = z.infer<typeof linkSecretRequestSchema>;
export type LinkSecret = z.infer<typeof linkSecretSchema>;
export type LinkUseRequest = z.infer<typeof linkUseRequestSchema>;
export type LinkUse = z.infer<typeof linkUseSchema>;
export type SessionLoginRequest = z.infer<typeof sessionLoginRequestSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type SessionsClosedResult = z.infer<typeof sessionsClosedResultSchema>;
export type AuditEventsResponse = z.infer<typeof auditEventsResponseSchema>;
export type DataHealth = z.infer<typeof dataHealthSchema>;
