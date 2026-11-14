import {
  DATA_DATASETS_LIMIT,
  DATA_EVENTS_LIMIT,
  type DataDataset,
  type DataDatasets,
  type DataEvent,
  type DataEvents,
  type DataHealth,
  type DeploymentEnvironment,
} from '@buoh/contracts';
import {
  DERIV_SOURCE,
  isLogExpired,
  listCaptureLogs,
  readDatasetPublications,
  readLatestStoredHealth,
  readLogDataEvents,
  readPublishedDatasets,
  selectActiveLog,
  type CaptureLog,
  type LogDataEvents,
  type LogLocation,
  type StoredDataIncident,
  type StoredHealthObservation,
  type StoredPublication,
  type StoredPublishedDataset,
} from '@buoh/market-data-worker/lectura';
import type { Pool } from 'pg';

/**
 * Las lecturas del sistema de datos (ADR-0019 §8), con el código del worker por la ruta
 * `@buoh/market-data-worker/lectura` y el pool de `buoh_api_lectura`. Ninguna deriva el log entero
 * ni ejecuta `data:health`.
 */
export interface DataReader {
  /**
   * La salud de los datos: el log activo de la captura de Deriv y la última observación que guardó
   * `buoh-operaciones` en él (`DataHealth`). Rechaza con el error de PostgreSQL si no responde, con
   * `StoredHealthError` si el informe guardado no tiene su forma, y con `LogsUnreadableError` si hay
   * logs y el rol no puede leer ninguno.
   */
  health(): Promise<DataHealth>;
  /**
   * Los eventos de datos de los logs que no han vencido (`DataEvents`): las versiones del catálogo,
   * las incidencias y las condiciones, y las publicaciones de este entorno de `buoh_datasets`, que no
   * vencen (ADR-0020 §10), los `DATA_EVENTS_LIMIT` más recientes. Rechaza con el error de PostgreSQL si no responde, con `DataEventIntegrityError`
   * si una fila no pasa sus comprobaciones, y con `LogsUnreadableError` si hay logs y el rol no
   * puede leer ninguno.
   */
  events(): Promise<DataEvents>;
  /**
   * Los datasets publicados en este entorno (`DataDatasets`, ADR-0020 §10), de `buoh_datasets`, los
   * `DATA_DATASETS_LIMIT` más recientes, con su período, sus conteos, cómo terminaron, sus
   * incidencias y la última verificación de cada modo. No lee R2. Sin el esquema, ninguno. Rechaza
   * con el error de PostgreSQL si no responde o no se puede leer el esquema, y con
   * `DatasetIntegrityError` si una fila no pasa sus comprobaciones.
   */
  datasets(): Promise<DataDatasets>;
}

export interface DataReaderDeps {
  /** El pool de lectura (`createReaderPool`). */
  readonly pool: Pick<Pool, 'query'>;
  /** Milisegundos de pared: la hora con que se busca el log activo y se ven los logs vencidos. */
  readonly clock: () => number;
  /** El entorno de la API: los eventos solo traen las publicaciones de este entorno. */
  readonly environment: DeploymentEnvironment;
}

/**
 * Hay esquemas de log, pero el rol del pool no puede leer ninguno: por ejemplo, porque no tiene los
 * privilegios de `buoh_lectura` o porque el lector recibió otro pool. La búsqueda del log activo
 * toma un log que no se puede leer por uno que se está preparando (ADR-0018 §6), así que sin esto la
 * respuesta diría que no hay log activo.
 */
export class LogsUnreadableError extends Error {
  constructor() {
    super('Hay logs, pero el rol de lectura no puede leer ninguno.');
    this.name = 'LogsUnreadableError';
  }
}

function toContract(observation: StoredHealthObservation): NonNullable<DataHealth['observation']> {
  return observation.status === 'completed'
    ? {
        status: 'completed',
        observed_at_utc: observation.observedAtUtc,
        report: observation.report,
        alerts: observation.alerts.map(({ event, reason }) => ({ event, reason })),
      }
    : {
        status: 'failed',
        observed_at_utc: observation.observedAtUtc,
        reason: observation.reason,
        code: observation.code,
      };
}

/**
 * El log activo de la captura de Deriv (ADR-0018 §6), o `null`, y la hora con que se buscó. Como
 * `findActiveLog`: lee los logs y después toma la hora. Rechaza con `LogsUnreadableError` si hay
 * logs y el rol del pool no puede leer ninguno.
 */
export async function activeCaptureLog(
  deps: Pick<DataReaderDeps, 'clock' | 'pool'>,
): Promise<{ readonly log: LogLocation | null; readonly now: number }> {
  const logs = await readableCaptureLogs(deps);
  const now = deps.clock();
  return { log: selectActiveLog(logs, new Date(now).toISOString()), now };
}

/** Los logs de la captura de Deriv, o `LogsUnreadableError` si hay y el rol no puede leer ninguno. */
async function readableCaptureLogs(deps: Pick<DataReaderDeps, 'pool'>): Promise<CaptureLog[]> {
  const logs = await listCaptureLogs(deps.pool, DERIV_SOURCE);
  if (logs.length > 0 && logs.every((log) => !log.readable)) {
    throw new LogsUnreadableError();
  }
  return logs;
}

function incidentEvent(log: number, incident: StoredDataIncident): DataEvent {
  const base = {
    kind: 'incident',
    log,
    at_utc: incident.observed_at_utc,
    source: incident.source,
    incident_id: incident.incident_id,
    severity: incident.severity,
    symbol: incident.symbol,
  } as const;
  switch (incident.incident_type) {
    case 'persistence_unavailable':
      return {
        ...base,
        incident_type: incident.incident_type,
        evidence: { stage: incident.evidence.stage, reason: incident.evidence.reason },
      };
    case 'source_limit_exceeded':
      return {
        ...base,
        incident_type: incident.incident_type,
        evidence: {
          resource: incident.evidence.resource,
          unit: incident.evidence.unit,
          observed_value: incident.evidence.observed_value,
          maximum_value: incident.evidence.maximum_value,
        },
      };
    case 'invalid_source_frame':
      return {
        ...base,
        incident_type: incident.incident_type,
        evidence: {
          reason: incident.evidence.reason,
          raw_payload_sha256: incident.evidence.raw_payload_sha256,
        },
      };
  }
}

/** Una publicación de `buoh_datasets` en la forma de `DataEvents`, con el log de su dataset. */
function publicationEvent({ log, record, source }: StoredPublication): DataEvent {
  return {
    kind: 'publication',
    log,
    at_utc: record.published_at_utc,
    source,
    dataset_id: record.dataset_id,
    publication_id: record.publication_id,
    state: record.state,
  };
}

/** Los eventos de un log en la forma de `DataEvents`, sin las publicaciones. */
function eventsOf(log: number, stored: LogDataEvents): DataEvent[] {
  return [
    ...stored.catalogVersions.map((version): DataEvent => ({
      kind: 'catalog_version',
      log,
      at_utc: version.receivedAtUtc,
      source: version.source,
      version: version.version,
      snapshot_id: version.snapshotId,
      content_sha256: version.contentSha256,
      entry_count: version.entryCount,
    })),
    ...stored.incidents.map((incident) => incidentEvent(log, incident)),
    ...stored.conditions.map((condition): DataEvent => ({
      kind: 'condition',
      log,
      at_utc: condition.occurred_at_utc,
      source: condition.source,
      condition_event_id: condition.condition_event_id,
      condition_key: condition.condition_key,
      condition_type: condition.condition_type,
      symbol: condition.symbol,
      action: condition.action,
      resolution_reason: condition.action === 'resolved' ? condition.resolution_reason : null,
    })),
  ];
}

/**
 * Con la misma hora, una condición va antes que la incidencia que la abre, que se guarda en el mismo
 * instante: la lista va de lo más nuevo a lo más viejo, y la causa queda debajo.
 */
const KIND_ORDER: Readonly<Record<DataEvent['kind'], number>> = {
  condition: 0,
  incident: 1,
  publication: 2,
  catalog_version: 3,
};

function eventId(event: DataEvent): string {
  switch (event.kind) {
    case 'catalog_version':
      return event.snapshot_id;
    case 'publication':
      return event.publication_id;
    case 'incident':
      return event.incident_id;
    case 'condition':
      return event.condition_event_id;
  }
}

/** Del más nuevo al más viejo; con la misma hora, por log, por clase y por identificador. */
function newestFirst(a: DataEvent, b: DataEvent): number {
  if (a.at_utc !== b.at_utc) {
    return a.at_utc < b.at_utc ? 1 : -1;
  }
  if (a.log !== b.log) {
    return b.log - a.log;
  }
  if (a.kind !== b.kind) {
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  }
  const [idA, idB] = [eventId(a), eventId(b)];
  return idA < idB ? 1 : idA > idB ? -1 : 0;
}

/** Un dataset de `buoh_datasets` en la forma de `DataDatasets`. */
function datasetOf(stored: StoredPublishedDataset): DataDataset {
  const { core } = stored;
  return {
    dataset_id: stored.dataset_id,
    publication_id: stored.publication_id,
    published_at_utc: stored.published_at_utc,
    source: core.source,
    symbols: [...core.symbols],
    log: stored.log,
    first_segment: stored.first_segment,
    last_segment: stored.last_segment,
    event_time_from_utc: core.event_time_from_utc,
    event_time_to_utc: core.event_time_to_utc,
    source_event_count: core.source_event_count,
    raw_frame_count: core.raw_frame_count,
    normalized_tick_count: core.normalized_tick_count,
    incident_count: core.incident_count,
    condition_event_count: core.condition_event_count,
    quality_rule_version: core.quality_rule_version,
    quality_profile_id: core.quality_profile_id,
    clean: stored.clean,
    pending_continuity_symbols: [...stored.pending_continuity_symbols],
    open_condition_types: [...stored.open_condition_types],
    incidents: stored.incidents.map((item) => ({ ...item })),
    verifications: {
      verify_only:
        stored.verifications.verify_only === null ? null : { ...stored.verifications.verify_only },
      recompute:
        stored.verifications.recompute === null ? null : { ...stored.verifications.recompute },
    },
  };
}

export function createDataReader(deps: DataReaderDeps): DataReader {
  return {
    datasets: async () => {
      // Uno más que el límite: así se sabe si quedan otros fuera.
      const stored = await readPublishedDatasets(deps.pool, {
        source: DERIV_SOURCE,
        environment: deps.environment,
        limit: DATA_DATASETS_LIMIT + 1,
      });
      return {
        datasets: stored.slice(0, DATA_DATASETS_LIMIT).map(datasetOf),
        truncated: stored.length > DATA_DATASETS_LIMIT,
      };
    },
    events: async () => {
      const logs = await readableCaptureLogs(deps);
      const now = new Date(deps.clock()).toISOString();
      const read = logs
        .filter((log) => log.readable && !isLogExpired(log, now))
        .map((log) => log.location)
        .sort((a, b) => b.number - a.number);
      const events: DataEvent[] = [];
      for (const log of read) {
        // Una fila más que el límite en cada clase: así se sabe si quedan otras fuera.
        const stored = await readLogDataEvents(deps.pool, log, {
          source: DERIV_SOURCE,
          limit: DATA_EVENTS_LIMIT + 1,
        });
        events.push(...eventsOf(log.number, stored));
      }
      // Las publicaciones salen de `buoh_datasets`, también las de un log que ya venció: los
      // datasets no vencen (ADR-0020 §6 y §10).
      const publications = await readDatasetPublications(deps.pool, {
        source: DERIV_SOURCE,
        environment: deps.environment,
        limit: DATA_EVENTS_LIMIT + 1,
      });
      events.push(...publications.map(publicationEvent));
      events.sort(newestFirst);
      return {
        logs: read.map((log) => log.number),
        events: events.slice(0, DATA_EVENTS_LIMIT),
        truncated: events.length > DATA_EVENTS_LIMIT,
      };
    },
    health: async () => {
      const { log } = await activeCaptureLog(deps);
      if (log === null) {
        return { log: null, observation: null };
      }
      const observation = await readLatestStoredHealth(deps.pool, log);
      return {
        log: log.number,
        observation: observation === null ? null : toContract(observation),
      };
    },
  };
}
