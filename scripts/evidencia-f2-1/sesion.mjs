// Evidencia de memoria de F2.1 (ADR-0017 §9). No es un comando del producto: lo arranca
// `medir-memoria.mjs` como proceso hijo, uno por medición.
//
// Uso, desde la raíz del repositorio, con el worker compilado y Node 24.22.0:
//
//   node scripts/evidencia-f2-1/sesion.mjs --escenario arranque|reconexion --esquemas <schemas.zip>
//
// Corre la sesión de ingesta de Deriv con el cableado de `ingest` (`runIngest` en
// `apps/market-data-worker/src/ingest.ts`): las variables `BUOH_*` con las reglas de `ingest`
// (`checkIngestConfig`), los almacenes de `openStores`, las migraciones comprobadas sin aplicar
// nada, el bloqueo de PostgreSQL, el log protegido por él, el cursor y el latido, el esquema de
// fuente guardado, el punto de control de cada segmento cerrado (`writeLiveCheckpoints`), el
// temporizador y el reloj reales e IDs UUIDv7. `medir-memoria.mjs` lo arranca con los límites de V8
// del script `ingest` (`WORKER_NODE_FLAGS`). Cambia cuatro cosas, que no tocan lo que se mide:
//
// - la retención es de 8 días, porque las 23 horas de `ingest` no dejan arrancar con un log de 7 días
//   (`retention_expired`, ADR-0015 §7);
// - el canal de Deriv es el falso de `deriv-sintetico.mjs`, en el proceso, sin red;
// - `schemas.zip` sale de `--esquemas`, una copia de la release fijada, que la sesión comprueba con su
//   SHA-256 como siempre;
// - la espera entre intentos usa `random() = 0`: 500 ms antes de reconectar.
//
// Escenarios:
//
// - `arranque`: arranca, conecta, recibe 3 ticks y para;
// - `reconexion`: arranca, conecta, recibe 5 ticks, el canal cierra la conexión (1001), la sesión
//   reconecta, el primer tick deja el hueco con su fin, la sesión pide la historia a los 2000 ms, la
//   recupera `complete` y, tras 3 ticks más, para.
//
// Mide el máximo de memoria residente de cada fase con el `VmHWM` de `/proc/self/status`, que pone a
// cero escribiendo `5` en `/proc/self/clear_refs` al empezar cada fase: `arranque`, desde el
// principio hasta la primera conexión (los esquemas, el bloqueo, el log, la comprobación del
// arranque y la reconstrucción de los puntos de control que falten); `conexion`, la primera conexión;
// y, en `reconexion`, `reconexion`, desde el cierre del canal hasta el final (la espera, la conexión
// nueva, la vigilancia del hueco y la historia). Cifras en KiB, como las da `/proc`. Al terminar
// escribe en stdout una línea JSON con las fases, el resultado saneado de la sesión y sus alertas
// contadas, nunca precios ni payloads. Salida 0 si la sesión terminó `completed`, 1 si no, y 2 con
// argumentos o configuración que no valen.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  checkIngestConfig,
  createUuidV7Generator,
  loadConfig,
  openLockedSourceLog,
  OperationalRegistry,
  openStores,
  pendingMigrations,
  PostgresSessionLockProvider,
} from '../../apps/market-data-worker/dist/index.js';
import { realScheduler } from '../../apps/market-data-worker/dist/cli/scheduler.js';
import { DERIV_SOURCE } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { startDerivSession } from '../../apps/market-data-worker/dist/deriv/session.js';
import { fakeDerivSocketFactory, SYMBOL } from './deriv-sintetico.mjs';

const RETENTION_MS = 8 * 86_400_000;
/** Ticks de la primera conexión antes de que el canal la cierre, en `reconexion`. */
const TICKS_BEFORE_DROP = 5;
/** Ticks antes de parar: en `arranque`, de la primera conexión; en `reconexion`, tras la historia. */
const TICKS_BEFORE_STOP = 3;

/** El máximo de memoria residente desde el último reinicio, en KiB (`VmHWM`). */
function peakKib() {
  const match = /^VmHWM:\s+(\d+) kB$/mu.exec(readFileSync('/proc/self/status', 'utf8'));
  if (match === null) {
    throw new TypeError('/proc/self/status no tiene VmHWM.');
  }
  return Number(match[1]);
}

/** Pone a cero el máximo, que pasa a ser la memoria residente de ahora. */
function resetPeak() {
  writeFileSync('/proc/self/clear_refs', '5');
}

const fail = (exitCode, fields) => {
  console.log(JSON.stringify({ ...fields, status: 'failed' }));
  process.exit(exitCode);
};

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      escenario: { type: 'string' },
      esquemas: { type: 'string' },
    },
  }));
  if (!['arranque', 'reconexion'].includes(options.escenario) || options.esquemas === undefined) {
    throw new TypeError('Uso: --escenario arranque|reconexion --esquemas <schemas.zip>.');
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

const startedMs = Date.now();
const archive = readFileSync(options.esquemas);
const stores = openStores(config);
const pending = await pendingMigrations(stores.pool);
if (pending.length > 0) {
  await stores.close();
  fail(2, { code: 'MIGRATIONS_PENDING', pending });
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

const phases = {};
let startupMs = null;
let session = null;
let historyAnswered = false;
let ticksAfterHistory = 0;
const reconnecting = options.escenario === 'reconexion';
const connect = fakeDerivSocketFactory({
  ...(reconnecting ? { dropAfterTicks: TICKS_BEFORE_DROP } : {}),
  onConnect: (index) => {
    if (index === 0) {
      startupMs = Date.now() - startedMs;
      phases.arranque = peakKib();
      resetPeak();
    }
  },
  onDrop: () => {
    phases.conexion = peakKib();
    resetPeak();
  },
  onHistory: () => {
    historyAnswered = true;
  },
  onTick: (index, count) => {
    if (!reconnecting && index === 0 && count === TICKS_BEFORE_STOP) {
      session.stop();
    }
    if (reconnecting && index === 1 && historyAnswered) {
      ticksAfterHistory += 1;
      if (ticksAfterHistory === TICKS_BEFORE_STOP) {
        session.stop();
      }
    }
  },
});

let result;
try {
  session = startDerivSession({
    alert,
    catalog: stores.catalog,
    connect,
    fetch: () => Promise.resolve(new Response(archive, { status: 200 })),
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
    random: () => 0,
    registry,
    requestedResponses: stores.requestedResponses,
    retentionMs: RETENTION_MS,
    scheduler: realScheduler,
    schemaObjects: stores.objects,
    serverTime: false,
    sink: { invalidFrame: () => undefined, tick: () => undefined },
    status: stores.ingestionStatus,
    symbol: SYMBOL,
    writeLiveCheckpoints: true,
  });
  result = await session.done;
} finally {
  await stores.close();
}
phases[reconnecting ? 'reconexion' : 'conexion'] = peakKib();

const alertCounts = {};
for (const event of alerts.sort()) {
  alertCounts[event] = (alertCounts[event] ?? 0) + 1;
}
console.log(
  JSON.stringify({
    alerts: alertCounts,
    connections: result.connections.map((connection) => ({
      closure:
        connection.closure === null
          ? null
          : { closure_type: connection.closure.closure_type, reason: connection.closure.reason },
      end: connection.end,
    })),
    end: result.end,
    escenario: options.escenario,
    peak_kib: phases,
    recoveries: result.recoveries.map((outcome) =>
      outcome.status === 'abandoned'
        ? { status: 'abandoned' }
        : {
            durable: outcome.durable,
            recovered_event_count:
              outcome.result.status === 'unavailable' ? null : outcome.result.recovered_event_count,
            status: outcome.result.status,
          },
    ),
    startup_ms: startupMs,
    total_ms: Date.now() - startedMs,
    waits_ms: result.waits_ms,
  }),
);
process.exitCode = result.end.status === 'completed' ? 0 : 1;
