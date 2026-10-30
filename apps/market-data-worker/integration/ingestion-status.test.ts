import { canonicalJson, type JsonValue } from '@buoh/contracts';
import {
  deriveRequestedResponseIncident,
  type PipelineProfile,
  type RequestedResponseInvalidReason,
} from '@buoh/domain';
import { createServer, type AddressInfo } from 'node:net';

import { type Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { openSchemaArchive } from '../src/deriv/schema-archive.js';
import { SourceLockUnavailableError } from '../src/deriv/session.js';
import {
  buildRawSourceFrame,
  createPool,
  LogPersistenceError,
  loadConfig,
  migrate,
  openLockedSourceLog,
  openStores,
  PostgresSessionLockProvider,
  SOURCE_LOCK_LOST,
  SourceLock,
  type WorkerConfig,
} from '../src/index.js';
import { sourceLockHolder } from '../src/postgres/source-lock.js';
import { derivMessages, syntheticSchemaArchive } from '../test/support/deriv-fixtures.js';
import {
  cursorOf,
  heartbeatOf,
  statusStoreRules,
  uuid,
} from '../test/support/status-store-rules.js';

/**
 * Migración `0004` (ADR-0015 §6): cursor y latido de la ingesta, el motivo `history_inconsistent`
 * de las respuestas pedidas, y el bloqueo de PostgreSQL de la sesión (ADR-0015 §3, «Bloqueo»),
 * contra PostgreSQL y S3-compatible locales. Esquema PostgreSQL propio, recreado en cada ejecución.
 */
const SCHEMA = 'buoh_integration_status';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;
let applied: string[];
let profile: PipelineProfile;

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'sin error',
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

/** Backend que tiene el bloqueo de la fuente según `pg_locks`, o `null`. */
const holder = (source: string): Promise<number | null> => sourceLockHolder(admin, source);

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  applied = (await migrate(stores.pool)).applied;
  const fixture = syntheticSchemaArchive();
  const loaded = openSchemaArchive(fixture.archive, fixture.expected);
  if (loaded.status !== 'loaded') {
    throw new TypeError(loaded.reason);
  }
  profile = createDerivMeasurementProfile({ schemas: loaded.schemas, symbol: 'SYNTH_100' });
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

describe('migración 0004', () => {
  it('se aplica después de las tres anteriores, y antes de la 0005', () => {
    expect(applied).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
      '0004_cursor_y_latido.sql',
      '0005_punto_de_control_en_vivo.sql',
    ]);
  });
});

describe('PostgresIngestionStatusStore (ADR-0015 §6)', () => {
  statusStoreRules(() => stores.ingestionStatus);

  /** Inserta una fila de `ingestion_cursors` sin pasar por el almacén. */
  function insertCursor(row: {
    readonly active_segment_index?: number;
    readonly connection_id?: string | null;
    readonly cursor_jcs?: string;
    readonly high_watermark_event_time_utc?: string | null;
    readonly schema_version?: string;
    readonly source: string;
    readonly source_event_count?: number;
    readonly symbol?: string;
    readonly updated_at_utc?: string;
    readonly version: number;
  }) {
    const cursor = cursorOf(row.source);
    return stores.pool.query(
      `INSERT INTO ingestion_cursors
         (source, symbol, version, schema_version, connection_id, active_segment_index,
          source_event_count, last_durable_source_event_id, last_durable_observation_id,
          high_watermark_event_time_utc, updated_at_utc, cursor_jcs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.source,
        row.symbol ?? cursor.symbol,
        row.version,
        row.schema_version ?? cursor.schema_version,
        row.connection_id === undefined ? cursor.connection_id : row.connection_id,
        row.active_segment_index ?? cursor.active_segment_index,
        row.source_event_count ?? cursor.source_event_count,
        cursor.last_durable_source_event_id,
        cursor.last_durable_observation_id,
        row.high_watermark_event_time_utc === undefined
          ? cursor.high_watermark_event_time_utc
          : row.high_watermark_event_time_utc,
        row.updated_at_utc ?? cursor.updated_at_utc,
        row.cursor_jcs ?? canonicalJson(cursor),
      ],
    );
  }

  /** Inserta una fila de `ingestion_heartbeats` sin pasar por el almacén. */
  function insertHeartbeat(
    sequence: number,
    row: {
      readonly backlog_bytes?: number;
      readonly backlog_count?: number;
      readonly connection_state?: string;
      readonly observed_at_utc?: string;
      readonly pg_backend_pid?: number | null;
      readonly source?: string;
    } = {},
  ) {
    const heartbeat = heartbeatOf('sql_heartbeats', sequence);
    return stores.pool.query(
      `INSERT INTO ingestion_heartbeats
         (heartbeat_id, source, run_id, observed_at_utc, pg_backend_pid, connection_state,
          backlog_count, backlog_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        heartbeat.heartbeat_id,
        row.source ?? heartbeat.source,
        heartbeat.run_id,
        row.observed_at_utc ?? heartbeat.observed_at_utc,
        row.pg_backend_pid === undefined ? heartbeat.pg_backend_pid : row.pg_backend_pid,
        row.connection_state ?? heartbeat.connection_state,
        row.backlog_count ?? heartbeat.backlog_count,
        row.backlog_bytes ?? heartbeat.backlog_bytes,
      ],
    );
  }

  it('guarda cada campo del cursor en su columna y el cursor entero en JCS', async () => {
    const cursor = cursorOf('sql_columns', {
      active_segment_index: 2,
      source_event_count: 9_007_199_254_740_991,
    });
    await stores.ingestionStatus.appendCursor(cursor);
    const { rows } = await stores.pool.query<Record<string, unknown>>(
      `SELECT source, symbol, version, schema_version, connection_id::text AS connection_id,
              active_segment_index::text AS active_segment_index,
              source_event_count::text AS source_event_count,
              last_durable_source_event_id::text AS last_durable_source_event_id,
              last_durable_observation_id::text AS last_durable_observation_id,
              high_watermark_event_time_utc, updated_at_utc, cursor_jcs
         FROM ingestion_cursors WHERE source = 'sql_columns'`,
    );
    expect(rows).toEqual([
      {
        ...cursor,
        active_segment_index: '2',
        cursor_jcs: canonicalJson(cursor),
        source_event_count: '9007199254740991',
        version: 1,
      },
    ]);
    expect((await stores.ingestionStatus.latestCursor('sql_columns', 'SYNTH_100'))?.cursor).toEqual(
      cursor,
    );
  });

  it('el trigger exige versiones del cursor contiguas desde 1 por fuente y símbolo', async () => {
    expect(await errorCode(insertCursor({ source: 'sql_contiguous', version: 2 }))).toBe('23514');
    expect(await errorCode(insertCursor({ source: 'sql_contiguous', version: 1 }))).toBe(
      'sin error',
    );
    expect(await errorCode(insertCursor({ source: 'sql_contiguous', version: 1 }))).toBe('23514');
    expect(await errorCode(insertCursor({ source: 'sql_contiguous', version: 3 }))).toBe('23514');
    // Otro símbolo de la misma fuente empieza en 1.
    expect(
      await errorCode(insertCursor({ source: 'sql_contiguous', symbol: 'SYNTH_50', version: 1 })),
    ).toBe('sin error');
    expect((await stores.ingestionStatus.appendCursor(cursorOf('sql_contiguous'))).version).toBe(2);
  });

  it('dos escritores a la vez no repiten una versión del cursor', async () => {
    await stores.ingestionStatus.appendCursor(cursorOf('sql_concurrent'));
    const first = await stores.pool.connect();
    const second = await stores.pool.connect();
    try {
      const insert = (client: PoolClient) =>
        client.query(
          `INSERT INTO ingestion_cursors
             (source, symbol, version, schema_version, connection_id, active_segment_index,
              source_event_count, last_durable_source_event_id, last_durable_observation_id,
              high_watermark_event_time_utc, updated_at_utc, cursor_jcs)
           SELECT source, symbol, 2, schema_version, connection_id, active_segment_index,
                  source_event_count, last_durable_source_event_id, last_durable_observation_id,
                  high_watermark_event_time_utc, updated_at_utc, cursor_jcs
             FROM ingestion_cursors WHERE source = 'sql_concurrent' AND version = 1`,
        );
      await first.query('BEGIN');
      await insert(first);
      // El segundo no ve la versión 2 sin confirmar: lo para la clave primaria al confirmarse la
      // del primero o, si llega después, el trigger.
      const pending = errorCode(insert(second));
      await first.query('COMMIT');
      expect(['23505', '23514']).toContain(await pending);
    } finally {
      first.release();
      second.release();
    }
    const { rows } = await stores.pool.query<{ version: number }>(
      "SELECT version FROM ingestion_cursors WHERE source = 'sql_concurrent' ORDER BY version",
    );
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
  });

  it('los CHECK de ingestion_cursors', async () => {
    const cases: [Parameters<typeof insertCursor>[0], string][] = [
      [{ schema_version: '1.1.0', source: 'sql_cursor_checks', version: 1 }, '23514'],
      [{ source: '', version: 1 }, '23514'],
      [{ source: 'sql_cursor_checks', symbol: '', version: 1 }, '23514'],
      [{ source: 'sql_cursor_checks', version: 0 }, '23514'],
      [{ active_segment_index: -1, source: 'sql_cursor_checks', version: 1 }, '23514'],
      [{ source: 'sql_cursor_checks', source_event_count: -1, version: 1 }, '23514'],
      [
        { source: 'sql_cursor_checks', updated_at_utc: '2026-03-02T10:00:02Z', version: 1 },
        '23514',
      ],
      [
        {
          high_watermark_event_time_utc: '2026-03-02 10:00:01.000Z',
          source: 'sql_cursor_checks',
          version: 1,
        },
        '23514',
      ],
      [{ connection_id: null, source: 'sql_cursor_checks', version: 1 }, '23502'],
    ];
    for (const [row, code] of cases) {
      expect(await errorCode(insertCursor(row))).toBe(code);
    }
    expect(
      await errorCode(
        insertCursor({
          high_watermark_event_time_utc: null,
          source: 'sql_cursor_checks',
          version: 1,
        }),
      ),
    ).toBe('sin error');
  });

  it('los CHECK de ingestion_heartbeats', async () => {
    // `heartbeat_id` es único en toda la tabla: números que no usa ninguna otra prueba.
    const cases: [number, Parameters<typeof insertHeartbeat>[1], string][] = [
      [101, { connection_state: 'paused' }, '23514'],
      [102, { backlog_count: -1 }, '23514'],
      [103, { backlog_bytes: -1 }, '23514'],
      [104, { pg_backend_pid: 0 }, '23514'],
      [105, { pg_backend_pid: null }, '23502'],
      [106, { observed_at_utc: '2026-03-02T10:00:00Z' }, '23514'],
      [107, { source: '' }, '23514'],
    ];
    for (const [sequence, row, code] of cases) {
      expect(await errorCode(insertHeartbeat(sequence, row))).toBe(code);
    }
    for (const [sequence, state] of [
      [108, 'connecting'],
      [109, 'connected'],
      [110, 'disconnected'],
    ] as const) {
      expect(await errorCode(insertHeartbeat(sequence, { connection_state: state }))).toBe(
        'sin error',
      );
    }
    expect((await stores.ingestionStatus.latestHeartbeat('sql_heartbeats'))?.connection_state).toBe(
      'disconnected',
    );
  });

  it('las dos tablas son append-only', async () => {
    await stores.ingestionStatus.appendCursor(cursorOf('sql_append_only'));
    await stores.ingestionStatus.appendHeartbeat(heartbeatOf('sql_append_only', 30));
    for (const table of ['ingestion_cursors', 'ingestion_heartbeats']) {
      expect(await errorCode(stores.pool.query(`UPDATE ${table} SET source = 'x'`))).toBe('23001');
      expect(await errorCode(stores.pool.query(`DELETE FROM ${table}`))).toBe('23001');
      expect(await errorCode(stores.pool.query(`TRUNCATE ${table}`))).toBe('23001');
    }
  });

  it('latestCursor falla si el JCS de la fila no es el de sus columnas', async () => {
    const cursor = cursorOf('sql_tampered');
    const cases = [
      // Otro valor en el JCS.
      canonicalJson({ ...cursor, source_event_count: 5 }),
      // El mismo cursor, pero no en JCS.
      JSON.stringify(cursor, null, 2),
      // Un JSON que no es un cursor.
      '{}',
    ];
    for (const [index, jcs] of cases.entries()) {
      const source = `sql_tampered_${String(index)}`;
      await insertCursor({
        cursor_jcs: jcs.replaceAll('sql_tampered', source),
        source,
        version: 1,
      });
      await expect(stores.ingestionStatus.latestCursor(source, 'SYNTH_100')).rejects.toThrow();
    }
    await expect(
      stores.ingestionStatus.latestCursor('sql_tampered_0', 'SYNTH_100'),
    ).rejects.toThrow(/no corresponde a su fila/u);
  });
});

describe('requested_response_incidents con history_inconsistent (migración 0004)', () => {
  it('PostgresRequestedResponseIncidentStore guarda una página de historia incoherente', async () => {
    const frame = buildRawSourceFrame(
      {
        connection_id: uuid(1),
        observation_id: uuid(60),
        // `times` y `prices` de distinta longitud.
        payload_utf8: derivMessages.history(7, [1772445600, 1772445601], ['100.00']),
        received_at_utc: '2026-03-02T10:00:00.000Z',
      },
      profile,
    );
    const incident = deriveRequestedResponseIncident(frame, 'history_inconsistent');
    await stores.requestedResponses.append(incident);
    const { rows } = await stores.pool.query<{ incident_jcs: string; reason: string }>(
      'SELECT reason, incident_jcs FROM requested_response_incidents WHERE observed_ref = $1',
      [uuid(60)],
    );
    expect(rows).toEqual([
      { incident_jcs: canonicalJson(incident as JsonValue), reason: 'history_inconsistent' },
    ]);
  });

  it('la tabla admite los siete motivos de una respuesta pedida y ninguno más', async () => {
    const reasons: (RequestedResponseInvalidReason | 'otro')[] = [
      'catalog_duplicate_symbol',
      'catalog_empty',
      'catalog_entry_invalid',
      'catalog_exponent_not_supported',
      'history_inconsistent',
      'schema_validation_failed',
      'source_error_response',
      'otro',
    ];
    const codes: unknown[] = [];
    for (const [index, reason] of reasons.entries()) {
      codes.push(
        await errorCode(
          stores.pool.query(
            `INSERT INTO requested_response_incidents
               (incident_id, incident_type, source, observed_ref, observed_at_utc, reason, incident_jcs)
             VALUES ($1, 'invalid_source_frame', $2, $3, '2026-03-02T10:00:00.000Z', $4, '{}')`,
            [`sha256:${String(index).repeat(64)}`, DERIV_SOURCE, uuid(70 + index), reason],
          ),
        ),
      );
    }
    expect(codes).toEqual([...Array<string>(7).fill('sin error'), '23514']);
  });
});

describe('PostgresSessionLockProvider (ADR-0015 §3, «Bloqueo»)', () => {
  it('toma el bloqueo con el PID de su sesión, y otro proveedor recibe null mientras lo tiene', async () => {
    const provider = new PostgresSessionLockProvider({
      postgres: config.postgres,
      source: 'lock_provider',
    });
    const other = new PostgresSessionLockProvider({
      postgres: config.postgres,
      source: 'lock_provider',
    });
    const lock = await provider.acquire();
    if (lock === null) {
      throw new TypeError('No se tomó el bloqueo.');
    }
    try {
      expect(lock.held).toBe(true);
      expect(lock.backendPid).toBe(await holder('lock_provider'));
      expect(await other.acquire()).toBeNull();
    } finally {
      await lock.release();
    }
    expect(await holder('lock_provider')).toBeNull();
    const next = await other.acquire();
    try {
      expect(next?.held).toBe(true);
      expect(next?.backendPid).toBe(await holder('lock_provider'));
      expect(next?.backendPid).not.toBe(lock.backendPid);
    } finally {
      await next?.release();
    }
  });

  it('si PostgreSQL no responde, lanza SourceLockUnavailableError con la causa', async () => {
    // Un puerto local sin nadie que escuche.
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const provider = new PostgresSessionLockProvider({
      postgres: { ...config.postgres, host: '127.0.0.1', port },
      source: 'lock_unavailable',
    });
    const error = await provider.acquire().then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(SourceLockUnavailableError);
    expect((error as SourceLockUnavailableError).reason).toBe('ECONNREFUSED');
    expect(((error as Error).cause as { code?: unknown }).code).toBe('ECONNREFUSED');
  });

  it('openLockedSourceLog escribe con el bloqueo vigente y deja de escribir al soltarlo', async () => {
    const source = 'lock_log';
    const provider = new PostgresSessionLockProvider({ postgres: config.postgres, source });
    const lock = await provider.acquire();
    if (lock === null) {
      throw new TypeError('No se tomó el bloqueo.');
    }
    const log = await openLockedSourceLog(lock, {
      objects: stores.objects,
      source,
      store: stores.sourceLog,
      zlibVersion: process.versions.zlib,
    });
    const opened = (sequence: number) => ({
      connection_id: uuid(sequence),
      event_id: uuid(sequence + 1),
      kind: 'connection_opened' as const,
      occurred_at_utc: '2026-03-02T10:00:00.000Z',
      schema_version: '1.0.0',
      source,
      supersedes_connection_id: null,
    });
    expect((await log.append(opened(80))).position).toBe(0);

    await lock.release();
    const error = await log.append(opened(82)).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(LogPersistenceError);
    expect((error as LogPersistenceError).reason).toBe(SOURCE_LOCK_LOST);
    const { rowCount } = await stores.pool.query(
      'SELECT 1 FROM source_event_index WHERE source = $1',
      [source],
    );
    expect(rowCount).toBe(1);
  });

  it('openLockedSourceLog no abre el log de una fuente con el bloqueo de otra', async () => {
    const lock = await SourceLock.acquire({ postgres: config.postgres, source: 'lock_other' });
    if (lock === null) {
      throw new TypeError('No se tomó el bloqueo.');
    }
    try {
      await expect(
        openLockedSourceLog(lock, {
          objects: stores.objects,
          source: 'lock_mine',
          store: stores.sourceLog,
          zlibVersion: process.versions.zlib,
        }),
      ).rejects.toThrow(TypeError);
    } finally {
      await lock.release();
    }
  });
});
