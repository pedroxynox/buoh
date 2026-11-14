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
 * `GET /api/v1/datos/datasets` con el pool de lectura de la API y el código del worker por la ruta
 * `lectura`. El superusuario hace de `buoh-operaciones` y de la publicación: crea `buoh_datasets` con
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

/** `GET /api/v1/datos/datasets` con sesión y el pool de lectura `pool`. */
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
      url: '/api/v1/datos/datasets',
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

/** El primer segmento del dataset siguiente de cada log. */
const nextSegment = new Map<number, number>();

interface DatasetInput {
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
}): JsonValue {
  const counts = {
    source_events: input.ticks + 4,
    normalized_ticks: input.ticks,
    quality_incidents: input.incidents,
    operational_conditions: 0,
  } as const;
  return {
    schema_version: '1.0.0',
    canonicalization_version: 'RFC8785',
    source: SOURCE,
    source_schema_release: 'synthetic-deriv-1',
    source_schema_sha256: sha256('esquema'),
    connector_version: 'deriv-options-ws-1.1.0',
    normalizer_version: '3.0.0',
    quality_rule_version: '3.0.0',
    quality_profile_id: 'deriv_options-publication-v1-R_100',
    quality_profile_sha256: sha256('perfil'),
    segment_policy_version: '1.0.0',
    source_event_schema_version: '1.0.0',
    market_tick_schema_version: '1.0.0',
    incident_schema_version: '2.0.0',
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
  const ticks = input.ticks ?? (input.period === null ? 0 : 5000);
  const incidents = input.incidents ?? [];
  const core = manifestCore({
    id,
    incidents: incidents.length,
    period:
      input.period === undefined
        ? ['2026-11-01T00:00:00.000Z', '2026-11-01T05:59:58.000Z']
        : input.period,
    ticks,
  });
  const text = input.coreText?.(core) ?? canonicalJson(core);
  const datasetId = `sha256:${sha256(text)}`;
  const publicationId = nextUuid();
  const first = nextSegment.get(input.log) ?? 0;
  const last = first + (input.segments ?? 72) - 1;
  nextSegment.set(input.log, last + 1);
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
         (dataset_id, publication_id, log_number, first_segment, last_segment, clean,
          pending_continuity_symbols, open_condition_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [datasetId, publicationId, input.log, first, last, clean, pending, open],
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

describe('GET /api/v1/datos/datasets contra PostgreSQL (ADR-0020 §10)', () => {
  it('sin el esquema buoh_datasets, como antes de la primera publicación, ningún dataset', async () => {
    await resetDatasets({ migrated: false });
    expect(await getDatasets()).toMatchObject({
      body: { datasets: [], truncated: false },
      status: 200,
    });
    await resetDatasets();
    expect(await getDatasets()).toMatchObject({
      body: { datasets: [], truncated: false },
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
      [nextUuid(), first.datasetId, sha256(core.rows[0]?.manifest_core_jcs ?? '')],
    );

    const response = await getDatasets();
    expect(response.status).toBe(200);
    const body = dataDatasetsSchema.parse(response.body);
    expect(body.truncated).toBe(false);
    expect(body.datasets.map((dataset) => dataset.dataset_id)).toEqual([
      second.datasetId,
      first.datasetId,
    ]);
    expect(body.datasets[1]).toEqual({
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
    });
    expect(body.datasets[0]).toMatchObject({
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

  it(`con ${String(DATA_DATASETS_LIMIT)} datasets, la lista entera; con más, los más recientes y cortada`, async () => {
    const published = (index: number) =>
      new Date(Date.parse('2026-11-20T00:00:00.000Z') + index * 1000).toISOString();
    for (let index = 0; index < DATA_DATASETS_LIMIT; index += 1) {
      await publishDataset({ log: 3, published: published(index), segments: 1 });
    }
    const exact = dataDatasetsSchema.parse((await getDatasets()).body);
    expect(exact.datasets).toHaveLength(DATA_DATASETS_LIMIT);
    expect(exact.truncated).toBe(false);
    // Dos más que el límite: se ven los más nuevos, del último al tercero.
    for (const index of [DATA_DATASETS_LIMIT, DATA_DATASETS_LIMIT + 1]) {
      await publishDataset({ log: 3, published: published(index), segments: 1 });
    }
    const cut = dataDatasetsSchema.parse((await getDatasets()).body);
    expect(cut.truncated).toBe(true);
    expect(cut.datasets).toHaveLength(DATA_DATASETS_LIMIT);
    expect(cut.datasets[0]?.published_at_utc).toBe(published(DATA_DATASETS_LIMIT + 1));
    expect(cut.datasets.at(-1)?.published_at_utc).toBe(published(2));
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
