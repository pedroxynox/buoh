-- F2.2 · Informes de buoh-operaciones (ADR-0018 §11) y el índice del último latido. La tabla es
-- append-only.

-- Un informe por fila: lo que dejó un paso de una ejecución de buoh-operaciones en el log al que se
-- refiere, como el HealthReport de data:health sobre el log activo. Lo escribe solo
-- buoh-operaciones, como buoh_dueno: buoh_ingesta no lo toca y buoh_lectura lo lee (ADR-0018 §8).
-- report_jcs es el informe en JCS, sin precios ni payloads, y report_id un UUIDv7, así que su orden
-- es el de escritura. step es el nombre del paso, que comprueba quien escribe.
CREATE TABLE operations_reports (
  report_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z][a-z_]{0,62}$'),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  observed_at_utc text NOT NULL
    CHECK (observed_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  report_jcs text NOT NULL
);

CREATE TRIGGER operations_reports_append_only
  BEFORE UPDATE OR DELETE ON operations_reports
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER operations_reports_no_truncate
  BEFORE TRUNCATE ON operations_reports
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();

-- El último latido de una fuente (ORDER BY write_order DESC LIMIT 1), que leen data:health y la
-- búsqueda del log activo (ADR-0018 §6), sin recorrer los latidos del log.
CREATE INDEX ingestion_heartbeats_source_write_order ON ingestion_heartbeats (source, write_order);
