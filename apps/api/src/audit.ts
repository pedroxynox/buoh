import { auditEventSchema, canonicalJson, type AuditEvent } from '@buoh/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Guarda una entrada de la auditoría (ADR-0019 §5) en `buoh_api.audit_events`: el documento en JCS
 * y las columnas que se consultan, que la base comprueba iguales a las del documento. La entrada se
 * valida antes con su contrato, así que nunca se guarda una que no lo cumple. Acepta un cliente de
 * la transacción o el pool (los fallos agrupados se escriben fuera de transacción).
 */
export async function insertAuditEvent(
  client: Pick<Pool | PoolClient, 'query'>,
  event: AuditEvent,
): Promise<void> {
  const parsed = auditEventSchema.parse(event);
  await client.query(
    `INSERT INTO buoh_api.audit_events
       (audit_event_id, account_id, occurred_at_utc, action, event_jcs)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      parsed.audit_event_id,
      parsed.account_id,
      parsed.occurred_at_utc,
      parsed.action,
      canonicalJson(parsed),
    ],
  );
}
