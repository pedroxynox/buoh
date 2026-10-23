import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { type SourceEvent } from '@buoh/contracts';
import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contentKey,
  createPool,
  driveSyntheticStimuli,
  loadConfig,
  loadSyntheticFixture,
  migrate,
  openStores,
  OperationalRegistry,
  publishFromLog,
  RawFirstIngestor,
  replayDataset,
  SourceEventLog,
  type ObjectStore,
  type SyntheticFixture,
} from '../src/index.js';

/**
 * Integración del log raw-first (F1-STREAM-001) y del registro operativo contra PostgreSQL y
 * S3-compatible locales. Esquema PostgreSQL propio, recreado en cada ejecución; IDs y tiempos del
 * pipeline inyectados.
 */
const SCHEMA = 'buoh_integration_log';
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const MAIN_DATASET_ID = 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd';
const ZERO_DATASET_ID = 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f';
const DETECTED_AT = '2026-01-01T00:00:30.000Z';

const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
let stores: ReturnType<typeof openStores>;
let admin: Pool;
let fixture: SyntheticFixture;
let applied: string[];

/** Envoltorio que hace fallar la siguiente escritura de objeto, como el estímulo del vector. */
class ArmableObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly #inner: ObjectStore;
  #armed: string | null = null;

  constructor(inner: ObjectStore) {
    this.#inner = inner;
    this.bucket = inner.bucket;
  }

  arm(reason: string): void {
    this.#armed = reason;
  }

  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'> {
    const armed = this.#armed;
    if (armed !== null) {
      this.#armed = null;
      return Promise.reject(Object.assign(new Error('Fallo armado'), { code: armed }));
    }
    return this.#inner.putIfAbsent(key, bytes, contentType);
  }

  get(key: string, maxBytes: number): Promise<Uint8Array> {
    return this.#inner.get(key, maxBytes);
  }
}

let objects: ArmableObjectStore;
let counter = 9000;

function id(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

const openLog = () =>
  SourceEventLog.open({
    objects,
    source: 'synthetic',
    store: stores.sourceLog,
    zlibVersion: process.versions.zlib,
  });

async function newIngestor() {
  return new RawFirstIngestor({
    log: await openLog(),
    nextId: () => id((counter += 1)),
    now: () => DETECTED_AT,
    profile: fixture.profile,
    registry: await OperationalRegistry.open({ source: 'synthetic', store: stores.operational }),
    reopenLog: openLog,
    sink: { invalidFrame: () => undefined, tick: () => undefined },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

beforeAll(async () => {
  const config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  objects = new ArmableObjectStore(stores.objects);
  applied = (await migrate(stores.pool)).applied;
  fixture = await loadSyntheticFixture(vectorRoot);
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

describe('integración del log raw-first y el registro operativo', () => {
  it('aplica las dos migraciones', () => {
    expect(applied).toEqual(['0001_publicaciones.sql', '0002_log_raw_first.sql']);
  });

  it('los vectores pasan por el log real y se publican con sus dataset_id', async () => {
    const ingestor = await newIngestor();
    for (const scenario of fixture.scenarios) {
      await driveSyntheticStimuli(ingestor, scenario.stimuli, 'synthetic');
      await ingestor.rotate('requested');
    }
    expect(ingestor.state).toBe('accepting');

    const closed = await stores.sourceLog.listClosedSegments('synthetic', 0, 10);
    const files = [
      'expected-source-events-000000.ndjson',
      'expected-source-events-000001.ndjson',
      'zero-valid-ticks/expected-source-events.ndjson',
    ];
    expect(closed).toHaveLength(files.length);
    for (const [index, segment] of closed.entries()) {
      const physical = await stores.objects.get(
        contentKey(segment.object_bytes_sha256),
        segment.object_size_bytes,
      );
      expect(
        Buffer.from(gunzipSync(physical)).equals(
          readFileSync(resolve(vectorRoot, files[index] ?? '')),
        ),
      ).toBe(true);
    }

    for (const [from, to, datasetId, publicationId] of [
      [0, 1, MAIN_DATASET_ID, '019b76da-cb28-7003-8000-000000000201'],
      [2, 2, ZERO_DATASET_ID, '019b76da-cb28-7003-8000-000000000202'],
    ] as const) {
      const publication = await publishFromLog({
        environment: 'test',
        fromSegment: from,
        log: ingestor.log,
        metadata: stores.metadata,
        objects: stores.objects,
        profile: fixture.profile,
        publication_id: publicationId,
        published_at_utc: '2026-01-01T00:00:09.000Z',
        toSegment: to,
        zlibVersion: process.versions.zlib,
      });
      expect(publication.dataset_id).toBe(datasetId);
      const report = await replayDataset({
        datasetId,
        environment: 'test',
        metadata: stores.metadata,
        mode: 'recompute',
        objects: stores.objects,
      });
      expect(report.status).toBe('reproduced');
    }
  });

  it('un reinicio continúa desde el estado durable en PostgreSQL', async () => {
    const log = await openLog();
    expect(log.openSegmentIndex).toBe(3);
    expect(log.openSegmentStats.event_count).toBe(0);
    expect(log.totalEventCount).toBe(12);
  });

  it('un fallo de escritura raw queda en el registro operativo y un ConnectionOpened lo resuelve', async () => {
    const ingestor = await newIngestor();
    objects.arm('synthetic_injected_failure');
    const outcome = await ingestor.receiveFrame({
      connection_id: '019b76da-a800-7000-8000-00000000a000',
      observation_id: id(100),
      payload_utf8:
        '{"msg_type":"tick","tick":{"epoch":1767225630,"pip_size":3,"quote":100.125,"symbol":"SYNTH_100"}}',
      received_at_utc: '2026-01-01T00:00:30.100Z',
    });
    expect(outcome).toEqual({ stage: 'raw_object_write', status: 'not_durable' });

    const stored = await stores.pool.query<{ incident_jcs: string }>(
      'SELECT incident_jcs FROM operational_incidents',
    );
    expect(stored.rows.map((row) => JSON.parse(row.incident_jcs) as unknown)).toMatchObject([
      {
        evidence: { reason: 'synthetic_injected_failure', stage: 'raw_object_write' },
        observed_ref: id(100),
        severity: 'critical',
      },
    ]);
    expect(
      (
        await OperationalRegistry.open({ source: 'synthetic', store: stores.operational })
      ).openConditionTypes(),
    ).toEqual(['persistence_unavailable']);

    const reopened: Exclude<SourceEvent, { kind: 'raw_source_frame' }> = {
      connection_id: '019b76da-a800-7000-8000-00000000b000',
      event_id: id(101),
      kind: 'connection_opened',
      occurred_at_utc: '2026-01-01T00:00:40.000Z',
      schema_version: '1.0.0',
      source: 'synthetic',
      supersedes_connection_id: '019b76da-a800-7000-8000-00000000a000',
    };
    expect((await ingestor.receiveEvent(reopened)).status).toBe('durable');
    expect(ingestor.state).toBe('accepting');
    const reloaded = await OperationalRegistry.open({
      source: 'synthetic',
      store: stores.operational,
    });
    expect(reloaded.openConditionTypes()).toEqual([]);
  });

  it('la base de datos impone contigüidad, segmentos cerrados y conteos', async () => {
    const row = (segment: number, position: number, eventId: string) => [
      'synthetic',
      segment,
      position,
      eventId,
      'raw_source_frame',
      '2026-01-01T00:00:00.000Z',
      'a'.repeat(64),
      10,
    ];
    const insert = `INSERT INTO source_event_index
      (source, segment_index, position, event_id, kind, event_time_utc, object_sha256, byte_length)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
    const intoClosed = await rejection(stores.pool.query(insert, row(0, 6, id(200))));
    const gap = await rejection(stores.pool.query(insert, row(3, 5, id(201))));
    const skip = await rejection(stores.pool.query(insert, row(5, 0, id(202))));
    for (const error of [intoClosed, gap, skip]) {
      expect((error as { code?: string }).code).toBe('23514');
    }
    const wrongCount = await rejection(
      stores.pool.query(
        `INSERT INTO closed_source_segments
          (source, segment_index, event_count, raw_frame_count, byte_count, logical_content_sha256,
           object_bytes_sha256, object_size_bytes, compression, writer_name, writer_version,
           close_reason, segment_policy_version, first_event_time_utc, last_event_time_utc)
         VALUES ('synthetic', 3, 99, 0, 10, $1, $1, 10, 'none', NULL, NULL, 'requested', '1.0.0',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ['b'.repeat(64)],
      ),
    );
    expect((wrongCount as { code?: string }).code).toBe('23514');
  });

  it.each([
    ['UPDATE', `UPDATE source_event_index SET byte_length = 1`],
    ['DELETE', 'DELETE FROM closed_source_segments'],
    ['TRUNCATE', 'TRUNCATE operational_incidents'],
    ['UPDATE', `UPDATE operational_conditions SET action = 'opened'`],
  ])('las tablas del log y del registro son append-only: %s se rechaza', async (_label, sql) => {
    const error = await rejection(stores.pool.query(sql));
    expect((error as { code?: string }).code).toBe('23001');
  });
});
