import { z } from 'zod';

import {
  closureTypeSchema,
  limitUnitSchema,
  persistenceStageSchema,
  qualityIncidentTypeSchema,
  severitySchema,
  sourceResourceSchema,
} from './enums.js';
import { deriveEventId, type JsonValue } from './identity.js';
import {
  eventRefSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  schemaVersionSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
} from './scalars.js';

/**
 * Versiones de `DataQualityIncident` con lector. 2.0.0 solo difiere de 1.0.0 en que admite
 * `symbol = null` en `invalid_source_frame` (reglas de calidad 2.0.0). Otra versión se rechaza.
 */
export const INCIDENT_SCHEMA_VERSIONS = ['1.0.0', '2.0.0'] as const;

const incidentBase = {
  schema_version: z.enum(INCIDENT_SCHEMA_VERSIONS),
  incident_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  severity: severitySchema,
  quality_rule_version: schemaVersionSchema,
  source: nonEmptyStringSchema,
  observed_at_utc: utcTimestampMsSchema,
  observed_ref: eventRefSchema,
  related_refs: z.array(eventRefSchema),
};

const invalidSourceFrameSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('invalid_source_frame'),
  // Nulo solo con esquema de incidencias 2.0.0 (validado abajo): frame sin símbolo atribuible.
  symbol: symbolSchema.nullable(),
  evidence: z.strictObject({
    raw_payload_sha256: sha256HexSchema,
    reason: nonEmptyStringSchema,
  }),
});
const duplicateExactSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('duplicate_exact'),
  symbol: symbolSchema,
  evidence: z.strictObject({ tick_fingerprint_sha256: sha256HexSchema }),
});
const sourceTimeConflictSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('source_time_conflict'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    event_time_utc: utcTimestampMsSchema,
    tick_fingerprints: z.tuple([sha256HexSchema, sha256HexSchema]),
  }),
});
const outOfOrderSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('out_of_order'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    event_time_utc: utcTimestampMsSchema,
    high_watermark_utc: utcTimestampMsSchema,
  }),
});
const deliveryDelayedSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('delivery_delayed'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    delay_ms: nonNegativeIntegerSchema,
    maximum_delivery_delay_ms: nonNegativeIntegerSchema,
  }),
});
const connectionLostSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('connection_lost'),
  symbol: z.null(),
  evidence: z.strictObject({
    affected_symbols: z.array(symbolSchema),
    closure_type: closureTypeSchema.exclude(['requested']),
    reason: nonEmptyStringSchema,
  }),
});
const eventGapUnresolvedSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('event_gap_unresolved'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    from_event_time_utc: utcTimestampMsSchema,
    to_event_time_utc: utcTimestampMsSchema,
    reason: nonEmptyStringSchema,
  }),
});
const persistenceUnavailableSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('persistence_unavailable'),
  symbol: symbolSchema.nullable(),
  evidence: z.strictObject({
    stage: persistenceStageSchema,
    reason: nonEmptyStringSchema,
  }),
});
const sourceLimitExceededSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('source_limit_exceeded'),
  symbol: symbolSchema.nullable(),
  evidence: z.strictObject({
    resource: sourceResourceSchema,
    unit: limitUnitSchema,
    observed_value: nonNegativeIntegerSchema,
    maximum_value: nonNegativeIntegerSchema,
  }),
});

export const dataQualityIncidentStructuralSchema = z
  .discriminatedUnion('incident_type', [
    invalidSourceFrameSchema,
    duplicateExactSchema,
    sourceTimeConflictSchema,
    outOfOrderSchema,
    deliveryDelayedSchema,
    connectionLostSchema,
    eventGapUnresolvedSchema,
    persistenceUnavailableSchema,
    sourceLimitExceededSchema,
  ])
  .meta({ id: 'DataQualityIncident', title: 'DataQualityIncident' });

const resourceUnits = {
  websocket_frame: 'bytes',
  in_memory_queue_events: 'events',
  in_memory_queue_bytes: 'bytes',
  schema_archive: 'bytes',
  schema_entry: 'bytes',
  schema_entries: 'entries',
  schema_expanded: 'bytes',
} as const;

export const dataQualityIncidentSchema = dataQualityIncidentStructuralSchema.superRefine(
  (value, context) => {
    if (!isSortedUnique(value.related_refs)) {
      context.addIssue({
        code: 'custom',
        message: 'related_refs debe ser único y estar ordenado.',
        path: ['related_refs'],
      });
    }

    const body = { ...value } as Record<string, unknown>;
    delete body['incident_id'];
    if (deriveEventId(body as JsonValue) !== value.incident_id) {
      context.addIssue({
        code: 'custom',
        message: 'incident_id no corresponde al contenido canónico.',
        path: ['incident_id'],
      });
    }

    switch (value.incident_type) {
      case 'connection_lost':
        if (!isSortedUnique(value.evidence.affected_symbols)) {
          context.addIssue({
            code: 'custom',
            message: 'affected_symbols debe ser único y estar ordenado.',
            path: ['evidence', 'affected_symbols'],
          });
        }
        break;
      case 'delivery_delayed':
        if (value.evidence.delay_ms <= value.evidence.maximum_delivery_delay_ms) {
          context.addIssue({
            code: 'custom',
            message: 'delay_ms debe superar maximum_delivery_delay_ms.',
            path: ['evidence', 'delay_ms'],
          });
        }
        break;
      case 'event_gap_unresolved':
        if (value.evidence.from_event_time_utc > value.evidence.to_event_time_utc) {
          context.addIssue({
            code: 'custom',
            message: 'El rango del hueco es inválido.',
            path: ['evidence', 'to_event_time_utc'],
          });
        }
        break;
      case 'source_limit_exceeded':
        if (resourceUnits[value.evidence.resource] !== value.evidence.unit) {
          context.addIssue({
            code: 'custom',
            message: 'La unidad no corresponde al recurso.',
            path: ['evidence', 'unit'],
          });
        }
        if (value.evidence.observed_value <= value.evidence.maximum_value) {
          context.addIssue({
            code: 'custom',
            message: 'observed_value debe superar maximum_value.',
            path: ['evidence', 'observed_value'],
          });
        }
        break;
      case 'source_time_conflict': {
        const [first, second] = value.evidence.tick_fingerprints;
        if (first >= second) {
          context.addIssue({
            code: 'custom',
            message: 'tick_fingerprints debe contener dos hashes distintos y ordenados.',
            path: ['evidence', 'tick_fingerprints'],
          });
        }
        break;
      }
      case 'out_of_order':
        if (value.evidence.event_time_utc >= value.evidence.high_watermark_utc) {
          context.addIssue({
            code: 'custom',
            message: 'event_time_utc debe ser anterior al high-watermark.',
            path: ['evidence', 'event_time_utc'],
          });
        }
        break;
      case 'invalid_source_frame':
        if (value.symbol === null && value.schema_version !== '2.0.0') {
          context.addIssue({
            code: 'custom',
            message: 'invalid_source_frame sin símbolo requiere el esquema de incidencias 2.0.0.',
            path: ['symbol'],
          });
        }
        break;
      case 'duplicate_exact':
      case 'persistence_unavailable':
        break;
    }
  },
);

export { qualityIncidentTypeSchema };
export type DataQualityIncident = z.infer<typeof dataQualityIncidentSchema>;
