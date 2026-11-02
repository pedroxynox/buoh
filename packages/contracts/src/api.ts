import { z } from 'zod';

/**
 * Mensajes de la API de buoh (ADR-0019 §6; contratos de dominio, «Mensajes de la API»). Las rutas
 * van bajo `/api/v1/`, y la versión de un mensaje es la de su ruta: estos mensajes no llevan
 * `schema_version`. La API valida con ellos cada entrada y cada salida, y su OpenAPI se genera
 * desde ellos (`apps/api/generated/openapi.json`).
 */

/**
 * Códigos de error de la API, una lista cerrada. Cada PR de ADR-0019 §14 suma los que produce:
 * - `invalid_request`: la petición no cumple su contrato (consulta, cuerpo o tipo de contenido), o
 *   el servidor HTTP la rechazó antes de llegar a una ruta;
 * - `not_found`: ninguna ruta atiende ese método y esa dirección;
 * - `internal`: un fallo del servidor, también una respuesta que no cumple su contrato.
 */
export const apiErrorCodeSchema = z.enum(['invalid_request', 'not_found', 'internal']);

/**
 * El cuerpo de toda respuesta de error: el código y el identificador de la petición, nunca el
 * mensaje de un error interno ni su traza.
 */
export const apiErrorSchema = z
  .strictObject({
    error: z.strictObject({
      code: apiErrorCodeSchema,
      request_id: z.uuid(),
    }),
  })
  .meta({ id: 'ApiError', title: 'ApiError' });

/** La respuesta de `GET /api/salud` cuando el proceso responde (ADR-0019 §7). */
export const apiHealthSchema = z
  .strictObject({
    status: z.literal('ok'),
  })
  .meta({ id: 'ApiHealth', title: 'ApiHealth' });

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiHealth = z.infer<typeof apiHealthSchema>;
