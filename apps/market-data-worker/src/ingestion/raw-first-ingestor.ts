import { rawSourceFrameSchema, sha256Hex, type SourceEvent } from '@buoh/contracts';
import {
  CONTRACT_SCHEMA_VERSION,
  evaluateSourceLimit,
  normalizeRawFrame,
  type InvalidFrameReason,
  type PipelineProfile,
  type SegmentCloseReason,
  type UnflaggedTick,
} from '@buoh/domain';

import { type OperationalRegistry } from '../operational/registry.js';
import { type ClosedSourceSegment } from '../source-log/ports.js';
import {
  failureReason,
  LogPersistenceError,
  type SourceEventLog,
} from '../source-log/source-event-log.js';

/** Destino de lo normalizado en vivo. Solo recibe derivados de frames ya durables. */
export interface TickSink {
  invalidFrame(input: {
    readonly observation_id: string;
    readonly reason: InvalidFrameReason;
  }): void;
  tick(tick: UnflaggedTick): void;
}

/** Frame tal como llega del transporte, con ID y recepción ya inyectados. */
export interface FrameInput {
  readonly connection_id: string;
  readonly observation_id: string;
  readonly payload_utf8: string;
  readonly received_at_utc: string;
}

export type ReceiveOutcome =
  | { readonly position: number; readonly segment_index: number; readonly status: 'durable' }
  | { readonly status: 'input_closed' }
  | { readonly resource: string; readonly status: 'limit_exceeded' }
  | { readonly stage: string; readonly status: 'not_durable' };

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
  ): Promise<ReceiveOutcome> {
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

  async #append(event: SourceEvent, observedRef: string): Promise<ReceiveOutcome> {
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

    const raw = rawSourceFrameSchema.parse({
      connection_id: frame.connection_id,
      connector_version: this.#input.profile.connector_version,
      kind: 'raw_source_frame',
      observation_id: frame.observation_id,
      payload_utf8: frame.payload_utf8,
      // Hash sobre los bytes UTF-8 exactos; nunca se reserializa el payload.
      raw_payload_sha256: sha256Hex(frame.payload_utf8),
      received_at_utc: frame.received_at_utc,
      schema_version: CONTRACT_SCHEMA_VERSION,
      source: this.#input.profile.source,
    });
    const outcome = await this.#append(raw, raw.observation_id);
    if (outcome.status !== 'durable') {
      return outcome;
    }

    // Solo un raw durable se normaliza; el normalizador nunca modifica el raw.
    const normalized = normalizeRawFrame(raw, this.#input.profile);
    if (normalized.ok) {
      this.#input.sink.tick(normalized.tick);
      this.#emittedTicks += 1;
    } else {
      this.#input.sink.invalidFrame({
        observation_id: raw.observation_id,
        reason: normalized.reason,
      });
    }
    return outcome;
  }

  /**
   * Evento de conexión o recuperación. Con la entrada pausada se rechazan recuperaciones; se admite
   * el `ConnectionClosed` del cierre de la entrada si el log sigue sano, y un `ConnectionOpened`,
   * que reabre el log si había fallado y, al quedar durable, resuelve las condiciones operativas.
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
      try {
        this.#log = await this.#input.reopenLog();
        this.#logFailed = false;
      } catch (error) {
        return this.#onPersistenceFailure(
          new LogPersistenceError('source_event_index', failureReason(error), { cause: error }),
          event.event_id,
        );
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
