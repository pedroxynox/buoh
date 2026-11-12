// Evidencia de memoria del gráfico de F2.4 (ADR-0019 §8; plan de Fase 2, `F2-API-001`): fija la
// ventana máxima del gráfico midiendo la memoria de la API. No es un comando del producto: arranca la
// API compilada y la mide, como las evidencias de memoria de F2.1 y F2.3.
//
// Uso, desde la raíz del repositorio, con la API, el worker y la web compilados (`pnpm run build`),
// Node 24.22.0 y el PostgreSQL y el S3-compatible locales con sus variables `BUOH_POSTGRES_*` y
// `BUOH_S3_*` (el arnés de integración):
//
//   node scripts/evidencia-f2-4/medir-memoria.mjs [--horas 1,6,12,24] [--rondas 3]
//     [--captura-horas 25] [--esquemas <schemas.zip>]
//
// En una base desechable, `buoh_medicion_f2_4`, crea el log 1 con las migraciones del worker y
// escribe en él, bajo `logs/000001/` del bucket local, una captura sintética de R_100 de
// `--captura-horas` horas que termina un minuto antes de empezar (`writeCaptureLog`, la de F2.1: un
// tick cada 2 s y un `pong` cada 45 s, en segmentos de 5 minutos), con el esquema de fuente de la
// release fijada guardado antes y un punto de control por segmento cerrado, como los escribe
// `ingest`. Crea el rol `buoh_api_lectura` con los privilegios de `buoh_lectura` y migra `buoh_api`.
// Después, para la ventana 0 (sin gráfico, la línea base) y para cada una de `--horas`, `--rondas`
// veces y cada vez en una API nueva, con la caché vacía y los tamaños de V8 de producción
// (`API_NODE_FLAGS`):
//
// 1. da de alta una cuenta con la orden `cuenta`, usa su enlace e inicia sesión (Argon2id real);
// 2. pide el gráfico de esas horas dos veces: la primera lee los segmentos de R2, y la segunda, de la
//    caché;
// 3. da de alta otra cuenta, usa su enlace e inicia sesión, con la caché ya llena: así el pico de
//    Argon2id llega con lo que guarda el gráfico;
// 4. lee el máximo de memoria residente del proceso de la API (`VmHWM` de `/proc/<pid>/status`).
//
// Cuenta el mayor de las rondas de cada ventana. Criterio: con la ventana máxima de los contratos
// (`DATA_CHART_MAX_HOURS`), el máximo no pasa de 300 MiB, el techo orientativo del proceso de la API
// de la medición de F2.3 (`scripts/evidencia-f2-3/medir-memoria.mjs`), muy por debajo del Starter de
// 512 MB. La salida da también lo que le queda a un backtest de los 435 MB que no puede pasar el
// servicio con uno en curso (ADR-0019 §10 y §12): el plan de Fase 2 le da hasta 256 MB
// (`F2-BACKTEST-001`), y F2.7 fija su techo. Cifras en MiB de 1 048 576 bytes, salvo ese margen, en MB.
//
// `schemas.zip` es la release fijada de Deriv (`DERIV_SCHEMA_RELEASE`): con `--esquemas`, una copia
// local; si no, la descarga de su URL fijada, la única red que usa, y la comprueba con su SHA-256.
// Nunca se conecta a Deriv. Las claves y las contraseñas se generan al vuelo y viajan solo por el
// entorno de los procesos hijos, sin los secretos del agente; este script nunca las escribe. Al
// terminar borra la base. La salida es una línea JSON con cada ventana, sin precios ni claves. Salida
// 0 si se cumple el criterio y todas las peticiones fueron bien, 1 si no, 2 ante un uso inválido.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { hotp, totpStep } from '../../apps/api/dist/auth/totp.js';
import { API_NODE_FLAGS } from '../../apps/api/dist/node-flags.js';
import {
  checkpointRow,
  contentKey,
  createPool,
  createS3Client,
  loadConfig,
  logLocation,
  migrate,
  PostgresSourceLogStore,
  S3ObjectStore,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/index.js';
import { createDerivMeasurementProfile } from '../../apps/market-data-worker/dist/deriv/profile.js';
import { openSchemaArchive } from '../../apps/market-data-worker/dist/deriv/schema-archive.js';
import {
  DERIV_SCHEMA_RELEASE,
  SOURCE_SCHEMA_ENTRY,
} from '../../apps/market-data-worker/dist/deriv/schema-release.js';
import { DATA_CHART_MAX_HOURS } from '../../packages/contracts/dist/index.js';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
} from '../../packages/domain/dist/index.js';
import { SYMBOL, writeCaptureLog } from '../evidencia-f2-1/deriv-sintetico.mjs';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const pg = requireFromWorker('pg');

const SERVE = fileURLToPath(new URL('../../apps/api/dist/cli/serve.js', import.meta.url));
const MIGRATE = fileURLToPath(new URL('../../apps/api/dist/cli/migrate.js', import.meta.url));
const CUENTA = fileURLToPath(new URL('../../apps/api/dist/cli/cuenta.js', import.meta.url));
const DATABASE = 'buoh_medicion_f2_4';
const READER = 'buoh_api_lectura';
const PASSWORD = 'una contraseña larga de prueba f2-4';
const HOUR_MS = 3_600_000;
/** El techo orientativo del proceso de la API, el de la medición de F2.3. */
const CEILING_MIB = 300;
/** Lo más que puede usar el servicio con un backtest en curso (ADR-0019 §10 y §12), en MB. */
const SERVICE_WITH_BACKTEST_MB = 435;
const RUN = Date.now().toString(36);

const log = (message) => {
  console.error(`${new Date().toISOString()} ${message}`);
};
const mib = (kib) => Math.round((kib / 1024) * 10) / 10;

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      'captura-horas': { default: '25', type: 'string' },
      esquemas: { type: 'string' },
      horas: { default: '1,6,12,24', type: 'string' },
      rondas: { default: '3', type: 'string' },
    },
  }));
  for (const name of ['rondas', 'captura-horas']) {
    if (!(Number(options[name]) > 0)) {
      throw new TypeError(`--${name} tiene que ser un número positivo.`);
    }
  }
  options.windows = options.horas.split(',').map(Number);
  if (options.windows.some((hours) => !Number.isInteger(hours) || hours < 1 || hours > 24)) {
    throw new TypeError('--horas son enteros de 1 a 24, separados por comas.');
  }
} catch (error) {
  console.log(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

if (process.env.BUOH_POSTGRES_HOST === undefined || process.env.BUOH_S3_ENDPOINT === undefined) {
  console.log(
    JSON.stringify({
      code: 'ConfigError',
      message: 'Faltan las variables BUOH_POSTGRES_* y BUOH_S3_* locales (usa el arnés).',
      status: 'failed',
    }),
  );
  process.exit(2);
}

/** El entorno de los procesos hijos: el del arnés, sin los secretos de producción del agente. */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('BUOH_AGENTE_')),
);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of text) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function serverKeys() {
  const keys = new Set();
  while (keys.size < 3) {
    keys.add(randomBytes(32).toString('base64'));
  }
  return [...keys];
}

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', () => undefined);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** El máximo (`VmHWM`) y la memoria residente de ahora (`VmRSS`) del proceso, en KiB. */
function rssKib(pid) {
  const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
  return {
    peak: Number(/VmHWM:\s+(\d+)\s+kB/u.exec(status)?.[1] ?? '0'),
    now: Number(/VmRSS:\s+(\d+)\s+kB/u.exec(status)?.[1] ?? '0'),
  };
}

async function waitForReady(origin) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/salud`);
      if (response.status === 200) {
        return true;
      }
    } catch {
      // Todavía no escucha.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Alta, uso del enlace (Argon2id) e inicio de sesión (Argon2id): la cookie de la sesión. */
async function enrollAndLogin(origin, env, user) {
  const alta = await runNode(CUENTA, ['alta', user], env);
  const url = alta.stdout.split('\n').find((line) => line.includes('/enlace/#'));
  if (url === undefined) {
    throw new Error(`cuenta alta no dio enlace (salida ${String(alta.code)})`);
  }
  const token = url.slice(url.indexOf('/enlace/#') + '/enlace/#'.length).trim();
  const post = (path, body) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const secret = await (await post('/api/v1/enlace/secreto', { token })).json();
  const decoded = base32Decode(secret.totp.secret);
  const enroll = await post('/api/v1/enlace', {
    token,
    password: PASSWORD,
    code: hotp(decoded, totpStep(Date.now())),
  });
  const login = await post('/api/v1/sesion', {
    username: user,
    password: PASSWORD,
    code: hotp(decoded, totpStep(Date.now()) + 1),
  });
  if (enroll.status !== 200 || login.status !== 201) {
    throw new Error(`el alta dio ${String(enroll.status)} y el inicio ${String(login.status)}`);
  }
  return login.headers.get('set-cookie')?.split(';')[0] ?? '';
}

/** Una ronda de una ventana, en una API nueva: el máximo de memoria y lo que tardó el gráfico. */
async function measureRound(hours, index, env, origin) {
  const child = spawn(process.execPath, [...API_NODE_FLAGS, SERVE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Las líneas de la API no llevan secretos (ADR-0019 §11): se guardan las últimas para un error.
  let lines = '';
  const keep = (chunk) => {
    lines = (lines + String(chunk)).slice(-2000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  try {
    if (!(await waitForReady(origin))) {
      throw new Error(`la API no respondió /api/salud a tiempo: ${lines}`);
    }
    const cookie = await enrollAndLogin(origin, env, `m${RUN}_${String(hours)}_${String(index)}a`);
    const result = { hours };
    if (hours > 0) {
      for (const pass of ['cold', 'warm']) {
        const started = performance.now();
        const response = await fetch(`${origin}/api/v1/datos/grafico?hours=${String(hours)}`, {
          headers: { cookie },
        });
        const text = await response.text();
        result[`${pass}_ms`] = Math.round(performance.now() - started);
        result[`${pass}_status`] = response.status;
        if (pass === 'cold') {
          const body = response.status === 200 ? JSON.parse(text) : null;
          result.bytes = Buffer.byteLength(text);
          result.ticks = body?.ticks.offsets_ms.length ?? null;
          result.gaps = body?.gaps.length ?? null;
        }
      }
    }
    if (hours > 0) {
      result.after_chart_rss_mib = mib(rssKib(child.pid).now);
    }
    await enrollAndLogin(origin, env, `m${RUN}_${String(hours)}_${String(index)}b`);
    const memory = rssKib(child.pid);
    result.peak_mib = mib(memory.peak);
    result.rss_mib = mib(memory.now);
    return result;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('close', resolve);
      setTimeout(resolve, 5000);
    });
  }
}

/** `schemas.zip` de la release fijada, comprobado. */
async function loadSchemas() {
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

const local = loadConfig({ ...baseEnv, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' });
const platform = new pg.Pool({
  database: local.postgres.database,
  host: local.postgres.host,
  max: 1,
  password: local.postgres.password,
  port: local.postgres.port,
  user: local.postgres.user,
});
const readerPassword = randomBytes(24).toString('hex');
let output;
let exitCode = 1;
try {
  const schemas = await loadSchemas();
  const profile = createDerivMeasurementProfile({ schemas, symbol: SYMBOL });
  await platform.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await platform.query(`DROP ROLE IF EXISTS ${READER}`);
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  await platform.query(`CREATE ROLE ${READER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`);

  const location = logLocation(1);
  const owner = createPool({ ...local.postgres, database: DATABASE, schema: 'public' });
  await owner.query(`CREATE SCHEMA ${location.schema}`);
  await owner.end();
  const logPool = createPool({ ...local.postgres, database: DATABASE, schema: location.schema });
  const s3 = createS3Client(local.s3);
  const objects = new S3ObjectStore(s3, local.s3.bucket, location.prefix);
  let captured;
  try {
    await migrate(logPool);
    await logPool.query(`GRANT USAGE ON SCHEMA ${location.schema} TO ${READER}`);
    await logPool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${location.schema} TO ${READER}`);
    await objects.putIfAbsent(
      contentKey(DERIV_SCHEMA_RELEASE.entries_sha256[SOURCE_SCHEMA_ENTRY]),
      schemas.schema('ticks', 'response').bytes,
      'application/json',
    );
    const store = new PostgresSourceLogStore(logPool);
    const endMs = Date.now() - 60_000;
    const startMs = endMs - Number(options['captura-horas']) * HOUR_MS;
    log(`escribiendo ${options['captura-horas']} horas de captura`);
    const written = await writeCaptureLog({
      endMs,
      objects,
      onProgress: (events) => {
        if (events % 10_000 === 0) {
          log(`${String(events)} eventos`);
        }
      },
      profile,
      seed: `f2-4-${RUN}`,
      startMs,
      store,
    });
    // Un punto de control por segmento cerrado, como los escribe `ingest` (ADR-0017 §5).
    const reader = await SourceEventLog.open({
      objects,
      source: profile.source,
      store,
      zlibVersion: process.versions.zlib,
    });
    let state = emptyLiveDerivationState();
    let events = 0;
    let frames = 0;
    for (let index = 0; index < reader.openSegmentIndex; index += 1) {
      const { events: segmentEvents, segment } = await reader.readClosedSegment(index);
      state = foldLiveDerivation(state, segmentEvents, profile);
      events += segmentEvents.length;
      frames += segmentEvents.filter((event) => event.kind === 'raw_source_frame').length;
      const checkpoint = buildLiveDerivationCheckpoint({
        event_count: events,
        profile,
        raw_frame_count: frames,
        segment_index: index,
        segment_logical_content_sha256: segment.logical_content_sha256,
        state,
        symbol: SYMBOL,
      });
      await store.insertLiveCheckpoint(checkpointRow(checkpoint, new Date(endMs).toISOString()));
    }
    captured = { events: written.events, segments: written.segments, start_ms: startMs };
    log(`${String(written.events)} eventos en ${String(written.segments)} segmentos cerrados`);
  } finally {
    await logPool.end();
    s3.destroy();
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const [passwordPepper, totpKey, tokenKey] = serverKeys();
  const env = {
    ...baseEnv,
    BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
    BUOH_API_ORIGIN: origin,
    BUOH_API_PASSWORD_PEPPER: passwordPepper,
    BUOH_API_TOTP_KEY: totpKey,
    BUOH_API_TOKEN_KEY: tokenKey,
    BUOH_API_LECTURA_POSTGRES_PASSWORD: readerPassword,
    BUOH_API_S3_ENDPOINT: local.s3.endpoint,
    BUOH_API_S3_ACCESS_KEY_ID: local.s3.accessKeyId,
    BUOH_API_S3_SECRET_ACCESS_KEY: local.s3.secretAccessKey,
    BUOH_API_S3_BUCKET: local.s3.bucket,
    BUOH_API_S3_REGION: local.s3.region,
    BUOH_POSTGRES_DB: DATABASE,
    PORT: String(port),
  };
  log('migrando el esquema buoh_api');
  const migrated = await runNode(MIGRATE, [], env);
  if (migrated.code !== 0) {
    throw new Error(`db:migrate de la API salió con ${String(migrated.code)}`);
  }

  const windows = [];
  for (const hours of [0, ...options.windows]) {
    const rounds = [];
    for (let index = 0; index < Number(options.rondas); index += 1) {
      log(`ventana ${String(hours)} h, ronda ${String(index + 1)}`);
      rounds.push(await measureRound(hours, index, env, origin));
    }
    windows.push({
      hours,
      peak_mib: Math.max(...rounds.map((item) => item.peak_mib)),
      rounds,
    });
  }
  const ok = windows.every((item) =>
    item.rounds.every(
      (round) => item.hours === 0 || (round.cold_status === 200 && round.warm_status === 200),
    ),
  );
  const atMax = windows.find((item) => item.hours === DATA_CHART_MAX_HOURS);
  // Lo que le queda a un backtest de los 435 MB con el máximo de cada ventana, en MB.
  for (const item of windows) {
    item.backtest_margin_mb = Math.round(
      SERVICE_WITH_BACKTEST_MB - (item.peak_mib * 1_048_576) / 1e6,
    );
  }
  output = {
    node: process.version,
    node_flags: API_NODE_FLAGS,
    capture: captured,
    ceiling_mib: CEILING_MIB,
    max_hours: DATA_CHART_MAX_HOURS,
    requests_ok: ok,
    passed: ok && atMax !== undefined && atMax.peak_mib <= CEILING_MIB,
    windows,
    finished_at_utc: new Date().toISOString(),
  };
  exitCode = output.passed ? 0 : 1;
} catch (error) {
  output = {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    status: 'failed',
  };
} finally {
  await platform.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
  await platform.query(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined);
  await platform.end();
}
console.log(JSON.stringify(output));
process.exitCode = exitCode;
