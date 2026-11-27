import {
  DATA_DATASETS_LIMIT,
  DATA_EVENTS_LIMIT,
  type DataDataset,
  type DataDatasets,
  type DataEvent,
  type DataEvents,
  type DataHealth,
  type DeploymentEnvironment,
  isBatchManifestCore,
} from '@buoh/contracts';
import {
  DatasetIntegrityError,
  DERIV_SOURCE,
  isLogExpired,
  listCaptureLogs,
  R_100_SEQUENCE,
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
   * las incidencias y las condiciones de los logs de R_100, y las publicaciones de este entorno de
   * `buoh_datasets`, que no vencen (ADR-0020 §10), agrupados por secuencia, los
   * `DATA_EVENTS_LIMIT` más recientes de cada una (ADR-0021 §5). Rechaza con el error de PostgreSQL
   * si no responde, con `DataEventIntegrityError` si una fila no pasa sus comprobaciones, y con
   * `LogsUnreadableError` si hay logs y el rol no puede leer ninguno.
   */
  events(): Promise<DataEvents>;
  /**
   * Los datasets publicados en este entorno (`DataDatasets`, ADR-0020 §10), de `buoh_datasets`,
   * agrupados por secuencia, los `DATA_DATASETS_LIMIT` más recientes de cada una (ADR-0021 §5), con
   * su período, sus conteos, cómo terminaron, sus incidencias, la última verificación de cada modo
   * y, en los de los lotes, sus velas, horarios, ofertas y cotizaciones. No lee R2. Sin el esquema, ninguno. Rechaza
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
    batch: batchOf(core),
  };
}

/**
 * Lo que solo tiene un core 1.1.0, el de un dataset de los lotes (ADR-0021 §3), o `null` con uno
 * 1.0.0. El contrato del core pone esos campos exactamente en un 1.1.0.
 */
function batchOf(core: StoredPublishedDataset['core']): DataDataset['batch'] {
  if (!isBatchManifestCore(core)) {
    return null;
  }
  const batch = {
    candle_time_from_utc: core.candle_time_from_utc,
    candle_time_to_utc: core.candle_time_to_utc,
    market_candle_count: core.market_candle_count,
    trading_session_count: core.trading_session_count,
    contract_offer_count: core.contract_offer_count,
    contract_quote_count: core.contract_quote_count,
  };
  // `readPublishedDatasets` ya validó el core, así que esto no pasa; si pasara, no se inventa nada.
  if (Object.values(batch).some((value) => value === undefined)) {
    throw new DatasetIntegrityError();
  }
  return batch as NonNullable<DataDataset['batch']>;
}

/** Lo que va en cada secuencia, en el orden en que llega. */
function groupBy<T>(items: readonly T[], sequenceOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const sequence = sequenceOf(item);
    const group = groups.get(sequence);
    if (group === undefined) {
      groups.set(sequence, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

/** Por el nombre de la secuencia, en el orden de las unidades UTF-16, como pide el contrato. */
function bySequenceName<T>([a]: readonly [string, T], [b]: readonly [string, T]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createDataReader(deps: DataReaderDeps): DataReader {
  return {
    datasets: async () => {
      // De cada secuencia, uno más que el límite: así se sabe si quedan otros fuera.
      const stored = await readPublishedDatasets(deps.pool, {
        source: DERIV_SOURCE,
        environment: deps.environment,
        limitPerSequence: DATA_DATASETS_LIMIT + 1,
      });
      const groups = [...groupBy(stored, (dataset) => dataset.sequence)].sort(bySequenceName);
      return {
        sequences: groups.map(([sequence, datasets]) => ({
          sequence,
          datasets: datasets.slice(0, DATA_DATASETS_LIMIT).map(datasetOf),
          truncated: datasets.length > DATA_DATASETS_LIMIT,
        })),
      };
    },
    events: async () => {
      // Los logs que se leen son los de R_100 (`listCaptureLogs`; ADR-0019 §8, precisión del PR 3
      // de ADR-0021), así que sus eventos van en esa secuencia.
      const logs = await readableCaptureLogs(deps);
      const now = new Date(deps.clock()).toISOString();
      const read = logs
        .filter((log) => log.readable && !isLogExpired(log, now))
        .map((log) => log.location)
        .sort((a, b) => b.number - a.number);
      const fromLogs: DataEvent[] = [];
      for (const log of read) {
        // Una fila más que el límite en cada clase: así se sabe si quedan otras fuera.
        const stored = await readLogDataEvents(deps.pool, log, {
          source: DERIV_SOURCE,
          limit: DATA_EVENTS_LIMIT + 1,
        });
        fromLogs.push(...eventsOf(log.number, stored));
      }
      // Las publicaciones salen de `buoh_datasets`, también las de un log que ya venció: los
      // datasets no vencen (ADR-0020 §6 y §10). Cada una va en la secuencia de su dataset, y de
      // cada secuencia se leen una más que el límite (ADR-0021 §5).
      const publications = await readDatasetPublications(deps.pool, {
        source: DERIV_SOURCE,
        environment: deps.environment,
        limitPerSequence: DATA_EVENTS_LIMIT + 1,
      });
      const groups = groupBy(publications, (publication) => publication.sequence);
      const live = R_100_SEQUENCE.name;
      const sequences = new Map<string, DataEvent[]>(
        [...groups].map(([sequence, list]) => [sequence, list.map(publicationEvent)]),
      );
      if (read.length > 0 || fromLogs.length > 0) {
        sequences.set(live, [...fromLogs, ...(sequences.get(live) ?? [])]);
      }
      return {
        sequences: [...sequences].sort(bySequenceName).map(([sequence, events]) => {
          events.sort(newestFirst);
          return {
            sequence,
            logs: sequence === live ? read.map((log) => log.number) : [],
            events: events.slice(0, DATA_EVENTS_LIMIT),
            truncated: events.length > DATA_EVENTS_LIMIT,
          };
        }),
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
