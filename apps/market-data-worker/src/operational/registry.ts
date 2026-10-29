import {
  dataQualityIncidentSchema,
  deriveEventId,
  derivePersistenceConditionKey,
  deriveSourceLimitConditionKey,
  operationalConditionEventSchema,
  validateConditionCausality,
  type ConditionType,
  type DataQualityIncident,
  type OperationalConditionEvent,
  type persistenceStageSchema,
  type SourceEvent,
} from '@buoh/contracts';
import {
  CONTRACT_SCHEMA_VERSION,
  QUALITY_RULE_VERSION,
  sourceEventTime,
  type SourceLimitViolation,
} from '@buoh/domain';
import { type z } from 'zod';

import { failureReason, sourceEventId } from '../source-log/source-event-log.js';

export type PersistenceStage = z.infer<typeof persistenceStageSchema>;

type OperationalType = 'persistence_unavailable' | 'source_limit_exceeded';

/** Puerto PostgreSQL del registro operativo (tablas `operational_*`, append-only). */
export interface OperationalStore {
  load(source: string): Promise<{
    conditions: OperationalConditionEvent[];
    incidents: DataQualityIncident[];
  }>;
  /** Inserta incidencias y condiciones en una única transacción. */
  append(input: {
    conditions: readonly OperationalConditionEvent[];
    incidents: readonly DataQualityIncident[];
  }): Promise<void>;
}

/** Alerta estructurada y sanitizada cuando PostgreSQL no permite registrar. */
export type OperationalAlert = (payload: Readonly<Record<string, string | null>>) => void;

export const stderrAlert: OperationalAlert = (payload) => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

export type RecordResult =
  | {
      readonly conditions: readonly OperationalConditionEvent[];
      readonly incident: DataQualityIncident | null;
      readonly status: 'recorded';
    }
  | { readonly status: 'alert_only' };

export const OPERATIONAL_RESOLUTION_REASONS = {
  persistence_unavailable: 'persistence_restored',
  source_limit_exceeded: 'input_reopened',
} as const;

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

interface RecordInput {
  readonly observed_at_utc: string;
  /** `observation_id` del frame afectado o UUIDv7 del intento. */
  readonly observed_ref: string;
  /** Último source event durable, si existe. */
  readonly related_refs: readonly string[];
  readonly symbol?: string | null;
}

/**
 * Registro operativo de `persistence_unavailable` y `source_limit_exceeded` (contratos de dominio,
 * «Registro operativo de persistencia y límites»). Vive fuera de los datasets; cada escritura se
 * valida con `validateConditionCausality` antes de persistirse.
 */
export class OperationalRegistry {
  readonly source: string;
  readonly #store: OperationalStore;
  readonly #alert: OperationalAlert;
  readonly #incidents = new Map<string, DataQualityIncident>();
  /** Última condición por `condition_key`. */
  readonly #latest = new Map<string, OperationalConditionEvent>();

  private constructor(source: string, store: OperationalStore, alert: OperationalAlert) {
    this.source = source;
    this.#store = store;
    this.#alert = alert;
  }

  static async open(input: {
    readonly alert?: OperationalAlert;
    readonly source: string;
    readonly store: OperationalStore;
  }): Promise<OperationalRegistry> {
    const registry = new OperationalRegistry(input.source, input.store, input.alert ?? stderrAlert);
    const loaded = await input.store.load(input.source);
    const incidents = loaded.incidents.map((item) => dataQualityIncidentSchema.parse(item));
    const conditions = loaded.conditions
      .map((item) => operationalConditionEventSchema.parse(item))
      .toSorted((left, right) =>
        left.occurred_at_utc === right.occurred_at_utc
          ? left.condition_event_id < right.condition_event_id
            ? -1
            : 1
          : left.occurred_at_utc < right.occurred_at_utc
            ? -1
            : 1,
      );
    for (const incident of incidents) {
      registry.#incidents.set(incident.incident_id, incident);
    }
    for (const condition of conditions) {
      registry.#latest.set(condition.condition_key, condition);
    }
    return registry;
  }

  /** Condiciones cuya última acción es `opened`. */
  openConditions(): OperationalConditionEvent[] {
    return [...this.#latest.values()]
      .filter((condition) => condition.action === 'opened')
      .toSorted((left, right) => (left.condition_key < right.condition_key ? -1 : 1));
  }

  /** Los tipos de las condiciones abiertas, únicos y ordenados; los lee `data:health`. */
  openConditionTypes(): ConditionType[] {
    return sortedUnique(this.openConditions().map((condition) => condition.condition_type));
  }

  recordPersistenceUnavailable(
    input: RecordInput & { readonly reason: string; readonly stage: PersistenceStage },
  ): Promise<RecordResult> {
    return this.#record({
      ...input,
      condition_key: derivePersistenceConditionKey(this.source, input.stage),
      evidence: { reason: input.reason, stage: input.stage },
      incident_type: 'persistence_unavailable',
      severity: 'critical',
    });
  }

  recordSourceLimitExceeded(
    input: RecordInput & { readonly violation: SourceLimitViolation },
  ): Promise<RecordResult> {
    const { violation } = input;
    return this.#record({
      ...input,
      condition_key: deriveSourceLimitConditionKey(this.source, violation.evidence.resource),
      evidence: { ...violation.evidence },
      incident_type: 'source_limit_exceeded',
      // Frame o cola imponen `paused` → error; esquema o ZIP imponen `failed` → critical.
      severity: violation.service_health === 'failed' ? 'critical' : 'error',
    });
  }

  /**
   * Resuelve las condiciones abiertas que `event`, ya durable, demuestra superadas: cualquier evento
   * confirmado restaura la persistencia; solo `ConnectionOpened` reabre la entrada tras un límite.
   */
  async resolveWith(input: SourceEvent): Promise<RecordResult> {
    const resolvable = this.openConditions().filter(
      (condition) =>
        condition.condition_type === 'persistence_unavailable' ||
        input.kind === 'connection_opened',
    );
    if (resolvable.length === 0) {
      return { conditions: [], incident: null, status: 'recorded' };
    }
    const occurredAt = sourceEventTime(input);
    const resolutions = resolvable.map((opening) => {
      if (occurredAt <= opening.occurred_at_utc) {
        throw new TypeError('La resolución debe ser posterior a la apertura.');
      }
      const type = opening.condition_type as OperationalType;
      const body = {
        action: 'resolved',
        cause_refs: sortedUnique([opening.condition_event_id, sourceEventId(input)]),
        condition_key: opening.condition_key,
        condition_type: type,
        occurred_at_utc: occurredAt,
        resolution_reason: OPERATIONAL_RESOLUTION_REASONS[type],
        schema_version: CONTRACT_SCHEMA_VERSION,
        source: this.source,
        symbol: opening.symbol,
      };
      return operationalConditionEventSchema.parse({
        ...body,
        condition_event_id: deriveEventId(body),
      });
    });
    const openingIncidents = resolvable.flatMap((opening) =>
      opening.cause_refs
        .map((reference) => this.#incidents.get(reference))
        .filter((incident): incident is DataQualityIncident => incident !== undefined),
    );
    validateConditionCausality({
      conditions: [...resolvable, ...resolutions],
      incidents: openingIncidents,
      sourceEvents: [input],
    });
    try {
      await this.#store.append({ conditions: resolutions, incidents: [] });
    } catch (error) {
      this.#alert({
        event: 'operational_registry_unavailable',
        observed_ref: sourceEventId(input),
        operation: 'resolve',
        reason: failureReason(error),
      });
      return { status: 'alert_only' };
    }
    for (const resolution of resolutions) {
      this.#latest.set(resolution.condition_key, resolution);
    }
    return { conditions: resolutions, incident: null, status: 'recorded' };
  }

  async #record(
    input: RecordInput & {
      readonly condition_key: string;
      readonly evidence: Readonly<Record<string, number | string>>;
      readonly incident_type: OperationalType;
      readonly severity: 'critical' | 'error';
    },
  ): Promise<RecordResult> {
    const symbol = input.symbol ?? null;
    const body = {
      evidence: input.evidence,
      incident_type: input.incident_type,
      observed_at_utc: input.observed_at_utc,
      observed_ref: input.observed_ref,
      quality_rule_version: QUALITY_RULE_VERSION,
      related_refs: sortedUnique(input.related_refs),
      schema_version: CONTRACT_SCHEMA_VERSION,
      severity: input.severity,
      source: this.source,
      symbol,
    };
    const incident = dataQualityIncidentSchema.parse({
      ...body,
      incident_id: deriveEventId(body),
    });

    // Una repetición registra la incidencia sin reabrir una clave ya abierta.
    const conditions: OperationalConditionEvent[] = [];
    if (this.#latest.get(input.condition_key)?.action !== 'opened') {
      const opening = {
        action: 'opened',
        cause_refs: [incident.incident_id],
        condition_key: input.condition_key,
        condition_type: input.incident_type,
        occurred_at_utc: input.observed_at_utc,
        schema_version: CONTRACT_SCHEMA_VERSION,
        source: this.source,
        symbol,
      };
      conditions.push(
        operationalConditionEventSchema.parse({
          ...opening,
          condition_event_id: deriveEventId(opening),
        }),
      );
    }
    validateConditionCausality({ conditions, incidents: [incident], sourceEvents: [] });

    try {
      await this.#store.append({ conditions, incidents: [incident] });
    } catch (error) {
      this.#alert({
        event: 'operational_registry_unavailable',
        incident_type: input.incident_type,
        observed_at_utc: input.observed_at_utc,
        observed_ref: input.observed_ref,
        operation: 'record',
        reason: failureReason(error),
        subject: String(input.evidence['stage'] ?? input.evidence['resource'] ?? ''),
      });
      return { status: 'alert_only' };
    }
    this.#incidents.set(incident.incident_id, incident);
    for (const condition of conditions) {
      this.#latest.set(condition.condition_key, condition);
    }
    return { conditions, incident, status: 'recorded' };
  }
}
