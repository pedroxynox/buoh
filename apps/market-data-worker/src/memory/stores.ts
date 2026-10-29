import {
  sourceCatalogSnapshotSchema,
  type DataQualityIncident,
  type IngestionCursor,
  type OperationalConditionEvent,
  type SourceCatalogSnapshot,
} from '@buoh/contracts';

import {
  parseRequestedResponseIncident,
  type CatalogStore,
  type CatalogVersion,
  type RequestedResponseIncidentStore,
} from '../deriv/ports.js';
import { ObjectReadError } from '../errors.js';
import {
  ingestionHeartbeatSchema,
  parseIngestionCursor,
  type IngestionCursorVersion,
  type IngestionHeartbeat,
  type IngestionStatusStore,
} from '../ingestion/status.js';
import { type OperationalStore } from '../operational/registry.js';
import { type ObjectStore } from '../ports.js';
import {
  type ClosedSourceSegment,
  type SourceEventIndexRow,
  type SourceLogState,
  type SourceLogStore,
} from '../source-log/ports.js';

/**
 * Almacenes en memoria con las mismas reglas que los de PostgreSQL y almacenamiento de objetos:
 * triggers de `0002`, `0003` y `0004`, claves únicas y validación de lo que se guarda. Los usa
 * `data:smoke`, que no escribe nada fuera de su proceso (ADR-0012 §10): todo se borra al terminar.
 * Las pruebas les añaden fallos inyectables en `test/support/memory-stores.ts`.
 */

/** Objetos por clave; nunca reemplaza una clave existente. */
export class InMemoryObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly objects: Map<string, Uint8Array>;

  constructor(bucket = 'buoh-memory', objects = new Map<string, Uint8Array>()) {
    this.bucket = bucket;
    this.objects = objects;
  }

  /** El tipo de contenido no se guarda: en memoria no hace falta. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    if (this.objects.has(key)) {
      return Promise.resolve('exists');
    }
    this.objects.set(key, Uint8Array.from(bytes));
    return Promise.resolve('created');
  }

  get(key: string, maxBytes: number): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      return Promise.reject(new ObjectReadError('not_found', key));
    }
    if (stored.byteLength > maxBytes) {
      return Promise.reject(new ObjectReadError('too_large', key));
    }
    return Promise.resolve(Uint8Array.from(stored));
  }
}

/** Log raw-first con las mismas invariantes que los triggers de `0002_log_raw_first`. */
export class InMemorySourceLogStore implements SourceLogStore {
  readonly rows: SourceEventIndexRow[] = [];
  readonly closed: ClosedSourceSegment[] = [];

  readLogState(source: string): Promise<SourceLogState> {
    const closed = this.closed.filter((segment) => segment.source === source);
    const lastClosed = closed.at(-1) ?? null;
    const openIndex = lastClosed === null ? 0 : lastClosed.segment_index + 1;
    const rows = this.rows.filter((row) => row.source === source);
    return Promise.resolve({
      lastClosed,
      lastEventId: rows.at(-1)?.event_id ?? null,
      lastRawObservationId:
        rows.filter((row) => row.kind === 'raw_source_frame').at(-1)?.event_id ?? null,
      openRows: rows.filter((row) => row.segment_index === openIndex),
      totalEventCount: rows.length,
    });
  }

  insertIndexRow(row: SourceEventIndexRow): Promise<void> {
    const inSegment = this.rows.filter(
      (item) => item.source === row.source && item.segment_index === row.segment_index,
    );
    const closedHere = this.closed.some(
      (item) => item.source === row.source && item.segment_index === row.segment_index,
    );
    const previousClosed =
      row.segment_index === 0 ||
      this.closed.some(
        (item) => item.source === row.source && item.segment_index === row.segment_index - 1,
      );
    if (
      closedHere ||
      row.position !== inSegment.length ||
      (row.position === 0 && !previousClosed) ||
      this.rows.some((item) => item.event_id === row.event_id)
    ) {
      return Promise.reject(new Error('Fila de índice inválida.'));
    }
    this.rows.push(row);
    return Promise.resolve();
  }

  insertClosedSegment(segment: ClosedSourceSegment): Promise<void> {
    const rows = this.rows.filter(
      (item) => item.source === segment.source && item.segment_index === segment.segment_index,
    );
    if (
      rows.length !== segment.event_count ||
      rows.filter((row) => row.kind === 'raw_source_frame').length !== segment.raw_frame_count
    ) {
      return Promise.reject(new Error('Conteos del segmento inválidos.'));
    }
    this.closed.push(segment);
    return Promise.resolve();
  }

  listClosedSegments(source: string, from: number, to: number): Promise<ClosedSourceSegment[]> {
    return Promise.resolve(
      this.closed.filter(
        (segment) =>
          segment.source === source && segment.segment_index >= from && segment.segment_index <= to,
      ),
    );
  }
}

/** Registro operativo: incidencias y condiciones de una o varias fuentes. */
export class InMemoryOperationalStore implements OperationalStore {
  readonly incidents: DataQualityIncident[] = [];
  readonly conditions: OperationalConditionEvent[] = [];

  load(source: string) {
    return Promise.resolve({
      conditions: this.conditions.filter((item) => item.source === source),
      incidents: this.incidents.filter((item) => item.source === source),
    });
  }

  append(input: {
    conditions: readonly OperationalConditionEvent[];
    incidents: readonly DataQualityIncident[];
  }): Promise<void> {
    this.incidents.push(...input.incidents);
    this.conditions.push(...input.conditions);
    return Promise.resolve();
  }
}

/**
 * Versiones del catálogo con las reglas de `source_catalog_versions` (ADR-0012 §7): versión nueva
 * solo si cambia el `content_sha256` respecto de la última, y un snapshot es como mucho una versión.
 */
export class InMemoryCatalogStore implements CatalogStore {
  readonly versions: CatalogVersion[] = [];

  #latest(source: string, catalogFormat: string): CatalogVersion | null {
    return (
      this.versions
        .filter(
          (item) =>
            item.snapshot.source === source && item.snapshot.catalog_format === catalogFormat,
        )
        .at(-1) ?? null
    );
  }

  latest(
    source: string,
    catalogFormat: SourceCatalogSnapshot['catalog_format'],
  ): Promise<CatalogVersion | null> {
    return Promise.resolve(this.#latest(source, catalogFormat));
  }

  record(input: SourceCatalogSnapshot): Promise<{
    readonly status: 'created' | 'unchanged';
    readonly version: number;
  }> {
    return Promise.resolve().then(() => {
      // Como `PostgresCatalogStore`: solo guarda un snapshot que cumple su contrato.
      const snapshot = sourceCatalogSnapshotSchema.parse(input);
      const last = this.#latest(snapshot.source, snapshot.catalog_format);
      if (last !== null && last.snapshot.content_sha256 === snapshot.content_sha256) {
        return { status: 'unchanged' as const, version: last.version };
      }
      // Como `snapshot_id` único en `source_catalog_versions`.
      if (this.versions.some((item) => item.snapshot.snapshot_id === snapshot.snapshot_id)) {
        throw Object.assign(new Error('Snapshot ya guardado'), { code: '23505' });
      }
      const version = (last?.version ?? 0) + 1;
      this.versions.push({ snapshot, version });
      return { status: 'created' as const, version };
    });
  }
}

/** Incidencias de respuestas pedidas; la misma incidencia no se guarda dos veces, como en PostgreSQL. */
export class InMemoryRequestedResponseIncidentStore implements RequestedResponseIncidentStore {
  readonly incidents: DataQualityIncident[] = [];

  append(input: DataQualityIncident): Promise<void> {
    return Promise.resolve().then(() => {
      // Como `PostgresRequestedResponseIncidentStore`: solo la forma de ADR-0012 §6.
      const incident = parseRequestedResponseIncident(input);
      if (!this.incidents.some((item) => item.incident_id === incident.incident_id)) {
        this.incidents.push(incident);
      }
    });
  }
}

/**
 * Cursor y latido con las reglas de `ingestion_cursors` e `ingestion_heartbeats` (migración `0004`,
 * ADR-0015 §6): versiones del cursor contiguas desde 1 por fuente y símbolo, un `heartbeat_id` como
 * mucho una vez, y el último latido es el último escrito.
 */
export class InMemoryIngestionStatusStore implements IngestionStatusStore {
  readonly cursors: IngestionCursorVersion[] = [];
  readonly heartbeats: IngestionHeartbeat[] = [];

  #latestCursor(source: string, symbol: string): IngestionCursorVersion | null {
    return (
      this.cursors
        .filter((item) => item.cursor.source === source && item.cursor.symbol === symbol)
        .at(-1) ?? null
    );
  }

  appendCursor(input: IngestionCursor): Promise<IngestionCursorVersion> {
    return Promise.resolve().then(() => {
      // Como `PostgresIngestionStatusStore`: solo un IngestionCursor 1.0.0 válido.
      const cursor = parseIngestionCursor(input);
      const last = this.#latestCursor(cursor.source, cursor.symbol);
      const stored = { cursor, version: (last?.version ?? 0) + 1 };
      this.cursors.push(stored);
      return stored;
    });
  }

  latestCursor(source: string, symbol: string): Promise<IngestionCursorVersion | null> {
    return Promise.resolve(this.#latestCursor(source, symbol));
  }

  cursorSymbols(source: string): Promise<string[]> {
    const symbols = this.cursors
      .filter((item) => item.cursor.source === source)
      .map((item) => item.cursor.symbol);
    return Promise.resolve([...new Set(symbols)].sort());
  }

  appendHeartbeat(input: IngestionHeartbeat): Promise<void> {
    return Promise.resolve().then(() => {
      const heartbeat = ingestionHeartbeatSchema.parse(input);
      // Como la clave primaria `heartbeat_id` de `ingestion_heartbeats`.
      if (this.heartbeats.some((item) => item.heartbeat_id === heartbeat.heartbeat_id)) {
        throw Object.assign(new Error('Latido ya guardado'), { code: '23505' });
      }
      this.heartbeats.push(heartbeat);
    });
  }

  latestHeartbeat(source: string): Promise<IngestionHeartbeat | null> {
    return Promise.resolve(this.heartbeats.filter((item) => item.source === source).at(-1) ?? null);
  }
}
