import { sha256Hex, sourceEventSchema, type SourceEvent } from '@buoh/contracts';
import { z } from 'zod';

import { CONTRACT_SCHEMA_VERSION, type PipelineProfile } from './profile.js';
import { deriveMarketData } from './quality.js';

/**
 * Adaptador del proveedor sintético `fixture-v1`: convierte estímulos del driver en
 * `SourceEvent` append-only. Los estímulos no son el log persistido; la rotación de segmento y el
 * fallo de persistencia armado son controles del harness y nunca se persisten.
 */

const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const uuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const utc = z.string().min(1);
const text = z.string().min(1);

const recoveryBase = {
  fixture_sequence: sequence,
  kind: z.literal('history_recovery_result'),
  event_id: uuidV7,
  connection_id: uuidV7,
  occurred_at_utc: utc,
  from_event_time_utc: utc,
  to_event_time_utc: utc,
  symbol: text,
};

const stimulusSchema = z.union([
  z.strictObject({
    fixture_sequence: sequence,
    kind: z.literal('source_frame'),
    connection_id: uuidV7,
    observation_id: uuidV7,
    payload_utf8: z.string(),
    received_at_utc: utc,
  }),
  z.strictObject({
    fixture_sequence: sequence,
    kind: z.literal('connection_closed'),
    event_id: uuidV7,
    connection_id: uuidV7,
    occurred_at_utc: utc,
    closure_type: z.enum(['requested', 'remote', 'transport_error', 'timeout']),
    affected_symbols: z.array(text),
    reason: text,
  }),
  z.strictObject({
    fixture_sequence: sequence,
    kind: z.literal('connection_opened'),
    event_id: uuidV7,
    connection_id: uuidV7,
    occurred_at_utc: utc,
    supersedes_connection_id: uuidV7.nullable(),
  }),
  z.strictObject({
    ...recoveryBase,
    status: z.literal('complete'),
    recovered_event_count: z.number().int().min(0),
  }),
  z.strictObject({
    ...recoveryBase,
    status: z.literal('partial'),
    recovered_event_count: z.number().int().min(0),
    reason: text,
  }),
  z.strictObject({ ...recoveryBase, status: z.literal('unavailable'), reason: text }),
  z.strictObject({
    fixture_sequence: sequence,
    kind: z.literal('segment_rotation_requested'),
    occurred_at_utc: utc,
    reason: text,
  }),
  z.strictObject({
    fixture_sequence: sequence,
    kind: z.literal('persistence_fault_armed'),
    fault_id: uuidV7,
    occurred_at_utc: utc,
    reason: text,
    scope: z.literal('next_raw_object_write'),
    stage: z.literal('raw_object_write'),
  }),
]);

export type SyntheticStimulus = z.infer<typeof stimulusSchema>;

/** Resultado fail-closed cuando la escritura raw no puede confirmarse (ADR-0004 §12). */
export interface PersistenceFailureOutcome {
  dataset_state: 'not_published';
  emitted_tick_count: number;
  execution_mode: 'disabled';
  incident_evidence: { reason: string; stage: 'raw_object_write' };
  incident_type: 'persistence_unavailable';
  last_durable_observation_id: string | null;
  required_action: 'close_connection_then_recover';
  schema_version: string;
  service_health: 'paused';
  source_event_count: number;
}

export type SyntheticIngestionResult =
  | { readonly status: 'persisted'; readonly segments: SourceEvent[][] }
  | {
      readonly durableSegments: SourceEvent[][];
      readonly outcome: PersistenceFailureOutcome;
      readonly status: 'fail_closed';
    };

export function parseSyntheticStimuli(values: readonly unknown[]): SyntheticStimulus[] {
  return values.map((value, index) => {
    const stimulus = stimulusSchema.parse(value);
    if (stimulus.fixture_sequence !== index + 1) {
      throw new TypeError('fixture_sequence debe ser contiguo desde uno.');
    }
    return stimulus;
  });
}

function toSourceEvent(
  stimulus: Exclude<
    SyntheticStimulus,
    { kind: 'persistence_fault_armed' | 'segment_rotation_requested' }
  >,
  profile: PipelineProfile,
): SourceEvent {
  if (stimulus.kind === 'source_frame') {
    return sourceEventSchema.parse({
      connection_id: stimulus.connection_id,
      connector_version: profile.connector_version,
      kind: 'raw_source_frame',
      observation_id: stimulus.observation_id,
      payload_utf8: stimulus.payload_utf8,
      // Hash sobre los bytes UTF-8 exactos recibidos; nunca se reserializa el payload.
      raw_payload_sha256: sha256Hex(stimulus.payload_utf8),
      received_at_utc: stimulus.received_at_utc,
      schema_version: CONTRACT_SCHEMA_VERSION,
      source: profile.source,
    });
  }
  // `fixture_sequence` pertenece al driver y no se persiste.
  const fields: Record<string, unknown> = { ...stimulus };
  delete fields['fixture_sequence'];
  return sourceEventSchema.parse({
    ...fields,
    schema_version: CONTRACT_SCHEMA_VERSION,
    source: profile.source,
  });
}

/**
 * Ejecuta el driver sintético en orden. Un raw solo se considera durable si su escritura no
 * consumió un fallo armado; ante el fallo, se detiene la entrada sin normalizar el frame afectado.
 */
export function ingestSyntheticStimuli(
  values: readonly unknown[],
  profile: PipelineProfile,
): SyntheticIngestionResult {
  const stimuli = parseSyntheticStimuli(values);
  const segments: SourceEvent[][] = [];
  let current: SourceEvent[] = [];
  let armedFault: Extract<SyntheticStimulus, { kind: 'persistence_fault_armed' }> | undefined;

  const durableSegments = () => (current.length > 0 ? [...segments, current] : [...segments]);

  for (const stimulus of stimuli) {
    switch (stimulus.kind) {
      case 'segment_rotation_requested':
        if (current.length === 0) {
          throw new TypeError('La rotación requiere al menos un source event en el segmento.');
        }
        segments.push(current);
        current = [];
        continue;
      case 'persistence_fault_armed':
        if (armedFault !== undefined) {
          throw new TypeError('Ya existe un fallo de persistencia armado sin consumir.');
        }
        armedFault = stimulus;
        continue;
      case 'source_frame':
        if (armedFault !== undefined) {
          const durable = durableSegments();
          const lastDurableRaw = durable
            .flat()
            .filter((event) => event.kind === 'raw_source_frame')
            .at(-1);
          return {
            durableSegments: durable,
            outcome: {
              dataset_state: 'not_published',
              emitted_tick_count: deriveMarketData(durable, profile).ticks.length,
              execution_mode: 'disabled',
              incident_evidence: { reason: armedFault.reason, stage: armedFault.stage },
              incident_type: 'persistence_unavailable',
              last_durable_observation_id: lastDurableRaw?.observation_id ?? null,
              required_action: 'close_connection_then_recover',
              schema_version: CONTRACT_SCHEMA_VERSION,
              service_health: 'paused',
              source_event_count: durable.flat().length,
            },
            status: 'fail_closed',
          };
        }
        current.push(toSourceEvent(stimulus, profile));
        continue;
      case 'connection_closed':
      case 'connection_opened':
      case 'history_recovery_result':
        current.push(toSourceEvent(stimulus, profile));
        continue;
    }
  }

  if (armedFault !== undefined) {
    throw new TypeError(
      `El fallo armado ${armedFault.fault_id} no fue consumido por ninguna escritura.`,
    );
  }
  return { segments: durableSegments(), status: 'persisted' };
}
