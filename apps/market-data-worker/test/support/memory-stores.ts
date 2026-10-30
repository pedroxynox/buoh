import {
  type DataQualityIncident,
  type DeploymentEnvironment,
  type OperationalConditionEvent,
  type PublishedManifestRecord,
  type SourceCatalogSnapshot,
} from '@buoh/contracts';

import { type CatalogVersion } from '../../src/deriv/ports.js';
import { PublicationConflictError, PublicationError } from '../../src/errors.js';
import {
  type IngestionCursorVersion,
  type IngestionHeartbeat,
} from '../../src/ingestion/status.js';
import {
  InMemoryCatalogStore,
  InMemoryIngestionStatusStore,
  InMemoryObjectStore,
  InMemoryOperationalStore,
  InMemoryRequestedResponseIncidentStore,
  InMemorySourceLogStore,
} from '../../src/memory/stores.js';
import { type CommitPublicationInput, type MetadataStore } from '../../src/ports.js';
import {
  type ClosedSourceSegment,
  type LiveCheckpointCandidate,
  type LiveCheckpointInsert,
  type SourceEventIndexRow,
  type StoredLiveCheckpoint,
} from '../../src/source-log/ports.js';

/**
 * Dobles de prueba: los almacenes en memoria de `src/memory/stores.ts`, con las mismas reglas que
 * PostgreSQL y el almacenamiento de objetos, más puntos de fallo inyectables.
 */

/** Almacenamiento de objetos en memoria con puntos de fallo inyectables. */
export class MemoryObjectStore extends InMemoryObjectStore {
  /** Devuelve true para hacer fallar la escritura de esa clave. */
  failPut: (key: string) => boolean = () => false;
  /** Permite alterar los bytes leídos (simula almacenamiento corrupto o incoherente). */
  onRead: (key: string, bytes: Uint8Array) => Uint8Array = (_key, bytes) => bytes;

  constructor(bucket = 'buoh-test', objects = new Map<string, Uint8Array>()) {
    super(bucket, objects);
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

  override putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    const armed = this.#armedFailure;
    if (armed !== null) {
      this.#armedFailure = null;
      return Promise.reject(Object.assign(new Error(`Fallo armado: ${armed}`), { code: armed }));
    }
    if (this.failPut(key)) {
      return Promise.reject(new Error(`Fallo inyectado al escribir ${key}`));
    }
    return super.putIfAbsent(key, bytes);
  }

  override async get(key: string, maxBytes: number): Promise<Uint8Array> {
    return this.onRead(key, await super.get(key, maxBytes));
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

/** Log raw-first en memoria con las invariantes de `0002_log_raw_first` y fallos inyectables. */
export class MemorySourceLogStore extends InMemorySourceLogStore {
  /** Devuelve true para hacer fallar la inserción de esa fila de índice. */
  failIndex: (row: SourceEventIndexRow) => boolean = () => false;
  /**
   * Devuelve true para insertar esa fila y aun así informar un error: el índice la confirmó, pero
   * quien escribe no lo sabe (un resultado ambiguo, ADR-0004 §12). Al reabrir, el log la adopta.
   */
  failIndexAfterInsert: (row: SourceEventIndexRow) => boolean = () => false;
  failClose = false;

  override async insertIndexRow(row: SourceEventIndexRow): Promise<void> {
    if (this.failIndex(row)) {
      throw Object.assign(new Error('Fallo inyectado'), { code: 'synthetic_index_failure' });
    }
    await super.insertIndexRow(row);
    if (this.failIndexAfterInsert(row)) {
      throw Object.assign(new Error('Fallo inyectado tras insertar'), {
        code: 'synthetic_index_ambiguous',
      });
    }
  }

  override insertClosedSegment(segment: ClosedSourceSegment): Promise<void> {
    if (this.failClose) {
      return Promise.reject(
        Object.assign(new Error('Fallo inyectado'), { code: 'synthetic_close_failure' }),
      );
    }
    return super.insertClosedSegment(segment);
  }

  /** Devuelve true para hacer fallar la inserción de ese punto de control del estado vivo. */
  failCheckpoint: (row: StoredLiveCheckpoint) => boolean = () => false;
  /**
   * Devuelve true para insertar ese punto de control y aun así informar un error: la fila quedó
   * guardada, pero quien escribe no lo sabe (un resultado ambiguo, ADR-0017 §5).
   */
  failCheckpointAfterInsert: (row: StoredLiveCheckpoint) => boolean = () => false;
  /** Hace fallar la lectura de los puntos de control, como un PostgreSQL que no responde. */
  failCheckpointReads = false;
  #checkpointGate: Promise<void> | null = null;

  /**
   * Retiene las inserciones de puntos de control hasta `release`, como un PostgreSQL lento: las que
   * llegan mientras tanto esperan, ya pasado el bloqueo.
   */
  holdCheckpointWrites(): { readonly release: () => void } {
    const gate = Promise.withResolvers<undefined>();
    this.#checkpointGate = gate.promise;
    return {
      release: () => {
        this.#checkpointGate = null;
        gate.resolve(undefined);
      },
    };
  }

  override async insertLiveCheckpoint(row: StoredLiveCheckpoint): Promise<LiveCheckpointInsert> {
    await this.#checkpointGate;
    if (this.failCheckpoint(row)) {
      throw Object.assign(new Error('Fallo inyectado'), { code: 'synthetic_checkpoint_failure' });
    }
    const result = await super.insertLiveCheckpoint(row);
    if (this.failCheckpointAfterInsert(row)) {
      throw Object.assign(new Error('Fallo inyectado tras insertar'), {
        code: 'synthetic_checkpoint_ambiguous',
      });
    }
    return result;
  }

  override readLiveCheckpoint(
    source: string,
    versionsSha256: string,
    below: number | null,
  ): Promise<LiveCheckpointCandidate | null> {
    if (this.failCheckpointReads) {
      return Promise.reject(Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' }));
    }
    return super.readLiveCheckpoint(source, versionsSha256, below);
  }
}

/** Registro operativo en memoria; `failAppend` simula PostgreSQL no disponible. */
export class MemoryOperationalStore extends InMemoryOperationalStore {
  failAppend = false;

  override append(input: {
    conditions: readonly OperationalConditionEvent[];
    incidents: readonly DataQualityIncident[];
  }): Promise<void> {
    if (this.failAppend) {
      return Promise.reject(Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' }));
    }
    return super.append(input);
  }
}

/** Versiones del catálogo en memoria; `failNext` simula PostgreSQL no disponible una vez. */
export class MemoryCatalogStore extends InMemoryCatalogStore {
  failNext = false;

  #maybeFail(): Promise<void> {
    if (!this.failNext) {
      return Promise.resolve();
    }
    this.failNext = false;
    return Promise.reject(Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' }));
  }

  override async latest(
    source: string,
    catalogFormat: SourceCatalogSnapshot['catalog_format'],
  ): Promise<CatalogVersion | null> {
    await this.#maybeFail();
    return super.latest(source, catalogFormat);
  }

  override async record(snapshot: SourceCatalogSnapshot): Promise<{
    readonly status: 'created' | 'unchanged';
    readonly version: number;
  }> {
    await this.#maybeFail();
    return super.record(snapshot);
  }
}

/** Incidencias de respuestas pedidas en memoria; `failAppend` simula PostgreSQL no disponible. */
export class MemoryRequestedResponseIncidentStore extends InMemoryRequestedResponseIncidentStore {
  failAppend = false;

  override append(incident: DataQualityIncident): Promise<void> {
    if (this.failAppend) {
      return Promise.reject(Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' }));
    }
    return super.append(incident);
  }
}

/**
 * Cursor y latido en memoria (`InMemoryIngestionStatusStore`), con fallos inyectables: cada uno
 * simula que PostgreSQL no responde, con el error de `failure`.
 */
export class MemoryIngestionStatusStore extends InMemoryIngestionStatusStore {
  /** El error de cada fallo inyectado; por defecto, uno con el código `ECONNREFUSED`. */
  failure: () => Error = () =>
    Object.assign(new Error('Fallo inyectado'), { code: 'ECONNREFUSED' });
  /** Cada `appendCursor` falla mientras sea `true`. */
  failCursorWrites = false;
  /** Cada `appendHeartbeat` falla mientras sea `true`. */
  failHeartbeatWrites = false;
  /** Las próximas `n` lecturas (`latestCursor` o `cursorSymbols`) fallan. */
  failReads = 0;
  #gate: Promise<void> | null = null;

  /** Retiene las escrituras hasta `release`: cada una espera y después se guarda o falla. */
  holdWrites(): { readonly release: () => void } {
    const gate = Promise.withResolvers<undefined>();
    this.#gate = gate.promise;
    return {
      release: () => {
        this.#gate = null;
        gate.resolve(undefined);
      },
    };
  }

  #read(): Promise<void> {
    if (this.failReads === 0) {
      return Promise.resolve();
    }
    this.failReads -= 1;
    return Promise.reject(this.failure());
  }

  override async appendCursor(
    ...args: Parameters<InMemoryIngestionStatusStore['appendCursor']>
  ): Promise<IngestionCursorVersion> {
    await this.#gate;
    if (this.failCursorWrites) {
      throw this.failure();
    }
    return super.appendCursor(...args);
  }

  override async appendHeartbeat(heartbeat: IngestionHeartbeat): Promise<void> {
    await this.#gate;
    if (this.failHeartbeatWrites) {
      throw this.failure();
    }
    await super.appendHeartbeat(heartbeat);
  }

  override async latestCursor(source: string, symbol: string) {
    await this.#read();
    return super.latestCursor(source, symbol);
  }

  override async cursorSymbols(source: string) {
    await this.#read();
    return super.cursorSymbols(source);
  }
}
