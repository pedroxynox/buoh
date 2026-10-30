/** Paso de ADR-0004 §8 en el que se detuvo una publicación. */
export type PublicationStep = 'commit' | 'manifest_write' | 'object_write' | 'precondition';

/** Fallo antes del commit: no hay dataset visible; los objetos escritos quedan huérfanos. */
export class PublicationError extends Error {
  readonly step: PublicationStep;

  constructor(step: PublicationStep, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicationError';
    this.step = step;
  }
}

/** Ya existe un `PublishedManifestRecord` activo para el dataset en el entorno. */
export class PublicationConflictError extends PublicationError {
  readonly datasetId: string;

  constructor(datasetId: string, options?: { cause?: unknown }) {
    super('commit', `El dataset ${datasetId} ya tiene una publicación activa.`, options);
    this.name = 'PublicationConflictError';
    this.datasetId = datasetId;
  }
}

export type ReplayErrorCode =
  | 'CONTRACT_INVALID'
  | 'DATASET_NOT_PUBLISHED'
  | 'FORMAT_UNSUPPORTED'
  | 'MANIFEST_INTEGRITY'
  | 'OBJECT_INTEGRITY'
  | 'OBJECT_LOCATION_UNSUPPORTED'
  | 'RECOMPUTATION_FAILED'
  | 'RECOMPUTATION_MISMATCH'
  | 'STORAGE_UNAVAILABLE'
  | 'VERSION_UNSUPPORTED';

/** Replay abortado: el dataset no se pudo verificar o no se reprodujo. */
export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReplayErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReplayError';
    this.code = code;
    this.details = details;
  }
}

/** Un objeto no existe o supera el tamaño permitido antes de leerse. */
export class ObjectReadError extends Error {
  readonly reason: 'not_found' | 'too_large';

  constructor(reason: 'not_found' | 'too_large', key: string) {
    super(
      reason === 'not_found' ? `Objeto inexistente: ${key}` : `Objeto excede el límite: ${key}`,
    );
    this.name = 'ObjectReadError';
    this.reason = reason;
  }
}

/**
 * El mismo log dio dos puntos de control distintos del segmento `segmentIndex` con las mismas
 * versiones: la clave ya tiene uno con otro SHA-256 (ADR-0017 §5, «Conflicto»). Solo puede ser un
 * error de programación, y se corrige con una versión nueva del formato del estado vivo. Su código
 * es el motivo con que termina la sesión, `checkpoint_conflict`.
 */
export class LiveCheckpointConflictError extends Error {
  readonly code = 'checkpoint_conflict';
  readonly segmentIndex: number;

  constructor(segmentIndex: number) {
    super(`El punto de control del segmento ${String(segmentIndex)} ya existe con otro SHA-256.`);
    this.name = 'LiveCheckpointConflictError';
    this.segmentIndex = segmentIndex;
  }
}
