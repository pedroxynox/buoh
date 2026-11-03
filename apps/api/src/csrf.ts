import type { IncomingHttpHeaders } from 'node:http';

/**
 * Las dos primeras condiciones contra CSRF de una petición que cambia algo (ADR-0019 §2; OWASP):
 * 1. `Origin` exactamente igual al origen público de la API y, si llega, `Sec-Fetch-Site:
 *    same-origin`;
 * 2. `Content-Type: application/json`, sin más parámetro que `charset=utf-8`, un tipo que un
 *    formulario de otro sitio no puede enviar.
 *
 * Se comprueban antes de leer el cuerpo. Una cabecera repetida llega unida con comas y no
 * coincide. La tercera, el token CSRF de la sesión, llega con las sesiones (PR 4b).
 */
export function isSameOriginJsonRequest(headers: IncomingHttpHeaders, origin: string): boolean {
  if (headers.origin !== origin) {
    return false;
  }
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    return false;
  }
  return isJsonContentType(headers['content-type']);
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const [type, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase());
  return (
    type === 'application/json' &&
    parameters.every(
      (parameter) => parameter === 'charset=utf-8' || parameter === 'charset="utf-8"',
    )
  );
}
