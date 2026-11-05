import type { SourceEvent } from '@buoh/contracts';
import { emptyLiveDerivationState, foldLiveDerivation, liveDerivationView } from '@buoh/domain';

import {
  assembleChartWindow,
  chartItemsOf,
  type ChartWindow,
} from '../../src/source-log/chart-window.js';
import type { SourceEventLog } from '../../src/source-log/source-event-log.js';
import {
  A,
  at,
  B,
  C,
  close,
  open,
  ping,
  recovery,
  T0,
  tick,
} from '../../../../packages/domain/test/support/live-corpus.js';
import { eventsOf, measurement, SYMBOL } from './live-corpus.js';

// La captura sintética de las pruebas del gráfico (ADR-0019 §8), con el perfil de medición del
// corpus del dominio: fuente `synthetic`, símbolo `SYNTH_100` y ningún precio de mercado. La usan las
// pruebas en memoria (`test/chart-window.test.ts`) y las de PostgreSQL y S3-compatible
// (`integration/chart-window.test.ts`).

export const D = '019b76da-a800-7000-8000-00000000d000';
export const E = '019b76da-a800-7000-8000-00000000e000';

/** Una hora de fuente en milisegundos desde la época. */
export const ms = (epoch: number, milliseconds = 0) => epoch * 1000 + milliseconds;

/** El principio de una ventana sin nada antes. */
export const NO_START = { stopped: false, watermark_ms: null } as const;

/** Ticks cada 2 s, de `from` a `to` incluidos, con cotizaciones que cambian. */
export function ticksBetween(
  stimuli: unknown[],
  connection: string,
  from: number,
  to: number,
): void {
  for (let epoch = from; epoch <= to; epoch += 2) {
    const quote = (100 + ((epoch - T0) % 7) / 8).toFixed(3);
    stimuli.push(tick(stimuli.length + 1, connection, epoch, { quote }));
  }
}

/**
 * Unos 40 minutos de captura con todo lo que marca un hueco: una parada pedida de 5 minutos, una
 * conexión perdida que la historia recupera, otra que deja un hueco sin resolver y una última que
 * sigue sin conexión al final.
 */
export function captureStimuli(): unknown[] {
  const stimuli: unknown[] = [];
  const next = () => stimuli.length + 1;
  stimuli.push(open(next(), A, null, at(T0 - 1)));
  ticksBetween(stimuli, A, T0, T0 + 598);
  stimuli.push(close(next(), A, at(T0 + 599), 'requested'));
  stimuli.push(open(next(), B, A, at(T0 + 900)));
  // La suscripción repite el último tick.
  stimuli.push(tick(next(), B, T0 + 598, { quote: (100 + (598 % 7) / 8).toFixed(3) }));
  ticksBetween(stimuli, B, T0 + 902, T0 + 1200);
  stimuli.push(close(next(), B, at(T0 + 1201), 'timeout'));
  stimuli.push(open(next(), C, B, at(T0 + 1203)));
  ticksBetween(stimuli, C, T0 + 1206, T0 + 1208);
  stimuli.push(
    recovery(
      next(),
      { from: at(T0 + 1200, 1), to: at(T0 + 1205, 999) },
      { recovered_event_count: 2, status: 'complete' },
      at(T0 + 1209),
      C,
    ),
  );
  ticksBetween(stimuli, C, T0 + 1210, T0 + 1800);
  stimuli.push(close(next(), C, at(T0 + 1801), 'repaired'));
  stimuli.push(open(next(), D, C, at(T0 + 1805)));
  ticksBetween(stimuli, D, T0 + 1810, T0 + 1812);
  stimuli.push(
    recovery(
      next(),
      { from: at(T0 + 1800, 1), to: at(T0 + 1809, 999) },
      { reason: 'history_page_limit', recovered_event_count: 3, status: 'partial' },
      at(T0 + 1813),
      D,
    ),
  );
  ticksBetween(stimuli, D, T0 + 1814, T0 + 2400);
  stimuli.push(close(next(), D, at(T0 + 2401), 'timeout'));
  return stimuli;
}

/** Los source events de `captureStimuli`. */
export function captureEvents(): SourceEvent[] {
  return eventsOf(captureStimuli(), measurement);
}

/**
 * La misma captura, que vuelve a conectar después de la última conexión perdida y sigue unos 3
 * minutos más, sin que llegue la historia: el hueco pendiente ya tiene fin.
 */
export function reconnectedEvents(): SourceEvent[] {
  const stimuli = captureStimuli();
  stimuli.push(open(stimuli.length + 1, E, D, at(T0 + 2405)));
  ticksBetween(stimuli, E, T0 + 2410, T0 + 2600);
  return eventsOf(stimuli, measurement);
}

/**
 * Dos paradas pedidas: la primera termina con los ticks de una conexión nueva, y tras la segunda la
 * conexión nueva solo trae pongs durante más de 6 minutos, hasta los ticks de T0 + 800.
 */
export function twoStopsEvents(): SourceEvent[] {
  const stimuli: unknown[] = [open(1, A, null, at(T0 - 1))];
  ticksBetween(stimuli, A, T0, T0 + 100);
  stimuli.push(close(stimuli.length + 1, A, at(T0 + 101), 'requested'));
  stimuli.push(open(stimuli.length + 1, B, A, at(T0 + 200)));
  ticksBetween(stimuli, B, T0 + 202, T0 + 300);
  stimuli.push(close(stimuli.length + 1, B, at(T0 + 301), 'requested'));
  stimuli.push(open(stimuli.length + 1, C, B, at(T0 + 310)));
  for (let epoch = T0 + 311; epoch <= T0 + 700; epoch += 2) {
    stimuli.push(ping(stimuli.length + 1, C, at(epoch)));
  }
  ticksBetween(stimuli, C, T0 + 800, T0 + 900);
  return eventsOf(stimuli, measurement);
}

/**
 * Escribe los eventos en el log con un segmento cerrado cada 60 eventos y después de cada cierre
 * pedido, como en la parada de `ingest`.
 */
export async function writeCapture(
  log: SourceEventLog,
  events: readonly SourceEvent[],
): Promise<void> {
  let inSegment = 0;
  for (const event of events) {
    await log.append(event);
    inSegment += 1;
    const requested = event.kind === 'connection_closed' && event.closure_type === 'requested';
    if (inSegment === 60 || requested) {
      await log.close(requested ? 'requested' : 'window');
      inSegment = 0;
    }
  }
}

/** Lo que el log entero da para la ventana: todo desde el principio, sin puntos de control. */
export function wholeLogChart(
  events: readonly SourceEvent[],
  from: number,
  to: number,
): ChartWindow {
  const state = foldLiveDerivation(emptyLiveDerivationState(), events, measurement);
  return assembleChartWindow({
    from_ms: from,
    items: chartItemsOf(events, measurement, SYMBOL),
    pending: liveDerivationView(state)
      .pendingGaps.filter((item) => item.symbol === SYMBOL)
      .map((item) => ({
        from_ms: Date.parse(item.from_event_time_utc),
        to_ms: item.to_event_time_utc === null ? null : Date.parse(item.to_event_time_utc),
      })),
    start: NO_START,
    to_ms: to,
  });
}
