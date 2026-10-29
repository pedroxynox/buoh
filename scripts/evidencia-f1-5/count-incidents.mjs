// Evidencia de la puerta de salida de Fase 1 (ADR-0015 §12, puntos 7 y 8). No es un comando del
// producto.
//
// Uso, desde la raíz del repositorio y con el worker compilado:
//
//   node scripts/evidencia-f1-5/count-incidents.mjs [--symbol R_100] [--delivered <archivo>]...
//
// Con las mismas variables `BUOH_*` que la captura (`ingest`), lee el log durable de `deriv_options`
// solo para leer, como `data:health`: `observeDataHealth` sobre `openHealthStores`, que nunca toman
// el bloqueo ni escriben. Deriva del log, con el perfil de medición que arma esa lectura con el
// esquema de fuente guardado, las incidencias y condiciones (`deriveMarketData`, de `@buoh/domain`)
// y escribe una sola línea JSON en stdout con conteos, tipos, estados, motivos e IDs, nunca precios
// ni payloads. Con `--delivered`, cada archivo lleva un `observation_id` por línea (los ticks que
// entregó el sink de `capture.mjs`), y la línea dice cuántos son un `raw_source_frame` durable del
// log (punto 7).
//
// Salida 0 si pudo leer el log; 1 si la lectura terminó en las reglas 2 o 3 de `data:health` (la
// línea lleva `observation` y `reason`) o la derivación falló; 2 con argumentos inválidos.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import {
  createUuidV7Generator,
  loadConfig,
  observeDataHealth,
  openHealthStores,
} from '../../apps/market-data-worker/dist/index.js';
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
  if (observation.status !== 'observed') {
    exitCode = 1;
    line = { observation: observation.status, reason: observation.reason };
  } else {
    const events = observation.segments.flat();
    const recoveries = events.filter((event) => event.kind === 'history_recovery_result');
    line = {
      connections: connectionsOf(events),
      events: events.length,
      events_by_kind: countBy(events.map((event) => event.kind)),
      heartbeat_connection_state: observation.latestHeartbeat?.connection_state ?? null,
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
      segments: observation.segments.length,
      writer_present: observation.writerPid !== null,
    };
    if (observation.profile !== null && events.length > 0) {
      try {
        const derived = deriveMarketData(observation.segments, observation.profile);
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
} finally {
  await stores.close();
}
console.log(JSON.stringify({ observed_at_utc: new Date().toISOString(), ...line }));
process.exitCode = exitCode;
