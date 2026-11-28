// Evidencia de memoria de la vista de cada instante (ADR-0024 §2 y §11, PR 2). No es un comando del
// producto: usa la librería compilada de `packages/domain`, sin red ni servicios.
//
// Uso, desde la raíz del repositorio, con el dominio compilado (`pnpm run build`) y Node 24.22.0:
//
//   node scripts/evidencia-f2-7/medir-memoria-vista.mjs [--repeticiones 3]
//
// Mide, en procesos aparte con los tamaños de V8 de `ingest` (`--max-semi-space-size=1` y
// `--max-old-space-size=256`), la vista sobre un log sintético de R_100 de 1 día y de 7 días: una
// conexión, un tick cada 2 s y un `pong` cada 90 s, y al final una continuidad pendiente que llega
// al techo de lo retenido (un cierre no pedido, la reconexión y 16 000 ticks más) y un resultado
// `complete`. Los eventos se generan al vuelo, así que lo que crece con el log solo puede ser de la
// vista. Toma el máximo de memoria residente de cada proceso (`process.resourceUsage().maxRSS`),
// el mayor de las repeticiones, y comprueba el criterio de §11: con 7 días, no más de un 10 % por
// encima de 1 día. Escribe un JSON en stdout. Salida 0 si se cumple, 1 si no y 2 con argumentos que
// no valen.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { sha256Hex } from '../../packages/contracts/dist/index.js';
import {
  createPipelineProfile,
  DATA_VIEW_RETENTION_LIMIT,
  DataView,
} from '../../packages/domain/dist/index.js';

const V8_FLAGS = ['--max-semi-space-size=1', '--max-old-space-size=256'];
const SYMBOL = 'SYNTH_100';
const T0 = 1767225600;

const { values } = parseArgs({
  options: {
    dias: { type: 'string' },
    hijo: { type: 'boolean' },
    repeticiones: { type: 'string' },
  },
});

/** Un ID de evento con el número `sequence`. */
const idOf = (sequence) => `019b76da-a800-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
const connectionOf = (index) =>
  `019b76da-a800-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`;
const iso = (ms) => new Date(ms).toISOString();

/** El log sintético de `days` días, evento a evento. */
function* syntheticLog(days) {
  let sequence = 0;
  const raw = (connection, payload, receivedMs) => {
    sequence += 1;
    return {
      connection_id: connection,
      connector_version: 'fixture-v1',
      kind: 'raw_source_frame',
      observation_id: idOf(sequence),
      payload_utf8: payload,
      raw_payload_sha256: sha256Hex(payload),
      received_at_utc: iso(receivedMs),
      schema_version: '1.0.0',
      source: 'synthetic',
    };
  };
  const tick = (connection, second) =>
    raw(
      connection,
      `{"msg_type":"tick","tick":{"epoch":${String(T0 + second)},"pip_size":3,"quote":100.${String(second % 1000).padStart(3, '0')},"symbol":"${SYMBOL}"}}`,
      (T0 + second) * 1000 + 40,
    );
  const other = (kind, connection, occurredMs, extra) => {
    sequence += 1;
    return {
      connection_id: connection,
      event_id: idOf(sequence),
      kind,
      occurred_at_utc: iso(occurredMs),
      schema_version: '1.0.0',
      source: 'synthetic',
      ...extra,
    };
  };
  const first = connectionOf(0);
  yield other('connection_opened', first, T0 * 1000 - 1000, { supersedes_connection_id: null });
  const seconds = days * 86_400;
  let second = 0;
  for (; second < seconds; second += 2) {
    yield tick(first, second);
    if (second % 90 === 0) {
      yield raw(first, '{"msg_type":"ping","ping":"pong"}', (T0 + second) * 1000 + 500);
    }
  }
  // La continuidad pendiente que llega al techo, y su resultado.
  const watermark = second - 2;
  yield other('connection_closed', first, (T0 + watermark) * 1000 + 500, {
    affected_symbols: [SYMBOL],
    closure_type: 'timeout',
    reason: 'ping_timeout',
  });
  const next = connectionOf(1);
  yield other('connection_opened', next, (T0 + watermark) * 1000 + 600, {
    supersedes_connection_id: first,
  });
  const end = watermark + 10;
  for (let index = 0; index < DATA_VIEW_RETENTION_LIMIT + 10; index += 1) {
    yield tick(next, end + index * 2);
  }
  yield other(
    'history_recovery_result',
    next,
    (T0 + end + DATA_VIEW_RETENTION_LIMIT * 2 + 30) * 1000,
    {
      from_event_time_utc: iso((T0 + watermark) * 1000 + 1),
      recovered_event_count: 0,
      status: 'complete',
      symbol: SYMBOL,
      to_event_time_utc: iso((T0 + end) * 1000 - 1),
    },
  );
}

function profile() {
  const root = fileURLToPath(new URL('../../test-vectors/market-data/v1/', import.meta.url));
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(
      JSON.stringify({
        allowed_symbols: [SYMBOL],
        gap_detection: 'after_reconnection',
        maximum_delivery_delay_ms: 3000,
        maximum_event_gap_ms: 2000,
        non_tick_msg_types: ['history', 'ping'],
        profile_id: 'synthetic-view-memory',
        quality_rule_version: '3.0.0',
        source: 'synthetic',
      }),
    ),
    source_schema_bytes: readFileSync(`${root}source-schema.json`),
    source_schema_release: 'synthetic-v1',
  });
}

/** El proceso medido: aplica el log y escribe su máximo de memoria residente. */
function child(days) {
  const started = process.hrtime.bigint();
  const view = new DataView(profile());
  let events = 0;
  let ticks = 0;
  let health = 0;
  let maxBatch = 0;
  for (const event of syntheticLog(days)) {
    // 150 eventos por segmento y 288 segmentos por dataset: unos 5 minutos y un día.
    const segment = Math.floor(events / 150);
    const emitted = view.apply(event, {
      dataset_id: `dataset-${String(Math.floor(segment / 288))}`,
      segment_index: segment,
    });
    events += 1;
    let batch = 0;
    for (const item of emitted) {
      if (item.kind === 'tick') {
        ticks += 1;
        batch += 1;
      } else {
        health += 1;
      }
    }
    maxBatch = Math.max(maxBatch, batch);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(
    `${JSON.stringify({
      days,
      events,
      health_events: health,
      max_rss_kib: process.resourceUsage().maxRSS,
      max_ticks_in_one_event: maxBatch,
      state_json_bytes: JSON.stringify(view.state()).length,
      ticks,
      us_per_event: Math.round((elapsedMs * 1000) / events),
    })}\n`,
  );
}

function measure(days) {
  return new Promise((resolvePromise, reject) => {
    const script = fileURLToPath(import.meta.url);
    const proc = spawn(process.execPath, [...V8_FLAGS, script, '--hijo', '--dias', String(days)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`El proceso de ${String(days)} días salió con ${String(code)}.`));
        return;
      }
      resolvePromise(JSON.parse(output));
    });
  });
}

if (values.hijo === true) {
  child(Number(values.dias));
} else {
  const repetitions = Number(values.repeticiones ?? '3');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    console.error('Uso: node scripts/evidencia-f2-7/medir-memoria-vista.mjs [--repeticiones 3]');
    process.exit(2);
  }
  const runs = { 1: [], 7: [] };
  for (let index = 0; index < repetitions; index += 1) {
    for (const days of [1, 7]) {
      runs[days].push(await measure(days));
    }
  }
  const peak = (days) => Math.max(...runs[days].map((item) => item.max_rss_kib));
  const ratio = peak(7) / peak(1);
  const report = {
    node: process.version,
    v8_flags: V8_FLAGS,
    runs,
    max_rss_mib: { 1: peak(1) / 1024, 7: peak(7) / 1024 },
    ratio_7_to_1: Math.round(ratio * 1000) / 1000,
    criterion: ratio <= 1.1 ? 'met' : 'not_met',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(ratio <= 1.1 ? 0 : 1);
}
