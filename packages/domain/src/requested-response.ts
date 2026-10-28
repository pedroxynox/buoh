import {
  dataQualityIncidentSchema,
  deriveEventId,
  type DataQualityIncident,
  type RawSourceFrame,
} from '@buoh/contracts';

import { getMember, toPlainJson, type JsonNode } from './json-lexeme.js';
import { RULE_SETS } from './profile.js';

/**
 * Respuestas pedidas (contratos de dominio, «Incidencias de respuestas pedidas»; ADR-0012 §6). Las
 * reglas 2.0.0 no comprueban las respuestas declaradas en `non_tick_msg_types`: lo hace quien las
 * pidió, con estas funciones puras, después de que el frame sea durable.
 *
 * Motivos de `evidence.reason`. `schema_validation_failed` y `source_error_response` valen para toda
 * respuesta pedida; los `catalog_*`, solo para el catálogo (contratos de dominio,
 * «SourceCatalogSnapshot»), y `history_inconsistent`, solo para la respuesta a `ticks_history`
 * que cumple su esquema pero no es coherente (ADR-0015 §4): le falta `history`, `history.times`,
 * `history.prices` o `pip_size`, o falla en `pip_size`, longitudes, orden o rango de
 * `history.times`, o en un precio que no acepta la regla de `quote_decimal`.
 */
export type RequestedResponseInvalidReason =
  | 'catalog_duplicate_symbol'
  | 'catalog_empty'
  | 'catalog_entry_invalid'
  | 'catalog_exponent_not_supported'
  | 'history_inconsistent'
  | 'schema_validation_failed'
  | 'source_error_response';

/**
 * Las dos comprobaciones comunes, en orden: un objeto `error` (como en las reglas 2.0.0) y después
 * el esquema de respuesta de la operación en la release fijada. `null` si la respuesta pasa las dos.
 */
export function checkRequestedResponse(
  root: JsonNode,
  validateResponse: (value: unknown) => boolean,
): 'schema_validation_failed' | 'source_error_response' | null {
  if (getMember(root, 'error')?.type === 'object') {
    return 'source_error_response';
  }
  if (!validateResponse(toPlainJson(root))) {
    return 'schema_validation_failed';
  }
  return null;
}

/**
 * Incidencia de una respuesta pedida inválida. Todos sus campos salen del frame durable y del
 * motivo, así que se puede volver a derivar igual. `symbol` es `null` porque ninguna respuesta
 * declarada es de un símbolo: es una diferencia deliberada con la atribución de las reglas 2.0.0.
 */
export function deriveRequestedResponseIncident(
  frame: RawSourceFrame,
  reason: RequestedResponseInvalidReason,
): DataQualityIncident {
  const rules = RULE_SETS['2.0.0'];
  const body = {
    evidence: { raw_payload_sha256: frame.raw_payload_sha256, reason },
    incident_type: 'invalid_source_frame',
    observed_at_utc: frame.received_at_utc,
    observed_ref: frame.observation_id,
    quality_rule_version: rules.quality_rule_version,
    related_refs: [],
    schema_version: rules.incident_schema_version,
    severity: 'error',
    source: frame.source,
    symbol: null,
  };
  return dataQualityIncidentSchema.parse({ ...body, incident_id: deriveEventId(body) });
}
