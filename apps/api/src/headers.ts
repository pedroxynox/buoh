/**
 * Las cabeceras de seguridad de toda respuesta JSON de la API (ADR-0019 §9), también de los
 * errores. La política de contenido del HTML llega con la web que sirve la API (PR 5 de §14).
 */
export const JSON_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
