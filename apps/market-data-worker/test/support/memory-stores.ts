import {
  type DataQualityIncident,
  type DeploymentEnvironment,
  type PublishedManifestRecord,
} from '@buoh/contracts';

import { ObjectReadError, PublicationConflictError, PublicationError } from '../../src/errors.js';
import {
  type CommitPublicationInput,
  type MetadataStore,
  type ObjectStore,
} from '../../src/ports.js';

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

  putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
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
