/**
 * El punto de control de la derivación en vivo en el log de una fuente (ADR-0017 §5 y §6): la fila
 * que lo guarda, las comprobaciones que deciden si un lector lo usa y quien lo escribe en `ingest`.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  canonicalJson,
  liveDerivationCheckpointSchema,
  sha256Hex,
  type LiveDerivationCheckpoint,
  type LiveDerivationState,
} from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  emptyLiveDerivationState,
  foldLiveDerivation,
  liveCheckpointDigests,
  liveCheckpointVersions,
  type PipelineProfile,
} from '@buoh/domain';

import { LiveCheckpointConflictError } from '../errors.js';
import { type OperationalAlert } from '../operational/registry.js';
import {
  type ClosedSourceSegment,
  type LiveCheckpointCandidate,
  type LiveCheckpointInsert,
  type StoredLiveCheckpoint,
} from './ports.js';
import {
  failureReason,
  LogIntegrityError,
  LogReadError,
  type SourceEventLog,
} from './source-event-log.js';

/** La fila de `live_derivation_checkpoints` de un punto de control, escrito a `writtenAtUtc`. */
export function checkpointRow(
  checkpoint: LiveDerivationCheckpoint,
  writtenAtUtc: string,
): StoredLiveCheckpoint {
  const { checkpoint_sha256, versions_sha256 } = liveCheckpointDigests(checkpoint);
  const { versions } = checkpoint;
  return {
    checkpoint_jcs: canonicalJson(checkpoint),
    checkpoint_sha256,
    connector_version: versions.connector_version,
    event_count: checkpoint.event_count,
    live_state_version: versions.live_state_version,
    quality_profile_sha256: versions.quality_profile_sha256,
    quality_rule_version: versions.quality_rule_version,
    raw_frame_count: checkpoint.raw_frame_count,
    schema_version: checkpoint.schema_version,
    segment_index: checkpoint.segment_index,
    segment_logical_content_sha256: checkpoint.segment_logical_content_sha256,
    segment_policy_version: versions.segment_policy_version,
    source: checkpoint.source,
    source_event_schema_version: versions.source_event_schema_version,
    source_schema_sha256: versions.source_schema_sha256,
    symbol: checkpoint.symbol,
    versions_sha256,
    written_at_utc: writtenAtUtc,
  };
}

/**
 * El SHA-256 de las versiones de ADR-0017 §6 con las que se deriva con este perfil: el de la clave
 * de los puntos de control que se escriben con él, como `liveCheckpointDigests`.
 */
export function liveCheckpointVersionsSha256(profile: PipelineProfile): string {
  return sha256Hex(canonicalJson(liveCheckpointVersions(profile)));
}

/** Por qué un lector no usa un punto de control guardado (ADR-0017 §6). */
export type LiveCheckpointRejection =
  'checkpoint_binding_mismatch' | 'checkpoint_digest_mismatch' | 'checkpoint_identity_mismatch';

export type CheckedLiveCheckpoint =
  | { readonly checkpoint: LiveDerivationCheckpoint; readonly status: 'valid' }
  | { readonly reason: LiveCheckpointRejection; readonly status: 'rejected' };

/**
 * El punto de control de la fila, si su JCS es el de un `LiveDerivationCheckpoint` válido y la fila
 * es la que se escribe con él: el mismo SHA-256 y las mismas columnas. Si no, `null`.
 */
function parseStored(row: StoredLiveCheckpoint): LiveDerivationCheckpoint | null {
  let value: unknown;
  try {
    value = JSON.parse(row.checkpoint_jcs);
  } catch {
    return null;
  }
  const parsed = liveDerivationCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  // `checkpointRow` también da el JCS y su SHA-256: comparar las filas los incluye.
  return isDeepStrictEqual({ ...checkpointRow(parsed.data, row.written_at_utc) }, { ...row })
    ? parsed.data
    : null;
}

/**
 * Las comprobaciones de ADR-0017 §6 de un punto de control guardado, en este orden:
 *
 * 1. integridad: su JCS es el de un `LiveDerivationCheckpoint` válido, con el SHA-256 y las columnas
 *    de su fila (`checkpoint_digest_mismatch`);
 * 2. identidad: la fuente y el símbolo son los del lector (`checkpoint_identity_mismatch`);
 * 3. enlace con el log: su segmento está cerrado con el mismo `logical_content_sha256`, y los
 *    eventos y raw frames de los segmentos 0 a *k* son los que guarda (`checkpoint_binding_mismatch`).
 *
 * Las versiones ya las eligió la lectura, que nunca da uno de otras versiones (`readLiveCheckpoint`);
 * si las de la fila no son las del lector, es un error de programación del almacén, y lanza.
 */
export function checkStoredCheckpoint(
  candidate: LiveCheckpointCandidate,
  expected: { readonly source: string; readonly symbol: string; readonly versions_sha256: string },
): CheckedLiveCheckpoint {
  const { binding, row } = candidate;
  if (row.versions_sha256 !== expected.versions_sha256) {
    throw new TypeError('El almacén dio un punto de control de otras versiones.');
  }
  const checkpoint = parseStored(row);
  if (checkpoint === null) {
    return { reason: 'checkpoint_digest_mismatch', status: 'rejected' };
  }
  if (checkpoint.source !== expected.source || checkpoint.symbol !== expected.symbol) {
    return { reason: 'checkpoint_identity_mismatch', status: 'rejected' };
  }
  if (
    binding.logical_content_sha256 !== checkpoint.segment_logical_content_sha256 ||
    binding.event_count !== checkpoint.event_count ||
    binding.raw_frame_count !== checkpoint.raw_frame_count
  ) {
    return { reason: 'checkpoint_binding_mismatch', status: 'rejected' };
  }
  return { checkpoint, status: 'valid' };
}

/**
 * Lo que impide seguir escribiendo puntos de control: el log ya no se puede derivar, porque el
 * pliegue falla o un segmento cerrado no pasa sus comprobaciones (`log_not_derivable`); el mismo log
 * dio dos distintos (`checkpoint_conflict`); o un error de programación (`unexpected`).
 */
export interface LiveCheckpointFailure {
  readonly error: unknown;
  readonly reason: 'checkpoint_conflict' | 'log_not_derivable' | 'unexpected';
  /** El segmento cuyo punto de control falló, o `null` si no fue al derivar uno. */
  readonly segment_index: number | null;
}

/**
 * El estado vivo al final del segmento cerrado `segment_index`, con los conteos acumulados hasta él:
 * el de un punto de control, o el del log vacío, con `-1`.
 */
export interface LiveCheckpointBase {
  readonly event_count: number;
  readonly raw_frame_count: number;
  readonly segment_index: number;
  readonly state: LiveDerivationState;
}

function emptyBase(): LiveCheckpointBase {
  return {
    event_count: 0,
    raw_frame_count: 0,
    segment_index: -1,
    state: emptyLiveDerivationState(),
  };
}

function baseOf(checkpoint: LiveDerivationCheckpoint): LiveCheckpointBase {
  return {
    event_count: checkpoint.event_count,
    raw_frame_count: checkpoint.raw_frame_count,
    segment_index: checkpoint.segment_index,
    state: checkpoint.state,
  };
}

export interface LiveCheckpointLookupInput {
  /** Alerta saneada de cada fila que rechaza (`checkpoint_rejected`). */
  readonly alert: OperationalAlert;
  readonly profile: PipelineProfile;
  readonly symbol: string;
}

/**
 * Busca el último punto de control válido del log de una fuente y un símbolo con las versiones del
 * perfil (ADR-0017 §6): de mayor a menor segmento, con las comprobaciones de `checkStoredCheckpoint`.
 * En una sesión la comparten quien escribe los puntos de control y los lectores en vivo, así que
 * avisa una sola vez de cada fila que rechaza (`checkpoint_rejected`, con su motivo y su segmento),
 * aunque la encuentren varias búsquedas, y la recuerda: su clave ya tiene esa fila, que nadie
 * reemplaza. Una fila de otras versiones nunca llega aquí: la lectura solo da las del perfil.
 */
export class LiveCheckpointLookup {
  readonly profile: PipelineProfile;
  readonly symbol: string;
  /** El SHA-256 de las versiones del perfil (`liveCheckpointVersionsSha256`). */
  readonly versionsSha256: string;
  readonly #alert: OperationalAlert;
  /** Segmentos con una fila rechazada de estas versiones. */
  readonly #rejected = new Set<number>();

  constructor(input: LiveCheckpointLookupInput) {
    this.#alert = input.alert;
    this.profile = input.profile;
    this.symbol = input.symbol;
    this.versionsSha256 = liveCheckpointVersionsSha256(input.profile);
  }

  /** ¿Alguna búsqueda rechazó la fila de este segmento? */
  hasRejected(segmentIndex: number): boolean {
    return this.#rejected.has(segmentIndex);
  }

  /**
   * El último punto de control válido del log por debajo del segmento `below`, o de cualquiera con
   * `null`, o el del log vacío si no hay ninguno. Si el almacén no responde, lanza `LogReadError`.
   */
  async lastValid(log: SourceEventLog, below: number | null): Promise<LiveCheckpointBase> {
    const expected = {
      source: this.profile.source,
      symbol: this.symbol,
      versions_sha256: this.versionsSha256,
    };
    let limit = below;
    for (;;) {
      const candidate = await log.readLiveCheckpoint(this.versionsSha256, limit);
      if (candidate === null) {
        return emptyBase();
      }
      const checked = checkStoredCheckpoint(candidate, expected);
      if (checked.status === 'valid') {
        return baseOf(checked.checkpoint);
      }
      const segmentIndex = candidate.row.segment_index;
      if (!this.#rejected.has(segmentIndex)) {
        this.#rejected.add(segmentIndex);
        this.#alert({
          event: 'checkpoint_rejected',
          reason: checked.reason,
          segment_index: String(segmentIndex),
        });
      }
      limit = segmentIndex;
    }
  }
}

export interface LiveCheckpointWriterInput {
  readonly alert: OperationalAlert;
  /** El log de la sesión: el vigente, también después de reabrirlo. */
  readonly log: () => SourceEventLog;
  /**
   * La búsqueda que comparte con los lectores de la sesión, del mismo perfil y el mismo símbolo,
   * para avisar una sola vez de cada fila rechazada; sin ella, una propia.
   */
  readonly lookup?: LiveCheckpointLookup;
  /** La hora de escritura de cada fila, que no entra en ningún hash. */
  readonly now: () => string;
  /** El primer fallo que impide seguir; después, el escritor no escribe nada más. */
  readonly onFailure: (failure: LiveCheckpointFailure) => void;
  readonly profile: PipelineProfile;
  readonly symbol: string;
}

/**
 * Escribe el punto de control de cada segmento cerrado del log de `ingest` (ADR-0017 §5 y §6). El
 * trabajo va en una cola, en orden, y nunca la rechaza:
 *
 * - `rebuild`, al abrir el log, busca el último punto de control válido de sus versiones, de mayor
 *   a menor segmento (`LiveCheckpointLookup`, que avisa una sola vez de cada uno que rechaza, con el
 *   motivo de `checkStoredCheckpoint`). Después reconstruye por partes hasta el último segmento
 *   cerrado: lee y pliega cada segmento de uno en uno y escribe su punto de control, salvo en un
 *   segmento cuya clave ya tiene una fila rechazada, que no se reemplaza, la rechazara esta búsqueda
 *   o la de un lector de la sesión.
 * - `onClosed`, con cada segmento cerrado, sigue igual desde el último punto de control escrito
 *   hasta ese segmento, así que también escribe los cierres que no le llegaron.
 *
 * Si un almacén no responde, al leer los puntos de control, al leer un segmento o al escribir, avisa
 * con `checkpoint_unavailable` y el motivo saneado, y el cierre siguiente lo vuelve a intentar desde
 * el último punto de control escrito: así una inserción ambigua se reintenta, y con el mismo SHA-256
 * cuenta como escrita. Con otro SHA-256 avisa con `checkpoint_conflict`. Ese conflicto, un pliegue
 * que falla y un segmento que no pasa sus comprobaciones llaman a `onFailure`, una sola vez.
 */
export class LiveCheckpointWriter {
  readonly #input: LiveCheckpointWriterInput;
  /** La búsqueda del último válido, que recuerda los segmentos con una fila rechazada (§6). */
  readonly #lookup: LiveCheckpointLookup;
  /** El estado desde el que se escribe el siguiente, o `null` hasta encontrarlo en el log. */
  #base: LiveCheckpointBase | null = null;
  #failure: LiveCheckpointFailure | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: LiveCheckpointWriterInput) {
    const { lookup } = input;
    if (
      lookup !== undefined &&
      (lookup.profile !== input.profile || lookup.symbol !== input.symbol)
    ) {
      throw new TypeError('La búsqueda de puntos de control es de otro perfil o de otro símbolo.');
    }
    this.#input = input;
    this.#lookup =
      lookup ??
      new LiveCheckpointLookup({
        alert: input.alert,
        profile: input.profile,
        symbol: input.symbol,
      });
  }

  /** El fallo que impidió seguir, o `null`. */
  get failure(): LiveCheckpointFailure | null {
    return this.#failure;
  }

  /** Busca el último válido y escribe los que falten hasta el último segmento cerrado. */
  rebuild(): Promise<void> {
    return this.#enqueue(() => this.#advance(this.#input.log().openSegmentIndex - 1));
  }

  /** Escribe los que falten hasta el segmento que se acaba de cerrar. */
  onClosed(segment: ClosedSourceSegment): void {
    void this.#enqueue(() => this.#advance(segment.segment_index));
  }

  /** Se resuelve cuando termina el trabajo pendiente. */
  settle(): Promise<void> {
    return this.#queue;
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(job).catch((error: unknown) => {
      this.#fail('unexpected', error, null);
    });
    return this.#queue;
  }

  #fail(reason: LiveCheckpointFailure['reason'], error: unknown, segmentIndex: number | null) {
    if (this.#failure !== null) {
      return;
    }
    this.#failure = { error, reason, segment_index: segmentIndex };
    this.#input.onFailure(this.#failure);
  }

  async #advance(target: number): Promise<void> {
    if (this.#failure !== null) {
      return;
    }
    let base = this.#base ?? (await this.#establish());
    this.#base = base;
    // `#write` da `null` si no pudo escribir o si ya no se puede seguir.
    while (base !== null && base.segment_index < target) {
      base = await this.#write(base, base.segment_index + 1);
      if (base !== null) {
        this.#base = base;
      }
    }
  }

  /** El último punto de control válido de estas versiones, o el log vacío; `null` si no se pudo leer. */
  async #establish(): Promise<LiveCheckpointBase | null> {
    try {
      return await this.#lookup.lastValid(this.#input.log(), null);
    } catch (error) {
      if (!(error instanceof LogReadError)) {
        throw error;
      }
      this.#input.alert({ event: 'checkpoint_unavailable', reason: error.reason });
      return null;
    }
  }

  /**
   * Pliega el segmento `segmentIndex` desde `base` y escribe su punto de control. Da el estado nuevo,
   * o `null` si no se pudo escribir o no se puede seguir.
   */
  async #write(base: LiveCheckpointBase, segmentIndex: number): Promise<LiveCheckpointBase | null> {
    const log = this.#input.log();
    let read: Awaited<ReturnType<SourceEventLog['readClosedSegment']>>;
    try {
      read = await log.readClosedSegment(segmentIndex);
    } catch (error) {
      if (error instanceof LogReadError) {
        this.#input.alert({
          event: 'checkpoint_unavailable',
          reason: error.reason,
          segment_index: String(segmentIndex),
        });
      } else {
        this.#fail(
          error instanceof LogIntegrityError ? 'log_not_derivable' : 'unexpected',
          error,
          segmentIndex,
        );
      }
      return null;
    }
    let checkpoint: LiveDerivationCheckpoint;
    try {
      checkpoint = buildLiveDerivationCheckpoint({
        event_count: base.event_count + read.segment.event_count,
        profile: this.#input.profile,
        raw_frame_count: base.raw_frame_count + read.segment.raw_frame_count,
        segment_index: segmentIndex,
        segment_logical_content_sha256: read.segment.logical_content_sha256,
        state: foldLiveDerivation(base.state, read.events, this.#input.profile),
        symbol: this.#input.symbol,
      });
    } catch (error) {
      // Como en `deriveMarketData` al arrancar: el log ya no se puede derivar (ADR-0017 §5).
      this.#fail('log_not_derivable', error, segmentIndex);
      return null;
    }
    const next = baseOf(checkpoint);
    if (this.#lookup.hasRejected(segmentIndex)) {
      // Su clave ya tiene una fila rechazada, que no se reemplaza: la supera la del segmento
      // siguiente (ADR-0017 §6).
      return next;
    }
    let result: LiveCheckpointInsert;
    try {
      result = await log.writeLiveCheckpoint(checkpointRow(checkpoint, this.#input.now()));
    } catch (error) {
      this.#input.alert({
        event: 'checkpoint_unavailable',
        reason: failureReason(error),
        segment_index: String(segmentIndex),
      });
      return null;
    }
    if (result === 'conflict') {
      this.#input.alert({ event: 'checkpoint_conflict', segment_index: String(segmentIndex) });
      this.#fail(
        'checkpoint_conflict',
        new LiveCheckpointConflictError(segmentIndex),
        segmentIndex,
      );
      return null;
    }
    return next;
  }
}
