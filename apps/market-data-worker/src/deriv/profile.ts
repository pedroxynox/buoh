import { canonicalJson } from '@buoh/contracts';
import {
  createPipelineProfile,
  RULE_SETS,
  utf8,
  type PipelineProfile,
  type QualityProfile,
} from '@buoh/domain';

import { type DerivSchemaSet } from './schema-archive.js';

/** Identidad de la fuente (ADR-0012 §1). Cambiar peticiones, límites o transporte crea otro conector. */
export const DERIV_SOURCE = 'deriv_options';
export const DERIV_CONNECTOR_VERSION = 'deriv-options-ws-1.0.0';
export const DERIV_PUBLIC_ENDPOINT = 'wss://api.derivws.com/trading/v1/options/ws/public';

/**
 * Respuestas pedidas que no son ticks (ADR-0012 §5), en orden. Ni `ticks`, que trae el error de una
 * suscripción fallida, ni `error`, la respuesta a un método desconocido: las reglas 2.0.0 registran
 * los dos como `source_error_response`.
 */
export const DERIV_NON_TICK_MSG_TYPES = ['active_symbols', 'forget_all', 'ping', 'time'] as const;

/**
 * Perfil de medición del adaptador (ADR-0012 §8): reglas 2.0.0, un solo símbolo y sin umbrales, así
 * que nunca deriva ni publica un dataset. El esquema de fuente es `ticks_response.schema.json` de la
 * release cargada. Sus bytes son el JCS del perfil, así que el mismo símbolo da siempre el mismo
 * hash.
 */
export function createDerivMeasurementProfile(input: {
  readonly schemas: DerivSchemaSet;
  readonly symbol: string;
}): PipelineProfile {
  const qualityProfile = {
    allowed_symbols: [input.symbol],
    gap_detection: 'after_reconnection',
    non_tick_msg_types: [...DERIV_NON_TICK_MSG_TYPES],
    profile_id: `${DERIV_SOURCE}-measurement-${input.symbol}`,
    purpose: 'measurement',
    quality_rule_version: RULE_SETS['2.0.0'].quality_rule_version,
    source: DERIV_SOURCE,
  } satisfies QualityProfile;
  return createPipelineProfile({
    connector_version: DERIV_CONNECTOR_VERSION,
    quality_profile_bytes: utf8(canonicalJson(qualityProfile)),
    source_schema_bytes: input.schemas.schema('ticks', 'response').bytes,
    source_schema_release: input.schemas.release,
  });
}
