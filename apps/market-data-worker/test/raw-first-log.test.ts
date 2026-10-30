import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  canonicalJson,
  connectionClosedSchema,
  connectionOpenedSchema,
  rawSourceFrameSchema,
  sha256Hex,
  sourceEventSchema,
  validateConditionCausality,
  type ConnectionClosed,
  type ConnectionOpened,
  type MarketTick,
  type RawSourceFrame,
  type SourceEvent,
} from '@buoh/contracts';
import {
  createPipelineProfile,
  ndjsonBytes,
  prettyCanonicalJson,
  type InvalidFrameReason,
  type PipelineProfile,
  type UnflaggedTick,
} from '@buoh/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contentKey,
  driveSyntheticStimuli,
  failureReason,
  loadSyntheticFixture,
  LogIntegrityError,
  LogPersistenceError,
  LogReadError,
  OperationalRegistry,
  previousConnection,
  publishFromLog,
  RawFirstIngestor,
  replayDataset,
  SourceEventLog,
  type ClosedSourceSegment,
  type OperationalAlert,
  type SyntheticFixture,
} from '../src/index.js';
import {
  MemoryMetadataStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';

// Casos derivados de F1-STREAM-001 (plan F1 §6), ADR-0004 §7/§12, ADR-0005 §4–§6, contratos
// «Registro operativo de persistencia y límites» y el oráculo test-vectors/market-data/v1.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const MAIN_DATASET_ID = 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd';
const ZERO_DATASET_ID = 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f';
const DETECTED_AT = '2026-01-01T00:00:10.000Z';
const CONNECTION_A = '019b76da-a800-7000-8000-00000000a000';
const CONNECTION_B = '019b76da-a800-7000-8000-00000000b000';

function id(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function readVector(path: string): Buffer {
  return readFileSync(resolve(vectorRoot, path));
}

function readNdjson(path: string): unknown[] {
  const text = readVector(path).toString('utf8');
  return text.length === 0
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
}

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let fixture: SyntheticFixture;

beforeAll(async () => {
  fixture = await loadSyntheticFixture(vectorRoot);
});

function tickPayload(epoch: number): string {
  return `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":100.125,"symbol":"SYNTH_100"}}`;
}

/** Almacenes en memoria, log, registro e ingestor conectados como en runtime. */
async function harness(
  options: {
    /** Reloj del ingestor; por defecto, fijo en `DETECTED_AT`. */
    now?: () => string;
    /** Recibe cada source event que el ingestor hizo durable; por defecto, ninguno. */
    onDurable?: (event: SourceEvent) => void;
    /** Recibe cada segmento que el ingestor cerró de forma durable; por defecto, ninguno. */
    onSegmentClosed?: (segment: ClosedSourceSegment) => void;
    operational?: MemoryOperationalStore;
    profile?: PipelineProfile;
  } = {},
) {
  const profile = options.profile ?? fixture.profile;
  const objects = new MemoryObjectStore();
  const sourceLog = new MemorySourceLogStore();
  const operational = options.operational ?? new MemoryOperationalStore();
  const metadata = new MemoryMetadataStore();
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const ticks: UnflaggedTick[] = [];
  const invalid: { observation_id: string; reason: InvalidFrameReason }[] = [];
  const nonTick: { msg_type: string; observation_id: string }[] = [];
  let counter = 9000;
  const openLog = () =>
    SourceEventLog.open({
      objects,
      source: 'synthetic',
      store: sourceLog,
      zlibVersion: 'test-zlib',
    });
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: 'synthetic',
    store: operational,
  });
  const ingestor = new RawFirstIngestor({
    log: await openLog(),
    nextId: () => id((counter += 1)),
    now: options.now ?? (() => DETECTED_AT),
    ...(options.onDurable === undefined ? {} : { onDurable: options.onDurable }),
    ...(options.onSegmentClosed === undefined ? {} : { onSegmentClosed: options.onSegmentClosed }),
    profile,
    registry,
    reopenLog: openLog,
    sink: {
      invalidFrame: (item) => invalid.push(item),
      nonTickFrame: (item) => nonTick.push(item),
      tick: (tick) => ticks.push(tick),
    },
  });
  return {
    alerts,
    ingestor,
    invalid,
    metadata,
    nonTick,
    objects,
    openLog,
    operational,
    registry,
    sourceLog,
    ticks,
  };
}

function stripFlags(tick: MarketTick): UnflaggedTick {
  const copy: Record<string, unknown> = { ...tick };
  delete copy['quality_flags'];
  return copy as unknown as UnflaggedTick;
}

const connectionOpened = (eventId: string, occurredAt: string): SourceEvent => ({
  connection_id: CONNECTION_B,
  event_id: eventId,
  kind: 'connection_opened',
  occurred_at_utc: occurredAt,
  schema_version: '1.0.0',
  source: 'synthetic',
  supersedes_connection_id: CONNECTION_A,
});

function openedEvent(
  connectionId: string,
  eventId: string,
  occurredAt: string,
  supersedes: string | null = null,
): ConnectionOpened {
  return connectionOpenedSchema.parse({
    connection_id: connectionId,
    event_id: eventId,
    kind: 'connection_opened',
    occurred_at_utc: occurredAt,
    schema_version: '1.0.0',
    source: 'synthetic',
    supersedes_connection_id: supersedes,
  });
}

/** Cierre del servidor, como el que persiste el transporte. */
function closedEvent(connectionId: string, eventId: string, occurredAt: string): ConnectionClosed {
  return connectionClosedSchema.parse({
    affected_symbols: ['SYNTH_100'],
    closure_type: 'remote',
    connection_id: connectionId,
    event_id: eventId,
    kind: 'connection_closed',
    occurred_at_utc: occurredAt,
    reason: 'close_code_1001',
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

function frameEvent(connectionId: string, observationId: string): RawSourceFrame {
  const payload = tickPayload(1767225601);
  return rawSourceFrameSchema.parse({
    connection_id: connectionId,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: observationId,
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: '2026-01-01T00:00:01.100Z',
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

/** Source events durables según el almacén: las filas del índice, leídas de sus objetos. */
async function storedEvents(stores: {
  objects: MemoryObjectStore;
  sourceLog: MemorySourceLogStore;
}): Promise<{ event: SourceEvent; segment_index: number }[]> {
  return Promise.all(
    stores.sourceLog.rows.map(async (row) => ({
      event: sourceEventSchema.parse(
        JSON.parse(
          Buffer.from(
            await stores.objects.get(contentKey(row.object_sha256), row.byte_length),
          ).toString('utf8'),
        ),
      ),
      segment_index: row.segment_index,
    })),
  );
}

describe('F1-STREAM-001: captura raw-first contra market-data v1', () => {
  it('el escenario principal reproduce sus segmentos byte a byte y el mismo dataset_id', async () => {
    const run = await harness();
    forbidAmbientEffects();
    await driveSyntheticStimuli(run.ingestor, readNdjson('input-frames.ndjson'), 'synthetic');
    await run.ingestor.rotate('requested');

    // Dos segmentos cerrados: la rotación del harness y el cierre explícito final.
    expect(
      run.sourceLog.closed.map((segment) => [segment.segment_index, segment.close_reason]),
    ).toEqual([
      [0, 'requested'],
      [1, 'requested'],
    ]);
    const files = ['expected-source-events-000000.ndjson', 'expected-source-events-000001.ndjson'];
    run.sourceLog.closed.forEach((segment, index) => {
      const physical = run.objects.objects.get(contentKey(segment.object_bytes_sha256));
      expect(physical, `segmento ${String(index)}`).toBeDefined();
      expect(
        Buffer.from(gunzipSync(physical ?? new Uint8Array())).equals(
          readVector(files[index] ?? ''),
        ),
      ).toBe(true);
    });
    const segments = await run.ingestor.log.readClosedSegments(0, 1);
    segments.forEach((segment, index) => {
      expect(Buffer.from(ndjsonBytes(segment)).equals(readVector(files[index] ?? ''))).toBe(true);
    });

    // Cada source event tiene su objeto JCS verificable, indexado en orden de observación.
    expect(run.sourceLog.rows).toHaveLength(11);
    for (const row of run.sourceLog.rows) {
      const bytes = run.objects.objects.get(contentKey(row.object_sha256));
      expect(bytes && sha256Hex(bytes)).toBe(row.object_sha256);
    }

    // Solo frames durables y válidos llegan al sink, idénticos a los ticks firmados sin flags.
    const expectedTicks = readNdjson('expected-ticks.ndjson') as MarketTick[];
    expect(run.ticks).toHaveLength(expectedTicks.length);
    for (const tick of run.ticks) {
      const expected = expectedTicks.find((item) => item.observation_id === tick.observation_id);
      expect(expected && stripFlags(expected)).toEqual(tick);
    }
    expect(run.invalid).toEqual([{ observation_id: id(6), reason: 'schema_validation_failed' }]);
    expect(run.ingestor.state).toBe('accepting');
    expect(run.operational.incidents).toEqual([]);

    const publication = await publishFromLog({
      environment: 'test',
      fromSegment: 0,
      log: run.ingestor.log,
      metadata: run.metadata,
      objects: run.objects,
      profile: fixture.profile,
      publication_id: '019b76da-cb28-7003-8000-0000000000a1',
      published_at_utc: '2026-01-01T00:00:09.000Z',
      toSegment: 1,
      zlibVersion: 'test-zlib',
    });
    expect(publication.dataset_id).toBe(MAIN_DATASET_ID);
    // El objeto del segmento del log es el mismo que referencia el dataset (deduplicado).
    expect(
      publication.manifest.storage_objects
        .filter((object) => object.role === 'source_events')
        .map((object) => object.object_bytes_sha256),
    ).toEqual(run.sourceLog.closed.map((segment) => segment.object_bytes_sha256));
    const report = await replayDataset({
      datasetId: MAIN_DATASET_ID,
      environment: 'test',
      metadata: run.metadata,
      mode: 'recompute',
      objects: run.objects,
    });
    expect(report.status).toBe('reproduced');
  });

  it('un fallo de normalización conserva el frame exacto y produce invalid_source_frame', async () => {
    const run = await harness();
    forbidAmbientEffects();
    const stimuli = readNdjson('zero-valid-ticks/input.ndjson');
    await driveSyntheticStimuli(run.ingestor, stimuli, 'synthetic');
    await run.ingestor.rotate('requested');

    const [segment] = await run.ingestor.log.readClosedSegments(0, 0);
    const [raw] = segment ?? [];
    expect(raw?.kind === 'raw_source_frame' && raw.payload_utf8).toBe(
      (stimuli[0] as { payload_utf8: string }).payload_utf8,
    );
    expect(run.ticks).toEqual([]);
    expect(run.invalid).toEqual([
      {
        observation_id: (stimuli[0] as { observation_id: string }).observation_id,
        reason: 'schema_validation_failed',
      },
    ]);

    const publication = await publishFromLog({
      environment: 'test',
      fromSegment: 0,
      log: run.ingestor.log,
      metadata: run.metadata,
      objects: run.objects,
      profile: fixture.profile,
      publication_id: '019b76da-abe8-7103-8000-000000000001',
      published_at_utc: '2026-01-01T00:00:01.000Z',
      toSegment: 0,
      zlibVersion: 'test-zlib',
    });
    expect(publication.dataset_id).toBe(ZERO_DATASET_ID);
    expect(
      publication.derived.incidents.map((incident) => [
        incident.incident_type,
        incident.observed_ref,
      ]),
    ).toEqual([
      ['invalid_source_frame', (stimuli[0] as { observation_id: string }).observation_id],
    ]);
  });

  it('un fallo de escritura raw reproduce expected-persistence-failure.json sin emitir ticks', async () => {
    const run = await harness();
    forbidAmbientEffects();
    await driveSyntheticStimuli(
      run.ingestor,
      readNdjson('input-persistence-failure.ndjson'),
      'synthetic',
      {
        onFaultArmed: (stimulus) => {
          run.objects.armNextPutFailure(stimulus.reason);
        },
      },
    );

    expect(run.objects.hasArmedFailure).toBe(false);
    const report = run.ingestor.persistenceFailureReport();
    expect(prettyCanonicalJson(report)).toBe(
      readVector('expected-persistence-failure.json').toString('utf8'),
    );
    expect(run.ticks).toEqual([]);
    expect(run.sourceLog.rows).toEqual([]);
    expect(run.ingestor.state).toBe('paused');

    const [incident] = run.operational.incidents;
    expect(incident).toMatchObject({
      evidence: { reason: 'synthetic_injected_failure', stage: 'raw_object_write' },
      incident_type: 'persistence_unavailable',
      observed_at_utc: DETECTED_AT,
      observed_ref: '019b76da-a864-7000-9000-000000000002',
      related_refs: [],
      severity: 'critical',
      symbol: null,
    });
    expect(
      run.operational.conditions.map((condition) => [condition.condition_type, condition.action]),
    ).toEqual([['persistence_unavailable', 'opened']]);
    expect(
      await run.ingestor.receiveFrame({
        connection_id: CONNECTION_A,
        observation_id: id(50),
        payload_utf8: tickPayload(1767225601),
        received_at_utc: '2026-01-01T00:00:01.100Z',
      }),
    ).toEqual({ status: 'input_closed' });
  });

  it('un fallo del índice no emite el tick y deja el objeto como huérfano', async () => {
    const run = await harness();
    run.sourceLog.failIndex = () => true;
    const outcome = await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: tickPayload(1767225600),
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    expect(outcome).toEqual({ stage: 'source_event_index', status: 'not_durable' });
    expect(run.ticks).toEqual([]);
    expect(run.sourceLog.rows).toEqual([]);
    expect(run.objects.objects.size).toBe(1);
    expect(run.operational.incidents[0]?.evidence).toEqual({
      reason: 'synthetic_index_failure',
      stage: 'source_event_index',
    });
  });

  it('sin PostgreSQL solo emite una alerta sanitizada y no afirma persistencia', async () => {
    const operational = new MemoryOperationalStore();
    operational.failAppend = true;
    const run = await harness({ operational });
    run.sourceLog.failIndex = () => true;
    const secretPayload = tickPayload(1767225600);
    await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: secretPayload,
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    expect(run.alerts).toEqual([
      {
        event: 'operational_registry_unavailable',
        incident_type: 'persistence_unavailable',
        observed_at_utc: DETECTED_AT,
        observed_ref: id(1),
        operation: 'record',
        reason: 'ECONNREFUSED',
        subject: 'source_event_index',
      },
    ]);
    expect(JSON.stringify(run.alerts)).not.toContain('SYNTH_100');
    expect(operational.incidents).toEqual([]);
    expect(run.ingestor.state).toBe('paused');
  });

  it('un ConnectionOpened durable tras recuperar resuelve la condición y reabre la entrada', async () => {
    const run = await harness();
    run.objects.armNextPutFailure('synthetic_injected_failure');
    await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: tickPayload(1767225600),
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    expect(run.ingestor.state).toBe('paused');

    const reopened = connectionOpened(id(2), '2026-01-01T00:00:20.000Z');
    if (reopened.kind === 'raw_source_frame') {
      throw new TypeError('evento inesperado');
    }
    expect((await run.ingestor.receiveEvent(reopened)).status).toBe('durable');
    expect(run.ingestor.state).toBe('accepting');

    const [opening, resolution] = run.operational.conditions;
    expect(resolution).toMatchObject({
      action: 'resolved',
      cause_refs: [id(2), opening?.condition_event_id].sort(),
      condition_key: opening?.condition_key,
      occurred_at_utc: '2026-01-01T00:00:20.000Z',
      resolution_reason: 'persistence_restored',
    });
    expect(
      validateConditionCausality({
        conditions: run.operational.conditions,
        incidents: run.operational.incidents,
        sourceEvents: [reopened],
      }).openConditionTypes,
    ).toEqual([]);

    // Tras reabrir, un frame vuelve a ser durable y a emitir su tick.
    await run.ingestor.receiveFrame({
      connection_id: CONNECTION_B,
      observation_id: id(3),
      payload_utf8: tickPayload(1767225620),
      received_at_utc: '2026-01-01T00:00:20.100Z',
    });
    expect(run.ticks.map((tick) => tick.observation_id)).toEqual([id(3)]);
  });

  it('un frame por encima de 1 MiB se rechaza sin persistirlo y registra source_limit_exceeded', async () => {
    const run = await harness();
    const outcome = await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: 'x'.repeat(1_048_577),
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    expect(outcome).toEqual({ resource: 'websocket_frame', status: 'limit_exceeded' });
    expect(run.sourceLog.rows).toEqual([]);
    expect(run.objects.objects.size).toBe(0);
    expect(run.operational.incidents[0]).toMatchObject({
      evidence: {
        maximum_value: 1_048_576,
        observed_value: 1_048_577,
        resource: 'websocket_frame',
        unit: 'bytes',
      },
      incident_type: 'source_limit_exceeded',
      // observation_id ya asignado al frame rechazado, como exige el contrato.
      observed_ref: id(1),
      severity: 'error',
      symbol: null,
    });
    expect(run.ingestor.state).toBe('paused');

    // Con la entrada cerrada: se rechazan frames, se registra el cierre y un ConnectionOpened reabre.
    expect(
      await run.ingestor.receiveFrame({
        connection_id: CONNECTION_A,
        observation_id: id(2),
        payload_utf8: tickPayload(1767225600),
        received_at_utc: '2026-01-01T00:00:00.200Z',
      }),
    ).toEqual({ status: 'input_closed' });
    const closed = await run.ingestor.receiveEvent({
      affected_symbols: [],
      closure_type: 'requested',
      connection_id: CONNECTION_A,
      event_id: id(3),
      kind: 'connection_closed',
      occurred_at_utc: '2026-01-01T00:00:00.300Z',
      reason: 'source_limit_exceeded',
      schema_version: '1.0.0',
      source: 'synthetic',
    });
    expect(closed.status).toBe('durable');
    expect(run.ingestor.state).toBe('paused');
    const reopened = connectionOpened(id(4), '2026-01-01T00:00:20.000Z');
    if (reopened.kind === 'raw_source_frame') {
      throw new TypeError('evento inesperado');
    }
    await run.ingestor.receiveEvent(reopened);
    expect(run.ingestor.state).toBe('accepting');
    expect(run.operational.conditions.at(-1)).toMatchObject({
      action: 'resolved',
      condition_type: 'source_limit_exceeded',
      resolution_reason: 'input_reopened',
    });
  });

  it('con reglas 2.0.0 un mensaje que no es tick se guarda raw, no da tick ni alarma y se reproduce', async () => {
    const quality = JSON.parse(readVector('quality-profile.json').toString('utf8')) as Record<
      string,
      unknown
    >;
    const profile = createPipelineProfile({
      connector_version: 'fixture-v1',
      quality_profile_bytes: Buffer.from(
        JSON.stringify({ ...quality, non_tick_msg_types: ['ping'], quality_rule_version: '2.0.0' }),
      ),
      source_schema_bytes: readVector('source-schema.json'),
      source_schema_release: 'synthetic-v1',
    });
    const run = await harness({ profile });
    forbidAmbientEffects();
    const ping = '{"echo_req":{"ping":1,"req_id":1},"msg_type":"ping","ping":"pong","req_id":1}';
    await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: ping,
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    await run.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(2),
      payload_utf8: tickPayload(1767225600),
      received_at_utc: '2026-01-01T00:00:00.200Z',
    });
    await run.ingestor.rotate('requested');

    expect(run.nonTick).toEqual([{ msg_type: 'ping', observation_id: id(1) }]);
    expect(run.invalid).toEqual([]);
    expect(run.alerts).toEqual([]);
    expect(run.operational.incidents).toEqual([]);
    expect(run.ticks.map((tick) => tick.observation_id)).toEqual([id(2)]);
    expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual([id(1), id(2)]);

    const publication = await publishFromLog({
      environment: 'test',
      fromSegment: 0,
      log: run.ingestor.log,
      metadata: run.metadata,
      objects: run.objects,
      profile,
      publication_id: '019b76da-cb28-7003-8000-0000000000c1',
      published_at_utc: '2026-01-01T00:00:09.000Z',
      toSegment: 0,
      zlibVersion: 'test-zlib',
    });
    expect(publication.core).toMatchObject({
      incident_count: 0,
      incident_schema_version: '2.0.0',
      normalizer_version: '2.0.0',
      quality_rule_version: '2.0.0',
      raw_frame_count: 2,
    });
    for (const mode of ['verify-only', 'recompute'] as const) {
      const report = await replayDataset({
        datasetId: publication.dataset_id,
        environment: 'test',
        metadata: run.metadata,
        mode,
        objects: run.objects,
      });
      expect(report.status).toBe(mode === 'recompute' ? 'reproduced' : 'verified');
    }
  });

  it('una condición abierta de una ejecución anterior mantiene la entrada cerrada', async () => {
    const first = await harness();
    first.objects.armNextPutFailure('synthetic_injected_failure');
    await first.ingestor.receiveFrame({
      connection_id: CONNECTION_A,
      observation_id: id(1),
      payload_utf8: tickPayload(1767225600),
      received_at_utc: '2026-01-01T00:00:00.100Z',
    });
    const restarted = await harness({ operational: first.operational });
    expect(restarted.registry.openConditionTypes()).toEqual(['persistence_unavailable']);
    expect(restarted.ingestor.state).toBe('paused');
  });
});

describe('log de source events: rotación 1.0.0 y reinicio', () => {
  function raw(sequence: number, receivedAt: string): SourceEvent {
    const payload = tickPayload(1767225600 + sequence);
    return rawSourceFrameSchema.parse({
      connection_id: CONNECTION_A,
      connector_version: 'fixture-v1',
      kind: 'raw_source_frame',
      observation_id: id(sequence),
      payload_utf8: payload,
      raw_payload_sha256: sha256Hex(payload),
      received_at_utc: receivedAt,
      schema_version: '1.0.0',
      source: 'synthetic',
    });
  }

  async function freshLog() {
    const objects = new MemoryObjectStore();
    const store = new MemorySourceLogStore();
    const open = () =>
      SourceEventLog.open({ objects, source: 'synthetic', store, zlibVersion: 'test-zlib' });
    return { log: await open(), objects, open, store };
  }

  it('rota antes del frame 10 001', async () => {
    const { log, store } = await freshLog();
    for (let sequence = 1; sequence <= 10_001; sequence += 1) {
      await log.append(raw(sequence, '2026-01-01T00:00:00.100Z'));
    }
    expect(store.closed.map((segment) => [segment.close_reason, segment.raw_frame_count])).toEqual([
      ['raw_frames', 10_000],
    ]);
    expect(log.openSegmentStats.event_count).toBe(1);
  });

  it('rota cuando un evento llega 5 minutos después del primero del segmento', async () => {
    const { log, store } = await freshLog();
    await log.append(raw(1, '2026-01-01T00:00:00.000Z'));
    await log.append(raw(2, '2026-01-01T00:04:59.999Z'));
    await log.append(raw(3, '2026-01-01T00:05:00.000Z'));
    expect(store.closed.map((segment) => [segment.close_reason, segment.event_count])).toEqual([
      ['window', 2],
    ]);
    expect(log.openSegmentIndex).toBe(1);
  });

  it('readClosedSegment da un segmento cerrado con su fila de closed_source_segments, verificado como en readClosedSegments', async () => {
    const { log, objects, store } = await freshLog();
    await log.append(raw(1, '2026-01-01T00:00:00.000Z'));
    await log.append(raw(2, '2026-01-01T00:00:01.000Z'));
    await log.close('requested');
    await log.append(raw(3, '2026-01-01T00:00:02.000Z'));
    await log.close('requested');

    const second = await log.readClosedSegment(1);
    expect(second.segment).toEqual(store.closed[1]);
    expect(second.events).toEqual((await log.readClosedSegments(1, 1))[0]);
    // El segmento abierto no está cerrado.
    await expect(log.readClosedSegment(2)).rejects.toBeInstanceOf(LogIntegrityError);
    // Un objeto alterado no pasa sus comprobaciones.
    const first = store.closed[0];
    if (first === undefined) {
      throw new TypeError('Falta el segmento 0.');
    }
    objects.objects.set(contentKey(first.object_bytes_sha256), new Uint8Array([1, 2, 3]));
    await expect(log.readClosedSegment(0)).rejects.toBeInstanceOf(LogIntegrityError);
    await expect(log.readClosedSegment(-1)).rejects.toThrow(/inválido/u);
  });

  it('continúa el segmento no finalizado tras un reinicio', async () => {
    const { log, open, store } = await freshLog();
    const events = [1, 2, 3].map((sequence) =>
      raw(sequence, `2026-01-01T00:00:0${String(sequence)}.000Z`),
    );
    for (const event of events) {
      await log.append(event);
    }
    const restarted = await open();
    expect(restarted.openSegmentStats.event_count).toBe(3);
    expect(restarted.lastEventId).toBe(id(3));
    expect(restarted.totalEventCount).toBe(3);
    const fourth = raw(4, '2026-01-01T00:00:04.000Z');
    await restarted.append(fourth);
    await restarted.close('requested');
    const [segment] = await restarted.readClosedSegments(0, 0);
    expect(
      Buffer.from(ndjsonBytes(segment ?? [])).equals(Buffer.from(ndjsonBytes([...events, fourth]))),
    ).toBe(true);
    expect(store.rows.map((row) => row.position)).toEqual([0, 1, 2, 3]);
  });

  it('firstEventTimeUtc es la hora del evento durable más antiguo, el primero del log: null sin eventos, la del primero al escribirlo y la misma al reabrirlo, también con su segmento ya cerrado', async () => {
    const { log, open } = await freshLog();
    expect(log.firstEventTimeUtc).toBeNull();
    expect((await open()).firstEventTimeUtc).toBeNull();
    await log.append(raw(1, '2026-01-01T00:00:01.000Z'));
    await log.append(raw(2, '2026-01-01T00:00:02.000Z'));
    expect(log.firstEventTimeUtc).toBe('2026-01-01T00:00:01.000Z');
    expect((await open()).firstEventTimeUtc).toBe('2026-01-01T00:00:01.000Z');
    await log.close('requested');
    await log.append(raw(3, '2026-01-01T00:00:03.000Z'));
    expect((await open()).firstEventTimeUtc).toBe('2026-01-01T00:00:01.000Z');
  });

  it('firstEventTimeUtc incluye un evento que el índice confirmó aunque informó error: el log reabierto lo adopta', async () => {
    const { log, open, store } = await freshLog();
    store.failIndexAfterInsert = () => true;
    await expect(log.append(raw(1, '2026-01-01T00:00:01.000Z'))).rejects.toThrow(
      LogPersistenceError,
    );
    expect(log.firstEventTimeUtc).toBeNull();
    store.failIndexAfterInsert = () => false;
    expect((await open()).firstEventTimeUtc).toBe('2026-01-01T00:00:01.000Z');
  });

  type Stores = Pick<Awaited<ReturnType<typeof freshLog>>, 'objects' | 'store'>;

  /** Cambia la línea del primer evento del segmento abierto, con su objeto y su fila de acuerdo. */
  function replaceFirstLine({ objects, store }: Stores, change: (text: string) => string): void {
    const [row] = store.rows;
    const stored =
      row === undefined ? undefined : objects.objects.get(contentKey(row.object_sha256));
    if (row === undefined || stored === undefined) {
      throw new TypeError('El segmento abierto no tiene eventos.');
    }
    const bytes = new TextEncoder().encode(change(Buffer.from(stored).toString('utf8')));
    objects.objects.set(contentKey(sha256Hex(bytes)), bytes);
    store.rows[0] = { ...row, byte_length: bytes.byteLength, object_sha256: sha256Hex(bytes) };
  }

  /** Cambia los bytes guardados del objeto del primer evento del segmento abierto. */
  function changeFirstObject(
    { objects, store }: Stores,
    change: (bytes: Uint8Array) => Uint8Array | null,
  ): void {
    const key = contentKey(store.rows[0]?.object_sha256 ?? '');
    const changed = change(Uint8Array.from(objects.objects.get(key) ?? new Uint8Array()));
    if (changed === null) {
      objects.objects.delete(key);
    } else {
      objects.objects.set(key, changed);
    }
  }

  it.each<[string, (stores: Stores) => void, RegExp | null]>([
    [
      'un objeto alterado',
      (stores) => {
        changeFirstObject(stores, (bytes) => {
          bytes[2] = 0x41;
          return bytes;
        });
      },
      /alterado o incompleto/u,
    ],
    // El índice confirmó el evento: un objeto que falta o que crece no es un almacén que no
    // responde, sino contenido confirmado que ya no está, como al leer un segmento cerrado.
    [
      'un objeto ausente',
      (stores) => {
        changeFirstObject(stores, () => null);
      },
      /ausente/u,
    ],
    [
      'un objeto mayor que su fila',
      (stores) => {
        changeFirstObject(stores, (bytes) => Uint8Array.from([...bytes, 0x0a]));
      },
      /mayor que su fila/u,
    ],
    [
      'una línea que no es JCS',
      (stores) => {
        replaceFirstLine(stores, (text) => ` ${text}`);
      },
      /no es JCS/u,
    ],
    [
      'una línea que no es un source event',
      (stores) => {
        replaceFirstLine(stores, () => '{"kind":"otro"}');
      },
      null,
    ],
    [
      'la línea de otro evento',
      (stores) => {
        replaceFirstLine(stores, () => canonicalJson(raw(9, '2026-01-01T00:00:09.000Z')));
      },
      /no corresponde/u,
    ],
    [
      'una fila fuera de su posición',
      ({ store }) => {
        const [row] = store.rows;
        if (row !== undefined) {
          store.rows[0] = { ...row, position: 1 };
        }
      },
      /no contiguo/u,
    ],
  ])(
    'al reabrir, %s en el segmento abierto lanza LogIntegrityError: no se reintenta',
    async (_label, corrupt, message) => {
      const { log, objects, open, store } = await freshLog();
      await log.append(raw(1, '2026-01-01T00:00:01.000Z'));
      corrupt({ objects, store });

      const reopening = open();
      await expect(reopening).rejects.toThrow(LogIntegrityError);
      if (message !== null) {
        await expect(reopening).rejects.toThrow(message);
      }
    },
  );

  it.each<[string, (stores: Stores) => void]>([
    [
      'el índice',
      ({ store }) => {
        vi.spyOn(store, 'readLogState').mockRejectedValue(
          Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' }),
        );
      },
    ],
    [
      'el almacenamiento de objetos',
      ({ objects }) => {
        objects.onRead = () => {
          throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
        };
      },
    ],
  ])(
    'al reabrir, si %s no responde, lanza LogReadError con el motivo saneado',
    async (_label, failReads) => {
      const { log, objects, open, store } = await freshLog();
      await log.append(raw(1, '2026-01-01T00:00:01.000Z'));
      failReads({ objects, store });

      const reopening = open();
      await expect(reopening).rejects.toThrow(LogReadError);
      await expect(reopening).rejects.toMatchObject({ reason: 'ECONNREFUSED' });
    },
  );

  it('tras un fallo la instancia queda inválida hasta reabrirla', async () => {
    const { log, objects, open } = await freshLog();
    objects.armNextPutFailure('synthetic_injected_failure');
    await expect(log.append(raw(1, '2026-01-01T00:00:01.000Z'))).rejects.toMatchObject({
      reason: 'synthetic_injected_failure',
      stage: 'raw_object_write',
    });
    await expect(log.append(raw(2, '2026-01-01T00:00:02.000Z'))).rejects.toThrow(/reábrelo/u);
    const reopened = await open();
    await reopened.append(raw(2, '2026-01-01T00:00:02.000Z'));
    expect(reopened.totalEventCount).toBe(1);
  });

  it('publicar exige segmentos cerrados', async () => {
    const { log } = await freshLog();
    await log.append(raw(1, '2026-01-01T00:00:01.000Z'));
    await expect(log.readClosedSegments(0, 0)).rejects.toThrow(/cerrados/u);
  });

  it('la lectura durable da los segmentos cerrados y el abierto, en orden y como en el almacén', async () => {
    const { log, objects, open, store } = await freshLog();
    expect(await log.readDurableSegments()).toEqual([]);
    const closedSegment = [1, 2].map((sequence) =>
      raw(sequence, `2026-01-01T00:00:0${String(sequence)}.000Z`),
    );
    for (const event of closedSegment) {
      await log.append(event);
    }
    await log.close('requested');
    // Un segmento abierto sin eventos no tiene nada durable.
    expect(await log.readDurableSegments()).toEqual([closedSegment]);
    const openSegment = [3, 4, 5].map((sequence) =>
      raw(sequence, `2026-01-01T00:00:0${String(sequence)}.000Z`),
    );
    for (const event of openSegment) {
      await log.append(event);
    }

    const segments = await log.readDurableSegments();
    expect(segments).toEqual([closedSegment, openSegment]);
    const stored = await storedEvents({ objects, sourceLog: store });
    expect(segments).toEqual(
      [0, 1].map((index) =>
        stored.filter((item) => item.segment_index === index).map((item) => item.event),
      ),
    );
    // Una instancia abierta desde los almacenes lee lo mismo.
    expect(await (await open()).readDurableSegments()).toEqual(segments);
  });

  it('la lectura durable falla tras un fallo de persistencia hasta reabrir el log', async () => {
    const { log, objects, open } = await freshLog();
    const first = raw(1, '2026-01-01T00:00:01.000Z');
    await log.append(first);
    objects.armNextPutFailure('synthetic_injected_failure');
    await expect(log.append(raw(2, '2026-01-01T00:00:02.000Z'))).rejects.toMatchObject({
      stage: 'raw_object_write',
    });
    await expect(log.readDurableSegments()).rejects.toThrow(/reábrelo/u);
    expect(await (await open()).readDurableSegments()).toEqual([[first]]);
  });

  it('el motivo de un fallo usa el código o nombre del error, nunca su mensaje', () => {
    const withCode = Object.assign(new Error('postgres://buoh:secreto@host'), {
      code: 'ECONNRESET',
    });
    expect(failureReason(withCode)).toBe('ECONNRESET');
    expect(failureReason(Object.assign(new Error('x'), { code: 'con espacios' }))).toBe('Error');
    expect(failureReason('texto')).toBe('unknown_error');
  });
});

// Conexión anterior y cierre no registrado: ADR-0015 §3 («Conexión anterior» y «Cierre no
// registrado», pendiente 7 de F1.3) y contratos de dominio, «Registro operativo».
describe('conexión anterior (ADR-0015 §3)', () => {
  it('sin ConnectionOpened en el log no hay conexión anterior', () => {
    expect(previousConnection([])).toBeNull();
    // Un frame no basta: para el log, una conexión existe solo con su apertura durable.
    expect(previousConnection([[frameEvent(CONNECTION_A, id(1))]])).toBeNull();
  });

  it('es la última conexión con ConnectionOpened, cerrada solo si la sigue su ConnectionClosed, con la hora de ese cierre', () => {
    const openedA = openedEvent(CONNECTION_A, id(1), '2026-01-01T00:00:01.000Z');
    const frameA = frameEvent(CONNECTION_A, id(2));
    const closedA = closedEvent(CONNECTION_A, id(3), '2026-01-01T00:00:02.000Z');
    const openedB = openedEvent(CONNECTION_B, id(4), '2026-01-01T00:00:03.000Z', CONNECTION_A);

    expect(previousConnection([[openedA, frameA]])).toEqual({
      closed: false,
      closed_at_utc: null,
      connection_id: CONNECTION_A,
    });
    expect(previousConnection([[openedA, frameA, closedA]])).toEqual({
      closed: true,
      closed_at_utc: '2026-01-01T00:00:02.000Z',
      connection_id: CONNECTION_A,
    });
    // En otro segmento, y sin cierre todavía.
    expect(previousConnection([[openedA, frameA, closedA], [openedB]])).toEqual({
      closed: false,
      closed_at_utc: null,
      connection_id: CONNECTION_B,
    });
  });

  it('un intento cuyo ConnectionOpened no quedó durable no existe para el log', async () => {
    const run = await harness();
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), '2026-01-01T00:00:01.000Z'));
    run.objects.armNextPutFailure('synthetic_injected_failure');
    expect(
      await run.ingestor.receiveEvent(
        openedEvent(CONNECTION_B, id(2), '2026-01-01T00:00:20.000Z', CONNECTION_A),
      ),
    ).toEqual({ stage: 'raw_object_write', status: 'not_durable' });

    const reopened = await run.openLog();
    expect(previousConnection(await reopened.readDurableSegments())).toEqual({
      closed: false,
      closed_at_utc: null,
      connection_id: CONNECTION_A,
    });
  });
});

describe('RawFirstIngestor.repairUnrecordedClose: cierre no registrado (ADR-0015 §3)', () => {
  const OPENED_AT = '2026-01-01T00:00:01.000Z';
  const DETECTION = '2026-01-01T00:00:30.000Z';
  const REOPENED_AT = '2026-01-01T00:00:31.000Z';

  function tick(observationId: string) {
    return {
      connection_id: CONNECTION_A,
      observation_id: observationId,
      payload_utf8: tickPayload(1767225601),
      received_at_utc: '2026-01-01T00:00:01.100Z',
    };
  }

  const unavailable = () => {
    throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
  };

  it('un log sin conexiones no tiene nada que reparar', async () => {
    const run = await harness();
    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: null,
      connection_id: null,
      status: 'nothing_to_repair',
    });
    expect(run.sourceLog.rows).toEqual([]);
  });

  it('si la conexión anterior ya tiene su cierre, no escribe nada y da la hora de ese cierre', async () => {
    const run = await harness();
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await run.ingestor.receiveEvent(closedEvent(CONNECTION_A, id(2), '2026-01-01T00:00:02.000Z'));

    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: '2026-01-01T00:00:02.000Z',
      connection_id: CONNECTION_A,
      status: 'nothing_to_repair',
    });
    expect(run.sourceLog.rows).toHaveLength(2);
  });

  it('con el log sano escribe el cierre close_not_recorded de la conexión anterior y deja la entrada como estaba', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await run.ingestor.receiveFrame(tick(id(2)));
    // El proceso cayó con la conexión abierta: su ConnectionClosed nunca se escribió.
    now = DETECTION;

    expect(
      await run.ingestor.repairUnrecordedClose({
        affected_symbols: ['SYNTH_50', 'SYNTH_100', 'SYNTH_50'],
      }),
    ).toEqual({ closed_at_utc: DETECTION, connection_id: CONNECTION_A, status: 'repaired' });
    expect((await storedEvents(run)).map((item) => item.event)).toEqual([
      openedEvent(CONNECTION_A, id(1), OPENED_AT),
      expect.objectContaining({ kind: 'raw_source_frame', observation_id: id(2) }),
      {
        affected_symbols: ['SYNTH_100', 'SYNTH_50'],
        closure_type: 'transport_error',
        connection_id: CONNECTION_A,
        event_id: id(9001),
        kind: 'connection_closed',
        occurred_at_utc: DETECTION,
        reason: 'close_not_recorded',
        schema_version: '1.0.0',
        source: 'synthetic',
      },
    ]);
    expect(run.ingestor.state).toBe('accepting');
    // Ya tiene su cierre durable: nunca se cierra dos veces la misma conexión.
    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: DETECTION,
      connection_id: CONNECTION_A,
      status: 'nothing_to_repair',
    });
    expect(run.sourceLog.rows).toHaveLength(3);
  });

  it('si la conexión anterior abrió en un segmento ya cerrado, el cierre reparado va al segmento abierto, vacío tras la rotación', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    const openedA = openedEvent(CONNECTION_A, id(1), OPENED_AT);
    await run.ingestor.receiveEvent(openedA);
    // El segmento de la apertura queda cerrado y el abierto no tiene eventos.
    await run.ingestor.rotate('requested');
    now = DETECTION;

    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: DETECTION,
      connection_id: CONNECTION_A,
      status: 'repaired',
    });
    const close = connectionClosedSchema.parse({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'transport_error',
      connection_id: CONNECTION_A,
      event_id: id(9001),
      kind: 'connection_closed',
      occurred_at_utc: DETECTION,
      reason: 'close_not_recorded',
      schema_version: '1.0.0',
      source: 'synthetic',
    });
    expect(await storedEvents(run)).toEqual([
      { event: openedA, segment_index: 0 },
      { event: close, segment_index: 1 },
    ]);
    expect(await run.ingestor.log.readDurableSegments()).toEqual([[openedA], [close]]);
    // Igual desde los almacenes.
    expect(await (await run.openLog()).readDurableSegments()).toEqual([[openedA], [close]]);
  });

  it('el cierre reparado no reabre la entrada: sigue cerrada hasta el ConnectionOpened', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    // Un frame de más de 1 MiB cierra la entrada, y el proceso cae antes del ConnectionClosed.
    await run.ingestor.receiveFrame({ ...tick(id(2)), payload_utf8: 'x'.repeat(1_048_577) });
    expect(run.ingestor.state).toBe('paused');
    now = DETECTION;

    expect(
      (await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).status,
    ).toBe('repaired');
    expect(run.ingestor.state).toBe('paused');
    expect(run.registry.openConditionTypes()).toEqual(['source_limit_exceeded']);
    now = REOPENED_AT;
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_B, id(3), REOPENED_AT, CONNECTION_A));
    expect(run.ingestor.state).toBe('accepting');
  });

  it('con el log fallido lo reabre antes de leer la conexión anterior, y el cierre reparado resuelve persistence_unavailable', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    run.objects.armNextPutFailure('synthetic_injected_failure');
    await run.ingestor.receiveFrame(tick(id(2)));
    const failedLog = run.ingestor.log;
    now = DETECTION;

    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: DETECTION,
      connection_id: CONNECTION_A,
      status: 'repaired',
    });
    expect(run.ingestor.log).not.toBe(failedLog);
    expect((await storedEvents(run)).map((item) => item.event)).toEqual([
      openedEvent(CONNECTION_A, id(1), OPENED_AT),
      expect.objectContaining({
        connection_id: CONNECTION_A,
        event_id: id(9001),
        occurred_at_utc: DETECTION,
        reason: 'close_not_recorded',
      }),
    ]);
    // Es el primer evento durable tras el fallo: resuelve la condición.
    const [opening, resolution] = run.operational.conditions;
    expect(resolution).toMatchObject({
      action: 'resolved',
      cause_refs: [id(9001), opening?.condition_event_id].sort(),
      condition_key: opening?.condition_key,
      occurred_at_utc: DETECTION,
      resolution_reason: 'persistence_restored',
    });
    // Pero no reabre la entrada: eso lo hace el ConnectionOpened durable.
    expect(run.ingestor.state).toBe('paused');
    now = REOPENED_AT;
    expect(
      (await run.ingestor.receiveEvent(openedEvent(CONNECTION_B, id(3), REOPENED_AT, CONNECTION_A)))
        .status,
    ).toBe('durable');
    expect(run.ingestor.state).toBe('accepting');
  });

  it('si no puede reabrir el log, el cierre no es durable y queda persistence_unavailable con su ID', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    run.objects.armNextPutFailure('synthetic_injected_failure');
    await run.ingestor.receiveFrame(tick(id(2)));
    // El almacenamiento tampoco responde al reabrir el log.
    run.objects.onRead = unavailable;
    now = DETECTION;

    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      stage: 'source_event_index',
      status: 'not_durable',
    });
    expect(run.operational.incidents.at(-1)).toMatchObject({
      evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
      incident_type: 'persistence_unavailable',
      observed_at_utc: DETECTION,
      // El ID del cierre que se iba a escribir identifica el intento.
      observed_ref: id(9001),
      related_refs: [id(1)],
      severity: 'critical',
    });
    expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual([id(1)]);
    expect(run.ingestor.state).toBe('paused');

    // Con el almacenamiento de vuelta, el intento siguiente lo repara.
    run.objects.onRead = (_key, bytes) => bytes;
    now = REOPENED_AT;
    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: REOPENED_AT,
      connection_id: CONNECTION_A,
      status: 'repaired',
    });
    expect((await storedEvents(run)).at(-1)?.event).toMatchObject({
      event_id: id(9002),
      occurred_at_utc: REOPENED_AT,
      reason: 'close_not_recorded',
    });
  });

  it.each<[string, (run: Awaited<ReturnType<typeof harness>>) => void]>([
    [
      'el almacenamiento de objetos',
      (run) => {
        // El segmento cerrado se lee de su objeto.
        run.objects.onRead = unavailable;
      },
    ],
    [
      'el índice',
      (run) => {
        vi.spyOn(run.sourceLog, 'listClosedSegments').mockImplementation(unavailable);
      },
    ],
  ])(
    'si %s no responde al leer el log, el cierre no es durable y queda persistence_unavailable',
    async (_store, failReads) => {
      let now = OPENED_AT;
      const run = await harness({ now: () => now });
      await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
      await run.ingestor.rotate('requested');
      failReads(run);
      now = DETECTION;

      expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual(
        { stage: 'source_event_index', status: 'not_durable' },
      );
      expect(run.operational.incidents).toEqual([
        expect.objectContaining({
          evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
          incident_type: 'persistence_unavailable',
          observed_ref: id(9001),
        }),
      ]);
      expect(run.sourceLog.rows).toHaveLength(1);
      expect(run.ingestor.state).toBe('paused');
    },
  );

  it.each<[string, (stored: Uint8Array) => Uint8Array | null, RegExp]>([
    [
      'alterado: ya no tiene el hash de su fila',
      (stored) => {
        const altered = Uint8Array.from(stored);
        altered[2] = 0x41;
        return altered;
      },
      /segmento 0 alterado/u,
    ],
    // El índice confirmó el segmento: un objeto que falta o que crece no es un almacén que no
    // responde, sino contenido confirmado que ya no está, como en el replay.
    ['ausente', () => null, /segmento 0 ausente/u],
    [
      'mayor que su fila',
      (stored) => Uint8Array.from([...stored, 0x0a]),
      /segmento 0 mayor que su fila/u,
    ],
  ])(
    'si el objeto de un segmento cerrado está %s, la reparación se rechaza con LogIntegrityError sin escribir el cierre ni registrar persistence_unavailable',
    async (_label, change, message) => {
      let now = OPENED_AT;
      const run = await harness({ now: () => now });
      await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
      await run.ingestor.rotate('requested');
      const key = contentKey(run.sourceLog.closed[0]?.object_bytes_sha256 ?? '');
      const changed = change(run.objects.objects.get(key) ?? new Uint8Array());
      if (changed === null) {
        run.objects.objects.delete(key);
      } else {
        run.objects.objects.set(key, changed);
      }
      now = DETECTION;

      // Con contenido no confiable no se reintenta (ADR-0004 §12): ni pausa ni incidencia.
      const repair = run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] });
      await expect(repair).rejects.toThrow(LogIntegrityError);
      await expect(repair).rejects.toThrow(message);
      expect(run.sourceLog.rows).toHaveLength(1);
      expect(run.operational.incidents).toEqual([]);
      expect(run.registry.openConditionTypes()).toEqual([]);
      expect(run.ingestor.state).toBe('accepting');
    },
  );

  it('un error al leer el log que no viene de un almacén rechaza la reparación sin registrar persistence_unavailable', async () => {
    const run = await harness();
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    // Un error de programación, por ejemplo: no dice que el almacenamiento no esté disponible.
    const bug = new TypeError('sintético');
    vi.spyOn(run.ingestor.log, 'readDurableSegments').mockRejectedValueOnce(bug);

    await expect(
      run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] }),
    ).rejects.toBe(bug);
    expect(run.sourceLog.rows).toHaveLength(1);
    expect(run.operational.incidents).toEqual([]);
    expect(run.ingestor.state).toBe('accepting');
  });

  it('con el log marcado como desactualizado (markLogStale), lo reabre antes de leer la conexión anterior: ve la que abrió otro escritor y repara su cierre', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await run.ingestor.receiveEvent(closedEvent(CONNECTION_A, id(2), '2026-01-01T00:00:02.000Z'));
    // Otro escritor, con el bloqueo que esta instancia perdió, abre una conexión y cae sin cerrarla.
    const openedB = openedEvent(CONNECTION_B, id(3), '2026-01-01T00:00:03.000Z', CONNECTION_A);
    await (await run.openLog()).append(openedB);
    // El log abierto no lo ve: para él, la conexión anterior es A, ya cerrada.
    expect(
      (await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).status,
    ).toBe('nothing_to_repair');
    run.ingestor.markLogStale();
    now = DETECTION;

    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: DETECTION,
      connection_id: CONNECTION_B,
      status: 'repaired',
    });
    expect((await storedEvents(run)).map((item) => item.event).slice(-2)).toEqual([
      openedB,
      expect.objectContaining({
        connection_id: CONNECTION_B,
        occurred_at_utc: DETECTION,
        reason: 'close_not_recorded',
      }),
    ]);
    // No hubo ningún fallo: ni incidencia ni pausa.
    expect(run.operational.incidents).toEqual([]);
    expect(run.ingestor.state).toBe('accepting');
  });

  it('si el índice confirmó el cierre aunque informó error, el log reabierto lo adopta y no hay nada que reparar', async () => {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    run.sourceLog.failIndexAfterInsert = (row) => row.kind === 'connection_closed';
    expect(
      await run.ingestor.receiveEvent(closedEvent(CONNECTION_A, id(2), '2026-01-01T00:00:02.000Z')),
    ).toEqual({ stage: 'source_event_index', status: 'not_durable' });
    expect(run.operational.incidents[0]?.evidence).toEqual({
      reason: 'synthetic_index_ambiguous',
      stage: 'source_event_index',
    });
    run.sourceLog.failIndexAfterInsert = () => false;
    now = DETECTION;

    // La hora es la del cierre adoptado: la apertura siguiente tiene que ser posterior.
    expect(await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] })).toEqual({
      closed_at_utc: '2026-01-01T00:00:02.000Z',
      connection_id: CONNECTION_A,
      status: 'nothing_to_repair',
    });
    // Solo el cierre original.
    expect((await storedEvents(run)).map((item) => item.event)).toEqual([
      openedEvent(CONNECTION_A, id(1), OPENED_AT),
      closedEvent(CONNECTION_A, id(2), '2026-01-01T00:00:02.000Z'),
    ]);
    // Nada nuevo quedó durable: la condición sigue abierta hasta el ConnectionOpened.
    expect(run.registry.openConditionTypes()).toEqual(['persistence_unavailable']);
    expect(run.ingestor.state).toBe('paused');
    now = REOPENED_AT;
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_B, id(3), REOPENED_AT, CONNECTION_A));
    expect(run.registry.openConditionTypes()).toEqual([]);
    expect(run.ingestor.state).toBe('accepting');
  });
});

// Lo que la sesión sigue para su cursor, su latido y la retención (ADR-0015 §6 y §7).
describe('RawFirstIngestor: onDurable', () => {
  const OPENED_AT = '2026-01-01T00:00:01.000Z';
  const DETECTION = '2026-01-01T00:00:30.000Z';

  const tickFrame = (observationId: string) => ({
    connection_id: CONNECTION_A,
    observation_id: observationId,
    payload_utf8: tickPayload(1767225601),
    received_at_utc: '2026-01-01T00:00:01.100Z',
  });

  it('recibe en orden cada source event que el ingestor hizo durable, también el cierre reparado, y nunca uno que no quedó durable', async () => {
    let now = OPENED_AT;
    const durable: SourceEvent[] = [];
    const run = await harness({ now: () => now, onDurable: (event) => durable.push(event) });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await run.ingestor.receiveFrame(tickFrame(id(2)));
    run.objects.armNextPutFailure('synthetic_injected_failure');
    await run.ingestor.receiveFrame(tickFrame(id(3)));
    now = DETECTION;
    await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] });

    expect(durable).toEqual((await storedEvents(run)).map((item) => item.event));
    expect(
      durable.map((event) =>
        event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
      ),
    ).toEqual([id(1), id(2), id(9001)]);
  });

  it('un evento que el índice confirmó aunque informó error no pasa por él: el log lo adopta al reabrirse', async () => {
    let now = OPENED_AT;
    const durable: string[] = [];
    const run = await harness({
      now: () => now,
      onDurable: (event) =>
        durable.push(event.kind === 'raw_source_frame' ? event.observation_id : event.event_id),
    });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    run.sourceLog.failIndexAfterInsert = (row) => row.event_id === id(2);
    await run.ingestor.receiveFrame(tickFrame(id(2)));
    run.sourceLog.failIndexAfterInsert = () => false;
    now = DETECTION;
    await run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] });

    expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual([id(1), id(2), id(9001)]);
    expect(durable).toEqual([id(1), id(9001)]);
  });
});

// Cada segmento cerrado de forma durable, para el punto de control del estado vivo (ADR-0017 §5).
describe('RawFirstIngestor: onSegmentClosed', () => {
  const frameAt = (observationId: string, receivedAt: string) => ({
    connection_id: CONNECTION_A,
    observation_id: observationId,
    payload_utf8: tickPayload(1767225601),
    received_at_utc: receivedAt,
  });

  it('recibe en orden cada segmento que el ingestor cerró, al rotar antes de un evento y con rotate, y nunca uno que no quedó durable', async () => {
    const closed: ClosedSourceSegment[] = [];
    const run = await harness({ onSegmentClosed: (segment) => closed.push(segment) });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), '2026-01-01T00:00:00.000Z'));
    // Cinco minutos después del primero: la ventana cierra el segmento 0 antes del frame.
    await run.ingestor.receiveFrame(frameAt(id(2), '2026-01-01T00:05:00.000Z'));
    expect(closed).toEqual([run.sourceLog.closed[0]]);
    // Un cierre que no queda durable no pasa por aquí.
    run.sourceLog.failClose = true;
    expect(await run.ingestor.rotate('requested')).toMatchObject({ status: 'not_durable' });
    expect(closed).toHaveLength(1);
    run.sourceLog.failClose = false;
    await run.ingestor.receiveEvent(
      openedEvent(CONNECTION_B, id(3), '2026-01-01T00:05:01.000Z', CONNECTION_A),
    );
    expect(await run.ingestor.rotate('requested')).toMatchObject({ status: 'closed' });
    // El vacío no se cierra.
    expect(await run.ingestor.rotate('requested')).toEqual({ segment: null, status: 'closed' });
    expect(closed).toEqual(run.sourceLog.closed);
    expect(closed.map((segment) => segment.segment_index)).toEqual([0, 1]);
  });
});

// Reabrir el log que falló (runbook, «Almacenamiento no disponible»): un almacén que no responde se
// reintenta, pero un contenido que no pasa sus comprobaciones no (ADR-0004 §12).
describe('RawFirstIngestor: reabrir el log que falló', () => {
  const OPENED_AT = '2026-01-01T00:00:01.000Z';
  const REOPENED_AT = '2026-01-01T00:00:31.000Z';

  const tickFrame = (observationId: string) => ({
    connection_id: CONNECTION_A,
    observation_id: observationId,
    payload_utf8: tickPayload(1767225601),
    received_at_utc: '2026-01-01T00:00:01.100Z',
  });

  /** La entrada falló: su apertura y un tick quedaron durables; el segundo tick, no. */
  async function failedLog() {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await run.ingestor.receiveFrame(tickFrame(id(2)));
    run.objects.armNextPutFailure('synthetic_injected_failure');
    expect(await run.ingestor.receiveFrame(tickFrame(id(3)))).toEqual({
      stage: 'raw_object_write',
      status: 'not_durable',
    });
    now = REOPENED_AT;
    return run;
  }

  type Run = Awaited<ReturnType<typeof failedLog>>;

  /** Las dos operaciones que reabren el log fallido antes de escribir. */
  const reopenWith = {
    receiveEvent: (run: Run) =>
      run.ingestor.receiveEvent(openedEvent(CONNECTION_B, id(4), REOPENED_AT, CONNECTION_A)),
    repairUnrecordedClose: (run: Run) =>
      run.ingestor.repairUnrecordedClose({ affected_symbols: ['SYNTH_100'] }),
  };

  /** Cambia el objeto del tick durable, `id(2)`, en el segmento abierto. */
  function changeTickObject(run: Run, change: (bytes: Uint8Array) => Uint8Array | null): void {
    const row = run.sourceLog.rows.find((item) => item.event_id === id(2));
    const key = contentKey(row?.object_sha256 ?? '');
    const changed = change(Uint8Array.from(run.objects.objects.get(key) ?? new Uint8Array()));
    if (changed === null) {
      run.objects.objects.delete(key);
    } else {
      run.objects.objects.set(key, changed);
    }
  }

  const corruptions = {
    alterado: (run: Run) => {
      changeTickObject(run, (bytes) => {
        bytes[2] = 0x41;
        return bytes;
      });
    },
    ausente: (run: Run) => {
      changeTickObject(run, () => null);
    },
  };

  it.each([
    ['alterado', 'receiveEvent'],
    ['alterado', 'repairUnrecordedClose'],
    ['ausente', 'receiveEvent'],
    ['ausente', 'repairUnrecordedClose'],
  ] as const)(
    'con el objeto de un evento del segmento abierto %s, %s se rechaza con LogIntegrityError sin registrar otro persistence_unavailable',
    async (corruption, operation) => {
      const run = await failedLog();
      corruptions[corruption](run);

      await expect(reopenWith[operation](run)).rejects.toThrow(LogIntegrityError);
      // Solo la incidencia del fallo de escritura: el contenido no confiable no se reintenta.
      expect(run.operational.incidents).toEqual([
        expect.objectContaining({
          evidence: { reason: 'synthetic_injected_failure', stage: 'raw_object_write' },
          incident_type: 'persistence_unavailable',
          observed_ref: id(3),
        }),
      ]);
      expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual([id(1), id(2)]);
      expect(run.ingestor.state).toBe('paused');
    },
  );

  it.each(['receiveEvent', 'repairUnrecordedClose'] as const)(
    'un error al reabrir que no viene de un almacén ni del contenido, como uno de programación, hace que %s se rechace sin registrar otro persistence_unavailable',
    async (operation) => {
      const run = await failedLog();
      const bug = new TypeError('sintético');
      vi.spyOn(SourceEventLog, 'open').mockRejectedValueOnce(bug);

      // No dice que el almacenamiento no esté disponible: reintentarlo como una pausa ocultaría el
      // error.
      await expect(reopenWith[operation](run)).rejects.toBe(bug);
      expect(run.operational.incidents).toEqual([expect.objectContaining({ observed_ref: id(3) })]);
      expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual([id(1), id(2)]);
      expect(run.ingestor.state).toBe('paused');
    },
  );

  it('readDurableSegments da null con el log fallido, sin reabrirlo; con el log reabierto, da sus eventos durables', async () => {
    const run = await failedLog();
    const open = vi.spyOn(SourceEventLog, 'open');

    expect(await run.ingestor.readDurableSegments()).toBeNull();
    expect(open).not.toHaveBeenCalled();
    await reopenWith.receiveEvent(run);
    const segments = await run.ingestor.readDurableSegments();
    expect(
      segments
        ?.flat()
        .map((event) =>
          event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
        ),
    ).toEqual([id(1), id(2), id(4)]);
  });

  it('rotate no reabre el log fallido: devuelve input_closed sin cerrar el segmento', async () => {
    const run = await failedLog();
    const open = vi.spyOn(SourceEventLog, 'open');

    expect(await run.ingestor.rotate('requested')).toEqual({ status: 'input_closed' });
    expect(open).not.toHaveBeenCalled();
    expect(run.sourceLog.closed).toEqual([]);
    expect(run.ingestor.state).toBe('paused');
  });

  // La reparación con un almacén que no responde al reabrir está en «si no puede reabrir el log».
  it('si un almacén no responde al reabrir, receiveEvent registra persistence_unavailable y no queda durable', async () => {
    const run = await failedLog();
    run.objects.onRead = () => {
      throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
    };

    expect(await reopenWith.receiveEvent(run)).toEqual({
      stage: 'source_event_index',
      status: 'not_durable',
    });
    expect(run.operational.incidents.at(-1)).toMatchObject({
      evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
      incident_type: 'persistence_unavailable',
      // La apertura que no quedó durable.
      observed_ref: id(4),
    });
    expect(run.operational.incidents).toHaveLength(2);
  });
});

// Un log desactualizado no falló: la sesión lo marca así después de tomar un bloqueo nuevo, porque
// en los segundos que tardó en notarse la pérdida otro proceso pudo escribir (ADR-0015 §3,
// «Conexión anterior»). Lo que use el log lo reabre antes, sin incidencia; un log fallido, en cambio,
// sigue cerrado como hasta ahora.
describe('RawFirstIngestor.markLogStale: el log desactualizado se reabre antes de usarlo', () => {
  const OPENED_AT = '2026-01-01T00:00:01.000Z';
  const OTHER_AT = '2026-01-01T00:00:02.000Z';
  const LATER = '2026-01-01T00:00:03.000Z';

  /**
   * La entrada abrió la conexión A. Después otro escritor, con el bloqueo que esta instancia perdió,
   * añade el cierre de A al segmento abierto, y la instancia queda marcada como desactualizada.
   */
  async function staleLog() {
    let now = OPENED_AT;
    const run = await harness({ now: () => now });
    await run.ingestor.receiveEvent(openedEvent(CONNECTION_A, id(1), OPENED_AT));
    await (await run.openLog()).append(closedEvent(CONNECTION_A, id(2), OTHER_AT));
    run.ingestor.markLogStale();
    now = LATER;
    return run;
  }

  type Run = Awaited<ReturnType<typeof staleLog>>;

  const tickFrame = {
    connection_id: CONNECTION_A,
    observation_id: id(3),
    payload_utf8: tickPayload(1767225601),
    received_at_utc: LATER,
  };

  it.each<[string, (run: Run) => Promise<unknown>, unknown, string[], number]>([
    [
      'receiveFrame escribe el frame después del evento del otro escritor',
      (run) => run.ingestor.receiveFrame(tickFrame),
      { position: 2, segment_index: 0, status: 'durable' },
      [id(1), id(2), id(3)],
      0,
    ],
    [
      'receiveEvent escribe el evento después del evento del otro escritor',
      (run) => run.ingestor.receiveEvent(openedEvent(CONNECTION_B, id(3), LATER, CONNECTION_A)),
      { position: 2, segment_index: 0, status: 'durable' },
      [id(1), id(2), id(3)],
      0,
    ],
    [
      'readDurableSegments da también el evento del otro escritor',
      (run) => run.ingestor.readDurableSegments(),
      [[openedEvent(CONNECTION_A, id(1), OPENED_AT), closedEvent(CONNECTION_A, id(2), OTHER_AT)]],
      [id(1), id(2)],
      0,
    ],
    [
      'rotate cierra el segmento con el evento del otro escritor',
      (run) => run.ingestor.rotate('requested'),
      {
        segment: expect.objectContaining({
          close_reason: 'requested',
          event_count: 2,
          segment_index: 0,
        }) as unknown,
        status: 'closed',
      },
      [id(1), id(2)],
      1,
    ],
  ])(
    'lo reabre antes, sin incidencia: %s',
    async (_label, operation, expected, rows, closedSegments) => {
      const run = await staleLog();

      expect(await operation(run)).toEqual(expected);
      expect(run.sourceLog.rows.map((row) => row.event_id)).toEqual(rows);
      expect(run.sourceLog.closed).toHaveLength(closedSegments);
      expect(run.operational.incidents).toEqual([]);
      expect(run.registry.openConditionTypes()).toEqual([]);
      expect(run.ingestor.state).toBe('accepting');
    },
  );

  it('si un almacén no responde al reabrirlo, receiveFrame no escribe el frame y registra persistence_unavailable con su observation_id', async () => {
    const run = await staleLog();
    run.objects.onRead = () => {
      throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
    };

    expect(await run.ingestor.receiveFrame(tickFrame)).toEqual({
      stage: 'source_event_index',
      status: 'not_durable',
    });
    expect(run.ticks).toEqual([]);
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
        incident_type: 'persistence_unavailable',
        observed_ref: id(3),
      }),
    ]);
    expect(run.ingestor.state).toBe('paused');
  });

  it('si un almacén no responde al reabrirlo, readDurableSegments da null y registra persistence_unavailable, como tras un fallo: la lectura siguiente ya no lo reabre', async () => {
    const run = await staleLog();
    run.objects.onRead = () => {
      throw Object.assign(new Error('sintético'), { code: 'ECONNREFUSED' });
    };

    expect(await run.ingestor.readDurableSegments()).toBeNull();
    expect(run.operational.incidents).toEqual([
      expect.objectContaining({
        evidence: { reason: 'ECONNREFUSED', stage: 'source_event_index' },
        incident_type: 'persistence_unavailable',
        // La lectura no tiene evento propio: el ID del intento.
        observed_ref: id(9001),
      }),
    ]);
    expect(run.ingestor.state).toBe('paused');
    const open = vi.spyOn(SourceEventLog, 'open');
    expect(await run.ingestor.readDurableSegments()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
