import { type Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { openSchemaArchive } from '../src/deriv/schema-archive.js';
import { SourceLockUnavailableError } from '../src/deriv/session.js';
import { sourceLockHolder } from '../src/postgres/source-lock.js';
import {
  lockedSourceLogStore,
  openLockedSourceLog,
  OperationalRegistry,
  PostgresSessionLockProvider,
  RawFirstIngestor,
  SOURCE_LOCK_LOST,
  SourceLock,
  sourceLockKey,
  SourceEventLog,
  type SourceEventIndexRow,
  type WorkerConfig,
} from '../src/index.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';
import {
  MemoryObjectStore,
  MemoryOperationalStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';

// Bloqueo por fuente (ADR-0012 §9), sin PostgreSQL: la clave y el log protegido. La prueba con una
// sesión real de PostgreSQL está en integration/catalog-and-lock.test.ts.
const START = '2026-03-02T10:00:00.000Z';

function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function row(source: string, position: number): SourceEventIndexRow {
  return {
    byte_length: 10,
    event_id: uuid(position + 1),
    event_time_utc: START,
    kind: 'connection_opened',
    object_sha256: '0'.repeat(64),
    position,
    segment_index: 0,
    source,
  };
}

async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'sin error',
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

describe('sourceLockKey', () => {
  it('es el SHA-256 de buoh:source-log:<fuente>, 8 bytes con signo', () => {
    // Calculado con hashlib de Python, fuera del código probado.
    expect(sourceLockKey('deriv_options')).toBe('-3598305319908194316');
    expect(sourceLockKey('synthetic')).toBe('2508138588543325748');
  });
});

describe('sourceLockHolder (ADR-0015 §8, «Escritor vivo»)', () => {
  /** Un pool que responde cada consulta con `rows` y anota su texto y sus valores. */
  function fakePool(rows: readonly { pid: number }[]) {
    const queries: { text: string; values: unknown }[] = [];
    const pool = {
      query: (text: string, values: unknown) => {
        queries.push({ text, values });
        return Promise.resolve({ rows });
      },
    } as unknown as Pick<Pool, 'query'>;
    return { pool, queries };
  }

  it('lee de pg_locks el bloqueo concedido de la fuente en la base actual, con los 32 bits altos y bajos de la clave, y da el PID de su sesión', async () => {
    const { pool, queries } = fakePool([{ pid: 4242 }]);
    expect(await sourceLockHolder(pool, 'deriv_options')).toBe(4242);
    expect(await sourceLockHolder(pool, 'synthetic')).toBe(4242);
    // Las dos mitades de la clave como enteros sin signo, calculadas con hashlib de Python, fuera
    // del código probado.
    expect(queries.map((query) => query.values)).toEqual([
      ['3457171552', '1299793908'],
      ['583971521', '4052948532'],
    ]);
    const [first] = queries;
    expect(first?.text).toMatch(/^SELECT pid FROM pg_locks\b/u);
    for (const condition of [
      /locktype = 'advisory'/u,
      /\bgranted\b/u,
      /objsubid = 1/u,
      /classid = \$1::bigint::oid/u,
      /objid = \$2::bigint::oid/u,
      /database = \(SELECT oid FROM pg_database WHERE datname = current_database\(\)\)/u,
    ]) {
      expect(first?.text).toMatch(condition);
    }
  });

  it('sin una sesión que tenga el bloqueo da null', async () => {
    expect(await sourceLockHolder(fakePool([]).pool, 'deriv_options')).toBeNull();
  });
});

describe('lockedSourceLogStore', () => {
  it('escribe mientras el bloqueo sigue tomado y deja de escribir cuando se pierde', async () => {
    const inner = new MemorySourceLogStore();
    const lock = { held: true, source: DERIV_SOURCE };
    const store = lockedSourceLogStore(inner, lock);

    await store.insertIndexRow(row(DERIV_SOURCE, 0));
    expect(inner.rows).toHaveLength(1);

    lock.held = false;
    expect(await rejectionCode(store.insertIndexRow(row(DERIV_SOURCE, 1)))).toBe(SOURCE_LOCK_LOST);
    expect(
      await rejectionCode(
        store.insertClosedSegment({
          byte_count: 10,
          close_reason: 'requested',
          compression: 'none',
          event_count: 1,
          first_event_time_utc: START,
          last_event_time_utc: START,
          logical_content_sha256: '0'.repeat(64),
          object_bytes_sha256: '0'.repeat(64),
          object_size_bytes: 10,
          raw_frame_count: 0,
          segment_index: 0,
          segment_policy_version: '1.0.0',
          source: DERIV_SOURCE,
          writer_name: null,
          writer_version: null,
        }),
      ),
    ).toBe(SOURCE_LOCK_LOST);
    expect(inner.rows).toHaveLength(1);
    expect(inner.closed).toEqual([]);
    // Leer no necesita el bloqueo.
    expect((await store.readLogState(DERIV_SOURCE)).totalEventCount).toBe(1);
    expect(await store.listClosedSegments(DERIV_SOURCE, 0, 0)).toEqual([]);
  });

  it('no escribe el log de otra fuente', async () => {
    const store = lockedSourceLogStore(new MemorySourceLogStore(), {
      held: true,
      source: DERIV_SOURCE,
    });
    await expect(store.insertIndexRow(row('synthetic', 0))).rejects.toThrow(TypeError);
  });

  it('sin el bloqueo, el ingestor pausa por persistencia y no reabre hasta tenerlo', async () => {
    const fixture = syntheticSchemaArchive();
    const loaded = openSchemaArchive(fixture.archive, fixture.expected);
    if (loaded.status !== 'loaded') {
      throw new TypeError(loaded.reason);
    }
    const objects = new MemoryObjectStore();
    const inner = new MemorySourceLogStore();
    const operational = new MemoryOperationalStore();
    const lock = { held: true, source: DERIV_SOURCE };
    const openLog = () =>
      SourceEventLog.open({
        objects,
        source: DERIV_SOURCE,
        store: lockedSourceLogStore(inner, lock),
        zlibVersion: 'test',
      });
    let sequence = 100;
    const ingestor = new RawFirstIngestor({
      log: await openLog(),
      nextId: () => uuid((sequence += 1)),
      now: () => START,
      profile: createDerivMeasurementProfile({ schemas: loaded.schemas, symbol: 'SYNTH_100' }),
      registry: await OperationalRegistry.open({ source: DERIV_SOURCE, store: operational }),
      reopenLog: openLog,
      sink: { invalidFrame: () => undefined, tick: () => undefined },
    });

    lock.held = false;
    const outcome = await ingestor.receiveFrame({
      connection_id: uuid(1),
      observation_id: uuid(2),
      payload_utf8: '{"msg_type":"ping"}',
      received_at_utc: START,
    });
    expect(outcome).toEqual({ stage: 'source_event_index', status: 'not_durable' });
    expect(ingestor.state).toBe('paused');
    expect(operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: SOURCE_LOCK_LOST, stage: 'source_event_index' },
        incident_type: 'persistence_unavailable',
      }),
    ]);

    // Un ConnectionOpened no reabre la entrada mientras falte el bloqueo.
    const reopened = await ingestor.receiveEvent({
      connection_id: uuid(3),
      event_id: uuid(4),
      kind: 'connection_opened',
      occurred_at_utc: '2026-03-02T10:00:01.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    });
    expect(reopened.status).toBe('not_durable');
    expect(ingestor.state).toBe('paused');
    expect(inner.rows).toEqual([]);
  });
});

describe('PostgresSessionLockProvider', () => {
  // Sin PostgreSQL: `SourceLock.acquire` sustituido. La prueba con PostgreSQL real está en
  // integration/ingestion-status.test.ts.
  const postgres: WorkerConfig['postgres'] = {
    database: 'buoh',
    host: '127.0.0.1',
    password: 'sintético',
    port: 5432,
    schema: 'buoh_test',
    user: 'buoh',
  };

  it('toma el bloqueo de su fuente con SourceLock.acquire y lo devuelve tal cual, o null', async () => {
    const lock = { backendPid: 4242, held: true, source: DERIV_SOURCE } as unknown as SourceLock;
    const acquire = vi
      .spyOn(SourceLock, 'acquire')
      .mockResolvedValueOnce(lock)
      .mockResolvedValueOnce(null);
    const provider = new PostgresSessionLockProvider({ postgres, source: DERIV_SOURCE });

    expect(await provider.acquire()).toBe(lock);
    expect(await provider.acquire()).toBeNull();
    expect(acquire.mock.calls).toEqual([
      [{ postgres, source: DERIV_SOURCE }],
      [{ postgres, source: DERIV_SOURCE }],
    ]);
  });

  it('si PostgreSQL no responde, lanza SourceLockUnavailableError con la causa saneada', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 rol buoh'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(SourceLock, 'acquire').mockRejectedValueOnce(cause);
    const provider = new PostgresSessionLockProvider({ postgres, source: DERIV_SOURCE });

    const error = await provider.acquire().then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(SourceLockUnavailableError);
    expect((error as SourceLockUnavailableError).reason).toBe('ECONNREFUSED');
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).not.toContain('127.0.0.1');
  });

  it('un error sin código, como el tiempo de conexión vencido de pg, también es no disponible', async () => {
    vi.spyOn(SourceLock, 'acquire').mockRejectedValueOnce(
      new Error('Connection terminated due to connection timeout'),
    );
    const provider = new PostgresSessionLockProvider({ postgres, source: DERIV_SOURCE });
    await expect(provider.acquire()).rejects.toMatchObject({
      name: 'SourceLockUnavailableError',
      reason: 'Error',
    });
  });
});

describe('openLockedSourceLog', () => {
  it('solo abre el log con un SourceLock: un bloqueo en memoria se rechaza sin leer el log', async () => {
    const store = new MemorySourceLogStore();
    const readLogState = vi.spyOn(store, 'readLogState');
    await expect(
      openLockedSourceLog(
        { held: true, release: () => Promise.resolve() },
        { objects: new MemoryObjectStore(), source: DERIV_SOURCE, store, zlibVersion: 'test' },
      ),
    ).rejects.toThrow(TypeError);
    expect(readLogState).not.toHaveBeenCalled();
  });
});
