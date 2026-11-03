/**
 * Las cabeceras de seguridad de las respuestas de la API (ADR-0019 §9). Las comunes van en toda
 * respuesta, también los errores. La política de contenido y la caché cambian entre el JSON de la
 * API, el HTML de la web que sirve la API y sus recursos estáticos.
 */

/** Comunes a toda respuesta: JSON, HTML y recursos estáticos, también los errores (ADR-0019 §9). */
export const COMMON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};

/** Toda respuesta JSON de la API, también los errores: nada que cargar y sin caché (ADR-0019 §9). */
export const JSON_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  ...COMMON_SECURITY_HEADERS,
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** La caché de los recursos con huella de contenido (`_next/static/`): inmutable un año (§9). */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** La caché del HTML y de los demás archivos sin huella: se revalida siempre (§9). */
export const NO_CACHE = 'no-cache';

/**
 * La política de contenido del HTML que sirve la API (ADR-0019 §9). `script-src` lleva `'self'` y el
 * hash SHA-256 de cada script en línea del archivo, que la API calcula de lo que sirve; nunca
 * `'unsafe-inline'` ni `'unsafe-eval'`. `style-src-attr 'unsafe-inline'` hace falta porque React
 * escribe atributos `style` en los gráficos. El PR puede estrechar esta política; ampliarla cambia
 * la ADR.
 */
export function htmlContentSecurityPolicy(scriptHashes: readonly string[]): string {
  const scriptSrc = ["'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`)].join(' ');
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
