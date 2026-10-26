import { canonicalJson, type JsonValue } from '@buoh/contracts';

import { type DerivSchemaSet } from './schema-archive.js';

/** Peticiones que hace el adaptador (ADR-0012 §1). `ticks_history` y `forget` llegan con F1.5. */
export type DerivRequest =
  | { readonly operation: 'active_symbols' }
  | { readonly operation: 'forget_all' }
  | { readonly operation: 'ping' }
  | { readonly operation: 'ticks'; readonly symbol: string }
  | { readonly operation: 'time' };

export type DerivRequestOperation = DerivRequest['operation'];

/**
 * `msg_type` de la respuesta que espera cada petición (ADR-0012 §5). Una suscripción a `ticks`
 * responde con `tick`; si falla, con `ticks` y un objeto `error`.
 */
export const EXPECTED_MSG_TYPE = {
  active_symbols: 'active_symbols',
  forget_all: 'forget_all',
  ping: 'ping',
  ticks: 'tick',
  time: 'time',
} as const satisfies Record<DerivRequestOperation, string>;

/** Cuerpo de la petición con su `req_id`. */
export function requestBody(request: DerivRequest, reqId: number): Record<string, JsonValue> {
  switch (request.operation) {
    case 'active_symbols':
      return { active_symbols: 'brief', req_id: reqId };
    case 'forget_all':
      return { forget_all: 'ticks', req_id: reqId };
    case 'ping':
      return { ping: 1, req_id: reqId };
    case 'ticks':
      return { req_id: reqId, subscribe: 1, ticks: request.symbol };
    case 'time':
      return { req_id: reqId, time: 1 };
  }
}

/**
 * Texto de la petición, o `null` si no cumple su esquema de petición en la release fijada: el
 * adaptador valida cada petición propia antes de enviarla (ADR-0012 §2).
 */
export function encodeRequest(
  schemas: DerivSchemaSet,
  request: DerivRequest,
  reqId: number,
): string | null {
  const body = requestBody(request, reqId);
  return schemas.schema(request.operation, 'request').validate(body) ? canonicalJson(body) : null;
}
