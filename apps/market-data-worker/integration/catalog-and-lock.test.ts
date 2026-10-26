import {
  canonicalJson,
  dataQualityIncidentSchema,
  deriveEventId,
  sha256Hex,
  type JsonValue,
  type SourceCatalogSnapshot,
} from '@buoh/contracts';
import {
  createCatalogResponseSchema,
  deriveCatalogSnapshot,
  deriveRequestedResponseIncident,
  type PipelineProfile,
} from '@buoh/domain';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { openSchemaArchive } from '../src/deriv/schema-archive.js';
import {
  buildRawSourceFrame,
  contentKey,
  createPool,
  loadConfig,
  lockedSourceLogStore,
  migrate,
  openStores,
  PostgresCatalogStore,
  SOURCE_LOCK_LOST,
  SourceLock,
  sourceLockKey,
  type ObjectStore,
  type WorkerConfig,
} from '../src/index.js';
import {
  catalogEntry,
  derivMessages,
  SYNTH_50,
  SYNTH_100,
  syntheticSchemaArchive,
} from '../test/support/deriv-fixtures.js';

/**
 * Catálogo, incidencias de respuestas pedidas y bloqueo por fuente (ADR-0012 §6, §7 y §9) contra
 * PostgreSQL y S3-compatible locales. Esquema PostgreSQL propio, recreado en cada ejecución.
 */
const SCHEMA = 'buoh_integration_catalog';
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
let catalogSchema: ReturnType<typeof createCatalogResponseSchema>;

function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function frame(entries: readonly unknown[], sequence: number, source = DERIV_SOURCE) {
  return buildRawSourceFrame(
    {
      connection_id: uuid(1),
      observation_id: uuid(sequence),
      payload_utf8: derivMessages.catalog(1, entries),
      received_at_utc: `2026-03-02T10:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    },
    { ...profile, source },
  );
}

function snapshot(entries: readonly unknown[], sequence: number, source = DERIV_SOURCE) {
  const result = deriveCatalogSnapshot(frame(entries, sequence, source), catalogSchema);
  if (!result.ok) {
    throw new TypeError(result.reason);
  }
  return result.snapshot;
}

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'sin error',
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

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
  catalogSchema = createCatalogResponseSchema({
    source_schema_bytes: loaded.schemas.schema('active_symbols', 'response').bytes,
    source_schema_release: loaded.schemas.release,
  });
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

describe('migración 0003', () => {
  it('se aplica después de las dos anteriores', () => {
    expect(applied).toEqual([
      '0001_publicaciones.sql',
      '0002_log_raw_first.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
    ]);
  });
});

describe('PostgresCatalogStore (ADR-0012 §7)', () => {
  it('crea versiones contiguas solo cuando cambia el contenido, y guarda el JCS por contenido', async () => {
    const first = snapshot([SYNTH_100, SYNTH_50], 10);
    // Mismo contenido, otra consulta: solo cambia trade_count, que no entra en el snapshot.
    const sameContent = snapshot(
      [catalogEntry('SYNTH_100', 'Synthetic 100 Index', 99), SYNTH_50],
      11,
    );
    const changed = snapshot([SYNTH_100, { ...SYNTH_50, exchange_is_open: 0 }], 12);
    const backToFirst = snapshot([SYNTH_100, SYNTH_50], 13);
    expect(sameContent.content_sha256).toBe(first.content_sha256);
    expect(backToFirst.snapshot_id).not.toBe(first.snapshot_id);

    expect(await stores.catalog.latest(DERIV_SOURCE, 'deriv_active_symbols')).toBeNull();
    expect(await stores.catalog.record(first)).toEqual({ status: 'created', version: 1 });
    expect(await stores.catalog.record(sameContent)).toEqual({ status: 'unchanged', version: 1 });
    expect(await stores.catalog.record(changed)).toEqual({ status: 'created', version: 2 });
    // Volver a un contenido anterior también crea versión.
    expect(await stores.catalog.record(backToFirst)).toEqual({ status: 'created', version: 3 });

    const { rows } = await stores.pool.query<{
      document_sha256: string;
      snapshot_id: string;
      version: number;
    }>(
      `SELECT version, snapshot_id, document_sha256 FROM source_catalog_versions
        WHERE source = $1 ORDER BY version`,
      [DERIV_SOURCE],
    );
    expect(rows.map((row) => [row.version, row.snapshot_id])).toEqual([
      [1, first.snapshot_id],
      [2, changed.snapshot_id],
      [3, backToFirst.snapshot_id],
    ]);
    const document = canonicalJson(backToFirst);
    expect(rows[2]?.document_sha256).toBe(sha256Hex(document));
    const stored = await stores.objects.get(contentKey(sha256Hex(document)), 1_000_000);
    expect(new TextDecoder().decode(stored)).toBe(document);

    expect(await stores.catalog.latest(DERIV_SOURCE, 'deriv_active_symbols')).toEqual({
      snapshot: backToFirst,
      version: 3,
    });
  });

  it('cada fuente lleva su propia secuencia de versiones', async () => {
    const other = snapshot([SYNTH_100], 20, 'other_source');
    expect(await stores.catalog.record(other)).toEqual({ status: 'created', version: 1 });
    expect((await stores.catalog.latest('other_source', 'deriv_active_symbols'))?.version).toBe(1);
  });

  it('un documento alterado en el almacenamiento hace fallar la lectura', async () => {
    const tampered: ObjectStore = {
      bucket: stores.objects.bucket,
      get: async (key, maxBytes) => {
        const bytes = Uint8Array.from(await stores.objects.get(key, maxBytes));
        bytes[bytes.length - 2] = 0x20;
        return bytes;
      },
      putIfAbsent: (key, bytes, contentType) => stores.objects.putIfAbsent(key, bytes, contentType),
    };
    const store = new PostgresCatalogStore(stores.pool, tampered);
    await expect(store.latest(DERIV_SOURCE, 'deriv_active_symbols')).rejects.toThrow(/hash/u);
  });

  it('los triggers rechazan versiones no contiguas, sin cambio de contenido y modificaciones', async () => {
    const insert = (version: number, item: SourceCatalogSnapshot) =>
      stores.pool.query(
        `INSERT INTO source_catalog_versions
           (source, catalog_format, version, snapshot_id, content_sha256, entry_count,
            observation_id, received_at_utc, document_sha256, document_byte_length)
         VALUES ($1, 'deriv_active_symbols', $2, $3, $4, $5, $6, $7, $8, 1)`,
        [
          item.source,
          version,
          item.snapshot_id,
          item.content_sha256,
          item.entry_count,
          item.observation_id,
          item.received_at_utc,
          '0'.repeat(64),
        ],
      );
    // La última versión de deriv_options es la 3, con el contenido de [SYNTH_100, SYNTH_50].
    expect(await errorCode(insert(5, snapshot([SYNTH_50], 30)))).toBe('23514');
    expect(await errorCode(insert(4, snapshot([SYNTH_100, SYNTH_50], 31)))).toBe('23514');
    expect(
      await errorCode(stores.pool.query('UPDATE source_catalog_versions SET entry_count = 9')),
    ).toBe('23001');
    expect(await errorCode(stores.pool.query('DELETE FROM source_catalog_versions'))).toBe('23001');
    expect(await errorCode(stores.pool.query('TRUNCATE source_catalog_versions'))).toBe('23001');
  });
});

describe('PostgresRequestedResponseIncidentStore (ADR-0012 §6)', () => {
  it('guarda la incidencia una sola vez, en JCS, y solo invalid_source_frame', async () => {
    const incident = deriveRequestedResponseIncident(frame([], 40), 'catalog_empty');
    await stores.requestedResponses.append(incident);
    await stores.requestedResponses.append(incident);

    const { rows } = await stores.pool.query<{
      incident_jcs: string;
      observed_ref: string;
      reason: string;
    }>(
      `SELECT observed_ref::text AS observed_ref, reason, incident_jcs
         FROM requested_response_incidents`,
    );
    expect(rows).toEqual([
      {
        incident_jcs: canonicalJson(incident as JsonValue),
        observed_ref: uuid(40),
        reason: 'catalog_empty',
      },
    ]);

    const body = {
      evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
      incident_type: 'persistence_unavailable',
      observed_at_utc: '2026-03-02T10:00:00.000Z',
      observed_ref: uuid(41),
      quality_rule_version: '1.0.0',
      related_refs: [],
      schema_version: '1.0.0',
      severity: 'critical',
      source: DERIV_SOURCE,
      symbol: null,
    };
    const persistence = dataQualityIncidentSchema.parse({
      ...body,
      incident_id: deriveEventId(body),
    });
    await expect(stores.requestedResponses.append(persistence)).rejects.toThrow(
      /solo deja invalid_source_frame/u,
    );
    expect(
      await errorCode(stores.pool.query("UPDATE requested_response_incidents SET reason = 'x'")),
    ).toBe('23001');
    expect(await errorCode(stores.pool.query('DELETE FROM requested_response_incidents'))).toBe(
      '23001',
    );
  });
});

describe('SourceLock (ADR-0012 §9)', () => {
  /** Backend que tiene el bloqueo de la fuente según `pg_locks`, o `null`. */
  async function holder(source: string): Promise<number | null> {
    const key = BigInt.asUintN(64, BigInt(sourceLockKey(source)));
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid = $1::bigint::oid AND objid = $2::bigint::oid`,
      [(key >> 32n).toString(), (key & 0xffff_ffffn).toString()],
    );
    return rows[0]?.pid ?? null;
  }

  it('una sola instancia por fuente: la segunda no arranca hasta que la primera suelta', async () => {
    const first = await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE });
    expect(first?.held).toBe(true);
    expect(await holder(DERIV_SOURCE)).not.toBeNull();
    expect(
      await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE }),
    ).toBeNull();

    const other = await SourceLock.acquire({ postgres: config.postgres, source: 'synthetic' });
    expect(other?.held).toBe(true);
    await other?.release();

    await first?.release();
    expect(await holder(DERIV_SOURCE)).toBeNull();
    const second = await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE });
    expect(second?.held).toBe(true);
    await second?.release();
  });

  it('si su sesión se pierde, el log deja de escribir y otro proceso puede tomarlo', async () => {
    const lock = await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE });
    if (lock === null) {
      throw new TypeError('No se tomó el bloqueo.');
    }
    const pid = await holder(DERIV_SOURCE);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    for (let attempt = 0; attempt < 50 && lock.held; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(lock.held).toBe(false);

    const guarded = lockedSourceLogStore(stores.sourceLog, lock);
    expect(
      await errorCode(
        guarded.insertIndexRow({
          byte_length: 10,
          event_id: uuid(50),
          event_time_utc: '2026-03-02T10:00:00.000Z',
          kind: 'connection_opened',
          object_sha256: '0'.repeat(64),
          position: 0,
          segment_index: 0,
          source: DERIV_SOURCE,
        }),
      ),
    ).toBe(SOURCE_LOCK_LOST);
    expect(
      (
        await stores.pool.query('SELECT 1 FROM source_event_index WHERE source = $1', [
          DERIV_SOURCE,
        ])
      ).rowCount,
    ).toBe(0);

    const next = await SourceLock.acquire({ postgres: config.postgres, source: DERIV_SOURCE });
    expect(next?.held).toBe(true);
    await next?.release();
    await lock.release();
  });
});
