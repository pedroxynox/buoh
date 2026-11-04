import type { DataHealth } from '@buoh/contracts';
import {
  DERIV_SOURCE,
  findActiveLog,
  readLatestStoredHealth,
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
   * `buoh-operaciones` en él (`DataHealth`). Rechaza con el error de PostgreSQL si no responde, y con
   * `StoredHealthError` si el informe guardado no tiene su forma.
   */
  health(): Promise<DataHealth>;
}

export interface DataReaderDeps {
  /** El pool de lectura (`createReaderPool`). */
  readonly pool: Pick<Pool, 'query'>;
  /** Milisegundos de pared: la hora con que se busca el log activo. */
  readonly clock: () => number;
}

function toContract(observation: StoredHealthObservation): NonNullable<DataHealth['observation']> {
  return observation.status === 'completed'
    ? {
        status: 'completed',
        observed_at_utc: observation.observedAtUtc,
        report: observation.report,
      }
    : { status: 'failed', observed_at_utc: observation.observedAtUtc, reason: observation.reason };
}

export function createDataReader(deps: DataReaderDeps): DataReader {
  return {
    health: async () => {
      const log = await findActiveLog(deps.pool, {
        now: () => new Date(deps.clock()).toISOString(),
        source: DERIV_SOURCE,
      });
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
