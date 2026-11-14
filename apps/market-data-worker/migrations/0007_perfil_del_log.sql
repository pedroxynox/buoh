-- F2.5 · El perfil de calidad de cada log (ADR-0020 §4). La tabla es append-only.

-- El perfil con el que se deriva el log entero: el estado vivo de ingest, la reparación de cierres,
-- la vigilancia de huecos, data:health y el gráfico de la API lo arman desde esta fila y el esquema
-- de fuente que guardó la ingesta. Sin fila, el log sigue con el perfil de medición. Admite como
-- mucho una fila: profile_slot solo vale 1. La inserta solo buoh-operaciones, como buoh_dueno, en un
-- log sin escrituras en el que buoh_ingesta todavía no tiene el uso del esquema, después de sus
-- migraciones y antes de darle los privilegios; buoh_ingesta y buoh_lectura solo la leen
-- (ADR-0020 §4 y ADR-0018 §8). profile_id es el profile_id del perfil de calidad y
-- quality_profile_sha256 el SHA-256 de su JCS, con el que quien lo arma comprueba que es el mismo.
CREATE TABLE log_quality_profile (
  profile_slot smallint PRIMARY KEY DEFAULT 1 CHECK (profile_slot = 1),
  profile_id text NOT NULL CHECK (profile_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  quality_profile_sha256 text NOT NULL CHECK (quality_profile_sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  assigned_at_utc text NOT NULL
    CHECK (assigned_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

CREATE TRIGGER log_quality_profile_append_only
  BEFORE UPDATE OR DELETE ON log_quality_profile
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER log_quality_profile_no_truncate
  BEFORE TRUNCATE ON log_quality_profile
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
