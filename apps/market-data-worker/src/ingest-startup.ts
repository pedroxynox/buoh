import { type Scheduler } from './deriv/ports.js';
import {
  SourceLockUnavailableError,
  type SessionLock,
  type SessionLockProvider,
} from './deriv/session.js';
import { type OperationalAlert } from './operational/registry.js';
import { failureReason } from './source-log/source-event-log.js';
import { type LogLocation } from './successive-logs.js';

// La espera del arranque de `ingest` en `production` (ADR-0018 §4): antes de capturar, espera sin
// escribir nada hasta que PostgreSQL acepte su credencial, haya un log preparado con todas sus
// migraciones y el bloqueo de la fuente esté libre, en ese orden. Así un despliegue, una migración
// nueva o una contraseña rotada no hacen que termine ni que se reinicie en bucle (§5 y §12).

/** Cada cuánto vuelve a mirar la credencial, el log y sus migraciones mientras espera. */
export const STARTUP_RETRY_MS = 30_000;
/** Cada cuánto vuelve a intentar el bloqueo de la fuente mientras lo tiene otro proceso. */
export const STARTUP_LOCK_RETRY_MS = 1_000;
/** Cada cuánto repite la alerta `ingest_waiting` mientras el motivo no cambia. */
export const STARTUP_ALERT_INTERVAL_MS = 60_000;

/** Lo que espera `ingest` en `production`, en el orden en que lo mira. */
export const STARTUP_WAIT_REASONS = [
  'postgres_unavailable',
  'log_not_prepared',
  'migrations_pending',
  'source_lock_taken',
] as const;
export type StartupWaitReason = (typeof STARTUP_WAIT_REASONS)[number];

/** El motivo de un bloqueo que ya no está tomado al recibirlo, como el de la sesión. */
const LOCK_LOST = 'source_lock_lost';

/** Las lecturas de la espera, que no escriben nada. En `ingest`, `openStartupReads`. */
export interface StartupReads {
  /**
   * El log activo de la fuente (`findActiveLog`), o `null` si no hay ninguno preparado. Rechaza si
   * PostgreSQL no acepta la credencial o no responde.
   */
  locateLog(): Promise<LogLocation | null>;
  /** Las migraciones del worker que le faltan al esquema del log, sin aplicar nada. */
  pendingMigrations(log: LogLocation): Promise<readonly string[]>;
  /** Libera las conexiones. */
  close(): Promise<void>;
}

export interface StartupWaitInput {
  /** Recibe cada alerta `ingest_waiting`, saneada. */
  readonly alert: OperationalAlert;
  /** El bloqueo de la fuente: `PostgresSessionLockProvider` en `ingest`. */
  readonly lock: SessionLockProvider;
  /** La hora UTC con milisegundos (`toISOString()`), para repetir la alerta cada minuto. */
  readonly now: () => string;
  readonly reads: Pick<StartupReads, 'locateLog' | 'pendingMigrations'>;
  /** El temporizador de las esperas entre intentos. */
  readonly scheduler: Scheduler;
  /** Escucha la parada: llama a `onSignal` con cada señal y devuelve la función que deja de escucharla. */
  readonly signals: (onSignal: () => void) => () => void;
}

/**
 * Cómo terminó la espera: lista, con el log activo y el bloqueo de la fuente tomado, o parada por
 * una señal, con el motivo por el que esperaba, o `null` si todavía no esperaba nada.
 */
export type StartupWaitResult =
  | { readonly lock: SessionLock; readonly log: LogLocation; readonly status: 'ready' }
  | { readonly status: 'stopped'; readonly waiting: StartupWaitReason | null };

/** Lo que dio una comprobación de la credencial, el log y sus migraciones, o una parada. */
type PreparedCheck =
  | { readonly log: LogLocation }
  | { readonly detail: string | null; readonly reason: StartupWaitReason }
  | { readonly stopped: true };

/**
 * La credencial, el log y sus migraciones, en ese orden (ADR-0018 §4). La primera lectura del log
 * activo es la que prueba la credencial: si PostgreSQL la rechaza o no responde, o si falla
 * cualquier lectura, el motivo es `postgres_unavailable`, con el código o el nombre del error
 * (`failureReason`), nunca su mensaje. Si llegó la parada mientras buscaba el log, no lee las
 * migraciones.
 */
async function checkPrepared(
  reads: StartupWaitInput['reads'],
  stopped: () => boolean,
): Promise<PreparedCheck> {
  let log: LogLocation | null;
  try {
    log = await reads.locateLog();
  } catch (error) {
    return { detail: failureReason(error), reason: 'postgres_unavailable' };
  }
  if (log === null) {
    return { detail: null, reason: 'log_not_prepared' };
  }
  if (stopped()) {
    return { stopped: true };
  }
  let pending: readonly string[];
  try {
    pending = await reads.pendingMigrations(log);
  } catch (error) {
    return { detail: failureReason(error), reason: 'postgres_unavailable' };
  }
  const [first] = pending;
  return first === undefined ? { log } : { detail: first, reason: 'migrations_pending' };
}

/**
 * Una espera del arranque. Sus campos privados guardan la parada y el temporizador de la pausa en
 * curso, que la parada corta.
 */
class StartupWait {
  readonly #input: StartupWaitInput;
  #stopped = false;
  #wake: (() => void) | null = null;
  #reason: StartupWaitReason | null = null;
  #lastAlertMs: number | null = null;

  constructor(input: StartupWaitInput) {
    this.#input = input;
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }

  #stopRequested(): boolean {
    return this.#stopped;
  }

  /**
   * Deja la alerta `ingest_waiting` con el motivo y su detalle saneado cuando el motivo cambia y,
   * mientras no cambia, una vez por minuto. Un reloj que retrocede no la calla.
   */
  #waiting(reason: StartupWaitReason, detail: string | null): void {
    const at = Date.parse(this.#input.now());
    const elapsed = this.#lastAlertMs === null ? Number.POSITIVE_INFINITY : at - this.#lastAlertMs;
    if (reason !== this.#reason || elapsed >= STARTUP_ALERT_INTERVAL_MS || elapsed < 0) {
      this.#input.alert({ detail, event: 'ingest_waiting', reason });
      this.#lastAlertMs = at;
    }
    this.#reason = reason;
  }

  /** Espera `ms` milisegundos del temporizador, o menos si llega la parada. */
  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#stopped) {
        resolve();
        return;
      }
      const cancel = this.#input.scheduler.schedule(ms, () => {
        this.#wake = null;
        resolve();
      });
      this.#wake = () => {
        cancel();
        this.#wake = null;
        resolve();
      };
    });
  }

  #stoppedResult(): StartupWaitResult {
    return { status: 'stopped', waiting: this.#reason };
  }

  async run(): Promise<StartupWaitResult> {
    const { lock: provider, reads } = this.#input;
    let prepared: LogLocation | null = null;
    for (;;) {
      if (this.#stopRequested()) {
        return this.#stoppedResult();
      }
      if (prepared === null) {
        const check = await checkPrepared(reads, () => this.#stopRequested());
        if ('stopped' in check) {
          // La vuelta siguiente devuelve la parada.
          continue;
        }
        if ('reason' in check) {
          this.#waiting(check.reason, check.detail);
          await this.#pause(STARTUP_RETRY_MS);
        } else {
          prepared = check.log;
        }
        continue;
      }
      let lock: SessionLock | null;
      try {
        lock = await provider.acquire();
      } catch (error) {
        if (!(error instanceof SourceLockUnavailableError)) {
          throw error;
        }
        this.#waiting('postgres_unavailable', error.reason);
        prepared = null;
        await this.#pause(STARTUP_RETRY_MS);
        continue;
      }
      if (lock === null) {
        // Solo el bloqueo se vuelve a intentar cada segundo: lo demás ya estaba listo.
        this.#waiting('source_lock_taken', null);
        await this.#pause(STARTUP_LOCK_RETRY_MS);
        continue;
      }
      // Una parada mientras lo tomaba: lo suelta enseguida, sin leer más, para el escritor siguiente.
      if (this.#stopRequested()) {
        await lock.release();
        return this.#stoppedResult();
      }
      // Con el bloqueo, solo este proceso escribe, así que el log activo ya no cambia. Si cambió
      // mientras esperaba, por ejemplo porque el escritor anterior pasó al log siguiente (§6), se
      // suelta y, tras la pausa del bloqueo, se vuelve a mirar todo. La pausa evita un bucle sin
      // esperas si las dos lecturas no dejaran de diferir.
      let current: LogLocation | null;
      try {
        current = await reads.locateLog();
      } catch (error) {
        await lock.release();
        this.#waiting('postgres_unavailable', failureReason(error));
        prepared = null;
        await this.#pause(STARTUP_RETRY_MS);
        continue;
      }
      if (!lock.held) {
        await lock.release();
        this.#waiting('postgres_unavailable', LOCK_LOST);
        prepared = null;
        await this.#pause(STARTUP_RETRY_MS);
        continue;
      }
      if (current?.number !== prepared.number) {
        await lock.release();
        prepared = null;
        await this.#pause(STARTUP_LOCK_RETRY_MS);
        continue;
      }
      if (this.#stopRequested()) {
        await lock.release();
        return this.#stoppedResult();
      }
      return { lock, log: prepared, status: 'ready' };
    }
  }
}

/**
 * Espera el arranque de `ingest` en `production` (ADR-0018 §4), sin escribir nada:
 *
 * 1. que PostgreSQL acepte la credencial y haya un log activo preparado (`log_not_prepared`);
 * 2. que ese log tenga todas las migraciones del worker (`migrations_pending`);
 * 3. el bloqueo de la fuente (`source_lock_taken`).
 *
 * Si PostgreSQL no responde en cualquiera de esas lecturas o al tomar el bloqueo, el motivo es
 * `postgres_unavailable`. Vuelve a intentar el bloqueo cada `STARTUP_LOCK_RETRY_MS`, y lo demás
 * cada `STARTUP_RETRY_MS`, empezando por la credencial. Mientras espera deja la alerta
 * `ingest_waiting` (`#waiting`). Con el bloqueo tomado, vuelve a buscar el log activo: si cambió,
 * suelta el bloqueo y, tras `STARTUP_LOCK_RETRY_MS`, empieza otra vez.
 *
 * Se resuelve lista, con el log y el bloqueo, que pasa a quien la llama, o parada si llega una señal:
 * entonces no deja ningún bloqueo tomado ni ninguna pausa pendiente. Un rechazo de `acquire` que no
 * es `SourceLockUnavailableError` es un error de programación, y la rechaza con él.
 */
export async function waitForProductionStart(input: StartupWaitInput): Promise<StartupWaitResult> {
  const wait = new StartupWait(input);
  const stopListening = input.signals(() => {
    wait.stop();
  });
  try {
    return await wait.run();
  } finally {
    stopListening();
  }
}

/**
 * El bloqueo que tomó la espera del arranque, para la sesión (ADR-0018 §4): su primer `acquire` da
 * ese bloqueo, y los siguientes, después de perderlo, los del proveedor de siempre. Así la sesión
 * empieza con el bloqueo que la espera ya tiene, sin soltarlo ni volver a pedirlo, y si lo pierde
 * mientras captura y lo tiene otro proceso, termina con `source_lock_taken`, como fuera de
 * `production`.
 */
export class HandedOverLockProvider implements SessionLockProvider {
  #first: SessionLock | null;
  readonly #next: SessionLockProvider;

  constructor(first: SessionLock, next: SessionLockProvider) {
    this.#first = first;
    this.#next = next;
  }

  acquire(): Promise<SessionLock | null> {
    const first = this.#first;
    if (first === null) {
      return this.#next.acquire();
    }
    this.#first = null;
    return Promise.resolve(first);
  }

  /** Suelta el bloqueo de la espera si la sesión no llegó a pedirlo. Nunca falla. */
  async releaseUnused(): Promise<void> {
    const first = this.#first;
    this.#first = null;
    await first?.release();
  }
}
