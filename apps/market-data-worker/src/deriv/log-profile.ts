import { canonicalJson, sha256Hex } from '@buoh/contracts';
import type { PipelineProfile } from '@buoh/domain';

import { LogIntegrityError } from '../source-log/source-event-log.js';
import {
  createDerivMeasurementProfileFromSourceSchema,
  createDerivPublicationProfileFromSourceSchema,
  DERIV_PUBLICATION_THRESHOLDS,
  derivPublicationQualityProfile,
} from './profile.js';

// El perfil de cada log (ADR-0020 §4): la fila de `log_quality_profile` (migración 0007 de los logs)
// y cómo la arman sus lectores, el arranque de `ingest` y la sesión de cada corte (con la reparación
// de cierres y la vigilancia de huecos, que usan el perfil de la sesión), `data:health` y el gráfico
// de la API.

/** La fila de `log_quality_profile`: qué perfil de calidad deriva el log y el SHA-256 de su JCS. */
export interface LogQualityProfileRow {
  readonly profile_id: string;
  readonly quality_profile_sha256: string;
}

/**
 * El símbolo del perfil que `buoh-operaciones` da a cada log nuevo: el de la captura de producción
 * (ADR-0018 §4), el único con umbrales medidos (ADR-0020 §1).
 */
export const LOG_PROFILE_SYMBOL = 'R_100';

/**
 * El perfil de un log no es uno que el código sepa armar: otro `profile_id`, otro SHA-256 o el de
 * otro símbolo. Es un `LogIntegrityError`, así que cada lector lo trata como un log que no se puede
 * derivar (`log_not_derivable`): falla cerrado, como una versión sin lector.
 */
export class LogProfileUnknownError extends LogIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'LogProfileUnknownError';
  }
}

/** La fila del perfil de publicación del símbolo, la que da `buoh-operaciones` (ADR-0020 §4). */
export function derivLogProfileRow(symbol: string): LogQualityProfileRow {
  const profile = derivPublicationQualityProfile(symbol);
  return {
    profile_id: profile.profile_id,
    quality_profile_sha256: sha256Hex(canonicalJson(profile)),
  };
}

/**
 * El perfil con el que se deriva un log (ADR-0020 §4), con el esquema de fuente y la release que
 * tiene quien lo arma: sin fila, el de medición, como un log de antes del PR 5; con la del perfil de
 * publicación del símbolo, ese perfil, con el mismo SHA-256. Cualquier otra fila lanza
 * `LogProfileUnknownError`.
 */
export function createDerivLogProfile(input: {
  readonly row: LogQualityProfileRow | null;
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
  readonly symbol: string;
}): PipelineProfile {
  const { row, ...source } = input;
  if (row === null) {
    return createDerivMeasurementProfileFromSourceSchema(source);
  }
  if (!Object.hasOwn(DERIV_PUBLICATION_THRESHOLDS, input.symbol)) {
    throw new LogProfileUnknownError(
      `El log tiene el perfil ${row.profile_id}, y ${input.symbol} no tiene umbrales medidos.`,
    );
  }
  const known = derivLogProfileRow(input.symbol);
  if (
    row.profile_id !== known.profile_id ||
    row.quality_profile_sha256 !== known.quality_profile_sha256
  ) {
    throw new LogProfileUnknownError(
      `El log tiene el perfil ${row.profile_id}, que este código no arma para ${input.symbol}.`,
    );
  }
  return createDerivPublicationProfileFromSourceSchema(source);
}
