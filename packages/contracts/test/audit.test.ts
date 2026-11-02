import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import * as publicContracts from '../src/index.js';
import {
  AUDIT_ACTIONS,
  AUDIT_EVENT_SCHEMA_VERSIONS,
  auditActorSchema,
  auditEventSchema,
  auditObjectKindSchema,
} from '../src/index.js';

// `AuditEvent` (ADR-0019 §5 y §6; contratos de dominio, «AuditEvent»): la entrada de la auditoría
// de la API, con su autor, su hora UTC, su acción, su motivo, sus objetos y su petición.

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

const ACCOUNT = '01900000-0000-7000-8000-000000000001';
const OTHER_ACCOUNT = '01900000-0000-7000-8000-000000000002';
const CREDENTIAL = '01900000-0000-7000-8000-000000000003';
const LINK = '01900000-0000-7000-8000-000000000004';
const SESSION_A = '01900000-0000-7000-8000-000000000005';
const SESSION_B = '01900000-0000-7000-8000-000000000006';
const EVENT = '01900000-0000-7000-8000-0000000000aa';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-03T10:00:00.000Z';

type Entry = Record<string, unknown>;

/** Una entrada de cada acción de F2.3, válida, con las claves en orden alfabético. */
const ENTRIES: Readonly<Record<(typeof AUDIT_ACTIONS)[number], Entry>> = {
  account_enrolled: {
    account_id: ACCOUNT,
    action: 'account_enrolled',
    actor: 'anonymous',
    audit_event_id: EVENT,
    objects: [
      { id: ACCOUNT, kind: 'account' },
      { id: CREDENTIAL, kind: 'credential' },
      { id: LINK, kind: 'link' },
    ],
    occurred_at_utc: AT,
    reason: 'enrollment_link',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  credential_disabled: {
    account_id: ACCOUNT,
    action: 'credential_disabled',
    actor: 'system',
    audit_event_id: EVENT,
    objects: [{ id: CREDENTIAL, kind: 'credential' }],
    occurred_at_utc: AT,
    reason: 'failure_limit',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  credential_reset: {
    account_id: ACCOUNT,
    action: 'credential_reset',
    actor: 'anonymous',
    audit_event_id: EVENT,
    objects: [
      { id: CREDENTIAL, kind: 'credential' },
      { id: LINK, kind: 'link' },
    ],
    occurred_at_utc: AT,
    reason: 'reset_link',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  link_created: {
    account_id: ACCOUNT,
    action: 'link_created',
    actor: 'operator',
    audit_event_id: EVENT,
    objects: [{ id: LINK, kind: 'link' }],
    occurred_at_utc: AT,
    reason: 'enrollment',
    request_id: null,
    schema_version: '1.0.0',
  },
  link_used: {
    account_id: ACCOUNT,
    action: 'link_used',
    actor: 'anonymous',
    audit_event_id: EVENT,
    objects: [{ id: LINK, kind: 'link' }],
    occurred_at_utc: AT,
    reason: 'reset',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  login_failed: {
    account_id: ACCOUNT,
    action: 'login_failed',
    actor: 'anonymous',
    audit_event_id: EVENT,
    objects: [{ id: CREDENTIAL, kind: 'credential' }],
    occurred_at_utc: AT,
    reason: 'invalid_credentials',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  login_failures: {
    account_id: null,
    action: 'login_failures',
    actor: 'anonymous',
    audit_event_id: EVENT,
    failure_count: 37,
    objects: [],
    occurred_at_utc: AT,
    reason: 'unknown_username',
    request_id: null,
    schema_version: '1.0.0',
    window_started_at_utc: '2026-11-03T09:55:00.000Z',
  },
  session_closed: {
    account_id: ACCOUNT,
    action: 'session_closed',
    actor: 'account',
    audit_event_id: EVENT,
    objects: [{ id: SESSION_A, kind: 'session' }],
    occurred_at_utc: AT,
    reason: 'logout',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  session_started: {
    account_id: ACCOUNT,
    action: 'session_started',
    actor: 'account',
    audit_event_id: EVENT,
    objects: [
      { id: CREDENTIAL, kind: 'credential' },
      { id: SESSION_A, kind: 'session' },
    ],
    occurred_at_utc: AT,
    reason: 'password_and_totp',
    request_id: REQUEST,
    schema_version: '1.0.0',
  },
  sessions_closed: {
    account_id: ACCOUNT,
    action: 'sessions_closed',
    actor: 'operator',
    audit_event_id: EVENT,
    objects: [
      { id: SESSION_A, kind: 'session' },
      { id: SESSION_B, kind: 'session' },
    ],
    occurred_at_utc: AT,
    reason: 'operator_command',
    request_id: null,
    schema_version: '1.0.0',
  },
};

function entry(action: (typeof AUDIT_ACTIONS)[number], changes: Entry = {}): Entry {
  return { ...ENTRIES[action], ...changes };
}

const accepts = (value: unknown): boolean => auditEventSchema.safeParse(value).success;

/** Los caminos de las incidencias con que se rechaza `value`. */
function rejectedPaths(value: unknown): string[] {
  const result = auditEventSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('AuditEvent', () => {
  it('cierra la lista de acciones de F2.3, sus autores, las clases de objetos y las versiones', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'account_enrolled',
      'credential_disabled',
      'credential_reset',
      'link_created',
      'link_used',
      'login_failed',
      'login_failures',
      'session_closed',
      'session_started',
      'sessions_closed',
    ]);
    expect(auditActorSchema.options).toEqual(['account', 'operator', 'system', 'anonymous']);
    expect(auditObjectKindSchema.options).toEqual(['account', 'credential', 'link', 'session']);
    expect(AUDIT_EVENT_SCHEMA_VERSIONS).toEqual(['1.0.0']);
    expect(Object.keys(ENTRIES).sort()).toEqual([...AUDIT_ACTIONS]);
  });

  it.each(AUDIT_ACTIONS)('acepta una entrada %s y la devuelve igual', (action) => {
    expect(auditEventSchema.parse(ENTRIES[action])).toEqual(ENTRIES[action]);
  });

  it('no tiene ningún campo para un secreto, una dirección, el navegador o el nombre escrito', () => {
    const allowed = new Set([
      'account_id',
      'action',
      'actor',
      'audit_event_id',
      'failure_count',
      'objects',
      'occurred_at_utc',
      'reason',
      'request_id',
      'schema_version',
      'window_started_at_utc',
    ]);
    for (const action of AUDIT_ACTIONS) {
      expect(
        Object.keys(ENTRIES[action]).every((key) => allowed.has(key)),
        action,
      ).toBe(true);
      for (const field of ['username', 'ip_address', 'user_agent', 'password', 'token', 'extra']) {
        expect(accepts(entry(action, { [field]: 'x' })), `${action} ${field}`).toBe(false);
      }
      expect(accepts(entry(action, { objects: [{ id: LINK, kind: 'link', token: 'x' }] }))).toBe(
        false,
      );
    }
  });

  it('rechaza una acción, un autor, un motivo o una clase de objeto que no son suyos', () => {
    expect(accepts(entry('session_started', { action: 'session_renewed' }))).toBe(false);
    expect(accepts(entry('session_started', { actor: 'anonymous' }))).toBe(false);
    expect(accepts(entry('link_created', { actor: 'account' }))).toBe(false);
    expect(accepts(entry('credential_disabled', { actor: 'operator' }))).toBe(false);
    expect(accepts(entry('login_failed', { reason: 'unknown_username' }))).toBe(false);
    expect(accepts(entry('session_closed', { reason: 'expired' }))).toBe(false);
    expect(accepts(entry('login_failed', { objects: [{ id: LINK, kind: 'username' }] }))).toBe(
      false,
    );
    expect(accepts(entry('session_started', { schema_version: '1.1.0' }))).toBe(false);
    expect(accepts(entry('session_started', { audit_event_id: REQUEST }))).toBe(false);
    expect(accepts(entry('session_started', { occurred_at_utc: '2026-11-03T10:00:00Z' }))).toBe(
      false,
    );
  });

  it('solo una entrada de intentos agrupados puede no ser de ninguna cuenta', () => {
    for (const action of AUDIT_ACTIONS.filter((name) => name !== 'login_failures')) {
      expect(accepts(entry(action, { account_id: null })), action).toBe(false);
    }
    expect(accepts(ENTRIES.login_failures)).toBe(true);
  });

  it('lleva la petición que la causó, salvo con la orden cuenta y en los intentos agrupados', () => {
    for (const action of [
      'account_enrolled',
      'credential_disabled',
      'credential_reset',
      'link_used',
      'login_failed',
      'session_closed',
      'session_started',
    ] as const) {
      expect(accepts(entry(action, { request_id: null })), action).toBe(false);
      expect(accepts(entry(action, { request_id: 'no-es-un-uuid' })), action).toBe(false);
    }
    expect(accepts(entry('link_created', { request_id: REQUEST }))).toBe(false);
    expect(accepts(entry('login_failures', { request_id: REQUEST }))).toBe(false);
    expect(rejectedPaths(entry('sessions_closed', { request_id: REQUEST }))).toEqual([
      'request_id',
    ]);
    const byAccount = { actor: 'account', reason: 'other_sessions' };
    expect(accepts(entry('sessions_closed', { ...byAccount, request_id: REQUEST }))).toBe(true);
    expect(rejectedPaths(entry('sessions_closed', { ...byAccount }))).toEqual(['request_id']);
  });

  it('pide los objetos únicos, en orden por clase e id, y al menos uno salvo en los agrupados', () => {
    const started = ENTRIES.session_started;
    const objects = started['objects'] as Entry[];
    expect(rejectedPaths({ ...started, objects: [...objects].reverse() })).toEqual(['objects']);
    expect(rejectedPaths({ ...started, objects: [objects[0], objects[0]] })).toEqual(['objects']);
    expect(rejectedPaths(entry('session_closed', { objects: [] }))).toEqual(['objects']);
    expect(accepts(entry('login_failures', { objects: [] }))).toBe(true);
  });

  it('solo nombra la cuenta de su account_id, para que ninguna cuenta vea otra', () => {
    expect(
      rejectedPaths(
        entry('account_enrolled', {
          objects: [
            { id: OTHER_ACCOUNT, kind: 'account' },
            { id: CREDENTIAL, kind: 'credential' },
          ],
        }),
      ),
    ).toEqual(['objects']);
    expect(
      rejectedPaths(
        entry('login_failures', {
          objects: [{ id: ACCOUNT, kind: 'account' }],
          reason: 'rate_limited',
        }),
      ),
    ).toEqual(['objects']);
  });

  it('en los cierres de sesión, cada motivo con su autor', () => {
    expect(accepts(entry('session_closed', { actor: 'system', reason: 'session_limit' }))).toBe(
      true,
    );
    expect(rejectedPaths(entry('session_closed', { actor: 'system' }))).toEqual(['actor']);
    expect(rejectedPaths(entry('session_closed', { reason: 'session_limit' }))).toEqual(['actor']);
    expect(
      accepts(
        entry('sessions_closed', {
          actor: 'system',
          reason: 'credential_reset',
          request_id: REQUEST,
        }),
      ),
    ).toBe(true);
    expect(
      rejectedPaths(
        entry('sessions_closed', {
          actor: 'account',
          reason: 'credential_reset',
          request_id: REQUEST,
        }),
      ),
    ).toEqual(['actor']);
    expect(rejectedPaths(entry('sessions_closed', { reason: 'other_sessions' }))).toEqual([
      'actor',
    ]);
  });

  it('agrupa los intentos con su número y su ventana, sin cuenta para un nombre que no existe', () => {
    const grouped = (changes: Entry) => entry('login_failures', changes);
    expect(accepts(grouped({ account_id: ACCOUNT, reason: 'disabled_credential' }))).toBe(true);
    expect(accepts(grouped({ account_id: ACCOUNT, reason: 'rate_limited' }))).toBe(true);
    expect(accepts(grouped({ reason: 'rate_limited' }))).toBe(true);
    expect(rejectedPaths(grouped({ account_id: ACCOUNT }))).toEqual(['account_id']);
    expect(rejectedPaths(grouped({ objects: [{ id: CREDENTIAL, kind: 'credential' }] }))).toEqual([
      'account_id',
    ]);
    expect(rejectedPaths(grouped({ reason: 'disabled_credential' }))).toEqual(['account_id']);
    expect(rejectedPaths(grouped({ window_started_at_utc: '2026-11-03T10:00:00.001Z' }))).toEqual([
      'window_started_at_utc',
    ]);
    expect(accepts(grouped({ window_started_at_utc: AT }))).toBe(true);
    for (const failure_count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(accepts(grouped({ failure_count })), String(failure_count)).toBe(false);
    }
    expect(accepts({ ...ENTRIES.login_failed, failure_count: 1 })).toBe(false);
  });

  it('su JSON Schema exportado acepta lo que acepta el runtime, y el esquema estructural no es público', () => {
    const url = import.meta.resolve('@buoh/contracts/json-schema/audit-event');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL(url), 'utf8')) as object);
    for (const action of AUDIT_ACTIONS) {
      expect(validate(ENTRIES[action]), action).toBe(true);
      expect(validate(entry(action, { extra: 1 })), action).toBe(false);
    }
    expect('auditEventStructuralSchema' in publicContracts).toBe(false);
  });
});
