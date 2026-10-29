import {
  connectionClosedSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  type ConnectionClosed,
  type ConnectionOpened,
  type HistoryRecoveryResult,
  type RawSourceFrame,
} from '@buoh/contracts';
import {
  checkRequestedResponse,
  CONTRACT_SCHEMA_VERSION,
  deriveCatalogSnapshot,
  deriveRequestedResponseIncident,
  evaluateSourceLimit,
  JsonLexemeError,
  parseJsonPreservingNumbers,
  type CatalogResponseSchema,
  type JsonNode,
  type PipelineProfile,
  type RequestedResponseInvalidReason,
  type SourceLimitViolation,
} from '@buoh/domain';

import {
  buildRawSourceFrame,
  type FrameInput,
  type RawFirstIngestor,
  type ReceiveOutcome,
} from '../ingestion/raw-first-ingestor.js';
import { type OperationalAlert } from '../operational/registry.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  historyRange,
  HistoryRecovery,
  readHistoryPage,
  type HistoryPage,
  type HistoryRecoveryDecision,
  type HistoryRecoveryOutcome,
  type HistoryRecoveryRequest,
} from './history-recovery.js';
import { IngestQueue } from './ingest-queue.js';
import {
  type CatalogStore,
  type CatalogVersion,
  type RequestedResponseIncidentStore,
  type Scheduler,
} from './ports.js';
import { encodeRequest, EXPECTED_MSG_TYPE, type DerivRequest } from './requests.js';
import { type DerivSchemaSet } from './schema-archive.js';
import {
  CONNECT_TIMEOUT_MS,
  type DerivSocket,
  type SocketFactory,
  type SocketSignal,
} from './socket.js';

/**
 * Tiempo máximo de respuesta de cada petición (ADR-0004 §7), también de cada página de historia. Al
 * vencer, cierra la conexión, salvo en una página de historia (ADR-0015 §4).
 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Intervalo del `ping` de keepalive: Deriv recomienda de 30 a 60 s (ADR-0004 §2). */
export const KEEPALIVE_INTERVAL_MS = 45_000;

type ClosureType = ConnectionClosed['closure_type'];

/** Petición de una página de historia (ADR-0015 §4). */
type HistoryRequest = Extract<DerivRequest, { readonly operation: 'ticks_history' }>;

/**
 * Cómo terminó la conexión:
 * - `completed`: el cierre previsto (la duración o `finish`) o la parada (`stop`), después de
 *   `forget_all` o, sin suscripción, enseguida;
 * - `disconnected`: la conexión se perdió, no se abrió o la cortó `interrupt` (cierre remoto, error
 *   de transporte, tiempo vencido, mensaje binario o el motivo de `interrupt`). Quien sigue la
 *   conexión decide si reconecta;
 * - `paused`: un límite de frame o de cola, o el almacenamiento, cerró la entrada (salud `paused`);
 * - `failed`: no se puede seguir sin intervención (salud `failed`): sin snapshot válido, símbolo
 *   ausente, suscripción rechazada o un frame cortado sin tamaño conocido.
 *
 * `reason` es un código estable y `detail`, un dato saneado (un código de error, una etapa, una
 * operación o un motivo de incidencia), nunca contenido de la fuente.
 */
export type DerivSessionEnd =
  | { readonly status: 'completed' }
  | {
      readonly detail: string | null;
      readonly reason: string;
      readonly status: 'disconnected' | 'failed' | 'paused';
    };

export interface DerivConnectionResult {
  /** Catálogo vigente: el recibido (`created` o `unchanged`) o, si llegó inválido, el anterior. */
  readonly catalog:
    (CatalogVersion & { readonly status: 'created' | 'previous' | 'unchanged' }) | null;
  /** Cierre de la entrada; `persisted` dice si su `ConnectionClosed` quedó durable. */
  readonly closure: {
    readonly closure_type: ClosureType;
    readonly persisted: boolean;
    readonly reason: string;
  } | null;
  readonly connection_id: string | null;
  readonly end: DerivSessionEnd;
  /**
   * Recepción local menos la hora del servidor (`time`), en milisegundos, o `null` si no se pidió o
   * no se obtuvo. Deriv da segundos enteros: incluye hasta 999 ms de redondeo.
   */
  readonly server_time_offset_ms: number | null;
  /** `subscription.id` del primer tick de la suscripción. */
  readonly subscription_id: string | null;
}

export interface DerivConnectionInput {
  readonly alert: OperationalAlert;
  readonly catalog: CatalogStore;
  readonly catalogSchema: CatalogResponseSchema;
  readonly connect: SocketFactory;
  /**
   * Tiempo de escucha desde el primer tick hasta el cierre previsto, como `finish`. Sin él, la
   * conexión nunca pide el cierre previsto por su cuenta: termina cuando se pierde o cuando quien la
   * sigue la cierra, con `finish`, `stop` o `interrupt`.
   */
  readonly durationMs?: number;
  readonly endpoint: string;
  readonly ingestor: RawFirstIngestor;
  readonly nextId: () => string;
  readonly now: () => string;
  /** Perfil del ingestor: da la fuente y el conector de cada frame. */
  readonly profile: PipelineProfile;
  readonly requestedResponses: RequestedResponseIncidentStore;
  readonly scheduler: Scheduler;
  readonly schemas: DerivSchemaSet;
  /** Pide `time` una vez, tras el primer tick, para medir el desfase. */
  readonly serverTime: boolean;
  /**
   * Conexión anterior del log, que supera el `ConnectionOpened` de esta (ADR-0015 §3); `null` solo
   * si el log no tiene conexiones.
   */
  readonly supersedes_connection_id: string | null;
  readonly symbol: string;
}

/** Trabajo del único consumidor de la cola, en orden de llegada. */
type Work =
  | { readonly event: ConnectionClosed; readonly kind: 'closed' }
  | { readonly event: ConnectionOpened; readonly kind: 'opened' }
  | { readonly frame: FrameInput; readonly kind: 'frame' }
  | {
      readonly kind: 'limit';
      readonly observed_at_utc: string;
      readonly observed_ref: string;
      readonly violation: SourceLimitViolation;
    }
  | {
      readonly event: HistoryRecoveryResult;
      readonly kind: 'recovery';
      readonly recovery: HistoryRecovery;
    };

interface ClosePlan {
  readonly closure_type: ClosureType;
  /** Descarta los frames que esperan: después de un límite no se emite nada más (ADR-0012 §4). */
  readonly drop_waiting: boolean;
  readonly end: DerivSessionEnd;
  /** Límite que el consumidor registra antes del cierre. */
  readonly limit?: Omit<Extract<Work, { kind: 'limit' }>, 'kind'>;
  /** Motivo del `ConnectionClosed`. */
  readonly reason: string;
}

type JsonObject = Extract<JsonNode, { type: 'object' }>;

/** Raíz del frame si es un objeto JSON; `null` si no es JSON (las reglas 2.0.0 ya lo registraron). */
function parseObject(text: string): JsonObject | null {
  let root: JsonNode;
  try {
    root = parseJsonPreservingNumbers(text);
  } catch (error) {
    if (error instanceof JsonLexemeError) {
      return null;
    }
    throw error;
  }
  return root.type === 'object' ? root : null;
}

function stringMember(node: JsonNode | undefined, key: string): string | null {
  const value = node?.type === 'object' ? node.entries.get(key) : undefined;
  return value?.type === 'string' ? value.value : null;
}

/** Entero positivo escrito sin fracción ni exponente, como los `req_id` del adaptador. */
function positiveIntegerMember(node: JsonObject, key: string): number | null {
  const value = node.entries.get(key);
  if (value?.type !== 'number' || !/^[1-9]\d*$/u.test(value.lexeme)) {
    return null;
  }
  const parsed = Number(value.lexeme);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const disconnected = (reason: string, detail: string | null = null): DerivSessionEnd => ({
  detail,
  reason,
  status: 'disconnected',
});
const paused = (reason: string, detail: string | null = null): DerivSessionEnd => ({
  detail,
  reason,
  status: 'paused',
});
const failed = (reason: string, detail: string | null = null): DerivSessionEnd => ({
  detail,
  reason,
  status: 'failed',
});

/** Forma de los motivos: un código estable, como `smoke_interrupt`. */
const STABLE_CODE = /^[a-z][a-z0-9_]*$/u;

/**
 * Una conexión al canal público de Deriv (ADR-0012 §3 a §7): abre el WebSocket, persiste
 * `ConnectionOpened`, pide el catálogo, se suscribe al símbolo si está en el último snapshot válido y
 * mantiene el keepalive. Quien la sigue la cierra con `finish` (el cierre previsto), `stop` (la
 * parada por señal) o `interrupt` (un corte del propio transporte); con `durationMs`, el cierre
 * previsto llega también por sí mismo, al cumplirse la duración. El cierre previsto espera a la
 * recuperación de historia en curso; la parada, no.
 *
 * Todo lo que toca el ingestor pasa por una cola con un solo consumidor: frames, apertura, pausa por
 * límite, resultado de la recuperación de historia y cierre. Las respuestas se interpretan solo
 * después de que su frame sea durable, sobre el texto que conserva el transporte. Toda pérdida
 * termina la conexión y queda en su `ConnectionClosed`; quien la sigue decide si reconecta, y pide
 * con `recoverHistory` la historia de un hueco por esta misma conexión (ADR-0015 §4).
 */
export class DerivConnection {
  readonly #input: DerivConnectionInput;
  readonly #queue: IngestQueue<Work>;
  readonly #pending = new Map<
    number,
    { readonly cancel: () => void; readonly request: DerivRequest }
  >();
  /** Peticiones declaradas que esperaban respuesta cuando se decidió el cierre. */
  readonly #pendingAtClose = new Map<number, DerivRequest>();
  readonly #done = Promise.withResolvers<DerivConnectionResult>();
  #socket: DerivSocket | null = null;
  #socketClosed = false;
  #connectionId: string | null = null;
  #lastReqId = 0;
  #cancelConnect: (() => void) | null = null;
  #cancelKeepalive: (() => void) | null = null;
  #cancelDuration: (() => void) | null = null;
  #closing: ClosePlan | null = null;
  #closure: DerivConnectionResult['closure'] = null;
  /** El `ConnectionClosed` ya se procesó, o no hacía falta porque la conexión no llegó a abrirse. */
  #closeHandled = false;
  #settled = false;
  #catalog: DerivConnectionResult['catalog'] = null;
  #subscribed = false;
  #subscriptionId: string | null = null;
  #serverTimeOffsetMs: number | null = null;
  #recovery: HistoryRecovery | null = null;
  /** El cierre previsto llegó durante una recuperación: `forget_all` espera a que termine. */
  #forgetAfterRecovery = false;
  /** Ya se pidió `forget_all`: el cierre previsto o la parada esperan su respuesta. */
  #forgetAllSent = false;
  /** Se pidió `finish` o `stop`: ya no empieza ninguna recuperación de historia. */
  #closeAsked = false;

  constructor(input: DerivConnectionInput) {
    this.#input = input;
    this.#queue = new IngestQueue<Work>({
      consume: (work) => this.#consume(work),
      onError: (error) => {
        this.#fail(error);
      },
    });
  }

  /**
   * Abre la conexión y la sigue hasta el final. Se resuelve cuando la entrada está cerrada y el
   * socket también; se rechaza solo con un error inesperado, después de cortar el socket: por
   * ejemplo, el `LogIntegrityError` de un log que, al reabrirse, no pasa sus comprobaciones.
   */
  run(): Promise<DerivConnectionResult> {
    this.#cancelConnect = this.#input.scheduler.schedule(CONNECT_TIMEOUT_MS, () => {
      this.#close({
        closure_type: 'timeout',
        drop_waiting: false,
        end: disconnected('connect_timeout'),
        reason: 'connect_timeout',
      });
    });
    try {
      this.#socket = this.#input.connect({
        onSignal: (signal) => {
          this.#onSignal(signal);
        },
        url: this.#input.endpoint,
      });
    } catch (error) {
      this.#socketClosed = true;
      this.#close({
        closure_type: 'transport_error',
        drop_waiting: false,
        end: disconnected('connect_failed', failureReason(error)),
        reason: 'connect_failed',
      });
    }
    return this.#done.promise;
  }

  /**
   * Recupera la historia de un hueco por esta conexión, con hasta tres intentos (ADR-0015 §4). Cada
   * intento pide páginas `ticks_history` desde el final del hueco hacia atrás, cada una con su
   * `req_id` y 15 000 ms de espera; vencer no cierra la conexión y el flujo de ticks sigue. Cada
   * respuesta se interpreta cuando su frame es durable, y la que no es válida deja su incidencia de
   * respuesta pedida. Un intento que termina con `history_error_response`, `history_timeout` o
   * `history_boundary_missing` se repite 30 000 ms después, desde la primera página. El
   * `HistoryRecoveryResult` del último intento pasa por la cola, detrás del primer tick posterior al
   * cierre. Si no queda durable, la conexión se cierra como con un frame no durable. Si mientras
   * tanto llega el cierre previsto (la duración o `finish`), `forget_all` espera a que la
   * recuperación termine; la parada (`stop`) no espera: la abandona.
   *
   * Si la conexión no está suscrita o ya se le pidió `finish` o `stop`, se resuelve enseguida como
   * `abandoned`, sin pedir ninguna página. Si se cierra antes de encolar el resultado, también
   * durante la espera entre intentos, se resuelve igual y no persiste nada; si falla por un error
   * inesperado o llega la parada, igual, aunque el resultado ya esté en la cola. Si el fallo o la
   * parada llegan mientras el resultado ya se escribe, esa escritura puede terminar aunque se
   * resuelva como `abandoned`: el log es la fuente de verdad. Un hueco con horas que no están en UTC
   * con milisegundos o que no dan segundos enteros, otro símbolo o una segunda llamada con una
   * recuperación en curso son errores de programación (`TypeError`).
   */
  recoverHistory(request: HistoryRecoveryRequest): Promise<HistoryRecoveryOutcome> {
    const range = historyRange(request);
    if (request.symbol !== this.#input.symbol) {
      throw new TypeError(`La conexión recupera ${this.#input.symbol}, no ${request.symbol}.`);
    }
    if (this.#recovery !== null) {
      throw new TypeError('La conexión ya tiene una recuperación de historia en curso.');
    }
    const connectionId = this.#connectionId;
    if (!this.#subscribed || this.#closeAsked || this.#closing !== null || connectionId === null) {
      return Promise.resolve({ status: 'abandoned' });
    }
    const recovery: HistoryRecovery = new HistoryRecovery({
      hooks: {
        queueResult: (decision) => {
          this.#queueRecoveryResult(recovery, connectionId, decision);
        },
        scheduler: this.#input.scheduler,
        sendPage: (page) =>
          this.#send({
            end: page.end,
            operation: 'ticks_history',
            start: page.start,
            symbol: request.symbol,
          }),
      },
      range,
      request,
    });
    this.#recovery = recovery;
    // Si se abandona sola, con una página que no salió (`HistoryRecoveryHooks.sendPage`), la
    // conexión la suelta al resolverse: si no, el cierre previsto la esperaría para siempre.
    void recovery.outcome.then(() => {
      if (this.#recovery === recovery) {
        this.#recovery = null;
        this.#afterRecovery();
      }
    });
    recovery.start();
    return recovery.outcome;
  }

  /**
   * El cierre previsto, a pedido; el mismo que llega al cumplirse `durationMs`. Con la conexión
   * suscrita, pide `forget_all` y cierra con `requested` cuando su respuesta queda durable, con fin
   * `completed`; si hay una recuperación de historia en curso, primero espera a que termine, con sus
   * reintentos (ADR-0015 §4). Sin suscripción no hay nada que olvidar: cierra enseguida con
   * `requested` y motivo `requested`, también `completed`. Cancela la duración, y desde entonces no
   * empieza ninguna recuperación nueva. No hace nada si el cierre ya está decidido o si el cierre
   * previsto ya se pidió. Devuelve `true` si el cierre previsto quedó pedido, ahora o antes, y
   * `false` si no hizo nada porque el cierre ya estaba decidido: la conexión termina con ese
   * cierre, que puede no ser el previsto (por ejemplo, el servidor cerró justo antes).
   */
  finish(): boolean {
    if (this.#closing !== null) {
      return false;
    }
    this.#closeAsked = true;
    this.#cancelDuration?.();
    this.#cancelDuration = null;
    if (!this.#subscribed) {
      this.#closeRequested();
    } else if (this.#recovery === null) {
      this.#requestForgetAll();
    } else {
      // El cierre previsto espera a la recuperación en curso, con sus reintentos (ADR-0015 §4).
      this.#forgetAfterRecovery = true;
    }
    return true;
  }

  /**
   * La parada por señal (ADR-0015 §3, «Parada»). No espera a la recuperación de historia en curso:
   * la abandona, y su resultado no se persiste aunque ya esté en la cola, salvo que ya se esté
   * escribiendo (ver `recoverHistory`). Cancela la duración, y desde entonces no empieza ninguna
   * recuperación nueva. Con la conexión suscrita, pide `forget_all`, si el cierre previsto no lo pidió
   * ya, y cierra con `requested` cuando su respuesta queda durable, con fin `completed`; si no
   * responde en 15 000 ms, cierra con `timeout`, como cualquier petición. Sin suscripción, cierra
   * enseguida con `requested` y motivo `requested`, también `completed`; el `ConnectionClosed` se
   * escribe solo si la conexión llegó a abrirse. No hace nada si el cierre ya está decidido.
   */
  stop(): void {
    if (this.#closing !== null) {
      return;
    }
    this.#closeAsked = true;
    this.#cancelDuration?.();
    this.#cancelDuration = null;
    // Si el cierre previsto la esperaba, al abandonarla pide `forget_all` (`#afterRecovery`).
    this.#abandonRecovery(true);
    if (this.#subscribed) {
      this.#requestForgetAll();
    } else {
      this.#closeRequested();
    }
  }

  /**
   * Corta el propio transporte, como si la conexión se perdiera: cierra con `transport_error` y
   * motivo `reason`, corta el socket y termina con `disconnected` y ese motivo. Lo usa el smoke de
   * reconexión (ADR-0015 §9, `smoke_interrupt`). No hace nada si el cierre ya está decidido. Un
   * motivo que no es un código estable (minúsculas, cifras y `_`, empezando por una letra) es un
   * error de programación (`TypeError`), y entonces no cambia nada.
   */
  interrupt(reason: string): void {
    if (!STABLE_CODE.test(reason)) {
      throw new TypeError(`El motivo ${JSON.stringify(reason)} no es un código estable.`);
    }
    this.#close({
      closure_type: 'transport_error',
      drop_waiting: false,
      end: disconnected(reason),
      reason,
    });
  }

  /** Cierre pedido sin suscripción: no hay nada que olvidar ni datos que perder. */
  #closeRequested(): void {
    this.#close({
      closure_type: 'requested',
      drop_waiting: false,
      end: { status: 'completed' },
      reason: 'requested',
    });
  }

  /** Pide `forget_all` una sola vez: su respuesta cierra con `requested`. */
  #requestForgetAll(): void {
    if (!this.#forgetAllSent) {
      this.#forgetAllSent = true;
      this.#send({ operation: 'forget_all' });
    }
  }

  /** Encola el resultado de la recuperación, como un evento de control más. */
  #queueRecoveryResult(
    recovery: HistoryRecovery,
    connectionId: string,
    decision: HistoryRecoveryDecision,
  ): void {
    const { request } = recovery;
    const event = historyRecoveryResultSchema.parse({
      ...decision,
      connection_id: connectionId,
      event_id: this.#input.nextId(),
      from_event_time_utc: request.from_event_time_utc,
      kind: 'history_recovery_result',
      occurred_at_utc: this.#input.now(),
      schema_version: CONTRACT_SCHEMA_VERSION,
      source: this.#input.profile.source,
      symbol: request.symbol,
      to_event_time_utc: request.to_event_time_utc,
    });
    this.#queue.pushControl({ event, kind: 'recovery', recovery });
  }

  /**
   * Termina la recuperación en curso con `abandoned`, si su resultado no está en la cola o si
   * `force`: la conexión falló, y el resultado ya no se persiste aunque esté en la cola.
   */
  #abandonRecovery(force = false): void {
    if (this.#recovery?.abandon(force) === true) {
      this.#recovery = null;
      this.#afterRecovery();
    }
  }

  /**
   * La recuperación terminó: su resultado pasó por la cola, o se abandonó. Si el cierre previsto la
   * esperaba, ahora pide `forget_all`; con el cierre ya decidido, `#send` no envía nada.
   */
  #afterRecovery(): void {
    if (this.#forgetAfterRecovery) {
      this.#forgetAfterRecovery = false;
      this.#requestForgetAll();
    }
  }

  #onSignal(signal: SocketSignal): void {
    switch (signal.kind) {
      case 'open':
        this.#onOpen();
        return;
      case 'text':
        this.#onText(signal.text, signal.byte_length);
        return;
      case 'binary':
        // Un `RawSourceFrame` solo admite texto UTF-8 (ADR-0012 §3).
        this.#close({
          closure_type: 'transport_error',
          drop_waiting: false,
          end: disconnected('binary_frame'),
          reason: 'binary_frame',
        });
        return;
      case 'frame_too_large':
        this.#onFrameTooLarge(signal.observed_value);
        return;
      case 'error':
        this.#close({
          closure_type: 'transport_error',
          drop_waiting: false,
          end: disconnected(
            this.#connectionId === null ? 'connect_failed' : 'transport_error',
            signal.code,
          ),
          reason: signal.code,
        });
        return;
      case 'closed':
        this.#onSocketClosed(signal.code);
        return;
    }
  }

  #onOpen(): void {
    if (this.#closing !== null || this.#connectionId !== null) {
      return;
    }
    this.#cancelConnect?.();
    this.#cancelConnect = null;
    this.#connectionId = this.#input.nextId();
    const event = connectionOpenedSchema.parse({
      connection_id: this.#connectionId,
      event_id: this.#input.nextId(),
      kind: 'connection_opened',
      occurred_at_utc: this.#input.now(),
      schema_version: CONTRACT_SCHEMA_VERSION,
      source: this.#input.profile.source,
      supersedes_connection_id: this.#input.supersedes_connection_id,
    });
    this.#queue.pushControl({ event, kind: 'opened' });
  }

  #onText(text: string, byteLength: number): void {
    const connectionId = this.#connectionId;
    // Después de decidir el cierre, la entrada ya no acepta frames.
    if (this.#closing !== null || connectionId === null) {
      return;
    }
    const frame: FrameInput = {
      connection_id: connectionId,
      observation_id: this.#input.nextId(),
      payload_utf8: text,
      received_at_utc: this.#input.now(),
    };
    const offer = this.#queue.offerFrame({ frame, kind: 'frame' }, byteLength);
    if (offer.status === 'rejected') {
      const { resource } = offer.violation.evidence;
      this.#close({
        closure_type: 'transport_error',
        drop_waiting: true,
        end: paused(resource),
        limit: {
          observed_at_utc: frame.received_at_utc,
          // El frame que no cupo (ADR-0012 §4).
          observed_ref: frame.observation_id,
          violation: offer.violation,
        },
        reason: resource,
      });
    }
  }

  #onFrameTooLarge(observedValue: number | null): void {
    const violation =
      observedValue === null ? null : evaluateSourceLimit('websocket_frame', observedValue);
    if (violation === null) {
      // Sin el tamaño declarado no hay `observed_value`: no se inventa uno (ADR-0012 §3).
      this.#close({
        closure_type: 'transport_error',
        drop_waiting: true,
        end: failed('frame_size_unavailable'),
        reason: 'websocket_frame',
      });
      return;
    }
    this.#close({
      closure_type: 'transport_error',
      drop_waiting: true,
      end: paused('websocket_frame'),
      limit: {
        observed_at_utc: this.#input.now(),
        // El frame cortado nunca llegó entero, pero recibe su `observation_id` al detectarse.
        observed_ref: this.#input.nextId(),
        violation,
      },
      reason: 'websocket_frame',
    });
  }

  #onSocketClosed(code: number): void {
    this.#socketClosed = true;
    // 1006: la conexión se cortó sin un cierre ordenado (RFC 6455 §7.4.1).
    const abnormal = code === 1006;
    this.#close({
      closure_type: abnormal ? 'transport_error' : 'remote',
      drop_waiting: false,
      end:
        this.#connectionId === null
          ? disconnected('connect_failed', String(code))
          : disconnected(abnormal ? 'transport_error' : 'remote_closed', String(code)),
      reason: `close_code_${String(code)}`,
    });
    this.#finishIfDone();
  }

  /**
   * Cierra la entrada. La primera decisión gana: deja de aceptar frames, cancela los tiempos, corta
   * el socket y encola, detrás de lo que ya espera, la pausa por límite y el `ConnectionClosed`.
   */
  #close(plan: ClosePlan): void {
    if (this.#closing !== null) {
      return;
    }
    this.#closing = plan;
    // Su respuesta, si llega durable, ya no cambia el flujo, pero deja su incidencia o su versión.
    for (const [reqId, { request }] of this.#pending) {
      if (request.operation !== 'ticks') {
        this.#pendingAtClose.set(reqId, request);
      }
    }
    this.#cancelTimers();
    // Sin su resultado en la cola, la recuperación no persiste nada (ADR-0015 §4).
    this.#abandonRecovery();
    if (plan.drop_waiting) {
      this.#queue.dropWaitingFrames();
    }
    if (!this.#socketClosed) {
      if (plan.closure_type === 'requested') {
        this.#socket?.close();
      } else {
        this.#socket?.terminate();
      }
    }
    const connectionId = this.#connectionId;
    if (connectionId === null) {
      // Sin `ConnectionOpened` no hay entrada que cerrar en el log.
      this.#closeHandled = true;
    } else {
      if (plan.limit !== undefined) {
        this.#queue.pushControl({ kind: 'limit', ...plan.limit });
      }
      this.#queue.pushControl({
        event: connectionClosedSchema.parse({
          affected_symbols: this.#subscribed ? [this.#input.symbol] : [],
          closure_type: plan.closure_type,
          connection_id: connectionId,
          event_id: this.#input.nextId(),
          kind: 'connection_closed',
          occurred_at_utc: this.#input.now(),
          reason: plan.reason,
          schema_version: CONTRACT_SCHEMA_VERSION,
          source: this.#input.profile.source,
        }),
        kind: 'closed',
      });
    }
    this.#finishIfDone();
  }

  #cancelTimers(): void {
    for (const cancel of [this.#cancelConnect, this.#cancelKeepalive, this.#cancelDuration]) {
      cancel?.();
    }
    this.#cancelConnect = null;
    this.#cancelKeepalive = null;
    this.#cancelDuration = null;
    for (const pending of this.#pending.values()) {
      pending.cancel();
    }
    this.#pending.clear();
  }

  #finishIfDone(): void {
    const plan = this.#closing;
    if (this.#settled || plan === null || !this.#closeHandled || !this.#socketClosed) {
      return;
    }
    this.#settled = true;
    // Un `ConnectionClosed` que no quedó durable significa que el log falló: la entrada está en
    // pausa por persistencia, aunque la conexión ya se hubiera completado o perdido.
    const end =
      this.#closure?.persisted === false &&
      (plan.end.status === 'completed' || plan.end.status === 'disconnected')
        ? paused('persistence_unavailable')
        : plan.end;
    this.#done.resolve({
      catalog: this.#catalog,
      closure: this.#closure,
      connection_id: this.#connectionId,
      end,
      server_time_offset_ms: this.#serverTimeOffsetMs,
      subscription_id: this.#subscriptionId,
    });
  }

  /**
   * Error inesperado: corta el socket, abandona la recuperación aunque su resultado ya esté en la
   * cola y rechaza la conexión. El cierre se decide primero, para que ya no se envíe nada.
   */
  #fail(error: unknown): void {
    this.#closing ??= {
      closure_type: 'transport_error',
      drop_waiting: true,
      end: failed('unexpected'),
      reason: 'unexpected',
    };
    this.#cancelTimers();
    this.#abandonRecovery(true);
    if (!this.#socketClosed) {
      this.#socket?.terminate();
    }
    if (!this.#settled) {
      this.#settled = true;
      this.#done.reject(error);
    }
  }

  async #consume(work: Work): Promise<void> {
    const { ingestor } = this.#input;
    switch (work.kind) {
      case 'opened':
        await this.#persistOpened(work.event);
        return;
      case 'frame':
        await this.#ingestFrame(work.frame);
        return;
      case 'limit':
        await ingestor.pauseForSourceLimit(work);
        return;
      case 'recovery': {
        const { recovery } = work;
        // Abandonada mientras esperaba en la cola, porque la conexión falló: su resultado nunca
        // llega al ingestor (ADR-0015 §4).
        if (recovery.abandoned) {
          return;
        }
        const outcome = await ingestor.receiveEvent(work.event);
        if (outcome.status !== 'durable') {
          this.#closeAfterIngest(outcome);
        }
        if (this.#recovery === recovery) {
          this.#recovery = null;
        }
        recovery.finish(outcome.status === 'durable', work.event);
        this.#afterRecovery();
        return;
      }
      case 'closed': {
        const outcome = await ingestor.receiveEvent(work.event);
        this.#closure = {
          closure_type: work.event.closure_type,
          persisted: outcome.status === 'durable',
          reason: work.event.reason,
        };
        this.#closeHandled = true;
        this.#finishIfDone();
        return;
      }
    }
  }

  async #persistOpened(event: ConnectionOpened): Promise<void> {
    const { ingestor } = this.#input;
    const outcome = await ingestor.receiveEvent(event);
    if (outcome.status !== 'durable') {
      // Sin la apertura durable no se ingiere nada; el log fallido tampoco admitirá el cierre.
      this.#close({
        closure_type: 'transport_error',
        drop_waiting: true,
        end: paused('persistence_unavailable', 'stage' in outcome ? outcome.stage : null),
        reason: 'persistence_unavailable',
      });
      return;
    }
    if (ingestor.state === 'paused') {
      // Una condición operativa sigue abierta y la apertura no la resolvió: la entrada sigue
      // cerrada. Todavía no hay suscripción, así que no se pierde nada.
      this.#close({
        closure_type: 'requested',
        drop_waiting: false,
        end: paused('input_closed'),
        reason: 'input_closed',
      });
      return;
    }
    if (this.#closing !== null) {
      return;
    }
    this.#scheduleKeepalive();
    this.#send({ operation: 'active_symbols' });
  }

  async #ingestFrame(frame: FrameInput): Promise<void> {
    const outcome = await this.#input.ingestor.receiveFrame(frame);
    if (outcome.status === 'durable') {
      await (this.#closing === null ? this.#interpret(frame) : this.#auditAfterClose(frame));
      return;
    }
    this.#closeAfterIngest(outcome);
  }

  /**
   * Cierre por un frame o un resultado que el ingestor no hizo durable: después de un límite, de un
   * fallo del log o con la entrada cerrada no se emite nada más.
   */
  #closeAfterIngest(outcome: Exclude<ReceiveOutcome, { readonly status: 'durable' }>): void {
    switch (outcome.status) {
      case 'limit_exceeded':
        // Segunda barrera: el ingestor ya pausó la entrada y registró el límite.
        this.#close({
          closure_type: 'transport_error',
          drop_waiting: true,
          end: paused(outcome.resource),
          reason: outcome.resource,
        });
        return;
      case 'not_durable':
        this.#close({
          closure_type: 'transport_error',
          drop_waiting: true,
          end: paused('persistence_unavailable', outcome.stage),
          reason: 'persistence_unavailable',
        });
        return;
      case 'input_closed':
        this.#close({
          closure_type: 'transport_error',
          drop_waiting: true,
          end: paused('input_closed'),
          reason: 'input_closed',
        });
        return;
    }
  }

  /** Correlaciona un frame durable con la petición que espera su `req_id` y su `msg_type`. */
  async #interpret(frame: FrameInput): Promise<void> {
    const root = parseObject(frame.payload_utf8);
    const reqId = root === null ? null : positiveIntegerMember(root, 'req_id');
    const pending = reqId === null ? undefined : this.#pending.get(reqId);
    if (root === null || reqId === null || pending === undefined) {
      return;
    }
    const msgType = stringMember(root, 'msg_type');
    const { request } = pending;
    if (request.operation === 'ticks') {
      if (msgType === EXPECTED_MSG_TYPE.ticks) {
        this.#settle(reqId);
        this.#onSubscribed(root);
      } else if (msgType === 'ticks' && root.entries.get('error')?.type === 'object') {
        // Las reglas 2.0.0 ya registraron `source_error_response`. Sin suscripción no hay datos que
        // perder: el cierre es `requested` y la salud, `failed` (ADR-0012 §5).
        this.#settle(reqId);
        this.#subscribed = false;
        this.#close({
          closure_type: 'requested',
          drop_waiting: false,
          end: failed('subscription_failed'),
          reason: 'subscription_failed',
        });
      }
      return;
    }
    if (request.operation === 'ticks_history') {
      const page = this.#readPage(root, request);
      if (page !== null) {
        this.#settle(reqId);
        await this.#recordPageIncident(frame, page);
        // Después de esperar: si la recuperación se abandonó mientras tanto, ya no la hay.
        this.#recovery?.onPage(reqId, page);
      }
      return;
    }
    if (msgType !== EXPECTED_MSG_TYPE[request.operation]) {
      return;
    }
    this.#settle(reqId);
    const raw = buildRawSourceFrame(frame, this.#input.profile);
    switch (request.operation) {
      case 'active_symbols':
        await this.#onCatalog(raw);
        return;
      case 'ping':
        if (!(await this.#checkResponse(raw, root, 'ping'))) {
          // Como un keepalive sin respuesta (ADR-0012 §5).
          this.#close({
            closure_type: 'timeout',
            drop_waiting: false,
            end: disconnected('ping_invalid'),
            reason: 'ping_invalid',
          });
        }
        return;
      case 'time':
        if (await this.#checkResponse(raw, root, 'time')) {
          this.#serverTimeOffsetMs = serverTimeOffset(root, frame.received_at_utc);
        }
        return;
      case 'forget_all':
        // Con error o sin él, el cierre previsto sigue: la incidencia queda registrada.
        await this.#checkResponse(raw, root, 'forget_all');
        this.#close({
          closure_type: 'requested',
          drop_waiting: false,
          end: { status: 'completed' },
          reason: 'requested',
        });
        return;
    }
  }

  /**
   * Respuesta durable que llega después de decidir el cierre. Ya no suscribe, no cierra y no mide la
   * hora, pero deja lo que exigen ADR-0012 §6 y §7: la incidencia de una respuesta inválida o, en el
   * catálogo, su versión.
   */
  async #auditAfterClose(frame: FrameInput): Promise<void> {
    const root = parseObject(frame.payload_utf8);
    const reqId = root === null ? null : positiveIntegerMember(root, 'req_id');
    const request = reqId === null ? undefined : this.#pendingAtClose.get(reqId);
    if (
      root === null ||
      reqId === null ||
      request === undefined ||
      request.operation === 'ticks' ||
      stringMember(root, 'msg_type') !== EXPECTED_MSG_TYPE[request.operation]
    ) {
      return;
    }
    this.#pendingAtClose.delete(reqId);
    if (request.operation === 'ticks_history') {
      // La recuperación ya se abandonó: la página solo deja su incidencia, si no es válida.
      const page = this.#readPage(root, request);
      if (page !== null) {
        await this.#recordPageIncident(frame, page);
      }
      return;
    }
    const raw = buildRawSourceFrame(frame, this.#input.profile);
    if (request.operation !== 'active_symbols') {
      await this.#checkResponse(raw, root, request.operation);
      return;
    }
    const stored = await this.#storeCatalog(raw);
    if (stored.status === 'store_failed') {
      this.#input.alert({
        event: 'catalog_store_unavailable',
        observed_ref: raw.observation_id,
        reason: stored.code,
      });
    }
  }

  #settle(reqId: number): void {
    this.#pending.get(reqId)?.cancel();
    this.#pending.delete(reqId);
  }

  /** Lee la respuesta a una página de historia (ADR-0015 §4), o `null` si no le responde. */
  #readPage(root: JsonObject, request: HistoryRequest): HistoryPage | null {
    return readHistoryPage(
      root,
      request,
      this.#input.schemas.schema('ticks_history', 'response').validate,
    );
  }

  /** Incidencia de una página que no es válida, si la tiene: el error de `ticks_history` no. */
  async #recordPageIncident(frame: FrameInput, page: HistoryPage): Promise<void> {
    if (page.status !== 'valid' && page.incident !== null) {
      await this.#recordIncident(buildRawSourceFrame(frame, this.#input.profile), page.incident);
    }
  }

  /** Comprobaciones comunes de una respuesta declarada; si falla, registra su incidencia. */
  async #checkResponse(
    raw: RawSourceFrame,
    root: JsonObject,
    operation: 'forget_all' | 'ping' | 'time',
  ): Promise<boolean> {
    const reason = checkRequestedResponse(
      root,
      this.#input.schemas.schema(operation, 'response').validate,
    );
    if (reason === null) {
      return true;
    }
    await this.#recordIncident(raw, reason);
    return false;
  }

  /**
   * Incidencia de una respuesta pedida (ADR-0012 §6). Si no se puede guardar, queda una alerta: la
   * incidencia se vuelve a derivar del frame, que ya es durable.
   */
  async #recordIncident(
    raw: RawSourceFrame,
    reason: RequestedResponseInvalidReason,
  ): Promise<void> {
    const incident = deriveRequestedResponseIncident(raw, reason);
    try {
      await this.#input.requestedResponses.append(incident);
    } catch (error) {
      this.#input.alert({
        event: 'requested_response_incident_unavailable',
        incident_id: incident.incident_id,
        observed_ref: incident.observed_ref,
        reason: failureReason(error),
      });
    }
  }

  /**
   * Guarda la respuesta a `active_symbols` (ADR-0012 §7): un snapshot válido va al almacén, que crea
   * versión solo si cambió el contenido; uno inválido deja su incidencia y sigue vigente la última
   * versión válida, si existe.
   */
  async #storeCatalog(raw: RawSourceFrame): Promise<
    | {
        readonly current: DerivConnectionResult['catalog'];
        readonly invalid: RequestedResponseInvalidReason | null;
        readonly status: 'stored';
      }
    | { readonly code: string; readonly status: 'store_failed' }
  > {
    const { catalog } = this.#input;
    const conversion = deriveCatalogSnapshot(raw, this.#input.catalogSchema);
    try {
      if (conversion.ok) {
        const stored = await catalog.record(conversion.snapshot);
        this.#catalog = {
          snapshot: conversion.snapshot,
          status: stored.status,
          version: stored.version,
        };
        return { current: this.#catalog, invalid: null, status: 'stored' };
      }
      await this.#recordIncident(raw, conversion.reason);
      const previous = await catalog.latest(raw.source, 'deriv_active_symbols');
      if (previous !== null) {
        this.#catalog = { ...previous, status: 'previous' };
      }
      return {
        current: previous === null ? null : this.#catalog,
        invalid: conversion.reason,
        status: 'stored',
      };
    } catch (error) {
      return { code: failureReason(error), status: 'store_failed' };
    }
  }

  /** Respuesta a `active_symbols`: se suscribe solo si el símbolo está en el snapshot vigente. */
  async #onCatalog(raw: RawSourceFrame): Promise<void> {
    const { symbol } = this.#input;
    const stored = await this.#storeCatalog(raw);
    if (stored.status === 'store_failed') {
      this.#close({
        closure_type: 'requested',
        drop_waiting: false,
        end: paused('catalog_store_unavailable', stored.code),
        reason: 'catalog_store_unavailable',
      });
      return;
    }
    const { current } = stored;
    if (current === null) {
      this.#close({
        closure_type: 'requested',
        drop_waiting: false,
        end: failed('catalog_invalid', stored.invalid),
        reason: 'catalog_invalid',
      });
      return;
    }
    if (!current.snapshot.entries.some((entry) => entry.underlying_symbol === symbol)) {
      this.#close({
        closure_type: 'requested',
        drop_waiting: false,
        end: failed('symbol_not_in_catalog'),
        reason: 'symbol_not_in_catalog',
      });
      return;
    }
    if (this.#closing === null) {
      this.#subscribed = true;
      this.#send({ operation: 'ticks', symbol });
    }
  }

  #onSubscribed(root: JsonObject): void {
    this.#subscriptionId = stringMember(root.entries.get('subscription'), 'id');
    const { durationMs } = this.#input;
    if (durationMs !== undefined) {
      this.#cancelDuration = this.#input.scheduler.schedule(durationMs, () => {
        this.#cancelDuration = null;
        this.finish();
      });
    }
    if (this.#input.serverTime) {
      this.#send({ operation: 'time' });
    }
  }

  #scheduleKeepalive(): void {
    this.#cancelKeepalive = this.#input.scheduler.schedule(KEEPALIVE_INTERVAL_MS, () => {
      this.#cancelKeepalive = null;
      this.#send({ operation: 'ping' });
      if (this.#closing === null) {
        this.#scheduleKeepalive();
      }
    });
  }

  /**
   * Envía una petición validada contra su esquema, con su `req_id` y su tiempo de espera. Devuelve
   * el `req_id`, o `null` si no la envió.
   */
  #send(request: DerivRequest): number | null {
    if (this.#closing !== null) {
      return null;
    }
    const reqId = this.#lastReqId + 1;
    const text = encodeRequest(this.#input.schemas, request, reqId);
    if (text === null) {
      // El adaptador comprueba sus peticiones antes de conectar: esto es un error del código.
      this.#fail(new TypeError(`La petición ${request.operation} no cumple su esquema.`));
      return null;
    }
    this.#lastReqId = reqId;
    this.#pending.set(reqId, {
      cancel: this.#input.scheduler.schedule(REQUEST_TIMEOUT_MS, () => {
        if (request.operation === 'ticks_history') {
          // Una página vencida no cierra la conexión (ADR-0015 §4): deja de esperar su respuesta,
          // que si llega se guarda raw como cualquier frame y no se interpreta.
          this.#pending.delete(reqId);
          this.#recovery?.onPage(reqId, { status: 'timeout' });
          return;
        }
        this.#close({
          closure_type: 'timeout',
          drop_waiting: false,
          end: disconnected('request_timeout', request.operation),
          reason: `${request.operation}_timeout`,
        });
      }),
      request,
    });
    this.#socket?.send(text);
    return reqId;
  }
}

/** Recepción menos la hora del servidor, o `null` si `time` no es un entero de segundos usable. */
function serverTimeOffset(root: JsonObject, receivedAtUtc: string): number | null {
  const value = root.entries.get('time');
  if (value?.type !== 'number' || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return null;
  }
  const milliseconds = Number(value.lexeme) * 1000;
  return Number.isSafeInteger(milliseconds) ? Date.parse(receivedAtUtc) - milliseconds : null;
}
