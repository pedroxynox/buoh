import { canonicalJson } from '@buoh/contracts';
import {
  createPipelineProfile,
  RULE_SETS,
  utf8,
  type PipelineProfile,
  type QualityProfile,
} from '@buoh/domain';

import type { DerivSchemaSet } from './schema-archive.js';

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

/**
 * Umbrales live medidos por símbolo (ADR-0020 §1): el retraso de entrega, el intervalo nominal más
 * la resolución de la hora de fuente, y el hueco, el intervalo nominal. Solo R_100 está medido; otro
 * símbolo se mide aparte y lleva otro perfil.
 */
export const DERIV_PUBLICATION_THRESHOLDS = {
  R_100: { maximum_delivery_delay_ms: 3000, maximum_event_gap_ms: 2000 },
} as const satisfies Record<
  string,
  { readonly maximum_delivery_delay_ms: number; readonly maximum_event_gap_ms: number }
>;

/**
 * Perfil de publicación de los datasets vivos (ADR-0020 §2): `deriv_options-publication-v1-<símbolo>`,
 * con los umbrales medidos del símbolo, las reglas 3.0.0 y las mismas respuestas que no son ticks
 * que el perfil de medición, que no cambia. El esquema de fuente es `ticks_response.schema.json` de la
 * release cargada, como el de medición. Rechaza un símbolo sin umbrales medidos.
 */
export function createDerivPublicationProfile(input: {
  readonly schemas: DerivSchemaSet;
  readonly symbol: string;
}): PipelineProfile {
  return createDerivPublicationProfileFromSourceSchema({
    source_schema_bytes: input.schemas.schema('ticks', 'response').bytes,
    source_schema_release: input.schemas.release,
    symbol: input.symbol,
  });
}

/**
 * El mismo perfil de publicación, armado con los bytes del esquema de fuente que guardó la ingesta y
 * su release (`readStoredSourceSchema`), como `createDerivMeasurementProfileFromSourceSchema`.
 */
export function createDerivPublicationProfileFromSourceSchema(input: {
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
  readonly symbol: string;
}): PipelineProfile {
  if (!Object.hasOwn(DERIV_PUBLICATION_THRESHOLDS, input.symbol)) {
    throw new TypeError(
      `El símbolo ${input.symbol} no tiene umbrales medidos: no publica datasets (ADR-0020 §1).`,
    );
  }
  const thresholds =
    DERIV_PUBLICATION_THRESHOLDS[input.symbol as keyof typeof DERIV_PUBLICATION_THRESHOLDS];
  const qualityProfile = {
    allowed_symbols: [input.symbol],
    gap_detection: 'after_reconnection',
    maximum_delivery_delay_ms: thresholds.maximum_delivery_delay_ms,
    maximum_event_gap_ms: thresholds.maximum_event_gap_ms,
    non_tick_msg_types: [...DERIV_NON_TICK_MSG_TYPES],
    profile_id: `${DERIV_SOURCE}-publication-v1-${input.symbol}`,
    quality_rule_version: RULE_SETS['3.0.0'].quality_rule_version,
    source: DERIV_SOURCE,
  } satisfies QualityProfile;
  return createPipelineProfile({
    connector_version: DERIV_CONNECTOR_VERSION,
    quality_profile_bytes: utf8(canonicalJson(qualityProfile)),
    source_schema_bytes: input.source_schema_bytes,
    source_schema_release: input.source_schema_release,
  });
}
