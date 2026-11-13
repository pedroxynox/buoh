// Estimación de la memoria de publicar y de reproducir un dataset vivo con el código de hoy
// (ADR-0020, «Medición» y §7). No es un comando del producto ni la evidencia del criterio de §7, que
// mide el PR 3 con su código: sirve para elegir el techo. Lee segmentos reales de la captura de
// producción con el acceso de solo lectura del agente (ADR-0018 §12), como `medir-umbrales.mjs`, y
// los publica en almacenes en memoria con un perfil de publicación de prueba, que nunca sale del
// proceso. Solo escribe tamaños, conteos y memoria, nunca una cotización.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`), los Secrets de
// Kiro Web del agente y los tamaños de V8 de producción (`WORKER_NODE_FLAGS`), una vez por fase:
//
//   pnpm exec node --expose-gc --max-semi-space-size=1 --max-old-space-size=256 \
//     scripts/evidencia-f2-5/medir-memoria-publicacion.mjs --log 2 --desde 300 --segmentos 105 \
//     --fase publicar|reproducir
//
// - `publicar`: lee los segmentos y mide `publishDataset` (ADR-0004 §8, con `deriveMarketData`).
// - `reproducir`: publica igual, suelta todo salvo los almacenes en memoria, y mide `replayDataset`
//   en recomputación. Es un techo, porque el proceso conserva lo que dejó la publicación.
//
// La memoria es el máximo de memoria residente del proceso (`process.resourceUsage().maxRSS`).
import { parseArgs } from 'node:util';

import {
  createPool,
  createS3Client,
  DERIV_CONNECTOR_VERSION,
  DERIV_NON_TICK_MSG_TYPES,
  DERIV_SCHEMA_RELEASE,
  DERIV_SOURCE,
  InMemoryObjectStore,
  logLocation,
  PostgresSourceLogStore,
  readStoredSourceSchema,
  replayDataset,
  S3ObjectStore,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/lectura.js';
import { WORKER_NODE_FLAGS } from '../../apps/market-data-worker/dist/node-flags.js';
import { publishDataset } from '../../apps/market-data-worker/dist/publication.js';
import { canonicalJson } from '../../packages/contracts/dist/index.js';
import { createPipelineProfile, utf8 } from '../../packages/domain/dist/index.js';

const BUCKET = 'buoh-captura';

const { values } = parseArgs({
  options: {
    desde: { type: 'string' },
    fase: { type: 'string' },
    log: { type: 'string' },
    segmentos: { type: 'string' },
  },
});
const logNumber = Number(values.log);
const from = Number(values.desde);
const count = Number(values.segmentos);
if (
  ![logNumber, from, count].every(Number.isSafeInteger) ||
  logNumber < 1 ||
  from < 0 ||
  count < 1 ||
  !['publicar', 'reproducir'].includes(values.fase ?? '')
) {
  console.error(
    'Uso: medir-memoria-publicacion.mjs --log 2 --desde 300 --segmentos 105 --fase publicar|reproducir',
  );
  process.exit(2);
}
if (WORKER_NODE_FLAGS.some((flag) => !process.execArgv.includes(flag))) {
  console.error(`Arranca Node con ${WORKER_NODE_FLAGS.join(' ')}, los tamaños de producción.`);
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

/** El registro de publicaciones, en memoria: el replay lo lee igual que el de PostgreSQL. */
class MemoryMetadata {
  #records = new Map();
  findActivePublication(datasetId) {
    return Promise.resolve(this.#records.get(datasetId) ?? null);
  }
  commitPublication(input) {
    this.#records.set(input.record.dataset_id, input.record);
    return Promise.resolve();
  }
}

const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const maxRssMib = () => mib(process.resourceUsage().maxRSS * 1024);

/** Lee los segmentos del rango con el acceso de solo lectura y arma el perfil de prueba. */
async function readRange() {
  const location = logLocation(logNumber);
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
        listClosedSegments: (source, a, b) => store.listClosedSegments(source, a, b),
        readLiveCheckpoint: (source, sha, below) => store.readLiveCheckpoint(source, sha, below),
        readLogState: (source) => store.readLogState(source),
      },
      zlibVersion: process.versions.zlib,
    });
    const schema = await readStoredSourceSchema(objects, DERIV_SCHEMA_RELEASE);
    if (schema.status !== 'found') {
      throw new Error(`source_schema_${schema.status}`);
    }
    const profile = createPipelineProfile({
      connector_version: DERIV_CONNECTOR_VERSION,
      quality_profile_bytes: utf8(
        canonicalJson({
          allowed_symbols: ['R_100'],
          gap_detection: 'after_reconnection',
          maximum_delivery_delay_ms: 3000,
          maximum_event_gap_ms: 2000,
          non_tick_msg_types: [...DERIV_NON_TICK_MSG_TYPES],
          profile_id: `${DERIV_SOURCE}-publication-probe-R_100`,
          quality_rule_version: '2.0.0',
          source: DERIV_SOURCE,
        }),
      ),
      source_schema_bytes: schema.bytes,
      source_schema_release: DERIV_SCHEMA_RELEASE.release,
    });
    const segments = [];
    for (let index = from; index < from + count; index += 1) {
      segments.push((await log.readClosedSegment(index)).events);
    }
    return { profile, segments };
  } finally {
    await pool.end().catch(() => undefined);
    s3.destroy();
  }
}

try {
  const read = await readRange();
  const afterRead = maxRssMib();
  const objects = new InMemoryObjectStore('medicion');
  const metadata = new MemoryMetadata();
  // En una función, para que la publicación se pueda soltar antes de reproducir.
  const published = await (async () => {
    const publication = await publishDataset({
      environment: 'test',
      metadata,
      objects,
      profile: read.profile,
      publication_id: '01900000-0000-7000-8000-000000000000',
      published_at_utc: '2026-11-13T00:00:00.000Z',
      segments: read.segments,
      zlibVersion: process.versions.zlib,
    });
    return {
      dataset_id: publication.dataset_id,
      events: publication.core.source_event_count,
      ticks: publication.core.normalized_tick_count,
    };
  })();
  const result = {
    fase: values.fase,
    log: logNumber,
    desde: from,
    segmentos: count,
    eventos: published.events,
    ticks: published.ticks,
    tras_leer_mib: afterRead,
  };
  if (values.fase === 'publicar') {
    result.max_rss_mib = maxRssMib();
  } else {
    read.segments.length = 0;
    globalThis.gc?.();
    const report = await replayDataset({
      datasetId: published.dataset_id,
      environment: 'test',
      metadata,
      mode: 'recompute',
      objects,
    });
    result.replay = report.status;
    result.max_rss_mib = maxRssMib();
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error?.code ?? error?.name ?? 'error' }));
  process.exitCode = 1;
}
