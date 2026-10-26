-- F1.4b · Versiones del catálogo de una fuente e incidencias de respuestas pedidas (ADR-0012 §6
-- y §7). Las dos tablas son append-only.

-- Una versión del catálogo por fila, contigua desde 1 por source + catalog_format. El documento es
-- el JCS del SourceCatalogSnapshot, en el objeto sha256/<document_sha256>.
CREATE TABLE source_catalog_versions (
  source text NOT NULL CHECK (source <> ''),
  catalog_format text NOT NULL CHECK (catalog_format IN ('deriv_active_symbols')),
  version integer NOT NULL CHECK (version >= 1),
  snapshot_id text NOT NULL UNIQUE CHECK (snapshot_id ~ '^sha256:[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 1),
  observation_id uuid NOT NULL,
  received_at_utc text NOT NULL
    CHECK (received_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  document_byte_length integer NOT NULL CHECK (document_byte_length > 0),
  PRIMARY KEY (source, catalog_format, version)
);

-- Versiones contiguas, y una versión nueva solo si cambia el contenido respecto de la última.
-- Dos escritores a la vez no pueden repetir versión: la clave primaria rechaza al segundo.
CREATE FUNCTION buoh_check_source_catalog_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_version integer;
  last_content text;
BEGIN
  SELECT version, content_sha256 INTO last_version, last_content
    FROM source_catalog_versions
   WHERE source = NEW.source AND catalog_format = NEW.catalog_format
   ORDER BY version DESC
   LIMIT 1;
  IF NEW.version <> coalesce(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'buoh: la versión % del catálogo de % no es contigua', NEW.version, NEW.source
      USING ERRCODE = 'check_violation';
  END IF;
  IF last_content = NEW.content_sha256 THEN
    RAISE EXCEPTION 'buoh: la versión % del catálogo de % no cambia su contenido', NEW.version, NEW.source
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_catalog_versions_contiguous
  BEFORE INSERT ON source_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION buoh_check_source_catalog_version();

-- Respuesta pedida inválida: siempre invalid_source_frame, sin símbolo y con el observation_id del
-- frame. Fuera de los datasets y del registro operativo: no abre condiciones ni cambia la salud.
CREATE TABLE requested_response_incidents (
  incident_id text PRIMARY KEY CHECK (incident_id ~ '^sha256:[0-9a-f]{64}$'),
  incident_type text NOT NULL CHECK (incident_type = 'invalid_source_frame'),
  source text NOT NULL CHECK (source <> ''),
  observed_ref uuid NOT NULL,
  observed_at_utc text NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'catalog_duplicate_symbol',
    'catalog_empty',
    'catalog_entry_invalid',
    'catalog_exponent_not_supported',
    'schema_validation_failed',
    'source_error_response'
  )),
  incident_jcs text NOT NULL
);

CREATE TRIGGER source_catalog_versions_append_only
  BEFORE UPDATE OR DELETE ON source_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER source_catalog_versions_no_truncate
  BEFORE TRUNCATE ON source_catalog_versions
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER requested_response_incidents_append_only
  BEFORE UPDATE OR DELETE ON requested_response_incidents
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER requested_response_incidents_no_truncate
  BEFORE TRUNCATE ON requested_response_incidents
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
