import { createHash, randomBytes } from 'node:crypto';

import {
  dataCatalogSchema,
  dataChartSchema,
  deriveCatalogContentSha256,
  deriveCatalogSnapshotId,
  sourceCatalogSnapshotSchema,
  type SourceEvent,
} from '@buoh/contracts';
import {
  buildRawSourceFrame,
  createPool as createWorkerPool,
  derivLogProfileRow,
  loadConfig,
  logLocation,
  migrate,
} from '@buoh/market-data-worker';
import {
  contentKey,
  createDerivMeasurementProfileFromSourceSchema,
  createS3Client,
  DERIV_CONNECTOR_VERSION,
  DERIV_SCHEMA_RELEASE,
  DERIV_SOURCE,
  PostgresCatalogStore,
  PostgresSourceLogStore,
  S3ObjectStore,
  SOURCE_SCHEMA_ENTRY,
  SourceEventLog,
  type ExpectedSchemaArchive,
} from '@buoh/market-data-worker/lectura';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { createRateLimiter } from '../src/accounts/limits.js';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { createMarketDataReader } from '../src/data/market.js';
import { createDataReader } from '../src/data/reader.js';
import type { ApiLogLine } from '../src/log.js';
import { loadPostgresConfig, type PostgresConfig } from '../src/postgres/config.js';
import { createReaderPool } from '../src/postgres/pool.js';
import { apiRoutes } from '../src/routes.js';

/**
 * Las lecturas de R2 (ADR-0019 §8) contra el PostgreSQL y el S3-compatible locales, sin TLS:
 * `GET /api/v1/datos/grafico` y `GET /api/v1/datos/catalogo` con el pool de lectura de la API y el
 * código del worker por la ruta `lectura`. El superusuario hace de `ingest` y de `buoh-operaciones`:
 * crea el log con las migraciones del worker, le da a un rol de prueba lo que tiene `buoh_lectura`
 * y escribe una captura sintética de R_100, con la forma de los mensajes de Deriv y precios
 * inventados, bajo el prefijo del log en el bucket de las pruebas. El esquema de fuente es uno
 * sintético, porque los de Deriv no están en el repositorio (ADR-0012 §2). Las sesiones son falsas.
 */
const DATABASE = 'buoh_integration_api_mercado';
const READER_USER = 'buoh_integration_api_mercado_lectura';
const readerPassword = randomBytes(24).toString('hex');
const ORIGIN = 'https://buoh.test';
const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: '01900000-0000-7000-8000-00000000a001',
  lastActivityMs: 0,
};
/** La hora de la prueba: el final de la captura. */
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const A = '019b76da-a800-7000-8000-00000000a000';
const B = '019b76da-a800-7000-8000-00000000b000';

/** El esquema sintético de la respuesta `tick`, con lo que lee el normalizador. */
const TICKS_SCHEMA = new TextEncoder().encode(
  JSON.stringify({
    $schema: 'http://json-schema.org/draft-04/schema#',
    properties: {
      echo_req: { type: 'object' },
      msg_type: { enum: ['tick'], type: 'string' },
      req_id: { type: 'integer' },
      subscription: { properties: { id: { type: 'string' } }, type: 'object' },
      tick: {
        additionalProperties: false,
        properties: {
          epoch: { type: 'integer' },
          id: { type: 'string' },
          pip_size: { type: 'number' },
          quote: { type: 'number' },
          symbol: { type: 'string' },
        },
        required: ['pip_size'],
        type: 'object',
      },
    },
    required: ['echo_req', 'msg_type'],
    type: 'object',
  }),
);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** La release fijada, con el esquema sintético en lugar del de Deriv. */
const RELEASE: ExpectedSchemaArchive = {
  ...DERIV_SCHEMA_RELEASE,
  entries_sha256: {
    ...DERIV_SCHEMA_RELEASE.entries_sha256,
    [SOURCE_SCHEMA_ENTRY]: sha256(TICKS_SCHEMA),
  },
  release: 'synthetic-deriv-1',
};
const profile = createDerivMeasurementProfileFromSourceSchema({
  source_schema_bytes: TICKS_SCHEMA,
  source_schema_release: RELEASE.release,
  symbol: 'R_100',
});

let local: PostgresConfig;
let platform: Pool | undefined;
let admin: Pool | undefined;
let reader: Pool | undefined;
const worker = loadConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' });
const s3 = createS3Client(worker.s3);
const badS3 = createS3Client({ ...worker.s3, secretAccessKey: randomBytes(24).toString('hex') });

function ready<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError('beforeAll no terminó.');
  }
  return value;
}

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

/** Una API con el lector de R2 sobre `client`, para pedirle varias rutas con la misma caché. */
function apiWith(client = s3) {
  const lines: ApiLogLine[] = [];
  let n = 0;
  const pool = ready(reader);
  const app = buildApp({
    log: (line) => lines.push(line),
    now: () => 0,
    requestId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
    origin: ORIGIN,
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
      market: createMarketDataReader({
        pool,
        objects: (log) => new S3ObjectStore(client, worker.s3.bucket, log.prefix),
        clock: () => NOW,
        schemaRelease: RELEASE,
      }),
    }),
    rateLimit: () => 0,
  });
  const get = async (url: string) => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SID}` },
    });
    return { body: response.json<unknown>(), status: response.statusCode };
  };
  return { app, get, lines };
}

/** Crea el log `number` con las migraciones del worker y le da al rol de prueba lo de `buoh_lectura`. */
async function createLog(number: number): Promise<string> {
  const { schema } = logLocation(number);
  await ready(admin).query(`CREATE SCHEMA ${schema}`);
  const pool = createWorkerPool({ ...local, database: DATABASE, schema, sslMode: 'disable' });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  await ready(admin).query(`GRANT USAGE ON SCHEMA ${schema} TO ${READER_USER}`);
  await ready(admin).query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${READER_USER}`);
  return schema;
}

const iso = (ms: number) => new Date(ms).toISOString();
let sequence = 0;
const id = () => {
  sequence += 1;
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
};

function tickFrame(connection: string, epochMs: number): SourceEvent {
  const quote = (1000 + ((epochMs / 2000) % 50) / 4).toFixed(2);
  return buildRawSourceFrame(
    {
      connection_id: connection,
      observation_id: id(),
      payload_utf8: `{"echo_req":{"req_id":2,"subscribe":1,"ticks":"R_100"},"msg_type":"tick","req_id":2,"subscription":{"id":"sub-1"},"tick":{"epoch":${String(epochMs / 1000)},"id":"sub-1","pip_size":2,"quote":${quote},"symbol":"R_100"}}`,
      received_at_utc: iso(epochMs + 300),
    },
    profile,
  );
}

/**
 * Una captura de 40 minutos en el log: ticks cada 2 s de 11:20 a 11:49:58, una parada pedida, y
 * otra conexión de 11:51 a 11:59:58. Un segmento cerrado cada 300 eventos y en la parada.
 */
async function writeCapture(schema: string, log: number): Promise<void> {
  const location = logLocation(log);
  const objects = new S3ObjectStore(s3, worker.s3.bucket, location.prefix);
  await objects.putIfAbsent(contentKey(sha256(TICKS_SCHEMA)), TICKS_SCHEMA, 'application/json');
  const pool = createWorkerPool({ ...local, database: DATABASE, schema, sslMode: 'disable' });
  try {
    const writer = await SourceEventLog.open({
      objects,
      source: DERIV_SOURCE,
      store: new PostgresSourceLogStore(pool),
      zlibVersion: process.versions.zlib,
    });
    const start = Date.parse('2026-11-08T11:20:00.000Z');
    const events: SourceEvent[] = [
      {
        connection_id: A,
        event_id: id(),
        kind: 'connection_opened',
        occurred_at_utc: iso(start - 1000),
        schema_version: '1.0.0',
        source: DERIV_SOURCE,
        supersedes_connection_id: null,
      },
    ];
    for (let at = start; at < start + 30 * 60_000; at += 2000) {
      events.push(tickFrame(A, at));
    }
    events.push({
      affected_symbols: ['R_100'],
      closure_type: 'requested',
      connection_id: A,
      event_id: id(),
      kind: 'connection_closed',
      occurred_at_utc: iso(start + 30 * 60_000 - 1000),
      reason: 'requested',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    });
    events.push({
      connection_id: B,
      event_id: id(),
      kind: 'connection_opened',
      occurred_at_utc: iso(start + 31 * 60_000 - 1000),
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: A,
    });
    for (let at = start + 31 * 60_000; at < NOW; at += 2000) {
      events.push(tickFrame(B, at));
    }
    let inSegment = 0;
    for (const event of events) {
      await writer.append(event);
      inSegment += 1;
      const requested = event.kind === 'connection_closed';
      if (inSegment === 300 || requested) {
        await writer.close(requested ? 'requested' : 'window');
        inSegment = 0;
      }
    }

    const entries = [
      {
        exchange_is_open: 1 as const,
        is_trading_suspended: 0 as const,
        market: 'synthetic_index',
        pip_size: '0.01',
        subgroup: 'synthetics',
        submarket: 'random_index',
        underlying_symbol: 'R_100',
        underlying_symbol_name: 'Volatility 100 Index',
        underlying_symbol_type: 'stockindex',
      },
    ];
    const body = {
      catalog_format: 'deriv_active_symbols' as const,
      catalog_normalizer_version: '1.0.0' as const,
      connector_version: DERIV_CONNECTOR_VERSION,
      content_sha256: deriveCatalogContentSha256(entries),
      entries,
      entry_count: 1,
      observation_id: id(),
      raw_payload_sha256: 'c'.repeat(64),
      received_at_utc: iso(start - 500),
      schema_version: '1.0.0' as const,
      source: DERIV_SOURCE,
      source_schema_release: RELEASE.release,
      source_schema_sha256: sha256(TICKS_SCHEMA),
    };
    const snapshot = sourceCatalogSnapshotSchema.parse({
      ...body,
      snapshot_id: deriveCatalogSnapshotId(body),
    });
    await new PostgresCatalogStore(pool, objects).record(snapshot);
  } finally {
    await pool.end();
  }
}

/** Un minuto de ticks en el log `log`, sin guardar antes el esquema de fuente, como otra release. */
async function writeTicksWithoutSchema(schema: string, log: number): Promise<void> {
  const objects = new S3ObjectStore(s3, worker.s3.bucket, logLocation(log).prefix);
  const pool = createWorkerPool({ ...local, database: DATABASE, schema, sslMode: 'disable' });
  try {
    const writer = await SourceEventLog.open({
      objects,
      source: DERIV_SOURCE,
      store: new PostgresSourceLogStore(pool),
      zlibVersion: process.versions.zlib,
    });
    const start = NOW - 60_000;
    await writer.append({
      connection_id: A,
      event_id: id(),
      kind: 'connection_opened',
      occurred_at_utc: iso(start - 1000),
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    });
    for (let at = start; at < NOW; at += 2000) {
      await writer.append(tickFrame(A, at));
    }
  } finally {
    await pool.end();
  }
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
}

beforeAll(async () => {
  local = loadPostgresConfig({ ...process.env, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' }).postgres;
  platform = new pg.Pool({ ...local, ssl: false, max: 1 });
  await dropAll(platform);
  await platform.query(
    `CREATE ROLE ${READER_USER} LOGIN PASSWORD ${pg.escapeLiteral(readerPassword)}`,
  );
  await platform.query(`CREATE DATABASE ${DATABASE}`);
  admin = new pg.Pool({ ...local, database: DATABASE, ssl: false, max: 2 });
  reader = createReaderPool({
    ...local,
    database: DATABASE,
    password: readerPassword,
    sslMode: 'disable',
    user: READER_USER,
  });
});

afterAll(async () => {
  s3.destroy();
  badS3.destroy();
  await reader?.end();
  await admin?.end();
  if (platform !== undefined) {
    await waitForNoSessions(platform, DATABASE);
    await dropAll(platform);
    await platform.end();
  }
});

describe('GET /api/v1/datos/grafico y /api/v1/datos/catalogo contra PostgreSQL y S3 (ADR-0019 §8)', () => {
  it('sin ningún log, ni gráfico ni catálogo', async () => {
    const { get } = apiWith();
    expect(await get('/api/v1/datos/grafico?hours=6')).toEqual({
      body: {
        log: null,
        source: DERIV_SOURCE,
        symbol: 'R_100',
        from_utc: '2026-11-08T06:00:00.000Z',
        to_utc: '2026-11-08T12:00:00.000Z',
        log_started_at_utc: null,
        ticks: { offsets_ms: [], quotes: [] },
        gaps: [],
      },
      status: 200,
    });
    expect(await get('/api/v1/datos/catalogo')).toEqual({
      body: { log: null, catalog: null },
      status: 200,
    });
  });

  it('con el log preparado y vacío, el log activo sin datos', async () => {
    await createLog(1);
    const { get } = apiWith();
    expect(await get('/api/v1/datos/grafico?hours=1')).toMatchObject({
      body: { log: 1, log_started_at_utc: null, ticks: { offsets_ms: [] }, gaps: [] },
      status: 200,
    });
    expect(await get('/api/v1/datos/catalogo')).toEqual({
      body: { log: 1, catalog: null },
      status: 200,
    });
  });

  it('con la captura, sus ticks y la parada pedida, y el catálogo con su versión; la segunda vez, igual', async () => {
    await writeCapture(logLocation(1).schema, 1);
    const { get, lines } = apiWith();
    const first = await get('/api/v1/datos/grafico?hours=1');
    expect(first.status).toBe(200);
    const chart = dataChartSchema.parse(first.body);
    expect(chart).toMatchObject({
      log: 1,
      from_utc: '2026-11-08T11:00:00.000Z',
      to_utc: '2026-11-08T12:00:00.000Z',
      log_started_at_utc: '2026-11-08T11:19:59.000Z',
    });
    // 900 ticks de 11:20 a 11:49:58 y 270 de 11:51 a 11:59:58.
    expect(chart.ticks.offsets_ms).toHaveLength(1170);
    expect(chart.ticks.offsets_ms[0]).toBe(20 * 60_000);
    expect(chart.ticks.offsets_ms.at(-1)).toBe(60 * 60_000 - 2000);
    expect(chart.ticks.quotes[0]).toMatch(/^\d+\.\d{2}$/u);
    expect(chart.gaps).toEqual([
      {
        from_utc: '2026-11-08T11:49:58.001Z',
        to_utc: '2026-11-08T11:50:59.999Z',
        cause: 'capture_stopped',
        history: 'not_requested',
        reason: null,
        recovered_ticks: null,
      },
    ]);
    expect(await get('/api/v1/datos/grafico?hours=1')).toEqual(first);
    const longer = dataChartSchema.parse((await get('/api/v1/datos/grafico?hours=24')).body);
    expect(longer.ticks.quotes).toEqual(chart.ticks.quotes);
    expect(longer.gaps).toEqual(chart.gaps);

    const catalog = await get('/api/v1/datos/catalogo');
    expect(catalog.status).toBe(200);
    expect(dataCatalogSchema.parse(catalog.body)).toMatchObject({
      log: 1,
      catalog: {
        source: DERIV_SOURCE,
        version: 1,
        received_at_utc: '2026-11-08T11:19:59.500Z',
        source_schema_release: 'synthetic-deriv-1',
        entries: [{ underlying_symbol: 'R_100', pip_size: '0.01' }],
      },
    });
    expect(lines.filter((line) => line.event === 'api_error')).toEqual([]);
  });

  it('con un token que R2 rechaza, storage_unavailable con el motivo saneado y sin la clave', async () => {
    const { get, lines } = apiWith(badS3);
    for (const url of ['/api/v1/datos/grafico?hours=1', '/api/v1/datos/catalogo']) {
      const response = await get(url);
      expect(response, url).toMatchObject({
        body: { error: { code: 'storage_unavailable' } },
        status: 503,
      });
    }
    const errors = lines.flatMap((line) => (line.event === 'api_error' ? [line.error] : []));
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toMatch(/^[A-Za-z0-9_.-]{1,64}$/u);
    }
    expect(JSON.stringify(lines)).not.toContain(worker.s3.secretAccessKey);
  });

  it('el rol de lectura no escribe en el log: la sesión del pool rechaza una escritura', async () => {
    const schema = logLocation(1).schema;
    const code = await ready(reader)
      .query(`DELETE FROM ${schema}.closed_source_segments`)
      .then(
        () => null,
        (error: unknown) => String((error as { code?: unknown }).code),
      );
    expect(code).toBe('25006');
  });

  it('un log nuevo sin el esquema de fuente guardado es internal, aunque otro log ya armó el perfil', async () => {
    const { get, lines } = apiWith();
    expect((await get('/api/v1/datos/grafico?hours=1')).status).toBe(200);
    await writeTicksWithoutSchema(await createLog(2), 2);
    expect(await get('/api/v1/datos/grafico?hours=1')).toMatchObject({
      body: { error: { code: 'internal' } },
      status: 500,
    });
    expect(lines.flatMap((line) => (line.event === 'api_error' ? [line.error] : []))).toEqual([
      'SourceSchemaMissingError',
    ]);
  });

  it('el gráfico arma el perfil de cada log desde su fila de log_quality_profile; uno que el código no conoce es internal (ADR-0020 §4)', async () => {
    const { get, lines } = apiWith();
    const assign = async (
      schema: string,
      row: { profile_id: string; quality_profile_sha256: string },
    ) => {
      await ready(admin).query(
        `INSERT INTO ${schema}.log_quality_profile
           (profile_id, quality_profile_sha256, run_id, assigned_at_utc)
         VALUES ($1, $2, $3, $4)`,
        [row.profile_id, row.quality_profile_sha256, id(), iso(NOW)],
      );
    };
    // El log 3, con el perfil de publicación de R_100 y la captura de siempre.
    const three = await createLog(3);
    await assign(three, derivLogProfileRow('R_100'));
    await writeCapture(three, 3);
    const chart = await get('/api/v1/datos/grafico?hours=1');
    expect(chart.status).toBe(200);
    expect(dataChartSchema.parse(chart.body)).toMatchObject({ log: 3 });
    // El log 4, con un perfil que este código no arma.
    const four = await createLog(4);
    await assign(four, {
      ...derivLogProfileRow('R_100'),
      profile_id: 'deriv_options-publication-v9-R_100',
    });
    await writeCapture(four, 4);
    expect(await get('/api/v1/datos/grafico?hours=1')).toMatchObject({
      body: { error: { code: 'internal' } },
      status: 500,
    });
    expect(lines.flatMap((line) => (line.event === 'api_error' ? [line.error] : []))).toEqual([
      'LogProfileUnknownError',
    ]);
  });
});
