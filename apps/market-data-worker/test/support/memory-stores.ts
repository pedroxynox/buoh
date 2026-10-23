import {
  type DataQualityIncident,
  type DeploymentEnvironment,
  type OperationalConditionEvent,
  type PublishedManifestRecord,
} from '@buoh/contracts';

import { ObjectReadError, PublicationConflictError, PublicationError } from '../../src/errors.js';
import { type OperationalStore } from '../../src/operational/registry.js';
import {
  type CommitPublicationInput,
  type MetadataStore,
  type ObjectStore,
} from '../../src/ports.js';
import {
  type ClosedSourceSegment,
  type SourceEventIndexRow,
  type SourceLogState,
  type SourceLogStore,
} from '../../src/source-log/ports.js';

/** Almacenamiento de objetos en memoria con puntos de fallo inyectables. */
export class MemoryObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly objects: Map<string, Uint8Array>;
  /** Devuelve true para hacer fallar la escritura de esa clave. */
  failPut: (key: string) => boolean = () => false;
  /** Permite alterar los bytes leídos (simula almacenamiento corrupto o incoherente). */
  onRead: (key: string, bytes: Uint8Array) => Uint8Array = (_key, bytes) => bytes;

  constructor(bucket = 'buoh-test', objects = new Map<string, Uint8Array>()) {
    this.bucket = bucket;
    this.objects = objects;
  }

  #armedFailure: string | null = null;

  /** Arma un fallo para la siguiente escritura, con `code` = `reason` (se consume una vez). */
  armNextPutFailure(reason: string): void {
    if (this.#armedFailure !== null) {
      throw new TypeError('Ya hay un fallo armado sin consumir.');
    }
    this.#armedFailure = reason;
  }

  get hasArmedFailure(): boolean {
    return this.#armedFailure !== null;
  }

  putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    const armed = this.#armedFailure;
    if (armed !== null) {
      this.#armedFailure = null;
      return Promise.reject(Object.assign(new Error(`Fallo armado: ${armed}`), { code: armed }));
    }
    if (this.failPut(key)) {
      return Promise.reject(new Error(`Fallo inyectado al escribir ${key}`));
    }
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
    return Promise.resolve(this.onRead(key, Uint8Array.from(stored)));
  }
}

interface StoredRecord {
  readonly environment: DeploymentEnvironment;
  readonly record: PublishedManifestRecord;
}

/** Repositorio de metadatos en memoria con la misma semántica transaccional que PostgreSQL. */
export class MemoryMetadataStore implements MetadataStore {
  readonly datasets = new Map<string, string>();
  readonly incidents = new Map<string, DataQualityIncident[]>();
  readonly records: StoredRecord[] = [];
  failCommit = false;

  findActivePublication(
    datasetId: string,
    environment: DeploymentEnvironment,
  ): Promise<PublishedManifestRecord | null> {
    const active = this.records.filter(
      (entry) =>
        entry.environment === environment &&
        entry.record.dataset_id === datasetId &&
        entry.record.state === 'active',
    );
    return Promise.resolve(active[0]?.record ?? null);
  }

  async commitPublication(input: CommitPublicationInput): Promise<void> {
    if (this.failCommit) {
      throw new Error('Fallo inyectado en el commit');
    }
    const existing = this.datasets.get(input.record.dataset_id);
    const core = JSON.stringify(input.core);
    if (existing !== undefined && existing !== core) {
      throw new PublicationError('commit', 'El dataset existente tiene otro core.');
    }
    if ((await this.findActivePublication(input.record.dataset_id, input.environment)) !== null) {
      throw new PublicationConflictError(input.record.dataset_id);
    }
    // Todo o nada: se aplica solo después de validar.
    this.datasets.set(input.record.dataset_id, core);
    this.incidents.set(input.record.dataset_id, [...input.incidents]);
    this.records.push({ environment: input.environment, record: input.record });
  }
}

/** Log raw-first en memoria con las mismas invariantes que los triggers de `0002_log_raw_first`. */
export class MemorySourceLogStore implements SourceLogStore {
  readonly rows: SourceEventIndexRow[] = [];
  readonly closed: ClosedSourceSegment[] = [];
  /** Devuelve true para hacer fallar la inserción de esa fila de índice. */
  failIndex: (row: SourceEventIndexRow) => boolean = () => false;
  failClose = false;

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
    if (this.failIndex(row)) {
      return Promise.reject(
        Object.assign(new Error('Fallo inyectado'), { code: 'synthetic_index_failure' }),
      );
    }
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
    if (this.failClose) {
      return Promise.reject(
        Object.assign(new Error('Fallo inyectado'), { code: 'synthetic_close_failure' }),
      );
    }
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

/** Registro operativo en memoria; `failAppend` simula PostgreSQL no disponible. */
export class MemoryOperationalStore implements OperationalStore {
  readonly incidents: DataQualityIncident[] = [];
  readonly conditions: OperationalConditionEvent[] = [];
  failAppend = false;

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
    if (this.failAppend) {
      return Promise.reject(Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' }));
    }
    this.incidents.push(...input.incidents);
    this.conditions.push(...input.conditions);
    return Promise.resolve();
  }
}
