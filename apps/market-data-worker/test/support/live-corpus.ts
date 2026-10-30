import { type SourceEvent } from '@buoh/contracts';
import { createPipelineProfile, deriveMarketData, ingestSyntheticStimuli } from '@buoh/domain';

import {
  C,
  CLOSED_TWICE,
  id,
  liveCorpus,
  OUT_OF_DOMAIN,
  RESOLVED_BEFORE_OPENING,
  sameInstantStimuli,
  SYMBOL,
  T0,
  tick,
  VECTOR_SCENARIOS,
  vectorSegments,
} from '../../../../packages/domain/test/support/live-corpus.js';

// El corpus de la equivalencia del estado vivo (ADR-0017 §9), el mismo que recorre la equivalencia
// del pliegue en el dominio (`packages/domain/test/support/live-corpus.ts`), con las funciones del
// paquete compilado del dominio, las que usan los lectores del worker. Aquí solo se añade lo que usa
// el worker: los logs como eventos y un frame de otro conector.

export const {
  corpus: CORPUS,
  eventsOf,
  measurement,
  publication,
  randomStimuli,
  vectorProfile,
} = liveCorpus({ createPipelineProfile, deriveMarketData, ingestSyntheticStimuli });

export { id, SYMBOL, VECTOR_SCENARIOS };

/** Los source events de un escenario del vector v1, en orden. */
export function vectorEvents(files: readonly string[]): SourceEvent[] {
  return vectorSegments(files).flat();
}

/**
 * Los logs del corpus que no se pueden derivar, con el perfil de medición: una conexión cerrada dos
 * veces, una resolución anterior a su apertura y las 32 variantes de una apertura y su resolución en
 * el mismo instante, que fallan o no según el ID que decide el empate (ADR-0017 §3).
 */
export function failureLogs(): (readonly [string, SourceEvent[]])[] {
  return [
    ['una conexión cerrada dos veces', eventsOf(CLOSED_TWICE, measurement)],
    ['una resolución anterior a su apertura', eventsOf(RESOLVED_BEFORE_OPENING, measurement)],
    ...sameInstantStimuli().map(
      ([type, variant, stimuli]) =>
        [
          `${type} en el mismo instante, variante ${String(variant)}`,
          eventsOf(stimuli, measurement),
        ] as const,
    ),
  ];
}

/**
 * Los logs fuera del dominio de ADR-0017 §3, con el perfil de medición: `deriveMarketData` los
 * acepta, y el pliegue falla cerrado.
 */
export function outOfDomainLogs(): (readonly [string, SourceEvent[]])[] {
  return OUT_OF_DOMAIN.map(([name, stimuli]) => [name, eventsOf(stimuli, measurement)] as const);
}

/** Un frame del log con otro conector, como el de una versión anterior del worker. */
export function foreignFrame(sequence: number): SourceEvent {
  const [event] = eventsOf([tick(1, C, T0 + 10)], measurement);
  if (event?.kind !== 'raw_source_frame') {
    throw new TypeError('Se esperaba un frame.');
  }
  return { ...event, connector_version: 'fixture-v0', observation_id: id(sequence) };
}
