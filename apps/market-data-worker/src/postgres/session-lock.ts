import { type WorkerConfig } from '../config.js';
import {
  SourceLockUnavailableError,
  type SessionLock,
  type SessionLockProvider,
} from '../deriv/session.js';
import { SourceEventLog, type OpenSourceEventLogInput } from '../source-log/source-event-log.js';
import { lockedSourceLogStore, SourceLock } from './source-lock.js';

/**
 * El bloqueo de la fuente para la sesión de ingesta sobre PostgreSQL (ADR-0015 §3, «Bloqueo»):
 * envuelve `SourceLock.acquire`. Cada `acquire` abre un cliente propio con su sesión y devuelve el
 * bloqueo tomado, con `held` en `true` y su `backendPid`, o `null` si lo tiene otro proceso. Si la
 * conexión o la consulta fallan, PostgreSQL no respondió: lanza `SourceLockUnavailableError` con
 * esa causa, y la sesión espera y lo intenta otra vez.
 */
export class PostgresSessionLockProvider implements SessionLockProvider {
  readonly source: string;
  readonly #postgres: WorkerConfig['postgres'];

  constructor(input: { readonly postgres: WorkerConfig['postgres']; readonly source: string }) {
    this.source = input.source;
    this.#postgres = input.postgres;
  }

  async acquire(): Promise<SourceLock | null> {
    try {
      return await SourceLock.acquire({ postgres: this.#postgres, source: this.source });
    } catch (error) {
      throw new SourceLockUnavailableError(error);
    }
  }
}

/**
 * Abre el log de la fuente con el almacén protegido por ese bloqueo (`lockedSourceLogStore`): cada
 * escritura comprueba antes que el bloqueo sigue tomado, así que el log solo escribe con el bloqueo
 * vigente (ADR-0015 §3). Es la apertura del log de la sesión (`openLog`) sobre PostgreSQL: la sesión
 * la llama con cada bloqueo nuevo. El bloqueo tiene que ser un `SourceLock` de la misma fuente que
 * el log; si no, rechaza con `TypeError` sin leer nada. Los fallos al abrir son los de
 * `SourceEventLog.open`.
 */
export function openLockedSourceLog(
  lock: SessionLock,
  input: OpenSourceEventLogInput,
): Promise<SourceEventLog> {
  if (!(lock instanceof SourceLock) || lock.source !== input.source) {
    return Promise.reject(
      new TypeError(`El log de "${input.source}" se abre con el SourceLock de su fuente.`),
    );
  }
  return SourceEventLog.open({ ...input, store: lockedSourceLogStore(input.store, lock) });
}
