/**
 * Una línea del registro de la API (ADR-0019 §11), también las que la CLI escribe en stderr. Solo
 * existen estos campos: ninguna cabecera, cookie, cuerpo, consulta, dirección IP ni navegador. Es
 * una lista cerrada de campos, así que no hace falta una lista de redacción.
 */
export type ApiLogLine =
  | {
      readonly event: 'api_request';
      readonly method: string;
      /** El patrón de la ruta de la tabla, o `null` si ninguna ruta la atendió. */
      readonly route: string | null;
      readonly status: number;
      readonly duration_ms: number;
      readonly request_id: string;
    }
  | { readonly event: 'api_error'; readonly request_id: string; readonly error: string }
  | { readonly event: 'api_client_error'; readonly request_id: string; readonly error: string }
  /** Los nombres de las variables de entorno rechazadas, nunca sus valores. */
  | { readonly event: 'api_config_error'; readonly variables: readonly string[] }
  | { readonly event: 'api_listening'; readonly port: number }
  | { readonly event: 'api_listen_failed'; readonly error: string }
  | { readonly event: 'api_stopping'; readonly signal: string }
  | { readonly event: 'api_stopped' }
  | { readonly event: 'api_stop_failed'; readonly error: string };

export type ApiLog = (line: ApiLogLine) => void;

const ERROR_CODE = /^[A-Z0-9][A-Z0-9_]{1,63}$/u;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

/**
 * El nombre saneado de un error: su código (`FST_ERR_…`, `ECONNRESET`, o el SQLSTATE de PostgreSQL,
 * como `42501`) o el nombre de su clase, nunca su mensaje, que puede llevar datos de la petición o
 * de un servicio.
 */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'NonError';
  }
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'string' && ERROR_CODE.test(code)) {
    return code;
  }
  return ERROR_NAME.test(error.name) ? error.name : 'Error';
}

/** Un registro que escribe cada línea como un JSON por línea. */
export function jsonLines(write: (text: string) => void): ApiLog {
  return (line) => {
    write(`${JSON.stringify(line)}\n`);
  };
}
