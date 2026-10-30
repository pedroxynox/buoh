-- F2.1 · Punto de control de la derivación en vivo (ADR-0017 §5 y §6). La tabla es append-only.
-- Los enteros del contrato (NonNegativeInteger, hasta 2^53 − 1) son bigint, como en la 0004.

-- Un LiveDerivationCheckpoint 1.0.0 por fila: el estado vivo del log de una fuente al final de su
-- segmento cerrado segment_index. El enlace con el log y cada versión tienen su columna, y
-- checkpoint_jcs es el punto de control entero en JCS, con su SHA-256. La clave es la fuente, el
-- segmento y el SHA-256 del JCS de las versiones, así que conviven filas de versiones distintas para
-- el mismo segmento. written_at_utc no entra en ningún hash. Quien lo lee comprueba el JCS, su
-- SHA-256 y el enlace con closed_source_segments antes de usarlo (ADR-0017 §6), así que una fila
-- que no los cumple puede existir: no se reemplaza, y la supera la del segmento siguiente.
CREATE TABLE live_derivation_checkpoints (
  source text NOT NULL CHECK (source <> ''),
  symbol text NOT NULL CHECK (symbol <> ''),
  segment_index bigint NOT NULL CHECK (segment_index >= 0),
  schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
  segment_logical_content_sha256 text NOT NULL
    CHECK (segment_logical_content_sha256 ~ '^[0-9a-f]{64}$'),
  event_count bigint NOT NULL CHECK (event_count > 0),
  raw_frame_count bigint NOT NULL CHECK (raw_frame_count >= 0 AND raw_frame_count <= event_count),
  connector_version text NOT NULL CHECK (connector_version <> ''),
  live_state_version text NOT NULL
    CHECK (live_state_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  quality_profile_sha256 text NOT NULL CHECK (quality_profile_sha256 ~ '^[0-9a-f]{64}$'),
  quality_rule_version text NOT NULL
    CHECK (quality_rule_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  segment_policy_version text NOT NULL
    CHECK (segment_policy_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  source_event_schema_version text NOT NULL
    CHECK (source_event_schema_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  source_schema_sha256 text NOT NULL CHECK (source_schema_sha256 ~ '^[0-9a-f]{64}$'),
  versions_sha256 text NOT NULL CHECK (versions_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_jcs text NOT NULL,
  checkpoint_sha256 text NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  written_at_utc text NOT NULL
    CHECK (written_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  PRIMARY KEY (source, segment_index, versions_sha256)
);

CREATE TRIGGER live_derivation_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON live_derivation_checkpoints
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER live_derivation_checkpoints_no_truncate
  BEFORE TRUNCATE ON live_derivation_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
