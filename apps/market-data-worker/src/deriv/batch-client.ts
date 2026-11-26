import type { ConnectionClosed } from '@buoh/contracts';

import type { FrameInput } from '../ingestion/raw-first-ingestor.js';
import { failureReason } from '../source-log/source-event-log.js';
import type { Scheduler } from './ports.js';
import type { BatchOperation } from './schema-release.js';
import type { DerivSocket, SocketFactory, SocketSignal } from './socket.js';

/**
 * El cliente de los lotes (ADR-0021 §3, «Ritmo con Deriv»; precisión del PR 5c1 de su §9): una
 * conexión al canal público de Deriv, sin cuenta, por la que pide sus peticiones de una en una. No
 * envía la siguiente hasta tener la respuesta de la anterior y hasta que pasa `pacingMs` desde el
 * envío anterior, también de otra conexión de la misma ejecución (`previousSentUtc`). Cada frame
 * que llega se escribe de forma durable antes de interpretarlo (`frame`, raw first; ADR-0004), y la
 * apertura y el cierre de la conexión, también (`opened` y `closed`), en ese orden.
 *
 * Para ante lo primero de esto, sin fallar, y lo dice en `stopped`: una respuesta con el error
 * `RateLimit` de Deriv (`rate_limit`), que no cuenta como respondida para que la ejecución
 * siguiente la vuelva a pedir; el plazo de la ejecución (`deadline`), que se mira antes de cada
 * envío; una respuesta que no llega en `requestTimeoutMs` (`request_timeout`); un cierre o un error
 * del socket (`disconnected`); un frame binario o mayor que el límite (`binary_frame` y
 * `frame_too_large`); demasiados frames esperando a escribirse (`queue_full`); o un fallo al
 * escribir (`persistence_failed`), después del cual no escribe nada más. Antes de abrirse, una
 * conexión que no se abre deja `connect_failed` o `connect_timeout`, sin escribir nada.
 */

type ClosureType = ConnectionClosed['closure_type'];

/** Una petición ya validada y codificada, con su `req_id`, único en la conexión. */
export interface BatchExchangeRequest {
  readonly operation: BatchOperation;
  readonly reqId: number;
  readonly text: string;
}

export type BatchStopReason =
  | 'binary_frame'
  | 'connect_failed'
  | 'connect_timeout'
  | 'deadline'
  | 'disconnected'
  | 'frame_too_large'
  | 'persistence_failed'
  | 'queue_full'
  | 'rate_limit'
  | 'request_timeout';

export interface BatchStop {
  /** Un código saneado o la operación de la petición, nunca un mensaje. */
  readonly detail: string | null;
  readonly reason: BatchStopReason;
}

export interface BatchExchangeInput {
  readonly closeTimeoutMs: number;
  /** Escribe el cierre de la conexión, después de escribir todo lo que llegó por ella. */
  readonly closed: (input: {
    readonly at_utc: string;
    readonly closure_type: ClosureType;
    readonly connection_id: string;
    readonly reason: string;
  }) => Promise<void>;
  readonly connect: SocketFactory;
  readonly connectTimeoutMs: number;
  /** La hora a partir de la cual no envía ninguna petición más. */
  readonly deadlineUtc: string;
  readonly endpoint: string;
  /** Escribe un frame recibido; lo interpreta solo después. */
  readonly frame: (frame: FrameInput) => Promise<void>;
  /** UUIDv7 de la conexión y de cada frame. */
  readonly nextId: () => string;
  readonly now: () => string;
  /** Escribe la apertura de la conexión, antes que cualquier frame suyo. */
  readonly opened: (input: {
    readonly at_utc: string;
    readonly connection_id: string;
  }) => Promise<void>;
  readonly pacingMs: number;
  /** El último envío de la ejecución, de otra conexión, o `null`. */
  readonly previousSentUtc: string | null;
  readonly requestTimeoutMs: number;
  readonly requests: readonly BatchExchangeRequest[];
  readonly scheduler: Scheduler;
}

export interface BatchExchangeResult {
  /** Las peticiones respondidas seguidas desde la primera: las que ya no hay que pedir. */
  readonly answered: number;
  /** La conexión, o `null` si no llegó a abrirse. */
  readonly connection_id: string | null;
  /** La hora del último envío, o la de `previousSentUtc` si no envió nada. */
  readonly last_sent_utc: string | null;
  readonly sent: number;
  readonly stopped: BatchStop | null;
}

/** Frames que esperan a escribirse, como mucho: con una petición a la vez no debería haber más de uno. */
export const BATCH_PENDING_FRAMES_LIMIT = 64;

/** El código de error de Deriv cuando se piden demasiadas peticiones seguidas (ADR-0021 §3). */
export const RATE_LIMIT = 'RateLimit';

type ExchangeEvent =
  | { readonly kind: 'answer'; readonly rateLimited: boolean; readonly reqId: number }
  | { readonly kind: 'binary' }
  | { readonly code: number; readonly kind: 'closed' }
  | { readonly code: string; readonly kind: 'error' }
  | { readonly kind: 'frame_too_large' }
  | { readonly kind: 'open' }
  | { readonly kind: 'persistence_failed'; readonly reason: string }
  | { readonly kind: 'queue_full' }
  | { readonly id: number; readonly kind: 'timer' };

/** `req_id` y `error.code` de una respuesta, sin depender de su forma; `null` si no es JSON. */
function controlOf(text: string): { readonly errorCode: unknown; readonly reqId: unknown } | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return null;
  }
  const record = root as Record<string, unknown>;
  const error = record['error'];
  return {
    errorCode:
      typeof error === 'object' && error !== null && !Array.isArray(error)
        ? (error as Record<string, unknown>)['code']
        : undefined,
    reqId: record['req_id'],
  };
}

class BatchExchange {
  readonly #input: BatchExchangeInput;
  readonly #events: ExchangeEvent[] = [];
  #wake: (() => void) | null = null;
  #timers = 0;
  #socket: DerivSocket | null = null;
  #connectionId: string | null = null;
  #closed = false;
  #writes: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #writeFailure: string | null = null;
  /** Las peticiones enviadas que esperan respuesta: como mucho una. */
  readonly #waiting = new Set<number>();

  constructor(input: BatchExchangeInput) {
    this.#input = input;
  }

  #push(event: ExchangeEvent): void {
    this.#events.push(event);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async #next(): Promise<ExchangeEvent> {
    for (;;) {
      const event = this.#events.shift();
      if (event !== undefined) {
        return event;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** Espera hasta que `decide` devuelve algo que no es `null`. */
  async #waitFor<T>(decide: (event: ExchangeEvent) => T | null): Promise<T> {
    for (;;) {
      const decided = decide(await this.#next());
      if (decided !== null) {
        return decided;
      }
    }
  }

  #timer(ms: number): { readonly cancel: () => void; readonly id: number } {
    this.#timers += 1;
    const id = this.#timers;
    const cancel = this.#input.scheduler.schedule(Math.max(0, ms), () => {
      this.#push({ id, kind: 'timer' });
    });
    return { cancel, id };
  }

  /** Escribe en orden, detrás de lo anterior; el primer fallo para todo lo que viene después. */
  #write(work: () => Promise<void>, after?: () => void): void {
    this.#writes = this.#writes.then(async () => {
      if (this.#writeFailure !== null) {
        return;
      }
      try {
        await work();
      } catch (error) {
        this.#writeFailure = failureReason(error);
        this.#push({ kind: 'persistence_failed', reason: this.#writeFailure });
        return;
      }
      after?.();
    });
  }

  #onSignal(signal: SocketSignal): void {
    switch (signal.kind) {
      case 'open': {
        const connectionId = this.#input.nextId();
        const at = this.#input.now();
        this.#connectionId = connectionId;
        this.#write(() => this.#input.opened({ at_utc: at, connection_id: connectionId }));
        this.#push({ kind: 'open' });
        return;
      }
      case 'text':
        this.#onText(signal.text);
        return;
      case 'binary':
        this.#push({ kind: 'binary' });
        return;
      case 'frame_too_large':
        this.#push({ kind: 'frame_too_large' });
        return;
      case 'error':
        this.#push({ code: signal.code, kind: 'error' });
        return;
      case 'closed':
        this.#closed = true;
        this.#push({ code: signal.code, kind: 'closed' });
        return;
    }
  }

  #onText(text: string): void {
    const connectionId = this.#connectionId;
    if (connectionId === null || this.#writeFailure !== null) {
      return;
    }
    if (this.#pendingWrites >= BATCH_PENDING_FRAMES_LIMIT) {
      this.#push({ kind: 'queue_full' });
      return;
    }
    this.#pendingWrites += 1;
    const frame: FrameInput = {
      connection_id: connectionId,
      observation_id: this.#input.nextId(),
      payload_utf8: text,
      received_at_utc: this.#input.now(),
    };
    this.#write(
      async () => {
        try {
          await this.#input.frame(frame);
        } finally {
          this.#pendingWrites -= 1;
        }
      },
      () => {
        // Solo un frame ya durable cuenta como respuesta (raw first).
        const control = controlOf(text);
        const reqId = control?.reqId;
        if (typeof reqId === 'number' && this.#waiting.has(reqId)) {
          this.#waiting.delete(reqId);
          this.#push({ kind: 'answer', rateLimited: control?.errorCode === RATE_LIMIT, reqId });
        }
      },
    );
  }

  /** Lo que para la conexión mientras espera, o `null` si el evento no la para. */
  #interruption(event: ExchangeEvent): BatchStop | null {
    switch (event.kind) {
      case 'closed':
        return { detail: `close_code_${String(event.code)}`, reason: 'disconnected' };
      case 'error':
        return { detail: event.code, reason: 'disconnected' };
      case 'binary':
        return { detail: null, reason: 'binary_frame' };
      case 'frame_too_large':
        return { detail: null, reason: 'frame_too_large' };
      case 'persistence_failed':
        return { detail: event.reason, reason: 'persistence_failed' };
      case 'queue_full':
        return { detail: null, reason: 'queue_full' };
      case 'answer':
      case 'open':
      case 'timer':
        return null;
    }
  }

  /** Cómo se cierra la conexión, y qué cierre se escribe, según por qué paró. */
  #closureOf(stop: BatchStop | null): {
    readonly closure_type: ClosureType;
    readonly reason: string;
    readonly terminate: boolean;
  } {
    if (stop === null) {
      return { closure_type: 'requested', reason: 'batch_completed', terminate: false };
    }
    switch (stop.reason) {
      case 'disconnected': {
        const transport =
          stop.detail === 'close_code_1006' || !stop.detail?.startsWith('close_code_');
        return {
          closure_type: transport ? 'transport_error' : 'remote',
          reason: stop.detail ?? 'disconnected',
          terminate: true,
        };
      }
      case 'request_timeout':
        return { closure_type: 'timeout', reason: 'request_timeout', terminate: true };
      case 'deadline':
      case 'rate_limit':
        return { closure_type: 'requested', reason: stop.reason, terminate: false };
      case 'binary_frame':
      case 'connect_failed':
      case 'connect_timeout':
      case 'frame_too_large':
      case 'persistence_failed':
      case 'queue_full':
        return { closure_type: 'requested', reason: stop.reason, terminate: true };
    }
  }

  async run(): Promise<BatchExchangeResult> {
    const input = this.#input;
    const socket = input.connect({
      onSignal: (signal) => {
        this.#onSignal(signal);
      },
      url: input.endpoint,
    });
    this.#socket = socket;
    const connectTimer = this.#timer(input.connectTimeoutMs);
    const notOpened = await this.#waitFor<BatchStop | 'open'>((event) => {
      switch (event.kind) {
        case 'open':
          return 'open';
        case 'timer':
          return event.id === connectTimer.id ? { detail: null, reason: 'connect_timeout' } : null;
        case 'closed':
          return { detail: `close_code_${String(event.code)}`, reason: 'connect_failed' };
        case 'error':
          return { detail: event.code, reason: 'connect_failed' };
        case 'answer':
        case 'binary':
        case 'frame_too_large':
        case 'persistence_failed':
        case 'queue_full':
          return null;
      }
    });
    connectTimer.cancel();
    if (notOpened !== 'open') {
      await this.#end(true);
      return {
        answered: 0,
        connection_id: null,
        last_sent_utc: input.previousSentUtc,
        sent: 0,
        stopped: notOpened,
      };
    }

    // La apertura es durable antes de la primera petición.
    await this.#writes;
    let stop: BatchStop | null =
      this.#writeFailure === null
        ? null
        : { detail: this.#writeFailure, reason: 'persistence_failed' };
    let answered = 0;
    let sent = 0;
    let lastSentUtc = input.previousSentUtc;
    const deadlineMs = Date.parse(input.deadlineUtc);
    for (const request of input.requests) {
      if (stop !== null) {
        break;
      }
      const wait =
        lastSentUtc === null
          ? 0
          : Date.parse(lastSentUtc) + input.pacingMs - Date.parse(input.now());
      if (wait > 0) {
        const pacing = this.#timer(wait);
        const interrupted = await this.#waitFor<BatchStop | 'paced'>((event) =>
          event.kind === 'timer' && event.id === pacing.id ? 'paced' : this.#interruption(event),
        );
        pacing.cancel();
        if (interrupted !== 'paced') {
          stop = interrupted;
          break;
        }
      }
      if (Date.parse(input.now()) >= deadlineMs) {
        stop = { detail: null, reason: 'deadline' };
        break;
      }
      this.#waiting.add(request.reqId);
      socket.send(request.text);
      sent += 1;
      lastSentUtc = input.now();
      const timeout = this.#timer(input.requestTimeoutMs);
      const outcome = await this.#waitFor<BatchStop | 'answered'>((event) => {
        if (event.kind === 'timer') {
          return event.id === timeout.id
            ? { detail: request.operation, reason: 'request_timeout' }
            : null;
        }
        if (event.kind === 'answer') {
          if (event.reqId !== request.reqId) {
            return null;
          }
          return event.rateLimited
            ? { detail: request.operation, reason: 'rate_limit' }
            : 'answered';
        }
        return this.#interruption(event);
      });
      timeout.cancel();
      this.#waiting.delete(request.reqId);
      if (outcome === 'answered') {
        answered += 1;
      } else {
        stop = outcome;
      }
    }

    const closure = this.#closureOf(stop);
    await this.#end(closure.terminate);
    const connectionId = this.#connectionId;
    if (this.#writeFailure === null && connectionId !== null) {
      let failed: string | null = null;
      try {
        await input.closed({
          at_utc: input.now(),
          closure_type: closure.closure_type,
          connection_id: connectionId,
          reason: closure.reason,
        });
      } catch (error) {
        failed = failureReason(error);
      }
      if (failed !== null) {
        this.#writeFailure = failed;
        stop ??= { detail: failed, reason: 'persistence_failed' };
      }
    } else if (this.#writeFailure !== null && stop?.reason !== 'persistence_failed') {
      stop = { detail: this.#writeFailure, reason: 'persistence_failed' };
    }
    return {
      answered,
      connection_id: connectionId,
      last_sent_utc: lastSentUtc,
      sent,
      stopped: stop,
    };
  }

  /**
   * Cierra el socket, si sigue abierto, y espera su aviso como mucho `closeTimeoutMs`; después, que
   * se escriba todo lo que llegó.
   */
  async #end(terminate: boolean): Promise<void> {
    const socket = this.#socket;
    if (socket !== null && !this.#closed) {
      if (terminate) {
        socket.terminate();
      } else {
        socket.close();
      }
      const timer = this.#timer(this.#input.closeTimeoutMs);
      const ended = await this.#waitFor<'closed' | 'late'>((event) => {
        if (event.kind === 'closed') {
          return 'closed';
        }
        return event.kind === 'timer' && event.id === timer.id ? 'late' : null;
      });
      timer.cancel();
      if (ended === 'late') {
        socket.terminate();
      }
    }
    await this.#writes;
  }
}

/** Abre una conexión, pide las peticiones de una en una y la cierra (ver arriba). */
export function runBatchExchange(input: BatchExchangeInput): Promise<BatchExchangeResult> {
  return new BatchExchange(input).run();
}
