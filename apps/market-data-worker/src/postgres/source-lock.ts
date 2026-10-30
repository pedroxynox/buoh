import { createHash } from 'node:crypto';

import pg from 'pg';

import { type WorkerConfig } from '../config.js';
import { type SourceLogStore } from '../source-log/ports.js';

/** Código del error de una escritura del log sin el bloqueo de su fuente. */
export const SOURCE_LOCK_LOST = 'source_lock_lost';

/** Cada cuánto el bloqueo comprueba que su sesión sigue viva. */
export const SOURCE_LOCK_HEARTBEAT_MS = 5_000;
/**
 * Tiempo máximo de cada consulta y de la conexión del bloqueo. Una sesión que no responde en este
 * tiempo cuenta como perdida.
 */
export const SOURCE_LOCK_QUERY_TIMEOUT_MS = 5_000;

/**
 * Clave de `pg_try_advisory_lock` de una fuente: los 8 primeros bytes del SHA-256 de
 * `buoh:source-log:<fuente>`, como entero de 64 bits con signo. No depende de funciones internas
 * de PostgreSQL, así que la misma fuente da la misma clave en cualquier versión. La clave vale para
 * toda la base de datos, no para un esquema: bloquea también la misma fuente en otro
 * `BUOH_POSTGRES_SCHEMA` de la misma base.
 */
export function sourceLockKey(source: string): string {
  const digest = createHash('sha256').update(`buoh:source-log:${source}`, 'utf8').digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/**
 * El PID de la sesión de PostgreSQL que tiene el bloqueo de la fuente según `pg_locks`, o `null` si
 * no lo tiene ninguna: el escritor vivo de `data:health` (ADR-0015 §8). Es la consulta del runbook
 * («Una sola instancia por fuente»): un bloqueo de 64 bits guarda los 32 bits altos de la clave en
 * `classid`, los 32 bajos en `objid` y `objsubid = 1`. Como el bloqueo, mira solo la base de datos
 * del pool: otra base del mismo servidor tiene sus propios bloqueos. Solo lee: nunca toma el
 * bloqueo. `pg_locks` se lee con cualquier rol.
 */
export async function sourceLockHolder(
  pool: Pick<pg.Pool, 'query'>,
  source: string,
): Promise<number | null> {
  const key = BigInt.asUintN(64, BigInt(sourceLockKey(source)));
  const { rows } = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND classid = $1::bigint::oid AND objid = $2::bigint::oid
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [(key >> 32n).toString(), (key & 0xffff_ffffn).toString()],
  );
  return rows[0]?.pid ?? null;
}

/**
 * Bloqueo de sesión de una fuente (ADR-0012 §9; pendiente 6 de F1.3). Todo proceso que escriba el
 * log de una fuente en PostgreSQL lo toma antes y lo mantiene mientras ingiere. Vive en un cliente
 * propio, fuera del pool: el pool cierra los clientes inactivos y el bloqueo se iría con ellos.
 *
 * Cada `SOURCE_LOCK_HEARTBEAT_MS` consulta su propia sesión. Si la sesión se cierra, da un error o
 * no responde en `SOURCE_LOCK_QUERY_TIMEOUT_MS`, `held` pasa a `false` y el log protegido con
 * `lockedSourceLogStore` deja de escribir. Así una conexión que muere sin aviso se nota en unos
 * 10 s. Mientras tanto, otro proceso podría tomar el bloqueo, pero los triggers de `0002` siguen
 * aceptando cada posición para un solo escritor. Para volver a escribir hay que tomar un bloqueo
 * nuevo.
 */
export class SourceLock {
  readonly source: string;
  readonly #client: pg.Client;
  readonly #key: string;
  readonly #backendPid: number;
  #held = true;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #beating = false;

  private constructor(source: string, client: pg.Client, key: string, backendPid: number) {
    this.source = source;
    this.#client = client;
    this.#key = key;
    this.#backendPid = backendPid;
  }

  /** Toma el bloqueo, o devuelve `null` sin esperar si otro proceso ya lo tiene. */
  static async acquire(input: {
    readonly postgres: WorkerConfig['postgres'];
    readonly source: string;
  }): Promise<SourceLock | null> {
    const key = sourceLockKey(input.source);
    const client = new pg.Client({
      connectionTimeoutMillis: SOURCE_LOCK_QUERY_TIMEOUT_MS,
      database: input.postgres.database,
      host: input.postgres.host,
      // Además del latido: el sistema avisa de una conexión cortada sin esperar las 2 horas por
      // defecto del keepalive de TCP.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      password: input.postgres.password,
      port: input.postgres.port,
      query_timeout: SOURCE_LOCK_QUERY_TIMEOUT_MS,
      user: input.postgres.user,
    });
    let lock: SourceLock | null = null;
    // Un error del socket no tumba el proceso: deja el bloqueo como perdido.
    client.on('error', () => {
      if (lock !== null) {
        lock.#markLost();
      }
    });
    await client.connect();
    let row: { backend_pid: number; locked: boolean };
    try {
      // El PID sale de la misma consulta que toma el bloqueo: es el de la sesión que lo tiene.
      const { rows } = await client.query<{ backend_pid: number; locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked, pg_backend_pid() AS backend_pid',
        [key],
      );
      if (rows[0] === undefined) {
        throw new TypeError('La consulta del bloqueo no devolvió ninguna fila.');
      }
      row = rows[0];
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (!row.locked) {
      await client.end();
      return null;
    }
    const acquired = new SourceLock(input.source, client, key, row.backend_pid);
    lock = acquired;
    client.on('end', () => {
      acquired.#markLost();
    });
    acquired.#heartbeat = setInterval(() => {
      void acquired.#beat();
    }, SOURCE_LOCK_HEARTBEAT_MS);
    // El latido no mantiene vivo el proceso por sí solo.
    acquired.#heartbeat.unref();
    return acquired;
  }

  /** `true` mientras la sesión que tiene el bloqueo siga viva. */
  get held(): boolean {
    return this.#held;
  }

  /**
   * El PID de PostgreSQL de la sesión que tiene el bloqueo (`pg_backend_pid()`), leído una vez al
   * tomarlo. Es el que `pg_locks` muestra para el bloqueo y el que la sesión de ingesta escribe en
   * cada latido (ADR-0015 §6), para que `data:health` (ADR-0015 §8, PR 6) reconozca al escritor vivo
   * de este esquema.
   */
  get backendPid(): number {
    return this.#backendPid;
  }

  async #beat(): Promise<void> {
    if (!this.#held || this.#beating) {
      return;
    }
    this.#beating = true;
    try {
      await this.#client.query('SELECT 1');
    } catch {
      this.#markLost();
    } finally {
      this.#beating = false;
    }
  }

  #markLost(): void {
    this.#held = false;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  /**
   * Suelta el bloqueo y cierra su cliente. Nunca falla ni espera más de
   * `SOURCE_LOCK_QUERY_TIMEOUT_MS`: cerrar la sesión ya suelta un bloqueo de sesión, así que soltarlo
   * antes es solo cortesía.
   */
  async release(): Promise<void> {
    const held = this.#held;
    this.#markLost();
    if (held) {
      await this.#client
        .query('SELECT pg_advisory_unlock($1::bigint)', [this.#key])
        .catch(() => undefined);
    }
    // Con una consulta vencida en curso, `end` corta el socket en lugar de esperar.
    await this.#client.end().catch(() => undefined);
  }
}

/**
 * Log de la fuente protegido por su bloqueo: cada escritura, también la de un punto de control del
 * estado vivo, comprueba antes que el bloqueo sigue tomado y, si no, falla con el código
 * `source_lock_lost`. El log lo trata como cualquier fallo de persistencia: el evento no es durable
 * y la entrada se pausa. Las lecturas no cambian.
 *
 * Si el bloqueo se pierde a mitad de una escritura, los triggers de `0002` siguen exigiendo
 * posiciones contiguas, así que dos escritores nunca dejan un log incoherente: uno de los dos falla.
 */
export function lockedSourceLogStore(
  store: SourceLogStore,
  lock: Pick<SourceLock, 'held' | 'source'>,
): SourceLogStore {
  const assertHeld = (source: string): void => {
    if (source !== lock.source) {
      throw new TypeError(`El bloqueo es de "${lock.source}", no de "${source}".`);
    }
    if (!lock.held) {
      throw Object.assign(new Error(`Se perdió el bloqueo de "${source}".`), {
        code: SOURCE_LOCK_LOST,
      });
    }
  };
  return {
    insertClosedSegment: async (segment) => {
      assertHeld(segment.source);
      await store.insertClosedSegment(segment);
    },
    insertIndexRow: async (row) => {
      assertHeld(row.source);
      await store.insertIndexRow(row);
    },
    // El punto de control del estado vivo también lo escribe solo quien tiene el bloqueo (ADR-0017
    // §5, «Escritor»).
    insertLiveCheckpoint: async (row) => {
      assertHeld(row.source);
      return store.insertLiveCheckpoint(row);
    },
    hasSourceEvent: (source, eventId) => store.hasSourceEvent(source, eventId),
    listClosedSegments: (source, from, to) => store.listClosedSegments(source, from, to),
    readLiveCheckpoint: (source, versionsSha256, below) =>
      store.readLiveCheckpoint(source, versionsSha256, below),
    readLogState: (source) => store.readLogState(source),
  };
}
