import { connectionClosedSchema, connectionOpenedSchema, type SourceEvent } from '@buoh/contracts';
import { vi } from 'vitest';

import { type HistoryRecoveryRequest } from '../../src/deriv/history-recovery.js';
import { createDerivMeasurementProfile, DERIV_SOURCE } from '../../src/deriv/profile.js';
import { buildRawSourceFrame } from '../../src/ingestion/raw-first-ingestor.js';
import {
  connectionHarness,
  START_EPOCH,
  syntheticSchemas,
  uuid,
  type ConnectionHarnessOptions,
} from './connection-harness.js';
import { derivMessages } from './deriv-fixtures.js';
import { type MemoryObjectStore } from './memory-stores.js';

// Un hueco que recuperar (ADR-0015 §4): la conexión anterior del log, cerrada sin pedirlo, y una
// conexión nueva que la supera, suscrita, con su primer tick posterior al cierre ya durable. Ningún
// precio es de mercado.

/** Conexión anterior del log, que la nueva supera. */
export const PREVIOUS = uuid(9001);
/** S: segundo del high-watermark, el último tick antes del cierre (09:59:00). */
export const S = START_EPOCH - 60;
/** E: segundo del primer tick posterior al cierre, el primero de la conexión nueva (10:00:00). */
export const E = START_EPOCH;

/** El hueco que dan las reglas, y la cotización canónica recibida en cada extremo. */
export const REQUEST: HistoryRecoveryRequest = {
  end_quote: '100.75',
  from_event_time_utc: '2026-03-02T09:59:00.001Z',
  start_quote: '100.25',
  symbol: 'SYNTH_100',
  to_event_time_utc: '2026-03-02T09:59:59.999Z',
};

/** La conexión anterior: su apertura, un tick en S (100.25) y su cierre remoto, que no es pedido. */
export function previousConnectionEvents(): SourceEvent[] {
  const profile = createDerivMeasurementProfile({
    schemas: syntheticSchemas(),
    symbol: 'SYNTH_100',
  });
  return [
    connectionOpenedSchema.parse({
      connection_id: PREVIOUS,
      event_id: uuid(9002),
      kind: 'connection_opened',
      occurred_at_utc: '2026-03-02T09:58:00.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    }),
    buildRawSourceFrame(
      {
        connection_id: PREVIOUS,
        observation_id: uuid(9003),
        payload_utf8: derivMessages.tick(2, S, '100.25'),
        received_at_utc: '2026-03-02T09:59:00.000Z',
      },
      profile,
    ),
    connectionClosedSchema.parse({
      affected_symbols: ['SYNTH_100'],
      closure_type: 'remote',
      connection_id: PREVIOUS,
      event_id: uuid(9004),
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T09:59:30.000Z',
      reason: 'close_code_1001',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    }),
  ];
}

/**
 * La conexión nueva, que supera a la anterior, suscrita y con su primer tick (E, 100.75) durable.
 * Después avanza 2000 ms, la espera que hará la sesión antes de pedir la historia. IDs: 1 la
 * conexión, 2 su apertura, 3 el catálogo y 4 el primer tick. El servidor responde cada `ping` del
 * keepalive, porque los tres intentos pasan de 45 000 ms.
 */
export async function recovering(
  options: Pick<ConnectionHarnessOptions, 'deferClose' | 'durationMs' | 'schemaOverrides'> = {},
) {
  const run = await connectionHarness({
    ...options,
    answerPings: true,
    events: previousConnectionEvents(),
    supersedes: PREVIOUS,
  });
  await run.subscribe(derivMessages.tick(2, E, '100.75'));
  await run.clock.advance(2000);
  return run;
}

export type RecoveringRun = Awaited<ReturnType<typeof recovering>>;

/** Las páginas pedidas, sin las demás peticiones (catálogo, suscripción, `ping` y `forget_all`). */
export const pagesSent = (run: RecoveringRun) =>
  run
    .socket()
    .requests()
    .filter((request) => 'ticks_history' in request);

/** ¿Se pidió `forget_all`? */
export const forgetAllSent = (run: RecoveringRun) =>
  run
    .socket()
    .requests()
    .some((request) => 'forget_all' in request);

/** Los `HistoryRecoveryResult` del log. */
export async function results(run: RecoveringRun): Promise<SourceEvent[]> {
  return (await run.events()).filter((event) => event.kind === 'history_recovery_result');
}

/** Retiene las escrituras de objetos hasta `release`, para dejar un frame en curso. */
export function holdObjectWrites(objects: MemoryObjectStore) {
  const gate = Promise.withResolvers<undefined>();
  const original = objects.putIfAbsent.bind(objects);
  vi.spyOn(objects, 'putIfAbsent').mockImplementation(async (key, bytes) => {
    await gate.promise;
    return original(key, bytes);
  });
  return {
    release: () => {
      gate.resolve(undefined);
    },
  };
}
