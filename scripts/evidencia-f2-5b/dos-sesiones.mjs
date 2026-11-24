// Evidencia de memoria de dos sesiones de `ingest` (ADR-0021 §1, PR 2d). No es un comando del
// producto: lo arranca `medir-memoria.mjs` como proceso hijo, uno por medición.
//
// Uso, desde la raíz del repositorio, con el worker compilado y Node 24.22.0:
//
//   node scripts/evidencia-f2-5b/dos-sesiones.mjs --esquemas <schemas.zip>
//     --log R_100:<esquema>:<bucket> --log frxXAUUSD:<esquema>:<bucket>
//
// Corre en un solo proceso, a la vez, una sesión de ingesta por log, como `ingest` con varios
// símbolos (ADR-0021 §1): cada una con sus almacenes (`openStores` con su esquema), su registro
// operativo, el bloqueo de su secuencia (`PostgresSessionLockProvider` con `sequence`), su log
// protegido por él, su cursor y su latido, el esquema de fuente guardado y el punto de control de
// cada segmento cerrado (`writeLiveCheckpoints`), que reconstruye al arrancar si faltan. El log de
// R_100 lleva la fila de su perfil de publicación, como en producción, y el del oro, ninguna (perfil
// de medición, ADR-0021 §2). Cambia lo mismo que la sesión de la evidencia de F2.1 y nada de lo que se
// mide: la retención es de 8 días, el canal de Deriv es el falso de `sintetico.mjs`, `schemas.zip`
// sale de `--esquemas` y la espera entre intentos usa `random() = 0`.
//
// Mide el máximo de memoria residente del proceso entero con el `VmHWM` de `/proc/self/status`, en
// dos fases: `arranque`, desde el principio hasta que las dos sesiones abren su primera conexión (los
// esquemas, los bloqueos, los logs, las comprobaciones del arranque y la reconstrucción de los puntos
// de control que falten, las dos a la vez); y `conexion`, desde ahí hasta que cada una recibe 3 ticks
// y las dos paran. Cifras en KiB. Escribe en stdout una línea JSON con las fases, el resultado
// saneado de cada sesión y sus alertas contadas, nunca precios ni payloads. Salida 0 si las dos
// terminaron `completed`, 1 si no, y 2 con argumentos o configuración que no valen.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  checkIngestConfig,
  createUuidV7Generator,
  derivLogProfileRow,
  IngestConfigError,
  loadConfig,
  LOG_SEQUENCES,
  openLockedSourceLog,
  OperationalRegistry,
  openStores,
  pendingMigrations,
  PostgresSessionLockProvider,
} from '../../apps/market-data-worker/dist/index.js';
import { realScheduler } from '../../apps/market-data-worker/dist/cli/scheduler.js';
import { DERIV_SOURCE } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { startDerivSession } from '../../apps/market-data-worker/dist/deriv/session.js';
import { fakeDerivSocketFactory, MARKETS } from './sintetico.mjs';

const RETENTION_MS = 8 * 86_400_000;
const TICKS_BEFORE_STOP = 3;

function peakKib() {
  const match = /^VmHWM:\s+(\d+) kB$/mu.exec(readFileSync('/proc/self/status', 'utf8'));
  if (match === null) {
    throw new TypeError('/proc/self/status no tiene VmHWM.');
  }
  return Number(match[1]);
}

function resetPeak() {
  writeFileSync('/proc/self/clear_refs', '5');
}

const fail = (exitCode, fields) => {
  console.log(JSON.stringify({ ...fields, status: 'failed' }));
  process.exit(exitCode);
};

let options;
let logs;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: { esquemas: { type: 'string' }, log: { multiple: true, type: 'string' } },
  }));
  if (options.esquemas === undefined || (options.log ?? []).length === 0) {
    throw new TypeError('Uso: --esquemas <schemas.zip> --log <símbolo>:<esquema>:<bucket>…');
  }
  logs = options.log.map((text) => {
    const [symbol, schema, bucket] = text.split(':');
    const market = MARKETS[symbol];
    const sequence = LOG_SEQUENCES.find((item) => item.name === symbol);
    if (market === undefined || sequence === undefined || !schema || !bucket) {
      throw new TypeError(`--log ${text} no vale.`);
    }
    return { bucket, market, schema, sequence, symbol };
  });
} catch (error) {
  fail(2, { code: 'UsageError', message: error.message });
}

for (const item of logs) {
  try {
    const env = { ...process.env, BUOH_POSTGRES_SCHEMA: item.schema, BUOH_S3_BUCKET: item.bucket };
    item.config = loadConfig(env);
    checkIngestConfig(item.config, env);
    if (item.config.environment === 'production') {
      throw new IngestConfigError(['BUOH_DEPLOYMENT_ENVIRONMENT']);
    }
  } catch (error) {
    fail(2, { code: error.name, message: error.message });
  }
}

const startedMs = Date.now();
const archive = readFileSync(options.esquemas);
const phases = {};
let connected = 0;
let stoppedSessions = 0;
let startupMs = null;
const sessions = [];

const runs = logs.map(async (item, position) => {
  const stores = openStores(item.config);
  const pending = await pendingMigrations(stores.pool);
  if (pending.length > 0) {
    await stores.close();
    throw new TypeError(`MIGRATIONS_PENDING ${item.schema}`);
  }
  const alerts = [];
  const alert = (payload) => {
    alerts.push(payload.event);
  };
  const registry = await OperationalRegistry.open({
    alert,
    source: DERIV_SOURCE,
    store: stores.operational,
  });
  let stopped = false;
  const connect = fakeDerivSocketFactory(item.market, {
    onConnect: (index) => {
      if (index === 0) {
        connected += 1;
        if (connected === logs.length) {
          startupMs = Date.now() - startedMs;
          phases.arranque = peakKib();
          resetPeak();
        }
      }
    },
    onTick: (index, count) => {
      if (index === 0 && count === TICKS_BEFORE_STOP && !stopped) {
        stopped = true;
        stoppedSessions += 1;
        sessions[position].stop();
      }
    },
  });
  try {
    sessions[position] = startDerivSession({
      alert,
      catalog: stores.catalog,
      connect,
      fetch: () => Promise.resolve(new Response(archive, { status: 200 })),
      lock: new PostgresSessionLockProvider({
        postgres: item.config.postgres,
        sequence: item.sequence,
        source: DERIV_SOURCE,
      }),
      logProfile: item.symbol === 'R_100' ? derivLogProfileRow('R_100') : null,
      nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
      now: () => new Date().toISOString(),
      openLog: (lock) =>
        openLockedSourceLog(lock, {
          objects: stores.objects,
          source: DERIV_SOURCE,
          store: stores.sourceLog,
          zlibVersion: process.versions.zlib,
        }),
      random: () => 0,
      registry,
      requestedResponses: stores.requestedResponses,
      retentionMs: RETENTION_MS,
      scheduler: realScheduler,
      schemaObjects: stores.objects,
      serverTime: false,
      sink: { invalidFrame: () => undefined, tick: () => undefined },
      status: stores.ingestionStatus,
      symbol: item.symbol,
      writeLiveCheckpoints: true,
    });
    const result = await sessions[position].done;
    const counts = {};
    for (const event of alerts.sort()) {
      counts[event] = (counts[event] ?? 0) + 1;
    }
    return {
      alerts: counts,
      connections: result.connections.map((connection) => ({
        closure:
          connection.closure === null
            ? null
            : { closure_type: connection.closure.closure_type, reason: connection.closure.reason },
        end: connection.end,
      })),
      end: result.end,
      symbol: item.symbol,
    };
  } finally {
    await stores.close();
  }
});

let results;
try {
  results = await Promise.all(runs);
} catch (error) {
  fail(1, { code: error?.name ?? 'Error', message: error?.message ?? String(error) });
}
phases.conexion = peakKib();
console.log(
  JSON.stringify({
    peak_kib: phases,
    sessions: results,
    startup_ms: startupMs,
    stopped_sessions: stoppedSessions,
    total_ms: Date.now() - startedMs,
  }),
);
process.exitCode = results.every((item) => item.end.status === 'completed') ? 0 : 1;
