import { type IngestionCursor, type SourceEvent } from '@buoh/contracts';
import { type InvalidFrameReason, type UnflaggedTick } from '@buoh/domain';

import { DERIV_SOURCE } from '../../src/deriv/profile.js';
import {
  SourceLockUnavailableError,
  startDerivSession,
  type SessionLock,
  type SessionLockProvider,
} from '../../src/deriv/session.js';
import { OperationalRegistry, type OperationalAlert } from '../../src/operational/registry.js';
import { lockedSourceLogStore } from '../../src/postgres/source-lock.js';
import { SourceEventLog } from '../../src/source-log/source-event-log.js';
import { PongingSocket, settle, START, uuid } from './connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from './deriv-fixtures.js';
import {
  MemoryCatalogStore,
  MemoryIngestionStatusStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemoryRequestedResponseIncidentStore,
  MemorySourceLogStore,
} from './memory-stores.js';

// La sesión de ingesta armada sobre almacenes en memoria (ADR-0015 §3): reloj y temporizador
// manuales, sockets falsos, IDs secuenciales desde 1, esquemas sintéticos descargados de un `fetch`
// falso y un bloqueo en memoria. Con `status`, también el cursor y el latido (ADR-0015 §6). Ningún
// precio es de mercado.

/** El PID de PostgreSQL del bloqueo número `number`, desde 1: 4000 + `number`. */
export const lockPid = (number: number): number => 4000 + number;

/**
 * Bloqueo en memoria. `lose` lo da por perdido, como cuando PostgreSQL corta la sesión que lo tiene.
 * Su `backendPid` es `lockPid(number)`, salvo que se cree sin PID, como el del smoke.
 */
export class FakeSessionLock implements SessionLock {
  /** Orden del bloqueo entre los que tomó la sesión, desde 1. */
  readonly number: number;
  readonly backendPid?: number;
  released = false;
  readonly #timeline: string[];
  readonly #onRelease: (number: number) => void;
  #held = true;

  constructor(
    number: number,
    timeline: string[],
    onRelease: (number: number) => void,
    held = true,
    withPid = true,
  ) {
    this.number = number;
    if (withPid) {
      this.backendPid = lockPid(number);
    }
    this.#timeline = timeline;
    this.#onRelease = onRelease;
    this.#held = held;
  }

  get held(): boolean {
    return this.#held;
  }

  lose(): void {
    this.#held = false;
  }

  release(): Promise<void> {
    this.#held = false;
    this.released = true;
    this.#timeline.push(`release:${String(this.number)}`);
    this.#onRelease(this.number);
    return Promise.resolve();
  }
}

/**
 * Lo que responde cada `acquire`, en orden: `lock` (un bloqueo nuevo), `lost` (un bloqueo que ya se
 * perdió: `held` es `false`), `taken` (lo tiene otro proceso: `null`), `unavailable` (PostgreSQL no
 * responde: lanza `SourceLockUnavailableError` con una causa de código `ECONNREFUSED`),
 * `{ unavailable: causa }` (igual, con esa causa) o `bug` (un error de programación del proveedor:
 * lanza un `TypeError`). Después de la lista, siempre un bloqueo nuevo.
 */
export type LockAnswer =
  'bug' | 'lock' | 'lost' | 'taken' | 'unavailable' | { readonly unavailable: unknown };

/** El error de programación que lanza un `acquire` con la respuesta `bug`. */
export const LOCK_BUG = new TypeError('sintético');

export class FakeLockProvider implements SessionLockProvider {
  readonly locks: FakeSessionLock[] = [];
  /** Se llama al empezar cada `acquire`, con su número desde 1. */
  onAcquire: (call: number) => void = () => undefined;
  /** Se llama al soltar cada bloqueo, con su número. */
  onRelease: (number: number) => void = () => undefined;
  readonly #answers: LockAnswer[];
  readonly #timeline: string[];
  readonly #withPid: boolean;
  #calls = 0;

  /** Con `withPid` en `false`, sus bloqueos no exponen `backendPid`, como el del smoke. */
  constructor(answers: readonly LockAnswer[], timeline: string[], withPid = true) {
    this.#answers = [...answers];
    this.#timeline = timeline;
    this.#withPid = withPid;
  }

  /** El bloqueo número `number`, desde 1; falla si la sesión no lo tomó. */
  lock(number: number): FakeSessionLock {
    const lock = this.locks[number - 1];
    if (lock === undefined) {
      throw new TypeError(`La sesión no tomó el bloqueo ${String(number)}.`);
    }
    return lock;
  }

  acquire(): Promise<SessionLock | null> {
    this.#calls += 1;
    this.onAcquire(this.#calls);
    const answer = this.#answers.shift() ?? 'lock';
    if (answer === 'taken') {
      this.#timeline.push('acquire:taken');
      return Promise.resolve(null);
    }
    if (typeof answer === 'object' || answer === 'unavailable') {
      this.#timeline.push('acquire:unavailable');
      const cause =
        typeof answer === 'object'
          ? answer.unavailable
          : Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
      return Promise.reject(new SourceLockUnavailableError(cause));
    }
    if (answer === 'bug') {
      this.#timeline.push('acquire:bug');
      return Promise.reject(LOCK_BUG);
    }
    const lock = new FakeSessionLock(
      this.locks.length + 1,
      this.#timeline,
      (number) => {
        this.onRelease(number);
      },
      answer === 'lock',
      this.#withPid,
    );
    this.locks.push(lock);
    this.#timeline.push(`acquire:${String(lock.number)}`);
    return Promise.resolve(lock);
  }
}

const SCHEMA_URL = 'https://schemas.invalid/schemas.zip';

let archive: ReturnType<typeof syntheticSchemaArchive> | null = null;

export interface SessionHarnessOptions {
  /** El servidor responde enseguida cada `ping`: para conexiones de más de 45 000 ms. */
  readonly answerPings?: boolean;
  /** Las primeras `n` llamadas a `connect` lanzan, como un host que no responde. */
  readonly failingConnects?: number;
  /** Source events que el log ya tiene, de ejecuciones anteriores; por defecto, ninguno. */
  readonly events?: readonly SourceEvent[];
  /** Cierra el segmento de esos eventos (`requested`) antes de la sesión. */
  readonly closeSegment?: boolean;
  /** Respuestas de `acquire`, en orden (ver `LockAnswer`); por defecto, siempre un bloqueo. */
  readonly locks?: readonly LockAnswer[];
  /** El `random` de la espera; por defecto, siempre 0. */
  readonly random?: () => number;
  /** SHA-256 esperado del archivo de esquemas; por defecto, el del archivo sintético. */
  readonly expectedSha256?: string;
  /** Además de anotarlo, recibe cada tick durable: para hacer fallar el sink. */
  readonly onTick?: (tick: UnflaggedTick) => void;
  /**
   * Cambia los almacenes después de escribir `events` y `cursors` y antes de arrancar la sesión.
   * `status` es el almacén del cursor y del latido, o `null` si la sesión no lo tiene.
   */
  readonly beforeStart?: (stores: {
    readonly objects: MemoryObjectStore;
    readonly sourceLog: MemorySourceLogStore;
    readonly status: MemoryIngestionStatusStore | null;
  }) => void;
  /**
   * La sesión escribe el cursor y el latido en un almacén en memoria (`status` del resultado del
   * harness); por defecto, no lo tiene, como el smoke.
   */
  readonly status?: boolean;
  /** Cursores que el almacén ya tiene, de ejecuciones anteriores, en orden; implica `status`. */
  readonly cursors?: readonly IngestionCursor[];
  /** Los bloqueos no exponen `backendPid`, como el del smoke; por defecto, sí. */
  readonly pidlessLocks?: boolean;
  /**
   * La sesión guarda el esquema de fuente en el almacenamiento de objetos del log (`objects`), como
   * `ingest`; por defecto, no, como el smoke.
   */
  readonly schemaObjects?: boolean;
  /** La retención de la sesión, en milisegundos; por defecto, ninguna. */
  readonly retentionMs?: number;
  /** Pide la parada dentro de la llamada número `n` a `connect`, mientras se crea el socket. */
  readonly stopOnConnect?: number;
  /** Pide la parada durante la descarga de los esquemas. */
  readonly stopOnFetch?: boolean;
  /** Pide la parada dentro de la llamada número `n` a `acquire`. */
  readonly stopOnAcquire?: number;
  /** Pide la parada dentro de la llamada número `n` a `openLog`. */
  readonly stopOnOpenLog?: number;
  /** Pide la parada mientras se suelta el bloqueo número `n`. */
  readonly stopOnRelease?: number;
  /** Pide `time` tras el primer tick de cada conexión; por defecto, no. */
  readonly serverTime?: boolean;
  /** Duración prevista de la sesión, en milisegundos; por defecto, ninguna. */
  readonly durationMs?: number;
  /** El corte del smoke de reconexión, en ms desde el primer tick; por defecto, ninguno. */
  readonly interruptAfterMs?: number;
  /** Cada socket falso avisa del cierre solo con `finishClose`, como `ws`; por defecto, enseguida. */
  readonly deferClose?: boolean;
}

/**
 * Una sesión sobre `SYNTH_100` que ya arrancó. `openLog` abre el log con el almacén protegido por el
 * bloqueo que recibe (`lockedSourceLogStore`), así que con un bloqueo perdido las escrituras fallan
 * con `source_lock_lost`. `timeline` anota en orden cada `acquire`, cada `release` y cada llamada a
 * `connect`.
 */
export async function sessionHarness(options: SessionHarnessOptions = {}) {
  const clock = new ManualClock(START);
  let sequence = 0;
  const nextId = () => uuid((sequence += 1));
  const objects = new MemoryObjectStore();
  const sourceLog = new MemorySourceLogStore();
  const operational = new MemoryOperationalStore();
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const ticks: UnflaggedTick[] = [];
  const invalid: { observation_id: string; reason: InvalidFrameReason }[] = [];
  const timeline: string[] = [];
  const sockets: FakeDerivSocket[] = [];
  /** Filas del índice cuando la sesión llama a `connect`, en orden. */
  const rowsAtConnect: number[] = [];
  /** Los bloqueos con que la sesión abrió el log, en orden. */
  const openedWith: SessionLock[] = [];
  let failingConnects = options.failingConnects ?? 0;

  const unlockedLog = () =>
    SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
  const seed = await unlockedLog();
  for (const event of options.events ?? []) {
    await seed.append(event);
  }
  if (options.closeSegment === true) {
    await seed.close('requested');
  }
  const status =
    options.status === true || options.cursors !== undefined
      ? new MemoryIngestionStatusStore()
      : null;
  for (const cursor of options.cursors ?? []) {
    await status?.appendCursor(cursor);
  }
  options.beforeStart?.({ objects, sourceLog, status });

  archive ??= syntheticSchemaArchive();
  const fixture = archive;
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: DERIV_SOURCE,
    store: operational,
  });
  const provider = new FakeLockProvider(
    options.locks ?? [],
    timeline,
    options.pidlessLocks !== true,
  );
  let stopSession = (): void => undefined;
  provider.onAcquire = (call) => {
    if (options.stopOnAcquire === call) {
      stopSession();
    }
  };
  provider.onRelease = (number) => {
    if (options.stopOnRelease === number) {
      stopSession();
    }
  };

  const session = startDerivSession({
    alert: (payload) => alerts.push(payload),
    catalog: new MemoryCatalogStore(),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(options.interruptAfterMs === undefined
      ? {}
      : { interruptAfterMs: options.interruptAfterMs }),
    connect: (input) => {
      rowsAtConnect.push(sourceLog.rows.length);
      timeline.push(`connect:${String(rowsAtConnect.length)}`);
      if (options.stopOnConnect === rowsAtConnect.length) {
        stopSession();
      }
      if (failingConnects > 0) {
        failingConnects -= 1;
        throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
      }
      const Socket = options.answerPings === true ? PongingSocket : FakeDerivSocket;
      const socket = new Socket({ ...input, deferClose: options.deferClose ?? false });
      sockets.push(socket);
      return socket;
    },
    expected:
      options.expectedSha256 === undefined
        ? fixture.expected
        : { ...fixture.expected, archive_sha256: options.expectedSha256 },
    fetch: () => {
      if (options.stopOnFetch === true) {
        // La descarga empieza mientras se arma la sesión: la parada llega justo después.
        queueMicrotask(() => {
          stopSession();
        });
      }
      return Promise.resolve(new Response(fixture.archive, { status: 200 }));
    },
    lock: provider,
    nextId,
    now: clock.now,
    openLog: (lock) => {
      openedWith.push(lock);
      if (options.stopOnOpenLog === openedWith.length) {
        stopSession();
      }
      return SourceEventLog.open({
        objects,
        source: DERIV_SOURCE,
        store: lockedSourceLogStore(sourceLog, {
          get held() {
            return lock.held;
          },
          source: DERIV_SOURCE,
        }),
        zlibVersion: 'test',
      });
    },
    random: options.random ?? (() => 0),
    registry,
    requestedResponses: new MemoryRequestedResponseIncidentStore(),
    ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    scheduler: clock.scheduler,
    ...(options.schemaObjects === true ? { schemaObjects: objects } : {}),
    schemaUrl: SCHEMA_URL,
    serverTime: options.serverTime ?? false,
    ...(status === null ? {} : { status }),
    sink: {
      invalidFrame: (item) => invalid.push(item),
      tick: (tick) => {
        ticks.push(tick);
        options.onTick?.(tick);
      },
    },
    symbol: 'SYNTH_100',
  });
  stopSession = () => {
    session.stop();
  };
  // Un rechazo mientras arranca no cuenta como no manejado: la prueba que espera `done` lo ve igual.
  session.done.catch(() => undefined);
  // La descarga sintética lee su cuerpo en varios pasos.
  await settle();
  await settle();

  /** El socket número `number` de la sesión, desde 1; falla si no existe. */
  const socket = (number: number): FakeDerivSocket => {
    const found = sockets[number - 1];
    if (found === undefined) {
      throw new TypeError(
        `Se esperaba el socket ${String(number)}, hay ${String(sockets.length)}.`,
      );
    }
    return found;
  };

  /** Source events durables, leídos de los almacenes con un log reabierto. */
  const events = async (): Promise<SourceEvent[]> =>
    (await (await unlockedLog()).readDurableSegments()).flat();

  /**
   * Abre el socket, responde el catálogo (`req_id` 1) y entrega el primer tick, en `epoch` y con
   * `quote`, como respuesta a la suscripción (`req_id` 2).
   */
  const subscribe = async (target: FakeDerivSocket, epoch: number, quote = '100.25') => {
    target.open();
    await settle();
    target.text(derivMessages.catalog(1));
    await settle();
    target.text(derivMessages.tick(2, epoch, quote));
    await settle();
  };

  return {
    alerts,
    clock,
    done: session.done,
    events,
    fixture,
    invalid,
    objects,
    openedWith,
    operational,
    provider,
    registry,
    rowsAtConnect,
    session,
    socket,
    sockets,
    sourceLog,
    status,
    subscribe,
    ticks,
    timeline,
    unlockedLog,
  };
}

export type SessionRun = Awaited<ReturnType<typeof sessionHarness>>;
