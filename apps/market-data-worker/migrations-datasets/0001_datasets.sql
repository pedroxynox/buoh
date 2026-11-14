-- F2.5 · El esquema de los datasets vivos de producción, buoh_datasets (ADR-0020 §5). Tiene su
-- propia secuencia de migraciones, aparte de la de cada log, porque los datasets no viven en un log
-- y no vencen (ADR-0020 §6). Su dueño es buoh_dueno, que las aplica con el esquema en search_path,
-- así que las tablas y las funciones se nombran sin esquema. Todas las tablas son append-only, con
-- los mismos disparadores que las de la Fase 1.

CREATE FUNCTION buoh_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'buoh: % no permitido en la tabla append-only %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Datasets, sus records y sus incidencias: la forma de la migración 0001 de los logs.
CREATE TABLE datasets (
  dataset_id text PRIMARY KEY,
  state text NOT NULL CHECK (state = 'published'),
  source text NOT NULL CHECK (source <> ''),
  manifest_core_jcs text NOT NULL,
  CHECK (dataset_id ~ '^sha256:[0-9a-f]{64}$'),
  -- dataset_id es el hash del manifest_core canónico (ADR-0004 §5).
  CHECK (dataset_id = 'sha256:' || encode(sha256(convert_to(manifest_core_jcs, 'UTF8')), 'hex'))
);

CREATE TABLE published_manifest_records (
  publication_id uuid PRIMARY KEY,
  deployment_environment text NOT NULL
    CHECK (deployment_environment IN ('development', 'test', 'staging', 'production')),
  dataset_id text NOT NULL REFERENCES datasets (dataset_id),
  schema_version text NOT NULL
    CHECK (schema_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  manifest_document_sha256 text NOT NULL CHECK (manifest_document_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_object_uri text NOT NULL CHECK (manifest_object_uri <> ''),
  manifest_object_bytes_sha256 text NOT NULL
    CHECK (manifest_object_bytes_sha256 ~ '^[0-9a-f]{64}$'),
  published_at_utc text NOT NULL
    CHECK (published_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  state text NOT NULL CHECK (state IN ('active', 'superseded')),
  -- Para que el rango y cada verificación citen una publicación de su propio dataset.
  UNIQUE (publication_id, dataset_id)
);

-- Como mucho un record activo por dataset y entorno (ADR-0004 §8).
CREATE UNIQUE INDEX published_manifest_records_one_active
  ON published_manifest_records (dataset_id, deployment_environment)
  WHERE state = 'active';

CREATE TABLE dataset_quality_incidents (
  dataset_id text NOT NULL REFERENCES datasets (dataset_id),
  incident_id text NOT NULL CHECK (incident_id ~ '^sha256:[0-9a-f]{64}$'),
  incident_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  symbol text,
  observed_at_utc text NOT NULL,
  incident_jcs text NOT NULL,
  PRIMARY KEY (dataset_id, incident_id)
);

-- El log y los segmentos de cada dataset, y cómo terminó (ADR-0020 §5 y §7). La inserta el mismo
-- COMMIT que hace visible el dataset, con la publicación que lo hizo visible. Un dataset es un rango
-- contiguo de segmentos cerrados de un solo log: el primero empieza en el segmento 0 y cada
-- siguiente, en el siguiente al último del anterior, así que no hay solapes ni huecos. clean dice
-- si su derivación terminó sin continuidad pendiente ni connection_lost abierta; si no, lo que dejó
-- abierto: los símbolos con continuidad pendiente y los tipos de condición abiertos, ordenados.
CREATE TABLE dataset_log_ranges (
  dataset_id text PRIMARY KEY REFERENCES datasets (dataset_id),
  publication_id uuid NOT NULL UNIQUE,
  log_number integer NOT NULL CHECK (log_number BETWEEN 1 AND 999999),
  first_segment integer NOT NULL CHECK (first_segment >= 0),
  last_segment integer NOT NULL CHECK (last_segment >= first_segment),
  clean boolean NOT NULL,
  pending_continuity_symbols text[] NOT NULL
    CHECK (array_position(pending_continuity_symbols, NULL) IS NULL),
  open_condition_types text[] NOT NULL
    CHECK (array_position(open_condition_types, NULL) IS NULL),
  CHECK (
    clean = (
      cardinality(pending_continuity_symbols) = 0
      AND array_position(open_condition_types, 'connection_lost') IS NULL
    )
  ),
  UNIQUE (log_number, first_segment),
  FOREIGN KEY (publication_id, dataset_id)
    REFERENCES published_manifest_records (publication_id, dataset_id)
);

-- Cada dataset empieza en el segmento siguiente al último del anterior de su log, o en el 0. El
-- bloqueo serializa las inserciones de un mismo log, así que la consulta ve la del anterior. La
-- tabla se nombra con el esquema del disparador, para no depender del search_path de quien inserta.
CREATE FUNCTION buoh_check_dataset_log_range() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_first integer;
BEGIN
  PERFORM pg_advisory_xact_lock(4100022, NEW.log_number);
  EXECUTE format(
    'SELECT COALESCE(max(last_segment) + 1, 0) FROM %I.dataset_log_ranges WHERE log_number = $1',
    TG_TABLE_SCHEMA
  ) INTO expected_first USING NEW.log_number;
  IF NEW.first_segment <> expected_first THEN
    RAISE EXCEPTION 'buoh: el dataset del log % tiene que empezar en el segmento %',
      NEW.log_number, expected_first
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_log_ranges_contiguous
  BEFORE INSERT ON dataset_log_ranges
  FOR EACH ROW EXECUTE FUNCTION buoh_check_dataset_log_range();

-- El resultado de cada verificación de un dataset publicado (ADR-0020 §8, paso 7), en un modo de
-- data:replay. Lo escribe solo buoh-operaciones, como buoh_dueno. verification_id es un UUIDv7 y
-- run_id, la ejecución de buoh-operaciones. passed es la salida 0; failed, la salida 1, con su
-- código de error saneado (ReplayErrorCode); incomplete, tres ejecuciones sin un resultado
-- concluyente. report_jcs es el informe JSON de data:replay en JCS, sin precios.
CREATE TABLE dataset_verifications (
  verification_id uuid PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES datasets (dataset_id),
  publication_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('verify-only', 'recompute')),
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'incomplete')),
  exit_code integer CHECK (exit_code >= 0),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  report_jcs text,
  run_id uuid NOT NULL,
  verified_at_utc text NOT NULL
    CHECK (verified_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  CHECK (
    (status = 'passed' AND exit_code = 0 AND error_code IS NULL AND report_jcs IS NOT NULL)
    OR (status = 'failed' AND exit_code = 1 AND error_code IS NOT NULL)
    OR (status = 'incomplete' AND exit_code IS DISTINCT FROM 0 AND exit_code IS DISTINCT FROM 1)
  ),
  FOREIGN KEY (publication_id, dataset_id)
    REFERENCES published_manifest_records (publication_id, dataset_id)
);

-- El registro operativo de la publicación (ADR-0020 §9): persistence_unavailable con la etapa de
-- la escritura que falló. Una publicación no produce source events, así que sus referencias son
-- publicaciones: observed_ref, el publication_id del intento; related_refs, el de la última
-- confirmada; y la resolución, la primera confirmada después de la apertura.
CREATE TABLE operational_incidents (
  incident_id text PRIMARY KEY CHECK (incident_id ~ '^sha256:[0-9a-f]{64}$'),
  incident_type text NOT NULL CHECK (incident_type = 'persistence_unavailable'),
  severity text NOT NULL CHECK (severity = 'critical'),
  source text NOT NULL CHECK (source <> ''),
  symbol text CHECK (symbol IS NULL),
  observed_at_utc text NOT NULL,
  incident_jcs text NOT NULL
);

CREATE TABLE operational_conditions (
  condition_event_id text PRIMARY KEY CHECK (condition_event_id ~ '^sha256:[0-9a-f]{64}$'),
  condition_key text NOT NULL,
  condition_type text NOT NULL CHECK (condition_type = 'persistence_unavailable'),
  action text NOT NULL CHECK (action IN ('opened', 'resolved')),
  source text NOT NULL CHECK (source <> ''),
  symbol text CHECK (symbol IS NULL),
  occurred_at_utc text NOT NULL,
  condition_jcs text NOT NULL
);

CREATE TRIGGER datasets_append_only
  BEFORE UPDATE OR DELETE ON datasets
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER datasets_no_truncate
  BEFORE TRUNCATE ON datasets
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER published_manifest_records_append_only
  BEFORE UPDATE OR DELETE ON published_manifest_records
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER published_manifest_records_no_truncate
  BEFORE TRUNCATE ON published_manifest_records
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_quality_incidents_append_only
  BEFORE UPDATE OR DELETE ON dataset_quality_incidents
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_quality_incidents_no_truncate
  BEFORE TRUNCATE ON dataset_quality_incidents
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_log_ranges_append_only
  BEFORE UPDATE OR DELETE ON dataset_log_ranges
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_log_ranges_no_truncate
  BEFORE TRUNCATE ON dataset_log_ranges
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_verifications_append_only
  BEFORE UPDATE OR DELETE ON dataset_verifications
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER dataset_verifications_no_truncate
  BEFORE TRUNCATE ON dataset_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER operational_incidents_append_only
  BEFORE UPDATE OR DELETE ON operational_incidents
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER operational_incidents_no_truncate
  BEFORE TRUNCATE ON operational_incidents
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER operational_conditions_append_only
  BEFORE UPDATE OR DELETE ON operational_conditions
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER operational_conditions_no_truncate
  BEFORE TRUNCATE ON operational_conditions
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
