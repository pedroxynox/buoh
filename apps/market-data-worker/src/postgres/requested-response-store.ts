import {
  canonicalJson,
  dataQualityIncidentSchema,
  type DataQualityIncident,
  type JsonValue,
} from '@buoh/contracts';
import { type Pool } from 'pg';

import { type RequestedResponseIncidentStore } from '../deriv/ports.js';

/**
 * Incidencias de respuestas pedidas sobre PostgreSQL (tabla append-only
 * `requested_response_incidents`, migración `0003`; ADR-0012 §6). La incidencia se deriva del frame
 * durable, así que guardarla otra vez no añade nada: el mismo `incident_id` se ignora.
 */
export class PostgresRequestedResponseIncidentStore implements RequestedResponseIncidentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append(input: DataQualityIncident): Promise<void> {
    const incident = dataQualityIncidentSchema.parse(input);
    if (incident.incident_type !== 'invalid_source_frame') {
      throw new TypeError(
        `Una respuesta pedida solo deja invalid_source_frame, no ${incident.incident_type}.`,
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
