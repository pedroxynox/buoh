import { type PendingGap } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GapWatch,
  type GapDerivation,
  type GapWatchFailure,
  type GapWatchInput,
} from '../src/deriv/gap-watch.js';
import { type HistoryRecoveryRequest } from '../src/deriv/history-recovery.js';
import { LogIntegrityError, LogNotDerivableError } from '../src/source-log/source-event-log.js';
import { START } from './support/connection-harness.js';
import { flush, ManualClock } from './support/deriv-fixtures.js';
import { REQUEST } from './support/recovery-harness.js';

// El hueco pendiente durante una conexión de la sesión (ADR-0015 §4, «Cuándo»), con la lectura del
// estado vivo del log inyectada: los casos que un log derivado por las reglas no da, como un
// extremo del hueco sin su tick. Reloj y temporizador manuales; ningún precio es de mercado.

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
}

beforeEach(() => {
  forbidAmbientEffects();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** El hueco de `REQUEST`, ya con su fin. */
const GAP: PendingGap = {
  from_event_time_utc: REQUEST.from_event_time_utc,
  symbol: 'SYNTH_100',
  to_event_time_utc: REQUEST.to_event_time_utc,
};

/** El tick del high-watermark (S, from − 1 ms) y el primero posterior al cierre (E, to + 1 ms). */
const AT_START = {
  event_time_utc: '2026-03-02T09:59:00.000Z',
  quote_decimal: '100.25',
  symbol: 'SYNTH_100',
};
const AT_END = {
  event_time_utc: '2026-03-02T10:00:00.000Z',
  quote_decimal: '100.75',
  symbol: 'SYNTH_100',
};

/**
 * Lo que la vigilancia lee del estado vivo: el hueco de `REQUEST` con la cotización canónica de sus
 * dos extremos, la de S y la de E, salvo la que se dé como `null`.
 */
function gapView(
  quotes: { readonly end?: string | null; readonly start?: string | null } = {},
): GapDerivation {
  return {
    gapQuotes: [
      {
        end_quote: quotes.end === undefined ? AT_END.quote_decimal : quotes.end,
        start_quote: quotes.start === undefined ? AT_START.quote_decimal : quotes.start,
        symbol: 'SYNTH_100',
      },
    ],
    pendingGaps: [GAP],
  };
}

/** Un `GapWatch` de SYNTH_100 con un log que `read` describe; `recover` anota cada pedido. */
function watchHarness(
  read: GapWatchInput['read'],
  overrides: Partial<Pick<GapWatchInput, 'recover'>> = {},
) {
  const clock = new ManualClock(START);
  const alerts: Parameters<GapWatchInput['alert']>[0][] = [];
  const failures: GapWatchFailure[] = [];
  const requests: HistoryRecoveryRequest[] = [];
  let settled = 0;
  const watch = new GapWatch({
    alert: (payload) => alerts.push(payload),
    onFailure: (failure) => failures.push(failure),
    onSettled: () => {
      settled += 1;
    },
    read,
    recover:
      overrides.recover ??
      ((request) => {
        requests.push(request);
        return Promise.resolve({ status: 'abandoned' });
      }),
    scheduler: clock.scheduler,
    symbol: 'SYNTH_100',
  });
  return { alerts, clock, failures, requests, settled: () => settled, watch };
}

/** Empieza la vigilancia y entrega el tick de E, posterior al high-watermark. */
async function startAndTick(run: ReturnType<typeof watchHarness>): Promise<void> {
  run.watch.start();
  await flush();
  run.watch.onTick(AT_END);
  await flush();
}

describe('GapWatch: los extremos del hueco (ADR-0015 §4)', () => {
  it('con los dos extremos en el estado vivo, pide 2000 ms después el hueco con la cotización canónica de cada uno', async () => {
    const run = watchHarness(() => Promise.resolve(gapView()));
    await startAndTick(run);
    expect(run.clock.pendingDelays()).toEqual([2000]);
    await run.clock.advance(2000);

    expect(run.requests).toEqual([REQUEST]);
    expect(run.alerts).toEqual([]);
  });

  it.each<[string, GapDerivation]>([
    ['el del high-watermark', gapView({ start: null })],
    ['el primero posterior al cierre', gapView({ end: null })],
    ['los dos, sin cotizaciones del símbolo', { gapQuotes: [], pendingGaps: [GAP] }],
  ])(
    'si falta el tick de un extremo, %s, no pide la historia: avisa una vez con history_boundary_unavailable y no deja nada pendiente',
    async (_label, derived) => {
      const run = watchHarness(() => Promise.resolve(derived));
      await startAndTick(run);
      run.watch.onTick({ ...AT_END, event_time_utc: '2026-03-02T10:00:02.000Z' });
      await run.clock.advance(10_000);

      expect(run.requests).toEqual([]);
      expect(run.alerts).toEqual([{ event: 'history_boundary_unavailable', symbol: 'SYNTH_100' }]);
      expect(run.watch.pending).toBe(false);
      expect(run.settled()).toBe(1);
      expect(run.failures).toEqual([]);
      expect(run.clock.pendingDelays()).toEqual([]);
    },
  );
});

describe('GapWatch: errores', () => {
  it('si el pliegue falla, el log no se puede derivar (LogNotDerivableError): lo entrega como log_not_derivable, sin pedir la historia', async () => {
    const error = new LogNotDerivableError(new TypeError('La conexión se cerró dos veces.'));
    const run = watchHarness(() => Promise.reject(error));
    run.watch.start();
    await flush();

    expect(run.failures).toEqual([{ error, reason: 'log_not_derivable' }]);
    run.watch.onTick(AT_END);
    await run.clock.advance(10_000);
    expect(run.requests).toEqual([]);
  });

  it.each<[string, GapWatchFailure['reason'], Error]>([
    [
      'un contenido que no pasa sus comprobaciones',
      'log_not_derivable',
      new LogIntegrityError('sintético'),
    ],
    ['un error de programación', 'unexpected', new TypeError('sintético')],
  ])('si la lectura del log falla con %s, lo entrega como %s', async (_label, reason, error) => {
    const run = watchHarness(() => Promise.reject(error));
    run.watch.start();
    await flush();

    expect(run.failures).toEqual([{ error, reason }]);
    expect(run.alerts).toEqual([]);
  });

  it('si la lectura dice que el log tuvo un fallo de persistencia (null), termina sin pedir la historia, sin avisar ni fallar, con la recuperación todavía pendiente', async () => {
    let reads = 0;
    // Al empezar, el log se lee; con el tick de E, ya falló.
    const run = watchHarness(() => Promise.resolve((reads += 1) === 1 ? gapView() : null));
    await startAndTick(run);
    run.watch.onTick({ ...AT_END, event_time_utc: '2026-03-02T10:00:02.000Z' });
    await run.clock.advance(10_000);

    expect(reads).toBe(2);
    expect(run.requests).toEqual([]);
    expect(run.alerts).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(run.settled()).toBe(0);
    // La conexión ya se cierra: la recuperación queda para la siguiente.
    expect(run.watch.pending).toBe(true);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si recoverHistory lanza, es un error de programación: lo entrega como unexpected', async () => {
    const error = new TypeError('La conexión ya tiene una recuperación de historia en curso.');
    const run = watchHarness(() => Promise.resolve(gapView()), {
      recover: () => {
        throw error;
      },
    });
    await startAndTick(run);
    await run.clock.advance(2000);

    expect(run.failures).toEqual([{ error, reason: 'unexpected' }]);
  });
});
