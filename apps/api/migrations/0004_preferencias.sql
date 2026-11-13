-- F2.4 · Las preferencias de cada cuenta (ADR-0019 §7; F2-UI-001), en el esquema buoh_api. En la
-- Fase 2 solo el tema de la web: noche (night) o día (day). Como las demás tablas, es append-only:
-- el rol buoh_api solo inserta y lee, y los triggers rechazan UPDATE, DELETE y TRUNCATE, también
-- al dueño. Un cambio es una fila nueva, y vale la última de la cuenta por write_order. Sin ninguna,
-- el tema es noche. Las funciones buoh_reject_mutation() (migración 0001) y
-- buoh_assign_write_order() (0002) ya existen; esta tabla las reutiliza.
CREATE TABLE account_preferences (
  preference_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts (account_id),
  theme text NOT NULL CHECK (theme IN ('night', 'day')),
  set_at_utc text NOT NULL
    CHECK (set_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

CREATE INDEX account_preferences_by_account ON account_preferences (account_id, write_order);

-- write_order lo asigna la base, como en las tablas de la migración 0002: así nadie guarda una
-- fila que ninguna posterior pueda superar.
CREATE TRIGGER account_preferences_write_order
  BEFORE INSERT ON account_preferences
  FOR EACH ROW EXECUTE FUNCTION buoh_assign_write_order();

CREATE TRIGGER account_preferences_append_only
  BEFORE UPDATE OR DELETE ON account_preferences
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER account_preferences_no_truncate
  BEFORE TRUNCATE ON account_preferences
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
