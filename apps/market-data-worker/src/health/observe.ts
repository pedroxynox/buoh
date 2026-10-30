import { sha256Hex, type DeploymentEnvironment, type SourceEvent } from '@buoh/contracts';
import { SOURCE_LIMITS } from '@buoh/domain';

import { createDerivMeasurementProfileFromSourceSchema, DERIV_SOURCE } from '../deriv/profile.js';
import { DERIV_SCHEMA_RELEASE, type ExpectedSchemaArchive } from '../deriv/schema-archive.js';
import { SOURCE_SCHEMA_ENTRY } from '../deriv/session.js';
import { ObjectReadError } from '../errors.js';
import { type IngestionStatusStore } from '../ingestion/status.js';
import { contentKey } from '../object-keys.js';
import { OperationalRegistry, type OperationalStore } from '../operational/registry.js';
import { type ObjectStore } from '../ports.js';
import { type SourceLogStore } from '../source-log/ports.js';
import {
  failureReason,
  LogIntegrityError,
  LogReadError,
  SourceEventLog,
} from '../source-log/source-event-log.js';
import { type HealthObservation } from './evaluate.js';

/**
 * Lo que lee `data:health` (ADR-0015 §8, «Entradas»), en el esquema PostgreSQL y el bucket de la
 * configuración. Solo son lecturas: ninguna escribe ni toma el bloqueo de la fuente. En `data:health`
 * salen de `openStores`; en las pruebas, de almacenes en memoria.
 */
export interface HealthStores {
  /** El último dataset activo de la fuente en el entorno (`PostgresMetadataStore`). */
  readonly datasets: {
    lastActiveDatasetId(source: string, environment: DeploymentEnvironment): Promise<string | null>;
  };
  /** Los cursores y el último latido de la ingesta (`PostgresIngestionStatusStore`). */
  readonly ingestionStatus: Pick<
    IngestionStatusStore,
    'cursorSymbols' | 'latestCursor' | 'latestHeartbeat'
  >;
  /** El almacenamiento de objetos: los objetos del log y el esquema de fuente guardado. */
  readonly objects: Pick<ObjectStore, 'bucket' | 'get'>;
  /** El registro operativo (`PostgresOperationalStore`). */
  readonly operational: Pick<OperationalStore, 'load'>;
  /** El índice del log (`PostgresSourceLogStore`). */
  readonly sourceLog: Pick<SourceLogStore, 'listClosedSegments' | 'readLogState'>;
  /**
   * El PID de la sesión de PostgreSQL que tiene el bloqueo de la fuente según `pg_locks`, o `null`
   * (`sourceLockHolder`): el escritor vivo.
   */
  lockHolder(source: string): Promise<number | null>;
  /** Las migraciones del worker que el esquema todavía no tiene, sin aplicar nada. */
  pendingMigrations(): Promise<readonly string[]>;
}

export interface ObserveDataHealthInput {
  /** El entorno de la configuración: el del último dataset activo. */
  readonly environment: DeploymentEnvironment;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  /** UUIDv7 para el cierre que la regla 4 añade en memoria. */
  readonly nextId: () => string;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  readonly stores: HealthStores;
  /** El símbolo pedido. */
  readonly symbol: string;
}

/**
 * Lo más que puede medir el esquema de fuente que guardó la ingesta: el máximo de una entrada de
 * `schemas.zip` (ADR-0004 §7), porque la carga rechaza una entrada mayor. La release fijada no da
 * el tamaño de cada entrada, solo su SHA-256. Un objeto mayor bajo esa clave tiene otros bytes.
 */
const SOURCE_SCHEMA_MAX_BYTES = SOURCE_LIMITS.schema_entry.maximum;

/**
 * La versión del writer de gzip que pide `SourceEventLog.open` para cerrar segmentos. `data:health`
 * nunca cierra ni escribe nada, así que no se usa.
 */
const UNUSED_WRITER_VERSION = 'data-health-read-only';

/** La tabla no existe (`undefined_table`): al esquema le faltan migraciones del worker. */
const UNDEFINED_TABLE = '42P01';

/** Una escritura que `data:health` nunca hace: si un error de programación la pidiera, falla. */
function refuseWrite(): Promise<never> {
  return Promise.reject(new TypeError('data:health solo lee: no escribe en ningún almacén.'));
}

/**
 * Lo que se informa en lugar de lo observado (reglas 2 y 3). La lanza la lectura que termina la
 * observación, y `observeDataHealth` la devuelve.
 */
class ObservationEnd extends Error {
  readonly observation: HealthObservation;

  constructor(observation: HealthObservation) {
    super(observation.status);
    this.name = 'ObservationEnd';
    this.observation = observation;
  }
}

const incompatible = (reason: string): ObservationEnd =>
  new ObservationEnd({ reason, source: DERIV_SOURCE, status: 'incompatible' });

/**
 * Un almacén que rechaza una lectura, con su motivo saneado (`failureReason`): no respondió (regla
 * 3), salvo una tabla que no existe, que dice que al esquema le faltan migraciones (regla 2).
 * Cualquier otro rechazo cuenta como un almacén que no responde, como en la sesión: la interfaz de
 * los almacenes no separa ese caso del de una fila que no pasa sus comprobaciones.
 */
function unanswered(reason: string): ObservationEnd {
  return reason === UNDEFINED_TABLE
    ? incompatible('migrations_pending')
    : new ObservationEnd({ reason, source: DERIV_SOURCE, status: 'storage_unavailable' });
}

/** Una lectura de un almacén: si la rechaza, la observación termina (`unanswered`). */
async function fromStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw unanswered(failureReason(error));
  }
}

/**
 * El log durable, cerrado y abierto, leído sin el bloqueo y sin escribir: `SourceEventLog.open` y
 * `readDurableSegments` sobre almacenes que rechazan toda escritura. Un contenido que no pasa sus
 * comprobaciones (`LogIntegrityError`) es `log_not_derivable` (regla 2); un almacén que no responde
 * (`LogReadError`), la regla 3.
 */
async function readLog(stores: HealthStores): Promise<SourceEvent[][]> {
  const { objects, sourceLog } = stores;
  try {
    const log = await SourceEventLog.open({
      objects: {
        bucket: objects.bucket,
        get: (key, maxBytes) => objects.get(key, maxBytes),
        putIfAbsent: refuseWrite,
      },
      source: DERIV_SOURCE,
      store: {
        insertClosedSegment: refuseWrite,
        insertIndexRow: refuseWrite,
        insertLiveCheckpoint: refuseWrite,
        listClosedSegments: (source, from, to) => sourceLog.listClosedSegments(source, from, to),
        // `readDurableSegments` no lee puntos de control: `data:health` todavía deriva el log entero.
        readLiveCheckpoint: () =>
          Promise.reject(new TypeError('data:health no lee puntos de control.')),
        readLogState: (source) => sourceLog.readLogState(source),
      },
      zlibVersion: UNUSED_WRITER_VERSION,
    });
    return await log.readDurableSegments();
  } catch (error) {
    if (error instanceof LogIntegrityError) {
      throw incompatible('log_not_derivable');
    }
    if (error instanceof LogReadError) {
      throw unanswered(error.reason);
    }
    throw error;
  }
}

/**
 * Los bytes del esquema de fuente que guardó la ingesta (ADR-0015 §7), con la clave de su SHA-256
 * fijado, o `null` si no está. Si la clave tiene otros bytes, la ingesta ya no arranca con ese
 * bucket, así que es `source_schema_mismatch` (regla 2), con el log vacío o no: una lectura mayor
 * que cualquier entrada de esquemas, o unos bytes con otro SHA-256.
 */
async function readSourceSchema(
  objects: HealthStores['objects'],
  expected: ExpectedSchemaArchive,
): Promise<Uint8Array | null> {
  const pinned = expected.entries_sha256[SOURCE_SCHEMA_ENTRY];
  let bytes: Uint8Array;
  try {
    bytes = await objects.get(contentKey(pinned), SOURCE_SCHEMA_MAX_BYTES);
  } catch (error) {
    if (error instanceof ObjectReadError) {
      if (error.reason === 'not_found') {
        return null;
      }
      throw incompatible('source_schema_mismatch');
    }
    throw unanswered(failureReason(error));
  }
  if (sha256Hex(bytes) !== pinned) {
    throw incompatible('source_schema_mismatch');
  }
  return bytes;
}

/**
 * Lo que observa `data:health` de la fuente de Deriv (ADR-0015 §8, «Entradas»), sin tomar el
 * bloqueo y sin escribir nada, en este orden:
 *
 * 1. las migraciones del esquema: si falta alguna, `migrations_pending` (regla 2), sin leer más;
 * 2. el escritor vivo (`pg_locks`) y el último latido, antes que el log: así un evento de conexión
 *    del log posterior al latido gana (regla 5), y un escritor que suelta el bloqueo mientras se
 *    lee el log ya dejó su cierre en él;
 * 3. los símbolos de los cursores de la fuente y el último cursor del símbolo pedido, antes que el
 *    log, como el arranque: un cursor escrito mientras se lee apunta a un evento que el índice ya
 *    tenía; después, el log durable y el esquema de fuente guardado, con el que arma el perfil de
 *    medición; sin él, el perfil es `null` y la evaluación decide;
 * 4. los tipos abiertos del registro operativo y el último dataset activo de la fuente en el
 *    entorno.
 *
 * La hora de la observación se toma una vez, al terminar de leer: el cierre que añade la regla 4
 * nunca queda antes de lo leído, y un latido leído nunca es posterior a ella. Si una lectura dice
 * algo incompatible o un almacén no responde, devuelve ese caso (reglas 2 y 3) con un motivo
 * saneado. Un error de programación la rechaza.
 */
export async function observeDataHealth(input: ObserveDataHealthInput): Promise<HealthObservation> {
  const { stores, symbol } = input;
  const expected = input.expected ?? DERIV_SCHEMA_RELEASE;
  try {
    const pending = await fromStore(() => stores.pendingMigrations());
    if (pending.length > 0) {
      throw incompatible('migrations_pending');
    }
    const writerPid = await fromStore(() => stores.lockHolder(DERIV_SOURCE));
    const latestHeartbeat = await fromStore(() =>
      stores.ingestionStatus.latestHeartbeat(DERIV_SOURCE),
    );
    const cursorSymbols = await fromStore(() => stores.ingestionStatus.cursorSymbols(DERIV_SOURCE));
    const latestCursor = await fromStore(() =>
      stores.ingestionStatus.latestCursor(DERIV_SOURCE, symbol),
    );
    const segments = await readLog(stores);
    const sourceSchema = await readSourceSchema(stores.objects, expected);
    const registry = await fromStore(() =>
      OperationalRegistry.open({
        source: DERIV_SOURCE,
        store: { append: refuseWrite, load: (source) => stores.operational.load(source) },
      }),
    );
    const lastPublishedDatasetId = await fromStore(() =>
      stores.datasets.lastActiveDatasetId(DERIV_SOURCE, input.environment),
    );
    return {
      cursorSymbols,
      lastPublishedDatasetId,
      latestCursor: latestCursor?.cursor ?? null,
      latestHeartbeat,
      nextId: input.nextId,
      now: input.now(),
      operationalConditionTypes: registry.openConditionTypes(),
      profile:
        sourceSchema === null
          ? null
          : createDerivMeasurementProfileFromSourceSchema({
              source_schema_bytes: sourceSchema,
              source_schema_release: expected.release,
              symbol,
            }),
      segments,
      source: DERIV_SOURCE,
      status: 'observed',
      symbol,
      writerPid,
    };
  } catch (error) {
    if (error instanceof ObservationEnd) {
      return error.observation;
    }
    throw error;
  }
}
