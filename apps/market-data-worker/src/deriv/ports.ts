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
 * Versiones del catálogo de una fuente (ADR-0012 §7). Solo guarda snapshots válidos. En
 * PostgreSQL y almacenamiento de objetos: `PostgresCatalogStore` (migración `0003`).
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
   *
   * Un snapshot sale de un solo frame, así que es como mucho una versión: guardar otra vez un
   * snapshot ya guardado (mismo `snapshot_id`) que no es el de la última versión falla.
   */
  record(snapshot: SourceCatalogSnapshot): Promise<{
    readonly status: 'created' | 'unchanged';
    readonly version: number;
  }>;
}

/**
 * Incidencias de respuestas pedidas (ADR-0012 §6): fuera de los datasets y del registro operativo,
 * porque no abren condiciones ni cambian la salud. En PostgreSQL:
 * `PostgresRequestedResponseIncidentStore` (tabla `requested_response_incidents`, migración `0003`).
 */
export interface RequestedResponseIncidentStore {
  append(incident: DataQualityIncident): Promise<void>;
}
