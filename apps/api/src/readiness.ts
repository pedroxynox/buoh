import { errorName, type ApiLog } from './log.js';

/**
 * El estado de las migraciones de la API para la versión que corre: todas aplicadas (`ready`),
 * alguna sin aplicar (`migrations_pending`) o alguna aplicada con otro contenido
 * (`migration_changed`), que no se arregla esperando.
 */
export type MigrationState = 'ready' | 'migrations_pending' | 'migration_changed';

/** Si la API ya tiene sus migraciones (ADR-0019 §7). */
export interface Readiness {
  isReady(): boolean;
}

export interface ReadinessController extends Readiness {
  /** Empieza a comprobar: ahora y después cada `intervalMs`, hasta que esté lista. */
  start(): void;
  /** Deja de comprobar, al cerrar la API. */
  stop(): void;
}

/**
 * La espera de la API (ADR-0019 §7): mientras faltan sus migraciones, no está lista, y su ruta de
 * salud responde 503. Comprueba al arrancar y después cada `intervalMs`. Una vez lista no vuelve a
 * comprobar: si PostgreSQL cae después, las peticiones reciben `postgres_unavailable`, y Render no
 * reinicia la API en bucle. Deja `api_waiting` cada vez que cambia el motivo, con el código del
 * error de PostgreSQL y nunca su mensaje, y `api_ready` al quedar lista.
 */
export function createReadiness(deps: {
  readonly check: () => Promise<MigrationState>;
  readonly intervalMs: number;
  readonly schedule: (run: () => void, ms: number) => () => void;
  readonly log: ApiLog;
}): ReadinessController {
  let ready = false;
  let stopped = false;
  let cancel: (() => void) | null = null;
  let lastReason: string | null = null;

  const waiting = (
    reason: 'migrations_pending' | 'migration_changed' | 'postgres_error',
    error?: string,
  ) => {
    const key = `${reason}:${error ?? ''}`;
    if (key !== lastReason) {
      lastReason = key;
      deps.log(
        reason === 'postgres_error'
          ? { event: 'api_waiting', reason, error: error ?? 'Error' }
          : { event: 'api_waiting', reason },
      );
    }
  };

  // Lee `stopped` en una función aparte: puede cambiar mientras la comprobación espera.
  const isStopped = (): boolean => stopped;

  const scheduleNext = (): void => {
    if (!isStopped()) {
      cancel = deps.schedule(() => {
        void run();
      }, deps.intervalMs);
    }
  };

  const run = async (): Promise<void> => {
    cancel = null;
    if (isStopped()) {
      return;
    }
    try {
      const state = await deps.check();
      if (state === 'ready') {
        ready = true;
        deps.log({ event: 'api_ready' });
        return;
      }
      waiting(state);
    } catch (error) {
      waiting('postgres_error', errorName(error));
    }
    scheduleNext();
  };

  return {
    isReady: () => ready,
    start: () => {
      void run();
    },
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
