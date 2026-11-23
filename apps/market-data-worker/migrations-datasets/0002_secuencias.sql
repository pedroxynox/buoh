-- Las secuencias de logs (ADR-0021 §1): cada rango nombra la secuencia de su log, porque dos
-- secuencias pueden tener un log con el mismo número, y la contigüidad y la clave única pasan a ser
-- por secuencia. Hasta esta migración solo existía la de R_100, así que las filas que ya están son
-- suyas. La columna lleva R_100 por defecto: PostgreSQL lo pone en las filas existentes sin
-- reescribirlas ni disparar los triggers append-only, y el código de antes, que solo publica R_100 e
-- inserta sin la columna, sigue funcionando si se vuelve atrás un despliegue (ADR-0018 §5). El
-- código de las secuencias nombra siempre la suya.
ALTER TABLE dataset_log_ranges
  ADD COLUMN sequence text NOT NULL DEFAULT 'R_100'
    CHECK (sequence ~ '^[A-Za-z0-9_]{1,64}$');

ALTER TABLE dataset_log_ranges DROP CONSTRAINT dataset_log_ranges_log_number_first_segment_key;
ALTER TABLE dataset_log_ranges
  ADD CONSTRAINT dataset_log_ranges_sequence_log_number_first_segment_key
    UNIQUE (sequence, log_number, first_segment);

-- Cada dataset empieza en el segmento siguiente al último del anterior del mismo log de la misma
-- secuencia, o en el 0. El bloqueo sigue siendo por número de log: serializa también los logs con
-- ese número de otras secuencias, lo que solo hace esperar un poco, y la consulta ve el anterior.
CREATE OR REPLACE FUNCTION buoh_check_dataset_log_range() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_first integer;
BEGIN
  PERFORM pg_advisory_xact_lock(4100022, NEW.log_number);
  EXECUTE format(
    'SELECT COALESCE(max(last_segment) + 1, 0) FROM %I.dataset_log_ranges
      WHERE sequence = $1 AND log_number = $2',
    TG_TABLE_SCHEMA
  ) INTO expected_first USING NEW.sequence, NEW.log_number;
  IF NEW.first_segment <> expected_first THEN
    RAISE EXCEPTION 'buoh: el dataset del log % de la secuencia % tiene que empezar en el segmento %',
      NEW.log_number, NEW.sequence, expected_first
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
