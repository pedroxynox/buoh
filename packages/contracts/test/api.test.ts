import { describe, expect, it } from 'vitest';

import { apiErrorCodeSchema, apiErrorSchema, apiHealthSchema } from '../src/index.js';

// Mensajes de la API (ADR-0019 §6; contratos de dominio, «Mensajes de la API»).
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

describe('ApiError', () => {
  it('acepta un código de la lista y el identificador de la petición', () => {
    for (const code of ['invalid_request', 'not_found', 'internal'] as const) {
      expect(apiErrorSchema.parse({ error: { code, request_id: REQUEST_ID } })).toEqual({
        error: { code, request_id: REQUEST_ID },
      });
    }
  });

  it('cierra la lista de códigos', () => {
    expect(apiErrorCodeSchema.options).toEqual(['invalid_request', 'not_found', 'internal']);
    for (const code of ['unauthenticated', 'forbidden', 'INTERNAL', '']) {
      expect(apiErrorSchema.safeParse({ error: { code, request_id: REQUEST_ID } }).success).toBe(
        false,
      );
    }
  });

  it('no admite un mensaje, una traza ni otros campos', () => {
    for (const extra of [{ message: 'detalle' }, { stack: 'Error: …' }, { status: 500 }]) {
      expect(
        apiErrorSchema.safeParse({ error: { code: 'internal', request_id: REQUEST_ID, ...extra } })
          .success,
      ).toBe(false);
    }
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'internal', request_id: REQUEST_ID },
        message: 'detalle',
      }).success,
    ).toBe(false);
  });

  it('exige un UUID como identificador de la petición', () => {
    for (const requestId of ['1', 'req-1', '', REQUEST_ID.toUpperCase().replace('4000', 'G000')]) {
      expect(
        apiErrorSchema.safeParse({ error: { code: 'internal', request_id: requestId } }).success,
      ).toBe(false);
    }
  });
});

describe('ApiHealth', () => {
  it('solo acepta { status: "ok" }', () => {
    expect(apiHealthSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    for (const value of [{ status: 'healthy' }, { status: 'ok', version: '1' }, {}, null]) {
      expect(apiHealthSchema.safeParse(value).success).toBe(false);
    }
  });
});
