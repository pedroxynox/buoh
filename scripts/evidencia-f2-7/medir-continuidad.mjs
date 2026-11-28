// La continuidad pendiente más larga de producción (ADR-0024 §2, PR 2). No es un comando del
// producto: lee la captura de producción con el acceso de solo lectura del agente (ADR-0018 §12),
// con las librerías compiladas del worker y del dominio, y solo saca horas, duraciones y conteos,
// nunca una cotización.
//
// Uso, desde la raíz del repositorio, con todo compilado (`pnpm run build`) y los Secrets de Kiro
// Web del agente (`BUOH_AGENTE_POSTGRES_HOST`, `BUOH_AGENTE_POSTGRES_PASSWORD`,
// `BUOH_AGENTE_S3_ENDPOINT`, `BUOH_AGENTE_S3_ACCESS_KEY_ID` y `BUOH_AGENTE_S3_SECRET_ACCESS_KEY`):
//
//   node scripts/evidencia-f2-7/medir-continuidad.mjs --secuencia R_100 [--logs 2,3]
//     [--memoria-desde 2026-11-28T00:00:00.000Z]
//
// Sin `--logs`, recorre todos los logs escritos de la secuencia (`R_100` o `frxXAUUSD`). De cada log lee sus
// segmentos cerrados, en orden y con lecturas adelantadas, arma su perfil como `data:health` (la
// fila de `log_quality_profile` y el esquema de fuente guardado) y aplica cada evento a la vista de
// cada instante (`DataView`), como un backtest. Cada continuidad pendiente va desde la salud de la
// vista que la nombra hasta la que ya no: mide su duración por el instante de la vista, los frames
// de tick que llegaron mientras tanto (los que cuentan para el techo de 16 000) y cuántos ticks dio
// la vista al decidirla. Con `--memoria-desde`, lee además la memoria del paso `memory` de
// `buoh-operaciones` desde esa hora, en el log activo de R_100. Escribe un JSON en stdout, y un fallo
// sale con código 1 y su código o el nombre del error, nunca su mensaje.
import { parseArgs } from 'node:util';

import {
  createDerivLogProfile,
  createPool,
  createS3Client,
  DERIV_SCHEMA_RELEASE,
  DERIV_SOURCE,
  findActiveLog,
  listCaptureLogs,
  logLocation,
  PostgresSourceLogStore,
  readLogQualityProfile,
  readStoredSourceSchema,
  S3ObjectStore,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/lectura.js';
import {
  GOLD_SEQUENCE,
  R_100_SEQUENCE,
} from '../../apps/market-data-worker/dist/successive-logs.js';
import { DATA_VIEW_RETENTION_LIMIT, DataView } from '../../packages/domain/dist/index.js';

const PREFETCH = 8;
const BUCKET = 'buoh-captura';
const SEQUENCES = { R_100: R_100_SEQUENCE, frxXAUUSD: GOLD_SEQUENCE };

const { values } = parseArgs({
  options: {
    logs: { type: 'string' },
    'memoria-desde': { type: 'string' },
    secuencia: { type: 'string' },
  },
});
const symbol = values.secuencia ?? '';
const sequence = SEQUENCES[symbol];
const requested = (values.logs ?? '')
  .split(',')
  .filter((value) => value !== '')
  .map(Number);
const memorySince = values['memoria-desde'];
if (
  sequence === undefined ||
  requested.some((value) => !Number.isSafeInteger(value) || value < 1) ||
  (memorySince !== undefined && Number.isNaN(Date.parse(memorySince)))
) {
  console.error(
    'Uso: node scripts/evidencia-f2-7/medir-continuidad.mjs --secuencia R_100|frxXAUUSD [--logs 2,3] [--memoria-desde <UTC>]',
  );
  process.exit(2);
}

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`Falta la variable ${name}.`);
    process.exit(2);
  }
  return value;
};

const isTickFrame = (event) =>
  event.kind === 'raw_source_frame' && event.payload_utf8.includes('"msg_type":"tick"');

/** Mide un log entero con la vista. */
async function measureLog(pool, s3, number) {
  const location = logLocation(number, sequence);
  const objects = new S3ObjectStore(s3, BUCKET, location.prefix);
  const store = new PostgresSourceLogStore(pool, { schema: location.schema });
  const refuse = () => Promise.reject(new Error('solo lectura'));
  const log = await SourceEventLog.open({
    objects: { bucket: BUCKET, get: (key, max) => objects.get(key, max), putIfAbsent: refuse },
    source: DERIV_SOURCE,
    store: {
      hasSourceEvent: (source, id) => store.hasSourceEvent(source, id),
      insertClosedSegment: refuse,
      insertIndexRow: refuse,
      insertLiveCheckpoint: refuse,
      listClosedSegments: (source, from, to) => store.listClosedSegments(source, from, to),
      readLiveCheckpoint: (source, sha, below) => store.readLiveCheckpoint(source, sha, below),
      readLogState: (source) => store.readLogState(source),
    },
    zlibVersion: 'solo-lectura',
  });
  const schema = await readStoredSourceSchema(objects, DERIV_SCHEMA_RELEASE);
  if (schema.status !== 'found') {
    return { log: number, skipped: `source_schema_${schema.status}` };
  }
  const row = await readLogQualityProfile(pool, location.schema);
  const profile = createDerivLogProfile({
    row,
    source_schema_bytes: schema.bytes,
    source_schema_release: DERIV_SCHEMA_RELEASE.release,
    symbol,
  });
  const view = new DataView(profile);

  const own = {
    log: number,
    profile_id: profile.quality_profile.profile_id,
    quality_rule_version: profile.rules.quality_rule_version,
    segments: 0,
    events: 0,
    ticks_given: 0,
    first_event_utc: null,
    last_event_utc: null,
    pending: [],
    largest_batch: 0,
    reached_retention_limit: 0,
  };
  let open = null;
  const lastClosed = log.openSegment().segment_index - 1;
  const reads = new Map();
  const request = (index) => {
    if (index <= lastClosed && !reads.has(index)) {
      const read = log.readClosedSegment(index);
      read.catch(() => undefined);
      reads.set(index, read);
    }
  };
  for (let index = 0; index < PREFETCH; index += 1) {
    request(index);
  }
  let lastInstant = null;
  for (let index = 0; index <= lastClosed; index += 1) {
    const { events } = await reads.get(index);
    reads.delete(index);
    request(index + PREFETCH);
    for (const event of events) {
      const emitted = view.apply(event, {
        dataset_id: `log-${String(number)}`,
        segment_index: index,
      });
      own.events += 1;
      const at = event.received_at_utc ?? event.occurred_at_utc;
      own.first_event_utc ??= at;
      own.last_event_utc = at;
      if (open !== null && isTickFrame(event)) {
        open.tick_frames += 1;
      }
      let batch = 0;
      for (const item of emitted) {
        if (item.kind === 'tick') {
          batch += 1;
          own.ticks_given += 1;
          lastInstant = item.instant_utc;
          continue;
        }
        lastInstant = item.instant_utc;
        const pending = item.pending_continuity_symbols.includes(symbol);
        if (pending && open === null) {
          open = { from_utc: item.instant_utc, tick_frames: 0 };
        } else if (!pending && open !== null) {
          own.pending.push({
            ...open,
            to_utc: item.instant_utc,
            duration_ms: Date.parse(item.instant_utc) - Date.parse(open.from_utc),
            decided_by:
              event.kind === 'history_recovery_result'
                ? `history_${event.status}`
                : event.kind === 'raw_source_frame'
                  ? 'separation'
                  : event.kind,
            ticks_given_when_decided: emitted.filter((entry) => entry.kind === 'tick').length,
          });
          open = null;
        }
      }
      own.largest_batch = Math.max(own.largest_batch, batch);
      if (batch >= DATA_VIEW_RETENTION_LIMIT) {
        own.reached_retention_limit += 1;
      }
    }
    own.segments += 1;
  }
  if (open !== null && lastInstant !== null) {
    own.pending.push({
      ...open,
      to_utc: lastInstant,
      duration_ms: Date.parse(lastInstant) - Date.parse(open.from_utc),
      decided_by: 'still_pending_at_last_closed_segment',
    });
  }
  own.unused_ticks = view.state().unused_ticks;
  own.pending_count = own.pending.length;
  own.longest_by_duration = own.pending
    .toSorted((l, r) => r.duration_ms - l.duration_ms)
    .slice(0, 3);
  own.longest_by_tick_frames = own.pending
    .toSorted((l, r) => r.tick_frames - l.tick_frames)
    .slice(0, 3);
  delete own.pending;
  return own;
}

/** La memoria del paso `memory` desde `since`: el principal más su hijo más grande. */
async function memoryReports(pool, since) {
  const active = await findActiveLog(pool, {
    now: () => new Date().toISOString(),
    source: DERIV_SOURCE,
  });
  if (active === null) {
    return null;
  }
  const { schema } = active;
  const { rows } = await pool.query(
    `SELECT observed_at_utc, status, report_jcs FROM "${schema}".operations_reports WHERE step = 'memory' AND observed_at_utc >= $1 ORDER BY observed_at_utc`,
    [since],
  );
  let highest = null;
  let withNull = 0;
  const statuses = {};
  for (const row of rows) {
    statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    const parsed = JSON.parse(row.report_jcs);
    const report = parsed.report ?? parsed;
    const children = Array.isArray(report.children) ? report.children : [];
    if (children.some((child) => child.max_rss_bytes === null)) {
      withNull += 1;
    }
    const biggest = Math.max(0, ...children.map((child) => child.max_rss_bytes ?? 0));
    const sum = (report.max_rss_bytes ?? 0) + biggest;
    if (highest === null || sum > highest.bytes) {
      highest = {
        at_utc: row.observed_at_utc,
        bytes: sum,
        mb: Math.round((sum / 1048576) * 10) / 10,
      };
    }
  }
  return {
    log: active.number,
    runs: rows.length,
    statuses,
    runs_with_null_child: withNull,
    highest,
  };
}

const pool = createPool(
  {
    database: 'buoh',
    host: env('BUOH_AGENTE_POSTGRES_HOST'),
    password: env('BUOH_AGENTE_POSTGRES_PASSWORD'),
    port: 5432,
    schema: 'public',
    sslMode: 'verify-full',
    user: 'buoh_agente',
  },
  { connectionTimeoutMillis: 15_000, query_timeout: 25_000 },
);
pool.on('error', () => undefined);
const s3 = createS3Client({
  accessKeyId: env('BUOH_AGENTE_S3_ACCESS_KEY_ID'),
  bucket: BUCKET,
  endpoint: env('BUOH_AGENTE_S3_ENDPOINT'),
  region: 'auto',
  secretAccessKey: env('BUOH_AGENTE_S3_SECRET_ACCESS_KEY'),
});

try {
  const { rows: sessions } = await pool.query(
    "SELECT count(*)::int AS other FROM pg_stat_activity WHERE usename = 'buoh_agente' AND pid <> pg_backend_pid()",
  );
  const numbers =
    requested.length > 0
      ? requested
      : (await listCaptureLogs(pool, DERIV_SOURCE, sequence))
          .filter((item) => item.readable && item.lastWriteUtc !== null)
          .map((item) => item.location.number);
  const logs = [];
  for (const number of numbers) {
    logs.push(await measureLog(pool, s3, number));
  }
  const all = logs.flatMap((item) => item.longest_by_duration ?? []);
  console.log(
    JSON.stringify(
      {
        measured_at_utc: new Date().toISOString(),
        symbol,
        other_agent_sessions_at_start: sessions[0]?.other ?? null,
        logs,
        longest_duration: all.toSorted((l, r) => r.duration_ms - l.duration_ms)[0] ?? null,
        most_tick_frames:
          logs
            .flatMap((item) => item.longest_by_tick_frames ?? [])
            .toSorted((l, r) => r.tick_frames - l.tick_frames)[0] ?? null,
        memory: memorySince === undefined ? undefined : await memoryReports(pool, memorySince),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ error: error?.code ?? error?.name ?? 'error' }));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
  s3.destroy();
}
