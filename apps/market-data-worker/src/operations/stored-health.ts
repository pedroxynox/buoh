import { healthReportSchema, utcTimestampMsSchema, type HealthReport } from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import { z } from 'zod';

import type { LogLocation } from '../successive-logs.js';
import type { OperationsStep } from './run.js';
import { SANITIZED } from './sanitized.js';

// La salud de los datos que leen la API y el motor (ADR-0019 §8): la última observación que guardó
// `buoh-operaciones` en la tabla `operations_reports` de un log (ADR-0018 §11, paso 2), sin ejecutar
// `data:health`. Lo escribe `run.ts`; aquí solo se lee, y este módulo no importa `run.ts` en
// JavaScript, para que la ruta `lectura` no cargue el código de `buoh-operaciones`.

/** El paso de `buoh-operaciones` cuyo informe es la salud del log activo. */
const HEALTH_STEP: OperationsStep = 'health';

/**
 * La última observación de la salud de un log, con la hora en que se guardó su informe:
 * - `completed`: el `HealthReport` de `data:health`, que puede no ser `healthy`;
 * - `failed`: la salud no se pudo observar, con su motivo saneado, como `child_timeout` o
 *   `health_command_failed`.
 */
export type StoredHealthObservation =
  | {
      readonly status: 'completed';
      readonly observedAtUtc: string;
      readonly report: HealthReport;
    }
  | {
      readonly status: 'failed';
      readonly observedAtUtc: string;
      readonly reason: string;
    };

/** Las columnas de una fila de `operations_reports` (migración `0006`) que lee la salud. */
export interface StoredHealthRow {
  readonly status: string;
  readonly observed_at_utc: string;
  readonly report_jcs: string;
}

/** Un informe guardado de la salud que no tiene la forma que escribe `buoh-operaciones`. */
export class StoredHealthError extends TypeError {
  constructor() {
    super('El informe guardado de la salud no tiene la forma que escribe buoh-operaciones.');
    this.name = 'StoredHealthError';
  }
}

// La forma de los informes del paso de la salud que escribe `run.ts` (`observeLog` y `failedHealth`):
// el que terminó lleva `report`, y el que falló, `reason`. Los demás campos, como `log`, `exit_code`,
// `alerts` o `code`, no se leen, así que uno nuevo no rompe la lectura.
const completedReportSchema = z.object({ report: healthReportSchema });
const failedReportSchema = z.object({ reason: z.string().regex(SANITIZED) });

/**
 * La observación de una fila del paso de la salud: su estado, su hora y, según el estado, el
 * `HealthReport` validado con su contrato o el motivo saneado. Lanza `StoredHealthError` si la fila
 * no tiene esa forma, sin repetir nada de su contenido.
 */
export function parseStoredHealthObservation(row: StoredHealthRow): StoredHealthObservation {
  const observedAt = utcTimestampMsSchema.safeParse(row.observed_at_utc);
  let stored: unknown;
  try {
    stored = JSON.parse(row.report_jcs);
  } catch {
    throw new StoredHealthError();
  }
  if (observedAt.success && row.status === 'completed') {
    const parsed = completedReportSchema.safeParse(stored);
    if (parsed.success) {
      return { status: 'completed', observedAtUtc: observedAt.data, report: parsed.data.report };
    }
  }
  if (observedAt.success && row.status === 'failed') {
    const parsed = failedReportSchema.safeParse(stored);
    if (parsed.success) {
      return { status: 'failed', observedAtUtc: observedAt.data, reason: parsed.data.reason };
    }
  }
  throw new StoredHealthError();
}

/**
 * La última observación de la salud del log (ADR-0019 §8): el último informe del paso `health` de su
 * tabla `operations_reports`, por su `report_id`, un UUIDv7 cuyo orden es el de escritura, haya
 * terminado o fallado. Si el último falló, uno anterior que terminó no lo sustituye. `null` si el log
 * no tiene ninguno, como justo después de un corte, sin mirar los de otro log. Lee una sola fila y no
 * escribe nada.
 */
export async function readLatestStoredHealth(
  pool: Pick<Pool, 'query'>,
  log: LogLocation,
): Promise<StoredHealthObservation | null> {
  const { rows } = await pool.query<StoredHealthRow>(
    `SELECT status, observed_at_utc, report_jcs
       FROM ${pg.escapeIdentifier(log.schema)}.operations_reports
      WHERE step = $1
      ORDER BY report_id DESC
      LIMIT 1`,
    [HEALTH_STEP],
  );
  const [row] = rows;
  return row === undefined ? null : parseStoredHealthObservation(row);
}
