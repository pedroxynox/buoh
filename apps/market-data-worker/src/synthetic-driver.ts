import { sourceEventSchema } from '@buoh/contracts';
import {
  CONTRACT_SCHEMA_VERSION,
  parseSyntheticStimuli,
  type SyntheticStimulus,
} from '@buoh/domain';

import { type RawFirstIngestor } from './ingestion/raw-first-ingestor.js';

export interface SyntheticDriverHooks {
  /** `persistence_fault_armed`: control del harness; quien prueba arma el fallo en su almacén. */
  readonly onFaultArmed?: (
    stimulus: Extract<SyntheticStimulus, { kind: 'persistence_fault_armed' }>,
  ) => void;
}

/**
 * Entrega los estímulos del proveedor sintético `fixture-v1` al ingestor real, como lo haría un
 * transporte. `segment_rotation_requested` y `persistence_fault_armed` son controles del harness y
 * nunca se persisten (ADR-0004 §7 y §12).
 */
export async function driveSyntheticStimuli(
  ingestor: RawFirstIngestor,
  values: readonly unknown[],
  source: string,
  hooks: SyntheticDriverHooks = {},
): Promise<void> {
  for (const stimulus of parseSyntheticStimuli(values)) {
    switch (stimulus.kind) {
      case 'segment_rotation_requested':
        await ingestor.rotate('requested');
        break;
      case 'persistence_fault_armed':
        hooks.onFaultArmed?.(stimulus);
        break;
      case 'source_frame':
        await ingestor.receiveFrame({
          connection_id: stimulus.connection_id,
          observation_id: stimulus.observation_id,
          payload_utf8: stimulus.payload_utf8,
          received_at_utc: stimulus.received_at_utc,
        });
        break;
      case 'connection_closed':
      case 'connection_opened':
      case 'history_recovery_result': {
        const fields: Record<string, unknown> = { ...stimulus };
        delete fields['fixture_sequence'];
        const event = sourceEventSchema.parse({
          ...fields,
          schema_version: CONTRACT_SCHEMA_VERSION,
          source,
        });
        if (event.kind === 'raw_source_frame') {
          throw new TypeError('Estímulo de conexión convertido en raw.');
        }
        await ingestor.receiveEvent(event);
        break;
      }
    }
  }
}
