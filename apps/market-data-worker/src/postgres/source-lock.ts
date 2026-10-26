import { createHash } from 'node:crypto';

import pg from 'pg';

import { type WorkerConfig } from '../config.js';
import { type SourceLogStore } from '../source-log/ports.js';

/** Código del error de una escritura del log sin el bloqueo de su fuente. */
export const SOURCE_LOCK_LOST = 'source_lock_lost';

/**
 * Clave de `pg_try_advisory_lock` de una fuente: los 8 primeros bytes del SHA-256 de
 * `buoh:source-log:<fuente>`, como entero de 64 bits con signo. No depende de funciones internas
 * de PostgreSQL, así que la misma fuente da la misma clave en cualquier versión.
 */
export function sourceLockKey(source: string): string {
  const digest = createHash('sha256').update(`buoh:source-log:${source}`, 'utf8').digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/**
 * Bloqueo de sesión de una fuente (ADR-0012 §9; pendiente 6 de F1.3). Todo proceso que escriba el
 * log de una fuente en PostgreSQL lo toma antes y lo mantiene mientras ingiere. Vive en un cliente
 * propio, fuera del pool: el pool cierra los clientes inactivos y el bloqueo se iría con ellos.
 *
 * Si la sesión se pierde, `held` pasa a `false` y el log protegido con `lockedSourceLogStore` deja de
 * escribir. Para volver a escribir hay que tomar un bloqueo nuevo.
 */
export class SourceLock {
  readonly source: string;
  readonly #client: pg.Client;
  readonly #key: string;
  #held = true;

  private constructor(source: string, client: pg.Client, key: string) {
    this.source = source;
    this.#client = client;
    this.#key = key;
  }

  /** Toma el bloqueo, o devuelve `null` sin esperar si otro proceso ya lo tiene. */
  static async acquire(input: {
    readonly postgres: WorkerConfig['postgres'];
    readonly source: string;
  }): Promise<SourceLock | null> {
    const key = sourceLockKey(input.source);
    const client = new pg.Client({
      database: input.postgres.database,
      host: input.postgres.host,
      // Detecta una conexión muerta aunque no haya consultas.
      keepAlive: true,
      password: input.postgres.password,
      port: input.postgres.port,
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
    let locked: boolean;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key],
      );
      locked = rows[0]?.locked === true;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (!locked) {
      await client.end();
      return null;
    }
    const acquired = new SourceLock(input.source, client, key);
    lock = acquired;
    client.on('end', () => {
      acquired.#markLost();
    });
    return acquired;
  }

  /** `true` mientras la sesión que tiene el bloqueo siga viva. */
  get held(): boolean {
    return this.#held;
  }

  #markLost(): void {
    this.#held = false;
  }

  /** Suelta el bloqueo y cierra su cliente. Si la sesión ya se perdió, solo cierra. */
  async release(): Promise<void> {
    const held = this.#held;
    this.#held = false;
    try {
      if (held) {
        await this.#client.query('SELECT pg_advisory_unlock($1::bigint)', [this.#key]);
      }
    } finally {
      await this.#client.end().catch(() => undefined);
    }
  }
}

/**
 * Log de la fuente protegido por su bloqueo: cada escritura comprueba antes que el bloqueo sigue
 * tomado y, si no, falla con el código `source_lock_lost`. El log lo trata como cualquier fallo de
 * persistencia: el evento no es durable y la entrada se pausa. Las lecturas no cambian.
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
    listClosedSegments: (source, from, to) => store.listClosedSegments(source, from, to),
    readLogState: (source) => store.readLogState(source),
  };
}
