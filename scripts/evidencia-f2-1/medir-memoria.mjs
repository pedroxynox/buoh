// Evidencia de memoria de F2.1 (ADR-0017 §9; plan de Fase 2, `F2-CHECKPOINT-001`). No es un comando
// del producto: usa la librería compilada del worker, como la evidencia de la Fase 1.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`), Node 24.22.0, los
// servicios de «Entorno local y replay» levantados y sus variables `BUOH_*` exportadas:
//
//   node scripts/evidencia-f2-1/medir-memoria.mjs --estado <archivo.json> [--dias-base 1]
//     [--dias-largo 7] [--repeticiones 3] [--esquemas <schemas.zip>] [--minutos <n>]
//     [--parar-tras-escribir] [--salida <archivo.json>]
//
// Para cada log, uno de `--dias-base` días y otro de `--dias-largo`, crea un esquema PostgreSQL
// desechable con las migraciones del worker y escribe en él, y en un bucket desechable común, una
// captura sintética de R_100 (`writeCaptureLog`, con el `SourceEventLog` del worker): una conexión
// con un tick cada 2 s y un `pong` cada 45 s, unos 45 000 eventos y 288 segmentos por día, sin puntos
// de control, que termina un par de minutos antes de empezar. Guarda antes el esquema de fuente, como
// `ingest` al arrancar. Después mide, en procesos aparte y en este orden:
//
// 1. `health-sin-punto-de-control`: `data:health` sin ningún punto de control válido, que reconstruye
//    el estado vivo en memoria (ADR-0017 §6);
// 2. `arranque-reconstruyendo`: la sesión de ingesta (`sesion.mjs`, escenario `arranque`), que
//    comprueba el log y escribe los puntos de control que faltan antes de conectar;
// 3. `arranque-con-punto-de-control`: la misma sesión, ya con los puntos de control;
// 4. `reconexion-con-hueco`: la sesión que pierde la conexión, reconecta y recupera el hueco
//    (escenario `reconexion`);
// 5. `health-con-punto-de-control`: `data:health` con el punto de control del último segmento cerrado.
//
// Los tres últimos se repiten `--repeticiones` veces, y cuenta el mayor. `data:health` es el comando
// de siempre (`apps/market-data-worker/dist/cli/health.js`), con `rss-al-salir.mjs` cargado con
// `--import`. Cada proceso corre con los límites de V8 de `ingest` y `data:health`
// (`WORKER_NODE_FLAGS`). Cifras en MiB de 1 048 576 bytes, como en ADR-0016 («Medición»). Comprueba los
// criterios de ADR-0017 §9: con el log largo, el máximo de `ingest` al arrancar (2 y 3) y durante la
// reconexión con hueco (4), y el de `data:health` (1 y 5), no superan en más de un 10 % los del log
// base, y quedan por debajo de 200 MiB (`ingest`) y de 160 MiB (`data:health`).
//
// Escribir 7 días lleva unos 40 minutos en local. Con `--minutos`, deja de escribir pasado ese tiempo
// y sale con 3: otra ejecución con el mismo `--estado` sigue donde quedó, porque los eventos son
// reproducibles. Con `--parar-tras-escribir`, también sale con 3 al terminar de escribir, y mide la
// ejecución siguiente. El archivo de estado guarda los nombres, las horas y lo ya medido, nunca
// credenciales. Una medición que se cortó no se repite: hay que empezar con un estado nuevo.
//
// `schemas.zip` es la release fijada de Deriv (`DERIV_SCHEMA_RELEASE`): con `--esquemas`, una copia
// local; si no, la descarga de su URL fijada, la única red que usa, y la sesión la comprueba con su
// SHA-256. Nunca se conecta a Deriv. Al terminar borra los esquemas y el bucket, y escribe en stdout
// una línea JSON con cada medición y cada criterio, sin precios ni payloads (con `--salida`, también
// en ese archivo). Salida 0 si se cumplen todos los criterios, 1 si no, 2 con argumentos o
// configuración que no valen y 3 si queda por escribir.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  contentKey,
  createPool,
  loadConfig,
  migrate,
  openStores,
  WORKER_NODE_FLAGS,
} from '../../apps/market-data-worker/dist/index.js';
import { createDerivMeasurementProfile } from '../../apps/market-data-worker/dist/deriv/profile.js';
import {
  DERIV_SCHEMA_RELEASE,
  openSchemaArchive,
} from '../../apps/market-data-worker/dist/deriv/schema-archive.js';
import { SOURCE_SCHEMA_ENTRY } from '../../apps/market-data-worker/dist/deriv/session.js';
import { SYMBOL, writeCaptureLog } from './deriv-sintetico.mjs';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} = requireFromWorker('@aws-sdk/client-s3');

const SESSION = fileURLToPath(new URL('sesion.mjs', import.meta.url));
const REPORTER = new URL('rss-al-salir.mjs', import.meta.url).href;
const HEALTH_CLI = fileURLToPath(
  new URL('../../apps/market-data-worker/dist/cli/health.js', import.meta.url),
);
const DAY_MS = 86_400_000;
/** Lo que espera cada proceso, como mucho. */
const CHILD_TIMEOUT_MS = 20 * 60_000;
/** Los techos de ADR-0017 §9, en MiB, y lo que puede subir el log largo sobre el base. */
const INGEST_CEILING_MIB = 200;
const HEALTH_CEILING_MIB = 160;
const MAX_GROWTH = 1.1;
/** Las mediciones, en orden, con cuántas veces se hacen y lo que corren. */
const MEASUREMENTS = [
  { name: 'health-sin-punto-de-control', repeated: false, run: 'health' },
  { name: 'arranque-reconstruyendo', repeated: false, run: 'arranque' },
  { name: 'arranque-con-punto-de-control', repeated: true, run: 'arranque' },
  { name: 'reconexion-con-hueco', repeated: true, run: 'reconexion' },
  { name: 'health-con-punto-de-control', repeated: true, run: 'health' },
];
/** Los criterios: la medición, su fase (`null`, el proceso entero) y su techo. */
const CRITERIA = [
  ['arranque-reconstruyendo', 'arranque', INGEST_CEILING_MIB],
  ['arranque-con-punto-de-control', 'arranque', INGEST_CEILING_MIB],
  ['reconexion-con-hueco', 'reconexion', INGEST_CEILING_MIB],
  ['health-sin-punto-de-control', null, HEALTH_CEILING_MIB],
  ['health-con-punto-de-control', null, HEALTH_CEILING_MIB],
];

const log = (message) => {
  console.error(`${new Date().toISOString()} ${message}`);
};
const mib = (kib) => Math.round((kib / 1024) * 10) / 10;

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      'dias-base': { default: '1', type: 'string' },
      'dias-largo': { default: '7', type: 'string' },
      esquemas: { type: 'string' },
      estado: { type: 'string' },
      minutos: { type: 'string' },
      'parar-tras-escribir': { default: false, type: 'boolean' },
      repeticiones: { default: '3', type: 'string' },
      salida: { type: 'string' },
    },
  }));
  if (options.estado === undefined) {
    throw new TypeError('Falta --estado <archivo.json>.');
  }
  for (const name of ['dias-base', 'dias-largo', 'repeticiones', 'minutos']) {
    if (options[name] !== undefined && !(Number(options[name]) > 0)) {
      throw new TypeError(`--${name} tiene que ser un número positivo.`);
    }
  }
} catch (error) {
  console.log(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

let base;
try {
  base = loadConfig(process.env);
} catch (error) {
  console.log(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
  process.exit(2);
}
const deadlineMs =
  options.minutos === undefined ? undefined : Date.now() + Number(options.minutos) * 60_000;

/** El estado guardado, o uno nuevo con los nombres y las horas de esta medición. */
function loadState() {
  if (existsSync(options.estado)) {
    return JSON.parse(readFileSync(options.estado, 'utf8'));
  }
  const suffix = Date.now().toString(36);
  const endMs = Date.now() - 120_000;
  return {
    bucket: `buoh-evidencia-f21-${suffix}`,
    logs: [
      { days: Number(options['dias-base']), name: 'base' },
      { days: Number(options['dias-largo']), name: 'largo' },
    ].map((item) => ({
      ...item,
      endMs,
      measurements: {},
      schema: `buoh_evidencia_f21_${item.name}_${suffix}`,
      seed: `${item.name}-${suffix}`,
      startMs: endMs - Math.round(item.days * DAY_MS),
      written: null,
    })),
    node: process.version,
    node_flags: [...WORKER_NODE_FLAGS],
    phase: 'nuevo',
    release: DERIV_SCHEMA_RELEASE.release,
    repetitions: Math.floor(Number(options.repeticiones)),
    started_at_utc: new Date().toISOString(),
  };
}

const state = loadState();
const saveState = () => {
  writeFileSync(options.estado, `${JSON.stringify(state, null, 1)}\n`);
};

/** `schemas.zip` de la release fijada, comprobado. */
async function loadArchive() {
  let bytes;
  if (options.esquemas === undefined) {
    const response = await fetch(DERIV_SCHEMA_RELEASE.archive_url, { redirect: 'follow' });
    if (!response.ok) {
      throw new TypeError(`La descarga de schemas.zip dio ${String(response.status)}.`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = new Uint8Array(readFileSync(options.esquemas));
  }
  const loaded = openSchemaArchive(bytes, DERIV_SCHEMA_RELEASE);
  if (loaded.status !== 'loaded') {
    throw new TypeError(`schemas.zip no es la release fijada: ${loaded.reason}.`);
  }
  return { bytes, schemas: loaded.schemas };
}

/**
 * Corre un proceso hijo de Node, con los límites de V8 del worker y ese entorno, y da su salida, sus
 * líneas JSON y lo que tardó.
 */
function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...WORKER_NODE_FLAGS, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = (text) =>
        text
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
      resolve({
        code,
        elapsed_ms: Date.now() - started,
        signal,
        stderr: lines(stderr),
        stdout: lines(stdout),
      });
    });
  });
}

/** `data:health` sobre el log, con su máximo de memoria residente. */
async function health(env) {
  const run = await runChild(['--import', REPORTER, HEALTH_CLI, '--json', '--symbol', SYMBOL], env);
  const report = run.stdout.at(-1) ?? null;
  const peak = run.stderr.find((line) => line.event === 'evidencia_max_rss_kib')?.value;
  return {
    alerts: run.stderr
      .filter((line) => line.event !== 'evidencia_max_rss_kib')
      .map((line) => `${String(line.event)}:${String(line.reason ?? '')}`),
    elapsed_ms: run.elapsed_ms,
    exit: run.code,
    peak_mib: peak === undefined ? null : mib(peak),
    service_health: report?.service_health ?? null,
  };
}

/** La sesión de ingesta en un escenario de `sesion.mjs`, con el máximo de cada fase. */
async function session(env, scenario, archivePath) {
  const run = await runChild([SESSION, '--escenario', scenario, '--esquemas', archivePath], env);
  const line = run.stdout.at(-1) ?? {};
  return {
    alerts: line.alerts ?? null,
    connections: line.connections ?? null,
    elapsed_ms: run.elapsed_ms,
    end: line.end ?? null,
    exit: run.code,
    peak_mib: Object.fromEntries(
      Object.entries(line.peak_kib ?? {}).map(([phase, kib]) => [phase, mib(kib)]),
    ),
    recoveries: line.recoveries ?? null,
    startup_ms: line.startup_ms ?? null,
  };
}

/** Cuántas filas tiene cada tabla del log en el esquema. */
async function logCounts(pool) {
  const counts = {};
  for (const table of [
    'source_event_index',
    'closed_source_segments',
    'live_derivation_checkpoints',
  ]) {
    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
    counts[table] = rows[0]?.count ?? null;
  }
  return counts;
}

/** Borra todos los objetos del bucket y el bucket; si ya no existe, no hace nada. */
async function deleteBucket(client, bucket) {
  for (;;) {
    let listed;
    try {
      listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    } catch (error) {
      if (error?.name === 'NoSuchBucket') {
        return;
      }
      throw error;
    }
    const keys = (listed.Contents ?? []).map((item) => ({ Key: item.Key }));
    if (keys.length === 0) {
      break;
    }
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** El mayor máximo de las repeticiones de una medición, en una fase o el del proceso. */
function peakOf(item, name, phase) {
  return Math.max(
    ...item.measurements[name].map((run) =>
      phase === null ? (run.peak_mib ?? Number.NaN) : (run.peak_mib[phase] ?? Number.NaN),
    ),
  );
}

/** Los criterios de ADR-0017 §9 y si las ejecuciones terminaron como deben. */
function evaluate() {
  const [baseLog, longLog] = state.logs;
  const criteria = CRITERIA.map(([name, phase, ceiling]) => {
    const baseMib = peakOf(baseLog, name, phase);
    const longMib = peakOf(longLog, name, phase);
    const growth = Math.round((longMib / baseMib) * 1000) / 1000;
    return {
      base_mib: baseMib,
      ceiling_mib: ceiling,
      fase: phase ?? 'proceso',
      growth,
      largo_mib: longMib,
      medicion: name,
      passed: longMib < ceiling && baseMib < ceiling && growth <= MAX_GROWTH,
    };
  });
  const runsOk = state.logs.every((item) =>
    Object.entries(item.measurements).every(([name, runs]) =>
      runs.every((run) =>
        name.startsWith('health')
          ? run.service_health !== null && run.peak_mib !== null
          : run.exit === 0 && run.end?.status === 'completed',
      ),
    ),
  );
  const recoveriesOk = state.logs.every((item) =>
    item.measurements['reconexion-con-hueco'].every(
      (run) => run.recoveries?.length === 1 && run.recoveries[0].status === 'complete',
    ),
  );
  return {
    criteria,
    passed: runsOk && recoveriesOk && criteria.every((item) => item.passed),
    recoveries_ok: recoveriesOk,
    runs_ok: runsOk,
  };
}

const s3 = new S3Client({
  credentials: { accessKeyId: base.s3.accessKeyId, secretAccessKey: base.s3.secretAccessKey },
  endpoint: base.s3.endpoint,
  forcePathStyle: true,
  region: base.s3.region,
});
const admin = createPool({ ...base.postgres, schema: 'public' });
const workDir = mkdtempSync(join(tmpdir(), 'buoh-evidencia-f21-'));
const envOf = (item) => ({
  ...process.env,
  BUOH_POSTGRES_SCHEMA: item.schema,
  BUOH_S3_BUCKET: state.bucket,
});
let exitCode = 1;
let output = null;
try {
  const archive = await loadArchive();
  const archivePath = join(workDir, 'schemas.zip');
  writeFileSync(archivePath, archive.bytes);
  const profile = createDerivMeasurementProfile({ schemas: archive.schemas, symbol: SYMBOL });

  if (state.phase === 'nuevo') {
    await s3.send(new CreateBucketCommand({ Bucket: state.bucket }));
    for (const item of state.logs) {
      await admin.query(`CREATE SCHEMA ${item.schema}`);
      const stores = openStores(loadConfig(envOf(item)));
      try {
        await migrate(stores.pool);
        // El esquema de fuente guardado, como lo deja `ingest` antes de conectar.
        await stores.objects.putIfAbsent(
          contentKey(DERIV_SCHEMA_RELEASE.entries_sha256[SOURCE_SCHEMA_ENTRY]),
          archive.schemas.schema('ticks', 'response').bytes,
          'application/json',
        );
      } finally {
        await stores.close();
      }
    }
    state.phase = 'escribiendo';
    saveState();
  }

  if (state.phase === 'escribiendo') {
    // Los dos logs a la vez: cada uno en su esquema, con su conexión al almacén.
    await Promise.all(
      state.logs
        .filter((item) => item.written === null)
        .map(async (item) => {
          const stores = openStores(loadConfig(envOf(item)));
          const started = Date.now();
          try {
            const result = await writeCaptureLog({
              deadlineMs,
              endMs: item.endMs,
              objects: stores.objects,
              onProgress: (events) => {
                if (events % 50_000 === 0) {
                  log(`log ${item.name}: ${String(events)} eventos`);
                }
              },
              profile,
              seed: item.seed,
              startMs: item.startMs,
              store: stores.sourceLog,
            });
            item.write_ms = (item.write_ms ?? 0) + (Date.now() - started);
            log(
              `log ${item.name}: ${String(result.events)} eventos y ${String(result.segments)} segmentos cerrados${result.complete ? '' : ', sin terminar'}`,
            );
            if (result.complete) {
              item.written = { events: result.events, segments: result.segments };
            }
          } finally {
            await stores.close();
          }
        }),
    );
    if (state.logs.some((item) => item.written === null)) {
      saveState();
      output = { estado: options.estado, phase: state.phase, status: 'incomplete' };
      exitCode = 3;
    } else {
      state.phase = 'midiendo';
      saveState();
      if (options['parar-tras-escribir']) {
        output = { estado: options.estado, phase: state.phase, status: 'incomplete' };
        exitCode = 3;
      }
    }
  }

  if (state.phase === 'midiendo' && exitCode !== 3) {
    for (const item of state.logs) {
      const env = envOf(item);
      for (const measurement of MEASUREMENTS) {
        const times = measurement.repeated ? state.repetitions : 1;
        const runs = item.measurements[measurement.name] ?? [];
        if (runs.some((run) => run === 'started')) {
          throw new TypeError(
            `La medición ${measurement.name} del log ${item.name} se cortó: empieza con un estado nuevo.`,
          );
        }
        // Las no repetidas van primero, y las repetidas alternan, ronda a ronda.
        if (!measurement.repeated && runs.length === 0) {
          item.measurements[measurement.name] = ['started'];
          saveState();
          log(`log ${item.name}: ${measurement.name}`);
          item.measurements[measurement.name] = [
            measurement.run === 'health'
              ? await health(env)
              : await session(env, measurement.run, archivePath),
          ];
          if (measurement.name === 'arranque-reconstruyendo') {
            const stores = openStores(loadConfig(env));
            try {
              item.after_rebuild = await logCounts(stores.pool);
            } finally {
              await stores.close();
            }
          }
          saveState();
        } else if (measurement.repeated && times > 0) {
          item.measurements[measurement.name] = runs;
        }
      }
      for (let round = 1; round <= state.repetitions; round += 1) {
        for (const measurement of MEASUREMENTS.filter((entry) => entry.repeated)) {
          const runs = item.measurements[measurement.name];
          if (runs.length >= round) {
            continue;
          }
          runs.push('started');
          saveState();
          log(`log ${item.name}: ${measurement.name}, ronda ${String(round)}`);
          runs[runs.length - 1] =
            measurement.run === 'health'
              ? await health(env)
              : await session(env, measurement.run, archivePath);
          saveState();
        }
      }
      const stores = openStores(loadConfig(env));
      try {
        item.counts = await logCounts(stores.pool);
      } finally {
        await stores.close();
      }
      saveState();
    }
    Object.assign(state, evaluate());
    state.phase = 'medido';
    saveState();
  }

  if (state.phase === 'medido') {
    log('borrando los esquemas y el bucket');
    for (const item of state.logs) {
      await admin.query(`DROP SCHEMA IF EXISTS ${item.schema} CASCADE`);
    }
    await deleteBucket(s3, state.bucket);
    state.phase = 'terminado';
    state.finished_at_utc = new Date().toISOString();
    saveState();
  }

  if (state.phase === 'terminado') {
    output = state;
    exitCode = state.passed ? 0 : 1;
  }
} catch (error) {
  output = {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    estado: options.estado,
    phase: state.phase,
    status: 'failed',
  };
  exitCode = 1;
} finally {
  await admin.end();
  s3.destroy();
  rmSync(workDir, { force: true, recursive: true });
}
const line = JSON.stringify(output);
if (options.salida !== undefined && state.phase === 'terminado') {
  writeFileSync(options.salida, `${line}\n`);
}
console.log(line);
process.exitCode = exitCode;
