// Evidencia de memoria y de duración de los datasets vivos (ADR-0020 §7 y §8; PR 3c de su §13). No
// es un comando del producto: usa la librería y los comandos compilados del worker.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`), los servicios de
// «Entorno local y replay» levantados y sus variables `BUOH_*` exportadas, con un usuario de
// PostgreSQL que crea bases:
//
//   node scripts/evidencia-f2-5/medir-datasets.mjs [--repeticiones 3] [--esquemas <schemas.zip>]
//     [--salida <archivo.json>]
//
// Crea una base y un bucket desechables y escribe en ellos, con el `SourceEventLog` del worker, dos
// logs sucesivos de una captura sintética de R_100 con la forma de la de producción (los mensajes
// de `scripts/evidencia-f2-1/deriv-sintetico.mjs`: un tick cada 2 s y un `pong` cada 45 s, con
// precios inventados), y `buoh_datasets`:
//
// - el log 1, de 12 horas: una conexión que cae a la hora sin historia y otra que sigue hasta el
//   final. La continuidad queda pendiente, así que ningún final posible es limpio y su primer dataset
//   llega al techo de 16 000 elementos (§7);
// - el log 2, de 5 minutos, para que el 1 esté terminado.
//
// Después corre, en procesos aparte con los tamaños de V8 de producción (`WORKER_NODE_FLAGS`) y
// `--repeticiones` veces cada uno, sobre una copia nueva de `buoh_datasets` en cada repetición:
// `datasets:publish` (`dist/cli/publish-dataset.js`), que publica ese dataset, y `data:replay`
// (`dist/cli/replay.js`) en `--verify-only` y en recomputación, con `buoh_datasets`. Cada proceso
// informa en su línea su memoria máxima (`max_rss_bytes`, de `process.resourceUsage().maxRSS`), y
// la publicación, su duración. Comprueba el criterio de §7: ninguno pasa de 256 MiB. Cifras en MiB de
// 1 048 576 bytes. Solo escribe conteos, tiempos y memoria, nunca una cotización.
//
// `schemas.zip` es la release fijada de Deriv (`DERIV_SCHEMA_RELEASE`): con `--esquemas`, una copia
// local; si no, la descarga de su URL fijada, la única red que usa. Nunca se conecta a Deriv. Al
// terminar borra la base y el bucket, y escribe en stdout una línea JSON (con `--salida`, también en
// ese archivo). Salida 0 si se cumple el criterio, 1 si no y 2 con argumentos o configuración que no
// valen.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  contentKey,
  createPool,
  createS3Client,
  DATASET_ELEMENT_CEILING,
  DATASETS_SCHEMA,
  loadConfig,
  logLocation,
  migrate,
  migrateDatasets,
  PostgresSourceLogStore,
  S3ObjectStore,
  SourceEventLog,
  WORKER_NODE_FLAGS,
} from '../../apps/market-data-worker/dist/index.js';
import { createDerivMeasurementProfile } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { openSchemaArchive } from '../../apps/market-data-worker/dist/deriv/schema-archive.js';
import {
  DERIV_SCHEMA_RELEASE,
  SOURCE_SCHEMA_ENTRY,
} from '../../apps/market-data-worker/dist/deriv/schema-release.js';
import { captureEvents, SYMBOL } from '../evidencia-f2-1/deriv-sintetico.mjs';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } =
  requireFromWorker('@aws-sdk/client-s3');

const PUBLISH_CLI = fileURLToPath(
  new URL('../../apps/market-data-worker/dist/cli/publish-dataset.js', import.meta.url),
);
const REPLAY_CLI = fileURLToPath(
  new URL('../../apps/market-data-worker/dist/cli/replay.js', import.meta.url),
);
/** El techo de memoria de §7, en MiB. */
const CEILING_MIB = 256;
const HOUR_MS = 3_600_000;
const CHILD_TIMEOUT_MS = 10 * 60_000;

const log = (message) => {
  console.error(`${new Date().toISOString()} ${message}`);
};
const mib = (bytes) => Math.round((bytes / 1_048_576) * 10) / 10;

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      esquemas: { type: 'string' },
      repeticiones: { default: '3', type: 'string' },
      salida: { type: 'string' },
    },
  }));
  if (!(Number.isSafeInteger(Number(options.repeticiones)) && Number(options.repeticiones) > 0)) {
    throw new TypeError('--repeticiones tiene que ser un entero positivo.');
  }
} catch (error) {
  console.log(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
  process.exit(2);
}
const repetitions = Number(options.repeticiones);

const suffix = Date.now().toString(36);
const database = `buoh_evidencia_f25_${suffix}`;
const bucket = `buoh-evidencia-f25-${suffix}`;
const baseEnv = { ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' };
delete baseEnv.BUOH_POSTGRES_SCHEMA;
let config;
try {
  config = loadConfig(baseEnv);
} catch (error) {
  console.log(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
  process.exit(2);
}
const env = { ...baseEnv, BUOH_POSTGRES_DB: database, BUOH_S3_BUCKET: bucket };

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
  return loaded.schemas;
}

/**
 * Los eventos de una captura de varias conexiones seguidas, con los de `captureEvents`: cada una
 * sucede a la anterior, y la que termina con `dropped` cae (`transport_error`, `close_code_1006`)
 * en lugar de cerrarse a petición.
 */
function* connectionsEvents(profile, connections) {
  let previous = null;
  for (const [index, connection] of connections.entries()) {
    let current = null;
    for (const event of captureEvents({ ...connection, profile, seed: `${suffix}-${index}` })) {
      if (event.kind === 'connection_opened') {
        current = event.connection_id;
        yield { ...event, supersedes_connection_id: previous };
      } else if (event.kind === 'connection_closed' && connection.dropped) {
        yield { ...event, closure_type: 'transport_error', reason: 'close_code_1006' };
      } else {
        yield event;
      }
    }
    previous = current;
  }
}

/** Escribe la captura en el log, como `ingest`, y cierra su segmento abierto. */
async function writeLog(location, events, schemaBytes) {
  const pool = createPool({ ...config.postgres, database, schema: location.schema });
  const s3 = createS3Client({ ...config.s3, bucket });
  try {
    const objects = new S3ObjectStore(s3, bucket, location.prefix);
    await objects.putIfAbsent(
      contentKey(DERIV_SCHEMA_RELEASE.entries_sha256[SOURCE_SCHEMA_ENTRY]),
      schemaBytes,
      'application/json',
    );
    const sourceLog = await SourceEventLog.open({
      objects,
      source: 'deriv_options',
      store: new PostgresSourceLogStore(pool),
      zlibVersion: process.versions.zlib,
    });
    let count = 0;
    for (const event of events) {
      await sourceLog.append(event);
      count += 1;
      if (count % 5_000 === 0) {
        log(`${location.schema}: ${String(count)} eventos`);
      }
    }
    if (sourceLog.openSegmentStats.event_count > 0) {
      await sourceLog.close('requested');
    }
    return { events: count, segments: sourceLog.openSegmentIndex };
  } finally {
    s3.destroy();
    await pool.end();
  }
}

/** Corre un comando del worker con los tamaños de V8 de producción y da su línea JSON. */
function runChild(script, args, childEnv) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...WORKER_NODE_FLAGS, script, ...args], {
      env: childEnv,
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
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((text) => text.startsWith('{'));
      resolve({
        alerts: stderr.split('\n').filter((text) => text.startsWith('{')).length,
        code,
        elapsed_ms: Date.now() - started,
        line: line === undefined ? null : JSON.parse(line),
      });
    });
  });
}

/** Borra todos los objetos del bucket y el bucket; si ya no existe, no hace nada. */
async function deleteBucket(client) {
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

const server = createPool({ ...config.postgres, schema: 'public' });
const s3 = createS3Client({ ...config.s3, bucket });
let exitCode;
let output;
try {
  const schemas = await loadArchive();
  const profile = createDerivMeasurementProfile({ schemas, symbol: SYMBOL });
  const schemaBytes = schemas.schema('ticks', 'response').bytes;
  await server.query(`CREATE DATABASE ${database}`);
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const admin = createPool({ ...config.postgres, database, schema: 'public' });
  try {
    for (const number of [1, 2]) {
      await admin.query(`CREATE SCHEMA ${logLocation(number).schema}`);
      const pool = createPool({ ...config.postgres, database, schema: logLocation(number).schema });
      await migrate(pool).finally(() => pool.end());
    }
  } finally {
    await admin.end();
  }
  // Las horas de la captura: el log 2 termina hace un minuto, así que ninguno ha vencido.
  const endTwo = Date.now() - 60_000;
  const startTwo = endTwo - 5 * 60_000;
  const endOne = startTwo - 60_000;
  const startOne = endOne - 12 * HOUR_MS;
  log('escribiendo el log 1 (12 horas)');
  const one = await writeLog(
    logLocation(1),
    connectionsEvents(profile, [
      { dropped: true, endMs: startOne + HOUR_MS, startMs: startOne },
      { dropped: false, endMs: endOne, startMs: startOne + HOUR_MS + 10_000 },
    ]),
    schemaBytes,
  );
  log('escribiendo el log 2 (5 minutos)');
  const two = await writeLog(
    logLocation(2),
    connectionsEvents(profile, [{ dropped: false, endMs: endTwo, startMs: startTwo }]),
    schemaBytes,
  );

  const runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    // Una copia nueva de buoh_datasets: cada repetición publica el mismo primer dataset.
    const datasetsPool = createPool({ ...config.postgres, database, schema: 'public' });
    try {
      await datasetsPool.query(`DROP SCHEMA IF EXISTS ${DATASETS_SCHEMA} CASCADE`);
      await migrateDatasets(datasetsPool);
    } finally {
      await datasetsPool.end();
    }
    log(`repetición ${String(repetition)}: datasets:publish`);
    const publish = await runChild(PUBLISH_CLI, [], env);
    if (publish.code !== 0 || publish.line?.status !== 'published') {
      throw new TypeError(`datasets:publish no publicó: ${JSON.stringify(publish.line)}.`);
    }
    const replays = {};
    for (const [mode, args] of [
      ['verify-only', ['--verify-only']],
      ['recompute', []],
    ]) {
      log(`repetición ${String(repetition)}: data:replay ${mode}`);
      const replay = await runChild(REPLAY_CLI, ['--dataset', publish.line.dataset_id, ...args], {
        ...env,
        BUOH_POSTGRES_SCHEMA: DATASETS_SCHEMA,
      });
      if (replay.code !== 0 || replay.line?.dataset_id !== publish.line.dataset_id) {
        throw new TypeError(`data:replay ${mode} falló: ${JSON.stringify(replay.line)}.`);
      }
      replays[mode] = {
        elapsed_ms: replay.elapsed_ms,
        peak_mib: mib(replay.line.max_rss_bytes),
        status: replay.line.status,
      };
    }
    runs.push({
      publish: {
        alerts: publish.alerts,
        clean: publish.line.clean,
        dataset_id: publish.line.dataset_id,
        duration_ms: publish.line.duration_ms,
        elapsed_ms: publish.elapsed_ms,
        elements: publish.line.elements,
        normalized_tick_count: publish.line.normalized_tick_count,
        peak_mib: mib(publish.line.max_rss_bytes),
        segments: [publish.line.first_segment, publish.line.last_segment],
        source_event_count: publish.line.source_event_count,
      },
      replay: replays,
    });
  }
  const peak = (pick) => Math.max(...runs.map(pick));
  const peaks = {
    publish: peak((run) => run.publish.peak_mib),
    recompute: peak((run) => run.replay.recompute.peak_mib),
    'verify-only': peak((run) => run.replay['verify-only'].peak_mib),
  };
  const passed = Object.values(peaks).every((value) => value <= CEILING_MIB);
  output = {
    ceiling_elements: DATASET_ELEMENT_CEILING,
    ceiling_mib: CEILING_MIB,
    logs: { 1: one, 2: two },
    node: process.version,
    node_flags: [...WORKER_NODE_FLAGS],
    passed,
    peaks_mib: peaks,
    publish_duration_ms_max: peak((run) => run.publish.duration_ms),
    release: DERIV_SCHEMA_RELEASE.release,
    runs,
  };
  exitCode = passed ? 0 : 1;
} catch (error) {
  output = { message: error?.message ?? String(error), status: 'failed' };
  exitCode = 1;
} finally {
  log('borrando la base y el bucket');
  await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await deleteBucket(s3).catch(() => undefined);
  s3.destroy();
  await server.end();
}
const text = JSON.stringify(output);
console.log(text);
if (options.salida !== undefined) {
  writeFileSync(options.salida, `${text}\n`);
}
process.exitCode = exitCode;
