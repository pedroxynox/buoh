import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  rawSourceFrameSchema,
  sha256Hex,
  validateConditionCausality,
  type MarketTick,
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
  OperationalRegistry,
  publishFromLog,
  RawFirstIngestor,
  replayDataset,
  SourceEventLog,
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
  options: { operational?: MemoryOperationalStore; profile?: PipelineProfile } = {},
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
    now: () => DETECTED_AT,
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

  it('al reiniciar detecta el objeto alterado de un evento del segmento abierto', async () => {
    const { log, objects, open, store } = await freshLog();
    await log.append(raw(1, '2026-01-01T00:00:01.000Z'));
    const key = contentKey(store.rows[0]?.object_sha256 ?? '');
    const altered = Uint8Array.from(objects.objects.get(key) ?? new Uint8Array());
    altered[2] = 0x41;
    objects.objects.set(key, altered);
    await expect(open()).rejects.toThrow(/alterado/u);
  });

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

  it('el motivo de un fallo usa el código o nombre del error, nunca su mensaje', () => {
    const withCode = Object.assign(new Error('postgres://buoh:secreto@host'), {
      code: 'ECONNRESET',
    });
    expect(failureReason(withCode)).toBe('ECONNRESET');
    expect(failureReason(Object.assign(new Error('x'), { code: 'con espacios' }))).toBe('Error');
    expect(failureReason('texto')).toBe('unknown_error');
  });
});
