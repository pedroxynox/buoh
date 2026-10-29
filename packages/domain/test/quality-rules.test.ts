import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rawSourceFrameSchema, sha256Hex } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  canonicalQuoteDecimal,
  createPipelineProfile,
  deriveHealthReport,
  deriveMarketData,
  evaluateSourceLimit,
  ingestSyntheticStimuli,
  isEpochSecondsLexeme,
  isPipSizeLexeme,
  normalizeRawFrame,
  parseJsonPreservingNumbers,
  pipSizeFromNumberLexeme,
  type PipelineProfile,
} from '../src/index.js';

// Casos derivados de ADR-0004 §7/§10 y de las transiciones de contratos de dominio que el vector
// v1 no ejercita. Usan el esquema y perfil sintéticos firmados.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');

const profile: PipelineProfile = createPipelineProfile({
  connector_version: 'fixture-v1',
  quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
  source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
  source_schema_release: 'synthetic-v1',
});

const CONNECTION_A = '019b76da-a800-7000-8000-00000000a000';
const CONNECTION_B = '019b76da-a800-7000-8000-00000000b000';

function id(suffix: number): string {
  return `019b76da-a800-7000-8000-${suffix.toString().padStart(12, '0')}`;
}

function frame(sequence: number, connection: string, payload: string, receivedAt: string) {
  return {
    connection_id: connection,
    fixture_sequence: sequence,
    kind: 'source_frame',
    observation_id: id(sequence),
    payload_utf8: payload,
    received_at_utc: receivedAt,
  };
}

function tickPayload(epoch: number, quote: string): string {
  return `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":${quote},"symbol":"SYNTH_100"}}`;
}

function persisted(stimuli: unknown[]) {
  const result = ingestSyntheticStimuli(stimuli, profile);
  if (result.status !== 'persisted') {
    throw new TypeError('Se esperaba persistencia completa.');
  }
  return result.segments;
}

function rawFrame(payload: string) {
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION_A,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: id(1),
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: '2026-01-01T00:00:00.100Z',
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

describe('normalizador 1.0.0', () => {
  it('conserva el lexema y completa ceros hasta pip_size sin aritmética binaria', () => {
    const result = normalizeRawFrame(rawFrame(tickPayload(1767225600, '100.13')), profile);
    expect(result.ok && result.tick.quote_decimal).toBe('100.130');
    const exact = normalizeRawFrame(rawFrame(tickPayload(1767225600, '100.130')), profile);
    expect(exact.ok && exact.tick.quote_decimal).toBe('100.130');
  });

  it.each([
    [
      'más decimales que pip_size',
      tickPayload(1767225600, '100.1301'),
      'quote_precision_exceeds_pip_size',
    ],
    ['exponente', tickPayload(1767225600, '1.0013e2'), 'quote_exponent_not_supported'],
    ['JSON inválido', '{"msg_type":"tick",', 'payload_not_json'],
    [
      'clave duplicada',
      '{"msg_type":"tick","msg_type":"tick","tick":{"epoch":1,"pip_size":3,"quote":1.000,"symbol":"SYNTH_100"}}',
      'payload_not_json',
    ],
    [
      'esquema',
      '{"msg_type":"tick","tick":{"epoch":1,"quote":1,"symbol":"SYNTH_100"}}',
      'schema_validation_failed',
    ],
  ])('rechaza %s sin alterar el raw', (_label, payload, reason) => {
    const result = normalizeRawFrame(rawFrame(payload), profile);
    expect(result).toEqual({ ok: false, reason, symbol: 'SYNTH_100' });
  });

  it('el parser conserva lexemas y rechaza contenido posterior', () => {
    expect(parseJsonPreservingNumbers('[100.130]')).toEqual({
      items: [{ lexeme: '100.130', type: 'number' }],
      type: 'array',
    });
    expect(() => parseJsonPreservingNumbers('{} {}')).toThrow();
  });
});

describe('canonicalQuoteDecimal (la regla de quote_decimal)', () => {
  it.each([
    ['100.13', 3, '100.130'],
    ['100.130', 3, '100.130'],
    ['100', 2, '100.00'],
    ['-0.5', 2, '-0.50'],
    ['7', 0, '7'],
  ])('%s con pip_size %d da %s, sin aritmética binaria', (lexeme, pipSize, value) => {
    expect(canonicalQuoteDecimal(lexeme, pipSize)).toEqual({ ok: true, value });
  });

  it.each([
    ['100.1301', 3, 'quote_precision_exceeds_pip_size'],
    ['100.0', 0, 'quote_precision_exceeds_pip_size'],
    ['1.0013e2', 3, 'quote_exponent_not_supported'],
    ['1E2', 2, 'quote_exponent_not_supported'],
  ])('rechaza %s con pip_size %d (%s)', (lexeme, pipSize, reason) => {
    expect(canonicalQuoteDecimal(lexeme, pipSize)).toEqual({ ok: false, reason });
  });
});

describe('isPipSizeLexeme e isEpochSecondsLexeme (reglas de lexema de ADR-0004 §4)', () => {
  it.each(['0', '2', '18'])('acepta el pip_size %s: entero de 0 a 18', (lexeme) => {
    expect(isPipSizeLexeme(lexeme)).toBe(true);
  });

  it.each(['19', '-1', '2.0', '2.5', '02', '2e0', '1E1', ''])(
    'rechaza el pip_size %s',
    (lexeme) => {
      expect(isPipSizeLexeme(lexeme)).toBe(false);
    },
  );

  it.each(['0', '1767225600', '-1'])('acepta el epoch %s: entero de segundos', (lexeme) => {
    expect(isEpochSecondsLexeme(lexeme)).toBe(true);
  });

  it.each(['1767225600.0', '1767225600.5', '01767225600', '1.7672256e9', '-0.0', ''])(
    'rechaza el epoch %s: sin fracción, exponente ni ceros a la izquierda',
    (lexeme) => {
      expect(isEpochSecondsLexeme(lexeme)).toBe(false);
    },
  );

  it('el normalizador aplica las mismas reglas a un tick, aunque el esquema de fuente los admita', () => {
    // El esquema pide enteros, y 3.0 y 1767225600.0 lo son; sus lexemas no.
    const pipFraction = `{"msg_type":"tick","tick":{"epoch":1767225600,"pip_size":3.0,"quote":1,"symbol":"SYNTH_100"}}`;
    expect(normalizeRawFrame(rawFrame(pipFraction), profile)).toEqual({
      ok: false,
      reason: 'schema_validation_failed',
      symbol: 'SYNTH_100',
    });
    const fraction = `{"msg_type":"tick","tick":{"epoch":1767225600.0,"pip_size":3,"quote":1,"symbol":"SYNTH_100"}}`;
    expect(normalizeRawFrame(rawFrame(fraction), profile)).toEqual({
      ok: false,
      reason: 'event_time_out_of_range',
      symbol: 'SYNTH_100',
    });
  });
});

describe('pipSizeFromNumberLexeme (el pip_size de una respuesta de historia, ADR-0015 §4)', () => {
  it.each([
    ['2', 2],
    ['2.0', 2],
    ['18.00', 18],
    ['0', 0],
    ['0.0', 0],
  ])('acepta %s y da %d: valor entero de 0 a 18, con o sin fracción de ceros', (lexeme, value) => {
    expect(pipSizeFromNumberLexeme(lexeme)).toBe(value);
  });

  it.each(['2.5', '19', '19.0', '-2', '2e0', '02', '2.'])('rechaza %s', (lexeme) => {
    expect(pipSizeFromNumberLexeme(lexeme)).toBeNull();
  });
});

describe('reglas de conexión y continuidad', () => {
  it('un cierre solicitado no crea incidencia ni condición', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      {
        affected_symbols: ['SYNTH_100'],
        closure_type: 'requested',
        connection_id: CONNECTION_A,
        event_id: id(2),
        fixture_sequence: 2,
        kind: 'connection_closed',
        occurred_at_utc: '2026-01-01T00:00:01.000Z',
        reason: 'operator_shutdown',
      },
    ]);
    const derived = deriveMarketData(segments, profile);
    expect(derived.incidents).toEqual([]);
    expect(derived.conditions).toEqual([]);
  });

  it('partial abre el hueco y complete del mismo rango lo resuelve sin reescribir incidencias', () => {
    const range = {
      from_event_time_utc: '2026-01-01T00:00:00.001Z',
      symbol: 'SYNTH_100',
      to_event_time_utc: '2026-01-01T00:00:04.999Z',
    };
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      {
        affected_symbols: ['SYNTH_100'],
        closure_type: 'remote',
        connection_id: CONNECTION_A,
        event_id: id(2),
        fixture_sequence: 2,
        kind: 'connection_closed',
        occurred_at_utc: '2026-01-01T00:00:01.000Z',
        reason: 'remote_close',
      },
      {
        connection_id: CONNECTION_B,
        event_id: id(3),
        fixture_sequence: 3,
        kind: 'connection_opened',
        occurred_at_utc: '2026-01-01T00:00:05.000Z',
        supersedes_connection_id: CONNECTION_A,
      },
      frame(4, CONNECTION_B, tickPayload(1767225605, '100.150'), '2026-01-01T00:00:05.100Z'),
      {
        ...range,
        connection_id: CONNECTION_B,
        event_id: id(5),
        fixture_sequence: 5,
        kind: 'history_recovery_result',
        occurred_at_utc: '2026-01-01T00:00:05.200Z',
        reason: 'partial_history',
        recovered_event_count: 1,
        status: 'partial',
      },
      {
        ...range,
        connection_id: CONNECTION_B,
        event_id: id(6),
        fixture_sequence: 6,
        kind: 'history_recovery_result',
        occurred_at_utc: '2026-01-01T00:00:05.300Z',
        recovered_event_count: 4,
        status: 'complete',
      },
    ]);
    const derived = deriveMarketData(segments, profile);

    expect(derived.incidents.map((incident) => incident.incident_type)).toEqual([
      'connection_lost',
      'event_gap_unresolved',
    ]);
    expect(
      derived.conditions.map((condition) => [condition.condition_type, condition.action]),
    ).toEqual([
      ['connection_lost', 'opened'],
      ['connection_lost', 'resolved'],
      ['event_gap_unresolved', 'opened'],
      ['event_gap_unresolved', 'resolved'],
    ]);
    expect(derived.openConditionTypes).toEqual([]);
    expect(derived.ticks.find((tick) => tick.observation_id === id(4))?.quality_flags).toEqual([
      'event_gap_unresolved',
    ]);

    const health = deriveHealthReport({
      backlog_bytes: 0,
      backlog_count: 0,
      derived,
      last_published_dataset_id: null,
      source: 'synthetic',
      sourceEvents: segments.flat(),
    });
    expect(health.service_health).toBe('healthy');
  });
});

describe('continuidad tras reconexión (gap_detection = after_reconnection)', () => {
  function reconnection(firstEpochAfter: number) {
    return persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      {
        affected_symbols: ['SYNTH_100'],
        closure_type: 'timeout',
        connection_id: CONNECTION_A,
        event_id: id(2),
        fixture_sequence: 2,
        kind: 'connection_closed',
        occurred_at_utc: '2026-01-01T00:00:00.500Z',
        reason: 'heartbeat_timeout',
      },
      {
        connection_id: CONNECTION_B,
        event_id: id(3),
        fixture_sequence: 3,
        kind: 'connection_opened',
        occurred_at_utc: '2026-01-01T00:00:00.600Z',
        supersedes_connection_id: CONNECTION_A,
      },
      frame(
        4,
        CONNECTION_B,
        tickPayload(firstEpochAfter, '100.150'),
        new Date(firstEpochAfter * 1000 + 100).toISOString(),
      ),
    ]);
  }

  function healthOf(segments: ReturnType<typeof persisted>) {
    return deriveHealthReport({
      backlog_bytes: 0,
      backlog_count: 0,
      derived: deriveMarketData(segments, profile),
      last_published_dataset_id: null,
      source: 'synthetic',
      sourceEvents: segments.flat(),
    }).service_health;
  }

  it('un hueco mayor que el umbral sin HistoryRecoveryResult deja continuidad pendiente', () => {
    const segments = reconnection(1767225609);
    const derived = deriveMarketData(segments, profile);
    expect(derived.pendingContinuitySymbols).toEqual(['SYNTH_100']);
    expect(derived.incidents.map((incident) => incident.incident_type)).toEqual([
      'connection_lost',
    ]);
    expect(healthOf(segments)).toBe('recovering');
  });

  const close = (sequence: number, connection: string, at: string) => ({
    affected_symbols: ['SYNTH_100'],
    closure_type: 'transport_error',
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_closed',
    occurred_at_utc: at,
    reason: 'reset',
  });
  const open = (sequence: number, connection: string, supersedes: string, at: string) => ({
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_opened',
    occurred_at_utc: at,
    supersedes_connection_id: supersedes,
  });
  const CONNECTION_C = '019b76da-a800-7000-8000-00000000c000';

  it('un segundo cierre no borra un hueco ya detectado', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      close(2, CONNECTION_A, '2026-01-01T00:00:00.500Z'),
      open(3, CONNECTION_B, CONNECTION_A, '2026-01-01T00:00:00.600Z'),
      frame(4, CONNECTION_B, tickPayload(1767225609, '100.150'), '2026-01-01T00:00:09.100Z'),
      close(5, CONNECTION_B, '2026-01-01T00:00:09.500Z'),
      open(6, CONNECTION_C, CONNECTION_B, '2026-01-01T00:00:09.600Z'),
      frame(7, CONNECTION_C, tickPayload(1767225610, '100.160'), '2026-01-01T00:00:10.100Z'),
    ]);
    expect(deriveMarketData(segments, profile).pendingContinuitySymbols).toEqual(['SYNTH_100']);
    expect(healthOf(segments)).toBe('recovering');
  });

  it('una recuperación que cubre solo el primer hueco no demuestra el segundo', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      close(2, CONNECTION_A, '2026-01-01T00:00:00.500Z'),
      open(3, CONNECTION_B, CONNECTION_A, '2026-01-01T00:00:00.600Z'),
      frame(4, CONNECTION_B, tickPayload(1767225609, '100.150'), '2026-01-01T00:00:09.100Z'),
      frame(5, CONNECTION_B, tickPayload(1767225610, '100.155'), '2026-01-01T00:00:10.100Z'),
      close(6, CONNECTION_B, '2026-01-01T00:00:10.500Z'),
      open(7, CONNECTION_C, CONNECTION_B, '2026-01-01T00:00:10.600Z'),
      frame(8, CONNECTION_C, tickPayload(1767225630, '100.160'), '2026-01-01T00:00:30.100Z'),
      {
        connection_id: CONNECTION_C,
        event_id: id(9),
        fixture_sequence: 9,
        from_event_time_utc: '2026-01-01T00:00:00.001Z',
        kind: 'history_recovery_result',
        occurred_at_utc: '2026-01-01T00:00:30.200Z',
        recovered_event_count: 8,
        status: 'complete',
        symbol: 'SYNTH_100',
        to_event_time_utc: '2026-01-01T00:00:08.999Z',
      },
    ]);
    expect(deriveMarketData(segments, profile).pendingContinuitySymbols).toEqual(['SYNTH_100']);
    expect(healthOf(segments)).toBe('recovering');
  });

  it('un tick atrasado tras un segundo cierre no demuestra un hueco ya excedido', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      close(2, CONNECTION_A, '2026-01-01T00:00:00.500Z'),
      open(3, CONNECTION_B, CONNECTION_A, '2026-01-01T00:00:00.600Z'),
      frame(4, CONNECTION_B, tickPayload(1767225609, '100.150'), '2026-01-01T00:00:09.100Z'),
      close(5, CONNECTION_B, '2026-01-01T00:00:09.500Z'),
      open(6, CONNECTION_C, CONNECTION_B, '2026-01-01T00:00:09.600Z'),
      frame(7, CONNECTION_C, tickPayload(1767225601, '100.130'), '2026-01-01T00:00:09.700Z'),
    ]);
    expect(deriveMarketData(segments, profile).pendingContinuitySymbols).toEqual(['SYNTH_100']);
    expect(healthOf(segments)).toBe('recovering');
  });

  it('un tick no posterior al high-watermark no demuestra continuidad', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225601, '100.125'), '2026-01-01T00:00:01.100Z'),
      close(2, CONNECTION_A, '2026-01-01T00:00:01.500Z'),
      open(3, CONNECTION_B, CONNECTION_A, '2026-01-01T00:00:01.600Z'),
      frame(4, CONNECTION_B, tickPayload(1767225600, '100.120'), '2026-01-01T00:00:01.700Z'),
      frame(5, CONNECTION_B, tickPayload(1767225601, '100.125'), '2026-01-01T00:00:01.800Z'),
      frame(6, CONNECTION_B, tickPayload(1767225611, '100.170'), '2026-01-01T00:00:11.100Z'),
    ]);
    expect(deriveMarketData(segments, profile).pendingContinuitySymbols).toEqual(['SYNTH_100']);
  });

  it('solo una recuperación que cubre el hueco lo decide', () => {
    const recovery = (sequence: number, from: string, to: string) => ({
      connection_id: CONNECTION_B,
      event_id: id(sequence),
      fixture_sequence: sequence,
      from_event_time_utc: from,
      kind: 'history_recovery_result',
      occurred_at_utc: '2026-01-01T00:00:09.200Z',
      recovered_event_count: 0,
      status: 'complete',
      symbol: 'SYNTH_100',
      to_event_time_utc: to,
    });
    const base = [
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
      close(2, CONNECTION_A, '2026-01-01T00:00:00.500Z'),
      open(3, CONNECTION_B, CONNECTION_A, '2026-01-01T00:00:00.600Z'),
      frame(4, CONNECTION_B, tickPayload(1767225609, '100.150'), '2026-01-01T00:00:09.100Z'),
    ];
    const unrelated = persisted([
      ...base,
      recovery(5, '2026-01-01T00:00:00.001Z', '2026-01-01T00:00:03.000Z'),
    ]);
    expect(deriveMarketData(unrelated, profile).pendingContinuitySymbols).toEqual(['SYNTH_100']);

    const covering = persisted([
      ...base,
      recovery(5, '2026-01-01T00:00:00.001Z', '2026-01-01T00:00:08.999Z'),
    ]);
    expect(deriveMarketData(covering, profile).pendingContinuitySymbols).toEqual([]);
    expect(healthOf(covering)).toBe('healthy');
  });

  it('una separación dentro del umbral demuestra continuidad', () => {
    const segments = reconnection(1767225602);
    expect(deriveMarketData(segments, profile).pendingContinuitySymbols).toEqual([]);
    expect(healthOf(segments)).toBe('healthy');
  });
});

describe('versiones y harness', () => {
  it('aborta ante source events de otra schema_version', () => {
    const [segment = []] = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
    ]);
    const altered = segment.map((event) => ({ ...event, schema_version: '2.0.0' }));
    expect(() => deriveMarketData([altered], profile)).toThrow(/schema_version 2\.0\.0/u);
  });

  it('aborta si un fallo armado no se consume', () => {
    expect(() =>
      ingestSyntheticStimuli(
        [
          {
            fault_id: id(9),
            fixture_sequence: 1,
            kind: 'persistence_fault_armed',
            occurred_at_utc: '2026-01-01T00:00:00.050Z',
            reason: 'synthetic_injected_failure',
            scope: 'next_raw_object_write',
            stage: 'raw_object_write',
          },
        ],
        profile,
      ),
    ).toThrow(/no fue consumido/u);
  });

  it('exige epoch entero y pip_size 0..18 aunque el esquema de fuente sea más laxo', () => {
    const looseSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        tick: {
          properties: {
            epoch: { type: 'number' },
            pip_size: { type: 'integer' },
            quote: { type: 'number' },
            symbol: { type: 'string' },
          },
          required: ['epoch', 'pip_size', 'quote', 'symbol'],
          type: 'object',
        },
      },
      required: ['tick'],
      type: 'object',
    };
    const loose = createPipelineProfile({
      connector_version: 'fixture-v1',
      quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
      source_schema_bytes: Buffer.from(JSON.stringify(looseSchema)),
      source_schema_release: 'loose-test',
    });
    const payload = (epoch: string, pip: string) =>
      `{"tick":{"epoch":${epoch},"pip_size":${pip},"quote":100.125,"symbol":"SYNTH_100"}}`;
    expect(normalizeRawFrame(rawFrame(payload('1767225600.5', '3')), loose)).toMatchObject({
      ok: false,
      reason: 'event_time_out_of_range',
    });
    expect(normalizeRawFrame(rawFrame(payload('1767225600', '19')), loose)).toMatchObject({
      ok: false,
      reason: 'schema_validation_failed',
    });
  });
});

describe('límites de fuente (ADR-0004 §7)', () => {
  it('aplica unidad, máximo y salud por recurso', () => {
    expect(evaluateSourceLimit('websocket_frame', 1_048_576)).toBeNull();
    expect(evaluateSourceLimit('websocket_frame', 1_048_577)).toEqual({
      action: 'reject_frame_and_close_input',
      evidence: {
        maximum_value: 1_048_576,
        observed_value: 1_048_577,
        resource: 'websocket_frame',
        unit: 'bytes',
      },
      service_health: 'paused',
    });
    expect(evaluateSourceLimit('in_memory_queue_events', 1001)?.service_health).toBe('paused');
    expect(evaluateSourceLimit('schema_entries', 1001)).toMatchObject({
      evidence: { unit: 'entries' },
      service_health: 'failed',
    });
    expect(evaluateSourceLimit('schema_expanded', 52_428_801)?.service_health).toBe('failed');
  });

  it('una cola por encima del límite impide reportar healthy', () => {
    const segments = persisted([
      frame(1, CONNECTION_A, tickPayload(1767225600, '100.125'), '2026-01-01T00:00:00.100Z'),
    ]);
    const health = deriveHealthReport({
      backlog_bytes: 0,
      backlog_count: 1001,
      derived: deriveMarketData(segments, profile),
      last_published_dataset_id: null,
      source: 'synthetic',
      sourceEvents: segments.flat(),
    });
    expect(health.service_health).toBe('paused');
  });
});
