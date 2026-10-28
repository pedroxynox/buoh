import { createCatalogResponseSchema } from '@buoh/domain';

import { RawFirstIngestor, type TickSink } from '../ingestion/raw-first-ingestor.js';
import {
  stderrAlert,
  type OperationalAlert,
  type OperationalRegistry,
} from '../operational/registry.js';
import { type SourceEventLog } from '../source-log/source-event-log.js';
import { DerivConnection, type DerivConnectionResult, type DerivSessionEnd } from './connection.js';
import { type CatalogStore, type RequestedResponseIncidentStore, type Scheduler } from './ports.js';
import { createDerivMeasurementProfile, DERIV_PUBLIC_ENDPOINT } from './profile.js';
import { encodeRequest, type DerivRequest } from './requests.js';
import {
  loadDerivSchemas,
  SCHEMA_DOWNLOAD_TIMEOUT_MS,
  type ExpectedSchemaArchive,
  type SchemaLoadResult,
} from './schema-archive.js';
import { type SocketFactory } from './socket.js';

export interface DerivAdapterInput {
  /** Alerta saneada si una incidencia de respuesta pedida no se puede guardar. */
  readonly alert?: OperationalAlert;
  readonly catalog: CatalogStore;
  readonly connect: SocketFactory;
  /** Tiempo de escucha desde el primer tick hasta pedir `forget_all`, en milisegundos. */
  readonly durationMs: number;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  /** Log de la fuente, ya abierto. */
  readonly log: SourceEventLog;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly registry: OperationalRegistry;
  readonly reopenLog: () => Promise<SourceEventLog>;
  readonly requestedResponses: RequestedResponseIncidentStore;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
  /** Pide `time` una vez para medir el desfase con el servidor (lo usa el smoke). */
  readonly serverTime: boolean;
  /** Recibe los ticks normalizados y los frames inválidos, ya durables. */
  readonly sink: TickSink;
  readonly symbol: string;
}

export interface DerivAdapterResult extends DerivConnectionResult {
  /** Release cargada, o `null` si la carga falló. */
  readonly schemas: { readonly archive_sha256: string; readonly release: string } | null;
}

/**
 * Las seis peticiones que se comprueban antes de conectar. `ticks_history` lleva un rango
 * representativo (`start` y `end` en 0): se comprueban la forma de la petición y el símbolo, y el
 * rango se conoce después.
 */
function connectionRequests(symbol: string): DerivRequest[] {
  return [
    { operation: 'active_symbols' },
    { operation: 'ticks', symbol },
    { end: 0, operation: 'ticks_history', start: 0, symbol },
    { operation: 'ping' },
    { operation: 'time' },
    { operation: 'forget_all' },
  ];
}

function notConnected(
  schemas: DerivAdapterResult['schemas'],
  end: DerivSessionEnd,
): DerivAdapterResult {
  return {
    catalog: null,
    closure: null,
    connection_id: null,
    end,
    schemas,
    server_time_offset_ms: null,
    subscription_id: null,
  };
}

/** Carga de esquemas con el tiempo máximo de ADR-0004 §7, medido con el temporizador inyectado. */
async function loadSchemas(input: DerivAdapterInput): Promise<SchemaLoadResult> {
  const controller = new AbortController();
  const cancel = input.scheduler.schedule(SCHEMA_DOWNLOAD_TIMEOUT_MS, () => {
    controller.abort();
  });
  const last = input.log.lastEventId;
  try {
    return await loadDerivSchemas({
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      fetch: input.fetch,
      nextId: input.nextId,
      now: input.now,
      registry: input.registry,
      related_refs: last === null ? [] : [last],
      signal: controller.signal,
      ...(input.schemaUrl === undefined ? {} : { url: input.schemaUrl }),
    });
  } finally {
    cancel();
  }
}

/**
 * Adaptador público de Deriv (`F1-SOURCE-001`, ADR-0012): carga los esquemas de la release fijada,
 * comprueba las peticiones con ellos, arma el perfil de medición y el `RawFirstIngestor`, repara el
 * cierre que le falte a la conexión anterior del log y sigue una conexión, que supera a esa, hasta
 * su cierre (ADR-0015 §3). Si los esquemas no cargan, nunca se conecta (salud `failed`); si el cierre
 * reparado no queda durable, tampoco (salud `paused`).
 */
export async function runDerivAdapter(input: DerivAdapterInput): Promise<DerivAdapterResult> {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new TypeError('durationMs debe ser un entero positivo de milisegundos.');
  }
  const loaded = await loadSchemas(input);
  if (loaded.status === 'failed') {
    return notConnected(null, { detail: loaded.detail, reason: loaded.reason, status: 'failed' });
  }
  const { schemas } = loaded;
  const summary = { archive_sha256: schemas.archive_sha256, release: schemas.release };

  // Antes de conectar: si una petición propia no cumple su esquema (por ejemplo, un símbolo con
  // caracteres que `ticks` no admite), no tiene sentido abrir la conexión.
  const invalid = connectionRequests(input.symbol).find(
    (request) => encodeRequest(schemas, request, 1) === null,
  );
  if (invalid !== undefined) {
    return notConnected(summary, {
      detail: invalid.operation,
      reason: 'request_invalid',
      status: 'failed',
    });
  }

  const profile = createDerivMeasurementProfile({ schemas, symbol: input.symbol });
  const ingestor = new RawFirstIngestor({
    log: input.log,
    nextId: input.nextId,
    now: input.now,
    profile,
    registry: input.registry,
    reopenLog: input.reopenLog,
    sink: input.sink,
  });
  // Antes del socket: la conexión anterior sale del log, nunca de la memoria (ADR-0015 §3).
  const repair = await ingestor.repairUnrecordedClose({ affected_symbols: [input.symbol] });
  if (repair.status === 'not_durable') {
    return notConnected(summary, {
      detail: repair.stage,
      reason: 'persistence_unavailable',
      status: 'paused',
    });
  }
  const connection = new DerivConnection({
    alert: input.alert ?? stderrAlert,
    catalog: input.catalog,
    catalogSchema: createCatalogResponseSchema({
      source_schema_bytes: schemas.schema('active_symbols', 'response').bytes,
      source_schema_release: schemas.release,
    }),
    connect: input.connect,
    durationMs: input.durationMs,
    // Siempre el canal público fijado en ADR-0004 §2: no hay forma de apuntar a otro host.
    endpoint: DERIV_PUBLIC_ENDPOINT,
    ingestor,
    nextId: input.nextId,
    now: input.now,
    profile,
    requestedResponses: input.requestedResponses,
    scheduler: input.scheduler,
    schemas,
    serverTime: input.serverTime,
    supersedes_connection_id: repair.connection_id,
    symbol: input.symbol,
  });
  return { ...(await connection.run()), schemas: summary };
}
