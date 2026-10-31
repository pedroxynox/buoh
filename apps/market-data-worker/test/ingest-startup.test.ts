import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HandedOverLockProvider,
  logLocation,
  STARTUP_ALERT_INTERVAL_MS,
  STARTUP_LOCK_RETRY_MS,
  STARTUP_RETRY_MS,
  STARTUP_WAIT_REASONS,
  waitForProductionStart,
  type LogLocation,
  type OperationalAlert,
  type StartupWaitResult,
} from '../src/index.js';
import { settle, START } from './support/connection-harness.js';
import { ManualClock } from './support/deriv-fixtures.js';
import { FakeLockProvider, LOCK_BUG, type LockAnswer } from './support/session-harness.js';

// La espera del arranque de `ingest` en `production` (ADR-0018 §4) sin red ni servicios: lecturas
// falsas que la prueba cambia mientras espera, el bloqueo en memoria de la sesión, el reloj manual
// y señales falsas. Los vectores salen de §4: el orden de lo que espera, cada 30 s salvo el
// bloqueo, que se intenta cada segundo, la alerta `ingest_waiting` cada minuto y nada escrito.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lo que ven las lecturas; la prueba lo cambia mientras espera. */
interface ReadsState {
  locate: LogLocation | null | Error;
  /** El log activo que da la lectura hecha con el bloqueo tomado, si no es el de `locate`. */
  locateUnderLock?: LogLocation | null;
  pending: readonly string[] | Error;
}

const coded = (code: string) =>
  Object.assign(new Error(`connect ${code} db.interno.invalid:5432 rol_sintetico`), { code });

/** La espera sobre lecturas falsas y `locks`, con el reloj manual, sin empezar a correr. */
function waitHarness(locks: readonly LockAnswer[] = []) {
  const clock = new ManualClock(START);
  const timeline: string[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const provider = new FakeLockProvider(locks, timeline);
  const state: ReadsState = { locate: logLocation(1), pending: [] };
  const signal: { handler: (() => void) | null; listening: boolean } = {
    handler: null,
    listening: false,
  };
  let result: StartupWaitResult | null = null;
  let rejection: unknown = null;
  const run = () => {
    const promise = waitForProductionStart({
      alert: (payload) => alerts.push(payload),
      lock: provider,
      now: clock.now,
      reads: {
        locateLog: () => {
          timeline.push('locate');
          const held = provider.locks.some((lock) => lock.held && !lock.released);
          if (held && state.locateUnderLock !== undefined) {
            return Promise.resolve(state.locateUnderLock);
          }
          return state.locate instanceof Error
            ? Promise.reject(state.locate)
            : Promise.resolve(state.locate);
        },
        pendingMigrations: (log) => {
          timeline.push(`pending:${String(log.number)}`);
          return state.pending instanceof Error
            ? Promise.reject(state.pending)
            : Promise.resolve(state.pending);
        },
      },
      scheduler: clock.scheduler,
      signals: (handler) => {
        signal.handler = handler;
        signal.listening = true;
        return () => {
          signal.listening = false;
        };
      },
    }).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        rejection = error;
      },
    );
    return promise;
  };
  return {
    alerts,
    clock,
    provider,
    raise: () => {
      signal.handler?.();
    },
    result: () => result,
    rejection: () => rejection,
    run,
    signal,
    state,
    timeline,
  };
}

describe('waitForProductionStart: lo que espera, en orden (ADR-0018 §4)', () => {
  it('la credencial, el log preparado y sus migraciones cada 30 s, y el bloqueo cada segundo; con todo, lista con el log y el bloqueo', async () => {
    expect(STARTUP_WAIT_REASONS).toEqual([
      'postgres_unavailable',
      'log_not_prepared',
      'migrations_pending',
      'source_lock_taken',
    ]);
    const wait = waitHarness(['taken', 'taken', 'lock']);
    wait.state.locate = coded('ECONNREFUSED');
    void wait.run();
    await settle();
    expect(wait.timeline).toEqual(['locate']);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);

    // PostgreSQL acepta la credencial, pero no hay log preparado.
    wait.state.locate = null;
    await wait.clock.advance(STARTUP_RETRY_MS - 1);
    expect(wait.timeline).toEqual(['locate']);
    await wait.clock.advance(1);
    expect(wait.timeline).toEqual(['locate', 'locate']);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);

    // El log 1, con una migración que falta.
    wait.state.locate = logLocation(1);
    wait.state.pending = ['0006_sintetica.sql'];
    await wait.clock.advance(STARTUP_RETRY_MS);
    expect(wait.timeline.slice(2)).toEqual(['locate', 'pending:1']);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);

    // Con las migraciones, el bloqueo, que tiene otro proceso: solo él, cada segundo.
    wait.state.pending = [];
    await wait.clock.advance(STARTUP_RETRY_MS);
    expect(wait.timeline.slice(4)).toEqual(['locate', 'pending:1', 'acquire:taken']);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_LOCK_RETRY_MS]);
    await wait.clock.advance(STARTUP_LOCK_RETRY_MS - 1);
    expect(wait.timeline).toHaveLength(7);
    await wait.clock.advance(1);
    expect(wait.timeline.slice(7)).toEqual(['acquire:taken']);
    await wait.clock.advance(STARTUP_LOCK_RETRY_MS);
    // Con el bloqueo, vuelve a buscar el log activo, que sigue siendo el 1.
    expect(wait.timeline.slice(8)).toEqual(['acquire:1', 'locate']);

    expect(wait.result()).toEqual({
      lock: wait.provider.lock(1),
      log: logLocation(1),
      status: 'ready',
    });
    expect(wait.provider.lock(1).held).toBe(true);
    expect(wait.provider.lock(1).released).toBe(false);
    expect(wait.clock.pendingDelays()).toEqual([]);
    expect(wait.signal.listening).toBe(false);
    expect(wait.alerts).toEqual([
      { detail: 'ECONNREFUSED', event: 'ingest_waiting', reason: 'postgres_unavailable' },
      { detail: null, event: 'ingest_waiting', reason: 'log_not_prepared' },
      { detail: '0006_sintetica.sql', event: 'ingest_waiting', reason: 'migrations_pending' },
      { detail: null, event: 'ingest_waiting', reason: 'source_lock_taken' },
    ]);
  });

  it('si PostgreSQL no responde al leer las migraciones o al tomar el bloqueo, postgres_unavailable con el código, y a los 30 s empieza otra vez por la credencial', async () => {
    const wait = waitHarness(['unavailable', 'lock']);
    wait.state.pending = coded('57P01');
    void wait.run();
    await settle();
    expect(wait.timeline).toEqual(['locate', 'pending:1']);
    wait.state.pending = [];
    await wait.clock.advance(STARTUP_RETRY_MS);
    expect(wait.timeline.slice(2)).toEqual(['locate', 'pending:1', 'acquire:unavailable']);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);
    await wait.clock.advance(STARTUP_RETRY_MS);
    expect(wait.timeline.slice(5)).toEqual(['locate', 'pending:1', 'acquire:1', 'locate']);
    expect(wait.result()).toMatchObject({ status: 'ready' });
    // Un solo aviso: el motivo no cambió y no pasó un minuto. Nunca el mensaje del error.
    expect(wait.alerts).toEqual([
      { detail: '57P01', event: 'ingest_waiting', reason: 'postgres_unavailable' },
    ]);
    expect(JSON.stringify(wait.alerts)).not.toMatch(/db\.interno|rol_sintetico|connect/u);
  });

  it('si el log activo cambió mientras esperaba el bloqueo, lo suelta y, al segundo, lo vuelve a mirar todo con el log nuevo', async () => {
    const wait = waitHarness(['lock', 'lock']);
    wait.state.locateUnderLock = logLocation(2);
    void wait.run();
    await settle();
    expect(wait.timeline).toEqual(['locate', 'pending:1', 'acquire:1', 'locate', 'release:1']);
    expect(wait.result()).toBeNull();
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_LOCK_RETRY_MS]);
    // El escritor anterior pasó al log 2: ahora la primera lectura también lo da.
    wait.state.locate = logLocation(2);
    await wait.clock.advance(STARTUP_LOCK_RETRY_MS);
    expect(wait.clock.pendingDelays()).toEqual([]);
    expect(wait.timeline.slice(5)).toEqual(['locate', 'pending:2', 'acquire:2', 'locate']);
    expect(wait.result()).toEqual({
      lock: wait.provider.lock(2),
      log: logLocation(2),
      status: 'ready',
    });
    expect(wait.alerts).toEqual([]);
  });

  it('un bloqueo que se perdió antes de terminar la espera se suelta: postgres_unavailable con source_lock_lost, y a los 30 s otra vez', async () => {
    const wait = waitHarness(['lost', 'lock']);
    void wait.run();
    await settle();
    expect(wait.timeline).toEqual(['locate', 'pending:1', 'acquire:1', 'locate', 'release:1']);
    expect(wait.alerts).toEqual([
      { detail: 'source_lock_lost', event: 'ingest_waiting', reason: 'postgres_unavailable' },
    ]);
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);
    await wait.clock.advance(STARTUP_RETRY_MS);
    expect(wait.result()).toEqual({
      lock: wait.provider.lock(2),
      log: logLocation(1),
      status: 'ready',
    });
  });

  it('un rechazo de acquire que no es de PostgreSQL es un error de programación: la espera se rechaza con él y deja de escuchar', async () => {
    const wait = waitHarness(['bug']);
    void wait.run();
    await settle();
    expect(wait.rejection()).toBe(LOCK_BUG);
    expect(wait.clock.pendingDelays()).toEqual([]);
    expect(wait.signal.listening).toBe(false);
  });
});

describe('waitForProductionStart: la alerta ingest_waiting', () => {
  it('al empezar a esperar, cuando cambia el motivo y, mientras no cambia, cada minuto', async () => {
    expect(STARTUP_ALERT_INTERVAL_MS).toBe(60_000);
    const wait = waitHarness(Array<LockAnswer>(125).fill('taken'));
    void wait.run();
    await settle();
    const lockAlerts = () =>
      wait.alerts.filter((alert) => alert['reason'] === 'source_lock_taken').length;
    expect(lockAlerts()).toBe(1);
    await wait.clock.advance(STARTUP_ALERT_INTERVAL_MS - STARTUP_LOCK_RETRY_MS);
    expect(lockAlerts()).toBe(1);
    await wait.clock.advance(STARTUP_LOCK_RETRY_MS);
    expect(lockAlerts()).toBe(2);
    await wait.clock.advance(STARTUP_ALERT_INTERVAL_MS);
    expect(lockAlerts()).toBe(3);
    expect(wait.timeline.filter((entry) => entry === 'acquire:taken')).toHaveLength(121);
  });

  it('un reloj que retrocede no la calla', async () => {
    const wait = waitHarness(Array<LockAnswer>(10).fill('taken'));
    void wait.run();
    await settle();
    expect(wait.alerts).toHaveLength(1);
    wait.clock.jumpWallClock(-10 * 60_000);
    await wait.clock.advance(STARTUP_LOCK_RETRY_MS);
    expect(wait.alerts).toHaveLength(2);
  });
});

describe('waitForProductionStart: la parada', () => {
  it('una señal durante una pausa la para enseguida, sin dejar ninguna pausa pendiente ni tomar el bloqueo', async () => {
    const wait = waitHarness();
    wait.state.locate = null;
    void wait.run();
    await settle();
    expect(wait.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);
    wait.raise();
    await settle();
    expect(wait.result()).toEqual({ status: 'stopped', waiting: 'log_not_prepared' });
    expect(wait.clock.pendingDelays()).toEqual([]);
    expect(wait.timeline).toEqual(['locate']);
    expect(wait.signal.listening).toBe(false);
  });

  it('una señal mientras lee termina esa comprobación y la para antes de tomar el bloqueo, con waiting null si todavía no esperaba nada', async () => {
    const wait = waitHarness(['lock']);
    const done = wait.run();
    // La primera lectura ya empezó y todavía no contestó.
    wait.raise();
    await done;
    expect(wait.result()).toEqual({ status: 'stopped', waiting: null });
    expect(wait.timeline).toEqual(['locate', 'pending:1']);
    expect(wait.provider.locks).toEqual([]);
  });

  it('una señal mientras busca el log con el bloqueo tomado suelta el bloqueo y la para', async () => {
    const wait = waitHarness(['lock']);
    void wait.run();
    // La señal llega cuando ya tomó el bloqueo: antes de que termine la lectura con él.
    wait.provider.onAcquire = () => {
      queueMicrotask(() => {
        wait.raise();
      });
    };
    await settle();
    expect(wait.timeline).toEqual(['locate', 'pending:1', 'acquire:1', 'locate', 'release:1']);
    expect(wait.result()).toEqual({ status: 'stopped', waiting: null });
  });
});

describe('HandedOverLockProvider', () => {
  it('el primer acquire da el bloqueo de la espera y los siguientes, los del proveedor', async () => {
    const timeline: string[] = [];
    const next = new FakeLockProvider(['taken'], timeline);
    const held = await new FakeLockProvider([], timeline).acquire();
    if (held === null) {
      throw new TypeError('Falta el bloqueo.');
    }
    const provider = new HandedOverLockProvider(held, next);
    expect(await provider.acquire()).toBe(held);
    expect(await provider.acquire()).toBeNull();
    expect(timeline).toEqual(['acquire:1', 'acquire:taken']);
    await provider.releaseUnused();
    expect(timeline).toEqual(['acquire:1', 'acquire:taken']);
  });

  it('releaseUnused suelta el bloqueo de la espera si nadie lo pidió, una sola vez', async () => {
    const timeline: string[] = [];
    const held = await new FakeLockProvider([], timeline).acquire();
    if (held === null) {
      throw new TypeError('Falta el bloqueo.');
    }
    const provider = new HandedOverLockProvider(held, new FakeLockProvider([], timeline));
    await provider.releaseUnused();
    await provider.releaseUnused();
    expect(timeline).toEqual(['acquire:1', 'release:1']);
  });
});
