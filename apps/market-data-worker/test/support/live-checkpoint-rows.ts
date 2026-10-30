import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
  type PipelineProfile,
} from '@buoh/domain';

import { checkpointRow } from '../../src/source-log/live-checkpoint.js';
import { type StoredLiveCheckpoint } from '../../src/source-log/ports.js';
import { type SourceEventLog } from '../../src/source-log/source-event-log.js';

/**
 * Las filas de los puntos de control de los segmentos cerrados del log, como las escribe `ingest`
 * (ADR-0017 §5): en cada segmento *k*, el pliegue del log desde el vacío hasta *k*, con los eventos
 * y los frames de los segmentos 0 a *k* y el enlace de *k*. Lee el log de cualquier almacén, en
 * memoria o PostgreSQL y S3-compatible.
 */
export async function checkpointRowsOf(input: {
  readonly log: SourceEventLog;
  readonly profile: PipelineProfile;
  readonly symbol: string;
  readonly writtenAt: string;
}): Promise<StoredLiveCheckpoint[]> {
  const { log, profile } = input;
  const rows: StoredLiveCheckpoint[] = [];
  let state = emptyLiveDerivationState();
  let eventCount = 0;
  let rawFrameCount = 0;
  for (let k = 0; k < log.openSegmentIndex; k += 1) {
    const { events, segment } = await log.readClosedSegment(k);
    state = foldLiveDerivation(state, events, profile);
    eventCount += events.length;
    rawFrameCount += events.filter((event) => event.kind === 'raw_source_frame').length;
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: eventCount,
      profile,
      raw_frame_count: rawFrameCount,
      segment_index: k,
      segment_logical_content_sha256: segment.logical_content_sha256,
      state,
      symbol: input.symbol,
    });
    rows.push(checkpointRow(checkpoint, input.writtenAt));
  }
  return rows;
}
