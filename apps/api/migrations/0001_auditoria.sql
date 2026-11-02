-- F2.3 · La auditoría de la API (ADR-0019 §5 y §7), en el esquema buoh_api. Cada fila es un
-- AuditEvent (contratos de dominio, «AuditEvent») en JCS, con las columnas que se consultan, que la
-- base comprueba iguales a las del documento. Es append-only como las tablas de los logs: el rol
-- buoh_api solo inserta y lee, y los triggers rechazan UPDATE, DELETE y TRUNCATE, también al dueño.

-- La función de los triggers, propia del esquema: la de cada log se borra con su log.
CREATE FUNCTION buoh_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'buoh: % no permitido en la tabla append-only %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- account_id es NULL en las entradas que no son de ninguna cuenta (ADR-0019 §4). Las horas son el
-- texto UTC del contrato, con milisegundos, como en los logs. Cada comprobación con el documento
-- usa IS NOT DISTINCT FROM: un campo que falta en el documento no la cumple, cuando con «=» daría
-- NULL y la cumpliría. Un documento que no es un objeto JSON no tiene esos campos.
CREATE TABLE audit_events (
  audit_event_id uuid PRIMARY KEY,
  account_id uuid,
  occurred_at_utc text NOT NULL
    CHECK (occurred_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_]{0,62}$'),
  event_jcs text NOT NULL,
  CHECK ((event_jcs::jsonb ->> 'audit_event_id') IS NOT DISTINCT FROM audit_event_id::text),
  CHECK (
    event_jcs::jsonb ? 'account_id'
    AND (event_jcs::jsonb ->> 'account_id') IS NOT DISTINCT FROM account_id::text
  ),
  CHECK ((event_jcs::jsonb ->> 'occurred_at_utc') IS NOT DISTINCT FROM occurred_at_utc),
  CHECK ((event_jcs::jsonb ->> 'action') IS NOT DISTINCT FROM action)
);

-- Las entradas de una cuenta en el orden de sus identificadores UUIDv7, el de su hora: la sección
-- Auditoría (ADR-0019 §5).
CREATE INDEX audit_events_by_account ON audit_events (account_id, audit_event_id);

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
