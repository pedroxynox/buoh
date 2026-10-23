-- F1.3b · Log raw-first de source events y registro operativo (ADR-0005 §4–§6).
-- Todas las tablas son append-only. Un segmento está abierto mientras no exista su fila en
-- closed_source_segments; cerrarlo no modifica filas previas.

-- Índice de cada source event durable: su línea JCS vive en el objeto sha256/<object_sha256>.
CREATE TABLE source_event_index (
  source text NOT NULL CHECK (source <> ''),
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  position integer NOT NULL CHECK (position >= 0),
  event_id uuid NOT NULL UNIQUE,
  kind text NOT NULL
    CHECK (kind IN ('raw_source_frame', 'connection_opened', 'connection_closed', 'history_recovery_result')),
  event_time_utc text NOT NULL
    CHECK (event_time_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length > 0),
  PRIMARY KEY (source, segment_index, position)
);

-- Segmento cerrado: objeto NDJSON gzip content-addressed y su hash lógico.
CREATE TABLE closed_source_segments (
  source text NOT NULL CHECK (source <> ''),
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  event_count integer NOT NULL CHECK (event_count > 0),
  raw_frame_count integer NOT NULL CHECK (raw_frame_count >= 0 AND raw_frame_count <= event_count),
  byte_count bigint NOT NULL CHECK (byte_count > 0 AND byte_count <= 67108864),
  logical_content_sha256 text NOT NULL CHECK (logical_content_sha256 ~ '^[0-9a-f]{64}$'),
  object_bytes_sha256 text NOT NULL CHECK (object_bytes_sha256 ~ '^[0-9a-f]{64}$'),
  object_size_bytes bigint NOT NULL CHECK (object_size_bytes >= 0),
  compression text NOT NULL CHECK (compression IN ('none', 'gzip')),
  writer_name text,
  writer_version text,
  close_reason text NOT NULL CHECK (close_reason IN ('bytes', 'raw_frames', 'requested', 'window')),
  segment_policy_version text NOT NULL,
  first_event_time_utc text NOT NULL,
  last_event_time_utc text NOT NULL,
  PRIMARY KEY (source, segment_index),
  CHECK ((compression = 'gzip') = (writer_name IS NOT NULL AND writer_version IS NOT NULL))
);

-- Posiciones contiguas, sin escribir en segmentos cerrados ni saltar segmentos.
CREATE FUNCTION buoh_check_source_event_index() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM closed_source_segments
     WHERE source = NEW.source AND segment_index = NEW.segment_index
  ) THEN
    RAISE EXCEPTION 'buoh: el segmento % de % ya está cerrado', NEW.segment_index, NEW.source
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.position <> (
    SELECT count(*) FROM source_event_index
     WHERE source = NEW.source AND segment_index = NEW.segment_index
  ) THEN
    RAISE EXCEPTION 'buoh: posición % no contigua en el segmento %', NEW.position, NEW.segment_index
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.position = 0 AND NEW.segment_index > 0 AND NOT EXISTS (
    SELECT 1 FROM closed_source_segments
     WHERE source = NEW.source AND segment_index = NEW.segment_index - 1
  ) THEN
    RAISE EXCEPTION 'buoh: el segmento % no sigue a un segmento cerrado', NEW.segment_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_event_index_contiguous
  BEFORE INSERT ON source_event_index
  FOR EACH ROW EXECUTE FUNCTION buoh_check_source_event_index();

-- Cerrar exige que el conteo coincida con las filas indexadas del segmento.
CREATE FUNCTION buoh_check_closed_source_segment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_count <> (
    SELECT count(*) FROM source_event_index
     WHERE source = NEW.source AND segment_index = NEW.segment_index
  ) OR NEW.raw_frame_count <> (
    SELECT count(*) FROM source_event_index
     WHERE source = NEW.source AND segment_index = NEW.segment_index AND kind = 'raw_source_frame'
  ) THEN
    RAISE EXCEPTION 'buoh: los conteos no corresponden al segmento %', NEW.segment_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER closed_source_segments_counts
  BEFORE INSERT ON closed_source_segments
  FOR EACH ROW EXECUTE FUNCTION buoh_check_closed_source_segment();

-- Registro operativo: persistence_unavailable y source_limit_exceeded fuera de los datasets.
CREATE TABLE operational_incidents (
  incident_id text PRIMARY KEY CHECK (incident_id ~ '^sha256:[0-9a-f]{64}$'),
  incident_type text NOT NULL
    CHECK (incident_type IN ('persistence_unavailable', 'source_limit_exceeded')),
  severity text NOT NULL CHECK (severity IN ('error', 'critical')),
  source text NOT NULL CHECK (source <> ''),
  symbol text,
  observed_at_utc text NOT NULL,
  incident_jcs text NOT NULL
);

CREATE TABLE operational_conditions (
  condition_event_id text PRIMARY KEY CHECK (condition_event_id ~ '^sha256:[0-9a-f]{64}$'),
  condition_key text NOT NULL,
  condition_type text NOT NULL
    CHECK (condition_type IN ('persistence_unavailable', 'source_limit_exceeded')),
  action text NOT NULL CHECK (action IN ('opened', 'resolved')),
  source text NOT NULL CHECK (source <> ''),
  symbol text,
  occurred_at_utc text NOT NULL,
  condition_jcs text NOT NULL
);

CREATE TRIGGER source_event_index_append_only
  BEFORE UPDATE OR DELETE ON source_event_index
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER source_event_index_no_truncate
  BEFORE TRUNCATE ON source_event_index
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER closed_source_segments_append_only
  BEFORE UPDATE OR DELETE ON closed_source_segments
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER closed_source_segments_no_truncate
  BEFORE TRUNCATE ON closed_source_segments
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
