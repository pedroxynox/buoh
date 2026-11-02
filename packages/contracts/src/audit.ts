import { z } from 'zod';

import { compareUtc, isSortedUnique, utcTimestampMsSchema, uuidV7Schema } from './scalars.js';

/**
 * `AuditEvent` (ADR-0019 §5 y §6; contratos de dominio, «AuditEvent»): una entrada de la auditoría
 * de la API, que se guarda en `buoh_api.audit_events` y nunca se modifica ni se borra. Dice quién
 * hizo qué, cuándo, por qué y sobre qué objetos. No tiene ningún campo para un secreto, una
 * dirección IP, el navegador ni el nombre de usuario escrito en un intento fallido.
 */

/**
 * Versiones de `AuditEvent` con lector. Cada incremento que suma acciones sube el minor (plan de
 * Fase 2, §9); la 1.0.0 trae las de F2.3. Otra versión se rechaza.
 */
export const AUDIT_EVENT_SCHEMA_VERSIONS = ['1.0.0'] as const;

/**
 * El autor de una entrada: la cuenta de la sesión (`account`), la orden `cuenta` desde la consola
 * de Render (`operator`), la propia API (`system`) o quien todavía no tiene sesión (`anonymous`).
 */
export const auditActorSchema = z.enum(['account', 'operator', 'system', 'anonymous']);

/** Las clases de los objetos que afecta una entrada, cada uno con su identificador UUIDv7. */
export const auditObjectKindSchema = z.enum(['account', 'credential', 'link', 'session']);

/** Un objeto afectado. Nunca un token, un hash con clave ni un nombre: solo su identificador. */
export const auditObjectSchema = z.strictObject({
  kind: auditObjectKindSchema,
  id: uuidV7Schema,
});

/** Las acciones de la versión 1.0.0, las de F2.3 (ADR-0019 §5), en orden alfabético. */
export const AUDIT_ACTIONS = [
  'account_enrolled',
  'credential_disabled',
  'credential_reset',
  'link_created',
  'link_used',
  'login_failed',
  'login_failures',
  'session_closed',
  'session_started',
  'sessions_closed',
] as const;

const schemaVersion = z.enum(AUDIT_EVENT_SCHEMA_VERSIONS);
/** El identificador de la petición que causó la entrada: el UUID de `ApiError` (ADR-0019 §6). */
const requestId = z.uuid();
const objects = z.array(auditObjectSchema);
const failureCount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** `cuenta alta` o `cuenta restablecer` crearon un enlace, y el anterior de la cuenta dejó de valer. */
const linkCreatedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('operator'),
  action: z.literal('link_created'),
  reason: z.enum(['enrollment', 'reset']),
  objects,
  request_id: z.null(),
});

/** Alguien sin sesión usó un enlace válido: de alta (`enrollment`) o de restablecimiento. */
const linkUsedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('anonymous'),
  action: z.literal('link_used'),
  reason: z.enum(['enrollment', 'reset']),
  objects,
  request_id: requestId,
});

/** El alta de la cuenta terminó con su enlace: su primera credencial, con un código válido. */
const accountEnrolledSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('anonymous'),
  action: z.literal('account_enrolled'),
  reason: z.literal('enrollment_link'),
  objects,
  request_id: requestId,
});

/** Un restablecimiento terminó: la credencial nueva vale y la anterior queda deshabilitada. */
const credentialResetSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('anonymous'),
  action: z.literal('credential_reset'),
  reason: z.literal('reset_link'),
  objects,
  request_id: requestId,
});

/** La API deshabilitó la credencial con su fallo número 100 seguido (ADR-0019 §1). */
const credentialDisabledSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('system'),
  action: z.literal('credential_disabled'),
  reason: z.literal('failure_limit'),
  objects,
  request_id: requestId,
});

/** Un inicio de sesión con la contraseña y el código válidos. */
const sessionStartedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('account'),
  action: z.literal('session_started'),
  reason: z.literal('password_and_totp'),
  objects,
  request_id: requestId,
});

/** Un intento fallido con una cuenta que existe y su credencial vigente: uno por entrada (§5). */
const loginFailedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.literal('anonymous'),
  action: z.literal('login_failed'),
  reason: z.literal('invalid_credentials'),
  objects,
  request_id: requestId,
});

/**
 * Los demás intentos fallidos de una ventana de 5 minutos, agrupados por clase y, si la hay, por
 * cuenta (§5): los de un nombre que no existe (`unknown_username`), los que llegan a una credencial
 * deshabilitada (`disabled_credential`) y los que rechaza un límite (`rate_limited`). Lleva su
 * número y el principio de su ventana, y no es de ninguna petición.
 */
const loginFailuresSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema.nullable(),
  actor: z.literal('anonymous'),
  action: z.literal('login_failures'),
  reason: z.enum(['unknown_username', 'disabled_credential', 'rate_limited']),
  objects,
  request_id: z.null(),
  failure_count: failureCount,
  window_started_at_utc: utcTimestampMsSchema,
});

/** Se cerró una sesión: «Cerrar sesión» (`logout`) o el tope de 10 sesiones (`session_limit`). */
const sessionClosedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.enum(['account', 'system']),
  action: z.literal('session_closed'),
  reason: z.enum(['logout', 'session_limit']),
  objects,
  request_id: requestId,
});

/**
 * Se cerraron varias sesiones: «Cerrar las demás sesiones» (`other_sessions`), `cuenta
 * cerrar-sesiones` (`operator_command`) o un restablecimiento (`credential_reset`).
 */
const sessionsClosedSchema = z.strictObject({
  schema_version: schemaVersion,
  audit_event_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  account_id: uuidV7Schema,
  actor: z.enum(['account', 'operator', 'system']),
  action: z.literal('sessions_closed'),
  reason: z.enum(['other_sessions', 'operator_command', 'credential_reset']),
  objects,
  request_id: requestId.nullable(),
});

export const auditEventStructuralSchema = z
  .discriminatedUnion('action', [
    accountEnrolledSchema,
    credentialDisabledSchema,
    credentialResetSchema,
    linkCreatedSchema,
    linkUsedSchema,
    loginFailedSchema,
    loginFailuresSchema,
    sessionClosedSchema,
    sessionStartedSchema,
    sessionsClosedSchema,
  ])
  .meta({ id: 'AuditEvent', title: 'AuditEvent' });

/** El autor de cada motivo de `session_closed` y de `sessions_closed`. */
const SESSION_CLOSED_ACTOR = { logout: 'account', session_limit: 'system' } as const;
const SESSIONS_CLOSED_ACTOR = {
  credential_reset: 'system',
  operator_command: 'operator',
  other_sessions: 'account',
} as const;

/**
 * El esquema runtime: la forma, y además:
 * - los objetos, únicos y en orden por `kind` y después por `id`, y al menos uno salvo en
 *   `login_failures`. Una cuenta entre los objetos es siempre la de `account_id`;
 * - en `session_closed` y `sessions_closed`, cada motivo con su autor. `sessions_closed` solo va sin
 *   petición cuando lo pide la orden `cuenta`;
 * - en `login_failures`, un nombre que no existe no tiene cuenta ni objetos; una credencial
 *   deshabilitada sí tiene cuenta; y la ventana no empieza después de la entrada.
 */
export const auditEventSchema = auditEventStructuralSchema.superRefine((event, context) => {
  const issue = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };
  if (!isSortedUnique(event.objects.map((object) => `${object.kind}:${object.id}`))) {
    issue('objects', 'objects debe ser único y estar ordenado por kind e id.');
  }
  if (event.action !== 'login_failures' && event.objects.length === 0) {
    issue('objects', 'Una entrada que no agrupa intentos nombra al menos un objeto.');
  }
  if (event.objects.some((object) => object.kind === 'account' && object.id !== event.account_id)) {
    issue('objects', 'Una entrada solo nombra la cuenta de su account_id.');
  }
  if (event.action === 'session_closed' && SESSION_CLOSED_ACTOR[event.reason] !== event.actor) {
    issue('actor', 'El autor no corresponde al motivo del cierre.');
  }
  if (event.action === 'sessions_closed') {
    if (SESSIONS_CLOSED_ACTOR[event.reason] !== event.actor) {
      issue('actor', 'El autor no corresponde al motivo del cierre.');
    }
    if ((event.request_id === null) !== (event.actor === 'operator')) {
      issue('request_id', 'Solo un cierre de la orden cuenta va sin petición.');
    }
  }
  if (event.action === 'login_failures') {
    if (
      event.reason === 'unknown_username' &&
      (event.account_id !== null || event.objects.length > 0)
    ) {
      issue('account_id', 'Los intentos con un nombre que no existe no tienen cuenta ni objetos.');
    }
    if (event.reason === 'disabled_credential' && event.account_id === null) {
      issue('account_id', 'Una credencial deshabilitada es de una cuenta.');
    }
    if (compareUtc(event.window_started_at_utc, event.occurred_at_utc) > 0) {
      issue('window_started_at_utc', 'La ventana no puede empezar después de la entrada.');
    }
  }
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditAction = AuditEvent['action'];
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditObject = z.infer<typeof auditObjectSchema>;
