import {
  canonicalJson,
  dataQualityIncidentSchema,
  operationalConditionEventSchema,
  type DataQualityIncident,
  type OperationalConditionEvent,
} from '@buoh/contracts';
import { type Pool } from 'pg';

import { type OperationalStore } from '../operational/registry.js';

/** Registro operativo sobre PostgreSQL estándar (tablas `operational_*`). */
export class PostgresOperationalStore implements OperationalStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async load(source: string): Promise<{
    conditions: OperationalConditionEvent[];
    incidents: DataQualityIncident[];
  }> {
    const incidents = await this.#pool.query<{ incident_jcs: string }>(
      'SELECT incident_jcs FROM operational_incidents WHERE source = $1 ORDER BY incident_id',
      [source],
    );
    const conditions = await this.#pool.query<{ condition_jcs: string }>(
      `SELECT condition_jcs FROM operational_conditions WHERE source = $1
        ORDER BY occurred_at_utc, condition_event_id`,
      [source],
    );
    return {
      conditions: conditions.rows.map((row) =>
        operationalConditionEventSchema.parse(JSON.parse(row.condition_jcs)),
      ),
      incidents: incidents.rows.map((row) =>
        dataQualityIncidentSchema.parse(JSON.parse(row.incident_jcs)),
      ),
    };
  }

  async append(input: {
    conditions: readonly OperationalConditionEvent[];
    incidents: readonly DataQualityIncident[];
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (const incident of input.incidents) {
        await client.query(
          `INSERT INTO operational_incidents
             (incident_id, incident_type, severity, source, symbol, observed_at_utc, incident_jcs)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (incident_id) DO NOTHING`,
          [
            incident.incident_id,
            incident.incident_type,
            incident.severity,
            incident.source,
            incident.symbol,
            incident.observed_at_utc,
            canonicalJson(incident),
          ],
        );
      }
      for (const condition of input.conditions) {
        await client.query(
          `INSERT INTO operational_conditions
             (condition_event_id, condition_key, condition_type, action, source, symbol,
              occurred_at_utc, condition_jcs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (condition_event_id) DO NOTHING`,
          [
            condition.condition_event_id,
            condition.condition_key,
            condition.condition_type,
            condition.action,
            condition.source,
            condition.symbol,
            condition.occurred_at_utc,
            canonicalJson(condition),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
