/**
 * Los errores con los que PostgreSQL no se puede usar ahora (ADR-0019 §7): la API responde
 * `postgres_unavailable` (503), y no `internal`. Son los de la red, las clases de SQLSTATE de la
 * conexión (`08`) y de la autenticación (`28`), el límite de conexiones (`53300`), la parada o el
 * arranque del servidor (`57P01` a `57P03`), una consulta cancelada por su plazo (`57014`) y los de
 * `pg` cuando la conexión se corta o no llega.
 */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03', '57014']);
const SQLSTATE_CLASSES = ['08', '28'];
/** Los errores de `pg` 8.23.1 y `pg-pool` 3.14.0 sin código cuando la conexión falla. */
const PG_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'timeout expired',
  'The server does not support SSL connections',
  'There was an error establishing an SSL connection',
]);

export function isPostgresUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code) || SQLSTATES.has(code)) {
      return true;
    }
    if (/^[0-9A-Z]{5}$/u.test(code) && SQLSTATE_CLASSES.includes(code.slice(0, 2))) {
      return true;
    }
  }
  return PG_MESSAGES.has(error.message);
}
