-- F1.3 · Publicación atómica de datasets (ADR-0004 §6, §8 y §9).
-- Tablas append-only: UPDATE, DELETE y TRUNCATE se rechazan. Los instantes se guardan como el
-- texto UTC canónico del contrato (RFC 3339 con milisegundos) para no reinterpretarlos.

CREATE FUNCTION buoh_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'buoh: % no permitido en la tabla append-only %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Dataset visible. Solo existe el estado público `published`; su identidad es el SHA-256 de JCS
-- de `DatasetManifestCore`, comprobado por la propia base de datos.
CREATE TABLE datasets (
  dataset_id text PRIMARY KEY,
  state text NOT NULL CHECK (state = 'published'),
  source text NOT NULL CHECK (source <> ''),
  manifest_core_jcs text NOT NULL,
  CHECK (dataset_id ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    dataset_id = 'sha256:' || encode(sha256(convert_to(manifest_core_jcs, 'UTF8')), 'hex')
  )
);

-- `PublishedManifestRecord`: autentica una instancia física del documento canónico.
CREATE TABLE published_manifest_records (
  publication_id uuid PRIMARY KEY,
  deployment_environment text NOT NULL
    CHECK (deployment_environment IN ('development', 'test', 'staging', 'production')),
  dataset_id text NOT NULL REFERENCES datasets (dataset_id),
  schema_version text NOT NULL CHECK (schema_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  manifest_document_sha256 text NOT NULL CHECK (manifest_document_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_object_uri text NOT NULL CHECK (manifest_object_uri <> ''),
  manifest_object_bytes_sha256 text NOT NULL
    CHECK (manifest_object_bytes_sha256 ~ '^[0-9a-f]{64}$'),
  published_at_utc text NOT NULL
    CHECK (published_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  state text NOT NULL CHECK (state IN ('active', 'superseded'))
);

-- Un único record activo por dataset en cada `deployment_environment`.
CREATE UNIQUE INDEX published_manifest_records_one_active
  ON published_manifest_records (dataset_id, deployment_environment)
  WHERE state = 'active';

-- Incidencias derivables del dataset (también presentes en su artefacto `quality_incidents`).
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

CREATE TRIGGER datasets_append_only
  BEFORE UPDATE OR DELETE ON datasets
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER datasets_no_truncate
  BEFORE TRUNCATE ON datasets
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();

-- F1.3 no implementa reubicación: ningún record cambia de estado. Una migración posterior podrá
-- permitir únicamente la transición `active` → `superseded`.
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
