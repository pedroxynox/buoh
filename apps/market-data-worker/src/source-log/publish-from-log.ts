import { type DatasetPublication } from '@buoh/domain';

import { publishDataset, type PublishDatasetInput } from '../publication.js';
import { type SourceEventLog } from './source-event-log.js';

export interface PublishFromLogInput extends Omit<PublishDatasetInput, 'segments'> {
  /** Primer y último segmento cerrado del log que forman el dataset (rango contiguo). */
  readonly fromSegment: number;
  readonly log: SourceEventLog;
  readonly toSegment: number;
}

/**
 * Publicación explícita (ADR-0004 §13, ADR-0005 §4) de un rango contiguo de segmentos cerrados del
 * log. Los límites entre segmentos del log son los límites de los artifacts `source_events:*`.
 */
export async function publishFromLog(input: PublishFromLogInput): Promise<DatasetPublication> {
  const { fromSegment, log, toSegment, ...publication } = input;
  if (log.source !== publication.profile.source) {
    throw new TypeError('El log y el perfil pertenecen a fuentes distintas.');
  }
  const segments = await log.readClosedSegments(fromSegment, toSegment);
  return publishDataset({ ...publication, segments });
}
