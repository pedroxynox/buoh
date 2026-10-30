// Evidencia de la puerta de salida de Fase 1 (ADR-0015 §12, puntos 5 a 8). No es un comando del
// producto.
//
// Uso, desde la raíz del repositorio y con el worker compilado:
//
//   node scripts/evidencia-f1-5/count-incidents.mjs [--symbol R_100] [--delivered <archivo>]...
//
// Con las mismas variables `BUOH_*` que la captura (`ingest`), observa `deriv_options` como
// `data:health` (`observeDataHealth` sobre `openHealthStores`, que nunca toman el bloqueo ni
// escriben) y después lee aparte el log durable entero, también solo para leer: `SourceEventLog`
// sobre almacenes que rechazan toda escritura, con `readDurableSegments`. Desde el PR 5 de ADR-0017
// §11, `data:health` parte del último punto de control y ya no da los eventos del log; leerlo
// entero vale para las capturas de minutos de los ensayos. Deriva del log, con el perfil de medición
// que arma la observación con el esquema de fuente guardado, las incidencias y condiciones
// (`deriveMarketData`, de `@buoh/domain`) y escribe una sola línea JSON en stdout con conteos, tipos,
// estados, motivos, IDs y el PID de PostgreSQL del escritor vivo y del último latido, nunca precios
// ni payloads. Con `--delivered`,
// cada archivo lleva un `observation_id` por línea (los ticks que entregó el sink de `capture.mjs`),
// y la línea dice cuántos son un `raw_source_frame` durable del log (punto 7).
//
// Aparte del log, `operational` cuenta todo lo que guarda el registro operativo de la fuente
// (incidencias por tipo, etapa y motivo, y condiciones por tipo y acción), leído con la misma
// lectura que usa `data:health`. Como solo necesita PostgreSQL, sale también con el almacenamiento
// de objetos parado (punto 5); si PostgreSQL no responde, dice `unavailable` y el motivo saneado.
//
// Salida 0 si pudo leer el log; 1 si la observación terminó en las reglas 2 o 3 de `data:health` (la
// línea lleva `observation` y `reason`), si no pudo leer el log entero (`log_read`, con el motivo
// saneado) o si la derivación falló; 2 con argumentos inválidos.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import {
  createUuidV7Generator,
  failureReason,
  loadConfig,
  LogIntegrityError,
  LogReadError,
  observeDataHealth,
  openHealthStores,
  OperationalRegistry,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/index.js';
import { DERIV_SOURCE } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { deriveMarketData } from '../../packages/domain/dist/index.js';

/** Cuenta cada valor de `values`, con las claves ordenadas. */
function countBy(values) {
  const counts = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Las conexiones del log, en orden: apertura, la que supera y su cierre, sin precios. */
function connectionsOf(events) {
  const byId = new Map();
  for (const event of events) {
    if (event.kind === 'connection_opened') {
      byId.set(event.connection_id, {
        closed_at_utc: null,
        closure_reason: null,
        closure_type: null,
        connection_id: event.connection_id,
        opened_at_utc: event.occurred_at_utc,
        supersedes_connection_id: event.supersedes_connection_id,
      });
    } else if (event.kind === 'connection_closed') {
      const entry = byId.get(event.connection_id) ?? {
        connection_id: event.connection_id,
        opened_at_utc: null,
        supersedes_connection_id: null,
      };
      byId.set(event.connection_id, {
        ...entry,
        closed_at_utc: event.occurred_at_utc,
        closure_reason: event.reason,
        closure_type: event.closure_type,
      });
    }
  }
  return [...byId.values()];
}

/** Los `observation_id` de los archivos de `--delivered`, comprobados contra los frames durables. */
function deliveredCheck(files, events) {
  const durable = new Set(
    events.filter((event) => event.kind === 'raw_source_frame').map((e) => e.observation_id),
  );
  const ids = files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  const unique = new Set(ids);
  const missing = [...unique].filter((id) => !durable.has(id));
  return {
    delivered: ids.length,
    durable: [...unique].filter((id) => durable.has(id)).length,
    files: files.length,
    missing: missing.length,
    missing_ids: missing.slice(0, 20),
    unique: unique.size,
  };
}

/** No escribe nunca: el log y el registro operativo se abren aquí solo para leerlos. */
const refuseWrite = () => Promise.reject(new TypeError('count-incidents solo lee.'));

/**
 * Los segmentos del log durable de la fuente, cerrados y abierto, leídos enteros y verificados,
 * con el log abierto como lo abre `data:health`: sobre almacenes que rechazan toda escritura.
 */
async function durableSegments(stores) {
  const { objects, sourceLog } = stores;
  const log = await SourceEventLog.open({
    objects: {
      bucket: objects.bucket,
      get: (key, maxBytes) => objects.get(key, maxBytes),
      putIfAbsent: refuseWrite,
    },
    source: DERIV_SOURCE,
    store: {
      hasSourceEvent: (source, eventId) => sourceLog.hasSourceEvent(source, eventId),
      insertClosedSegment: refuseWrite,
      insertIndexRow: refuseWrite,
      insertLiveCheckpoint: refuseWrite,
      listClosedSegments: (source, from, to) => sourceLog.listClosedSegments(source, from, to),
      readLiveCheckpoint: (source, versionsSha256, below) =>
        sourceLog.readLiveCheckpoint(source, versionsSha256, below),
      readLogState: (source) => sourceLog.readLogState(source),
    },
    // Solo para cerrar segmentos, que esta lectura nunca hace.
    zlibVersion: 'count-incidents-read-only',
  });
  return log.readDurableSegments();
}

/**
 * Lo que guarda el registro operativo de la fuente, contado: incidencias por tipo y por
 * `tipo:etapa:motivo` (la etapa, o el recurso de un límite, y el motivo saneado de su evidencia),
 * condiciones por `tipo:acción`, motivos de resolución y los tipos que siguen abiertos, como los
 * deja `OperationalRegistry`. Si PostgreSQL no responde, `unavailable` y el motivo saneado.
 */
async function operationalSummary(stores) {
  let loaded;
  try {
    loaded = await stores.operational.load(DERIV_SOURCE);
  } catch (error) {
    return { reason: failureReason(error), status: 'unavailable' };
  }
  const registry = await OperationalRegistry.open({
    source: DERIV_SOURCE,
    store: { append: refuseWrite, load: () => Promise.resolve(loaded) },
  });
  const { conditions, incidents } = loaded;
  return {
    conditions_by_type: countBy(
      conditions.map((condition) => `${condition.condition_type}:${condition.action}`),
    ),
    incidents_by_stage: countBy(
      incidents.map(
        (incident) =>
          `${incident.incident_type}:${incident.evidence?.stage ?? incident.evidence?.resource ?? ''}:${incident.evidence?.reason ?? ''}`,
      ),
    ),
    incidents_by_type: countBy(incidents.map((incident) => incident.incident_type)),
    open_condition_types: registry.openConditionTypes(),
    resolution_reasons: countBy(
      conditions
        .filter((condition) => condition.action === 'resolved')
        .map((condition) => condition.resolution_reason),
    ),
    status: 'loaded',
  };
}

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      delivered: { multiple: true, type: 'string' },
      symbol: { default: 'R_100', type: 'string' },
    },
  }));
} catch (error) {
  console.error(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // `ConfigError` nombra las variables, nunca sus valores.
  console.error(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
  process.exit(2);
}
const stores = openHealthStores(config);
let line;
let exitCode = 0;
try {
  const observation = await observeDataHealth({
    environment: config.environment,
    nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
    now: () => new Date().toISOString(),
    stores,
    symbol: options.symbol,
  });
  let segments = null;
  if (observation.status === 'observed') {
    try {
      segments = await durableSegments(stores);
    } catch (error) {
      // Un almacén que no responde o un contenido que no pasa sus comprobaciones, como en
      // `data:health`; cualquier otro error es de programación.
      if (error instanceof LogReadError) {
        line = { log_read: { reason: error.reason, status: 'failed' }, observation: 'observed' };
      } else if (error instanceof LogIntegrityError) {
        line = {
          log_read: { reason: 'log_not_derivable', status: 'failed' },
          observation: 'observed',
        };
      } else {
        throw error;
      }
      exitCode = 1;
    }
  }
  if (observation.status !== 'observed') {
    exitCode = 1;
    line = { observation: observation.status, reason: observation.reason };
  } else if (segments !== null) {
    const events = segments.flat();
    const recoveries = events.filter((event) => event.kind === 'history_recovery_result');
    line = {
      connections: connectionsOf(events),
      events: events.length,
      events_by_kind: countBy(events.map((event) => event.kind)),
      heartbeat_connection_state: observation.latestHeartbeat?.connection_state ?? null,
      heartbeat_observed_at_utc: observation.latestHeartbeat?.observed_at_utc ?? null,
      heartbeat_pg_backend_pid: observation.latestHeartbeat?.pg_backend_pid ?? null,
      latest_cursor_present: observation.latestCursor !== null,
      observation: 'observed',
      operational_open_condition_types: [...observation.operationalConditionTypes],
      profile_present: observation.profile !== null,
      recoveries: recoveries.map((event) => ({
        connection_id: event.connection_id,
        reason: event.status === 'complete' ? null : event.reason,
        recovered_event_count: event.status === 'unavailable' ? null : event.recovered_event_count,
        status: event.status,
      })),
      recoveries_by_status: countBy(recoveries.map((event) => event.status)),
      segments: segments.length,
      writer_pid: observation.writerPid,
      writer_present: observation.writerPid !== null,
    };
    if (observation.profile !== null && events.length > 0) {
      try {
        const derived = deriveMarketData(segments, observation.profile);
        line.derivation = {
          conditions_by_type: countBy(
            derived.conditions.map(
              (condition) => `${condition.condition_type}:${condition.action}`,
            ),
          ),
          incidents_by_type: countBy(derived.incidents.map((incident) => incident.incident_type)),
          open_condition_types: derived.openConditionTypes,
          pending_continuity_symbols: derived.pendingContinuitySymbols,
          pending_gaps: derived.pendingGaps.length,
          status: 'derived',
          ticks: derived.ticks.length,
        };
      } catch (error) {
        exitCode = 1;
        line.derivation = {
          reason: error instanceof Error ? error.name : 'Error',
          status: 'failed',
        };
      }
    } else {
      line.derivation = null;
    }
    if (options.delivered !== undefined) {
      line.delivered_ticks = deliveredCheck(options.delivered, events);
    }
  }
  line.operational = await operationalSummary(stores);
} finally {
  await stores.close();
}
console.log(JSON.stringify({ observed_at_utc: new Date().toISOString(), ...line }));
process.exitCode = exitCode;
