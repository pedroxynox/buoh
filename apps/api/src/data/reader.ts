import type { DataHealth } from '@buoh/contracts';
import {
  DERIV_SOURCE,
  listCaptureLogs,
  readLatestStoredHealth,
  selectActiveLog,
  type StoredHealthObservation,
} from '@buoh/market-data-worker/lectura';
import type { Pool } from 'pg';

/**
 * Las lecturas del sistema de datos (ADR-0019 §8), con el código del worker por la ruta
 * `@buoh/market-data-worker/lectura` y el pool de `buoh_api_lectura`. Ninguna deriva el log entero
 * ni ejecuta `data:health`.
 */
export interface DataReader {
  /**
   * La salud de los datos: el log activo de la captura de Deriv y la última observación que guardó
   * `buoh-operaciones` en él (`DataHealth`). Rechaza con el error de PostgreSQL si no responde, con
   * `StoredHealthError` si el informe guardado no tiene su forma, y con `LogsUnreadableError` si hay
   * logs y el rol no puede leer ninguno.
   */
  health(): Promise<DataHealth>;
}

export interface DataReaderDeps {
  /** El pool de lectura (`createReaderPool`). */
  readonly pool: Pick<Pool, 'query'>;
  /** Milisegundos de pared: la hora con que se busca el log activo. */
  readonly clock: () => number;
}

/**
 * Hay esquemas de log, pero el rol del pool no puede leer ninguno: por ejemplo, porque no tiene los
 * privilegios de `buoh_lectura` o porque el lector recibió otro pool. La búsqueda del log activo
 * toma un log que no se puede leer por uno que se está preparando (ADR-0018 §6), así que sin esto la
 * respuesta diría que no hay log activo.
 */
export class LogsUnreadableError extends Error {
  constructor() {
    super('Hay logs, pero el rol de lectura no puede leer ninguno.');
    this.name = 'LogsUnreadableError';
  }
}

function toContract(observation: StoredHealthObservation): NonNullable<DataHealth['observation']> {
  return observation.status === 'completed'
    ? {
        status: 'completed',
        observed_at_utc: observation.observedAtUtc,
        report: observation.report,
        alerts: observation.alerts.map(({ event, reason }) => ({ event, reason })),
      }
    : {
        status: 'failed',
        observed_at_utc: observation.observedAtUtc,
        reason: observation.reason,
        code: observation.code,
      };
}

export function createDataReader(deps: DataReaderDeps): DataReader {
  return {
    health: async () => {
      // Como `findActiveLog`: lee los logs y después toma la hora.
      const logs = await listCaptureLogs(deps.pool, DERIV_SOURCE);
      if (logs.length > 0 && logs.every((log) => !log.readable)) {
        throw new LogsUnreadableError();
      }
      const log = selectActiveLog(logs, new Date(deps.clock()).toISOString());
      if (log === null) {
        return { log: null, observation: null };
      }
      const observation = await readLatestStoredHealth(deps.pool, log);
      return {
        log: log.number,
        observation: observation === null ? null : toContract(observation),
      };
    },
  };
}
