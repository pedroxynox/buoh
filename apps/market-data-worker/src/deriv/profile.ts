import { canonicalJson } from '@buoh/contracts';
import {
  createPipelineProfile,
  RULE_SETS,
  utf8,
  type PipelineProfile,
  type QualityProfile,
} from '@buoh/domain';

import { type DerivSchemaSet } from './schema-archive.js';

/**
 * Identidad de la fuente (ADR-0012 §1). Cambiar peticiones, límites o transporte crea otro conector:
 * la 1.1.0 añade `ticks_history` y la reconexión (ADR-0015 §1).
 */
export const DERIV_SOURCE = 'deriv_options';
export const DERIV_CONNECTOR_VERSION = 'deriv-options-ws-1.1.0';
export const DERIV_PUBLIC_ENDPOINT = 'wss://api.derivws.com/trading/v1/options/ws/public';

/**
 * Respuestas pedidas que no son ticks (ADR-0012 §5 y ADR-0015 §1), en orden. `history` es la
 * respuesta a `ticks_history`. No están `ticks` ni `ticks_history`, que traen el error de una
 * suscripción o de una petición de historia rechazadas, ni `error`, la respuesta a un método
 * desconocido: las reglas 2.0.0 registran los tres como `source_error_response`.
 */
export const DERIV_NON_TICK_MSG_TYPES = [
  'active_symbols',
  'forget_all',
  'history',
  'ping',
  'time',
] as const;

/**
 * Perfil de medición del adaptador: reglas 2.0.0, un solo símbolo y sin umbrales. Sirve para
 * normalizar y para derivar el estado vivo (salud, condiciones y continuidad; ADR-0015 §2), y nunca
 * publica un dataset (ADR-0012 §8). El esquema de fuente es `ticks_response.schema.json` de la
 * release cargada. Sus bytes son el JCS del perfil, así que el mismo símbolo da siempre el mismo
 * hash.
 */
export function createDerivMeasurementProfile(input: {
  readonly schemas: DerivSchemaSet;
  readonly symbol: string;
}): PipelineProfile {
  return createDerivMeasurementProfileFromSourceSchema({
    source_schema_bytes: input.schemas.schema('ticks', 'response').bytes,
    source_schema_release: input.schemas.release,
    symbol: input.symbol,
  });
}

/**
 * El mismo perfil de medición, armado con los bytes del esquema de fuente y su release en lugar de
 * los esquemas cargados: `data:health` lo arma con el esquema que guardó la ingesta (ADR-0015 §7 y
 * §8), sin descargar nada. Con los bytes de `ticks_response.schema.json` y la release de unos
 * esquemas cargados da el perfil de `createDerivMeasurementProfile`.
 */
export function createDerivMeasurementProfileFromSourceSchema(input: {
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
  readonly symbol: string;
}): PipelineProfile {
  const qualityProfile = {
    allowed_symbols: [input.symbol],
    gap_detection: 'after_reconnection',
    non_tick_msg_types: [...DERIV_NON_TICK_MSG_TYPES],
    // Versionado como `synthetic-v1`: cambiar las respuestas declaradas cambia el identificador. La
    // v2 declara `history` (ADR-0015 §1).
    profile_id: `${DERIV_SOURCE}-measurement-v2-${input.symbol}`,
    purpose: 'measurement',
    quality_rule_version: RULE_SETS['2.0.0'].quality_rule_version,
    source: DERIV_SOURCE,
  } satisfies QualityProfile;
  return createPipelineProfile({
    connector_version: DERIV_CONNECTOR_VERSION,
    quality_profile_bytes: utf8(canonicalJson(qualityProfile)),
    source_schema_bytes: input.source_schema_bytes,
    source_schema_release: input.source_schema_release,
  });
}
