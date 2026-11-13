import { createHash, randomBytes } from 'node:crypto';

import {
  canonicalJson,
  DATA_EVENTS_LIMIT,
  dataEventsSchema,
  deriveEventId,
  type DataQualityIncident,
  type JsonValue,
  type OperationalConditionEvent,
} from '@buoh/contracts';
import {
  createPool as createWorkerPool,
  logLocation,
  migrate,
  OperationalRegistry,
  PostgresOperationalStore,
  PostgresRequestedResponseIncidentStore,
} from '@buoh/market-data-worker';
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
 * Los eventos de datos (ADR-0019 §5 y §8) contra el PostgreSQL local, sin TLS:
 * `GET /api/v1/datos/eventos` con el pool de lectura de la API y el código del worker por la ruta
 * `lectura`. El superusuario hace de `buoh-operaciones` y de la captura: crea los logs con las
 * migraciones del worker, le da a un rol de prueba lo que tiene `buoh_lectura` y guarda los eventos,
 * las incidencias y las condiciones con los almacenes del worker, y el catálogo y las publicaciones
 * con sus filas. Las sesiones son falsas.
 *
 * Los roles son de todo el servidor: la prueba borra los suyos y su base al empezar y al terminar.
 * Las contraseñas son aleatorias y nunca se escriben.
 */
const DATABASE = 'buoh_integration_api_eventos';
const READER_USER = 'buoh_integration_api_eventos_lectura';
const UNPRIVILEGED_USER = 'buoh_integration_api_eventos_sin_privilegios';
const readerPassword = randomBytes(24).toString('hex');
const SOURCE = 'deriv_options';
const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: '01900000-0000-7000-8000-00000000a001',
  lastActivityMs: 0,
};
/** La hora de la prueba: el log 1, con su última escritura 33 días antes, venció. */
const NOW = Date.parse('2026-11-12T12:00:00.000Z');

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

/** `GET /api/v1/datos/eventos` con sesión, el pool de lectura `pool` y la hora `now`. */
async function getEvents(pool: Pool = ready(reader), now = NOW) {
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
      clock: () => now,
      data: createDataReader({ pool, clock: () => now, environment: 'test' }),
      market: null,
    }),
    rateLimit: () => 0,
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/datos/eventos',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SID}` },
    });
    return { body: response.json<unknown>(), lines, status: response.statusCode };
  } finally {
    await app.close();
  }
}

/** Un pool del worker con el log en el `search_path`, como `ingest`. */
function logPool(number: number): Pool {
  return createWorkerPool({
    ...local,
    database: DATABASE,
    schema: logLocation(number).schema,
    sslMode: 'disable',
  });
}

/**
 * Crea el log `number` con las migraciones del worker y, salvo con `readable: false`, le da al rol de
 * prueba lo de `buoh_lectura`. Sin eso, la API lo toma por un log que se está preparando.
 */
async function createLog(number: number, { readable = true } = {}): Promise<string> {
  const { schema } = logLocation(number);
  await ready(admin).query(`CREATE SCHEMA ${schema}`);
  const pool = logPool(number);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  if (readable) {
    await ready(admin).query(`GRANT USAGE ON SCHEMA ${schema} TO ${READER_USER}`);
    await ready(admin).query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${READER_USER}`);
  }
  return schema;
}

let sequence = 0;
function nextUuid(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** Un latido de la captura, que cuenta como una escritura del log (ADR-0018 §6). */
async function heartbeat(schema: string, observed: string): Promise<void> {
  const id = nextUuid();
  await ready(admin).query(
    `INSERT INTO ${schema}.ingestion_heartbeats
       (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
        backlog_count, backlog_bytes)
     VALUES ($1, $2, $1, $3, 1, 'connected', 0, 0)`,
    [id, SOURCE, observed],
  );
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** La versión `version` del catálogo, con un contenido distinto en cada una. */
async function catalogVersion(schema: string, version: number, received: string): Promise<void> {
  // El trigger de las versiones lee la tabla sin esquema, como la escribe `ingest`, con el log en
  // el `search_path` de la sesión.
  const client = await ready(admin).connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    await client.query(
      `INSERT INTO source_catalog_versions
         (source, catalog_format, version, snapshot_id, content_sha256, entry_count,
          observation_id, received_at_utc, document_sha256, document_byte_length)
       VALUES ($1, 'deriv_active_symbols', $2, $3, $4, 89, $5, $6, $7, 1024)`,
      [
        SOURCE,
        version,
        `sha256:${sha256(`snapshot-${schema}-${String(version)}`)}`,
        sha256(`content-${schema}-${String(version)}`),
        nextUuid(),
        received,
        sha256(`document-${schema}-${String(version)}`),
      ],
    );
  } finally {
    await client.query('RESET search_path').catch(() => undefined);
    client.release();
  }
}

/** Un dataset publicado en `environment`, con su `PublishedManifestRecord`. */
async function publication(
  schema: string,
  environment: string,
  published: string,
): Promise<{ readonly datasetId: string; readonly publicationId: string }> {
  const core = `{"publicacion":"${published}","entorno":"${environment}"}`;
  const datasetId = `sha256:${sha256(core)}`;
  const publicationId = nextUuid();
  await ready(admin).query(
    `INSERT INTO ${schema}.datasets (dataset_id, state, source, manifest_core_jcs)
     VALUES ($1, 'published', $2, $3)`,
    [datasetId, SOURCE, core],
  );
  await ready(admin).query(
    `INSERT INTO ${schema}.published_manifest_records
       (publication_id, deployment_environment, dataset_id, schema_version,
        manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
        published_at_utc, state)
     VALUES ($1, $2, $3, '1.0.0', $4, 's3://buoh-local/manifests/x.json', $4, $5, 'active')`,
    [publicationId, environment, datasetId, sha256(core), published],
  );
  return { datasetId, publicationId };
}

/** Un documento con su identificador derivado, como los del dominio. */
function withId<K extends string>(key: K, body: Record<string, JsonValue>) {
  return { ...body, [key]: deriveEventId(body) } as Record<K, string> & Record<string, JsonValue>;
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

describe('GET /api/v1/datos/eventos contra PostgreSQL (ADR-0019 §5 y §8)', () => {
  it('sin ningún log, ningún evento', async () => {
    expect(await getEvents()).toMatchObject({
      body: { logs: [], events: [], truncated: false },
      status: 200,
    });
  });

  it('de los logs que no han vencido, sus eventos, del más nuevo al más viejo y solo los de este entorno', async () => {
    // El log 1 venció: su última escritura tiene más de 30 días.
    const log1 = await createLog(1);
    await heartbeat(log1, '2026-10-10T00:00:00.000Z');
    await catalogVersion(log1, 1, '2026-10-09T00:00:01.000Z');

    const log2 = await createLog(2);
    await heartbeat(log2, '2026-11-08T23:59:59.000Z');
    await catalogVersion(log2, 1, '2026-11-02T00:00:09.338Z');
    await catalogVersion(log2, 2, '2026-11-06T21:12:31.681Z');
    const published = await publication(log2, 'test', '2026-11-07T00:00:00.000Z');
    await publication(log2, 'production', '2026-11-07T00:00:01.000Z');

    const log3 = await createLog(3);
    await heartbeat(log3, '2026-11-12T11:59:00.000Z');
    // Una escritura en R2 que falló, con el registro operativo de `ingest`: la incidencia y la
    // condición que abre, en el mismo instante.
    const pool3 = logPool(3);
    let opened: OperationalConditionEvent;
    let failed: DataQualityIncident;
    try {
      const registry = await OperationalRegistry.open({
        alert: () => undefined,
        source: SOURCE,
        store: new PostgresOperationalStore(pool3),
      });
      const result = await registry.recordPersistenceUnavailable({
        observed_at_utc: '2026-11-09T14:00:00.124Z',
        observed_ref: nextUuid(),
        related_refs: [],
        reason: 'ServiceUnavailable',
        stage: 'raw_object_write',
      });
      if (result.status !== 'recorded' || result.incident === null) {
        throw new TypeError('El registro operativo no guardó la incidencia.');
      }
      const [first] = result.conditions;
      if (first === undefined) {
        throw new TypeError('El registro operativo no abrió la condición.');
      }
      failed = result.incident;
      opened = first;
      const openedBody: Record<string, JsonValue> = { ...opened };
      delete openedBody['condition_event_id'];
      const resolved = withId('condition_event_id', {
        ...openedBody,
        action: 'resolved',
        cause_refs: [nextUuid()],
        occurred_at_utc: '2026-11-09T14:00:20.511Z',
        resolution_reason: 'persistence_restored',
      }) as unknown as OperationalConditionEvent;
      const limit = withId('incident_id', {
        evidence: {
          maximum_value: 1_048_576,
          observed_value: 2_000_000,
          resource: 'websocket_frame',
          unit: 'bytes',
        },
        incident_type: 'source_limit_exceeded',
        observed_at_utc: '2026-11-10T08:00:00.000Z',
        observed_ref: nextUuid(),
        quality_rule_version: '2.0.0',
        related_refs: [],
        schema_version: '2.0.0',
        severity: 'error',
        source: SOURCE,
        symbol: null,
      }) as unknown as DataQualityIncident;
      await new PostgresOperationalStore(pool3).append({
        conditions: [resolved],
        incidents: [limit],
      });
      const requested = withId('incident_id', {
        evidence: { raw_payload_sha256: sha256('respuesta'), reason: 'catalog_empty' },
        incident_type: 'invalid_source_frame',
        observed_at_utc: '2026-11-11T00:00:00.500Z',
        observed_ref: nextUuid(),
        quality_rule_version: '2.0.0',
        related_refs: [],
        schema_version: '2.0.0',
        severity: 'error',
        source: SOURCE,
        symbol: null,
      }) as unknown as DataQualityIncident;
      await new PostgresRequestedResponseIncidentStore(pool3).append(requested);
    } finally {
      await pool3.end();
    }
    await catalogVersion(log3, 1, '2026-11-09T00:00:06.105Z');

    const response = await getEvents();
    expect(response.status).toBe(200);
    const body = dataEventsSchema.parse(response.body);
    expect(body.logs).toEqual([3, 2]);
    expect(body.truncated).toBe(false);
    expect(body.events.map((event) => [event.kind, event.log, event.at_utc])).toEqual([
      ['incident', 3, '2026-11-11T00:00:00.500Z'],
      ['incident', 3, '2026-11-10T08:00:00.000Z'],
      ['condition', 3, '2026-11-09T14:00:20.511Z'],
      // La condición va antes que la incidencia que la abrió, en el mismo instante.
      ['condition', 3, '2026-11-09T14:00:00.124Z'],
      ['incident', 3, '2026-11-09T14:00:00.124Z'],
      ['catalog_version', 3, '2026-11-09T00:00:06.105Z'],
      // Solo la publicación de este entorno, `test`.
      ['publication', 2, '2026-11-07T00:00:00.000Z'],
      ['catalog_version', 2, '2026-11-06T21:12:31.681Z'],
      ['catalog_version', 2, '2026-11-02T00:00:09.338Z'],
    ]);
    expect(body.events[0]).toMatchObject({
      incident_type: 'invalid_source_frame',
      evidence: { reason: 'catalog_empty', raw_payload_sha256: sha256('respuesta') },
      severity: 'error',
      symbol: null,
    });
    expect(body.events[1]).toMatchObject({
      incident_type: 'source_limit_exceeded',
      evidence: {
        resource: 'websocket_frame',
        unit: 'bytes',
        observed_value: 2_000_000,
        maximum_value: 1_048_576,
      },
    });
    expect(body.events[2]).toMatchObject({
      action: 'resolved',
      resolution_reason: 'persistence_restored',
      condition_key: opened.condition_key,
    });
    expect(body.events[3]).toEqual({
      kind: 'condition',
      log: 3,
      at_utc: opened.occurred_at_utc,
      source: SOURCE,
      condition_event_id: opened.condition_event_id,
      condition_key: opened.condition_key,
      condition_type: 'persistence_unavailable',
      symbol: null,
      action: 'opened',
      resolution_reason: null,
    });
    expect(body.events[4]).toEqual({
      kind: 'incident',
      log: 3,
      at_utc: failed.observed_at_utc,
      source: SOURCE,
      incident_id: failed.incident_id,
      incident_type: 'persistence_unavailable',
      severity: failed.severity,
      symbol: null,
      evidence: { stage: 'raw_object_write', reason: 'ServiceUnavailable' },
    });
    expect(body.events[6]).toEqual({
      kind: 'publication',
      log: 2,
      at_utc: '2026-11-07T00:00:00.000Z',
      source: SOURCE,
      dataset_id: published.datasetId,
      publication_id: published.publicationId,
      state: 'active',
    });
    expect(body.events[7]).toMatchObject({ version: 2, entry_count: 89 });
  });

  it(`con ${String(DATA_EVENTS_LIMIT)} eventos, la lista entera; con más, los más recientes y cortada`, async () => {
    // El 2026-12-20 solo el log 4 sigue sin vencer, así que solo cuentan sus versiones.
    const at = Date.parse('2026-12-20T00:00:00.000Z');
    const log4 = await createLog(4);
    await heartbeat(log4, '2026-12-19T00:00:00.000Z');
    const received = (version: number) =>
      new Date(Date.parse('2026-12-18T00:00:00.000Z') + version * 1000).toISOString();
    for (let version = 1; version <= DATA_EVENTS_LIMIT; version += 1) {
      await catalogVersion(log4, version, received(version));
    }
    const exact = dataEventsSchema.parse((await getEvents(ready(reader), at)).body);
    expect(exact.logs).toEqual([4]);
    expect(exact.events).toHaveLength(DATA_EVENTS_LIMIT);
    expect(exact.truncated).toBe(false);

    // Dos más que el límite: se ven las más nuevas, de la última a la tercera.
    for (const version of [DATA_EVENTS_LIMIT + 1, DATA_EVENTS_LIMIT + 2]) {
      await catalogVersion(log4, version, received(version));
    }
    const cut = dataEventsSchema.parse((await getEvents(ready(reader), at)).body);
    expect(cut.events).toHaveLength(DATA_EVENTS_LIMIT);
    expect(cut.truncated).toBe(true);
    expect(cut.events[0]).toMatchObject({
      kind: 'catalog_version',
      version: DATA_EVENTS_LIMIT + 2,
    });
    expect(cut.events.at(-1)).toMatchObject({ version: 3 });
  });

  it('con un rol que no puede leer ningún log, internal con LogsUnreadableError', async () => {
    const unprivileged = createReaderPool(readerConfig(UNPRIVILEGED_USER));
    unprivileged.on('error', () => undefined);
    try {
      const response = await getEvents(unprivileged);
      expect(response.status).toBe(500);
      expect(response.lines).toContainEqual({
        event: 'api_error',
        request_id: '00000000-0000-4000-8000-000000000000',
        error: 'LogsUnreadableError',
      });
    } finally {
      await unprivileged.end();
    }
  });

  /** El documento de la incidencia del límite que guardó el log 3, válido y en JCS. */
  async function storedLimitIncident(): Promise<{ readonly id: string; readonly jcs: string }> {
    const { rows } = await ready(admin).query<{ incident_id: string; incident_jcs: string }>(
      `SELECT incident_id, incident_jcs FROM ${logLocation(3).schema}.operational_incidents
        WHERE incident_type = 'source_limit_exceeded'`,
    );
    const [row] = rows;
    if (row === undefined) {
      throw new TypeError('Falta la incidencia del límite.');
    }
    return { id: row.incident_id, jcs: row.incident_jcs };
  }

  /**
   * Un log nuevo, el único sin vencer a la hora `at`, con una fila de `operational_incidents` con
   * el identificador `id` y el documento `jcs`: `GET /api/v1/datos/eventos` a esa hora.
   */
  async function eventsWithRow(number: number, at: string, id: string, jcs: string) {
    const schema = await createLog(number);
    await heartbeat(schema, at);
    await ready(admin).query(
      `INSERT INTO ${schema}.operational_incidents
         (incident_id, incident_type, severity, source, symbol, observed_at_utc, incident_jcs)
       VALUES ($1, 'source_limit_exceeded', 'error', $2, NULL, '2026-11-10T08:00:00.000Z', $3)`,
      [id, SOURCE, jcs],
    );
    return getEvents(ready(reader), Date.parse(at) + 60_000);
  }

  function expectIntegrityError(response: Awaited<ReturnType<typeof getEvents>>): void {
    expect(response.status).toBe(500);
    expect(response.lines).toContainEqual({
      event: 'api_error',
      request_id: '00000000-0000-4000-8000-000000000000',
      error: 'DataEventIntegrityError',
    });
    expect(JSON.stringify(response)).not.toContain('websocket_frame');
  }

  it('un documento válido que no está en JCS es internal, con DataEventIntegrityError y sin su contenido', async () => {
    const { id, jcs } = await storedLimitIncident();
    // El mismo documento, con su identificador, pero con espacios: no es JCS.
    const spaced = JSON.stringify(JSON.parse(jcs), null, 1);
    expectIntegrityError(await eventsWithRow(5, '2027-02-01T00:00:00.000Z', id, spaced));
  });

  it('una fila cuyo documento no es el de sus columnas es internal, con DataEventIntegrityError y sin su contenido', async () => {
    const { jcs } = await storedLimitIncident();
    // El documento de otra incidencia, válido y en JCS, en una fila con otro identificador.
    expectIntegrityError(
      await eventsWithRow(6, '2027-04-01T00:00:00.000Z', `sha256:${'0'.repeat(64)}`, jcs),
    );
  });

  /** Un log nuevo, legible y con un latido a la hora `at`. */
  async function liveLog(number: number, at: string): Promise<string> {
    const schema = await createLog(number);
    await heartbeat(schema, at);
    return schema;
  }

  /** `GET /api/v1/datos/eventos` un minuto después de `at`. */
  const eventsAt = (at: string) => getEvents(ready(reader), Date.parse(at) + 60_000);

  it('un log que el rol no puede leer no cuenta, como uno que se está preparando', async () => {
    const at = '2027-06-01T00:00:00.000Z';
    const readable = await liveLog(7, at);
    await catalogVersion(readable, 1, at);
    // El log 8, con una escritura, pero sin los privilegios de `buoh_lectura`.
    const unreadable = await createLog(8, { readable: false });
    await heartbeat(unreadable, at);
    const response = await eventsAt(at);
    expect(response.status).toBe(200);
    expect(dataEventsSchema.parse(response.body)).toMatchObject({
      logs: [7],
      events: [{ kind: 'catalog_version', log: 7 }],
      truncated: false,
    });
  });

  it('una condición que no es JSON, una respuesta pedida con otro motivo, una publicación sin UUIDv7, una versión con una fecha imposible y un motivo que no es un código son internal', async () => {
    const persistenceBody: Record<string, JsonValue> = {
      evidence: { reason: 'con un mensaje', stage: 'raw_object_write' },
      incident_type: 'persistence_unavailable',
      observed_at_utc: '2027-01-01T00:00:00.000Z',
      observed_ref: nextUuid(),
      quality_rule_version: '2.0.0',
      related_refs: [],
      schema_version: '2.0.0',
      severity: 'critical',
      source: SOURCE,
      symbol: null,
    };
    const requestedRef = nextUuid();
    const requestedBody: Record<string, JsonValue> = {
      evidence: { raw_payload_sha256: sha256('otra'), reason: 'schema_validation_failed' },
      incident_type: 'invalid_source_frame',
      observed_at_utc: '2027-01-01T00:00:00.000Z',
      observed_ref: requestedRef,
      quality_rule_version: '2.0.0',
      related_refs: [],
      schema_version: '2.0.0',
      severity: 'error',
      source: SOURCE,
      symbol: null,
    };
    const cases: readonly {
      readonly at: string;
      readonly write: (schema: string) => Promise<void>;
    }[] = [
      {
        at: '2027-08-01T00:00:00.000Z',
        write: async (schema) => {
          await ready(admin).query(
            `INSERT INTO ${schema}.operational_conditions
               (condition_event_id, condition_key, condition_type, action, source, symbol,
                occurred_at_utc, condition_jcs)
             VALUES ($1, $2, 'persistence_unavailable', 'opened', $3, NULL,
                     '2027-01-01T00:00:00.000Z', '{"condicion":')`,
            [
              `sha256:${'1'.repeat(64)}`,
              `persistence_unavailable:sha256:${'2'.repeat(64)}`,
              SOURCE,
            ],
          );
        },
      },
      {
        at: '2027-10-01T00:00:00.000Z',
        write: async (schema) => {
          const incident = withId('incident_id', requestedBody);
          // La columna dice otro motivo que su documento.
          await ready(admin).query(
            `INSERT INTO ${schema}.requested_response_incidents
               (incident_id, incident_type, source, observed_ref, observed_at_utc, reason,
                incident_jcs)
             VALUES ($1, 'invalid_source_frame', $2, $3, '2027-01-01T00:00:00.000Z',
                     'catalog_empty', $4)`,
            [incident.incident_id, SOURCE, requestedRef, canonicalJson(incident as JsonValue)],
          );
        },
      },
      {
        at: '2027-12-01T00:00:00.000Z',
        write: async (schema) => {
          const core = '{"publicacion":"sin-uuidv7"}';
          await ready(admin).query(
            `INSERT INTO ${schema}.datasets (dataset_id, state, source, manifest_core_jcs)
             VALUES ($1, 'published', $2, $3)`,
            [`sha256:${sha256(core)}`, SOURCE, core],
          );
          await ready(admin).query(
            `INSERT INTO ${schema}.published_manifest_records
               (publication_id, deployment_environment, dataset_id, schema_version,
                manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
                published_at_utc, state)
             VALUES ('00000000-0000-4000-8000-000000000001', 'test', $1, '1.0.0', $2,
                     's3://buoh-local/manifests/x.json', $2, '2027-01-01T00:00:00.000Z', 'active')`,
            [`sha256:${sha256(core)}`, sha256(core)],
          );
        },
      },
      {
        at: '2028-02-01T00:00:00.000Z',
        write: (schema) => catalogVersion(schema, 1, '2027-02-30T00:00:00.000Z'),
      },
      {
        at: '2028-04-01T00:00:00.000Z',
        write: async (schema) => {
          const pool = logPool(13);
          try {
            await new PostgresOperationalStore(pool).append({
              conditions: [],
              incidents: [withId('incident_id', persistenceBody) as unknown as DataQualityIncident],
            });
          } finally {
            await pool.end();
          }
          expect(schema).toBe(logLocation(13).schema);
        },
      },
    ];
    let number = 9;
    for (const { at, write } of cases) {
      await write(await liveLog(number, at));
      const response = await eventsAt(at);
      expect(response.status, at).toBe(500);
      expect(response.lines, at).toContainEqual({
        event: 'api_error',
        request_id: '00000000-0000-4000-8000-000000000000',
        error: 'DataEventIntegrityError',
      });
      expect(JSON.stringify(response), at).not.toMatch(/con un mensaje|schema_validation_failed/u);
      number += 1;
    }
  });

  it('el corte toma los más recientes de varios logs y de las dos tablas de incidencias', async () => {
    const at = '2028-06-01T00:00:00.000Z';
    const older = await liveLog(14, '2028-05-31T00:00:00.000Z');
    const newer = await liveLog(15, at);
    const time = (second: number) =>
      new Date(Date.parse('2028-05-30T00:00:00.000Z') + second * 1000).toISOString();
    const body = (second: number, requested: boolean): Record<string, JsonValue> => ({
      evidence: requested
        ? { raw_payload_sha256: sha256(String(second)), reason: 'source_error_response' }
        : { reason: 'ServiceUnavailable', stage: 'raw_object_write' },
      incident_type: requested ? 'invalid_source_frame' : 'persistence_unavailable',
      observed_at_utc: time(second),
      observed_ref: nextUuid(),
      quality_rule_version: '2.0.0',
      related_refs: [],
      schema_version: '2.0.0',
      severity: requested ? 'error' : 'critical',
      source: SOURCE,
      symbol: null,
    });
    // En el log 14, 150 incidencias del registro operativo en los segundos pares del 0 al 298 y 60
    // respuestas pedidas en los impares del 1 al 119; en el 15, 10 versiones del catálogo, más
    // nuevas que todas.
    const pool = logPool(14);
    try {
      await new PostgresOperationalStore(pool).append({
        conditions: [],
        incidents: Array.from(
          { length: 150 },
          (_, index) =>
            withId('incident_id', body(index * 2, false)) as unknown as DataQualityIncident,
        ),
      });
      const store = new PostgresRequestedResponseIncidentStore(pool);
      for (let index = 0; index < 60; index += 1) {
        await store.append(
          withId('incident_id', body(index * 2 + 1, true)) as unknown as DataQualityIncident,
        );
      }
    } finally {
      await pool.end();
    }
    for (let version = 1; version <= 10; version += 1) {
      await catalogVersion(newer, version, time(1000 + version));
    }
    expect(older).toBe(logLocation(14).schema);
    const result = dataEventsSchema.parse((await eventsAt(at)).body);
    expect(result.logs).toEqual([15, 14]);
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(DATA_EVENTS_LIMIT);
    const kinds = result.events.map((event) =>
      event.kind === 'incident' ? event.incident_type : event.kind,
    );
    // Las 10 versiones y, de las 210 incidencias, las 190 más nuevas: quedan fuera los segundos 0
    // a 19, 10 de cada tabla.
    expect(kinds.filter((kind) => kind === 'catalog_version')).toHaveLength(10);
    expect(kinds.filter((kind) => kind === 'persistence_unavailable')).toHaveLength(140);
    expect(kinds.filter((kind) => kind === 'invalid_source_frame')).toHaveLength(50);
    expect(result.events[0]).toMatchObject({ kind: 'catalog_version', version: 10 });
    expect(result.events[10]).toMatchObject({ at_utc: time(298) });
    expect(result.events.at(-1)).toMatchObject({ at_utc: time(20) });
  });
});
