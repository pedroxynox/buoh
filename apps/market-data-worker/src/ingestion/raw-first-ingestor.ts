import {
  connectionClosedSchema,
  rawSourceFrameSchema,
  sha256Hex,
  type RawSourceFrame,
  type SourceEvent,
} from '@buoh/contracts';
import {
  CONTRACT_SCHEMA_VERSION,
  evaluateSourceLimit,
  normalizeRawFrame,
  SOURCE_LIMITS,
  type InvalidFrameReason,
  type PipelineProfile,
  type SegmentCloseReason,
  type SourceLimitViolation,
  type UnflaggedTick,
} from '@buoh/domain';

import { type OperationalRegistry } from '../operational/registry.js';
import { type ClosedSourceSegment } from '../source-log/ports.js';
import { previousConnection } from '../source-log/previous-connection.js';
import {
  LogPersistenceError,
  LogReadError,
  type SourceEventLog,
} from '../source-log/source-event-log.js';

/** Destino de lo normalizado en vivo. Solo recibe derivados de frames ya durables. */
export interface TickSink {
  invalidFrame(input: {
    readonly observation_id: string;
    readonly reason: InvalidFrameReason;
  }): void;
  /** Reglas 2.0.0: mensaje durable de otro tipo, para quien lo correlaciona (ping, catálogo…). */
  nonTickFrame?(input: { readonly msg_type: string; readonly observation_id: string }): void;
  tick(tick: UnflaggedTick): void;
}

/** Frame tal como llega del transporte, con ID y recepción ya inyectados. */
export interface FrameInput {
  readonly connection_id: string;
  readonly observation_id: string;
  readonly payload_utf8: string;
  readonly received_at_utc: string;
}

/**
 * `RawSourceFrame` de un frame del transporte. Es pura: el ingestor la usa antes de escribir, y quien
 * correlaciona respuestas la repite sobre el texto que conserva para obtener el mismo frame sin
 * releer el log (ADR-0012 §5).
 */
export function buildRawSourceFrame(frame: FrameInput, profile: PipelineProfile): RawSourceFrame {
  return rawSourceFrameSchema.parse({
    connection_id: frame.connection_id,
    connector_version: profile.connector_version,
    kind: 'raw_source_frame',
    observation_id: frame.observation_id,
    payload_utf8: frame.payload_utf8,
    // Hash sobre los bytes UTF-8 exactos; nunca se reserializa el payload.
    raw_payload_sha256: sha256Hex(frame.payload_utf8),
    received_at_utc: frame.received_at_utc,
    schema_version: CONTRACT_SCHEMA_VERSION,
    source: profile.source,
  });
}

export type ReceiveOutcome =
  | { readonly position: number; readonly segment_index: number; readonly status: 'durable' }
  | { readonly status: 'input_closed' }
  | { readonly resource: string; readonly status: 'limit_exceeded' }
  | { readonly stage: string; readonly status: 'not_durable' };

type NotDurable = Extract<ReceiveOutcome, { readonly status: 'not_durable' }>;

/**
 * Resultado de `repairUnrecordedClose`. `connection_id` es la conexión anterior del log, la que
 * supera el `ConnectionOpened` siguiente, o `null` si el log no tiene conexiones. `closed_at_utc` es
 * la hora de su `ConnectionClosed` durable (en `repaired`, la del cierre reparado), o `null` sin
 * conexiones: el `ConnectionOpened` siguiente tiene que ser posterior.
 */
export type CloseRepairOutcome =
  | NotDurable
  | {
      readonly closed_at_utc: string | null;
      readonly connection_id: string | null;
      readonly status: 'nothing_to_repair';
    }
  | {
      readonly closed_at_utc: string;
      readonly connection_id: string;
      readonly status: 'repaired';
    };

/** Resumen fail-closed tras perder durabilidad (forma de `expected-persistence-failure.json`). */
export interface PersistenceFailureReport {
  readonly dataset_state: 'not_published';
  readonly emitted_tick_count: number;
  readonly execution_mode: 'disabled';
  readonly incident_evidence: { readonly reason: string; readonly stage: string };
  readonly incident_type: 'persistence_unavailable';
  readonly last_durable_observation_id: string | null;
  readonly required_action: 'close_connection_then_recover';
  readonly schema_version: string;
  readonly service_health: 'paused';
  readonly source_event_count: number;
}

export interface RawFirstIngestorInput {
  readonly log: SourceEventLog;
  /** Nuevo UUIDv7 del generador inyectado (intentos sin `observation_id`). */
  readonly nextId: () => string;
  /** Reloj UTC inyectado (detección de fallos y límites). */
  readonly now: () => string;
  readonly profile: PipelineProfile;
  readonly registry: OperationalRegistry;
  /** Reabre el log desde los almacenes tras un fallo de persistencia. */
  readonly reopenLog: () => Promise<SourceEventLog>;
  readonly sink: TickSink;
}

/**
 * Captura raw-first (F1-STREAM-001): cada frame se convierte en `RawSourceFrame` y se escribe en el
 * log durable **antes** de normalizarse; solo entonces el tick llega al sink. Un fallo de
 * almacenamiento o un límite de fuente pausa la entrada (ADR-0004 §12) y queda en el registro
 * operativo; la entrada se reabre solo con un `ConnectionOpened` durable.
 */
export class RawFirstIngestor {
  readonly #input: RawFirstIngestorInput;
  #log: SourceEventLog;
  #logFailed = false;
  #paused: boolean;
  #emittedTicks = 0;
  #lastFailure: { reason: string; stage: string } | null = null;

  constructor(input: RawFirstIngestorInput) {
    this.#input = input;
    this.#log = input.log;
    // Una condición abierta de una ejecución anterior mantiene la entrada cerrada.
    this.#paused = input.registry.openConditions().length > 0;
  }

  get state(): 'accepting' | 'paused' {
    return this.#paused ? 'paused' : 'accepting';
  }

  get emittedTickCount(): number {
    return this.#emittedTicks;
  }

  get log(): SourceEventLog {
    return this.#log;
  }

  /** Último source event confirmado como durable (la instancia fallida conserva ese dato). */
  #relatedRefs(): string[] {
    const last = this.#log.lastEventId;
    return last === null ? [] : [last];
  }

  async #onPersistenceFailure(
    error: LogPersistenceError,
    observedRef: string,
  ): Promise<NotDurable> {
    const relatedRefs = this.#relatedRefs();
    this.#logFailed = true;
    this.#paused = true;
    this.#lastFailure = { reason: error.reason, stage: error.stage };
    await this.#input.registry.recordPersistenceUnavailable({
      observed_at_utc: this.#input.now(),
      observed_ref: observedRef,
      reason: error.reason,
      related_refs: relatedRefs,
      stage: error.stage,
    });
    return { stage: error.stage, status: 'not_durable' };
  }

  async #append(
    event: SourceEvent,
    observedRef: string,
  ): Promise<Extract<ReceiveOutcome, { readonly status: 'durable' }> | NotDurable> {
    try {
      const result = await this.#log.append(event);
      return { position: result.position, segment_index: result.segment_index, status: 'durable' };
    } catch (error) {
      if (error instanceof LogPersistenceError) {
        return this.#onPersistenceFailure(error, observedRef);
      }
      throw error;
    }
  }

  /**
   * Reabre desde los almacenes el log que falló. Si no se puede porque un almacén no responde
   * (`LogReadError`), registra `persistence_unavailable` (etapa `source_event_index`) con
   * `observedRef` y el motivo saneado, y devuelve el resultado no durable. Cualquier otro error lo
   * relanza sin registrar nada: si el contenido del log no pasa sus comprobaciones
   * (`LogIntegrityError`), no se reintenta con contenido no confiable (ADR-0004 §12), y un error de
   * programación no se reintenta como si fuera una pausa.
   */
  async #reopenLog(observedRef: string): Promise<NotDurable | null> {
    try {
      this.#log = await this.#input.reopenLog();
      this.#logFailed = false;
      return null;
    } catch (error) {
      if (!(error instanceof LogReadError)) {
        throw error;
      }
      return this.#onPersistenceFailure(
        new LogPersistenceError('source_event_index', error.reason, { cause: error }),
        observedRef,
      );
    }
  }

  /** Frame del transporte: límite de bytes, escritura raw durable y después normalización. */
  async receiveFrame(frame: FrameInput): Promise<ReceiveOutcome> {
    if (this.#paused) {
      return { status: 'input_closed' };
    }
    // Límite antes de construir el RawSourceFrame: nunca se carga contenido fuera del límite.
    const violation = evaluateSourceLimit(
      'websocket_frame',
      Buffer.byteLength(frame.payload_utf8, 'utf8'),
    );
    if (violation !== null) {
      this.#paused = true;
      await this.#input.registry.recordSourceLimitExceeded({
        observed_at_utc: this.#input.now(),
        // El transporte ya asignó el observation_id del frame rechazado (contratos de dominio).
        observed_ref: frame.observation_id,
        related_refs: this.#relatedRefs(),
        violation,
      });
      return { resource: violation.evidence.resource, status: 'limit_exceeded' };
    }

    const raw = buildRawSourceFrame(frame, this.#input.profile);
    const outcome = await this.#append(raw, raw.observation_id);
    if (outcome.status !== 'durable') {
      return outcome;
    }

    // Solo un raw durable se normaliza; el normalizador nunca modifica el raw.
    const normalized = normalizeRawFrame(raw, this.#input.profile);
    if (normalized.ok) {
      this.#input.sink.tick(normalized.tick);
      this.#emittedTicks += 1;
    } else if (normalized.reason === 'non_tick') {
      // Reglas 2.0.0: respuesta de la fuente (ping, catálogo…), ya durable; no es un tick.
      this.#input.sink.nonTickFrame?.({
        msg_type: normalized.msg_type,
        observation_id: raw.observation_id,
      });
    } else {
      this.#input.sink.invalidFrame({
        observation_id: raw.observation_id,
        reason: normalized.reason,
      });
    }
    return outcome;
  }

  /**
   * Límite que el transporte detecta antes de `receiveFrame` (ADR-0012 §3 y §4): un frame que `ws`
   * cortó por su tamaño declarado o un frame que no cupo en la cola. Pausa la entrada y registra
   * `source_limit_exceeded`, como `receiveFrame` con un frame de más de 1 MiB. Solo escribe en el
   * registro operativo, nunca en el log; el transporte lo llama desde el mismo consumidor que entrega
   * los frames, así que el ingestor sigue recibiendo una sola llamada a la vez.
   */
  async pauseForSourceLimit(input: {
    readonly observed_at_utc: string;
    /** `observation_id` que el transporte asignó al frame rechazado. */
    readonly observed_ref: string;
    readonly violation: SourceLimitViolation;
  }): Promise<ReceiveOutcome> {
    const { resource } = input.violation.evidence;
    // Solo los límites de frame y de cola pausan la entrada. Los de esquema dejan `failed` y los
    // registra la carga de esquemas.
    if (SOURCE_LIMITS[resource].health !== 'paused') {
      throw new TypeError(`El recurso ${resource} no pausa la entrada.`);
    }
    this.#paused = true;
    await this.#input.registry.recordSourceLimitExceeded({
      observed_at_utc: input.observed_at_utc,
      observed_ref: input.observed_ref,
      related_refs: this.#relatedRefs(),
      violation: input.violation,
    });
    return { resource, status: 'limit_exceeded' };
  }

  /**
   * Evento de conexión o recuperación. Con la entrada pausada se rechazan recuperaciones; se admite
   * el `ConnectionClosed` del cierre de la entrada si el log sigue sano, y un `ConnectionOpened`,
   * que reabre el log si había fallado y, al quedar durable, resuelve las condiciones operativas. Si
   * al reabrir el log su contenido no pasa sus comprobaciones, se rechaza con `LogIntegrityError`,
   * sin registrar nada; igual con cualquier error al reabrirlo que no sea de un almacén que no
   * responde (`LogReadError`).
   */
  async receiveEvent(
    event: Exclude<SourceEvent, { kind: 'raw_source_frame' }>,
  ): Promise<ReceiveOutcome> {
    if (
      this.#paused &&
      event.kind !== 'connection_opened' &&
      !(event.kind === 'connection_closed' && !this.#logFailed)
    ) {
      return { status: 'input_closed' };
    }
    if (this.#logFailed) {
      const failure = await this.#reopenLog(event.event_id);
      if (failure !== null) {
        return failure;
      }
    }
    const outcome = await this.#append(event, event.event_id);
    if (outcome.status === 'durable') {
      const resolution = await this.#input.registry.resolveWith(event);
      if (event.kind === 'connection_opened' && resolution.status === 'recorded') {
        this.#paused = this.#input.registry.openConditions().length > 0;
      }
    }
    return outcome;
  }

  /**
   * Cierre no registrado (ADR-0015 §3, pendiente 7 de F1.3): antes de abrir el socket siguiente,
   * persiste el `ConnectionClosed` que le falta a la conexión anterior del log, por un fallo de
   * persistencia o una caída del proceso. Solo se llama sin conexión abierta. En este orden:
   *
   * 1. reabre el log si había fallado;
   * 2. vuelve a leer del log la conexión anterior. Si no hay ninguna o ya tiene su cierre, no hay nada
   *    que reparar; también si el índice confirmó el cierre original aunque informó error, porque el
   *    log reabierto lo adopta;
   * 3. escribe el cierre (`transport_error`, motivo `close_not_recorded`, `affected_symbols` y la
   *    hora de la detección) sin reabrir la entrada: sigue como estaba hasta un `ConnectionOpened`
   *    durable. Como cualquier evento durable, el cierre resuelve `persistence_unavailable`.
   *
   * Si el log no se puede reabrir porque un almacén no responde, un almacén no responde al leerlo o
   * el cierre no queda durable, registra `persistence_unavailable` como `receiveEvent`, con el ID
   * del cierre como `observed_ref`, y devuelve `not_durable`: no se debe abrir otro socket. Si el
   * contenido del log no pasa sus comprobaciones, al reabrirlo o al leerlo (`LogIntegrityError`), o
   * ante cualquier otro error al reabrirlo o al leerlo, rechaza sin registrar nada: no se reintenta
   * con contenido no confiable (ADR-0004 §12), ni un error de programación como si fuera una pausa.
   */
  async repairUnrecordedClose(input: {
    /** Símbolos de la sesión, que el cierre da como afectados. */
    readonly affected_symbols: readonly string[];
  }): Promise<CloseRepairOutcome> {
    // El ID del cierre se genera solo cuando hace falta: con el log fallido, antes de reabrirlo.
    let eventId: string | undefined;
    const closeId = () => (eventId ??= this.#input.nextId());
    if (this.#logFailed) {
      const failure = await this.#reopenLog(closeId());
      if (failure !== null) {
        return failure;
      }
    }
    let segments: SourceEvent[][];
    try {
      segments = await this.#log.readDurableSegments();
    } catch (error) {
      // Solo un almacén que no responde cuenta como no poder reabrir el log: sin leerlo no se sabe
      // qué conexión cerrar. Un contenido que no pasa sus comprobaciones (`LogIntegrityError`) no se
      // reintenta (ADR-0004 §12), y un error de programación tampoco: los dos rechazan la reparación.
      if (!(error instanceof LogReadError)) {
        throw error;
      }
      return this.#onPersistenceFailure(
        new LogPersistenceError('source_event_index', error.reason, { cause: error }),
        closeId(),
      );
    }
    const previous = previousConnection(segments);
    if (previous === null || previous.closed) {
      return {
        closed_at_utc: previous?.closed_at_utc ?? null,
        connection_id: previous?.connection_id ?? null,
        status: 'nothing_to_repair',
      };
    }
    const event = connectionClosedSchema.parse({
      affected_symbols: [...new Set(input.affected_symbols)].sort(),
      closure_type: 'transport_error',
      connection_id: previous.connection_id,
      event_id: closeId(),
      kind: 'connection_closed',
      occurred_at_utc: this.#input.now(),
      reason: 'close_not_recorded',
      schema_version: CONTRACT_SCHEMA_VERSION,
      source: this.#input.profile.source,
    });
    const outcome = await this.#append(event, event.event_id);
    if (outcome.status !== 'durable') {
      return outcome;
    }
    await this.#input.registry.resolveWith(event);
    return {
      closed_at_utc: event.occurred_at_utc,
      connection_id: previous.connection_id,
      status: 'repaired',
    };
  }

  /**
   * El log abierto ya no vale: la reparación del cierre o el evento de conexión siguientes lo vuelven
   * a abrir desde los almacenes con `reopenLog`, como tras un fallo de persistencia, pero sin
   * registrar nada. Lo usa la sesión después de tomar un bloqueo nuevo (ADR-0015 §3, «Conexión
   * anterior»): el log abierto escribe con el bloqueo anterior, y en los segundos que tardó en
   * notarse la pérdida otro proceso pudo escribir. Hasta reabrirlo, `rotate` no cierra el segmento.
   */
  markLogStale(): void {
    this.#logFailed = true;
  }

  /** Cierre explícito del segmento abierto (harness, drenaje o apagado). */
  async rotate(
    reason: SegmentCloseReason = 'requested',
  ): Promise<
    { readonly segment: ClosedSourceSegment | null; readonly status: 'closed' } | ReceiveOutcome
  > {
    if (this.#logFailed) {
      return { status: 'input_closed' };
    }
    try {
      return { segment: await this.#log.close(reason), status: 'closed' };
    } catch (error) {
      if (error instanceof LogPersistenceError) {
        return this.#onPersistenceFailure(error, this.#input.nextId());
      }
      throw error;
    }
  }

  /** Resultado fail-closed tras la última pérdida de durabilidad, o `null` si no hubo. */
  persistenceFailureReport(): PersistenceFailureReport | null {
    if (this.#lastFailure === null) {
      return null;
    }
    return {
      dataset_state: 'not_published',
      emitted_tick_count: this.#emittedTicks,
      execution_mode: 'disabled',
      incident_evidence: this.#lastFailure,
      incident_type: 'persistence_unavailable',
      last_durable_observation_id: this.#log.lastRawObservationId,
      required_action: 'close_connection_then_recover',
      schema_version: CONTRACT_SCHEMA_VERSION,
      service_health: 'paused',
      source_event_count: this.#log.totalEventCount,
    };
  }
}
