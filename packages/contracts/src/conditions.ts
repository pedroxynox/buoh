import { z } from 'zod';

import { conditionTypeSchema } from './enums.js';
import { dataQualityIncidentSchema, type DataQualityIncident } from './data-quality.js';
import { canonicalJson, deriveEventId, sha256Hex, type JsonValue } from './identity.js';
import {
  conditionKeySchema,
  eventRefSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  schemaVersionSchema,
  symbolSchema,
  utcTimestampMsSchema,
} from './scalars.js';
import { sourceEventSchema, type SourceEvent } from './source-events.js';

/**
 * `OperationalConditionEvent` (contratos de dominio, «OperationalConditionEvent»): una condición
 * con estado que se abre por una incidencia y se resuelve con evidencia nueva. Las condiciones
 * abiertas son las que impiden la salud `healthy`.
 */
const conditionBase = {
  schema_version: schemaVersionSchema,
  condition_event_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  condition_key: conditionKeySchema,
  condition_type: conditionTypeSchema,
  source: nonEmptyStringSchema,
  symbol: symbolSchema.nullable(),
  occurred_at_utc: utcTimestampMsSchema,
  cause_refs: z.array(eventRefSchema).min(1),
};

const openedConditionSchema = z.strictObject({
  ...conditionBase,
  action: z.literal('opened'),
});
const resolvedConditionSchema = z.strictObject({
  ...conditionBase,
  action: z.literal('resolved'),
  resolution_reason: nonEmptyStringSchema,
});

export const operationalConditionEventStructuralSchema = z
  .discriminatedUnion('action', [openedConditionSchema, resolvedConditionSchema])
  .meta({ id: 'OperationalConditionEvent', title: 'OperationalConditionEvent' });

export const operationalConditionEventSchema =
  operationalConditionEventStructuralSchema.superRefine((value, context) => {
    if (!isSortedUnique(value.cause_refs)) {
      context.addIssue({
        code: 'custom',
        message: 'cause_refs debe ser único y estar ordenado.',
        path: ['cause_refs'],
      });
    }

    if (!value.condition_key.startsWith(`${value.condition_type}:sha256:`)) {
      context.addIssue({
        code: 'custom',
        message: 'condition_key no corresponde a condition_type.',
        path: ['condition_key'],
      });
    }

    const body = { ...value } as Record<string, unknown>;
    delete body['condition_event_id'];
    if (deriveEventId(body as JsonValue) !== value.condition_event_id) {
      context.addIssue({
        code: 'custom',
        message: 'condition_event_id no corresponde al contenido canónico.',
        path: ['condition_event_id'],
      });
    }
  });

/**
 * La clave identifica la situación, no el evento: la apertura y su resolución comparten clave, y
 * una segunda apertura con la misma clave sin resolver es un error (`CONDITION_OPEN_DUPLICATE`).
 */
function deriveConditionKey(type: string, identity: JsonValue): string {
  return `${type}:sha256:${sha256Hex(canonicalJson(identity))}`;
}

export function deriveConnectionConditionKey(source: string, closedConnectionId: string): string {
  return deriveConditionKey('connection_lost', {
    closed_connection_id: closedConnectionId,
    source,
  });
}

export function deriveGapConditionKey(input: {
  from_event_time_utc: string;
  source: string;
  symbol: string;
  to_event_time_utc: string;
}): string {
  return deriveConditionKey('event_gap_unresolved', input);
}

export function derivePersistenceConditionKey(source: string, stage: string): string {
  return deriveConditionKey('persistence_unavailable', { source, stage });
}

export function deriveSourceLimitConditionKey(source: string, resource: string): string {
  return deriveConditionKey('source_limit_exceeded', { resource, source });
}

export interface ConditionCausalityInput {
  conditions: readonly unknown[];
  incidents: readonly unknown[];
  sourceEvents: readonly unknown[];
}

export interface ConditionCausalityResult {
  conditions: OperationalConditionEvent[];
  openConditionTypes: string[];
}

export type ContractContextErrorCode =
  | 'CONDITION_CAUSE_INVALID'
  | 'CONDITION_IDENTITY_MISMATCH'
  | 'CONDITION_NOT_STATEFUL'
  | 'CONDITION_OPEN_DUPLICATE'
  | 'CONDITION_OPEN_REQUIRES_INCIDENT'
  | 'CONDITION_OPERATIONAL_EVIDENCE_MISSING'
  | 'CONDITION_RECOVERY_MISMATCH'
  | 'CONDITION_RECONNECT_MISMATCH'
  | 'CONDITION_REFERENCE_UNKNOWN'
  | 'CONDITION_RESOLUTION_MISMATCH'
  | 'DATASET_COUNT_MISMATCH'
  | 'DATASET_ORDER_INVALID'
  | 'DATASET_PROVENANCE_MISMATCH'
  | 'DATASET_RANGE_MISMATCH'
  | 'DATASET_REFERENCE_UNKNOWN'
  | 'DATASET_VERSION_MISMATCH';

export class ContractContextError extends Error {
  readonly code: ContractContextErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  readonly path: readonly (number | string)[];

  constructor(input: {
    code: ContractContextErrorCode;
    context?: Readonly<Record<string, unknown>>;
    message: string;
    path: readonly (number | string)[];
  }) {
    super(input.message);
    this.name = 'ContractContextError';
    this.code = input.code;
    this.context = input.context ?? {};
    this.path = input.path;
  }
}

function failContext(input: ConstructorParameters<typeof ContractContextError>[0]): never {
  throw new ContractContextError(input);
}

function getSourceEventId(event: SourceEvent): string {
  return event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;
}

function getExpectedConditionKey(
  incident: DataQualityIncident,
  sourceById: ReadonlyMap<string, SourceEvent>,
): string {
  switch (incident.incident_type) {
    case 'connection_lost': {
      const closed = sourceById.get(incident.observed_ref);
      if (closed?.kind !== 'connection_closed' || closed.source !== incident.source) {
        failContext({
          code: 'CONDITION_CAUSE_INVALID',
          context: { incident_id: incident.incident_id },
          message: `Causa de conexión inválida: ${incident.incident_id}`,
          path: ['incidents', incident.incident_id, 'observed_ref'],
        });
      }
      return deriveConnectionConditionKey(incident.source, closed.connection_id);
    }
    case 'event_gap_unresolved':
      return deriveGapConditionKey({
        from_event_time_utc: incident.evidence.from_event_time_utc,
        source: incident.source,
        symbol: incident.symbol,
        to_event_time_utc: incident.evidence.to_event_time_utc,
      });
    case 'persistence_unavailable':
      return derivePersistenceConditionKey(incident.source, incident.evidence.stage);
    case 'source_limit_exceeded':
      return deriveSourceLimitConditionKey(incident.source, incident.evidence.resource);
    case 'delivery_delayed':
    case 'duplicate_exact':
    case 'invalid_source_frame':
    case 'out_of_order':
    case 'source_time_conflict':
      failContext({
        code: 'CONDITION_NOT_STATEFUL',
        context: { incident_type: incident.incident_type },
        message: `La incidencia ${incident.incident_type} no abre una condición.`,
        path: ['incidents', incident.incident_id, 'incident_type'],
      });
  }
}

/**
 * Comprueba que cada condición tiene la causa correcta: una apertura nace de una sola incidencia
 * de su tipo, y una resolución referencia su apertura y la evidencia propia de su tipo
 * (reconexión para `connection_lost`, recuperación completa del mismo rango para un hueco, y al
 * menos una referencia más para el resto). Recorre en orden de `occurred_at_utc`.
 */
export function validateConditionCausality(
  input: ConditionCausalityInput,
): ConditionCausalityResult {
  const sourceEvents = input.sourceEvents.map((event) => sourceEventSchema.parse(event));
  const incidents = input.incidents.map((incident) => dataQualityIncidentSchema.parse(incident));
  const conditions = input.conditions.map((condition) =>
    operationalConditionEventSchema.parse(condition),
  );
  const sourceById = new Map(sourceEvents.map((event) => [getSourceEventId(event), event]));
  const incidentById = new Map(incidents.map((incident) => [incident.incident_id, incident]));
  const sortedConditions = conditions.toSorted((left, right) =>
    left.occurred_at_utc === right.occurred_at_utc
      ? left.condition_event_id.localeCompare(right.condition_event_id)
      : left.occurred_at_utc.localeCompare(right.occurred_at_utc),
  );
  const seenConditions = new Map<string, OperationalConditionEvent>();
  const openingByKey = new Map<
    string,
    { condition: OperationalConditionEvent; incident: DataQualityIncident }
  >();

  for (const condition of sortedConditions) {
    for (const reference of condition.cause_refs) {
      if (
        !sourceById.has(reference) &&
        !incidentById.has(reference) &&
        !seenConditions.has(reference)
      ) {
        failContext({
          code: 'CONDITION_REFERENCE_UNKNOWN',
          context: { reference },
          message: `Referencia causal desconocida: ${reference}`,
          path: ['conditions', condition.condition_event_id, 'cause_refs'],
        });
      }
    }

    if (condition.action === 'opened') {
      const matchingIncidents: DataQualityIncident[] = [];
      for (const reference of condition.cause_refs) {
        const incident = incidentById.get(reference);
        if (incident?.incident_type === condition.condition_type) {
          matchingIncidents.push(incident);
        }
      }
      if (matchingIncidents.length !== 1) {
        failContext({
          code: 'CONDITION_OPEN_REQUIRES_INCIDENT',
          context: { matching_incident_count: matchingIncidents.length },
          message: `La apertura requiere una incidencia causal única: ${condition.condition_key}`,
          path: ['conditions', condition.condition_event_id, 'cause_refs'],
        });
      }

      const [incident] = matchingIncidents;
      if (
        incident === undefined ||
        condition.condition_key !== getExpectedConditionKey(incident, sourceById) ||
        condition.source !== incident.source ||
        condition.symbol !== incident.symbol
      ) {
        failContext({
          code: 'CONDITION_IDENTITY_MISMATCH',
          context: { condition_key: condition.condition_key },
          message: `Identidad de condición inválida: ${condition.condition_key}`,
          path: ['conditions', condition.condition_event_id, 'condition_key'],
        });
      }
      openingByKey.set(condition.condition_key, { condition, incident });
    } else {
      const opening = openingByKey.get(condition.condition_key);
      if (
        opening === undefined ||
        !condition.cause_refs.includes(opening.condition.condition_event_id)
      ) {
        failContext({
          code: 'CONDITION_RESOLUTION_MISMATCH',
          context: { condition_key: condition.condition_key },
          message: `Resolución sin apertura causal: ${condition.condition_key}`,
          path: ['conditions', condition.condition_event_id, 'cause_refs'],
        });
      }

      if (
        condition.condition_type !== opening.condition.condition_type ||
        condition.source !== opening.condition.source ||
        condition.symbol !== opening.condition.symbol
      ) {
        failContext({
          code: 'CONDITION_RESOLUTION_MISMATCH',
          context: { condition_key: condition.condition_key },
          message: `La resolución cambia la identidad de la apertura: ${condition.condition_key}`,
          path: ['conditions', condition.condition_event_id],
        });
      }

      if (condition.condition_type === 'connection_lost') {
        const closed = sourceById.get(opening.incident.observed_ref);
        const reconnects = condition.cause_refs
          .map((reference) => sourceById.get(reference))
          .filter(
            (event): event is Extract<SourceEvent, { kind: 'connection_opened' }> =>
              event?.kind === 'connection_opened',
          );
        if (
          closed?.kind !== 'connection_closed' ||
          !reconnects.some(
            (event) =>
              event.source === opening.incident.source &&
              event.supersedes_connection_id === closed.connection_id,
          )
        ) {
          failContext({
            code: 'CONDITION_RECONNECT_MISMATCH',
            context: { condition_key: condition.condition_key },
            message: `Reconexión causal inválida: ${condition.condition_key}`,
            path: ['conditions', condition.condition_event_id, 'cause_refs'],
          });
        }
      } else if (condition.condition_type === 'event_gap_unresolved') {
        if (opening.incident.incident_type !== 'event_gap_unresolved') {
          failContext({
            code: 'CONDITION_CAUSE_INVALID',
            context: { condition_key: condition.condition_key },
            message: `Incidencia de hueco inválida: ${condition.condition_key}`,
            path: ['conditions', condition.condition_event_id, 'cause_refs'],
          });
        }
        const gapIncident = opening.incident;
        const recoveries = condition.cause_refs
          .map((reference) => sourceById.get(reference))
          .filter(
            (event): event is Extract<SourceEvent, { kind: 'history_recovery_result' }> =>
              event?.kind === 'history_recovery_result',
          );
        if (
          !recoveries.some(
            (event) =>
              event.status === 'complete' &&
              event.source === gapIncident.source &&
              event.symbol === gapIncident.symbol &&
              event.from_event_time_utc === gapIncident.evidence.from_event_time_utc &&
              event.to_event_time_utc === gapIncident.evidence.to_event_time_utc,
          )
        ) {
          failContext({
            code: 'CONDITION_RECOVERY_MISMATCH',
            context: { condition_key: condition.condition_key },
            message: `Recuperación causal inválida: ${condition.condition_key}`,
            path: ['conditions', condition.condition_event_id, 'cause_refs'],
          });
        }
      } else if (condition.cause_refs.length < 2) {
        failContext({
          code: 'CONDITION_OPERATIONAL_EVIDENCE_MISSING',
          context: { condition_key: condition.condition_key },
          message: `Resolución operativa sin evidencia adicional: ${condition.condition_key}`,
          path: ['conditions', condition.condition_event_id, 'cause_refs'],
        });
      }
    }

    seenConditions.set(condition.condition_event_id, condition);
  }

  return {
    conditions,
    openConditionTypes: reduceOpenConditions(conditions),
  };
}

/**
 * Tipos de condición que siguen abiertos al final del log, únicos y ordenados (la entrada de
 * `open_condition_types` en `HealthReport`). Usa el mismo orden que validateConditionCausality.
 */
export function reduceOpenConditions(
  input: readonly z.infer<typeof operationalConditionEventSchema>[],
): string[] {
  const events = input.map((event) => operationalConditionEventSchema.parse(event));
  events.sort((left, right) =>
    left.occurred_at_utc === right.occurred_at_utc
      ? left.condition_event_id.localeCompare(right.condition_event_id)
      : left.occurred_at_utc.localeCompare(right.occurred_at_utc),
  );

  const state = new Map<string, z.infer<typeof operationalConditionEventSchema>>();
  for (const event of events) {
    const previous = state.get(event.condition_key);
    if (event.action === 'opened' && previous?.action === 'opened') {
      failContext({
        code: 'CONDITION_OPEN_DUPLICATE',
        context: { condition_key: event.condition_key },
        message: `Condición abierta dos veces: ${event.condition_key}`,
        path: ['conditions', event.condition_event_id],
      });
    }
    if (event.action === 'resolved') {
      if (previous?.action !== 'opened') {
        failContext({
          code: 'CONDITION_RESOLUTION_MISMATCH',
          context: { condition_key: event.condition_key },
          message: `Resolución sin apertura: ${event.condition_key}`,
          path: ['conditions', event.condition_event_id],
        });
      }
      if (!event.cause_refs.includes(previous.condition_event_id)) {
        failContext({
          code: 'CONDITION_RESOLUTION_MISMATCH',
          context: { condition_key: event.condition_key },
          message: `La resolución no referencia su apertura: ${event.condition_key}`,
          path: ['conditions', event.condition_event_id, 'cause_refs'],
        });
      }
    }
    state.set(event.condition_key, event);
  }

  return [
    ...new Set(
      [...state.values()]
        .filter((event) => event.action === 'opened')
        .map((event) => event.condition_type),
    ),
  ].sort();
}

export type OperationalConditionEvent = z.infer<typeof operationalConditionEventSchema>;
