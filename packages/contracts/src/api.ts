import { z } from 'zod';

import { auditEventStructuralSchema } from './audit.js';
import {
  conditionTypeSchema,
  limitUnitSchema,
  persistenceStageSchema,
  qualityIncidentTypeSchema,
  severitySchema,
  sourceResourceSchema,
} from './enums.js';
import { healthReportSchema } from './health.js';
import {
  conditionKeySchema,
  datasetIdSchema,
  decimalStringSchema,
  derivedEventIdSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';
import { derivActiveSymbolEntrySchema } from './source-catalog.js';

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
 *   credencial de lectura y, en las que leen R2, el token `api` (§8);
 * - `postgres_unavailable`: PostgreSQL no responde.
 *
 * Los de las sesiones y el inicio de sesión (PR 4b):
 * - `unauthenticated`: la petición necesita una sesión y no la trae, o la que trae no vale (§2);
 * - `invalid_credentials`: el nombre, la contraseña o el código no valen; la respuesta nunca dice
 *   cuál (§1);
 * - `credential_disabled`: la credencial está deshabilitada por sus 100 fallos; solo lo recibe quien
 *   acierta la contraseña y el código (§1).
 *
 * El de las lecturas de R2 de F2.4 (§8):
 * - `storage_unavailable`: el almacenamiento de objetos de la captura (R2) no responde.
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
  'storage_unavailable',
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
    'storage_unavailable',
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

/**
 * La ventana más larga del gráfico, en horas (ADR-0019 §8): la fija la medición de la memoria de la
 * API de F2.4 (`docs/operacion/evidencia-memoria-f2-4.md`).
 */
export const DATA_CHART_MAX_HOURS = 24;

/** Las horas de una ventana, de 1 a `DATA_CHART_MAX_HOURS`, como llegan en la consulta: texto. */
const HOURS_PATTERN = /^(?:[1-9]|1[0-9]|2[0-4])$/u;

/** `GET /api/v1/datos/grafico?hours=<n>`: las últimas `n` horas, de 1 a `DATA_CHART_MAX_HOURS`. */
export const dataChartQuerySchema = z.strictObject({
  hours: z.string().regex(HOURS_PATTERN),
});

const HOUR_MS = 3_600_000;

const chartCauses = ['connection_lost', 'capture_stopped'] as const;
const chartHistories = ['recovered', 'partial', 'unavailable', 'pending', 'not_requested'] as const;

/**
 * Un hueco del gráfico (ADR-0019 §8; concepto de interfaz §9): un período sin ticks del flujo que el
 * log registra, del high-watermark + 1 ms al primer tick posterior − 1 ms, o sin fin (`to_utc`
 * `null`) si todavía no llegó ninguno.
 * - `connection_lost`: tras un cierre no pedido. `history` dice qué trajo la historia: `recovered`,
 *   con los ticks que faltan en `recovered_ticks`, que el gráfico no dibuja; `partial` o
 *   `unavailable`, sin resolver, con el motivo de su `event_gap_unresolved` en `reason`; o `pending`,
 *   todavía sin resultado.
 * - `capture_stopped`: tras un cierre pedido, como el de un despliegue; `history` es
 *   `not_requested`, porque no se recupera.
 */
const chartGapSchema = z
  .strictObject({
    from_utc: utcTimestampMsSchema,
    to_utc: utcTimestampMsSchema.nullable(),
    cause: z.enum(chartCauses),
    history: z.enum(chartHistories),
    reason: operationsCodeSchema.nullable(),
    recovered_ticks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .superRefine((value, context) => {
    const issue = (message: string, path: string) => {
      context.addIssue({ code: 'custom', message, path: [path] });
    };
    if ((value.cause === 'capture_stopped') !== (value.history === 'not_requested')) {
      issue('Una parada pedida no se recupera, y solo ella.', 'history');
    }
    const unresolved = value.history === 'partial' || value.history === 'unavailable';
    if ((value.reason !== null) !== unresolved) {
      issue('Solo un hueco sin resolver lleva su motivo.', 'reason');
    }
    const recovered = value.history === 'recovered' || value.history === 'partial';
    if ((value.recovered_ticks !== null) !== recovered) {
      issue('Solo la historia que trajo ticks los cuenta.', 'recovered_ticks');
    }
    if (value.to_utc === null) {
      if (value.history !== 'pending' && value.history !== 'not_requested') {
        issue('Solo un hueco que sigue no tiene fin.', 'to_utc');
      }
    } else if (value.to_utc < value.from_utc) {
      issue('El hueco termina antes de empezar.', 'to_utc');
    }
  });

/**
 * La respuesta de `GET /api/v1/datos/grafico` (ADR-0019 §8): el gráfico de `symbol` en las últimas
 * horas del log activo, de `from_utc` a `to_utc`, la hora de la lectura.
 * - `log`: el número del log activo, o `null` si no hay ninguno; entonces no hay ticks ni huecos.
 * - `log_started_at_utc`: la hora del primer evento del log, o `null` si está vacío: antes de ella la
 *   ventana no tiene datos, como justo después del corte semanal.
 * - `ticks`: un tick por instante, en orden, cada uno a `offsets_ms` milisegundos de `from_utc`, con
 *   su cotización en decimal canónico en `quotes`, en la misma posición.
 * - `gaps`: los huecos que tocan la ventana, aunque empiecen antes, en orden de inicio.
 */
export const dataChartSchema = z
  .strictObject({
    log: z.number().int().min(1).max(MAX_LOG_NUMBER).nullable(),
    source: nonEmptyStringSchema,
    symbol: symbolSchema,
    from_utc: utcTimestampMsSchema,
    to_utc: utcTimestampMsSchema,
    log_started_at_utc: utcTimestampMsSchema.nullable(),
    ticks: z.strictObject({
      offsets_ms: z.array(
        z
          .number()
          .int()
          .min(0)
          .max(DATA_CHART_MAX_HOURS * HOUR_MS),
      ),
      quotes: z.array(decimalStringSchema),
    }),
    gaps: z.array(chartGapSchema),
  })
  .superRefine((value, context) => {
    const issue = (message: string, path: readonly (number | string)[]) => {
      context.addIssue({ code: 'custom', message, path: [...path] });
    };
    const length = Date.parse(value.to_utc) - Date.parse(value.from_utc);
    if (length <= 0 || length % HOUR_MS !== 0 || length > DATA_CHART_MAX_HOURS * HOUR_MS) {
      issue('La ventana dura horas enteras, de 1 a la máxima.', ['to_utc']);
    }
    const { offsets_ms: offsets, quotes } = value.ticks;
    if (offsets.length !== quotes.length) {
      issue('Cada tick tiene su hora y su cotización.', ['ticks', 'quotes']);
    }
    if (offsets.some((offset, index) => index > 0 && offset <= (offsets[index - 1] ?? -1))) {
      issue('Un tick por instante, en orden.', ['ticks', 'offsets_ms']);
    }
    if (offsets.some((offset) => offset > length)) {
      issue('Los ticks están dentro de la ventana.', ['ticks', 'offsets_ms']);
    }
    if (value.log === null) {
      if (offsets.length > 0 || value.gaps.length > 0 || value.log_started_at_utc !== null) {
        issue('Sin log activo no hay datos.', ['log']);
      }
    }
    for (const [index, gap] of value.gaps.entries()) {
      if (gap.from_utc > value.to_utc || (gap.to_utc !== null && gap.to_utc < value.from_utc)) {
        issue('Un hueco toca la ventana.', ['gaps', index]);
      }
      const previous = value.gaps[index - 1];
      if (previous !== undefined && previous.from_utc > gap.from_utc) {
        issue('Los huecos van en orden de inicio.', ['gaps', index]);
      }
    }
  })
  .meta({ id: 'DataChart', title: 'DataChart' });

/**
 * La respuesta de `GET /api/v1/datos/catalogo` (ADR-0019 §8): la última versión del catálogo de
 * Deriv en el log activo (ADR-0012 §7), con su número, que cuenta desde 1 en cada log, la hora en
 * que llegó y sus entradas, en orden de símbolo y con los nombres y valores oficiales.
 * - `log`: el número del log activo, o `null` si no hay ninguno; entonces tampoco hay catálogo.
 * - `catalog`: `null` si el log todavía no tiene ninguna versión, como justo después del corte
 *   semanal, sin mirar la del log anterior.
 */
export const dataCatalogSchema = z
  .strictObject({
    log: z.number().int().min(1).max(MAX_LOG_NUMBER).nullable(),
    catalog: z
      .strictObject({
        source: nonEmptyStringSchema,
        version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        received_at_utc: utcTimestampMsSchema,
        source_schema_release: nonEmptyStringSchema,
        content_sha256: sha256HexSchema,
        entries: z.array(derivActiveSymbolEntrySchema).min(1),
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    if (value.log === null && value.catalog !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Sin log activo no hay catálogo.',
        path: ['catalog'],
      });
    }
    if (
      value.catalog !== null &&
      !isSortedUnique(value.catalog.entries.map((entry) => entry.underlying_symbol))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Las entradas van en orden de símbolo, sin repetir.',
        path: ['catalog', 'entries'],
      });
    }
  })
  .meta({ id: 'DataCatalog', title: 'DataCatalog' });

/**
 * Cuántos eventos de datos devuelve como mucho `GET /api/v1/datos/eventos`, los más recientes
 * (ADR-0019 §8). Producción guarda unos 110 a la semana (2026-11-12), así que caben los de unas dos.
 */
export const DATA_EVENTS_LIMIT = 200;

const logNumberSchema = z.number().int().min(1).max(MAX_LOG_NUMBER);
const positiveCountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Lo que llevan todos los eventos de datos: el log donde está, su hora UTC y su fuente. */
const dataEventBase = {
  log: logNumberSchema,
  at_utc: utcTimestampMsSchema,
  source: nonEmptyStringSchema,
};

/** Una versión nueva del catálogo de la fuente (ADR-0012 §7), que cuenta desde 1 en cada log. */
const catalogVersionEventSchema = z.strictObject({
  ...dataEventBase,
  kind: z.literal('catalog_version'),
  version: positiveCountSchema,
  snapshot_id: derivedEventIdSchema,
  content_sha256: sha256HexSchema,
  entry_count: positiveCountSchema,
});

/**
 * La publicación de un dataset (ADR-0004 §8): su `PublishedManifestRecord`, por su identificador.
 * Desde el 6b de F2.4 sale de `buoh_datasets` (ADR-0020 §10), y su `log` es el del dataset
 * (`dataset_log_ranges`): los datasets no vencen, así que puede ser un log que ya no se lee.
 */
const publicationEventSchema = z.strictObject({
  ...dataEventBase,
  kind: z.literal('publication'),
  dataset_id: datasetIdSchema,
  publication_id: uuidV7Schema,
  state: z.enum(['active', 'superseded']),
});

const incidentBase = {
  ...dataEventBase,
  kind: z.literal('incident'),
  incident_id: derivedEventIdSchema,
  severity: severitySchema,
  symbol: symbolSchema.nullable(),
};

/**
 * Una incidencia del log, con su evidencia, la de su `DataQualityIncident`: las del registro
 * operativo, `persistence_unavailable` y `source_limit_exceeded`, y las de las respuestas pedidas,
 * `invalid_source_frame` (ADR-0012 §6). Sus motivos son códigos saneados, nunca un mensaje.
 */
const incidentEventSchema = z.discriminatedUnion('incident_type', [
  z.strictObject({
    ...incidentBase,
    incident_type: z.literal('persistence_unavailable'),
    evidence: z.strictObject({ stage: persistenceStageSchema, reason: operationsCodeSchema }),
  }),
  z.strictObject({
    ...incidentBase,
    incident_type: z.literal('source_limit_exceeded'),
    evidence: z.strictObject({
      resource: sourceResourceSchema,
      unit: limitUnitSchema,
      observed_value: nonNegativeIntegerSchema,
      maximum_value: nonNegativeIntegerSchema,
    }),
  }),
  z.strictObject({
    ...incidentBase,
    incident_type: z.literal('invalid_source_frame'),
    evidence: z.strictObject({ reason: operationsCodeSchema, raw_payload_sha256: sha256HexSchema }),
  }),
]);

/**
 * La apertura o la resolución de una condición del registro operativo (`OperationalConditionEvent`):
 * las dos comparten `condition_key`, y solo la resolución lleva su motivo.
 */
const conditionEventSchema = z.strictObject({
  ...dataEventBase,
  kind: z.literal('condition'),
  condition_event_id: derivedEventIdSchema,
  condition_key: conditionKeySchema,
  condition_type: conditionTypeSchema,
  symbol: symbolSchema.nullable(),
  action: z.enum(['opened', 'resolved']),
  resolution_reason: operationsCodeSchema.nullable(),
});

const dataEventSchema = z.discriminatedUnion('kind', [
  catalogVersionEventSchema,
  publicationEventSchema,
  incidentEventSchema,
  conditionEventSchema,
]);

/**
 * La respuesta de `GET /api/v1/datos/eventos` (ADR-0019 §5 y §8): los eventos de datos que guardan
 * los logs que no han vencido, para la sección Auditoría. Siguen en su log y se borran con él, a los
 * 30 días de su última escritura (ADR-0018 §7). Las publicaciones, desde el 6b de F2.4, salen de
 * `buoh_datasets` y no vencen (ADR-0020 §6 y §10).
 * - `logs`: los logs leídos, de mayor a menor número, sin repetir. Cada evento que no es una
 *   publicación es de uno de ellos.
 * - `events`: los `DATA_EVENTS_LIMIT` más recientes como mucho, del más nuevo al más viejo.
 * - `truncated`: si quedaron fuera otros más viejos.
 */
export const dataEventsSchema = z
  .strictObject({
    logs: z.array(logNumberSchema),
    events: z.array(dataEventSchema).max(DATA_EVENTS_LIMIT),
    truncated: z.boolean(),
  })
  .superRefine((value, context) => {
    const issue = (message: string, path: readonly (number | string)[]) => {
      context.addIssue({ code: 'custom', message, path: [...path] });
    };
    if (value.logs.some((log, index) => index > 0 && log >= (value.logs[index - 1] ?? 0))) {
      issue('Los logs van de mayor a menor, sin repetir.', ['logs']);
    }
    if (value.truncated && value.events.length < DATA_EVENTS_LIMIT) {
      issue('Solo se corta una lista llena.', ['truncated']);
    }
    for (const [index, event] of value.events.entries()) {
      if (event.kind !== 'publication' && !value.logs.includes(event.log)) {
        issue('Cada evento que no es una publicación es de un log leído.', [
          'events',
          index,
          'log',
        ]);
      }
      const previous = value.events[index - 1];
      if (previous !== undefined && previous.at_utc < event.at_utc) {
        issue('Los eventos van del más nuevo al más viejo.', ['events', index, 'at_utc']);
      }
      if (event.kind === 'condition') {
        if ((event.resolution_reason !== null) !== (event.action === 'resolved')) {
          issue('Solo una resolución lleva su motivo.', ['events', index, 'resolution_reason']);
        }
        if (!event.condition_key.startsWith(`${event.condition_type}:sha256:`)) {
          issue('La clave es la de su tipo de condición.', ['events', index, 'condition_key']);
        }
      }
    }
  })
  .meta({ id: 'DataEvents', title: 'DataEvents' });

// --- F2.4, 6b: los datasets publicados (ADR-0020 §10) ---

/**
 * Cuántos datasets devuelve como mucho `GET /api/v1/datos/datasets`, los más recientes. Producción
 * publica unos 4 al día (ADR-0020 §7), así que caben los de unos 50 días.
 */
export const DATA_DATASETS_LIMIT = 200;

/** El código saneado de un fallo de `data:replay` (`ReplayErrorCode`), como lo guarda la base. */
const replayErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/u);

/**
 * El último resultado de la verificación de un dataset en un modo de `data:replay` (ADR-0020 §8,
 * paso 7): `passed`, sin código; `failed`, con el código del fallo; `incomplete`, con el de su
 * última ejecución, si lo tiene.
 */
const datasetVerificationSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'incomplete']),
  verified_at_utc: utcTimestampMsSchema,
  error_code: replayErrorCodeSchema.nullable(),
});

/** Cuántas incidencias de calidad de un tipo y una gravedad tiene un dataset. */
const datasetIncidentCountSchema = z.strictObject({
  incident_type: qualityIncidentTypeSchema,
  severity: severitySchema,
  count: positiveCountSchema,
});

/**
 * Un dataset publicado de `buoh_datasets`, por su publicación activa (ADR-0020 §5 y §10): su
 * identificador, su publicación, su fuente y sus símbolos, su log y sus segmentos, su período
 * (`null` sin ticks) y sus conteos, los de su `DatasetManifestCore`; sus reglas y su perfil; cómo
 * terminó (`dataset_log_ranges`); sus incidencias, por tipo y gravedad; y la última verificación de
 * cada modo, o `null` si todavía no tiene.
 */
const publishedDatasetSchema = z.strictObject({
  dataset_id: datasetIdSchema,
  publication_id: uuidV7Schema,
  published_at_utc: utcTimestampMsSchema,
  source: nonEmptyStringSchema,
  symbols: z.array(symbolSchema).min(1),
  log: logNumberSchema,
  first_segment: nonNegativeIntegerSchema,
  last_segment: nonNegativeIntegerSchema,
  event_time_from_utc: utcTimestampMsSchema.nullable(),
  event_time_to_utc: utcTimestampMsSchema.nullable(),
  source_event_count: nonNegativeIntegerSchema,
  raw_frame_count: nonNegativeIntegerSchema,
  normalized_tick_count: nonNegativeIntegerSchema,
  incident_count: nonNegativeIntegerSchema,
  condition_event_count: nonNegativeIntegerSchema,
  quality_rule_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  quality_profile_id: nonEmptyStringSchema,
  clean: z.boolean(),
  pending_continuity_symbols: z.array(symbolSchema),
  open_condition_types: z.array(conditionTypeSchema),
  incidents: z.array(datasetIncidentCountSchema),
  verifications: z.strictObject({
    verify_only: datasetVerificationSchema.nullable(),
    recompute: datasetVerificationSchema.nullable(),
  }),
});

/**
 * La respuesta de `GET /api/v1/datos/datasets` (ADR-0020 §10): los datasets publicados del entorno
 * de la API, para la sección Datos, del más nuevo al más viejo por su publicación. No vencen
 * (ADR-0020 §6). `truncated` dice si quedaron fuera otros más viejos, así que solo puede ser `true`
 * con la lista llena.
 */
export const dataDatasetsSchema = z
  .strictObject({
    datasets: z.array(publishedDatasetSchema).max(DATA_DATASETS_LIMIT),
    truncated: z.boolean(),
  })
  .superRefine((value, context) => {
    const issue = (message: string, path: readonly (number | string)[]) => {
      context.addIssue({ code: 'custom', message, path: [...path] });
    };
    if (value.truncated && value.datasets.length < DATA_DATASETS_LIMIT) {
      issue('Solo se corta una lista llena.', ['truncated']);
    }
    const ids = new Set<string>();
    for (const [index, dataset] of value.datasets.entries()) {
      const at = (field: string) => ['datasets', index, field];
      if (ids.has(dataset.dataset_id)) {
        issue('Cada dataset sale una vez.', at('dataset_id'));
      }
      ids.add(dataset.dataset_id);
      const previous = value.datasets[index - 1];
      if (previous !== undefined && previous.published_at_utc < dataset.published_at_utc) {
        issue('Los datasets van del más nuevo al más viejo.', at('published_at_utc'));
      }
      if (dataset.last_segment < dataset.first_segment) {
        issue('El último segmento no va antes del primero.', at('last_segment'));
      }
      const noRange = dataset.event_time_from_utc === null && dataset.event_time_to_utc === null;
      const partialRange =
        (dataset.event_time_from_utc === null) !== (dataset.event_time_to_utc === null);
      if (partialRange || (dataset.normalized_tick_count === 0) !== noRange) {
        issue('El período es null exactamente cuando no hay ticks.', at('event_time_from_utc'));
      }
      if (
        dataset.event_time_from_utc !== null &&
        dataset.event_time_to_utc !== null &&
        dataset.event_time_from_utc > dataset.event_time_to_utc
      ) {
        issue('El período va en orden.', at('event_time_to_utc'));
      }
      if (dataset.raw_frame_count > dataset.source_event_count) {
        issue('Los frames crudos son source events.', at('raw_frame_count'));
      }
      for (const field of [
        'symbols',
        'pending_continuity_symbols',
        'open_condition_types',
      ] as const) {
        if (!isSortedUnique(dataset[field])) {
          issue('Va en orden y sin repetir.', at(field));
        }
      }
      const clean =
        dataset.pending_continuity_symbols.length === 0 &&
        !dataset.open_condition_types.includes('connection_lost');
      if (dataset.clean !== clean) {
        issue('Limpio es sin continuidad pendiente ni connection_lost abierta.', at('clean'));
      }
      const keys = dataset.incidents.map((item) => `${item.incident_type} ${item.severity}`);
      if (!isSortedUnique(keys)) {
        issue('Las incidencias van por tipo y gravedad, sin repetir.', at('incidents'));
      }
      const total = dataset.incidents.reduce((sum, item) => sum + item.count, 0);
      if (total !== dataset.incident_count) {
        issue('Las incidencias suman incident_count.', at('incidents'));
      }
      for (const mode of ['verify_only', 'recompute'] as const) {
        const result = dataset.verifications[mode];
        if (result === null) {
          continue;
        }
        if (result.status === 'passed' && result.error_code !== null) {
          issue('Una verificación que pasó no lleva código.', [
            'datasets',
            index,
            'verifications',
            mode,
          ]);
        }
        if (result.status === 'failed' && result.error_code === null) {
          issue('Una verificación que falló lleva su código.', [
            'datasets',
            index,
            'verifications',
            mode,
          ]);
        }
      }
    }
  })
  .meta({ id: 'DataDatasets', title: 'DataDatasets' });

// --- F2.4: las preferencias de la cuenta (F2-UI-001) ---

/**
 * Los temas de la web (guía de marca): `night`, el de por defecto, y `day`. En inglés, como los
 * demás valores de los contratos; la web los aplica como `data-theme="noche"` y `"dia"`.
 */
export const THEMES = ['night', 'day'] as const;
export const themeSchema = z.enum(THEMES);

/**
 * La respuesta de `GET /api/v1/preferencias` y de `POST /api/v1/preferencias` (ADR-0019 §7): las
 * preferencias de la cuenta de la sesión. En la Fase 2 solo el tema; sin ninguna guardada, `night`.
 */
export const accountPreferencesSchema = z
  .strictObject({ theme: themeSchema })
  .meta({ id: 'AccountPreferences', title: 'AccountPreferences' });

/** El cuerpo de `POST /api/v1/preferencias`: el tema que se guarda para la cuenta de la sesión. */
export const preferencesRequestSchema = z
  .strictObject({ theme: themeSchema })
  .meta({ id: 'PreferencesRequest', title: 'PreferencesRequest' });

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
export type DataChartQuery = z.infer<typeof dataChartQuerySchema>;
export type DataChart = z.infer<typeof dataChartSchema>;
export type DataChartGap = DataChart['gaps'][number];
export type DataCatalog = z.infer<typeof dataCatalogSchema>;
export type DataEvents = z.infer<typeof dataEventsSchema>;
export type DataEvent = DataEvents['events'][number];
export type DataDatasets = z.infer<typeof dataDatasetsSchema>;
export type DataDataset = DataDatasets['datasets'][number];
export type Theme = z.infer<typeof themeSchema>;
export type AccountPreferences = z.infer<typeof accountPreferencesSchema>;
export type PreferencesRequest = z.infer<typeof preferencesRequestSchema>;
