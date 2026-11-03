/**
 * Cliente de la API de buoh para las pantallas servidas por la API (ADR-0019 §9). Vive solo en las
 * pantallas de `out-api`: la variante `out` del escritorio nunca lo incluye, porque las páginas que
 * lo importan quedan fuera de su empaquetado (ADR-0019 §9; prueba `F2-UI-001`).
 *
 * Mismo origen que la API: las direcciones son relativas (`/api/v1/…`), la cookie de la sesión viaja
 * sola (`credentials: 'same-origin'`) y el navegador añade `Origin` y `Sec-Fetch-Site`, que la API
 * exige a cada petición que cambia algo (CSRF, ADR-0019 §2). La web añade el `Content-Type` y, con
 * una sesión, el `X-CSRF-Token`.
 */
import type {
  ApiErrorCode,
  AuditEvent,
  AuditEventsResponse,
  LinkSecret,
  LinkUse,
  PasswordRejectionReason,
  SessionInfo,
  SessionLoginRequest,
  SessionsClosedResult,
} from '@buoh/contracts';

/** El motivo de un fallo de la API, con los añadidos locales de red y de respuesta inesperada. */
export type FailureCode = ApiErrorCode | 'network' | 'unexpected';

export interface ApiFailure {
  readonly code: FailureCode;
  /** Segundos que faltan, en `rate_limited`. */
  readonly retryAfterSeconds?: number;
  /** Por qué se rechazó la contraseña, en `password_rejected`. */
  readonly reason?: PasswordRejectionReason;
}

/** Un fallo esperado de la API, con su código; nunca lleva el mensaje de un error interno. */
export class ApiCallError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.code);
    this.name = 'ApiCallError';
    this.failure = failure;
  }
}

const JSON_HEADER: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

interface RequestOptions {
  readonly body?: unknown;
  readonly csrfToken?: string;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (options.body !== undefined) {
    Object.assign(headers, JSON_HEADER);
    init.body = JSON.stringify(options.body);
  }
  if (options.csrfToken !== undefined) {
    headers['x-csrf-token'] = options.csrfToken;
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiCallError({ code: 'network' });
  }
  if (response.ok) {
    return (await response.json()) as T;
  }
  throw new ApiCallError(await readFailure(response));
}

/** Lee el código del cuerpo `ApiError` sin confiar en su forma; si no cuadra, `unexpected`. */
async function readFailure(response: Response): Promise<ApiFailure> {
  try {
    const parsed: unknown = await response.json();
    const error = (parsed as { error?: Record<string, unknown> } | null)?.error;
    if (error !== undefined && typeof error.code === 'string') {
      const retry = error.retry_after_seconds;
      const reason = error.reason;
      return {
        code: error.code as FailureCode,
        ...(typeof retry === 'number' ? { retryAfterSeconds: retry } : {}),
        ...(typeof reason === 'string' ? { reason: reason as PasswordRejectionReason } : {}),
      };
    }
  } catch {
    // Sin cuerpo JSON válido.
  }
  return { code: 'unexpected' };
}

export const api = {
  /** El token CSRF de la sesión actual; `unauthenticated` si no hay sesión (ADR-0019 §2). */
  session: (): Promise<SessionInfo> => request<SessionInfo>('GET', '/api/v1/sesion'),
  /** Inicia sesión; la respuesta trae el token CSRF y pone la cookie (ADR-0019 §1 y §2). */
  login: (input: SessionLoginRequest): Promise<SessionInfo> =>
    request<SessionInfo>('POST', '/api/v1/sesion', { body: input }),
  /** Cierra la sesión actual y borra su cookie. */
  logout: (csrfToken: string): Promise<SessionsClosedResult> =>
    request<SessionsClosedResult>('DELETE', '/api/v1/sesion', { body: {}, csrfToken }),
  /** Cierra las demás sesiones de la cuenta, menos la actual. */
  closeOthers: (csrfToken: string): Promise<SessionsClosedResult> =>
    request<SessionsClosedResult>('DELETE', '/api/v1/sesiones', { body: {}, csrfToken }),
  /** Pide un secreto TOTP nuevo para un enlace; el anterior deja de valer (ADR-0019 §3). */
  linkSecret: (token: string): Promise<LinkSecret> =>
    request<LinkSecret>('POST', '/api/v1/enlace/secreto', { body: { token } }),
  /** Usa el enlace con la contraseña nueva y un código: da de alta o restablece (ADR-0019 §3). */
  useLink: (input: { token: string; password: string; code: string }): Promise<LinkUse> =>
    request<LinkUse>('POST', '/api/v1/enlace', { body: input }),
  /** Las entradas de auditoría de la cuenta, de la más nueva a la más vieja (ADR-0019 §5). */
  audit: (): Promise<readonly AuditEvent[]> =>
    request<AuditEventsResponse>('GET', '/api/v1/auditoria').then((response) => response.events),
} as const;

const PASSWORD_REASONS: Readonly<Record<PasswordRejectionReason, string>> = {
  too_short: 'La contraseña es demasiado corta: al menos 15 caracteres.',
  too_long: 'La contraseña es demasiado larga: como mucho 128 caracteres.',
  common_password: 'Esa contraseña es demasiado común. Elige otra.',
  context_words: 'La contraseña no puede ser una palabra del contexto, como tu usuario o «buoh».',
};

/** Texto fijo de cada fallo; los dos con datos variables (`rate_limited`, `password_rejected`) se tratan aparte. */
const FAILURE_MESSAGES: Readonly<
  Record<Exclude<FailureCode, 'rate_limited' | 'password_rejected'>, string>
> = {
  invalid_credentials: 'El usuario, la contraseña o el código no son correctos.',
  credential_disabled:
    'Tu credencial está deshabilitada por demasiados intentos fallidos. Restablécela con un enlace nuevo.',
  invalid_code: 'El código no corresponde a este enlace. Usa el de tu app para el código de abajo.',
  invalid_link:
    'El enlace no es válido: no existe, caducó, ya se usó o lo reemplazó uno más nuevo.',
  unauthenticated: 'Tu sesión no es válida. Vuelve a iniciar sesión.',
  not_ready: 'El servicio no está disponible ahora mismo. Inténtalo de nuevo en un momento.',
  postgres_unavailable:
    'El servicio no está disponible ahora mismo. Inténtalo de nuevo en un momento.',
  csrf_rejected: 'Tu navegador bloqueó la petición. Recarga la página e inténtalo de nuevo.',
  invalid_request: 'Los datos no son válidos. Revísalos e inténtalo de nuevo.',
  not_found: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
  internal: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
  network: 'No se pudo conectar con el servicio. Revisa tu conexión e inténtalo de nuevo.',
  unexpected: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
};

/** Un texto en español para un fallo, sin revelar nunca cuál de los datos de acceso falló. */
export function describeFailure(failure: ApiFailure): string {
  if (failure.code === 'rate_limited') {
    return failure.retryAfterSeconds === undefined
      ? 'Demasiados intentos. Espera un momento y vuelve a intentarlo.'
      : `Demasiados intentos. Espera ${String(failure.retryAfterSeconds)} s y vuelve a intentarlo.`;
  }
  if (failure.code === 'password_rejected') {
    return failure.reason === undefined
      ? 'La contraseña no cumple la política.'
      : PASSWORD_REASONS[failure.reason];
  }
  // Un código fuera del contrato (una versión futura de la API) cae en el mensaje genérico, nunca
  // en un texto vacío.
  return (
    (FAILURE_MESSAGES as Record<string, string | undefined>)[failure.code] ??
    FAILURE_MESSAGES.unexpected
  );
}
