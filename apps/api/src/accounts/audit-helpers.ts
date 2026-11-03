import type { AuditEvent, AuditObject } from '@buoh/contracts';

/** Los campos de una entrada de auditoría, salvo su versión, su identificador y su hora. */
type WithoutIdentity<T> = T extends unknown
  ? Omit<T, 'schema_version' | 'audit_event_id' | 'occurred_at_utc'>
  : never;
export type AuditFields = WithoutIdentity<AuditEvent>;

/**
 * Los objetos de una entrada de auditoría en el orden del contrato: por clase y después por
 * identificador (`auditEventSchema` los exige únicos y ordenados).
 */
export function auditObjects(...objects: AuditObject[]): AuditObject[] {
  return objects.sort((a, b) => {
    const left = `${a.kind}:${a.id}`;
    const right = `${b.kind}:${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Una entrada de auditoría con su versión 1.0.0, su identificador UUIDv7 nuevo y su hora. */
export function auditEvent(newId: () => string, fields: AuditFields, nowUtc: string): AuditEvent {
  return {
    schema_version: '1.0.0',
    audit_event_id: newId(),
    occurred_at_utc: nowUtc,
    ...fields,
  };
}
