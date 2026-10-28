import { gunzipSync } from 'node:zlib';

import { canonicalJson, sha256Hex, sourceEventSchema, type SourceEvent } from '@buoh/contracts';
import {
  appendSegmentStats,
  EMPTY_SEGMENT_STATS,
  evaluateSegmentRotation,
  SEGMENT_POLICY,
  sourceEventLine,
  sourceEventTime,
  type SegmentCloseReason,
  type SegmentStats,
} from '@buoh/domain';

import { createStorageEncoder } from '../encoding.js';
import { contentKey } from '../object-keys.js';
import { type ObjectStore } from '../ports.js';
import {
  type ClosedSourceSegment,
  type SourceEventIndexRow,
  type SourceLogStore,
} from './ports.js';

/** Etapa de `PersistenceStage` que falló en el log. */
export type LogStage = 'raw_object_write' | 'source_event_index';

/** La durabilidad no se pudo confirmar; el evento no cuenta como durable. */
export class LogPersistenceError extends Error {
  readonly reason: string;
  readonly stage: LogStage;

  constructor(stage: LogStage, reason: string, options?: { cause?: unknown }) {
    super(`Durabilidad no confirmada en ${stage}: ${reason}`, options);
    this.name = 'LogPersistenceError';
    this.reason = reason;
    this.stage = stage;
  }
}

/**
 * Motivo sanitizado de un fallo de almacenamiento: código o nombre del error, nunca su mensaje
 * (podría incluir payloads, rutas o credenciales).
 */
export function failureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    for (const candidate of [code, name]) {
      if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(candidate)) {
        return candidate;
      }
    }
  }
  return 'unknown_error';
}

/**
 * Al leerlo, el contenido durable del log no pasa sus comprobaciones: un objeto alterado, un hash o
 * unos conteos que no cuadran, un segmento que no se descomprime, una línea que no es un source
 * event JCS o segmentos que no están todos cerrados. No se reintenta con ese contenido (ADR-0004
 * §12). Es un `TypeError`, como esas comprobaciones antes, y conserva sus mensajes.
 */
export class LogIntegrityError extends TypeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LogIntegrityError';
  }
}

/**
 * Al leer el log, no respondió un almacén: el de objetos o el índice. No dice nada del contenido,
 * así que se puede reintentar. `reason` es el motivo saneado (`failureReason`).
 */
export class LogReadError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Lectura del log no disponible: ${reason}`, options);
    this.name = 'LogReadError';
    this.reason = reason;
  }
}

/** Lectura de un almacén del log: si falla, lanza `LogReadError`. */
async function fromStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new LogReadError(failureReason(error), { cause: error });
  }
}

/** Comprobación de lo leído: lo que lance `check` es un `LogIntegrityError`, con el mismo mensaje. */
function verified<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contenido del log inválido.';
    throw new LogIntegrityError(message, { cause: error });
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function eventId(event: SourceEvent): string {
  return event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;
}

function joinLines(lines: readonly Uint8Array[]): Uint8Array {
  const total = lines.reduce((sum, line) => sum + line.byteLength + 1, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const line of lines) {
    bytes.set(line, offset);
    offset += line.byteLength;
    bytes[offset] = 0x0a;
    offset += 1;
  }
  return bytes;
}

/**
 * Escribe un objeto content-addressed y lo relee: solo cuenta como escrito si los bytes guardados
 * tienen el tamaño y el SHA-256 esperados. Lo usan el log y el catálogo.
 */
export async function writeVerified(
  objects: ObjectStore,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await objects.putIfAbsent(key, bytes, contentType);
  const stored = await objects.get(key, bytes.byteLength);
  if (stored.byteLength !== bytes.byteLength || sha256Hex(stored) !== sha256Hex(bytes)) {
    throw Object.assign(new Error('El objeto almacenado no coincide con su hash.'), {
      code: 'object_verification_failed',
    });
  }
}

function parseLine(bytes: Uint8Array): SourceEvent {
  const text = decoder.decode(bytes);
  const event = sourceEventSchema.parse(JSON.parse(text));
  if (canonicalJson(event) !== text) {
    throw new TypeError('La línea del source event no es JCS.');
  }
  return event;
}

export interface OpenSourceEventLogInput {
  readonly objects: ObjectStore;
  readonly source: string;
  readonly store: SourceLogStore;
  /** Versión de zlib del writer gzip de segmentos (`process.versions.zlib` en runtime). */
  readonly zlibVersion: string;
}

/**
 * Log append-only de source events (F1-STREAM-001, ADR-0005 §4). Un evento solo es durable cuando
 * su línea JCS está en un objeto content-addressed verificado (`raw_object_write`) **y** su fila en
 * `source_event_index` está confirmada (`source_event_index`). Los segmentos rotan según
 * `segment_policy_version = 1.0.0`; al cerrar, el NDJSON del segmento se escribe en gzip.
 *
 * Tras cualquier fallo de persistencia la instancia queda inválida: el estado en memoria podría no
 * coincidir con el durable, así que se debe reabrir desde los almacenes con `open`.
 */
export class SourceEventLog {
  readonly source: string;
  readonly #objects: ObjectStore;
  readonly #store: SourceLogStore;
  readonly #encode: ReturnType<typeof createStorageEncoder>;
  #segmentIndex: number;
  #lines: Uint8Array[];
  #stats: SegmentStats;
  #lastEventTime: string | null;
  #lastEventId: string | null;
  #lastRawObservationId: string | null;
  #totalEventCount: number;
  #failed = false;

  private constructor(
    input: OpenSourceEventLogInput,
    state: {
      lastEventId: string | null;
      lastEventTime: string | null;
      lastRawObservationId: string | null;
      lines: Uint8Array[];
      segmentIndex: number;
      stats: SegmentStats;
      totalEventCount: number;
    },
  ) {
    this.source = input.source;
    this.#objects = input.objects;
    this.#store = input.store;
    this.#encode = createStorageEncoder(input.zlibVersion);
    this.#segmentIndex = state.segmentIndex;
    this.#lines = state.lines;
    this.#stats = state.stats;
    this.#lastEventTime = state.lastEventTime;
    this.#lastEventId = state.lastEventId;
    this.#lastRawObservationId = state.lastRawObservationId;
    this.#totalEventCount = state.totalEventCount;
  }

  /**
   * Abre el log desde el estado durable: continúa el segmento no finalizado releyendo y
   * verificando cada objeto de sus eventos (runbook, «Inicio», paso 3–4).
   */
  static async open(input: OpenSourceEventLogInput): Promise<SourceEventLog> {
    const state = await input.store.readLogState(input.source);
    const segmentIndex =
      state.openRows[0]?.segment_index ??
      (state.lastClosed === null ? 0 : state.lastClosed.segment_index + 1);
    const lines: Uint8Array[] = [];
    let stats = EMPTY_SEGMENT_STATS;
    let lastEventTime: string | null = state.lastClosed?.last_event_time_utc ?? null;
    for (const [index, row] of state.openRows.entries()) {
      if (row.segment_index !== segmentIndex || row.position !== index) {
        throw new TypeError(`Segmento abierto no contiguo en la posición ${String(index)}.`);
      }
      const bytes = await input.objects.get(contentKey(row.object_sha256), row.byte_length);
      if (bytes.byteLength !== row.byte_length || sha256Hex(bytes) !== row.object_sha256) {
        throw new TypeError(`Objeto del source event ${row.event_id} alterado o incompleto.`);
      }
      const event = parseLine(bytes);
      if (eventId(event) !== row.event_id || event.source !== input.source) {
        throw new TypeError(`El objeto no corresponde al source event ${row.event_id}.`);
      }
      lines.push(bytes);
      stats = appendSegmentStats(stats, event);
      lastEventTime = sourceEventTime(event);
    }
    return new SourceEventLog(input, {
      lastEventId: state.lastEventId,
      lastEventTime,
      lastRawObservationId: state.lastRawObservationId,
      lines,
      segmentIndex,
      stats,
      totalEventCount: state.totalEventCount,
    });
  }

  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  get lastRawObservationId(): string | null {
    return this.#lastRawObservationId;
  }

  get openSegmentIndex(): number {
    return this.#segmentIndex;
  }

  get openSegmentStats(): SegmentStats {
    return this.#stats;
  }

  get totalEventCount(): number {
    return this.#totalEventCount;
  }

  #assertUsable(): void {
    if (this.#failed) {
      throw new TypeError(
        'El log tuvo un fallo de persistencia; reábrelo con SourceEventLog.open.',
      );
    }
  }

  #fail(stage: LogStage, error: unknown): never {
    this.#failed = true;
    throw new LogPersistenceError(stage, failureReason(error), { cause: error });
  }

  /**
   * Añade un source event de forma durable. Si la política lo exige, primero cierra el segmento
   * actual. Devuelve la posición durable; ante un fallo lanza `LogPersistenceError`.
   */
  async append(
    input: SourceEvent,
  ): Promise<{ closed: ClosedSourceSegment | null; position: number; segment_index: number }> {
    this.#assertUsable();
    const event = sourceEventSchema.parse(input);
    if (event.source !== this.source) {
      throw new TypeError(`Source event de otra fuente: ${event.source}.`);
    }
    const reason = evaluateSegmentRotation(this.#stats, event);
    const closed = reason === null ? null : await this.close(reason);

    const line = sourceEventLine(event);
    const digest = sha256Hex(line);
    try {
      await writeVerified(this.#objects, contentKey(digest), line, 'application/json');
    } catch (error) {
      this.#fail('raw_object_write', error);
    }
    const row: SourceEventIndexRow = {
      byte_length: line.byteLength,
      event_id: eventId(event),
      event_time_utc: sourceEventTime(event),
      kind: event.kind,
      object_sha256: digest,
      position: this.#stats.event_count,
      segment_index: this.#segmentIndex,
      source: this.source,
    };
    try {
      await this.#store.insertIndexRow(row);
    } catch (error) {
      // Un resultado ambiguo nunca se interpreta como durable (ADR-0004 §12).
      this.#fail('source_event_index', error);
    }

    this.#lines.push(line);
    this.#stats = appendSegmentStats(this.#stats, event);
    this.#lastEventTime = row.event_time_utc;
    this.#lastEventId = row.event_id;
    if (event.kind === 'raw_source_frame') {
      this.#lastRawObservationId = event.observation_id;
    }
    this.#totalEventCount += 1;
    return { closed, position: row.position, segment_index: row.segment_index };
  }

  /** Cierra el segmento abierto (si tiene eventos): objeto gzip verificado y fila de cierre. */
  async close(reason: SegmentCloseReason): Promise<ClosedSourceSegment | null> {
    this.#assertUsable();
    const first = this.#stats.first_event_time_utc;
    if (this.#stats.event_count === 0 || first === null || this.#lastEventTime === null) {
      return null;
    }
    const logical = joinLines(this.#lines);
    const encoded = this.#encode({
      artifact_id: 'source_events:000000',
      logical_bytes: logical,
      role: 'source_events',
    });
    const objectDigest = sha256Hex(encoded.bytes);
    try {
      await writeVerified(
        this.#objects,
        contentKey(objectDigest),
        encoded.bytes,
        encoded.compression === 'gzip' ? 'application/gzip' : 'application/x-ndjson',
      );
    } catch (error) {
      this.#fail('raw_object_write', error);
    }
    const segment: ClosedSourceSegment = {
      byte_count: this.#stats.byte_count,
      close_reason: reason,
      compression: encoded.compression,
      event_count: this.#stats.event_count,
      first_event_time_utc: first,
      last_event_time_utc: this.#lastEventTime,
      logical_content_sha256: sha256Hex(logical),
      object_bytes_sha256: objectDigest,
      object_size_bytes: encoded.bytes.byteLength,
      raw_frame_count: this.#stats.raw_frame_count,
      segment_index: this.#segmentIndex,
      segment_policy_version: SEGMENT_POLICY.version,
      source: this.source,
      writer_name: encoded.writer_name ?? null,
      writer_version: encoded.writer_version ?? null,
    };
    try {
      await this.#store.insertClosedSegment(segment);
    } catch (error) {
      this.#fail('source_event_index', error);
    }
    this.#segmentIndex += 1;
    this.#lines = [];
    this.#stats = EMPTY_SEGMENT_STATS;
    return segment;
  }

  /**
   * Todos los source events durables del log, agrupados por segmento y en orden: los cerrados,
   * leídos y verificados como en `readClosedSegments`, y al final el abierto, si tiene eventos, desde
   * las líneas que esta instancia releyó al abrirse o escribió. Es la entrada de `deriveMarketData`
   * y de la conexión anterior (ADR-0015 §3). Tras un fallo de persistencia falla: lo que la instancia
   * tiene en memoria podría no ser lo durable. Como `readClosedSegments`, lanza `LogReadError` si un
   * almacén no responde y `LogIntegrityError` si el contenido no pasa sus comprobaciones.
   */
  async readDurableSegments(): Promise<SourceEvent[][]> {
    this.#assertUsable();
    // Se copia antes de esperar: lo que se escriba mientras se leen los cerrados no entra.
    const openIndex = this.#segmentIndex;
    const openLines = [...this.#lines];
    const closed = openIndex === 0 ? [] : await this.readClosedSegments(0, openIndex - 1);
    return openLines.length === 0
      ? closed
      : [...closed, openLines.map((line) => verified(() => parseLine(line)))];
  }

  /**
   * Lee los segmentos cerrados `[from, to]` desde sus objetos, verificando hash físico, hash
   * lógico, conteos y forma de cada línea. Es el input de una publicación. Si un almacén no responde,
   * lanza `LogReadError`; si el contenido no pasa una comprobación, `LogIntegrityError`.
   */
  async readClosedSegments(from: number, to: number): Promise<SourceEvent[][]> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
      throw new TypeError('Rango de segmentos inválido.');
    }
    const segments = await fromStore(() => this.#store.listClosedSegments(this.source, from, to));
    if (
      segments.length !== to - from + 1 ||
      segments.some((item, index) => item.segment_index !== from + index)
    ) {
      throw new LogIntegrityError(
        `Los segmentos ${String(from)}–${String(to)} no están todos cerrados.`,
      );
    }
    const result: SourceEvent[][] = [];
    for (const segment of segments) {
      const physical = await fromStore(() =>
        this.#objects.get(contentKey(segment.object_bytes_sha256), segment.object_size_bytes),
      );
      if (sha256Hex(physical) !== segment.object_bytes_sha256) {
        throw new LogIntegrityError(
          `Objeto del segmento ${String(segment.segment_index)} alterado.`,
        );
      }
      const logical =
        segment.compression === 'gzip'
          ? verified(
              () =>
                new Uint8Array(
                  gunzipSync(physical, { maxOutputLength: SEGMENT_POLICY.maximum_bytes }),
                ),
            )
          : physical;
      if (sha256Hex(logical) !== segment.logical_content_sha256) {
        throw new LogIntegrityError(
          `Hash lógico del segmento ${String(segment.segment_index)} inválido.`,
        );
      }
      const text = verified(() => decoder.decode(logical));
      if (!text.endsWith('\n')) {
        throw new LogIntegrityError(`Segmento ${String(segment.segment_index)} sin newline final.`);
      }
      const events = text
        .slice(0, -1)
        .split('\n')
        .map((line) => verified(() => parseLine(new TextEncoder().encode(line))));
      if (
        events.length !== segment.event_count ||
        events.filter((event) => event.kind === 'raw_source_frame').length !==
          segment.raw_frame_count
      ) {
        throw new LogIntegrityError(
          `Conteos del segmento ${String(segment.segment_index)} inválidos.`,
        );
      }
      result.push(events);
    }
    return result;
  }
}
