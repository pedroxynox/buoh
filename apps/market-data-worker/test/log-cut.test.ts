import { type LiveDerivationView } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import {
  cutTimeOf,
  isCleanForCut,
  locateCaptureLog,
  LockRetention,
  LOG_CUT_ALERT_INTERVAL_MS,
  LOG_CUT_CHECK_MS,
  LOG_CUT_FORCE_AFTER_MS,
  LogCutWatch,
  logLocation,
  type LogCutDecision,
  type LogCutReads,
  type LogLocation,
  type OperationalAlert,
} from '../src/index.js';
import { type SessionLock } from '../src/deriv/session.js';
import { settle } from './support/connection-harness.js';
import { ManualClock } from './support/deriv-fixtures.js';

// El corte semanal de los logs de producción (ADR-0018 §6) sin red ni servicios: lecturas y sesión
// falsas, reloj y temporizador manuales. Las horas son las de los vectores de la ADR.

/** Un lunes a las 10:00 UTC: la primera escritura de la mayoría de las pruebas. */
const MONDAY = '2026-03-02T10:00:00.000Z';
/** Su hora de corte: el lunes siguiente a las 00:00 UTC. */
const CUT = '2026-03-09T00:00:00.000Z';
const CUT_MS = Date.parse(CUT);

describe('cutTimeOf: el primer lunes a las 00:00 UTC posterior a la primera escritura (ADR-0018 §6)', () => {
  it.each([
    // El log 1 de producción: su primer latido fue el domingo 2026-11-01 a las 00:06:06.087 UTC.
    ['un domingo', '2026-11-01T00:06:06.087Z', '2026-11-02T00:00:00.000Z'],
    ['un domingo a las 23:59:59.999', '2026-03-08T23:59:59.999Z', CUT],
    ['un lunes a las 10:00', MONDAY, CUT],
    ['un lunes justo a las 00:00:00.000', '2026-03-02T00:00:00.000Z', CUT],
    ['un lunes a las 00:00:00.001', '2026-03-02T00:00:00.001Z', CUT],
    ['un sábado', '2026-03-07T12:00:00.000Z', CUT],
    ['un jueves al final del año', '2026-12-31T23:00:00.000Z', '2027-01-04T00:00:00.000Z'],
  ])('con una escritura %s', (_label, firstWrite, expected) => {
    expect(cutTimeOf(firstWrite)).toBe(expected);
  });

  it('rechaza una hora que no es válida', () => {
    expect(() => cutTimeOf('no-es-una-hora')).toThrow(TypeError);
  });
});

/** Un estado vivo con solo lo que mira el corte. */
function view(
  fields: Partial<
    Pick<LiveDerivationView, 'connectedInLog' | 'openConditionTypes' | 'pendingContinuitySymbols'>
  > = {},
): LiveDerivationView {
  return {
    connectedInLog: fields.connectedInLog ?? true,
    gapQuotes: [],
    lastConnectionEventTimeUtc: null,
    lastEventConnectionId: null,
    lastEventTimeUtc: null,
    lastRaw: null,
    openConditions: [],
    openConditionTypes: fields.openConditionTypes ?? [],
    pendingContinuitySymbols: fields.pendingContinuitySymbols ?? [],
    pendingGaps: [],
    previousConnection: null,
    symbolNotAllowedSeen: false,
    watermarks: [],
  };
}

describe('isCleanForCut: el log limpio (ADR-0018 §6)', () => {
  it('conectado, sin continuidad pendiente y sin connection_lost abierta', () => {
    expect(isCleanForCut(view())).toBe(true);
  });

  it('una event_gap_unresolved abierta no lo impide', () => {
    expect(isCleanForCut(view({ openConditionTypes: ['event_gap_unresolved'] }))).toBe(true);
  });

  it.each<[string, Parameters<typeof view>[0]]>([
    ['sin conexión', { connectedInLog: false }],
    ['con una continuidad pendiente', { pendingContinuitySymbols: ['SYNTH_100'] }],
    ['con connection_lost abierta', { openConditionTypes: ['connection_lost'] }],
    [
      'con connection_lost y event_gap_unresolved abiertas',
      { openConditionTypes: ['connection_lost', 'event_gap_unresolved'] },
    ],
  ])('no está limpio %s', (_label, fields) => {
    expect(isCleanForCut(view(fields))).toBe(false);
  });
});

/** Lecturas falsas: el log activo, la primera escritura de cada log y los preparados. */
function fakeReads(
  state: {
    active?: LogLocation | null;
    fail?: Error;
    firstWrites?: Map<number, string>;
    /** Los logs a los que solo les faltan migraciones. */
    pending?: Set<number>;
    prepared?: Set<number>;
  } = {},
) {
  const calls: string[] = [];
  const answer = <T>(value: () => T): Promise<T> =>
    state.fail === undefined ? Promise.resolve(value()) : Promise.reject(state.fail);
  const reads: LogCutReads = {
    firstWrite: (log) => {
      calls.push(`first:${String(log.number)}`);
      return answer(() => state.firstWrites?.get(log.number) ?? null);
    },
    readiness: (log) => {
      calls.push(`prepared:${String(log.number)}`);
      return answer(() =>
        state.prepared?.has(log.number) === true
          ? 'ready'
          : state.pending?.has(log.number) === true
            ? 'migrations_pending'
            : 'not_prepared',
      );
    },
    locateLog: () => {
      calls.push('locate');
      return answer(() => (state.active === undefined ? logLocation(2) : state.active));
    },
  };
  return { calls, reads, state };
}

describe('locateCaptureLog: el log en el que captura ingest en production (ADR-0018 §6, «Al arrancar»)', () => {
  const at = (iso: string) => () => iso;

  it('sin log activo, ninguno', async () => {
    const { reads } = fakeReads({ active: null });
    expect(await locateCaptureLog(reads, { after: null, now: at(MONDAY) })).toBeNull();
  });

  it('el activo sin escrituras, o con su hora de corte por llegar o pasada hace menos de 24 horas: ese log, que la sesión retoma', async () => {
    const { calls, reads } = fakeReads({ prepared: new Set([3]) });
    expect(await locateCaptureLog(reads, { after: null, now: at(MONDAY) })).toEqual({
      log: logLocation(2),
      skipped: null,
    });
    expect(calls).toEqual(['locate', 'first:2']);

    const written = fakeReads({
      firstWrites: new Map([[2, MONDAY]]),
      prepared: new Set([3]),
    });
    for (const now of [MONDAY, CUT, new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS - 1).toISOString()]) {
      expect(await locateCaptureLog(written.reads, { after: null, now: at(now) })).toEqual({
        log: logLocation(2),
        skipped: null,
      });
    }
    expect(written.calls.filter((call) => call.startsWith('prepared:'))).toEqual([]);
  });

  it('a las 24 horas de la hora de corte, el siguiente si está preparado, saltando el activo; si no, ninguno (log_not_prepared)', async () => {
    const forced = new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS).toISOString();
    const prepared = fakeReads({ firstWrites: new Map([[2, MONDAY]]), prepared: new Set([3]) });
    expect(await locateCaptureLog(prepared.reads, { after: null, now: at(forced) })).toEqual({
      log: logLocation(3),
      skipped: logLocation(2),
    });

    const missing = fakeReads({ firstWrites: new Map([[2, MONDAY]]) });
    expect(await locateCaptureLog(missing.reads, { after: null, now: at(forced) })).toBeNull();
    expect(missing.calls).toEqual(['locate', 'first:2', 'prepared:3']);
  });

  it('el log siguiente al que solo le faltan migraciones vale: la espera del arranque las espera con migrations_pending', async () => {
    const forced = new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS).toISOString();
    const { reads } = fakeReads({ firstWrites: new Map([[2, MONDAY]]), pending: new Set([3]) });
    expect(await locateCaptureLog(reads, { after: null, now: at(forced) })).toEqual({
      log: logLocation(3),
      skipped: logLocation(2),
    });
    expect(await locateCaptureLog(reads, { after: 2, now: at(MONDAY) })).toEqual({
      log: logLocation(3),
      skipped: null,
    });
  });

  it('después de un corte del mismo proceso, el log siguiente al cortado si está preparado, sin mirar su hora de corte', async () => {
    const { calls, reads } = fakeReads({ prepared: new Set([3]) });
    expect(await locateCaptureLog(reads, { after: 2, now: at(MONDAY) })).toEqual({
      log: logLocation(3),
      skipped: null,
    });
    expect(calls).toEqual(['locate', 'prepared:3']);

    const unprepared = fakeReads();
    expect(await locateCaptureLog(unprepared.reads, { after: 2, now: at(MONDAY) })).toBeNull();

    // Si el activo ya pasó del cortado, ese.
    const ahead = fakeReads({ active: logLocation(3) });
    expect(await locateCaptureLog(ahead.reads, { after: 2, now: at(MONDAY) })).toEqual({
      log: logLocation(3),
      skipped: null,
    });
  });

  it('si PostgreSQL no responde, rechaza con su error', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { reads } = fakeReads({ fail: error });
    await expect(locateCaptureLog(reads, { after: null, now: at(MONDAY) })).rejects.toBe(error);
  });
});

/** Una vigilancia del corte del log 2 con lecturas, sesión y reloj falsos. */
function watchHarness(
  options: {
    firstWrite?: string | null;
    prepared?: boolean;
    start?: string;
    view?: LiveDerivationView | null | Error;
  } = {},
) {
  const clock = new ManualClock(options.start ?? MONDAY);
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const decisions: LogCutDecision[] = [];
  const session = {
    reads: 0,
    /** Si la sesión sigue: la parada, por una señal o por el corte, lo pone en `false`. */
    running: true,
    stops: 0,
    view: options.view === undefined ? view() : options.view,
  };
  const fake = fakeReads({
    firstWrites:
      options.firstWrite === null
        ? new Map<number, string>()
        : new Map([[2, options.firstWrite ?? MONDAY]]),
    prepared: options.prepared === false ? new Set() : new Set([3]),
  });
  const watch = new LogCutWatch({
    alert: (payload) => alerts.push(payload),
    log: logLocation(2),
    now: clock.now,
    onCut: (decision) => decisions.push(decision),
    reads: fake.reads,
    scheduler: clock.scheduler,
    session: {
      liveView: () => {
        session.reads += 1;
        const current = session.view;
        return current instanceof Error ? Promise.reject(current) : Promise.resolve(current);
      },
      running: () => session.running,
      stop: () => {
        session.stops += 1;
        session.running = false;
      },
    },
  });
  /** Salta el reloj de pared a `iso`, sin vencer ningún temporizador. */
  const jumpTo = (iso: string) => {
    clock.jumpWallClock(Date.parse(iso) - Date.parse(clock.now()));
  };
  return { alerts, clock, decisions, fake, jumpTo, session, watch };
}

describe('LogCutWatch: la vigilancia del corte mientras la sesión captura (ADR-0018 §6)', () => {
  it('antes de la hora de corte solo mira el reloj, cada 30 s como mucho, sin leer el log ni el siguiente', async () => {
    const run = watchHarness();
    run.watch.start();
    await run.clock.advance(0);
    expect(run.fake.calls).toEqual(['first:2']);
    expect(run.clock.pendingDelays()).toEqual([LOG_CUT_CHECK_MS]);
    await run.clock.advance(LOG_CUT_CHECK_MS * 3);
    // La primera escritura se lee una vez: la hora de corte no cambia.
    expect(run.fake.calls).toEqual(['first:2']);
    expect(run.session.reads).toBe(0);
    expect(run.decisions).toEqual([]);
  });

  it('justo a la hora de corte, con el log limpio y el siguiente preparado, corta: log_cut, onCut y la parada de la sesión, una vez', async () => {
    const run = watchHarness();
    run.watch.start();
    await run.clock.advance(0);
    // El paso pendiente vence a los 30 s, con el reloj de pared 1 ms antes de la hora de corte.
    run.jumpTo(new Date(CUT_MS - 1 - LOG_CUT_CHECK_MS).toISOString());
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([]);
    // El paso siguiente cae justo en la hora de corte: 1 ms después.
    expect(run.clock.pendingDelays()).toEqual([1]);
    await run.clock.advance(1);

    const decision = { forced: false, log: logLocation(2), next: logLocation(3) };
    expect(run.decisions).toEqual([decision]);
    expect(run.watch.decision).toEqual(decision);
    expect(run.session.stops).toBe(1);
    expect(run.fake.calls).toEqual(['first:2', 'prepared:3']);
    expect(run.alerts).toEqual([{ event: 'log_cut', forced: 'false', log: '2', next: '3' }]);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('con una continuidad pendiente no corta; vuelve a mirar a los 30 s y corta en cuanto está limpio', async () => {
    const run = watchHarness({
      start: CUT,
      view: view({ pendingContinuitySymbols: ['SYNTH_100'] }),
    });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.decisions).toEqual([]);
    expect(run.clock.pendingDelays()).toEqual([LOG_CUT_CHECK_MS]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([]);

    run.session.view = view();
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([{ forced: false, log: logLocation(2), next: logLocation(3) }]);
    expect(run.session.reads).toBe(3);
  });

  it('una event_gap_unresolved abierta no lo impide', async () => {
    const run = watchHarness({
      start: CUT,
      view: view({ openConditionTypes: ['event_gap_unresolved'] }),
    });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.watch.decision).toMatchObject({ forced: false });
  });

  it.each<[string, LiveDerivationView | null]>([
    ['sin conexión', view({ connectedInLog: false })],
    ['con connection_lost abierta', view({ openConditionTypes: ['connection_lost'] })],
    ['si la sesión todavía no abrió su log', null],
  ])('%s no corta antes de las 24 horas', async (_label, current) => {
    const run = watchHarness({ start: CUT, view: current });
    run.watch.start();
    await run.clock.advance(0);
    await run.clock.advance(LOG_CUT_CHECK_MS * 4);
    expect(run.decisions).toEqual([]);
    expect(run.session.stops).toBe(0);
  });

  it('sin el log siguiente preparado no corta: sigue en el log, con log_cut_blocked una vez por minuto, sin leer el estado vivo; con él preparado, corta', async () => {
    const run = watchHarness({ prepared: false, start: CUT });
    run.watch.start();
    await run.clock.advance(0);
    const blocked = {
      event: 'log_cut_blocked',
      log: '2',
      next: '3',
      reason: 'next_log_not_prepared',
    };
    expect(run.alerts).toEqual([blocked]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.alerts).toEqual([blocked]);
    await run.clock.advance(LOG_CUT_ALERT_INTERVAL_MS - LOG_CUT_CHECK_MS);
    expect(run.alerts).toEqual([blocked, blocked]);
    expect(run.session.reads).toBe(0);
    expect(run.decisions).toEqual([]);

    run.fake.state.prepared = new Set([3]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([{ forced: false, log: logLocation(2), next: logLocation(3) }]);
  });

  it('a las 24 horas de la hora de corte, sin un momento limpio, corta igual: log_cut_forced con lo que quedó abierto', async () => {
    const run = watchHarness({
      start: CUT,
      view: view({
        connectedInLog: false,
        openConditionTypes: ['connection_lost', 'event_gap_unresolved'],
        pendingContinuitySymbols: ['SYNTH_100'],
      }),
    });
    run.watch.start();
    await run.clock.advance(0);
    // El paso pendiente vence a los 30 s, 10 ms antes de las 24 horas.
    run.jumpTo(new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS - 10 - LOG_CUT_CHECK_MS).toISOString());
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([]);
    // El paso siguiente cae justo en las 24 horas.
    expect(run.clock.pendingDelays()).toEqual([10]);
    await run.clock.advance(10);

    expect(run.decisions).toEqual([{ forced: true, log: logLocation(2), next: logLocation(3) }]);
    expect(run.session.stops).toBe(1);
    expect(run.alerts).toEqual([
      {
        event: 'log_cut_forced',
        log: '2',
        next: '3',
        open_condition_types: 'connection_lost,event_gap_unresolved',
        pending_continuity: 'true',
        reason: 'clean_moment_not_reached',
      },
      { event: 'log_cut', forced: 'true', log: '2', next: '3' },
    ]);
  });

  it('pasadas las 24 horas, sin el siguiente preparado espera; en cuanto lo está, corta sin esperar otro momento limpio', async () => {
    const run = watchHarness({
      prepared: false,
      start: new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS).toISOString(),
      view: view({ connectedInLog: false }),
    });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.alerts.map((alert) => alert['event'])).toEqual(['log_cut_blocked']);
    run.fake.state.prepared = new Set([3]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([{ forced: true, log: logLocation(2), next: logLocation(3) }]);
  });

  it('sin el estado vivo al forzar el corte, la alerta lo dice con null', async () => {
    const run = watchHarness({
      start: new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS).toISOString(),
      view: new Error('almacén sin respuesta'),
    });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.alerts[0]).toEqual({
      event: 'log_cut_forced',
      log: '2',
      next: '3',
      open_condition_types: null,
      pending_continuity: null,
      reason: 'clean_moment_not_reached',
    });
    expect(run.watch.decision).toMatchObject({ forced: true });
  });

  it('mientras el log no tiene ninguna escritura, vuelve a mirar cada 30 s; la hora de corte sale de la primera', async () => {
    const run = watchHarness({ firstWrite: null, start: '2026-03-08T23:59:00.000Z' });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.clock.pendingDelays()).toEqual([LOG_CUT_CHECK_MS]);
    // La primera escritura llega el domingo a las 23:59:10: la hora de corte es el lunes a las 00:00.
    run.fake.state.firstWrites = new Map([[2, '2026-03-08T23:59:10.000Z']]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.clock.pendingDelays()).toEqual([LOG_CUT_CHECK_MS]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([{ forced: false, log: logLocation(2), next: logLocation(3) }]);
    expect(run.fake.calls.filter((call) => call.startsWith('first:'))).toEqual([
      'first:2',
      'first:2',
    ]);
  });

  it('una lectura que falla deja log_cut_check_unavailable con el motivo saneado y vuelve a mirar a los 30 s', async () => {
    const run = watchHarness({ start: CUT });
    run.fake.state.fail = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    });
    run.watch.start();
    await run.clock.advance(0);
    expect(run.alerts).toEqual([
      { event: 'log_cut_check_unavailable', log: '2', reason: 'ECONNREFUSED' },
    ]);
    expect(run.clock.pendingDelays()).toEqual([LOG_CUT_CHECK_MS]);
    delete run.fake.state.fail;
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.watch.decision).toMatchObject({ forced: false });
    expect(JSON.stringify(run.alerts)).not.toContain('10.0.0.5');
  });

  it('con el log siguiente solo a falta de migraciones, log_cut_blocked dice next_log_migrations_pending; al cambiar el motivo avisa enseguida; con todo listo, corta', async () => {
    const run = watchHarness({ prepared: false, start: CUT });
    run.fake.state.pending = new Set([3]);
    run.watch.start();
    await run.clock.advance(0);
    const pending = {
      event: 'log_cut_blocked',
      log: '2',
      next: '3',
      reason: 'next_log_migrations_pending',
    };
    expect(run.alerts).toEqual([pending]);
    // El log siguiente deja de poder leerse: el motivo cambia y la alerta sale sin esperar el minuto.
    run.fake.state.pending = new Set();
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.alerts).toEqual([pending, { ...pending, reason: 'next_log_not_prepared' }]);
    run.fake.state.prepared = new Set([3]);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.decisions).toEqual([{ forced: false, log: logLocation(2), next: logLocation(3) }]);
  });

  it('si una señal para la sesión antes de decidir el corte, no corta ni deja alertas, tampoco a las 24 horas', async () => {
    for (const start of [CUT, new Date(CUT_MS + LOG_CUT_FORCE_AFTER_MS).toISOString()]) {
      const run = watchHarness({ start });
      run.watch.start();
      // La señal llega mientras se lee si el log siguiente está preparado: la sesión deja de seguir,
      // aunque el log esté limpio.
      const read = run.fake.reads.readiness.bind(run.fake.reads);
      run.fake.reads.readiness = async (log) => {
        const readiness = await read(log);
        run.session.running = false;
        return readiness;
      };
      await run.clock.advance(0);
      expect(run.decisions).toEqual([]);
      expect(run.alerts).toEqual([]);
      expect(run.session.stops).toBe(0);
    }
  });

  it('stop la detiene sin cortar, también con una lectura en curso', async () => {
    const run = watchHarness({ start: CUT });
    let answer: (value: boolean) => void = () => undefined;
    run.fake.reads.readiness = () =>
      new Promise((resolve) => {
        answer = (ready) => {
          resolve(ready ? 'ready' : 'not_prepared');
        };
      });
    run.watch.start();
    await run.clock.advance(0);
    run.watch.stop();
    answer(true);
    await settle();
    expect(run.decisions).toEqual([]);
    expect(run.session.stops).toBe(0);
    expect(run.clock.pendingDelays()).toEqual([]);
  });
});

/** Un bloqueo falso que anota cada `release`. */
function fakeLock(releases: string[], name: string, backendPid?: number) {
  let held = true;
  const lock: SessionLock & { lose(): void } = {
    ...(backendPid === undefined ? {} : { backendPid }),
    get held() {
      return held;
    },
    lose: () => {
      held = false;
    },
    release: () => {
      releases.push(name);
      held = false;
      return Promise.resolve();
    },
  };
  return lock;
}

describe('LockRetention: el bloqueo no se suelta en un corte (ADR-0018 §6, «Cortar»)', () => {
  it('fuera de un corte, suelta el bloqueo de la sesión', async () => {
    const releases: string[] = [];
    const retention = new LockRetention();
    await retention.release(fakeLock(releases, 'a', 4242));

    expect(releases).toEqual(['a']);
    expect(retention.takeRetained()).toBeNull();
  });

  it('con retain, guarda tomado el mismo bloqueo, sin soltarlo, y lo pasa una sola vez a quien lo pide', async () => {
    const releases: string[] = [];
    const lock = fakeLock(releases, 'a', 4242);
    const retention = new LockRetention();
    retention.retain();
    await retention.release(lock);

    expect(releases).toEqual([]);
    expect(retention.takeRetained()).toBe(lock);
    expect(retention.takeRetained()).toBeNull();
    expect(lock.held).toBe(true);
  });

  it('con retain, guarda uno solo: otro bloqueo que suelta la sesión después se suelta', async () => {
    const releases: string[] = [];
    const retention = new LockRetention();
    retention.retain();
    await retention.release(fakeLock(releases, 'a'));
    await retention.release(fakeLock(releases, 'b'));

    expect(releases).toEqual(['b']);
  });

  it('con retain, uno que ya se perdió se suelta: no hay nada que guardar', async () => {
    const releases: string[] = [];
    const lock = fakeLock(releases, 'a');
    const retention = new LockRetention();
    retention.retain();
    lock.lose();
    await retention.release(lock);

    expect(releases).toEqual(['a']);
    expect(retention.takeRetained()).toBeNull();
  });
});
