import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  apiErrorCodeSchema,
  apiErrorSchema,
  apiHealthSchema,
  auditEventsResponseSchema,
  emptyRequestSchema,
  linkSecretRequestSchema,
  linkSecretSchema,
  linkUseRequestSchema,
  linkUseSchema,
  PASSWORD_REJECTION_REASONS,
  sessionInfoSchema,
  sessionLoginRequestSchema,
  sessionsClosedResultSchema,
  usernameSchema,
} from '../src/index.js';

// Mensajes de la API (ADR-0019 §6; contratos de dominio, «Mensajes de la API»).
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
/** Un token de enlace válido: los bytes 0 a 31 en base64url, 43 caracteres. */
const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const TOTP_URI = `otpauth://totp/buoh:pedro?secret=${TOTP_SECRET}&issuer=buoh&algorithm=SHA1&digits=6&period=30`;

function accepts(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe('ApiError', () => {
  it('acepta cada código sin campos propios con el identificador de la petición', () => {
    for (const code of [
      'invalid_request',
      'not_found',
      'internal',
      'csrf_rejected',
      'invalid_link',
      'invalid_code',
      'not_ready',
      'postgres_unavailable',
      'unauthenticated',
      'invalid_credentials',
      'credential_disabled',
    ] as const) {
      expect(apiErrorSchema.parse({ error: { code, request_id: REQUEST_ID } })).toEqual({
        error: { code, request_id: REQUEST_ID },
      });
    }
  });

  it('cierra la lista de códigos: los del esqueleto, los del PR 4a y los del PR 4b, en ese orden', () => {
    expect(API_ERROR_CODES).toEqual([
      'invalid_request',
      'not_found',
      'internal',
      'csrf_rejected',
      'invalid_link',
      'invalid_code',
      'password_rejected',
      'rate_limited',
      'not_ready',
      'postgres_unavailable',
      'unauthenticated',
      'invalid_credentials',
      'credential_disabled',
    ]);
    expect(apiErrorCodeSchema.options).toEqual(API_ERROR_CODES);
    for (const code of ['forbidden', 'logged_out', 'INTERNAL', 'invalid-credentials', '']) {
      expect(accepts(apiErrorSchema, { error: { code, request_id: REQUEST_ID } }), code).toBe(
        false,
      );
    }
  });

  it('rate_limited lleva siempre los segundos que faltan, de 1 a 3600, y ningún otro código los lleva', () => {
    for (const seconds of [1, 30, 3600]) {
      expect(
        apiErrorSchema.parse({
          error: { code: 'rate_limited', request_id: REQUEST_ID, retry_after_seconds: seconds },
        }),
      ).toEqual({
        error: { code: 'rate_limited', request_id: REQUEST_ID, retry_after_seconds: seconds },
      });
    }
    for (const seconds of [0, -1, 1.5, 3601, '30', null]) {
      expect(
        accepts(apiErrorSchema, {
          error: { code: 'rate_limited', request_id: REQUEST_ID, retry_after_seconds: seconds },
        }),
        String(seconds),
      ).toBe(false);
    }
    expect(
      accepts(apiErrorSchema, { error: { code: 'rate_limited', request_id: REQUEST_ID } }),
    ).toBe(false);
    expect(
      accepts(apiErrorSchema, {
        error: { code: 'internal', request_id: REQUEST_ID, retry_after_seconds: 1 },
      }),
    ).toBe(false);
  });

  it('password_rejected lleva siempre su motivo, de una lista cerrada, y ningún otro código lo lleva', () => {
    expect(PASSWORD_REJECTION_REASONS).toEqual([
      'too_short',
      'too_long',
      'common_password',
      'context_words',
    ]);
    for (const reason of PASSWORD_REJECTION_REASONS) {
      expect(
        apiErrorSchema.parse({
          error: { code: 'password_rejected', request_id: REQUEST_ID, reason },
        }),
      ).toEqual({ error: { code: 'password_rejected', request_id: REQUEST_ID, reason } });
    }
    for (const reason of ['weak', 'TOO_SHORT', '', null]) {
      expect(
        accepts(apiErrorSchema, {
          error: { code: 'password_rejected', request_id: REQUEST_ID, reason },
        }),
        String(reason),
      ).toBe(false);
    }
    expect(
      accepts(apiErrorSchema, { error: { code: 'password_rejected', request_id: REQUEST_ID } }),
    ).toBe(false);
    expect(
      accepts(apiErrorSchema, {
        error: { code: 'invalid_link', request_id: REQUEST_ID, reason: 'too_short' },
      }),
    ).toBe(false);
  });

  it('no admite un mensaje, una traza ni otros campos', () => {
    for (const extra of [{ message: 'detalle' }, { stack: 'Error: …' }, { status: 500 }]) {
      expect(
        accepts(apiErrorSchema, { error: { code: 'internal', request_id: REQUEST_ID, ...extra } }),
      ).toBe(false);
    }
    expect(
      accepts(apiErrorSchema, {
        error: { code: 'internal', request_id: REQUEST_ID },
        message: 'detalle',
      }),
    ).toBe(false);
  });

  it('exige un UUID como identificador de la petición', () => {
    for (const requestId of ['1', 'req-1', '', REQUEST_ID.toUpperCase().replace('4000', 'G000')]) {
      expect(accepts(apiErrorSchema, { error: { code: 'internal', request_id: requestId } })).toBe(
        false,
      );
    }
  });
});

describe('ApiHealth', () => {
  it('solo acepta { status: "ok" }', () => {
    expect(apiHealthSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    for (const value of [{ status: 'healthy' }, { status: 'ok', version: '1' }, {}, null]) {
      expect(accepts(apiHealthSchema, value)).toBe(false);
    }
  });
});

describe('nombre de usuario', () => {
  it('de 3 a 32 caracteres: minúsculas sin acentos, cifras, - y _', () => {
    for (const name of ['abc', 'pedro', 'pedro_perez-2', 'a'.repeat(32), '0-_']) {
      expect(accepts(usernameSchema, name), name).toBe(true);
    }
    for (const name of ['ab', 'a'.repeat(33), 'Pedro', 'pédro', 'pedro perez', 'pedro.perez', '']) {
      expect(accepts(usernameSchema, name), name).toBe(false);
    }
  });
});

describe('POST /api/v1/enlace/secreto', () => {
  it('la petición solo lleva el token del enlace, 32 bytes en base64url canónico', () => {
    expect(linkSecretRequestSchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    for (const token of ['w', 'A', '0', '4']) {
      expect(accepts(linkSecretRequestSchema, { token: `${TOKEN.slice(0, 42)}${token}` })).toBe(
        true,
      );
    }
    for (const token of [
      // El último de 43 caracteres lleva 4 bits y dos ceros: B (1), 9 (61) o _ (63) no son de 32 bytes.
      `${TOKEN.slice(0, 42)}B`,
      `${TOKEN.slice(0, 42)}9`,
      `${TOKEN.slice(0, 42)}_`,
      TOKEN.slice(0, 42),
      `${TOKEN}A`,
      `${TOKEN.slice(0, 41)}+A`,
      `${TOKEN}=`,
      '',
    ]) {
      expect(accepts(linkSecretRequestSchema, { token }), token).toBe(false);
    }
    expect(accepts(linkSecretRequestSchema, { token: TOKEN, password: 'x' })).toBe(false);
  });

  it('la respuesta lleva el propósito, el usuario, el vencimiento y el secreto TOTP con su URI', () => {
    const secret = {
      purpose: 'enrollment',
      username: 'pedro',
      expires_at_utc: '2026-11-03T12:15:00.000Z',
      totp: { secret: TOTP_SECRET, uri: TOTP_URI },
    };
    expect(linkSecretSchema.parse(secret)).toEqual(secret);
    expect(accepts(linkSecretSchema, { ...secret, purpose: 'reset' })).toBe(true);
    for (const purpose of ['login', 'Enrollment', '']) {
      expect(accepts(linkSecretSchema, { ...secret, purpose })).toBe(false);
    }
    expect(accepts(linkSecretSchema, { ...secret, expires_at_utc: '2026-11-03T12:15:00Z' })).toBe(
      false,
    );
    expect(accepts(linkSecretSchema, { ...secret, extra: 1 })).toBe(false);
  });

  it('el secreto son 32 caracteres de base32 y la URI repite exactamente el usuario y el secreto', () => {
    const base = {
      purpose: 'enrollment',
      username: 'pedro',
      expires_at_utc: '2026-11-03T12:15:00.000Z',
    };
    for (const totp of [
      {
        secret: TOTP_SECRET.toLowerCase(),
        uri: TOTP_URI.replace(TOTP_SECRET, TOTP_SECRET.toLowerCase()),
      },
      {
        secret: `${TOTP_SECRET.slice(0, 31)}1`,
        uri: TOTP_URI.replace(TOTP_SECRET, `${TOTP_SECRET.slice(0, 31)}1`),
      },
      {
        secret: TOTP_SECRET.slice(0, 31),
        uri: TOTP_URI.replace(TOTP_SECRET, TOTP_SECRET.slice(0, 31)),
      },
      { secret: TOTP_SECRET, uri: TOTP_URI.replace('buoh:pedro', 'buoh:otro') },
      { secret: TOTP_SECRET, uri: TOTP_URI.replace(TOTP_SECRET, 'A'.repeat(32)) },
      { secret: TOTP_SECRET, uri: TOTP_URI.replace('digits=6', 'digits=8') },
      { secret: TOTP_SECRET, uri: TOTP_URI.replace('SHA1', 'SHA256') },
      { secret: TOTP_SECRET, uri: `${TOTP_URI}&extra=1` },
      { secret: TOTP_SECRET, uri: TOTP_URI.replace('otpauth://totp/', 'otpauth://hotp/') },
    ]) {
      expect(accepts(linkSecretSchema, { ...base, totp }), JSON.stringify(totp)).toBe(false);
    }
  });
});

describe('POST /api/v1/enlace', () => {
  const use = { token: TOKEN, password: 'una contraseña larga de prueba', code: '012345' };

  it('la petición lleva el token, la contraseña nueva y un código de 6 cifras', () => {
    expect(linkUseRequestSchema.parse(use)).toEqual(use);
    for (const code of ['12345', '1234567', '12345a', '١٢٣٤٥٦', ' 12345', '']) {
      expect(accepts(linkUseRequestSchema, { ...use, code }), code).toBe(false);
    }
    expect(accepts(linkUseRequestSchema, { ...use, password: '' })).toBe(false);
    // Un sustituto suelto no es texto Unicode: en UTF-8 se convertiría en otro carácter.
    for (const password of [
      'contraseña larga \ud800 de prueba',
      'contraseña larga \udfff de prueba',
    ]) {
      expect(accepts(linkUseRequestSchema, { ...use, password })).toBe(false);
    }
    expect(
      accepts(linkUseRequestSchema, { ...use, password: 'contraseña larga 🦉 de prueba' }),
    ).toBe(true);
    expect(accepts(linkUseRequestSchema, { ...use, password: 'x'.repeat(1024) })).toBe(true);
    expect(accepts(linkUseRequestSchema, { ...use, password: 'x'.repeat(1025) })).toBe(false);
    expect(accepts(linkUseRequestSchema, { ...use, username: 'pedro' })).toBe(false);
  });

  it('la respuesta dice si dio de alta la cuenta o restableció la credencial', () => {
    for (const result of ['account_enrolled', 'credential_reset'] as const) {
      expect(linkUseSchema.parse({ result })).toEqual({ result });
    }
    for (const value of [{ result: 'session_started' }, {}, { result: 'account_enrolled', x: 1 }]) {
      expect(accepts(linkUseSchema, value)).toBe(false);
    }
  });
});

describe('POST /api/v1/sesion y GET /api/v1/sesion (ADR-0019 §1 y §2)', () => {
  const login = { username: 'pedro', password: 'una contraseña larga de prueba', code: '012345' };
  const CSRF = 'a'.repeat(64);

  it('el inicio de sesión lleva el nombre, la contraseña y un código de 6 cifras', () => {
    expect(sessionLoginRequestSchema.parse(login)).toEqual(login);
    for (const code of ['12345', '1234567', '12345a', '١٢٣٤٥٦', '']) {
      expect(accepts(sessionLoginRequestSchema, { ...login, code }), code).toBe(false);
    }
    for (const username of ['ab', 'Pedro', 'pedro perez', '']) {
      expect(accepts(sessionLoginRequestSchema, { ...login, username }), username).toBe(false);
    }
    expect(accepts(sessionLoginRequestSchema, { ...login, password: '' })).toBe(false);
    expect(accepts(sessionLoginRequestSchema, { ...login, password: 'x'.repeat(1025) })).toBe(
      false,
    );
    expect(accepts(sessionLoginRequestSchema, { ...login, password: 'x \ud800 y' })).toBe(false);
    expect(accepts(sessionLoginRequestSchema, { ...login, token: 'x' })).toBe(false);
  });

  it('la respuesta lleva solo el token CSRF, 64 hexadecimales en minúscula', () => {
    expect(sessionInfoSchema.parse({ csrf_token: CSRF })).toEqual({ csrf_token: CSRF });
    for (const token of [
      CSRF.toUpperCase(),
      CSRF.slice(0, 63),
      `${CSRF}a`,
      `${CSRF.slice(0, 62)}zz`,
      '',
    ]) {
      expect(accepts(sessionInfoSchema, { csrf_token: token }), token).toBe(false);
    }
    expect(accepts(sessionInfoSchema, { csrf_token: CSRF, extra: 1 })).toBe(false);
    expect(accepts(sessionInfoSchema, {})).toBe(false);
  });

  it('el cuerpo de un cierre es un objeto vacío, y su respuesta dice cuántas se cerraron', () => {
    expect(emptyRequestSchema.parse({})).toEqual({});
    expect(accepts(emptyRequestSchema, { x: 1 })).toBe(false);
    for (const closed of [0, 1, 9, 1000]) {
      expect(sessionsClosedResultSchema.parse({ closed })).toEqual({ closed });
    }
    for (const closed of [-1, 1.5, 1001, '1', null]) {
      expect(accepts(sessionsClosedResultSchema, { closed }), String(closed)).toBe(false);
    }
  });
});

describe('GET /api/v1/auditoria (ADR-0019 §5)', () => {
  const event = {
    schema_version: '1.0.0',
    audit_event_id: '01900000-0000-7000-8000-000000000001',
    occurred_at_utc: '2026-11-03T12:00:00.000Z',
    account_id: '01900000-0000-7000-8000-00000000a001',
    actor: 'account',
    action: 'session_started',
    reason: 'password_and_totp',
    objects: [{ kind: 'session', id: '01900000-0000-7000-8000-00000000b001' }],
    request_id: REQUEST_ID,
  };

  it('es una lista de entradas de auditoría', () => {
    expect(auditEventsResponseSchema.parse({ events: [event] })).toEqual({ events: [event] });
    expect(auditEventsResponseSchema.parse({ events: [] })).toEqual({ events: [] });
    expect(accepts(auditEventsResponseSchema, { events: [{ ...event, action: 'otra' }] })).toBe(
      false,
    );
    expect(accepts(auditEventsResponseSchema, { events: event })).toBe(false);
    expect(accepts(auditEventsResponseSchema, { events: [event], extra: 1 })).toBe(false);
  });
});
