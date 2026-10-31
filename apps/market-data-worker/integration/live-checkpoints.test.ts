import { buildLiveDerivationCheckpoint, emptyLiveDerivationState } from '@buoh/domain';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { createPool, loadConfig, migrate, openStores, type WorkerConfig } from '../src/index.js';
import {
  checkpointRow,
  checkStoredCheckpoint,
  liveCheckpointVersionsSha256,
} from '../src/source-log/live-checkpoint.js';
import {
  checkpointStoreRules,
  closeSegments,
  logicalSha256,
  sourceEventLookupRules,
  storedCheckpointOf,
} from '../test/support/checkpoint-store-rules.js';
import { syntheticSchemas } from '../test/support/connection-harness.js';

/**
 * Migración `0005` (ADR-0017 §5 y §6): los puntos de control del estado vivo, contra PostgreSQL
 * local. Esquema PostgreSQL propio, recreado en cada ejecución.
 */
const SCHEMA = 'buoh_integration_checkpoints';
const SYMBOL = 'SYNTH_100';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;
let applied: string[];
const profile = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });

/** Las columnas de `live_derivation_checkpoints`, en el orden de la migración. */
const COLUMNS = [
  'source',
  'symbol',
  'segment_index',
  'schema_version',
  'segment_logical_content_sha256',
  'event_count',
  'raw_frame_count',
  'connector_version',
  'live_state_version',
  'quality_profile_sha256',
  'quality_rule_version',
  'segment_policy_version',
  'source_event_schema_version',
  'source_schema_sha256',
  'versions_sha256',
  'checkpoint_jcs',
  'checkpoint_sha256',
  'written_at_utc',
] as const;

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'sin error',
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

/** Inserta una fila sin pasar por el almacén. */
function insertRow(row: Readonly<Partial<Record<(typeof COLUMNS)[number], unknown>>>) {
  return stores.pool.query(
    `INSERT INTO live_derivation_checkpoints (${COLUMNS.join(', ')})
     VALUES (${COLUMNS.map((_column, index) => `$${String(index + 1)}`).join(', ')})`,
    COLUMNS.map((column) => row[column]),
  );
}

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  applied = (await migrate(stores.pool)).applied;
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

describe('migración 0005', () => {
  it('se aplica después de las cuatro anteriores, y antes de la 0006', () => {
    expect(applied).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
      '0004_cursor_y_latido.sql',
      '0005_punto_de_control_en_vivo.sql',
      '0006_informes_de_operaciones.sql',
    ]);
  });
});

describe('PostgresSourceLogStore: búsqueda de un evento en el índice (ADR-0017 §4)', () => {
  sourceEventLookupRules(() => stores.sourceLog);
});

describe('PostgresSourceLogStore: puntos de control del estado vivo (ADR-0017 §5 y §6)', () => {
  checkpointStoreRules(() => stores.sourceLog);

  it('guarda cada campo en su columna y el punto de control entero en JCS, y quien lo lee lo acepta con su enlace', async () => {
    await closeSegments(stores.sourceLog, DERIV_SOURCE, 1);
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: 3,
      profile,
      raw_frame_count: 2,
      segment_index: 0,
      segment_logical_content_sha256: logicalSha256(DERIV_SOURCE, 0),
      state: emptyLiveDerivationState(),
      symbol: SYMBOL,
    });
    const row = checkpointRow(checkpoint, '2026-03-02T10:05:00.000Z');
    expect(await stores.sourceLog.insertLiveCheckpoint(row)).toBe('inserted');

    const { rows } = await stores.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS.map((column) =>
        ['event_count', 'raw_frame_count', 'segment_index'].includes(column)
          ? `${column}::int AS ${column}`
          : column,
      ).join(', ')}
         FROM live_derivation_checkpoints WHERE source = $1`,
      [DERIV_SOURCE],
    );
    expect(rows).toEqual([row]);
    const versions = liveCheckpointVersionsSha256(profile);
    const candidate = await stores.sourceLog.readLiveCheckpoint(DERIV_SOURCE, versions, null);
    if (candidate === null) {
      throw new TypeError('Falta el punto de control.');
    }
    expect(candidate.row).toEqual(row);
    expect(
      checkStoredCheckpoint(candidate, {
        source: DERIV_SOURCE,
        symbol: SYMBOL,
        versions_sha256: versions,
      }),
    ).toEqual({ checkpoint, status: 'valid' });
  });

  it('dos escritores a la vez no guardan dos filas con la misma clave', async () => {
    const source = 'sql_cp_concurrent';
    const first = storedCheckpointOf(source, 0);
    const second = storedCheckpointOf(source, 0, { checkpoint_jcs: '{"otro":true}' });
    const results = await Promise.all([
      stores.sourceLog.insertLiveCheckpoint(first),
      stores.sourceLog.insertLiveCheckpoint(second),
    ]);
    expect(results.toSorted()).toEqual(['conflict', 'inserted']);
    const { rows } = await stores.pool.query<{ count: string }>(
      'SELECT count(*) FROM live_derivation_checkpoints WHERE source = $1',
      [source],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('los CHECK de live_derivation_checkpoints', async () => {
    const valid = (segmentIndex: number) => storedCheckpointOf('sql_cp_checks', segmentIndex);
    const cases: [Record<string, unknown>, string][] = [
      [{ source: '' }, '23514'],
      [{ symbol: '' }, '23514'],
      [{ segment_index: -1 }, '23514'],
      [{ schema_version: '2.0.0' }, '23514'],
      [{ segment_logical_content_sha256: 'x' }, '23514'],
      [{ event_count: 0, raw_frame_count: 0 }, '23514'],
      [{ event_count: 3, raw_frame_count: 4 }, '23514'],
      [{ raw_frame_count: -1 }, '23514'],
      [{ connector_version: '' }, '23514'],
      [{ live_state_version: '1.0' }, '23514'],
      [{ quality_profile_sha256: 'C'.repeat(64) }, '23514'],
      [{ quality_rule_version: 'v2' }, '23514'],
      [{ segment_policy_version: '01.0.0' }, '23514'],
      [{ source_event_schema_version: '' }, '23514'],
      [{ source_schema_sha256: 'g'.repeat(64) }, '23514'],
      [{ versions_sha256: 'a'.repeat(63) }, '23514'],
      [{ checkpoint_sha256: 'a'.repeat(65) }, '23514'],
      [{ written_at_utc: '2026-03-02T10:05:00Z' }, '23514'],
      [{ checkpoint_jcs: null }, '23502'],
    ];
    for (const [index, [change, code]] of cases.entries()) {
      expect(
        await errorCode(insertRow({ ...valid(index), ...change })),
        JSON.stringify(change),
      ).toBe(code);
    }
    expect(await errorCode(insertRow(valid(100)))).toBe('sin error');
  });

  it('la tabla es append-only', async () => {
    await stores.sourceLog.insertLiveCheckpoint(storedCheckpointOf('sql_cp_append_only', 0));
    for (const statement of [
      "UPDATE live_derivation_checkpoints SET symbol = 'x'",
      'DELETE FROM live_derivation_checkpoints',
      'TRUNCATE live_derivation_checkpoints',
    ]) {
      expect(await errorCode(stores.pool.query(statement))).toBe('23001');
    }
  });
});
