import { type DataQualityIncident, type SourceCatalogSnapshot } from '@buoh/contracts';

/**
 * Temporizador inyectado (ADR-0004 §4). El adaptador nunca llama a `setTimeout` directamente, así
 * que las pruebas avanzan el tiempo a mano.
 */
export interface Scheduler {
  /** Llama a `callback` dentro de `ms` milisegundos y devuelve la función que lo cancela. */
  schedule(ms: number, callback: () => void): () => void;
}

export interface CatalogVersion {
  readonly snapshot: SourceCatalogSnapshot;
  /** Versión contigua por fuente y formato de catálogo: 1, 2, 3… */
  readonly version: number;
}

/**
 * Versiones del catálogo de una fuente (ADR-0012 §7). Solo guarda snapshots válidos. La
 * implementación en PostgreSQL y almacenamiento de objetos llega con el PR 6 de F1.4b.
 */
export interface CatalogStore {
  /** Última versión guardada, o `null` si la fuente todavía no tiene ninguna. */
  latest(
    source: string,
    catalogFormat: SourceCatalogSnapshot['catalog_format'],
  ): Promise<CatalogVersion | null>;
  /**
   * Guarda el snapshot como versión nueva solo si su `content_sha256` difiere del de la última
   * versión; volver a un contenido anterior también crea versión. Si no difiere, no guarda nada.
   * Devuelve la versión vigente después de la llamada.
   */
  record(snapshot: SourceCatalogSnapshot): Promise<{
    readonly status: 'created' | 'unchanged';
    readonly version: number;
  }>;
}

/**
 * Incidencias de respuestas pedidas (ADR-0012 §6): fuera de los datasets y del registro operativo,
 * porque no abren condiciones ni cambian la salud. La tabla PostgreSQL llega con el PR 6.
 */
export interface RequestedResponseIncidentStore {
  append(incident: DataQualityIncident): Promise<void>;
}
