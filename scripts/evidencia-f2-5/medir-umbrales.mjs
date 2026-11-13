// Medición de los umbrales live de R_100 (`F2-THRESHOLD-001`; ADR-0020, «Medición»). No es un
// comando del producto: lee la captura de producción con el acceso de solo lectura del agente
// (ADR-0018 §12), con la librería compilada del worker, y solo saca horas, tiempos y conteos, nunca
// una cotización.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`) y los Secrets de
// Kiro Web del agente (`BUOH_AGENTE_POSTGRES_HOST`, `BUOH_AGENTE_POSTGRES_PASSWORD`,
// `BUOH_AGENTE_S3_ENDPOINT`, `BUOH_AGENTE_S3_ACCESS_KEY_ID` y `BUOH_AGENTE_S3_SECRET_ACCESS_KEY`):
//
//   node scripts/evidencia-f2-5/medir-umbrales.mjs --logs 2,3 [--hasta 2026-11-13T00:00:00.000Z]
//
// Con `--hasta`, ignora los eventos de esa hora en adelante (la de recepción de un frame o la del
// evento), para que la misma ventana dé siempre las mismas cifras mientras los logs no venzan.
//
// Recorre los segmentos cerrados de cada log, en orden y con lecturas adelantadas, y mide:
//
// - el retraso de entrega de cada tick de R_100 (recepción menos hora de fuente), aparte el del primer
//   tick de cada conexión, que espera la suscripción. La hora de fuente de Deriv tiene segundos
//   enteros, así que el retraso medido puede pasar del real hasta en 999 ms;
// - el intervalo entre ticks seguidos de una misma conexión, y cada intervalo mayor que el nominal
//   de 2 s, con sus horas;
// - la separación tras cada cierre no pedido: del high-watermark del primer cierre al primer tick
//   posterior al high-watermark del último cierre (las reglas de continuidad de los contratos de
//   dominio). Aparte, la de cada cierre pedido;
// - cada `HistoryRecoveryResult`, y si `recovered_event_count` coincide con los tiempos distintos
//   entre S y E de las páginas `history` del último intento (ADR-0020 §3): las de la misma conexión
//   desde el resultado anterior, con un `req_id` igual o mayor que el de la de mayor `req_id` cuya
//   petición (`echo_req.end`) termina en E. Cuenta también los intentos (las páginas que terminan
//   en E) y las páginas del último.
//
// Los percentiles son de rango más cercano, como `distribution()` del smoke. Escribe un JSON en
// stdout, y un fallo sale con código 1 y su código o el nombre del error, nunca su mensaje.
import { parseArgs } from 'node:util';

import {
  createPool,
  createS3Client,
  DERIV_SOURCE,
  logLocation,
  PostgresSourceLogStore,
  S3ObjectStore,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/lectura.js';

const SYMBOL = 'R_100';
const NOMINAL_INTERVAL_MS = 2000;
const PREFETCH = 8;
const BUCKET = 'buoh-captura';

const { values } = parseArgs({
  options: { hasta: { type: 'string' }, logs: { type: 'string' } },
});
const logs = (values.logs ?? '')
  .split(',')
  .filter((value) => value !== '')
  .map(Number);
if (logs.length === 0 || logs.some((value) => !Number.isSafeInteger(value) || value < 1)) {
  console.error('Uso: node scripts/evidencia-f2-5/medir-umbrales.mjs --logs 2,3');
  process.exit(2);
}
const until = values.hasta === undefined ? Infinity : Date.parse(values.hasta);
if (Number.isNaN(until)) {
  console.error('--hasta tiene que ser una hora UTC, como 2026-11-13T00:00:00.000Z.');
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

/** Cuenta `key` en el histograma `map`. */
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** Distribución de un histograma: conteo, mínimo, percentiles de rango más cercano y máximo. */
function distribution(map) {
  const entries = [...map.entries()].sort((left, right) => left[0] - right[0]);
  const count = entries.reduce((sum, [, n]) => sum + n, 0);
  if (count === 0) {
    return null;
  }
  const at = (quantile) => {
    const rank = Math.max(1, Math.ceil(quantile * count));
    let seen = 0;
    for (const [value, n] of entries) {
      seen += n;
      if (seen >= rank) {
        return value;
      }
    }
    return entries.at(-1)[0];
  };
  const above = (limit) =>
    entries.filter(([value]) => value > limit).reduce((s, [, n]) => s + n, 0);
  return {
    count,
    min: entries[0][0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    p99_9: at(0.999),
    p99_99: at(0.9999),
    max: entries.at(-1)[0],
    above_1000: above(1000),
    above_2000: above(2000),
    above_3000: above(3000),
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** Ticks que faltan en las separaciones de un histograma, con un tick cada intervalo nominal. */
const missingTicks = (map) =>
  [...map.entries()].reduce(
    (sum, [separation, n]) => sum + n * (separation / NOMINAL_INTERVAL_MS - 1),
    0,
  );

const totals = {
  delay: new Map(),
  firstTickDelay: new Map(),
  interval: new Map(),
  separation: new Map(),
  requestedSeparation: new Map(),
};
const report = {
  logs: [],
  silences: [],
  late_ticks: [],
  reconnections: [],
  requested_stops: [],
  history: {
    results: 0,
    by_status: {},
    recovered_ticks: 0,
    attempts_per_result: {},
    last_attempt_pages_per_result: {},
    count_matches: 0,
    count_mismatches: [],
  },
};

/** Mide un log entero y suma lo suyo a `totals` y `report`. */
async function measureLog(pool, s3, number) {
  const location = logLocation(number);
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

  const own = { log: number, segments: 0, events: 0, ticks: 0, connections: 0 };
  own.first_event_utc = null;
  own.last_event_utc = null;
  let highWatermark = null;
  const lastByConnection = new Map();
  const historyPages = new Map(); // connection_id -> páginas `history` desde el último resultado
  const pending = { unrequested: null, requested: null };

  const onTick = (event, epochMs) => {
    const delay = Date.parse(event.received_at_utc) - epochMs;
    own.ticks += 1;
    const last = lastByConnection.get(event.connection_id);
    if (last === undefined) {
      own.connections += 1;
      bump(totals.firstTickDelay, delay);
    } else {
      bump(totals.delay, delay);
      if (delay > 3000) {
        report.late_ticks.push({ event_time_utc: iso(epochMs), delay_ms: delay });
      }
      if (epochMs > last) {
        bump(totals.interval, epochMs - last);
        if (epochMs - last > NOMINAL_INTERVAL_MS) {
          report.silences.push({
            from_utc: iso(last),
            to_utc: iso(epochMs),
            interval_ms: epochMs - last,
          });
        }
      }
    }
    lastByConnection.set(event.connection_id, Math.max(last ?? 0, epochMs));
    for (const kind of ['unrequested', 'requested']) {
      const gap = pending[kind];
      if (gap !== null && gap.reopened && epochMs > gap.closeWatermark) {
        const separation = epochMs - gap.startWatermark;
        if (kind === 'unrequested') {
          bump(totals.separation, separation);
          report.reconnections.push({
            closed_at_utc: gap.closedAt,
            closure_type: gap.closureType,
            reason: gap.reason,
            reasons: gap.reasons,
            closures: gap.closures,
            separation_ms: separation,
          });
        } else {
          bump(totals.requestedSeparation, separation);
          report.requested_stops.push({ closed_at_utc: gap.closedAt, separation_ms: separation });
        }
        pending[kind] = null;
      }
    }
    if (highWatermark === null || epochMs > highWatermark) {
      highWatermark = epochMs;
    }
  };

  const onHistoryResult = (event) => {
    const pages = historyPages.get(event.connection_id) ?? [];
    historyPages.set(event.connection_id, []);
    if (event.symbol !== SYMBOL) {
      return;
    }
    report.history.results += 1;
    report.history.by_status[event.status] = (report.history.by_status[event.status] ?? 0) + 1;
    if (event.status !== 'complete') {
      return;
    }
    report.history.recovered_ticks += event.recovered_event_count;
    const start = (Date.parse(event.from_event_time_utc) - 1) / 1000;
    const end = (Date.parse(event.to_event_time_utc) + 1) / 1000;
    const starts = pages.filter((page) => page.end === end);
    const firstReqId = Math.max(...starts.map((page) => page.reqId));
    const lastAttempt = starts.length === 0 ? [] : pages.filter((page) => page.reqId >= firstReqId);
    const tally = (key, value) => {
      report.history[key][value] = (report.history[key][value] ?? 0) + 1;
    };
    tally('attempts_per_result', starts.length);
    tally('last_attempt_pages_per_result', lastAttempt.length);
    const times = new Set();
    for (const page of lastAttempt) {
      for (const time of page.times) {
        if (time > start && time < end) {
          times.add(time);
        }
      }
    }
    if (times.size === event.recovered_event_count) {
      report.history.count_matches += 1;
    } else {
      report.history.count_mismatches.push({
        occurred_at_utc: event.occurred_at_utc,
        recovered_event_count: event.recovered_event_count,
        distinct_times: times.size,
        pages: pages.length,
      });
    }
  };

  let reachedUntil = false;
  const onEvent = (event) => {
    const at = event.received_at_utc ?? event.occurred_at_utc;
    if (reachedUntil || Date.parse(at) >= until) {
      reachedUntil = true;
      return;
    }
    own.events += 1;
    own.first_event_utc ??= at;
    own.last_event_utc = at;
    if (event.kind === 'raw_source_frame') {
      let payload;
      try {
        payload = JSON.parse(event.payload_utf8);
      } catch {
        return;
      }
      if (payload?.msg_type === 'tick' && payload.tick?.symbol === SYMBOL) {
        const epoch = Number(payload.tick.epoch);
        if (Number.isSafeInteger(epoch)) {
          onTick(event, epoch * 1000);
        }
      } else if (payload?.msg_type === 'history' && payload.echo_req?.ticks_history === SYMBOL) {
        const times = payload.history?.times;
        if (Array.isArray(times) && times.every((time) => Number.isSafeInteger(time))) {
          const list = historyPages.get(event.connection_id) ?? [];
          list.push({ end: Number(payload.echo_req.end), reqId: Number(payload.req_id), times });
          historyPages.set(event.connection_id, list);
        }
      }
    } else if (event.kind === 'connection_closed') {
      if (!event.affected_symbols.includes(SYMBOL) || highWatermark === null) {
        return;
      }
      const kind = event.closure_type === 'requested' ? 'requested' : 'unrequested';
      const current = pending[kind];
      pending[kind] = {
        closeWatermark: highWatermark,
        closedAt: current?.closedAt ?? event.occurred_at_utc,
        closureType: event.closure_type,
        closures: (current?.closures ?? 0) + 1,
        reason: event.reason,
        reasons: [...(current?.reasons ?? []), event.reason],
        reopened: false,
        startWatermark: current?.startWatermark ?? highWatermark,
      };
    } else if (event.kind === 'connection_opened') {
      for (const gap of Object.values(pending)) {
        if (gap !== null) {
          gap.reopened = true;
        }
      }
    } else if (event.kind === 'history_recovery_result') {
      onHistoryResult(event);
    }
  };

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
  for (let index = 0; index <= lastClosed; index += 1) {
    const { events } = await reads.get(index);
    reads.delete(index);
    request(index + PREFETCH);
    for (const event of events) {
      onEvent(event);
    }
    if (reachedUntil) {
      break;
    }
    own.segments += 1;
  }
  report.logs.push(own);
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
  for (const number of logs) {
    await measureLog(pool, s3, number);
  }
  report.reconnections.sort((left, right) => right.separation_ms - left.separation_ms);
  const reasons = {};
  for (const { reason } of report.reconnections) {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        logs: report.logs,
        delivery_delay_ms: distribution(totals.delay),
        first_tick_delay_ms: distribution(totals.firstTickDelay),
        late_ticks_over_3000_ms: report.late_ticks,
        interval_ms: distribution(totals.interval),
        silences: report.silences,
        reconnection_separation_ms: distribution(totals.separation),
        reconnections_at_nominal_interval: totals.separation.get(NOMINAL_INTERVAL_MS) ?? 0,
        reconnection_missing_ticks: missingTicks(totals.separation),
        reconnection_reasons: reasons,
        longest_reconnections: report.reconnections.slice(0, 5),
        requested_separation_ms: distribution(totals.requestedSeparation),
        requested_missing_ticks: missingTicks(totals.requestedSeparation),
        history: report.history,
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
