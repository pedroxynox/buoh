import { connectionClosedSchema, connectionOpenedSchema, type SourceEvent } from '@buoh/contracts';
import type { PipelineProfile } from '@buoh/domain';

import { buildRawSourceFrame } from '../../src/ingestion/raw-first-ingestor.js';
import type { ObjectStore } from '../../src/ports.js';
import type { SourceLogStore } from '../../src/source-log/ports.js';
import { SourceEventLog } from '../../src/source-log/source-event-log.js';
import { derivMessages } from './deriv-fixtures.js';

// Un log sintético de una captura de R_100, como la de `ingest`: conexiones con un tick cada 2 s,
// escritas con el `SourceEventLog` del worker, que rota sus segmentos cada 300 000 ms. Ningún precio
// es de mercado real.

const iso = (ms: number) => new Date(ms).toISOString();

export interface LiveConnection {
  /** Desde cuándo y hasta cuándo, en milisegundos UTC. */
  readonly fromMs: number;
  readonly toMs: number;
  /** Cómo termina: un cierre pedido o una caída (`transport_error`, `close_code_1006`). */
  readonly end: 'dropped' | 'requested';
}

/** Los source events de esas conexiones, en orden; cada una sucede a la anterior. */
export function liveEvents(
  profile: PipelineProfile,
  connections: readonly LiveConnection[],
  symbol = 'R_100',
): SourceEvent[] {
  let sequence = 0;
  const id = () => {
    sequence += 1;
    return `019b76da-a800-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
  };
  const events: SourceEvent[] = [];
  let previous: string | null = null;
  for (const connection of connections) {
    const connectionId = id();
    events.push(
      connectionOpenedSchema.parse({
        connection_id: connectionId,
        event_id: id(),
        kind: 'connection_opened',
        occurred_at_utc: iso(connection.fromMs),
        schema_version: '1.0.0',
        source: profile.source,
        supersedes_connection_id: previous,
      }),
    );
    for (
      let epoch = Math.ceil((connection.fromMs + 1000) / 1000);
      epoch * 1000 + 300 < connection.toMs;
      epoch += 2
    ) {
      events.push(
        buildRawSourceFrame(
          {
            connection_id: connectionId,
            observation_id: id(),
            payload_utf8: derivMessages.tick(2, epoch, '1234.56', symbol),
            received_at_utc: iso(epoch * 1000 + 250),
          },
          profile,
        ),
      );
    }
    events.push(
      connectionClosedSchema.parse({
        affected_symbols: [symbol],
        closure_type: connection.end === 'requested' ? 'requested' : 'transport_error',
        connection_id: connectionId,
        event_id: id(),
        kind: 'connection_closed',
        occurred_at_utc: iso(connection.toMs),
        reason: connection.end === 'requested' ? 'requested' : 'close_code_1006',
        schema_version: '1.0.0',
        source: profile.source,
      }),
    );
    previous = connectionId;
  }
  return events;
}

/** Escribe los eventos en el log y cierra el segmento abierto, como `ingest` al parar. */
export async function writeLiveLog(input: {
  readonly events: readonly SourceEvent[];
  readonly objects: ObjectStore;
  readonly source: string;
  readonly store: SourceLogStore;
}): Promise<number> {
  const log = await SourceEventLog.open({
    objects: input.objects,
    source: input.source,
    store: input.store,
    zlibVersion: 'test-zlib',
  });
  for (const event of input.events) {
    await log.append(event);
  }
  if (log.openSegmentStats.event_count > 0) {
    await log.close('requested');
  }
  return log.openSegmentIndex;
}
