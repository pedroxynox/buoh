// Evidencia de la puerta de salida de Fase 1 (ADR-0015 §12). No es un comando del producto: usa la
// librería compilada del worker (`capture.mjs` y `count-incidents.mjs`) y los comandos de la raíz y
// del worker, sin cambiar nada de ellos.
//
// Uso, desde la raíz del repositorio, con el worker compilado y las variables `BUOH_*` de los
// servicios locales (runbook, «Entorno local y replay»):
//
//   node scripts/evidencia-f1-5/drills.mjs --sequence <reinicios|smoke|replay|servicios> --out-dir <dir>
//     [--symbol R_100] [--capture-seconds 180]
//
// - `reinicios` (puntos 1, 3, 4, 7 y 8): prepara una captura con un esquema y un bucket desechables
//   (runbook, «Captura viva continua (`ingest`)», pasos 3 a 5, con `psql` y `aws`), corre
//   `capture.mjs` al menos `--capture-seconds` hasta `healthy`, lo mata con `SIGKILL` y lo arranca
//   otra vez (cierre `close_not_recorded`, apertura que lo supera, recuperación y `healthy`), lo
//   para con `SIGTERM` y lo arranca otra vez (cierre `requested`, apertura que lo supera, ningún
//   hueco pendiente) y lo para. Ejecuta `pnpm run data:health -- --json` en cada paso y
//   `count-incidents.mjs` antes y después de cada reinicio, comprueba al final que cada tick
//   entregado es un frame durable del log y borra el esquema y el bucket con el bloque del runbook
//   («Retención y borrado»), también si algo falló antes.
// - `smoke` (punto 2): `pnpm run data:smoke -- --live --duration-seconds 120
//   --interrupt-after-seconds 30`, en memoria.
// - `replay` (punto 9): en un esquema y un bucket desechables, `db:migrate`, `fixture:publish` y
//   `pnpm run data:replay` de cada dataset sintético (recomputación y `--verify-only`), comparando
//   su `dataset_id` con el de los vectores, y el mismo borrado.
// - `servicios`: comprueba las órdenes que paran y arrancan cada servicio (`service`), que usarán
//   los ensayos de fallo de persistencia (puntos 5 y 6): con cada servicio parado, `data:health` da
//   `paused` con la alerta `data_health_storage_unavailable`, y al arrancarlo otra vez, ya no.
//
// Cada paso queda en `<out-dir>/<secuencia>-<hora>/results.json`, con horas UTC, salidas, estados,
// motivos, conteos e IDs, nunca precios, payloads, credenciales, hosts ni puertos. La salida cruda
// de cada orden queda en `raw/` al lado, y los `observation_id` entregados en `ticks-<captura>.txt`:
// ese directorio no va a Git. Los servicios se pueden parar y arrancar durante una secuencia con
// las órdenes de `EVIDENCIA_F15_PG_STOP`, `EVIDENCIA_F15_PG_START`, `EVIDENCIA_F15_S3_STOP` y
// `EVIDENCIA_F15_S3_START` (`service`), que da quien levanta los servicios. Salida 0 si todas las
// comprobaciones pasan, 1 si alguna no, y 2 con argumentos inválidos.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CAPTURE = join(here, 'capture.mjs');
const COUNT = join(here, 'count-incidents.mjs');

// Runbook, «Captura viva continua (`ingest`)», «Preparar la captura», pasos 3 y 4, tal cual.
const CREATE_SCHEMA = String.raw`PGPASSWORD="$BUOH_POSTGRES_PASSWORD" psql -h "$BUOH_POSTGRES_HOST" -p "$BUOH_POSTGRES_PORT" \
  -U "$BUOH_POSTGRES_USER" -d "$BUOH_POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "CREATE SCHEMA $BUOH_POSTGRES_SCHEMA"`;
const CREATE_BUCKET = String.raw`AWS_ACCESS_KEY_ID="$BUOH_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BUOH_S3_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="$BUOH_S3_REGION" aws --endpoint-url "$BUOH_S3_ENDPOINT" \
  s3 mb "s3://$BUOH_S3_BUCKET"`;
// Runbook, «Retención y borrado»: el bloque de borrado con sus comprobaciones, tal cual.
const DELETE_BLOCK = String.raw`node -e 'process.exit(/^[a-z_][a-z0-9_]{0,62}$/u.test(process.argv[1]) ? 0 : 1)' -- "$BUOH_POSTGRES_SCHEMA" &&
  test "$BUOH_POSTGRES_SCHEMA" != public &&
  node -e 'process.exit(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(process.argv[1]) ? 0 : 1)' -- "$BUOH_S3_BUCKET" &&
  test "$BUOH_S3_BUCKET" != buoh-local &&
  PGPASSWORD="$BUOH_POSTGRES_PASSWORD" psql -h "$BUOH_POSTGRES_HOST" -p "$BUOH_POSTGRES_PORT" \
    -U "$BUOH_POSTGRES_USER" -d "$BUOH_POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA \"$BUOH_POSTGRES_SCHEMA\" CASCADE" &&
  AWS_ACCESS_KEY_ID="$BUOH_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BUOH_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="$BUOH_S3_REGION" aws --endpoint-url "$BUOH_S3_ENDPOINT" \
    s3 rb "s3://$BUOH_S3_BUCKET" --force`;
// Runbook, «Retención y borrado»: lo que se comprueba después del borrado.
const SCHEMA_LEFT = String.raw`PGPASSWORD="$BUOH_POSTGRES_PASSWORD" psql -h "$BUOH_POSTGRES_HOST" -p "$BUOH_POSTGRES_PORT" \
  -U "$BUOH_POSTGRES_USER" -d "$BUOH_POSTGRES_DB" -v ON_ERROR_STOP=1 -At \
  -c "SELECT nspname FROM pg_namespace WHERE nspname = '$BUOH_POSTGRES_SCHEMA'"`;
const BUCKETS_LEFT = String.raw`AWS_ACCESS_KEY_ID="$BUOH_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BUOH_S3_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="$BUOH_S3_REGION" aws --endpoint-url "$BUOH_S3_ENDPOINT" s3 ls`;

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      'capture-seconds': { default: '180', type: 'string' },
      'out-dir': { type: 'string' },
      sequence: { type: 'string' },
      symbol: { default: 'R_100', type: 'string' },
    },
  }));
  if (!['reinicios', 'replay', 'servicios', 'smoke'].includes(options.sequence ?? '')) {
    throw new TypeError('--sequence es reinicios, smoke, replay o servicios.');
  }
  if (options['out-dir'] === undefined) {
    throw new TypeError('Falta --out-dir.');
  }
  if (!/^[1-9][0-9]{0,4}$/u.test(options['capture-seconds'])) {
    throw new TypeError('--capture-seconds es un entero positivo.');
  }
} catch (error) {
  console.error(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

const { sequence, symbol } = options;
const captureSeconds = Number(options['capture-seconds']);
const startedAt = new Date();
const stamp = startedAt
  .toISOString()
  .replace(/\.\d{3}Z$/u, '')
  .replace(/[-:]/gu, '')
  .replace('T', '_');
const runDir = join(resolve(options['out-dir']), `${sequence}-${stamp.replace('_', 't')}z`);
const rawDir = join(runDir, 'raw');
mkdirSync(rawDir, { recursive: true });

const results = {
  checks: {},
  finished_at_utc: null,
  sequence,
  started_at_utc: startedAt.toISOString(),
  steps: [],
  symbol,
};
let stepNumber = 0;

const now = () => new Date().toISOString();

function save() {
  writeFileSync(join(runDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

/** Añade un paso a los resultados y deja una línea corta en stderr para seguir la secuencia. */
function record(step) {
  results.steps.push(step);
  save();
  const brief = ['step', 'label', 'exit', 'service_health', 'signal', 'reached']
    .filter((key) => step[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(step[key])}`)
    .join(' ');
  console.error(`[${now()}] ${brief}`);
}

function nextRawBase(label) {
  stepNumber += 1;
  return join(rawDir, `${String(stepNumber).padStart(2, '0')}-${label}`);
}

/** Las líneas de `text` que son un objeto JSON. */
function jsonLines(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === 'object') lines.push(value);
    } catch {
      // No es JSON: lo deja la salida cruda.
    }
  }
  return lines;
}

const lastJsonLine = (text) => jsonLines(text).at(-1) ?? null;

/**
 * Ejecuta una orden y espera a que termine, con su salida cruda en `raw/`. Si no termina en
 * `timeoutMs`, la mata.
 */
function run(label, command, args, { env = process.env, timeoutMs = 600_000 } = {}) {
  const base = nextRawBase(label);
  const started = now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${base}.out`, stdout);
      writeFileSync(`${base}.err`, stderr);
      resolvePromise({
        code,
        finished_at_utc: now(),
        raw: basename(base),
        signal,
        started_at_utc: started,
        stderr,
        stdout,
        timed_out: timedOut,
      });
    });
  });
}

/** Una orden de shell del runbook, con las variables de `env`, que tiene que terminar con 0. */
async function shellStep(label, script, env) {
  const result = await run(label, 'bash', ['-c', script], { env, timeoutMs: 300_000 });
  record({
    exit: result.code,
    finished_at_utc: result.finished_at_utc,
    label,
    raw: result.raw,
    started_at_utc: result.started_at_utc,
    step: 'shell',
  });
  return result;
}

/** `pnpm run data:health -- --json`: la línea del informe, la salida y las alertas de stderr. */
async function health(label, env) {
  const result = await run(`health-${label}`, 'pnpm', ['run', 'data:health', '--', '--json'], {
    env,
    timeoutMs: 180_000,
  });
  const report = lastJsonLine(result.stdout);
  const step = {
    alerts: jsonLines(result.stderr).filter((line) => typeof line.event === 'string'),
    exit: result.code,
    finished_at_utc: result.finished_at_utc,
    label,
    raw: result.raw,
    report,
    service_health: report?.service_health ?? null,
    started_at_utc: result.started_at_utc,
    step: 'health',
  };
  record(step);
  return step;
}

/** `count-incidents.mjs`, con los archivos de ticks entregados si se dan. */
async function count(label, env, delivered = []) {
  const result = await run(
    `count-${label}`,
    process.execPath,
    [COUNT, '--symbol', symbol, ...delivered.flatMap((file) => ['--delivered', file])],
    { env, timeoutMs: 180_000 },
  );
  const step = {
    alerts: jsonLines(result.stderr).filter((line) => typeof line.event === 'string'),
    exit: result.code,
    finished_at_utc: result.finished_at_utc,
    label,
    raw: result.raw,
    started_at_utc: result.started_at_utc,
    step: 'count',
    summary: lastJsonLine(result.stdout),
  };
  record(step);
  return step;
}

/**
 * Para o arranca un servicio con la orden que da el entorno (`EVIDENCIA_F15_<PG|S3>_<STOP|START>`).
 * La usan las secuencias que paran un servicio durante la ingesta (ADR-0015 §12, puntos 5 y 6).
 */
async function service(name, action, env) {
  const variable = `EVIDENCIA_F15_${name.toUpperCase()}_${action.toUpperCase()}`;
  const command = env[variable];
  if (command === undefined || command === '') {
    throw new TypeError(`Falta la orden ${variable}.`);
  }
  const result = await run(`service-${name}-${action}`, 'bash', ['-c', command], {
    env,
    timeoutMs: 180_000,
  });
  record({
    exit: result.code,
    finished_at_utc: result.finished_at_utc,
    label: `${name}-${action}`,
    raw: result.raw,
    started_at_utc: result.started_at_utc,
    step: 'service',
  });
  if (result.code !== 0) throw new Error(`${variable} terminó con ${result.code}.`);
  return result;
}

/** Arranca `capture.mjs` como proceso hijo, con su salida cruda en `raw/`. */
function startCapture(label, env) {
  const base = nextRawBase(`capture-${label}`);
  const ticksFile = join(runDir, `ticks-${label}.txt`);
  writeFileSync(ticksFile, '');
  const out = openSync(`${base}.out`, 'w');
  const err = openSync(`${base}.err`, 'w');
  const child = spawn(process.execPath, [CAPTURE, '--symbol', symbol, '--ticks-file', ticksFile], {
    cwd: root,
    env,
    stdio: ['ignore', out, err],
  });
  closeSync(out);
  closeSync(err);
  const capture = {
    base,
    child,
    exit: null,
    label,
    started_at_utc: now(),
    ticksFile,
  };
  capture.exited = new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => {
      capture.exit = { at: now(), code, signal };
      resolvePromise(capture.exit);
    });
  });
  record({ label, raw: basename(base), started_at_utc: capture.started_at_utc, step: 'capture' });
  return capture;
}

const deliveredCount = (capture) =>
  readFileSync(capture.ticksFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;

/**
 * Para una captura con `signal`: `SIGTERM` pide la parada (ADR-0015 §3), `SIGKILL` simula una caída.
 * Si con `SIGTERM` no termina en un minuto, la mata como dice el runbook («Parar»).
 */
async function stopCapture(capture, signal) {
  const sentAt = now();
  const alreadyExited = capture.exit !== null;
  capture.child.kill(signal);
  let exit = await Promise.race([capture.exited, sleep(60_000).then(() => null)]);
  let forced = false;
  if (exit === null) {
    forced = true;
    capture.child.kill('SIGKILL');
    exit = await capture.exited;
  }
  const step = {
    already_exited: alreadyExited,
    exit: exit.code,
    exit_signal: exit.signal,
    exited_at_utc: exit.at,
    forced_sigkill: forced,
    label: capture.label,
    ran_seconds: (Date.parse(sentAt) - Date.parse(capture.started_at_utc)) / 1000,
    report: lastJsonLine(readFileSync(`${capture.base}.out`, 'utf8')),
    sent_at_utc: sentAt,
    signal,
    step: 'stop',
    ticks_delivered: deliveredCount(capture),
  };
  record(step);
  return step;
}

/**
 * Un hueco que la historia no cubrió (`event_gap_unresolved`) deja `degraded` hasta que otra
 * recuperación `complete` del mismo rango lo resuelva, y F1.5 no la vuelve a intentar (ADR-0015,
 * «Consecuencias»): con esa condición abierta ya no hay que esperar `healthy`.
 */
const unresolvedGap = (step) =>
  step.service_health === 'degraded' &&
  (step.report?.open_condition_types ?? []).includes('event_gap_unresolved');

/**
 * Ejecuta `data:health` hasta que da `healthy` (salida 0), vence el plazo o queda un hueco sin
 * resolver (`unresolvedGap`).
 */
async function waitHealthy(label, env, capture, { pollMs, timeoutMs }) {
  const started = now();
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let last;
  for (;;) {
    polls += 1;
    last = await health(`${label}-${polls}`, env);
    if (
      last.exit === 0 ||
      unresolvedGap(last) ||
      capture.exit !== null ||
      Date.now() + pollMs > deadline
    ) {
      break;
    }
    await sleep(pollMs);
  }
  const step = {
    capture_exited: capture.exit !== null,
    finished_at_utc: now(),
    label,
    polls,
    reached: last.exit === 0,
    unresolved_gap: unresolvedGap(last),
    reached_at_utc: last.exit === 0 ? last.finished_at_utc : null,
    seconds_since_capture_start:
      (Date.parse(last.finished_at_utc) - Date.parse(capture.started_at_utc)) / 1000,
    started_at_utc: started,
    step: 'wait_healthy',
  };
  record(step);
  return step;
}

/**
 * Deja correr la captura hasta `seconds` desde su arranque, con `data:health` cada `everyMs`. Para
 * antes si la captura terminó sola.
 */
async function holdUntil(label, env, capture, seconds, everyMs = 60_000) {
  let snapshot = 0;
  for (;;) {
    const elapsed = Date.now() - Date.parse(capture.started_at_utc);
    if (elapsed >= seconds * 1000 || capture.exit !== null) break;
    await sleep(Math.min(everyMs, seconds * 1000 - elapsed));
    snapshot += 1;
    await health(`${label}-${snapshot}`, env);
  }
}

/** Esquema y bucket desechables de la secuencia, con las reglas de `ingest`. */
function throwawayEnv() {
  return {
    ...process.env,
    BUOH_POSTGRES_SCHEMA: `buoh_puerta_${sequence}_${stamp.toLowerCase()}`,
    BUOH_S3_BUCKET: `buoh-puerta-${sequence}-${stamp.toLowerCase().replace('_', '-')}`,
  };
}

/** Runbook, «Preparar la captura», pasos 3 a 5. */
async function prepareStorage(env) {
  results.schema = env.BUOH_POSTGRES_SCHEMA;
  results.bucket = env.BUOH_S3_BUCKET;
  for (const [label, script] of [
    ['schema-create', CREATE_SCHEMA],
    ['bucket-create', CREATE_BUCKET],
  ]) {
    const result = await shellStep(label, script, env);
    if (result.code !== 0) throw new Error(`${label} terminó con ${result.code}.`);
  }
  const migrate = await run(
    'db-migrate',
    'pnpm',
    ['--filter', '@buoh/market-data-worker', 'run', 'db:migrate'],
    { env, timeoutMs: 300_000 },
  );
  record({
    exit: migrate.code,
    finished_at_utc: migrate.finished_at_utc,
    label: 'db-migrate',
    raw: migrate.raw,
    started_at_utc: migrate.started_at_utc,
    step: 'migrate',
  });
  if (migrate.code !== 0) throw new Error(`db:migrate terminó con ${migrate.code}.`);
}

/** Runbook, «Retención y borrado»: el bloque de borrado y lo que se comprueba después. */
async function deleteStorage(env) {
  const deletion = await shellStep('delete', DELETE_BLOCK, env);
  const schemaLeft = await shellStep('schema-left', SCHEMA_LEFT, env);
  const bucketsLeft = await shellStep('buckets-left', BUCKETS_LEFT, env);
  results.deletion = {
    block_exit: deletion.code,
    bucket_gone:
      bucketsLeft.code === 0 &&
      !bucketsLeft.stdout
        .split('\n')
        .some((line) => line.trim().endsWith(` ${env.BUOH_S3_BUCKET}`)),
    finished_at_utc: now(),
    schema_gone: schemaLeft.code === 0 && schemaLeft.stdout.trim() === '',
  };
  save();
}

const connectionsOf = (step) => step?.summary?.connections ?? [];
const lastConnection = (step) => connectionsOf(step).at(-1) ?? null;
const recoveriesOf = (step) => step?.summary?.recoveries ?? [];

/** Puntos 1, 3, 4, 7 y 8. */
async function reinicios() {
  const env = throwawayEnv();
  const counts = {};
  const stops = {};
  const waits = {};
  const captures = [];
  try {
    await prepareStorage(env);
    await health('vacio', env);
    // Punto 1: captura continua hasta `healthy`, y al menos `captureSeconds`.
    const c1 = startCapture('c1', env);
    captures.push(c1);
    waits.c1 = await waitHealthy('c1', env, c1, { pollMs: 10_000, timeoutMs: 180_000 });
    await holdUntil('c1-sostenida', env, c1, captureSeconds);
    counts.antesDeMatar = await count('c1-antes-de-sigkill', env);
    // Punto 3: caída sin aviso y nuevo arranque.
    stops.c1 = await stopCapture(c1, 'SIGKILL');
    await health('tras-sigkill', env);
    counts.trasMatar = await count('tras-sigkill', env);
    const c2 = startCapture('c2', env);
    captures.push(c2);
    waits.c2 = await waitHealthy('c2', env, c2, { pollMs: 5_000, timeoutMs: 240_000 });
    counts.c2 = await count('c2-tras-reinicio', env);
    await holdUntil(
      'c2-sostenida',
      env,
      c2,
      (Date.now() - Date.parse(c2.started_at_utc)) / 1000 + 30,
      30_000,
    );
    // Punto 4: parada programada y nuevo arranque.
    stops.c2 = await stopCapture(c2, 'SIGTERM');
    await health('tras-sigterm', env);
    counts.trasParar = await count('tras-sigterm', env);
    const c3 = startCapture('c3', env);
    captures.push(c3);
    waits.c3 = await waitHealthy('c3', env, c3, { pollMs: 5_000, timeoutMs: 180_000 });
    counts.c3 = await count('c3-tras-reinicio', env);
    await holdUntil(
      'c3-sostenida',
      env,
      c3,
      (Date.now() - Date.parse(c3.started_at_utc)) / 1000 + 30,
      30_000,
    );
    stops.c3 = await stopCapture(c3, 'SIGTERM');
    await health('final', env);
    // Punto 7: cada tick entregado es un frame durable del log.
    counts.final = await count(
      'final-ticks-entregados',
      env,
      captures.map((capture) => capture.ticksFile),
    );
  } catch (error) {
    results.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    for (const capture of captures) {
      if (capture.exit === null) await stopCapture(capture, 'SIGKILL');
    }
    await deleteStorage(env);
  }

  const c1Connection = lastConnection(counts.antesDeMatar);
  const c2Connection = lastConnection(counts.c2);
  const c3Connection = lastConnection(counts.c3);
  const c2Closure = stops.c2?.report?.connections?.at(-1)?.closure ?? null;
  const repairedC1 = connectionsOf(counts.c2).find(
    (connection) => connection.connection_id === c1Connection?.connection_id,
  );
  const closedC2 = connectionsOf(counts.trasParar).find(
    (connection) => connection.connection_id === c2Connection?.connection_id,
  );
  const delivered = counts.final?.summary?.delivered_ticks ?? null;
  results.checks = {
    item1_captura_continua: {
      capture_seconds: stops.c1?.ran_seconds ?? null,
      healthy_reached: waits.c1?.reached ?? false,
      pass: (waits.c1?.reached ?? false) && (stops.c1?.ran_seconds ?? 0) >= captureSeconds,
    },
    item3_reinicio_sin_aviso: {
      close_after_restart: repairedC1
        ? { closure_reason: repairedC1.closure_reason, closure_type: repairedC1.closure_type }
        : null,
      close_before_restart: lastConnection(counts.trasMatar)?.closure_type ?? null,
      healthy_reached: waits.c2?.reached ?? false,
      killed_by: stops.c1?.exit_signal ?? null,
      pass:
        stops.c1?.exit_signal === 'SIGKILL' &&
        lastConnection(counts.trasMatar)?.closure_type === null &&
        repairedC1?.closure_type === 'transport_error' &&
        repairedC1?.closure_reason === 'close_not_recorded' &&
        c2Connection?.supersedes_connection_id === c1Connection?.connection_id &&
        recoveriesOf(counts.c2).some(
          (recovery) =>
            recovery.connection_id === c2Connection?.connection_id &&
            recovery.status === 'complete',
        ) &&
        (waits.c2?.reached ?? false),
      recoveries_after_restart: recoveriesOf(counts.c2),
      superseding_open: c2Connection?.supersedes_connection_id === c1Connection?.connection_id,
      unresolved_gap_after_restart: waits.c2?.unresolved_gap ?? null,
    },
    item4_reinicio_programado: {
      closure: c2Closure,
      healthy_reached: waits.c3?.reached ?? false,
      pass:
        stops.c2?.exit === 0 &&
        c2Closure?.closure_type === 'requested' &&
        c2Closure?.reason === 'requested' &&
        closedC2?.closure_type === 'requested' &&
        c3Connection?.supersedes_connection_id === c2Connection?.connection_id &&
        counts.trasParar?.summary?.derivation?.pending_gaps === 0 &&
        counts.c3?.summary?.derivation?.pending_gaps === 0 &&
        recoveriesOf(counts.c3).length === recoveriesOf(counts.trasParar).length &&
        (stops.c3?.report?.recoveries?.length ?? -1) === 0,
      pending_gaps_after_restart: counts.c3?.summary?.derivation?.pending_gaps ?? null,
      pending_gaps_before_restart: counts.trasParar?.summary?.derivation?.pending_gaps ?? null,
      superseding_open: c3Connection?.supersedes_connection_id === c2Connection?.connection_id,
    },
    item7_ningun_dato_no_durable: {
      delivered,
      pass: delivered !== null && delivered.delivered > 0 && delivered.missing === 0,
    },
    item8_incidencias_tras_reiniciar: {
      counts_recorded: Object.keys(counts),
      pass: ['antesDeMatar', 'trasMatar', 'c2', 'trasParar', 'c3', 'final'].every(
        (key) => counts[key]?.exit === 0,
      ),
    },
    retention_deleted: {
      pass: results.deletion?.schema_gone === true && results.deletion?.bucket_gone === true,
    },
  };
}

/** Punto 2: el smoke de reconexión, en memoria. */
async function smoke() {
  const result = await run(
    'data-smoke',
    'pnpm',
    [
      'run',
      'data:smoke',
      '--',
      '--live',
      '--duration-seconds',
      '120',
      '--interrupt-after-seconds',
      '30',
    ],
    { timeoutMs: 900_000 },
  );
  const report = lastJsonLine(result.stdout);
  const kept =
    report === null
      ? null
      : Object.fromEntries(
          [
            'closure',
            'connections',
            'connector_version',
            'duration_seconds',
            'end',
            'finished_at_utc',
            'frames',
            'incidents',
            'interrupt_after_seconds',
            'reconnect_waits_ms',
            'reconnections',
            'recovery',
            'started_at_utc',
            'status',
            'symbol',
          ].map((key) => [key, report[key]]),
        );
  record({
    exit: result.code,
    finished_at_utc: result.finished_at_utc,
    raw: result.raw,
    report: kept,
    started_at_utc: result.started_at_utc,
    step: 'smoke',
  });
  results.checks = {
    item2_desconexion: {
      pass:
        result.code === 0 &&
        report?.status === 'passed' &&
        report?.reconnections === 1 &&
        report?.recovery?.status === 'complete' &&
        report?.closure?.closure_type === 'requested',
    },
  };
}

/** Punto 9: los datasets sintéticos con el mismo `dataset_id`. */
async function replay() {
  const env = throwawayEnv();
  const expected = ['', 'zero-valid-ticks'].map(
    (dir) =>
      JSON.parse(
        readFileSync(
          join(root, 'test-vectors', 'market-data', 'v1', dir, 'expected-dataset.canonical.json'),
          'utf8',
        ),
      ).dataset_id,
  );
  const replays = [];
  let published = null;
  try {
    await prepareStorage(env);
    const publish = await run(
      'fixture-publish',
      'pnpm',
      ['--filter', '@buoh/market-data-worker', 'run', 'fixture:publish'],
      { env, timeoutMs: 300_000 },
    );
    published = lastJsonLine(publish.stdout);
    record({
      exit: publish.code,
      finished_at_utc: publish.finished_at_utc,
      raw: publish.raw,
      report: published,
      started_at_utc: publish.started_at_utc,
      step: 'fixture_publish',
    });
    for (const datasetId of expected) {
      for (const mode of [[], ['--verify-only']]) {
        const result = await run(
          `replay${mode.length > 0 ? '-verify' : ''}`,
          'pnpm',
          ['run', 'data:replay', '--', '--dataset', datasetId, ...mode],
          { env, timeoutMs: 300_000 },
        );
        const report = lastJsonLine(result.stdout);
        const step = {
          exit: result.code,
          expected_dataset_id: datasetId,
          finished_at_utc: result.finished_at_utc,
          raw: result.raw,
          report,
          same_dataset_id: report?.dataset_id === datasetId,
          started_at_utc: result.started_at_utc,
          step: 'replay',
        };
        replays.push(step);
        record(step);
      }
    }
  } catch (error) {
    results.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    await deleteStorage(env);
  }
  const publishedIds = (published?.results ?? []).map((entry) => entry.dataset_id).sort();
  results.checks = {
    item9_replay: {
      expected_dataset_ids: expected,
      pass:
        JSON.stringify(publishedIds) === JSON.stringify([...expected].sort()) &&
        replays.length === 4 &&
        replays.every(
          (step) =>
            step.exit === 0 &&
            step.same_dataset_id &&
            ['reproduced', 'verified'].includes(step.report?.status),
        ),
      published_dataset_ids: publishedIds,
    },
    retention_deleted: {
      pass: results.deletion?.schema_gone === true && results.deletion?.bucket_gone === true,
    },
  };
}

/** Las órdenes que paran y arrancan cada servicio, con `data:health` en cada paso. */
async function servicios() {
  const env = throwawayEnv();
  const observed = [];
  try {
    await prepareStorage(env);
    observed.push(['inicio', await health('inicio', env)]);
    for (const name of ['s3', 'pg']) {
      await service(name, 'stop', env);
      observed.push([`${name}-parado`, await health(`${name}-parado`, env)]);
      await service(name, 'start', env);
      observed.push([`${name}-arrancado`, await health(`${name}-arrancado`, env)]);
    }
  } catch (error) {
    results.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    await deleteStorage(env);
  }
  const unavailable = (step) =>
    step.alerts.some((alert) => alert.event === 'data_health_storage_unavailable');
  const expected = [false, true, false, true, false];
  results.checks = {
    retention_deleted: {
      pass: results.deletion?.schema_gone === true && results.deletion?.bucket_gone === true,
    },
    service_control: {
      observed: observed.map(([label, step]) => ({
        alerts: step.alerts.map((alert) => `${alert.event}:${alert.reason}`),
        exit: step.exit,
        label,
        service_health: step.service_health,
      })),
      pass:
        observed.length === expected.length &&
        observed.every(([, step], index) => unavailable(step) === expected[index]),
    },
  };
}

const sequences = { reinicios, replay, servicios, smoke };
await sequences[sequence]();
results.finished_at_utc = now();
save();
const passed = Object.values(results.checks).every((check) => check.pass === true);
console.log(JSON.stringify({ checks: results.checks, results: join(runDir, 'results.json') }));
process.exitCode = passed && results.error === undefined ? 0 : 1;
