import { type MarketTick } from '@buoh/contracts';
import { type LiveDerivationView } from '@buoh/domain';

import { type OperationalAlert } from '../operational/registry.js';
import { LogIntegrityError, LogReadError } from '../source-log/source-event-log.js';
import { type HistoryRecoveryOutcome, type HistoryRecoveryRequest } from './history-recovery.js';
import { type Scheduler } from './ports.js';

/**
 * Espera entre el primer tick durable posterior al cierre y la petición de historia: la historia
 * puede no tener todavía el tick recién recibido (ADR-0015 §4, «Cuándo»).
 */
export const HISTORY_REQUEST_DELAY_MS = 2000;

/**
 * Lo que la vigilancia necesita del estado vivo del log (ADR-0017 §4): los huecos pendientes y la
 * cotización canónica de sus extremos.
 */
export type GapDerivation = Pick<LiveDerivationView, 'gapQuotes' | 'pendingGaps'>;

/**
 * Por qué la vigilancia no puede seguir: el log no se puede derivar (`log_not_derivable`: el
 * contenido no pasó sus comprobaciones al leerlo o el pliegue falló), o un error de programación
 * (`unexpected`).
 */
export interface GapWatchFailure {
  readonly error: unknown;
  readonly reason: 'log_not_derivable' | 'unexpected';
}

export interface GapWatchInput {
  /** Alerta saneada: un almacén que no responde al leer el log, o un extremo sin su tick. */
  readonly alert: OperationalAlert;
  /** La vigilancia no puede seguir: quien la sigue para la conexión. */
  readonly onFailure: (failure: GapWatchFailure) => void;
  /** Ya no queda recuperación pendiente en esta conexión. */
  readonly onSettled: () => void;
  /**
   * Lee el estado vivo del log durable desde su último punto de control válido, con el perfil de
   * medición (`readLiveState`). Toma su foto al llamarla, así que incluye todo lo que ya es durable
   * en ese momento. `null` si el log tuvo un fallo de persistencia: la conexión ya se cierra. Lanza
   * `LogReadError` si un almacén no responde y `LogIntegrityError` si el contenido no pasa sus
   * comprobaciones o no se pliega (`LogNotDerivableError`).
   */
  readonly read: () => Promise<GapDerivation | null>;
  /** Pide la historia por la conexión (`DerivConnection.recoverHistory`). */
  readonly recover: (request: HistoryRecoveryRequest) => Promise<HistoryRecoveryOutcome>;
  readonly scheduler: Scheduler;
  readonly symbol: string;
}

/** Un instante UTC con milisegundos, corrido `ms`. */
function shift(instantUtc: string, ms: number): string {
  return new Date(Date.parse(instantUtc) + ms).toISOString();
}

/**
 * Lo que dice el estado vivo del hueco pendiente del símbolo: no hay (`none`); hay, pero su fin
 * todavía no se conoce (`open`); o se conoce, y entonces el pedido con la cotización canónica de sus
 * dos extremos (`ready`), salvo que falte el tick de uno (`boundary_unavailable`). `watermark_utc`
 * es el high-watermark donde empieza el hueco: `from_event_time_utc` − 1 ms.
 */
export type GapState =
  | { readonly status: 'none' }
  | { readonly status: 'open'; readonly watermark_utc: string }
  | { readonly status: 'boundary_unavailable'; readonly watermark_utc: string }
  | {
      readonly request: HistoryRecoveryRequest;
      readonly status: 'ready';
      readonly watermark_utc: string;
    };

/**
 * El hueco del símbolo según el estado vivo (ADR-0015 §2 y ADR-0017 §4), sin repetir la lógica de
 * continuidad de las reglas. Los extremos son los ticks canónicos en from − 1 ms (el
 * high-watermark) y en to + 1 ms (el primer tick posterior al cierre); con varios en el mismo
 * instante, el primero en orden canónico (`gapQuotes`).
 */
export function gapState(derived: GapDerivation, symbol: string): GapState {
  const gap = derived.pendingGaps.find((item) => item.symbol === symbol);
  if (gap === undefined) {
    return { status: 'none' };
  }
  const watermark = shift(gap.from_event_time_utc, -1);
  if (gap.to_event_time_utc === null) {
    return { status: 'open', watermark_utc: watermark };
  }
  const quotes = derived.gapQuotes.find((item) => item.symbol === symbol);
  const startQuote = quotes?.start_quote ?? null;
  const endQuote = quotes?.end_quote ?? null;
  if (startQuote === null || endQuote === null) {
    return { status: 'boundary_unavailable', watermark_utc: watermark };
  }
  return {
    request: {
      end_quote: endQuote,
      from_event_time_utc: gap.from_event_time_utc,
      start_quote: startQuote,
      symbol,
      to_event_time_utc: gap.to_event_time_utc,
    },
    status: 'ready',
    watermark_utc: watermark,
  };
}

/**
 * Vigila el hueco pendiente del símbolo durante una conexión de la sesión y pide su historia por esa
 * conexión, una vez como mucho (ADR-0015 §4, «Cuándo»):
 *
 * 1. al empezar, lee el estado vivo del log. Sin hueco pendiente no hay nada que hacer; con él, anota
 *    el high-watermark donde empieza;
 * 2. con cada tick durable estrictamente posterior a ese high-watermark (`onTick`), lo vuelve a
 *    leer. Si el hueco ya tiene fin, pide su historia 2000 ms después; si no, porque ese tick no es
 *    posterior al high-watermark del último cierre, espera al siguiente. Un tick que llega mientras
 *    se lee y no entra en esa lectura se tiene en cuenta al terminarla;
 * 3. termina con el resultado de la recuperación.
 *
 * Si un almacén no responde al leer el log, avisa con `source_log_unavailable` y lo intenta con el
 * tick siguiente. Si el log tuvo un fallo de persistencia, termina sin pedir nada ni avisar: la
 * conexión ya se cierra, y el fallo ya quedó registrado. Si un extremo no tiene su tick, avisa con
 * `history_boundary_unavailable` y no pide nada. `cancel` la termina sin pedir nada más: la conexión
 * terminó o llegó la parada.
 */
export class GapWatch {
  readonly #input: GapWatchInput;
  /**
   * `deriving`: lee el estado vivo del log; `watching`: espera un tick posterior al
   * high-watermark; `waiting`: los 2000 ms antes de pedir la historia; `recovering`: la
   * recuperación corre. `done`: no queda nada pendiente. `ended`: terminó con el hueco todavía
   * pendiente.
   */
  #state: 'deriving' | 'done' | 'ended' | 'recovering' | 'waiting' | 'watching' = 'deriving';
  /** High-watermark donde empieza el hueco, o `null` si todavía no se leyó el log. */
  #watermark: string | null = null;
  /** El tick más reciente que llegó mientras se leía el log, o `null`. */
  #latest: string | null = null;
  #cancelDelay: (() => void) | null = null;

  constructor(input: GapWatchInput) {
    this.#input = input;
  }

  /**
   * Queda una recuperación pendiente en esta conexión: todavía se lee el log, se espera el primer
   * tick posterior al cierre o los 2000 ms, la recuperación corre, o terminó sin que su resultado
   * quedara en el log.
   */
  get pending(): boolean {
    return this.#state !== 'done';
  }

  /** Empieza: lee el estado vivo del log como está al empezar la conexión. */
  start(): void {
    this.#derive(null);
  }

  /** Un tick durable de la conexión: si es posterior al high-watermark, vuelve a leer el log. */
  onTick(tick: Pick<MarketTick, 'event_time_utc' | 'symbol'>): void {
    if (tick.symbol !== this.#input.symbol) {
      return;
    }
    const time = tick.event_time_utc;
    if (this.#state === 'deriving') {
      if (this.#latest === null || time > this.#latest) {
        this.#latest = time;
      }
      return;
    }
    if (this.#state === 'watching' && (this.#watermark === null || time > this.#watermark)) {
      this.#derive(time);
    }
  }

  /** Termina sin pedir nada más: cancela los 2000 ms, si corren. */
  cancel(): void {
    if (this.#state !== 'done') {
      this.#end('ended');
    }
  }

  /**
   * Lee el estado vivo del log. `after` es el tick que lo pidió, ya incluido en la lectura, o `null`
   * al empezar la conexión.
   */
  #derive(after: string | null): void {
    this.#state = 'deriving';
    this.#latest = null;
    this.#input
      .read()
      .then(
        (derived) => {
          this.#onRead(derived, after);
        },
        (error: unknown) => {
          this.#onReadFailure(error);
        },
      )
      .catch((error: unknown) => {
        this.#fail({ error, reason: 'unexpected' });
      });
  }

  #onRead(derived: GapDerivation | null, after: string | null): void {
    if (this.#state !== 'deriving') {
      return;
    }
    if (derived === null) {
      // El log falló: la conexión ya se cierra, y la siguiente recupera el hueco.
      this.#end('ended');
      return;
    }
    const gap = gapState(derived, this.#input.symbol);
    if (gap.status === 'none') {
      this.#settle();
      return;
    }
    const watermark = gap.watermark_utc;
    this.#watermark = watermark;
    // Solo pide la historia por un tick de esta conexión posterior al high-watermark, que la
    // lectura ya incluye: así la conexión está suscrita y el fin es el que dan las reglas.
    if (after === null || after <= watermark || gap.status === 'open') {
      const latest = this.#latest;
      if (latest !== null && latest > watermark) {
        this.#derive(latest);
      } else {
        this.#state = 'watching';
      }
      return;
    }
    if (gap.status === 'boundary_unavailable') {
      this.#input.alert({ event: 'history_boundary_unavailable', symbol: this.#input.symbol });
      this.#settle();
      return;
    }
    const { request } = gap;
    this.#state = 'waiting';
    this.#cancelDelay = this.#input.scheduler.schedule(HISTORY_REQUEST_DELAY_MS, () => {
      this.#cancelDelay = null;
      this.#recover(request);
    });
  }

  #onReadFailure(error: unknown): void {
    if (this.#state !== 'deriving') {
      return;
    }
    if (error instanceof LogReadError) {
      // Sin la lectura no se sabe el fin del hueco: como si no se conociera, con el tick siguiente.
      this.#input.alert({ event: 'source_log_unavailable', reason: error.reason });
      this.#state = 'watching';
      return;
    }
    this.#fail({
      error,
      reason: error instanceof LogIntegrityError ? 'log_not_derivable' : 'unexpected',
    });
  }

  #recover(request: HistoryRecoveryRequest): void {
    if (this.#state !== 'waiting') {
      return;
    }
    this.#state = 'recovering';
    let outcome: Promise<HistoryRecoveryOutcome>;
    try {
      outcome = this.#input.recover(request);
    } catch (error) {
      this.#fail({ error, reason: 'unexpected' });
      return;
    }
    outcome
      .then((result) => {
        if (this.#state !== 'recovering') {
          return;
        }
        // Con el resultado en el log, el hueco quedó decidido. Si no quedó durable o se abandonó, la
        // conexión ya se está cerrando, y la siguiente lo recupera.
        if (result.status === 'finished' && result.durable) {
          this.#settle();
        } else {
          this.#end('ended');
        }
      })
      .catch((error: unknown) => {
        this.#fail({ error, reason: 'unexpected' });
      });
  }

  #settle(): void {
    this.#end('done');
    this.#input.onSettled();
  }

  #fail(failure: GapWatchFailure): void {
    this.#end('ended');
    this.#input.onFailure(failure);
  }

  #end(state: 'done' | 'ended'): void {
    this.#state = state;
    this.#cancelDelay?.();
    this.#cancelDelay = null;
  }
}
