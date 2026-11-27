import { createHash, randomBytes } from 'node:crypto';

import {
  canonicalJson,
  DATA_DATASETS_LIMIT,
  dataDatasetsSchema,
  EMPTY_SEQUENCE_SHA256,
  type JsonValue,
} from '@buoh/contracts';
import { DATASETS_SCHEMA, migrateDatasets } from '@buoh/market-data-worker';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { createRateLimiter } from '../src/accounts/limits.js';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { createDataReader } from '../src/data/reader.js';
import type { ApiLogLine } from '../src/log.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { createReaderPool } from '../src/postgres/pool.js';
import { apiRoutes } from '../src/routes.js';

/**
 * Los datasets publicados de la sección Datos (ADR-0020 §10) contra el PostgreSQL local, sin TLS:
 * `GET /api/v2/datos/datasets` con el pool de lectura de la API y el código del worker por la ruta
 * `lectura`, agrupados por secuencia (ADR-0021 §5). El superusuario hace de `buoh-operaciones` y de la publicación: crea `buoh_datasets` con
 * sus migraciones, le da a un rol de prueba lo que tiene `buoh_lectura` y guarda los datasets, sus
 * incidencias, sus rangos y sus verificaciones con sus filas. Las sesiones son falsas.
 *
 * Los roles son de todo el servidor: la prueba borra los suyos y su base al empezar y al terminar.
 * Las contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api_datasets';
const READER_USER = 'buoh_integration_api_datasets_lectura';
const UNPRIVILEGED_USER = 'buoh_integration_api_datasets_sin_privilegios';
const readerPassword = randomBytes(24).toString('hex');
const SOURCE = 'deriv_options';
const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: '01900000-0000-7000-8000-00000000a001',
  lastActivityMs: 0,
};
const NOW = Date.parse('2026-11-14T13:00:00.000Z');

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let reader: Pool | undefined;

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

const readerConfig = (user = READER_USER): PostgresConfig => ({
  ...local,
  database: DATABASE,
  password: readerPassword,
  sslMode: 'disable',
  user,
});

const sessions: SessionService = {
  login: () => Promise.reject(new Error('sin inicio de sesión en esta prueba')),
  authenticate: (secret) => Promise.resolve(secret === SID ? SESSION : null),
  renewActivity: () => Promise.resolve(),
  logout: () => Promise.resolve(0),
  closeOthers: () => Promise.resolve(0),
  listAudit: () => Promise.resolve([]),
  csrfToken: () => '0'.repeat(64),
  validateCsrf: () => false,
  flushPendingFailures: () => Promise.resolve(),
};

/** `GET /api/v2/datos/datasets` con sesión y el pool de lectura `pool`. */
async function getDatasets(pool: Pool = ready(reader)) {
  const lines: ApiLogLine[] = [];
  let n = 0;
  const app = buildApp({
    log: (line) => lines.push(line),
    now: () => 0,
    requestId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
    origin: 'https://buoh.test',
    routes: apiRoutes({
      readiness: { isReady: () => true },
      links: {
        issueSecret: () => Promise.reject(new Error('sin enlaces en esta prueba')),
        useLink: () => Promise.reject(new Error('sin enlaces en esta prueba')),
      },
      sessions,
      preferences: {
        get: () => Promise.reject(new Error('sin preferencias en esta prueba')),
        set: () => Promise.reject(new Error('sin preferencias en esta prueba')),
      },
      limiter: createRateLimiter(),
      clock: () => NOW,
      data: createDataReader({ pool, clock: () => NOW, environment: 'test' }),
      market: null,
    }),
    rateLimit: () => 0,
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/datos/datasets',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SID}` },
    });
    return { body: response.json<unknown>(), lines, status: response.statusCode };
  } finally {
    await app.close();
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

let sequence = 0;
function nextUuid(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/**
 * `buoh_datasets` vacío, con sus migraciones y lo que tiene `buoh_lectura` en él (ADR-0020 §5), o, con
 * `migrated: false`, sin el esquema. Sus tablas son append-only: para empezar de cero se borra.
 */
async function resetDatasets({ migrated = true } = {}): Promise<void> {
  await ready(admin).query(`DROP SCHEMA IF EXISTS ${DATASETS_SCHEMA} CASCADE`);
  nextSegment.clear();
  if (!migrated) {
    return;
  }
  await migrateDatasets(ready(admin));
  await ready(admin).query(`GRANT USAGE ON SCHEMA ${DATASETS_SCHEMA} TO ${READER_USER}`);
  await ready(admin).query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${DATASETS_SCHEMA} TO ${READER_USER}`,
  );
}

/** El primer segmento del dataset siguiente de cada log de cada secuencia. */
const nextSegment = new Map<string, number>();

/** Los conteos de un core 1.1.0, el de un dataset de los lotes (ADR-0021 §3). */
interface BatchCounts {
  readonly candles: number;
  readonly sessions: number;
  readonly offers: number;
  readonly quotes: number;
}

interface DatasetInput {
  /** La secuencia del log (`dataset_log_ranges.sequence`); sin ella, R_100. */
  readonly sequence?: string;
  /** Con ellos, un core 1.1.0 de los lotes, sin ticks; sin ellos, uno 1.0.0 de la captura. */
  readonly batch?: BatchCounts;
  readonly log: number;
  readonly published: string;
  readonly environment?: string;
  readonly segments?: number;
  /** El período, o `null` sin ticks. */
  readonly period?: readonly [string, string] | null;
  readonly ticks?: number;
  /** Las incidencias: tipo y gravedad de cada una. */
  readonly incidents?: readonly (readonly [string, string])[];
  readonly pending?: readonly string[];
  readonly open?: readonly string[];
  /** Las verificaciones, en orden de escritura: modo, estado y código. */
  readonly verifications?: readonly (readonly [string, string, string | null])[];
  /** El `manifest_core` tal cual, para probar uno que no está en JCS. */
  readonly coreText?: (core: JsonValue) => string;
}

/** Un `DatasetManifestCore` válido con esos conteos: un artefacto por rol, en el segmento 0. */
function manifestCore(input: {
  readonly id: string;
  readonly period: readonly [string, string] | null;
  readonly ticks: number;
  readonly incidents: number;
  readonly batch?: BatchCounts | undefined;
}): JsonValue {
  const { batch } = input;
  // Los roles en su orden canónico; los de los lotes, solo en un core 1.1.0.
  const counts = {
    source_events: input.ticks + 4,
    normalized_ticks: input.ticks,
    ...(batch === undefined
      ? {}
      : {
          market_candles: batch.candles,
          trading_sessions: batch.sessions,
          contract_offers: batch.offers,
          contract_quotes: batch.quotes,
        }),
    quality_incidents: input.incidents,
    operational_conditions: 0,
  } as const;
  const batchFields =
    batch === undefined
      ? {}
      : {
          market_candle_schema_version: '1.0.0',
          trading_session_schema_version: '1.0.0',
          contract_offer_schema_version: '1.0.0',
          contract_quote_schema_version: '1.0.0',
          candle_time_from_utc: batch.candles === 0 ? null : '2026-11-26T00:00:00.000Z',
          candle_time_to_utc: batch.candles === 0 ? null : '2026-11-26T23:59:00.000Z',
          market_candle_count: batch.candles,
          trading_session_count: batch.sessions,
          contract_offer_count: batch.offers,
          contract_quote_count: batch.quotes,
        };
  return {
    ...batchFields,
    schema_version: batch === undefined ? '1.0.0' : '1.1.0',
    canonicalization_version: 'RFC8785',
    source: SOURCE,
    source_schema_release: 'synthetic-deriv-1',
    source_schema_sha256: sha256('esquema'),
    connector_version: batch === undefined ? 'deriv-options-ws-1.1.0' : 'deriv-options-lotes-1.0.0',
    normalizer_version: '3.0.0',
    quality_rule_version: batch === undefined ? '3.0.0' : '4.0.0',
    quality_profile_id:
      batch === undefined
        ? 'deriv_options-publication-v1-R_100'
        : 'deriv_options-lotes-v1-cotizaciones',
    quality_profile_sha256: sha256('perfil'),
    segment_policy_version: batch === undefined ? '1.0.0' : '2.0.0',
    source_event_schema_version: '1.0.0',
    market_tick_schema_version: '1.0.0',
    incident_schema_version: batch === undefined ? '2.0.0' : '3.0.0',
    condition_event_schema_version: '1.0.0',
    symbols: ['R_100'],
    event_time_from_utc: input.period?.[0] ?? null,
    event_time_to_utc: input.period?.[1] ?? null,
    source_event_count: counts.source_events,
    raw_frame_count: input.ticks + 2,
    normalized_tick_count: counts.normalized_ticks,
    incident_count: counts.quality_incidents,
    condition_event_count: counts.operational_conditions,
    logical_artifacts: Object.entries(counts).map(([role, count]) => ({
      artifact_id: `${role}:000000`,
      role,
      segment_index: 0,
      record_count: count,
      logical_content_sha256: count === 0 ? EMPTY_SEQUENCE_SHA256 : sha256(`${input.id}-${role}`),
    })),
  };
}

/**
 * Un dataset del log `log` publicado en `buoh_datasets` como lo hace `datasets:publish`, en una
 * transacción: el dataset, su publicación, sus incidencias y su rango, seguido del anterior del log;
 * después, sus verificaciones, como `buoh-operaciones`.
 */
async function publishDataset(input: DatasetInput) {
  const id = nextUuid();
  const batch = input.batch;
  const ticks = input.ticks ?? (input.period === null || batch !== undefined ? 0 : 5000);
  const incidents = input.incidents ?? [];
  const core = manifestCore({
    batch,
    id,
    incidents: incidents.length,
    period:
      input.period === undefined
        ? batch === undefined
          ? ['2026-11-01T00:00:00.000Z', '2026-11-01T05:59:58.000Z']
          : null
        : input.period,
    ticks,
  });
  const text = input.coreText?.(core) ?? canonicalJson(core);
  const datasetId = `sha256:${sha256(text)}`;
  const publicationId = nextUuid();
  const sequenceName = input.sequence ?? 'R_100';
  const key = `${sequenceName}:${String(input.log)}`;
  const first = nextSegment.get(key) ?? 0;
  const last = first + (input.segments ?? 72) - 1;
  nextSegment.set(key, last + 1);
  const pending = [...(input.pending ?? [])];
  const open = [...(input.open ?? [])];
  const clean = pending.length === 0 && !open.includes('connection_lost');
  const client = await ready(admin).connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ${DATASETS_SCHEMA}.datasets (dataset_id, state, source, manifest_core_jcs)
       VALUES ($1, 'published', $2, $3)`,
      [datasetId, SOURCE, text],
    );
    await client.query(
      `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
         (publication_id, deployment_environment, dataset_id, schema_version,
          manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
          published_at_utc, state)
       VALUES ($1, $2, $3, '1.0.0', $4, 's3://buoh-captura/datasets/manifests/x.json', $4, $5,
               'active')`,
      [publicationId, input.environment ?? 'test', datasetId, sha256(text), input.published],
    );
    for (const [index, [type, severity]] of incidents.entries()) {
      await client.query(
        `INSERT INTO ${DATASETS_SCHEMA}.dataset_quality_incidents
           (dataset_id, incident_id, incident_type, severity, symbol, observed_at_utc, incident_jcs)
         VALUES ($1, $2, $3, $4, 'R_100', '2026-11-01T01:00:00.000Z', '{}')`,
        [datasetId, `sha256:${sha256(`${id}-${String(index)}`)}`, type, severity],
      );
    }
    await client.query(
      `INSERT INTO ${DATASETS_SCHEMA}.dataset_log_ranges
         (dataset_id, publication_id, sequence, log_number, first_segment, last_segment, clean,
          pending_continuity_symbols, open_condition_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [datasetId, publicationId, sequenceName, input.log, first, last, clean, pending, open],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const verified: { mode: string; at: string }[] = [];
  for (const [index, [mode, status, code]] of (input.verifications ?? []).entries()) {
    const at = new Date(Date.parse(input.published) + (index + 1) * 10_000).toISOString();
    await ready(admin).query(
      `INSERT INTO ${DATASETS_SCHEMA}.dataset_verifications
         (verification_id, dataset_id, publication_id, mode, status, exit_code, error_code,
          report_jcs, run_id, verified_at_utc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        nextUuid(),
        datasetId,
        publicationId,
        mode,
        status,
        status === 'passed' ? 0 : 1,
        code,
        status === 'passed' ? '{}' : null,
        nextUuid(),
        at,
      ],
    );
    verified.push({ mode, at });
  }
  return { datasetId, first, last, publicationId, verified };
}

async function waitForNoSessions(server: Pool, database: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await server.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM pg_stat_activity
        WHERE datname = $1 AND backend_type = 'client backend'`,
      [database],
    );
    if (rows[0]?.sessions === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`La base ${database} sigue con sesiones.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function dropAll(server: Pool): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await server.query(`DROP ROLE IF EXISTS ${READER_USER}`);
  await server.query(`DROP ROLE IF EXISTS ${UNPRIVILEGED_USER}`);
}

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await dropAll(platform);
  await platform.query(
    `CREATE ROLE ${READER_USER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`,
  );
  await platform.query(
    `CREATE ROLE ${UNPRIVILEGED_USER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  admin = new pg.Pool({ ...local, database: DATABASE, ssl: false, max: 2 });
  reader = createReaderPool(readerConfig());
});

afterAll(async () => {
  await reader?.end();
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropAll(platform);
    await platform.end();
  }
});

describe('GET /api/v2/datos/datasets contra PostgreSQL (ADR-0020 §10; ADR-0021 §5)', () => {
  it('sin el esquema buoh_datasets, como antes de la primera publicación, ningún dataset', async () => {
    await resetDatasets({ migrated: false });
    expect(await getDatasets()).toMatchObject({
      body: { sequences: [] },
      status: 200,
    });
    await resetDatasets();
    expect(await getDatasets()).toMatchObject({
      body: { sequences: [] },
      status: 200,
    });
  });

  it('los datasets de este entorno, del más nuevo al más viejo, con su período, sus conteos, cómo terminaron, sus incidencias por tipo y la última verificación de cada modo', async () => {
    const first = await publishDataset({
      incidents: [
        ['duplicate_exact', 'info'],
        ['connection_lost', 'warning'],
        ['duplicate_exact', 'info'],
      ],
      log: 1,
      published: '2026-11-14T12:21:23.290Z',
      verifications: [
        ['verify-only', 'failed', 'STORAGE_OBJECT_MISMATCH'],
        ['verify-only', 'passed', null],
        ['recompute', 'passed', null],
      ],
    });
    const second = await publishDataset({
      log: 1,
      open: ['connection_lost'],
      pending: ['R_100'],
      period: null,
      published: '2026-11-14T12:26:14.668Z',
      segments: 71,
    });
    // De otro entorno: no cuenta.
    await publishDataset({
      environment: 'production',
      log: 2,
      published: '2026-11-14T12:31:10.317Z',
    });
    // Una publicación sustituida del primero: el dataset sale una vez, por la activa.
    const superseded = nextUuid();
    const core = await ready(admin).query<{ manifest_core_jcs: string }>(
      `SELECT manifest_core_jcs FROM ${DATASETS_SCHEMA}.datasets WHERE dataset_id = $1`,
      [first.datasetId],
    );
    await ready(admin).query(
      `INSERT INTO ${DATASETS_SCHEMA}.published_manifest_records
         (publication_id, deployment_environment, dataset_id, schema_version,
          manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
          published_at_utc, state)
       VALUES ($1, 'test', $2, '1.0.0', $3, 's3://buoh-captura/datasets/manifests/y.json', $3,
               '2026-11-14T12:40:00.000Z', 'superseded')`,
      [superseded, first.datasetId, sha256(core.rows[0]?.manifest_core_jcs ?? '')],
    );
    // Una verificación de la publicación sustituida, más nueva: no cuenta.
    await ready(admin).query(
      `INSERT INTO ${DATASETS_SCHEMA}.dataset_verifications
         (verification_id, dataset_id, publication_id, mode, status, exit_code, error_code,
          report_jcs, run_id, verified_at_utc)
       VALUES ($1, $2, $3, 'recompute', 'failed', 1, 'RECOMPUTED_MISMATCH', NULL, $4,
               '2026-11-14T12:50:00.000Z')`,
      [nextUuid(), first.datasetId, superseded, nextUuid()],
    );

    const response = await getDatasets();
    expect(response.status).toBe(200);
    const body = dataDatasetsSchema.parse(response.body);
    expect(body.sequences.map((group) => group.sequence)).toEqual(['R_100']);
    const live = body.sequences[0];
    expect(live?.truncated).toBe(false);
    expect(live?.datasets.map((dataset) => dataset.dataset_id)).toEqual([
      second.datasetId,
      first.datasetId,
    ]);
    expect(live?.datasets[1]).toEqual({
      dataset_id: first.datasetId,
      publication_id: first.publicationId,
      published_at_utc: '2026-11-14T12:21:23.290Z',
      source: SOURCE,
      symbols: ['R_100'],
      log: 1,
      first_segment: 0,
      last_segment: 71,
      event_time_from_utc: '2026-11-01T00:00:00.000Z',
      event_time_to_utc: '2026-11-01T05:59:58.000Z',
      source_event_count: 5004,
      raw_frame_count: 5002,
      normalized_tick_count: 5000,
      incident_count: 3,
      condition_event_count: 0,
      quality_rule_version: '3.0.0',
      quality_profile_id: 'deriv_options-publication-v1-R_100',
      clean: true,
      pending_continuity_symbols: [],
      open_condition_types: [],
      incidents: [
        { incident_type: 'connection_lost', severity: 'warning', count: 1 },
        { incident_type: 'duplicate_exact', severity: 'info', count: 2 },
      ],
      // La última de cada modo: la de verify-only que pasó, no la que falló antes.
      verifications: {
        verify_only: {
          status: 'passed',
          verified_at_utc: first.verified[1]?.at,
          error_code: null,
        },
        recompute: {
          status: 'passed',
          verified_at_utc: first.verified[2]?.at,
          error_code: null,
        },
      },
      batch: null,
    });
    expect(live?.datasets[0]).toMatchObject({
      first_segment: 72,
      last_segment: 142,
      event_time_from_utc: null,
      event_time_to_utc: null,
      normalized_tick_count: 0,
      clean: false,
      pending_continuity_symbols: ['R_100'],
      open_condition_types: ['connection_lost'],
      incidents: [],
      verifications: { verify_only: null, recompute: null },
    });
    await resetDatasets();
  });

  it(`con ${String(DATA_DATASETS_LIMIT)} datasets en una secuencia, su lista entera; con más, los más recientes y cortada, sin tapar los de otra secuencia (ADR-0021 §5)`, async () => {
    const published = (index: number) =>
      new Date(Date.parse('2026-11-20T00:00:00.000Z') + index * 1000).toISOString();
    const quotes = { candles: 0, offers: 0, quotes: 763, sessions: 0 };
    // Uno de R_100, más viejo que todos los de las cotizaciones.
    const live = await publishDataset({ log: 3, published: published(-1), segments: 72 });
    for (let index = 0; index < DATA_DATASETS_LIMIT; index += 1) {
      await publishDataset({
        batch: quotes,
        log: 1,
        published: published(index),
        segments: 1,
        sequence: 'lotes_cotizaciones',
      });
    }
    const exact = dataDatasetsSchema.parse((await getDatasets()).body);
    expect(exact.sequences.map((group) => [group.sequence, group.datasets.length])).toEqual([
      ['R_100', 1],
      ['lotes_cotizaciones', DATA_DATASETS_LIMIT],
    ]);
    expect(exact.sequences.map((group) => group.truncated)).toEqual([false, false]);
    // Dos más que el límite: se ven los más nuevos, del último al tercero, y el de R_100 sigue.
    for (const index of [DATA_DATASETS_LIMIT, DATA_DATASETS_LIMIT + 1]) {
      await publishDataset({
        batch: quotes,
        log: 1,
        published: published(index),
        segments: 1,
        sequence: 'lotes_cotizaciones',
      });
    }
    const cut = dataDatasetsSchema.parse((await getDatasets()).body);
    const [r100, batch] = cut.sequences;
    expect(r100?.datasets.map((dataset) => dataset.dataset_id)).toEqual([live.datasetId]);
    expect(r100?.truncated).toBe(false);
    expect(batch?.sequence).toBe('lotes_cotizaciones');
    expect(batch?.truncated).toBe(true);
    expect(batch?.datasets).toHaveLength(DATA_DATASETS_LIMIT);
    expect(batch?.datasets[0]?.published_at_utc).toBe(published(DATA_DATASETS_LIMIT + 1));
    expect(batch?.datasets.at(-1)?.published_at_utc).toBe(published(2));
    await resetDatasets();
  });

  it('un dataset de los lotes, con su core 1.1.0, sus velas, horarios, ofertas y cotizaciones y las incidencias de los lotes (candle_missing, candle_repeated y contract_rejected)', async () => {
    const candles = await publishDataset({
      batch: { candles: 2879, offers: 0, quotes: 0, sessions: 7 },
      incidents: [
        ['candle_missing', 'error'],
        ['candle_repeated', 'warning'],
        ['candle_repeated', 'error'],
      ],
      log: 1,
      published: '2026-11-27T00:05:00.000Z',
      segments: 5,
      sequence: 'lotes_velas',
    });
    const schedules = await publishDataset({
      batch: { candles: 0, offers: 8, quotes: 0, sessions: 16 },
      log: 1,
      published: '2026-11-27T00:10:00.000Z',
      segments: 3,
      sequence: 'lotes_horarios',
    });
    const quotes = await publishDataset({
      batch: { candles: 0, offers: 0, quotes: 760, sessions: 0 },
      incidents: [['contract_rejected', 'warning']],
      log: 1,
      published: '2026-11-27T03:05:00.000Z',
      segments: 36,
      sequence: 'lotes_cotizaciones',
      verifications: [
        ['verify-only', 'passed', null],
        ['recompute', 'passed', null],
      ],
    });
    const response = await getDatasets();
    expect(response.status).toBe(200);
    const body = dataDatasetsSchema.parse(response.body);
    expect(body.sequences.map((group) => group.sequence)).toEqual([
      'lotes_cotizaciones',
      'lotes_horarios',
      'lotes_velas',
    ]);
    const [quotesGroup, schedulesGroup, candlesGroup] = body.sequences;
    expect(candlesGroup?.datasets).toEqual([
      expect.objectContaining({
        dataset_id: candles.datasetId,
        log: 1,
        first_segment: 0,
        last_segment: 4,
        event_time_from_utc: null,
        event_time_to_utc: null,
        normalized_tick_count: 0,
        incident_count: 3,
        quality_rule_version: '4.0.0',
        clean: true,
        incidents: [
          { incident_type: 'candle_missing', severity: 'error', count: 1 },
          { incident_type: 'candle_repeated', severity: 'error', count: 1 },
          { incident_type: 'candle_repeated', severity: 'warning', count: 1 },
        ],
        batch: {
          candle_time_from_utc: '2026-11-26T00:00:00.000Z',
          candle_time_to_utc: '2026-11-26T23:59:00.000Z',
          market_candle_count: 2879,
          trading_session_count: 7,
          contract_offer_count: 0,
          contract_quote_count: 0,
        },
      }),
    ]);
    expect(schedulesGroup?.datasets[0]).toMatchObject({
      dataset_id: schedules.datasetId,
      batch: {
        candle_time_from_utc: null,
        candle_time_to_utc: null,
        market_candle_count: 0,
        trading_session_count: 16,
        contract_offer_count: 8,
        contract_quote_count: 0,
      },
    });
    expect(quotesGroup?.datasets[0]).toMatchObject({
      dataset_id: quotes.datasetId,
      incidents: [{ incident_type: 'contract_rejected', severity: 'warning', count: 1 }],
      batch: { contract_quote_count: 760, market_candle_count: 0 },
      verifications: { verify_only: { status: 'passed' }, recompute: { status: 'passed' } },
    });
    await resetDatasets();
  });

  it('una secuencia que no tiene el formato de su nombre es internal con DatasetIntegrityError', async () => {
    await resetDatasets();
    // La columna lo comprueba: se quita su restricción, como un error de programación.
    await ready(admin).query(
      `ALTER TABLE ${DATASETS_SCHEMA}.dataset_log_ranges DROP CONSTRAINT IF EXISTS dataset_log_ranges_sequence_check`,
    );
    await publishDataset({
      log: 1,
      published: '2026-11-14T12:00:00.000Z',
      sequence: 'lotes-velas',
    });
    const response = await getDatasets();
    expect(response.status).toBe(500);
    expect(response.lines).toContainEqual({
      event: 'api_error',
      request_id: '00000000-0000-4000-8000-000000000000',
      error: 'DatasetIntegrityError',
    });
    await resetDatasets();
  });

  it('un manifest_core que no está en JCS es internal, con DatasetIntegrityError y sin su contenido', async () => {
    await publishDataset({
      coreText: (core) => JSON.stringify(core, null, 1),
      log: 4,
      published: '2026-11-14T12:00:00.000Z',
    });
    const response = await getDatasets();
    expect(response.status).toBe(500);
    expect(response.lines).toContainEqual({
      event: 'api_error',
      request_id: '00000000-0000-4000-8000-000000000000',
      error: 'DatasetIntegrityError',
    });
    expect(JSON.stringify(response)).not.toContain('deriv_options-publication-v1');
    await resetDatasets();
  });

  it('un dataset activo sin su fila de rango, con incidencias que no suman las de su núcleo o con listas sin orden o repetidas es internal con DatasetIntegrityError: no se calla', async () => {
    const expectIntegrity = async () => {
      const response = await getDatasets();
      expect(response.status).toBe(500);
      expect(response.lines).toContainEqual({
        event: 'api_error',
        request_id: '00000000-0000-4000-8000-000000000000',
        error: 'DatasetIntegrityError',
      });
    };
    // Quita las filas de un dataset de una tabla append-only, como un error de programación
    // (ADR-0020 §9).
    const remove = async (table: string, datasetId: string) => {
      await ready(admin).query(`ALTER TABLE ${DATASETS_SCHEMA}.${table} DISABLE TRIGGER USER`);
      await ready(admin).query(`DELETE FROM ${DATASETS_SCHEMA}.${table} WHERE dataset_id = $1`, [
        datasetId,
      ]);
      await ready(admin).query(`ALTER TABLE ${DATASETS_SCHEMA}.${table} ENABLE TRIGGER USER`);
    };
    const published = '2026-11-14T12:00:00.000Z';
    // Sin rango: no se omite.
    await remove('dataset_log_ranges', (await publishDataset({ log: 5, published })).datasetId);
    await expectIntegrity();
    await resetDatasets();
    // Una incidencia de más: su núcleo dice que no tiene ninguna.
    const extra = await publishDataset({ log: 5, published });
    await ready(admin).query(
      `INSERT INTO ${DATASETS_SCHEMA}.dataset_quality_incidents
         (dataset_id, incident_id, incident_type, severity, symbol, observed_at_utc, incident_jcs)
       VALUES ($1, $2, 'connection_lost', 'warning', 'R_100', '2026-11-01T01:00:00.000Z', '{}')`,
      [extra.datasetId, `sha256:${sha256('de más')}`],
    );
    await expectIntegrity();
    await resetDatasets();
    // Una de menos: su núcleo cuenta una.
    const missing = await publishDataset({
      incidents: [['connection_lost', 'warning']],
      log: 5,
      published,
    });
    await remove('dataset_quality_incidents', missing.datasetId);
    await expectIntegrity();
    await resetDatasets();
    // Los tipos de condición abiertos sin orden o desconocidos, y los símbolos pendientes repetidos o
    // vacíos: la base no los comprueba.
    for (const lists of [
      { open: ['event_gap_unresolved', 'connection_lost'] },
      { open: ['desconocida'] },
      { pending: ['R_100', 'R_100'] },
      { pending: [''] },
    ]) {
      await publishDataset({ ...lists, log: 5, published });
      await expectIntegrity();
      await resetDatasets();
    }
  });

  it('con el esquema y sin una de sus tablas, o con un rol sin privilegios, internal: no se calla', async () => {
    await ready(admin).query(`DROP TABLE ${DATASETS_SCHEMA}.dataset_verifications`);
    expect((await getDatasets()).status).toBe(500);
    await resetDatasets();
    const unprivileged = createReaderPool(readerConfig(UNPRIVILEGED_USER));
    unprivileged.on('error', () => undefined);
    try {
      expect((await getDatasets(unprivileged)).status).toBe(500);
    } finally {
      await unprivileged.end();
    }
  });
});
