import {
  ingestionCursorSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
  type IngestionCursor,
} from '@buoh/contracts';
import { z } from 'zod';

/** Versión del `IngestionCursor` que guarda la migración `0004` (ADR-0015 §6). */
export const INGESTION_CURSOR_SCHEMA_VERSION = '1.0.0';

/**
 * Latido de una ejecución de la ingesta (ADR-0015 §6), una fila de `ingestion_heartbeats`: la
 * fuente, la ejecución (`run_id`), la hora, el PID de PostgreSQL de la sesión que tiene el bloqueo
 * (`pg_backend_pid()`), el estado de la conexión y el backlog. `data:health` lo lee para saber si
 * el escritor vivo es el de este esquema y para tomar de él la conexión y el backlog (ADR-0015 §8).
 * No es un contrato entre paquetes: es estado operativo del worker, como el registro operativo.
 */
export const ingestionHeartbeatSchema = z.strictObject({
  heartbeat_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  run_id: uuidV7Schema,
  observed_at_utc: utcTimestampMsSchema,
  // `pg_backend_pid()` es un `integer` de PostgreSQL, siempre positivo.
  pg_backend_pid: z.number().int().min(1).max(2_147_483_647),
  connection_state: z.enum(['connecting', 'connected', 'disconnected']),
  backlog_count: nonNegativeIntegerSchema,
  backlog_bytes: nonNegativeIntegerSchema,
});

export type IngestionHeartbeat = z.infer<typeof ingestionHeartbeatSchema>;

/** Una versión guardada del cursor de una fuente y un símbolo. */
export interface IngestionCursorVersion {
  readonly cursor: IngestionCursor;
  /** Contigua desde 1 por fuente y símbolo, como las versiones del catálogo. */
  readonly version: number;
}

/**
 * Cursor y latido de la ingesta (ADR-0015 §6), append-only. En PostgreSQL:
 * `PostgresIngestionStatusStore` (tablas `ingestion_cursors` e `ingestion_heartbeats`, migración
 * `0004`); en memoria, `InMemoryIngestionStatusStore`, con las mismas reglas.
 */
export interface IngestionStatusStore {
  /**
   * Guarda el cursor como la versión siguiente de su fuente y su símbolo. Solo admite un
   * `IngestionCursor` 1.0.0 válido (`parseIngestionCursor`); si no, falla sin guardar nada.
   */
  appendCursor(cursor: IngestionCursor): Promise<IngestionCursorVersion>;
  /** La última versión del cursor de esa fuente y ese símbolo, o `null` si no hay ninguna. */
  latestCursor(source: string, symbol: string): Promise<IngestionCursorVersion | null>;
  /**
   * Guarda el latido. Solo admite uno válido (`ingestionHeartbeatSchema`), y un `heartbeat_id` ya
   * guardado falla con el código `23505`, como la clave primaria.
   */
  appendHeartbeat(heartbeat: IngestionHeartbeat): Promise<void>;
  /**
   * El último latido escrito de la fuente, o `null`. Es el último en escribirse, no el de hora más
   * tardía: si el reloj retrocede, el último escrito sigue siendo el estado más reciente.
   */
  latestHeartbeat(source: string): Promise<IngestionHeartbeat | null>;
}

/** Valida un `IngestionCursor` de la versión que guarda `0004` (`INGESTION_CURSOR_SCHEMA_VERSION`). */
export function parseIngestionCursor(input: IngestionCursor): IngestionCursor {
  const cursor = ingestionCursorSchema.parse(input);
  if (cursor.schema_version !== INGESTION_CURSOR_SCHEMA_VERSION) {
    throw new TypeError(
      `El cursor guardado es el IngestionCursor ${INGESTION_CURSOR_SCHEMA_VERSION}, no el ${cursor.schema_version}.`,
    );
  }
  return cursor;
}
