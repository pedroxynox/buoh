import {
  canonicalJson,
  connectionClosedSchema,
  connectionOpenedSchema,
  sha256Hex,
  sourceEventSchema,
  type LiveDerivationCheckpoint,
  type SourceEvent,
} from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
  liveCheckpointDigests,
} from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { buildRawSourceFrame } from '../src/ingestion/raw-first-ingestor.js';
import { contentKey } from '../src/object-keys.js';
import { type OperationalAlert } from '../src/operational/registry.js';
import { lockedSourceLogStore } from '../src/postgres/source-lock.js';
import {
  checkpointRow,
  checkStoredCheckpoint,
  LiveCheckpointWriter,
  liveCheckpointVersionsSha256,
  type LiveCheckpointFailure,
} from '../src/source-log/live-checkpoint.js';
import { type LiveCheckpointCandidate } from '../src/source-log/ports.js';
import { SourceEventLog } from '../src/source-log/source-event-log.js';
import { START_EPOCH, syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages } from './support/deriv-fixtures.js';
import { MemoryObjectStore, MemorySourceLogStore } from './support/memory-stores.js';

// El punto de control del estado vivo en el log (ADR-0017 §5 y §6): su fila, las comprobaciones de
// quien lo lee y quien lo escribe. Almacenes en memoria, IDs secuenciales y un esquema de fuente
// sintético; ningún precio es de mercado.

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida.');
  });
}

beforeEach(() => {
  forbidAmbientEffects();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SYMBOL = 'SYNTH_100';
const WRITTEN_AT = '2026-03-02T12:00:00.000Z';
const profile = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });

const at = (epoch: number, ms = 0) => new Date(epoch * 1000 + ms).toISOString();

/** La conexión número `n` del log, desde 0. */
const connection = (n: number) => uuid(5000 + n);

/**
 * El segmento `n` de un log sintético: la conexión `n`, que supera a la anterior, con dos ticks y su
 * cierre remoto, que deja pendiente la continuidad. IDs desde `100 · (n + 1)`.
 */
function segmentEvents(n: number): SourceEvent[] {
  const base = 100 * (n + 1);
  const epoch = START_EPOCH + 60 * n;
  return [
    connectionOpenedSchema.parse({
      connection_id: connection(n),
      event_id: uuid(base),
      kind: 'connection_opened',
      occurred_at_utc: at(epoch - 1),
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: n === 0 ? null : connection(n - 1),
    }),
    ...[0, 1].map((offset) =>
      buildRawSourceFrame(
        {
          connection_id: connection(n),
          observation_id: uuid(base + 1 + offset),
          payload_utf8: derivMessages.tick(2, epoch + offset, `100.${String(25 + offset)}`),
          received_at_utc: at(epoch + offset, 100),
        },
        profile,
      ),
    ),
    connectionClosedSchema.parse({
      affected_symbols: [SYMBOL],
      closure_type: 'remote',
      connection_id: connection(n),
      event_id: uuid(base + 3),
      kind: 'connection_closed',
      occurred_at_utc: at(epoch + 2),
      reason: 'close_code_1001',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    }),
  ];
}

/** Un log en memoria; `close` añade y cierra un segmento. */
async function memoryLog() {
  const objects = new MemoryObjectStore();
  const store = new MemorySourceLogStore();
  const open = (lock?: { readonly held: boolean }) =>
    SourceEventLog.open({
      objects,
      source: DERIV_SOURCE,
      store:
        lock === undefined
          ? store
          : lockedSourceLogStore(store, {
              get held() {
                return lock.held;
              },
              source: DERIV_SOURCE,
            }),
      zlibVersion: 'test',
    });
  const log = await open();
  const segments: SourceEvent[][] = [];
  const close = async (events: readonly SourceEvent[]) => {
    for (const event of events) {
      await log.append(event);
    }
    const segment = await log.close('requested');
    if (segment === null) {
      throw new TypeError('El segmento no se cerró.');
    }
    segments.push([...events]);
    return segment;
  };
  return { close, log, objects, open, segments, store };
}

/** El punto de control del segmento `k`: el pliegue del log entero, desde el vacío, hasta él. */
function expectedCheckpoint(
  segments: readonly (readonly SourceEvent[])[],
  k: number,
  logicalSha256: string,
): LiveDerivationCheckpoint {
  const events = segments.slice(0, k + 1).flat();
  return buildLiveDerivationCheckpoint({
    event_count: events.length,
    profile,
    raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
    segment_index: k,
    segment_logical_content_sha256: logicalSha256,
    state: foldLiveDerivation(emptyLiveDerivationState(), events, profile),
    symbol: SYMBOL,
  });
}

/** Los puntos de control guardados, como los escribió el log de `run`. */
type MemoryLog = Awaited<ReturnType<typeof memoryLog>>;

const expectedRows = (run: MemoryLog, indexes: readonly number[]) =>
  indexes.map((k) =>
    checkpointRow(
      expectedCheckpoint(run.segments, k, run.store.closed[k]?.logical_content_sha256 ?? ''),
      WRITTEN_AT,
    ),
  );

function writerOf(log: () => SourceEventLog) {
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const failures: LiveCheckpointFailure[] = [];
  const writer = new LiveCheckpointWriter({
    alert: (payload) => alerts.push(payload),
    log,
    now: () => WRITTEN_AT,
    onFailure: (failure) => failures.push(failure),
    profile,
    symbol: SYMBOL,
  });
  return { alerts, failures, writer };
}

/** Un resultado `unavailable` que no cubre exactamente el hueco pendiente (ADR-0017 §3). */
function unavailableOfAnotherRange(n: number): SourceEvent {
  const epoch = START_EPOCH + 60 * n;
  return sourceEventSchema.parse({
    connection_id: connection(n),
    event_id: uuid(100 * (n + 1) + 50),
    from_event_time_utc: at(epoch - 59, 1),
    kind: 'history_recovery_result',
    occurred_at_utc: at(epoch + 1, 500),
    reason: 'history_timeout',
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    status: 'unavailable',
    symbol: SYMBOL,
    to_event_time_utc: at(epoch - 30),
  });
}

describe('la fila de un punto de control (migración 0005)', () => {
  it('lleva cada campo del enlace y de las versiones en su columna, el punto de control entero en JCS y sus SHA-256', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    const checkpoint = expectedCheckpoint(
      run.segments,
      0,
      run.store.closed[0]?.logical_content_sha256 ?? '',
    );
    const row = checkpointRow(checkpoint, WRITTEN_AT);
    const digests = liveCheckpointDigests(checkpoint);

    expect(JSON.parse(row.checkpoint_jcs)).toEqual(checkpoint);
    expect(row).toMatchObject({
      ...checkpoint.versions,
      checkpoint_sha256: digests.checkpoint_sha256,
      event_count: 4,
      raw_frame_count: 2,
      schema_version: '1.0.0',
      segment_index: 0,
      segment_logical_content_sha256: run.store.closed[0]?.logical_content_sha256,
      source: DERIV_SOURCE,
      symbol: SYMBOL,
      versions_sha256: digests.versions_sha256,
      written_at_utc: WRITTEN_AT,
    });
    expect(liveCheckpointVersionsSha256(profile)).toBe(digests.versions_sha256);
  });
});

describe('checkStoredCheckpoint (ADR-0017 §6)', () => {
  async function candidateOf() {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    const closed = run.store.closed[0];
    if (closed === undefined) {
      throw new TypeError('Falta el segmento 0.');
    }
    const checkpoint = expectedCheckpoint(run.segments, 0, closed.logical_content_sha256);
    const candidate: LiveCheckpointCandidate = {
      binding: {
        event_count: closed.event_count,
        logical_content_sha256: closed.logical_content_sha256,
        raw_frame_count: closed.raw_frame_count,
      },
      row: checkpointRow(checkpoint, WRITTEN_AT),
    };
    return { candidate, checkpoint };
  }

  const expected = {
    source: DERIV_SOURCE,
    symbol: SYMBOL,
    versions_sha256: liveCheckpointVersionsSha256(profile),
  };

  it('acepta el que se escribió con su enlace, y da el punto de control', async () => {
    const { candidate, checkpoint } = await candidateOf();
    expect(checkStoredCheckpoint(candidate, expected)).toEqual({ checkpoint, status: 'valid' });
  });

  it('rechaza con checkpoint_digest_mismatch un JCS que no es el de un punto de control válido, con su SHA-256 y sus columnas', async () => {
    const { candidate, checkpoint } = await candidateOf();
    const { row } = candidate;
    const pretty = JSON.stringify(checkpoint, null, 2);
    const withSha = (jcs: string) => ({ checkpoint_jcs: jcs, checkpoint_sha256: sha256Hex(jcs) });
    const otherVersions = {
      ...checkpoint,
      versions: { ...checkpoint.versions, live_state_version: '9.9.9' },
    };
    const cases = [
      { checkpoint_sha256: 'f'.repeat(64) },
      { checkpoint_jcs: pretty },
      { checkpoint_jcs: '{', checkpoint_sha256: row.checkpoint_sha256 },
      withSha('{}'),
      { event_count: row.event_count + 1 },
      { segment_logical_content_sha256: 'e'.repeat(64) },
      // Las versiones del JCS no son las de su SHA-256.
      withSha(canonicalJson(otherVersions)),
    ];
    for (const change of cases) {
      expect(checkStoredCheckpoint({ ...candidate, row: { ...row, ...change } }, expected)).toEqual(
        {
          reason: 'checkpoint_digest_mismatch',
          status: 'rejected',
        },
      );
    }
  });

  it('rechaza con checkpoint_identity_mismatch uno de otro símbolo o de otra fuente', async () => {
    const { candidate } = await candidateOf();
    for (const other of [
      { ...expected, symbol: 'SYNTH_50' },
      { ...expected, source: 'otra_fuente' },
    ]) {
      expect(checkStoredCheckpoint(candidate, other)).toEqual({
        reason: 'checkpoint_identity_mismatch',
        status: 'rejected',
      });
    }
  });

  it('rechaza con checkpoint_binding_mismatch uno cuyo segmento no está cerrado, tiene otro hash lógico u otras sumas', async () => {
    const { candidate } = await candidateOf();
    const { binding } = candidate;
    for (const change of [
      { logical_content_sha256: null },
      { logical_content_sha256: 'e'.repeat(64) },
      { event_count: binding.event_count + 1 },
      { raw_frame_count: binding.raw_frame_count - 1 },
    ]) {
      expect(
        checkStoredCheckpoint({ ...candidate, binding: { ...binding, ...change } }, expected),
      ).toEqual({
        reason: 'checkpoint_binding_mismatch',
        status: 'rejected',
      });
    }
  });

  it('la integridad va antes que el enlace, y uno de otras versiones es un error del almacén', async () => {
    const { candidate } = await candidateOf();
    expect(
      checkStoredCheckpoint(
        {
          binding: { ...candidate.binding, logical_content_sha256: null },
          row: { ...candidate.row, checkpoint_sha256: 'f'.repeat(64) },
        },
        expected,
      ),
    ).toMatchObject({ reason: 'checkpoint_digest_mismatch' });
    expect(() =>
      checkStoredCheckpoint(candidate, { ...expected, versions_sha256: 'b'.repeat(64) }),
    ).toThrow(TypeError);
  });
});

describe('LiveCheckpointWriter (ADR-0017 §5 y §6)', () => {
  it('rebuild reconstruye por partes desde el log vacío: un punto de control por segmento cerrado, el pliegue del log entero hasta él', async () => {
    const run = await memoryLog();
    for (const n of [0, 1, 2]) {
      await run.close(segmentEvents(n));
    }
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();

    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1, 2]));
    expect(alerts).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('con cada cierre escribe los que faltan hasta él desde el último escrito, también los cierres que no recibió', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    const { alerts, writer } = writerOf(() => run.log);
    await writer.rebuild();
    await run.close(segmentEvents(1));
    // El cierre del segmento 1 no le llega; el del 2, sí.
    writer.onClosed(await run.close(segmentEvents(2)));
    await writer.settle();

    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1, 2]));
    expect(alerts).toEqual([]);
  });

  it('parte del último válido de sus versiones: avisa de cada rechazado, no lo reescribe y lo supera el siguiente, y no ve los de otras versiones', async () => {
    const run = await memoryLog();
    for (const n of [0, 1, 2, 3]) {
      await run.close(segmentEvents(n));
    }
    const [first, second, third, fourth] = expectedRows(run, [0, 1, 2, 3]);
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new TypeError('Faltan filas.');
    }
    // El 1 de otro símbolo, el 2 con su JCS alterado, el 3 enlazado con otro hash lógico y otro del
    // 3 de otras versiones.
    const otherSymbol = checkpointRow(
      {
        ...expectedCheckpoint(run.segments, 1, second.segment_logical_content_sha256),
        symbol: 'SYNTH_50',
      },
      WRITTEN_AT,
    );
    const misbound = checkpointRow(expectedCheckpoint(run.segments, 3, 'e'.repeat(64)), WRITTEN_AT);
    const other = expectedCheckpoint(run.segments, 3, fourth.segment_logical_content_sha256);
    const otherVersions = checkpointRow(
      { ...other, versions: { ...other.versions, live_state_version: '9.9.9' } },
      WRITTEN_AT,
    );
    for (const row of [
      first,
      otherSymbol,
      { ...third, checkpoint_sha256: 'f'.repeat(64) },
      misbound,
      otherVersions,
    ]) {
      await run.store.insertLiveCheckpoint(row);
    }
    const stored = [...run.store.checkpoints];
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();

    expect(alerts).toEqual([
      { event: 'checkpoint_rejected', reason: 'checkpoint_binding_mismatch', segment_index: '3' },
      { event: 'checkpoint_rejected', reason: 'checkpoint_digest_mismatch', segment_index: '2' },
      { event: 'checkpoint_rejected', reason: 'checkpoint_identity_mismatch', segment_index: '1' },
    ]);
    expect(run.store.checkpoints).toEqual(stored);
    // El del segmento siguiente sale del pliegue del log entero, como si no hubiera ninguno.
    writer.onClosed(await run.close(segmentEvents(4)));
    await writer.settle();
    expect(run.store.checkpoints).toEqual([...stored, ...expectedRows(run, [4])]);
    expect(failures).toEqual([]);
  });

  it('si no puede guardar uno, avisa con checkpoint_unavailable y el motivo saneado, y el cierre siguiente lo vuelve a intentar desde el último escrito', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    await run.close(segmentEvents(1));
    run.store.failCheckpoint = (row) => row.segment_index === 1;
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();
    expect(run.store.checkpoints).toEqual(expectedRows(run, [0]));
    expect(alerts).toEqual([
      {
        event: 'checkpoint_unavailable',
        reason: 'synthetic_checkpoint_failure',
        segment_index: '1',
      },
    ]);

    run.store.failCheckpoint = () => false;
    writer.onClosed(await run.close(segmentEvents(2)));
    await writer.settle();
    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1, 2]));
    expect(alerts).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('una inserción ambigua cuenta como escrita al reintentarla: su clave ya tiene el mismo SHA-256', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    run.store.failCheckpointAfterInsert = (row) => row.segment_index === 0;
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();
    run.store.failCheckpointAfterInsert = () => false;
    writer.onClosed(await run.close(segmentEvents(1)));
    await writer.settle();

    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1]));
    expect(alerts).toEqual([
      {
        event: 'checkpoint_unavailable',
        reason: 'synthetic_checkpoint_ambiguous',
        segment_index: '0',
      },
    ]);
    expect(failures).toEqual([]);
  });

  it('con otro SHA-256 en la misma clave avisa con checkpoint_conflict, llama a onFailure una vez y ya no escribe más', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();
    // Otro escritor guardó ya otro punto de control del segmento 1, el siguiente que se cierra.
    await run.close(segmentEvents(1));
    const otherState = expectedCheckpoint(
      run.segments,
      1,
      run.store.closed[1]?.logical_content_sha256 ?? '',
    );
    await run.store.insertLiveCheckpoint(
      checkpointRow({ ...otherState, symbol: 'SYNTH_50' }, WRITTEN_AT),
    );
    writer.onClosed(run.store.closed[1] ?? (undefined as never));
    writer.onClosed(await run.close(segmentEvents(2)));
    await writer.settle();

    expect(alerts).toEqual([{ event: 'checkpoint_conflict', segment_index: '1' }]);
    expect(failures).toEqual([
      expect.objectContaining({ reason: 'checkpoint_conflict', segment_index: 1 }),
    ]);
    expect(writer.failure).toBe(failures[0]);
    expect(run.store.checkpoints.map((row) => row.segment_index)).toEqual([0, 1]);
  });

  it('si el pliegue falla, llama a onFailure con log_not_derivable y no escribe nada después', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    await run.close([...segmentEvents(1).slice(0, 2), unavailableOfAnotherRange(1)]);
    await run.close(segmentEvents(2));
    const { failures, writer } = writerOf(() => run.log);
    await writer.rebuild();

    expect(run.store.checkpoints).toEqual(expectedRows(run, [0]));
    expect(failures).toEqual([
      expect.objectContaining({ reason: 'log_not_derivable', segment_index: 1 }),
    ]);
    expect(failures[0]?.error).toBeInstanceOf(TypeError);
  });

  it('un segmento cerrado que no pasa sus comprobaciones al leerlo da log_not_derivable', async () => {
    const run = await memoryLog();
    const segment = await run.close(segmentEvents(0));
    run.objects.objects.set(contentKey(segment.object_bytes_sha256), new Uint8Array([1, 2, 3]));
    const { failures, writer } = writerOf(() => run.log);
    await writer.rebuild();

    expect(run.store.checkpoints).toEqual([]);
    expect(failures).toEqual([
      expect.objectContaining({ reason: 'log_not_derivable', segment_index: 0 }),
    ]);
  });

  it('si un almacén no responde al leer un segmento o los puntos de control guardados, avisa con checkpoint_unavailable y lo vuelve a intentar con el cierre siguiente', async () => {
    const run = await memoryLog();
    const segment = await run.close(segmentEvents(0));
    const key = contentKey(segment.object_bytes_sha256);
    run.objects.onRead = (read, bytes) => {
      if (read === key) {
        throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
      }
      return bytes;
    };
    run.store.failCheckpointReads = true;
    const { alerts, failures, writer } = writerOf(() => run.log);
    await writer.rebuild();
    run.store.failCheckpointReads = false;
    writer.onClosed(await run.close(segmentEvents(1)));
    await writer.settle();
    run.objects.onRead = (_read, bytes) => bytes;
    writer.onClosed(await run.close(segmentEvents(2)));
    await writer.settle();

    expect(alerts).toEqual([
      { event: 'checkpoint_unavailable', reason: 'ECONNREFUSED' },
      { event: 'checkpoint_unavailable', reason: 'ECONNREFUSED', segment_index: '0' },
    ]);
    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1, 2]));
    expect(failures).toEqual([]);
  });

  it('escribe con el log protegido por el bloqueo: sin él, avisa con source_lock_lost y no escribe', async () => {
    const run = await memoryLog();
    await run.close(segmentEvents(0));
    const lock = { held: false };
    const locked = await run.open(lock);
    const { alerts, writer } = writerOf(() => locked);
    await writer.rebuild();
    expect(alerts).toEqual([
      { event: 'checkpoint_unavailable', reason: 'source_lock_lost', segment_index: '0' },
    ]);
    expect(run.store.checkpoints).toEqual([]);
    lock.held = true;
    writer.onClosed(await run.close(segmentEvents(1)));
    await writer.settle();
    expect(run.store.checkpoints).toEqual(expectedRows(run, [0, 1]));
  });

  it('un error de programación llama a onFailure con unexpected y la cola no se rechaza', async () => {
    const bug = new TypeError('sintético');
    const { failures, writer } = writerOf(() => {
      throw bug;
    });
    await writer.rebuild();
    expect(failures).toEqual([{ error: bug, reason: 'unexpected', segment_index: null }]);
  });
});
