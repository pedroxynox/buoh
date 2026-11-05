import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  apiErrorCodeSchema,
  apiErrorSchema,
  apiHealthSchema,
  auditEventsResponseSchema,
  DATA_CHART_MAX_HOURS,
  dataCatalogSchema,
  dataChartQuerySchema,
  dataChartSchema,
  dataHealthSchema,
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
      'storage_unavailable',
    ] as const) {
      expect(apiErrorSchema.parse({ error: { code, request_id: REQUEST_ID } })).toEqual({
        error: { code, request_id: REQUEST_ID },
      });
    }
  });

  it('cierra la lista de códigos: los del esqueleto, los del PR 4a, los del PR 4b y el de R2, en ese orden', () => {
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
      'storage_unavailable',
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

describe('GET /api/v1/datos/salud (ADR-0019 §8)', () => {
  const OBSERVED = '2026-11-04T12:55:31.204Z';
  const report = {
    backlog_bytes: 0,
    backlog_count: 0,
    connection_state: 'connected',
    execution_mode: 'disabled',
    last_event_time_utc: '2026-11-04T12:55:29.000Z',
    last_observation_id: '01900000-0000-7000-8000-000000000001',
    last_published_dataset_id: null,
    last_received_at_utc: '2026-11-04T12:55:29.412Z',
    open_condition_types: [],
    schema_version: '1.0.0',
    service_health: 'healthy',
    source: 'deriv_options',
  };
  const completed = { status: 'completed', observed_at_utc: OBSERVED, report, alerts: [] };
  const failed = {
    status: 'failed',
    observed_at_utc: OBSERVED,
    reason: 'child_timeout',
    code: null,
  };

  it('el log activo y su última observación: terminada con su HealthReport, fallida con su motivo, o ninguna', () => {
    for (const value of [
      { log: 2, observation: completed },
      { log: 2, observation: { ...completed, report: { ...report, service_health: 'paused' } } },
      { log: 2, observation: failed },
      { log: 2, observation: { ...failed, reason: '57P01' } },
      {
        log: 2,
        observation: {
          ...completed,
          report: {
            ...report,
            connection_state: 'disconnected',
            last_event_time_utc: null,
            last_observation_id: null,
            last_received_at_utc: null,
            service_health: 'paused',
          },
          alerts: [
            { event: 'data_health_storage_unavailable', reason: null },
            { event: 'checkpoint_rejected', reason: 'checkpoint_link_mismatch' },
          ],
        },
      },
      {
        log: 2,
        observation: { ...failed, reason: 'health_command_failed', code: 'ConfigError' },
      },
      { log: 3, observation: null },
      { log: null, observation: null },
    ]) {
      expect(dataHealthSchema.parse(value)).toEqual(value);
    }
  });

  it('sin log activo no hay observación', () => {
    expect(accepts(dataHealthSchema, { log: null, observation: completed })).toBe(false);
    expect(accepts(dataHealthSchema, { log: null, observation: failed })).toBe(false);
  });

  it('el log es un número de 1 a 999 999', () => {
    for (const log of [0, -1, 1.5, 1_000_000, '2']) {
      expect(accepts(dataHealthSchema, { log, observation: null }), String(log)).toBe(false);
    }
    expect(accepts(dataHealthSchema, { log: 999_999, observation: null })).toBe(true);
  });

  it('cada estado lleva solo lo suyo, con la hora UTC con milisegundos, y un motivo saneado', () => {
    for (const observation of [
      { ...completed, reason: 'child_timeout' },
      { status: 'completed', observed_at_utc: OBSERVED },
      { ...failed, report },
      { status: 'failed', observed_at_utc: OBSERVED },
      { ...failed, reason: 'connect ECONNREFUSED 10.0.0.5:5432' },
      { ...failed, reason: '' },
      { ...failed, observed_at_utc: '2026-11-04T12:55:31Z' },
      { ...completed, report: { ...report, extra: 1 } },
      // Un HealthReport que no cumple sus reglas: healthy con una condición abierta.
      { ...completed, report: { ...report, open_condition_types: ['connection_lost'] } },
      { ...completed, extra: 1 },
      { ...completed, status: 'pending' },
      // Las alertas y el código: siempre, saneados, y cada uno en su estado.
      { status: 'completed', observed_at_utc: OBSERVED, report },
      { ...completed, alerts: [{ event: 'data_health_failed' }] },
      { ...completed, alerts: [{ event: 'con espacios', reason: null }] },
      { ...completed, alerts: [{ event: 'x', reason: 'connect ECONNREFUSED 10.0.0.5' }] },
      { ...completed, alerts: [{ event: 'x', reason: null, extra: 1 }] },
      { ...completed, code: null },
      { status: 'failed', observed_at_utc: OBSERVED, reason: 'child_timeout' },
      { ...failed, code: 'Configuración inválida' },
      { ...failed, alerts: [] },
    ]) {
      expect(accepts(dataHealthSchema, { log: 2, observation }), JSON.stringify(observation)).toBe(
        false,
      );
    }
    expect(accepts(dataHealthSchema, { log: 2, observation: null, extra: 1 })).toBe(false);
  });
});

describe('DataChartQuery', () => {
  it(`las horas son un entero de 1 a ${String(DATA_CHART_MAX_HOURS)}, escrito sin ceros delante`, () => {
    for (let hours = 1; hours <= DATA_CHART_MAX_HOURS; hours += 1) {
      expect(dataChartQuerySchema.parse({ hours: String(hours) })).toEqual({
        hours: String(hours),
      });
    }
    for (const hours of ['0', String(DATA_CHART_MAX_HOURS + 1), '01', '6.0', '', ' 6', 'x', 6]) {
      expect(accepts(dataChartQuerySchema, { hours }), String(hours)).toBe(false);
    }
    expect(accepts(dataChartQuerySchema, {})).toBe(false);
    expect(accepts(dataChartQuerySchema, { hours: '6', extra: '1' })).toBe(false);
  });
});

describe('DataChart', () => {
  const FROM = '2026-11-08T06:00:00.000Z';
  const TO = '2026-11-08T12:00:00.000Z';
  const empty = {
    log: 3,
    source: 'deriv_options',
    symbol: 'R_100',
    from_utc: FROM,
    to_utc: TO,
    log_started_at_utc: '2026-11-08T00:00:04.646Z',
    ticks: { offsets_ms: [], quotes: [] },
    gaps: [],
  };
  const recovered = {
    from_utc: '2026-11-08T07:00:00.001Z',
    to_utc: '2026-11-08T07:00:05.999Z',
    cause: 'connection_lost',
    history: 'recovered',
    reason: null,
    recovered_ticks: 2,
  };
  const chart = {
    ...empty,
    ticks: { offsets_ms: [0, 2000, 6 * 3_600_000], quotes: ['1234.56', '1234.60', '1201.08'] },
    gaps: [
      // Empezó antes de la ventana: la toca.
      {
        from_utc: '2026-11-08T05:58:00.001Z',
        to_utc: '2026-11-08T06:00:01.999Z',
        cause: 'capture_stopped',
        history: 'not_requested',
        reason: null,
        recovered_ticks: null,
      },
      recovered,
      {
        ...recovered,
        from_utc: '2026-11-08T08:00:00.001Z',
        to_utc: '2026-11-08T08:00:09.999Z',
        history: 'partial',
        reason: 'history_page_limit',
        recovered_ticks: 3,
      },
      {
        ...recovered,
        from_utc: '2026-11-08T09:00:00.001Z',
        to_utc: '2026-11-08T09:00:09.999Z',
        history: 'unavailable',
        reason: 'history_timeout',
        recovered_ticks: null,
      },
      {
        ...recovered,
        from_utc: '2026-11-08T11:59:00.001Z',
        to_utc: null,
        history: 'pending',
        recovered_ticks: null,
      },
    ],
  };

  it('el gráfico del log activo, con un tick por instante y cada clase de hueco, o vacío', () => {
    for (const value of [
      chart,
      empty,
      { ...empty, log: null, log_started_at_utc: null },
      { ...empty, log_started_at_utc: null },
      {
        ...empty,
        from_utc: '2026-11-07T12:00:00.000Z',
        ticks: { offsets_ms: [24 * 3_600_000], quotes: ['1.5'] },
      },
      { ...empty, from_utc: '2026-11-08T11:00:00.000Z' },
    ]) {
      expect(dataChartSchema.parse(value)).toEqual(value);
    }
  });

  it('la ventana dura horas enteras, de 1 a la máxima, y termina después de empezar', () => {
    for (const from_utc of [
      TO,
      '2026-11-08T12:00:00.001Z',
      '2026-11-08T06:00:00.001Z',
      '2026-11-07T11:00:00.000Z',
    ]) {
      expect(accepts(dataChartSchema, { ...empty, from_utc }), from_utc).toBe(false);
    }
  });

  it('cada tick tiene su hora dentro de la ventana, en orden y sin repetir, y su cotización decimal', () => {
    for (const ticks of [
      { offsets_ms: [0, 2000], quotes: ['1.5'] },
      { offsets_ms: [2000, 0], quotes: ['1.5', '1.6'] },
      { offsets_ms: [2000, 2000], quotes: ['1.5', '1.6'] },
      { offsets_ms: [6 * 3_600_000 + 1], quotes: ['1.5'] },
      { offsets_ms: [-1], quotes: ['1.5'] },
      { offsets_ms: [1.5], quotes: ['1.5'] },
      { offsets_ms: [0], quotes: ['1e3'] },
      { offsets_ms: [0], quotes: [1.5] },
      { offsets_ms: [0], quotes: ['1.5'], extra: [] },
    ]) {
      expect(accepts(dataChartSchema, { ...empty, ticks }), JSON.stringify(ticks)).toBe(false);
    }
  });

  it('sin log activo no hay ticks, huecos ni inicio del log', () => {
    const none = { ...empty, log: null, log_started_at_utc: null };
    expect(accepts(dataChartSchema, { ...none, ticks: chart.ticks })).toBe(false);
    expect(accepts(dataChartSchema, { ...none, gaps: [recovered] })).toBe(false);
    expect(accepts(dataChartSchema, { ...none, log_started_at_utc: FROM })).toBe(false);
  });

  it('cada hueco lleva lo de su clase, toca la ventana y van en orden de inicio', () => {
    for (const gap of [
      // Una parada pedida no se recupera, y solo ella es not_requested.
      { ...recovered, cause: 'capture_stopped' },
      { ...recovered, history: 'not_requested', recovered_ticks: null },
      // Solo un hueco sin resolver lleva motivo.
      { ...recovered, reason: 'history_page_limit' },
      { ...recovered, history: 'partial', recovered_ticks: 3 },
      { ...recovered, history: 'unavailable', recovered_ticks: null },
      // Solo la historia que trajo ticks los cuenta.
      { ...recovered, recovered_ticks: null },
      { ...recovered, history: 'pending' },
      { ...recovered, history: 'unavailable', reason: 'history_timeout' },
      // Sin fin, solo uno que sigue.
      { ...recovered, to_utc: null },
      { ...recovered, to_utc: '2026-11-08T07:00:00.000Z' },
      // Un motivo saneado, nunca un mensaje.
      {
        ...recovered,
        history: 'partial',
        reason: 'la historia no llegó',
        recovered_ticks: 0,
      },
      { ...recovered, cause: 'other' },
      { ...recovered, recovered_ticks: -1 },
      { ...recovered, extra: 1 },
      // Fuera de la ventana.
      { ...recovered, from_utc: '2026-11-08T12:00:00.001Z', to_utc: '2026-11-08T12:00:05.999Z' },
      { ...recovered, from_utc: '2026-11-08T05:00:00.001Z', to_utc: '2026-11-08T05:59:59.999Z' },
    ]) {
      expect(accepts(dataChartSchema, { ...empty, gaps: [gap] }), JSON.stringify(gap)).toBe(false);
    }
    const [first, second] = chart.gaps;
    expect(accepts(dataChartSchema, { ...empty, gaps: [second, first] })).toBe(false);
  });

  it('no admite campos de más', () => {
    expect(accepts(dataChartSchema, { ...empty, extra: 1 })).toBe(false);
    expect(accepts(dataChartSchema, { ...empty, symbol: '' })).toBe(false);
  });
});

describe('DataCatalog', () => {
  const entry = {
    underlying_symbol: 'R_100',
    underlying_symbol_name: 'Volatility 100 Index',
    underlying_symbol_type: 'stockindex',
    market: 'synthetic_index',
    submarket: 'random_index',
    subgroup: 'synthetics',
    pip_size: '0.01',
    exchange_is_open: 1,
    is_trading_suspended: 0,
  };
  const catalog = {
    source: 'deriv_options',
    version: 26,
    received_at_utc: '2026-11-05T04:30:51.999Z',
    source_schema_release: 'deriv-api-2026-10-20',
    content_sha256: 'a'.repeat(64),
    entries: [{ ...entry, underlying_symbol: 'R_10' }, entry],
  };

  it('la última versión del log activo, con su número, su hora y sus entradas, o ninguna', () => {
    for (const value of [
      { log: 2, catalog },
      { log: 3, catalog: null },
      { log: null, catalog: null },
    ]) {
      expect(dataCatalogSchema.parse(value)).toEqual(value);
    }
  });

  it('sin log activo no hay catálogo, y sus entradas van en orden de símbolo, sin repetir', () => {
    expect(accepts(dataCatalogSchema, { log: null, catalog })).toBe(false);
    expect(
      accepts(dataCatalogSchema, { log: 2, catalog: { ...catalog, entries: [entry, entry] } }),
    ).toBe(false);
    expect(
      accepts(dataCatalogSchema, {
        log: 2,
        catalog: { ...catalog, entries: [...catalog.entries].reverse() },
      }),
    ).toBe(false);
    expect(accepts(dataCatalogSchema, { log: 2, catalog: { ...catalog, entries: [] } })).toBe(
      false,
    );
  });

  it('cada entrada tiene los nueve campos oficiales, y la versión cuenta desde 1', () => {
    for (const value of [
      { ...catalog, version: 0 },
      { ...catalog, content_sha256: 'x' },
      { ...catalog, received_at_utc: '2026-11-05T04:30:51Z' },
      { ...catalog, entries: [{ ...entry, trade_count: 7 }] },
      { ...catalog, entries: [{ ...entry, pip_size: 0.01 }] },
      { ...catalog, extra: 1 },
    ]) {
      expect(accepts(dataCatalogSchema, { log: 2, catalog: value }), JSON.stringify(value)).toBe(
        false,
      );
    }
  });
});
