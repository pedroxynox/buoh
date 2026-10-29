-- F1.5 · Cursor y latido de la ingesta (ADR-0015 §6), y el motivo history_inconsistent de las
-- incidencias de respuestas pedidas (ADR-0015 §4). Las dos tablas nuevas son append-only. Los
-- enteros del contrato (NonNegativeInteger, hasta 2^53 − 1) son bigint.

-- Una versión del IngestionCursor 1.0.0 por fila, contigua desde 1 por source + symbol, como el
-- catálogo. Cada campo del cursor tiene su columna, y cursor_jcs es el cursor entero en JCS.
CREATE TABLE ingestion_cursors (
  source text NOT NULL CHECK (source <> ''),
  symbol text NOT NULL CHECK (symbol <> ''),
  version integer NOT NULL CHECK (version >= 1),
  schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
  connection_id uuid NOT NULL,
  active_segment_index bigint NOT NULL CHECK (active_segment_index >= 0),
  source_event_count bigint NOT NULL CHECK (source_event_count >= 0),
  last_durable_source_event_id uuid NOT NULL,
  last_durable_observation_id uuid,
  high_watermark_event_time_utc text
    CHECK (high_watermark_event_time_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  updated_at_utc text NOT NULL
    CHECK (updated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  cursor_jcs text NOT NULL,
  PRIMARY KEY (source, symbol, version)
);

-- Versiones contiguas. Dos escritores a la vez no pueden repetir versión: el trigger o la clave
-- primaria rechazan al segundo.
CREATE FUNCTION buoh_check_ingestion_cursor_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_version integer;
BEGIN
  SELECT max(version) INTO last_version
    FROM ingestion_cursors
   WHERE source = NEW.source AND symbol = NEW.symbol;
  IF NEW.version <> coalesce(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'buoh: la versión % del cursor de % y % no es contigua', NEW.version, NEW.source, NEW.symbol
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_cursors_contiguous
  BEFORE INSERT ON ingestion_cursors
  FOR EACH ROW EXECUTE FUNCTION buoh_check_ingestion_cursor_version();

-- El latido de cada ejecución: pg_backend_pid es el de la sesión que tiene el bloqueo de la fuente,
-- con el que data:health reconoce al escritor vivo de este esquema (ADR-0015 §8). write_order da el
-- orden de escritura: el último latido de una fuente es el último escrito.
CREATE TABLE ingestion_heartbeats (
  heartbeat_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY,
  source text NOT NULL CHECK (source <> ''),
  run_id uuid NOT NULL,
  observed_at_utc text NOT NULL
    CHECK (observed_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  pg_backend_pid integer NOT NULL CHECK (pg_backend_pid > 0),
  connection_state text NOT NULL
    CHECK (connection_state IN ('connecting', 'connected', 'disconnected')),
  backlog_count bigint NOT NULL CHECK (backlog_count >= 0),
  backlog_bytes bigint NOT NULL CHECK (backlog_bytes >= 0)
);

-- Una página de historia incoherente (ADR-0015 §4) también es una respuesta pedida inválida. Se
-- conservan los seis motivos de la 0003.
ALTER TABLE requested_response_incidents
  DROP CONSTRAINT requested_response_incidents_reason_check,
  ADD CONSTRAINT requested_response_incidents_reason_check CHECK (reason IN (
    'catalog_duplicate_symbol',
    'catalog_empty',
    'catalog_entry_invalid',
    'catalog_exponent_not_supported',
    'history_inconsistent',
    'schema_validation_failed',
    'source_error_response'
  ));

CREATE TRIGGER ingestion_cursors_append_only
  BEFORE UPDATE OR DELETE ON ingestion_cursors
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER ingestion_cursors_no_truncate
  BEFORE TRUNCATE ON ingestion_cursors
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER ingestion_heartbeats_append_only
  BEFORE UPDATE OR DELETE ON ingestion_heartbeats
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER ingestion_heartbeats_no_truncate
  BEFORE TRUNCATE ON ingestion_heartbeats
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
