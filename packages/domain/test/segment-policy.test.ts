import { rawSourceFrameSchema, sha256Hex, type SourceEvent } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  appendSegmentStats,
  EMPTY_SEGMENT_STATS,
  evaluateSegmentRotation,
  SEGMENT_POLICY,
  sourceEventLine,
  sourceEventTime,
  type SegmentStats,
} from '../src/index.js';

// Casos derivados de ADR-0004 §7 y ADR-0005 §5 (segment_policy_version 1.0.0).
const CONNECTION = '019b76da-a800-7000-8000-00000000a000';

function raw(sequence: number, receivedAt: string, payload = '{"msg_type":"tick"}'): SourceEvent {
  return rawSourceFrameSchema.parse({
    connection_id: CONNECTION,
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`,
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: receivedAt,
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

const closed: SourceEvent = {
  affected_symbols: ['SYNTH_100'],
  closure_type: 'remote',
  connection_id: CONNECTION,
  event_id: '019b76da-a800-7000-8000-0000000000c1',
  kind: 'connection_closed',
  occurred_at_utc: '2026-01-01T00:04:59.999Z',
  reason: 'remote_close',
  schema_version: '1.0.0',
  source: 'synthetic',
};

function stats(partial: Partial<SegmentStats>): SegmentStats {
  return {
    byte_count: 100,
    event_count: 1,
    first_event_time_utc: '2026-01-01T00:00:00.000Z',
    raw_frame_count: 1,
    ...partial,
  };
}

describe('segment_policy_version 1.0.0', () => {
  it('fija los umbrales de ADR-0004 §7', () => {
    expect(SEGMENT_POLICY).toEqual({
      maximum_bytes: 67_108_864,
      maximum_raw_frames: 10_000,
      version: '1.0.0',
      window_ms: 300_000,
    });
  });

  it('acumula bytes NDJSON lógicos (línea JCS más newline), frames y primer tiempo', () => {
    const first = raw(1, '2026-01-01T00:00:00.000Z');
    const afterFirst = appendSegmentStats(EMPTY_SEGMENT_STATS, first);
    const afterSecond = appendSegmentStats(afterFirst, closed);
    expect(afterSecond).toEqual({
      byte_count: sourceEventLine(first).byteLength + sourceEventLine(closed).byteLength + 2,
      event_count: 2,
      first_event_time_utc: '2026-01-01T00:00:00.000Z',
      raw_frame_count: 1,
    });
    expect(sourceEventTime(first)).toBe('2026-01-01T00:00:00.000Z');
    expect(sourceEventTime(closed)).toBe('2026-01-01T00:04:59.999Z');
  });

  it('un segmento vacío nunca rota', () => {
    expect(
      evaluateSegmentRotation(EMPTY_SEGMENT_STATS, raw(1, '2030-01-01T00:00:00.000Z')),
    ).toBeNull();
  });

  it('rota por bytes antes de superar el máximo', () => {
    const event = raw(2, '2026-01-01T00:00:01.000Z');
    const line = sourceEventLine(event).byteLength + 1;
    expect(
      evaluateSegmentRotation(stats({ byte_count: SEGMENT_POLICY.maximum_bytes - line }), event),
    ).toBeNull();
    expect(
      evaluateSegmentRotation(
        stats({ byte_count: SEGMENT_POLICY.maximum_bytes - line + 1 }),
        event,
      ),
    ).toBe('bytes');
  });

  it('rota antes del frame 10 001 y no cuenta eventos que no son raw', () => {
    const full = stats({ raw_frame_count: 10_000, event_count: 10_000 });
    expect(
      evaluateSegmentRotation(
        stats({ raw_frame_count: 9_999 }),
        raw(2, '2026-01-01T00:00:01.000Z'),
      ),
    ).toBeNull();
    expect(evaluateSegmentRotation(full, raw(2, '2026-01-01T00:00:01.000Z'))).toBe('raw_frames');
    expect(evaluateSegmentRotation(full, closed)).toBeNull();
  });

  it('rota cuando el evento llega 5 minutos o más después del primero del segmento', () => {
    expect(evaluateSegmentRotation(stats({}), raw(2, '2026-01-01T00:04:59.999Z'))).toBeNull();
    expect(evaluateSegmentRotation(stats({}), raw(2, '2026-01-01T00:05:00.000Z'))).toBe('window');
    // Para eventos que no son raw cuenta occurred_at_utc.
    expect(
      evaluateSegmentRotation(stats({}), {
        ...closed,
        occurred_at_utc: '2026-01-01T00:05:00.000Z',
      }),
    ).toBe('window');
  });

  it('con varios umbrales a la vez informa bytes, luego frames, luego ventana', () => {
    const late = raw(2, '2026-01-01T01:00:00.000Z');
    expect(
      evaluateSegmentRotation(
        stats({ byte_count: SEGMENT_POLICY.maximum_bytes, raw_frame_count: 10_000 }),
        late,
      ),
    ).toBe('bytes');
    expect(evaluateSegmentRotation(stats({ raw_frame_count: 10_000 }), late)).toBe('raw_frames');
  });

  it('rechaza un evento que no cabe ni en un segmento vacío', () => {
    const huge = raw(3, '2026-01-01T00:00:00.000Z', 'x'.repeat(SEGMENT_POLICY.maximum_bytes));
    expect(() => evaluateSegmentRotation(EMPTY_SEGMENT_STATS, huge)).toThrow(/segmento vacío/u);
  });
});
