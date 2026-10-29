// Evidencia de la puerta de salida de Fase 1 (ADR-0015 §12, puntos 1, 3, 4 y 7). No es un comando
// del producto: lo arranca `drills.mjs` como proceso hijo, para poder pararlo con `SIGTERM` o matarlo
// con `SIGKILL`.
//
// Uso, desde la raíz del repositorio y con el worker compilado:
//
//   node scripts/evidencia-f1-5/capture.mjs --ticks-file <archivo> [--symbol R_100]
//
// Corre la sesión de ingesta de Deriv con el cableado de `ingest` (`ingestCommand` y `runIngest` en
// `apps/market-data-worker/src/ingest.ts`, y `src/cli/ingest.ts`): las variables `BUOH_*` con las
// reglas de `ingest` (`checkIngestConfig`), los almacenes de `openStores`, las migraciones
// comprobadas sin aplicar nada, el bloqueo de PostgreSQL (`PostgresSessionLockProvider`), el log
// protegido por él (`openLockedSourceLog`), el cursor y el latido, la retención de 23 horas, el
// esquema de fuente guardado, `ws`, el temporizador real, el azar de `node:crypto` e IDs UUIDv7.
// `SIGINT` o `SIGTERM` piden la parada una sola vez, como en `ingest`.
//
// Solo cambia el sink: `runIngest` no entrega los ticks a nadie, y aquí cada tick que entrega la
// sesión deja su `observation_id` en `--ticks-file`, una línea por tick, con una escritura síncrona,
// para que una caída (`SIGKILL`) no pierda los ya entregados. Nunca escribe precios. Al terminar
// escribe en stdout una línea JSON con los campos del resultado de `ingest` y los conteos del sink.
// Salida 0 si la sesión terminó `completed`, 1 si terminó `failed` y 2 con argumentos,
// configuración o migraciones que `ingest` rechaza.
import { appendFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

import {
  checkIngestConfig,
  createUuidV7Generator,
  INGEST_RETENTION_MS,
  loadConfig,
  openLockedSourceLog,
  OperationalRegistry,
  openStores,
  pendingMigrations,
  PostgresSessionLockProvider,
} from '../../apps/market-data-worker/dist/index.js';
import { realScheduler } from '../../apps/market-data-worker/dist/cli/scheduler.js';
import {
  DERIV_CONNECTOR_VERSION,
  DERIV_SOURCE,
} from '../../apps/market-data-worker/dist/deriv/profile.js';
import { startDerivSession } from '../../apps/market-data-worker/dist/deriv/session.js';
import { openWsSocket } from '../../apps/market-data-worker/dist/deriv/socket.js';

/** Valores de un entero aleatorio de 32 bits: dividido por este número, queda en [0, 1). */
const RANDOM_RANGE = 2 ** 32;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

const fail = (exitCode, fields) => {
  console.log(JSON.stringify({ ...fields, status: 'failed' }));
  process.exit(exitCode);
};

/** Una recuperación pedida, como en el resultado de `ingest`, sin horas ni precios. */
function recoveryOf(outcome) {
  if (outcome.status === 'abandoned') {
    return {
      attempts: null,
      durable: false,
      pages: null,
      reason: null,
      recovered_event_count: null,
      status: 'abandoned',
    };
  }
  const { result } = outcome;
  return {
    attempts: outcome.attempts,
    durable: outcome.durable,
    pages: outcome.pages,
    reason: result.status === 'complete' ? null : result.reason,
    recovered_event_count: result.status === 'unavailable' ? null : result.recovered_event_count,
    status: result.status,
  };
}

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      symbol: { default: 'R_100', type: 'string' },
      'ticks-file': { type: 'string' },
    },
  }));
  if (options['ticks-file'] === undefined) {
    throw new TypeError('Falta --ticks-file.');
  }
} catch (error) {
  fail(2, { code: 'UsageError', message: error.message });
}

let config;
try {
  config = loadConfig(process.env);
  checkIngestConfig(config);
} catch (error) {
  // `ConfigError` e `IngestConfigError` nombran las variables, nunca sus valores.
  fail(2, { code: error.name, message: error.message });
}

const ticksFile = options['ticks-file'];
const counts = { invalid_frames: 0, ticks_delivered: 0 };
const startedAt = new Date().toISOString();
const stores = openStores(config);
let exitCode = 1;
let line;
try {
  const pending = await pendingMigrations(stores.pool);
  if (pending.length > 0) {
    fail(2, { code: 'MIGRATIONS_PENDING', pending });
  }
  const registry = await OperationalRegistry.open({
    source: DERIV_SOURCE,
    store: stores.operational,
  });
  const session = startDerivSession({
    catalog: stores.catalog,
    connect: openWsSocket,
    fetch: globalThis.fetch,
    lock: new PostgresSessionLockProvider({ postgres: config.postgres, source: DERIV_SOURCE }),
    nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
    now: () => new Date().toISOString(),
    openLog: (lock) =>
      openLockedSourceLog(lock, {
        objects: stores.objects,
        source: DERIV_SOURCE,
        store: stores.sourceLog,
        zlibVersion: process.versions.zlib,
      }),
    random: () => randomInt(RANDOM_RANGE) / RANDOM_RANGE,
    registry,
    requestedResponses: stores.requestedResponses,
    retentionMs: INGEST_RETENTION_MS,
    scheduler: realScheduler,
    schemaObjects: stores.objects,
    serverTime: false,
    sink: {
      invalidFrame: () => {
        counts.invalid_frames += 1;
      },
      // Solo el `observation_id`: el tick lleva la cotización, que no sale de aquí.
      tick: (tick) => {
        appendFileSync(ticksFile, `${tick.observation_id}\n`);
        counts.ticks_delivered += 1;
      },
    },
    status: stores.ingestionStatus,
    symbol: options.symbol,
  });
  let stopAsked = false;
  const onSignal = () => {
    if (!stopAsked) {
      stopAsked = true;
      session.stop();
    }
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  let result;
  try {
    result = await session.done;
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  }
  exitCode = result.end.status === 'completed' ? 0 : 1;
  line = {
    connections: result.connections,
    connector_version: DERIV_CONNECTOR_VERSION,
    end: result.end,
    finished_at_utc: new Date().toISOString(),
    recoveries: result.recoveries.map(recoveryOf),
    schemas: result.schemas,
    sink: counts,
    source: DERIV_SOURCE,
    started_at_utc: startedAt,
    status: result.end.status,
    stopped_for_retention: result.stopped_for_retention,
    symbol: options.symbol,
    waits_ms: result.waits_ms,
  };
} catch (error) {
  line = { code: 'UNEXPECTED', message: error instanceof Error ? error.name : 'Error' };
  line.status = 'failed';
} finally {
  await stores.close();
}
console.log(JSON.stringify(line));
process.exitCode = exitCode;
