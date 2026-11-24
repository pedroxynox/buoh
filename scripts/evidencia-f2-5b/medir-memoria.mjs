// Evidencia de memoria de dos sesiones de `ingest` (ADR-0021 §1, PR 2d). No es un comando del
// producto: usa la librería compilada del worker, como la evidencia de F2.1.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`), Node 24.22.0, los
// servicios de «Entorno local y replay» levantados y sus variables `BUOH_*` exportadas:
//
//   node scripts/evidencia-f2-5b/medir-memoria.mjs --estado <archivo.json> [--dias 7]
//     [--repeticiones 3] [--esquemas <schemas.zip>] [--minutos <n>] [--salida <archivo.json>]
//
// Crea un esquema PostgreSQL y un bucket desechables por mercado, R_100 y el oro (`frxXAUUSD`), con
// las migraciones del worker, y escribe en cada uno, a la vez, una captura sintética de `--dias` días
// (`writeCaptureLog` de `sintetico.mjs`): una conexión, un tick cada 2 s en R_100 y cada segundo en el
// oro, un `pong` cada 45 s, sin puntos de control. El oro capturado los 7 días, sin sus cierres, es
// el log más largo que puede tener. Guarda antes el esquema de fuente, como `ingest` al arrancar, y
// en el de R_100 la fila de su perfil de publicación, como `buoh-operaciones` en producción. Después
// mide, en procesos aparte con los tamaños de V8 de `ingest` (`WORKER_NODE_FLAGS`), las dos sesiones
// en un proceso (`dos-sesiones.mjs`): primero `reconstruyendo`, las dos reconstruyendo a la vez sus
// puntos de control, y después `con-punto-de-control`, `--repeticiones` veces. Comprueba el criterio
// de ADR-0021 §1: el máximo del proceso entero, en cada medición, por debajo de 256 MB (10⁶ bytes), y
// cada sesión `completed`, sin alertas. Al terminar borra los esquemas y los buckets.
//
// Con `--minutos`, deja de escribir pasado ese tiempo y sale con 3: otra ejecución con el mismo
// `--estado` sigue donde quedó. El archivo de estado guarda los nombres, las horas y lo ya medido,
// nunca credenciales. Una medición que se cortó no se repite: hay que empezar con un estado nuevo.
// Salida 0 si se cumple el criterio, 1 si no, 2 con argumentos o configuración que no valen y 3 si
// queda por escribir.
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
  derivLogProfileRow,
  loadConfig,
  migrate,
  openStores,
  WORKER_NODE_FLAGS,
} from '../../apps/market-data-worker/dist/index.js';
import { createDerivMeasurementProfile } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { openSchemaArchive } from '../../apps/market-data-worker/dist/deriv/schema-archive.js';
import {
  DERIV_SCHEMA_RELEASE,
  SOURCE_SCHEMA_ENTRY,
} from '../../apps/market-data-worker/dist/deriv/schema-release.js';
import { MARKETS, writeCaptureLog } from './sintetico.mjs';

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

const SESSIONS = fileURLToPath(new URL('dos-sesiones.mjs', import.meta.url));
const DAY_MS = 86_400_000;
const CHILD_TIMEOUT_MS = 25 * 60_000;
/** El techo de ADR-0021 §1, en bytes: 256 MB, la mitad de los 512 MB del Starter. */
const CEILING_BYTES = 256_000_000;

const log = (message) => {
  console.error(`${new Date().toISOString()} ${message}`);
};

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      dias: { default: '7', type: 'string' },
      esquemas: { type: 'string' },
      estado: { type: 'string' },
      minutos: { type: 'string' },
      repeticiones: { default: '3', type: 'string' },
      salida: { type: 'string' },
    },
  }));
  if (options.estado === undefined) {
    throw new TypeError('Falta --estado <archivo.json>.');
  }
  for (const name of ['dias', 'repeticiones', 'minutos']) {
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

function loadState() {
  if (existsSync(options.estado)) {
    return JSON.parse(readFileSync(options.estado, 'utf8'));
  }
  const suffix = Date.now().toString(36);
  const endMs = Date.now() - 120_000;
  const days = Number(options.dias);
  return {
    days,
    logs: Object.values(MARKETS).map((market) => {
      const name = market.symbol.toLowerCase().replace(/[^a-z0-9]/gu, '');
      return {
        bucket: `buoh-evidencia-f25b-${name.replace(/_/gu, '')}-${suffix}`,
        endMs,
        schema: `buoh_evidencia_f25b_${name}_${suffix}`,
        seed: `${name}-${suffix}`,
        startMs: endMs - Math.round(days * DAY_MS),
        symbol: market.symbol,
        written: null,
      };
    }),
    measurements: { 'con-punto-de-control': [], reconstruyendo: [] },
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

function runChild(args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...WORKER_NODE_FLAGS, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      resolve({ code, elapsed_ms: Date.now() - started, line: lines.at(-1) ?? null, signal });
    });
  });
}

const envOf = (item) => ({
  ...process.env,
  BUOH_POSTGRES_SCHEMA: item.schema,
  BUOH_S3_BUCKET: item.bucket,
});

async function logCounts(item) {
  const stores = openStores(loadConfig(envOf(item)));
  try {
    const counts = {};
    for (const table of [
      'source_event_index',
      'closed_source_segments',
      'live_derivation_checkpoints',
    ]) {
      const { rows } = await stores.pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      counts[table] = rows[0]?.count ?? null;
    }
    return counts;
  } finally {
    await stores.close();
  }
}

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
    const keys = (listed.Contents ?? []).map((entry) => ({ Key: entry.Key }));
    if (keys.length === 0) {
      break;
    }
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** Una medición de las dos sesiones, saneada: memoria en bytes, fin y alertas de cada una. */
function summarize(run) {
  const line = run.line ?? {};
  const peaks = Object.fromEntries(
    Object.entries(line.peak_kib ?? {}).map(([phase, kib]) => [phase, kib * 1024]),
  );
  const values = Object.values(peaks);
  return {
    elapsed_ms: run.elapsed_ms,
    exit: run.code,
    peak_bytes: peaks,
    process_peak_bytes: values.length === 0 ? null : Math.max(...values),
    sessions: (line.sessions ?? []).map((session) => ({
      alerts: session.alerts,
      end: session.end,
      symbol: session.symbol,
    })),
    signal: run.signal,
    startup_ms: line.startup_ms ?? null,
  };
}

function evaluate() {
  const all = [...state.measurements.reconstruyendo, ...state.measurements['con-punto-de-control']];
  const runsOk = all.every(
    (run) =>
      run.exit === 0 &&
      run.sessions.length === 2 &&
      run.sessions.every(
        (session) =>
          session.end?.status === 'completed' && Object.keys(session.alerts ?? {}).length === 0,
      ),
  );
  const peak = Math.max(...all.map((run) => run.process_peak_bytes ?? Number.POSITIVE_INFINITY));
  return {
    ceiling_bytes: CEILING_BYTES,
    passed: runsOk && peak < CEILING_BYTES,
    peak_bytes: peak,
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
const workDir = mkdtempSync(join(tmpdir(), 'buoh-evidencia-f25b-'));
let exitCode = 1;
let output = null;
try {
  const archive = await loadArchive();
  const archivePath = join(workDir, 'schemas.zip');
  writeFileSync(archivePath, archive.bytes);

  if (state.phase === 'nuevo') {
    for (const item of state.logs) {
      await s3.send(new CreateBucketCommand({ Bucket: item.bucket }));
      await admin.query(`CREATE SCHEMA ${item.schema}`);
      const stores = openStores(loadConfig(envOf(item)));
      try {
        await migrate(stores.pool);
        await stores.objects.putIfAbsent(
          contentKey(DERIV_SCHEMA_RELEASE.entries_sha256[SOURCE_SCHEMA_ENTRY]),
          archive.schemas.schema('ticks', 'response').bytes,
          'application/json',
        );
        if (item.symbol === 'R_100') {
          const row = derivLogProfileRow('R_100');
          await stores.pool.query(
            `INSERT INTO log_quality_profile (profile_id, quality_profile_sha256, run_id, assigned_at_utc)
             VALUES ($1, $2, gen_random_uuid(), $3)`,
            [row.profile_id, row.quality_profile_sha256, new Date().toISOString()],
          );
        }
      } finally {
        await stores.close();
      }
    }
    state.phase = 'escribiendo';
    saveState();
  }

  if (state.phase === 'escribiendo') {
    await Promise.all(
      state.logs
        .filter((item) => item.written === null)
        .map(async (item) => {
          const market = MARKETS[item.symbol];
          const profile = createDerivMeasurementProfile({
            schemas: archive.schemas,
            symbol: item.symbol,
          });
          const stores = openStores(loadConfig(envOf(item)));
          const started = Date.now();
          try {
            const result = await writeCaptureLog({
              deadlineMs,
              endMs: item.endMs,
              market,
              objects: stores.objects,
              onProgress: (events) => {
                if (events % 100_000 === 0) {
                  log(`${item.symbol}: ${String(events)} eventos`);
                }
              },
              profile,
              seed: item.seed,
              startMs: item.startMs,
              store: stores.sourceLog,
            });
            item.write_ms = (item.write_ms ?? 0) + (Date.now() - started);
            log(
              `${item.symbol}: ${String(result.events)} eventos y ${String(result.segments)} segmentos cerrados${result.complete ? '' : ', sin terminar'}`,
            );
            if (result.complete) {
              item.written = { events: result.events, segments: result.segments };
            }
          } finally {
            await stores.close();
          }
        }),
    );
    saveState();
    if (state.logs.some((item) => item.written === null)) {
      output = { estado: options.estado, phase: state.phase, status: 'incomplete' };
      exitCode = 3;
    } else {
      state.phase = 'midiendo';
      saveState();
    }
  }

  if (state.phase === 'midiendo' && exitCode !== 3) {
    const args = [
      SESSIONS,
      '--esquemas',
      archivePath,
      ...state.logs.flatMap((item) => ['--log', `${item.symbol}:${item.schema}:${item.bucket}`]),
    ];
    const plan = [
      ['reconstruyendo', 1],
      ['con-punto-de-control', state.repetitions],
    ];
    for (const [name, times] of plan) {
      const runs = state.measurements[name];
      if (runs.some((run) => run === 'started')) {
        throw new TypeError(`La medición ${name} se cortó: empieza con un estado nuevo.`);
      }
      while (runs.length < times) {
        runs.push('started');
        saveState();
        log(`${name}, ${String(runs.length)} de ${String(times)}`);
        runs[runs.length - 1] = summarize(await runChild(args));
        saveState();
        if (name === 'reconstruyendo') {
          state.after_rebuild = {};
          for (const item of state.logs) {
            state.after_rebuild[item.symbol] = await logCounts(item);
          }
          saveState();
        }
      }
    }
    Object.assign(state, evaluate());
    state.phase = 'medido';
    saveState();
  }

  if (state.phase === 'medido') {
    log('borrando los esquemas y los buckets');
    for (const item of state.logs) {
      await admin.query(`DROP SCHEMA IF EXISTS ${item.schema} CASCADE`);
      await deleteBucket(s3, item.bucket);
    }
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
