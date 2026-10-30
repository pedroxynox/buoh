import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import * as publicContracts from '../src/index.js';
import {
  deriveConnectionConditionKey,
  deriveEventId,
  LIVE_STATE_VERSION,
  liveDerivationCheckpointSchema,
  type JsonValue,
} from '../src/index.js';

// LiveDerivationCheckpoint (ADR-0017 §5 y §6; contratos de dominio, `LiveDerivationCheckpoint`).
const SOURCE = 'deriv_options';
const CONNECTION = '019b76da-a800-7000-8000-00000000a000';
const CLOSE_EVENT = '019b76da-a800-7000-8000-000000000002';
const TICK = '019b76da-a800-7000-8000-000000000001';
const SHA = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

const versions = {
  connector_version: 'deriv-options-ws-1.1.0',
  live_state_version: LIVE_STATE_VERSION,
  quality_profile_sha256: SHA,
  quality_rule_version: '2.0.0',
  segment_policy_version: '1.0.0',
  source_event_schema_version: '1.0.0',
  source_schema_sha256: SHA,
};

const emptyState = {
  connected_in_log: false,
  last_connection_event_time_utc: null,
  last_event_connection_id: null,
  last_raw: null,
  open_conditions: [],
  pending_continuity: [],
  previous_connection: null,
  symbol_not_allowed_seen: false,
  watermarks: [],
};

function checkpoint(state: Record<string, unknown> = emptyState) {
  return {
    event_count: 3,
    raw_frame_count: 1,
    schema_version: '1.0.0',
    segment_index: 0,
    segment_logical_content_sha256: SHA,
    source: SOURCE,
    state,
    symbol: 'R_100',
    versions,
  };
}

function withId<K extends string>(
  key: K,
  body: Record<string, unknown>,
): Record<string, unknown> & Record<K, string> {
  return { ...body, [key]: deriveEventId(body as JsonValue) } as Record<string, unknown> &
    Record<K, string>;
}

/** Una apertura `connection_lost` con su incidencia causal, como la deriva `deriveMarketData`. */
function openConnectionLost() {
  const incident = withId('incident_id', {
    evidence: { affected_symbols: ['R_100'], closure_type: 'timeout', reason: 'ping_timeout' },
    incident_type: 'connection_lost',
    observed_at_utc: '2026-01-01T00:00:00.500Z',
    observed_ref: CLOSE_EVENT,
    quality_rule_version: '2.0.0',
    related_refs: [],
    schema_version: '2.0.0',
    severity: 'warning',
    source: SOURCE,
    symbol: null,
  });
  const condition = withId('condition_event_id', {
    action: 'opened',
    cause_refs: [incident.incident_id],
    condition_key: deriveConnectionConditionKey(SOURCE, CONNECTION),
    condition_type: 'connection_lost',
    occurred_at_utc: '2026-01-01T00:00:00.500Z',
    schema_version: '1.0.0',
    source: SOURCE,
    symbol: null,
  });
  return { closed_connection_id: CONNECTION, condition, incident };
}

const watermark = {
  canonical_tick: {
    observation_id: TICK,
    quote_decimal: '100.12',
    tick_fingerprint_sha256: FINGERPRINT,
  },
  event_time_utc: '2026-01-01T00:00:00.000Z',
  observation_id: TICK,
  symbol: 'R_100',
};

describe('LiveDerivationCheckpoint (ADR-0017)', () => {
  it('acepta un punto de control con el estado vacío y otro con una condición abierta', () => {
    expect(liveDerivationCheckpointSchema.parse(checkpoint())).toEqual(checkpoint());

    const state = {
      ...emptyState,
      connected_in_log: false,
      last_connection_event_time_utc: '2026-01-01T00:00:00.500Z',
      last_event_connection_id: CONNECTION,
      last_raw: { observation_id: TICK, received_at_utc: '2026-01-01T00:00:00.100Z' },
      open_conditions: [openConnectionLost()],
      pending_continuity: [
        {
          after_tick: null,
          close_watermark_utc: '2026-01-01T00:00:00.000Z',
          end_canonical_tick: null,
          end_utc: null,
          exceeded: false,
          start_canonical_tick: watermark.canonical_tick,
          symbol: 'R_100',
          watermark_observation_id: TICK,
          watermark_utc: '2026-01-01T00:00:00.000Z',
        },
      ],
      previous_connection: { closed_at_utc: '2026-01-01T00:00:00.500Z', connection_id: CONNECTION },
      watermarks: [watermark],
    };
    expect(liveDerivationCheckpointSchema.parse(checkpoint(state))).toEqual(checkpoint(state));
  });

  it('rechaza campos desconocidos, en el registro y en el estado', () => {
    expect(liveDerivationCheckpointSchema.safeParse({ ...checkpoint(), extra: 1 }).success).toBe(
      false,
    );
    expect(
      liveDerivationCheckpointSchema.safeParse(checkpoint({ ...emptyState, extra: 1 })).success,
    ).toBe(false);
  });

  it('rechaza listas del estado fuera de orden o repetidas', () => {
    const other = { ...watermark, symbol: 'R_050' };
    expect(
      liveDerivationCheckpointSchema.safeParse(
        checkpoint({ ...emptyState, watermarks: [watermark, other] }),
      ).success,
    ).toBe(false);
    expect(
      liveDerivationCheckpointSchema.safeParse(
        checkpoint({ ...emptyState, watermarks: [watermark, watermark] }),
      ).success,
    ).toBe(false);
  });

  it('una condición abierta tiene que ser una apertura causada por su incidencia', () => {
    const open = openConnectionLost();
    const resolved = withId('condition_event_id', {
      ...Object.fromEntries(
        Object.entries(open.condition).filter(([key]) => key !== 'condition_event_id'),
      ),
      action: 'resolved',
      resolution_reason: 'connection_reestablished',
    });
    expect(
      liveDerivationCheckpointSchema.safeParse(
        checkpoint({ ...emptyState, open_conditions: [{ ...open, condition: resolved }] }),
      ).success,
    ).toBe(false);

    const otherIncident = { ...open.incident, incident_id: `sha256:${'c'.repeat(64)}` };
    expect(
      liveDerivationCheckpointSchema.safeParse(
        checkpoint({ ...emptyState, open_conditions: [{ ...open, incident: otherIncident }] }),
      ).success,
    ).toBe(false);
  });

  it('no admite más raw frames que eventos', () => {
    expect(
      liveDerivationCheckpointSchema.safeParse({
        ...checkpoint(),
        event_count: 1,
        raw_frame_count: 2,
      }).success,
    ).toBe(false);
  });

  it('el JSON Schema exportado acepta lo que acepta el runtime', () => {
    const require = createRequire(import.meta.url);
    const addFormats = require('ajv-formats') as FormatsPlugin;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const url = import.meta.resolve('@buoh/contracts/json-schema/live-derivation-checkpoint');
    const validate = ajv.compile(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as object);

    expect(validate(checkpoint())).toBe(true);
    expect(validate({ ...checkpoint(), extra: 1 })).toBe(false);
    expect('liveDerivationCheckpointStructuralSchema' in publicContracts).toBe(false);
  });
});
