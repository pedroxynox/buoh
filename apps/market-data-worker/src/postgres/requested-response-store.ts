import {
  canonicalJson,
  dataQualityIncidentSchema,
  type DataQualityIncident,
  type JsonValue,
} from '@buoh/contracts';
import { RULE_SETS } from '@buoh/domain';
import { type Pool } from 'pg';

import { type RequestedResponseIncidentStore } from '../deriv/ports.js';

const RULES = RULE_SETS['2.0.0'];

/**
 * Incidencias de respuestas pedidas sobre PostgreSQL (tabla append-only
 * `requested_response_incidents`, migración `0003`; ADR-0012 §6). La incidencia se deriva del frame
 * durable, así que guardarla otra vez no añade nada: el mismo `incident_id` se ignora.
 *
 * Solo admite la forma que arma `deriveRequestedResponseIncident`: `invalid_source_frame` con
 * reglas y esquema 2.0.0, severidad `error`, sin símbolo y sin `related_refs`. Así una incidencia de
 * las reglas 2.0.0, que puede tener los mismos motivos, nunca acaba aquí por error.
 */
export class PostgresRequestedResponseIncidentStore implements RequestedResponseIncidentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append(input: DataQualityIncident): Promise<void> {
    const incident = dataQualityIncidentSchema.parse(input);
    if (
      incident.incident_type !== 'invalid_source_frame' ||
      incident.schema_version !== RULES.incident_schema_version ||
      incident.quality_rule_version !== RULES.quality_rule_version ||
      incident.severity !== 'error' ||
      incident.symbol !== null ||
      incident.related_refs.length > 0
    ) {
      throw new TypeError(
        'Una respuesta pedida solo deja invalid_source_frame 2.0.0, con severidad error, sin símbolo y sin related_refs.',
      );
    }
    await this.#pool.query(
      `INSERT INTO requested_response_incidents
         (incident_id, incident_type, source, observed_ref, observed_at_utc, reason, incident_jcs)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (incident_id) DO NOTHING`,
      [
        incident.incident_id,
        incident.incident_type,
        incident.source,
        incident.observed_ref,
        incident.observed_at_utc,
        incident.evidence.reason,
        canonicalJson(incident as JsonValue),
      ],
    );
  }
}
