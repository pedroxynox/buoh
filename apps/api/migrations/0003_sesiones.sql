-- F2.3 · Las sesiones de la API (ADR-0019 §2), en el esquema buoh_api: las sesiones abiertas, su
-- actividad y sus cierres. Como las demás tablas, cada una es append-only: el rol buoh_api solo
-- inserta y lee, y los triggers rechazan UPDATE, DELETE y TRUNCATE, también al dueño. Nada se
-- modifica: la actividad y el cierre de una sesión son filas nuevas. Una sesión vale si no está
-- cerrada, no venció (24 h desde que empezó) y no lleva más de 1 h sin actividad del propietario.
-- Las funciones buoh_reject_mutation() (migración 0001) y buoh_assign_write_order() (0002) ya
-- existen; estas tablas las reutilizan.

-- Una sesión. De su identificador de 32 bytes aleatorios solo se guarda el HMAC-SHA-256 con
-- BUOH_API_TOKEN_KEY, que no está en la base: quien inserte una fila no fabrica una sesión válida.
-- write_order la ordena por antigüedad para el tope de 10 (una nueva cierra la más antigua), y lo
-- asigna siempre la base, aunque el INSERT traiga otro con OVERRIDING SYSTEM VALUE.
CREATE TABLE sessions (
  session_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts (account_id),
  token_hmac bytea NOT NULL UNIQUE CHECK (octet_length(token_hmac) = 32),
  created_at_utc text NOT NULL
    CHECK (created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  expires_at_utc text NOT NULL
    CHECK (expires_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  CHECK (expires_at_utc > created_at_utc)
);

CREATE INDEX sessions_by_account ON sessions (account_id, write_order);

-- La actividad del propietario en una sesión, como mucho una fila por minuto (lo limita la API, no
-- la base). La inactividad se mide con la hora más reciente entre la creación de la sesión y estas
-- filas.
CREATE TABLE session_activity (
  session_activity_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (session_id),
  activity_at_utc text NOT NULL
    CHECK (activity_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

CREATE INDEX session_activity_by_session ON session_activity (session_id, activity_at_utc);

-- El cierre de una sesión, una sola vez (clave primaria por sesión): «Cerrar sesión» (logout), el
-- tope de 10 (session_limit), «Cerrar las demás sesiones» (other_sessions), la orden cuenta
-- (operator_command) o un restablecimiento (credential_reset).
CREATE TABLE session_closures (
  session_id uuid PRIMARY KEY REFERENCES sessions (session_id),
  reason text NOT NULL
    CHECK (reason IN ('logout', 'session_limit', 'other_sessions', 'operator_command', 'credential_reset')),
  closed_at_utc text NOT NULL
    CHECK (closed_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

-- write_order lo asigna la base, como en las tablas de la migración 0002.
CREATE TRIGGER sessions_write_order
  BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION buoh_assign_write_order();

CREATE TRIGGER sessions_append_only
  BEFORE UPDATE OR DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER sessions_no_truncate
  BEFORE TRUNCATE ON sessions
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER session_activity_append_only
  BEFORE UPDATE OR DELETE ON session_activity
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER session_activity_no_truncate
  BEFORE TRUNCATE ON session_activity
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER session_closures_append_only
  BEFORE UPDATE OR DELETE ON session_closures
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER session_closures_no_truncate
  BEFORE TRUNCATE ON session_closures
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
