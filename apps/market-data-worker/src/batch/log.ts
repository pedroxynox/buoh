import { BATCH_SEGMENT_POLICY } from '@buoh/domain';

import type { WorkerConfig } from '../config.js';
import { DERIV_SOURCE } from '../deriv/profile.js';
import type { SessionLock } from '../deriv/session.js';
import { openLockedSourceLog } from '../postgres/session-lock.js';
import type { HistorySegments } from '../history/command.js';
import { HEALTH_CONNECTION_TIMEOUT_MS, HEALTH_REQUEST_TIMEOUT_MS, openStores } from '../runtime.js';
import { SourceEventLog } from '../source-log/source-event-log.js';
import { withLog, type LogLocation } from '../successive-logs.js';
import type { BatchLogHandle } from './command.js';

/**
 * El log de una secuencia por lotes del comando de los lotes (ADR-0021 §3; precisión del PR 5c1 de
 * su §9): los almacenes del log (`withLog`), con los plazos de `data:health` en cada conexión y cada
 * petición, para que uno que no contesta termine en `persistence_failed` y no en el plazo del
 * proceso, y el log de la fuente protegido por el bloqueo de la secuencia (`openLockedSourceLog`),
 * con la política de segmentos de los lotes, `BATCH_SEGMENT_POLICY` (2.0.0).
 */
export async function openBatchLog(
  config: WorkerConfig,
  lock: SessionLock,
  log: LogLocation,
): Promise<BatchLogHandle> {
  const stores = openStores(withLog(config, log), {
    timeouts: { connectionMs: HEALTH_CONNECTION_TIMEOUT_MS, requestMs: HEALTH_REQUEST_TIMEOUT_MS },
  });
  try {
    const opened = await openLockedSourceLog(lock, {
      objects: stores.objects,
      policy: BATCH_SEGMENT_POLICY,
      source: DERIV_SOURCE,
      store: stores.sourceLog,
      zlibVersion: process.versions.zlib,
    });
    return { close: stores.close, log: opened, objects: stores.objects };
  } catch (error) {
    await stores.close();
    throw error;
  }
}

/**
 * Las lecturas de los segmentos cerrados de un log de los lotes, para el comando de la historia
 * (precisión del PR 6c de ADR-0021 §9): sus filas y sus source events, verificados, sobre los
 * almacenes del log (`withLog`), con los plazos de `data:health`. No escribe nada.
 */
export function openHistorySegments(config: WorkerConfig, log: LogLocation): HistorySegments {
  const stores = openStores(withLog(config, log), {
    timeouts: { connectionMs: HEALTH_CONNECTION_TIMEOUT_MS, requestMs: HEALTH_REQUEST_TIMEOUT_MS },
  });
  const reader = SourceEventLog.closedSegmentReader({
    objects: stores.objects,
    source: DERIV_SOURCE,
    store: stores.sourceLog,
    zlibVersion: 'solo-lectura',
  });
  return {
    close: stores.close,
    closed: (from) => stores.sourceLog.listClosedSegments(DERIV_SOURCE, from, MAX_SEGMENT_INDEX),
    read: async (index) => (await reader.readClosedSegment(index)).events,
  };
}

/** El mayor índice de segmento que cabe en la columna `integer` de `closed_source_segments`. */
const MAX_SEGMENT_INDEX = 2_147_483_647;
