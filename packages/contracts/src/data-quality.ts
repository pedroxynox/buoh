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
  decimalStringSchema,
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
 * `symbol = null` en `invalid_source_frame` (reglas de calidad 2.0.0). 3.0.0, la de las reglas de
 * los lotes (4.0.0), suma `contract_rejected` y también admite `symbol = null` en
 * `invalid_source_frame`; desde el PR 4d de ADR-0021, también `candle_repeated`, y desde el 5d1,
 * `candle_missing`. 3.1.0, la de las reglas de los lotes 4.1.0 (PR 6b de ADR-0021), es la 3.0.0
 * con `tick_gap`, que solo existe con ella. Otra versión se rechaza.
 */
export const INCIDENT_SCHEMA_VERSIONS = ['1.0.0', '2.0.0', '3.0.0', '3.1.0'] as const;

/** Las versiones de las reglas de los lotes: las que admiten sus tipos propios. */
const BATCH_INCIDENT_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(['3.0.0', '3.1.0']);

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
/**
 * Un rechazo de `proposal` a un multiplicador: Deriv no acepta ese multiplicador en ese mercado
 * (contratos de dominio, «Semántica ejecutable de las reglas de los lotes 4.0.0»; ADR-0024 §4). El
 * contrato pedido sale de `echo_req`. Solo con los esquemas de incidencias 3.0.0 y 3.1.0.
 */
const contractRejectedSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('contract_rejected'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    raw_payload_sha256: sha256HexSchema,
    error_code: nonEmptyStringSchema,
    contract_type: z.enum(['MULTUP', 'MULTDOWN']),
    multiplier_decimal: decimalStringSchema,
  }),
});
/**
 * Una vela de Deriv que llega otra vez, en otra página, para el mismo símbolo y minuto. Cuenta la
 * primera; la repetida no es un registro. Las dos huellas son iguales si la repetición es exacta
 * (`warning`) y distintas si Deriv mandó otros precios (`error`). Solo con los esquemas 3.0.0 y 3.1.0.
 */
const candleRepeatedSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('candle_repeated'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    open_time_utc: utcTimestampMsSchema,
    first_candle_fingerprint_sha256: sha256HexSchema,
    candle_fingerprint_sha256: sha256HexSchema,
  }),
});
/**
 * Un tramo de minutos seguidos dentro del horario de su mercado sin vela de 1 minuto: la apertura de
 * la primera vela que falta y la de la última, las dos incluidas. Deriv no da velas sin ticks, así
 * que son minutos sin datos registrados (ADR-0024 §5). Siempre `error`, como `event_gap_unresolved`.
 * Solo con los esquemas 3.0.0 y 3.1.0.
 */
const candleMissingSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('candle_missing'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    from_open_time_utc: utcTimestampMsSchema,
    to_open_time_utc: utcTimestampMsSchema,
  }),
});
/**
 * Un tramo de segundos seguidos dentro del horario de su mercado sin ticks de la historia que dura
 * al menos `maximum_tick_gap_ms`, el umbral del símbolo en el perfil: el primer segundo sin ticks y
 * el último, los dos incluidos. Así, entre dos ticks, la separación pasa del umbral. Es un intervalo
 * sin datos registrados (ADR-0024 §5), nunca se rellena. Siempre `error`, como `candle_missing`.
 * Solo con el esquema 3.1.0 (PR 6b de ADR-0021).
 */
const tickGapSchema = z.strictObject({
  ...incidentBase,
  incident_type: z.literal('tick_gap'),
  symbol: symbolSchema,
  evidence: z.strictObject({
    from_event_time_utc: utcTimestampMsSchema,
    to_event_time_utc: utcTimestampMsSchema,
    maximum_tick_gap_ms: nonNegativeIntegerSchema,
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
    contractRejectedSchema,
    candleRepeatedSchema,
    candleMissingSchema,
    tickGapSchema,
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
        if (value.symbol === null && value.schema_version === '1.0.0') {
          context.addIssue({
            code: 'custom',
            message:
              'invalid_source_frame sin símbolo requiere el esquema de incidencias 2.0.0 o 3.0.0.',
            path: ['symbol'],
          });
        }
        break;
      case 'contract_rejected':
        if (!BATCH_INCIDENT_SCHEMA_VERSIONS.has(value.schema_version)) {
          context.addIssue({
            code: 'custom',
            message: 'contract_rejected requiere el esquema de incidencias 3.0.0 o 3.1.0.',
            path: ['schema_version'],
          });
        }
        if (
          value.evidence.multiplier_decimal.startsWith('-') ||
          !/[1-9]/u.test(value.evidence.multiplier_decimal)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'multiplier_decimal debe ser mayor que cero.',
            path: ['evidence', 'multiplier_decimal'],
          });
        }
        break;
      case 'candle_repeated': {
        if (!BATCH_INCIDENT_SCHEMA_VERSIONS.has(value.schema_version)) {
          context.addIssue({
            code: 'custom',
            message: 'candle_repeated requiere el esquema de incidencias 3.0.0 o 3.1.0.',
            path: ['schema_version'],
          });
        }
        const exact =
          value.evidence.first_candle_fingerprint_sha256 ===
          value.evidence.candle_fingerprint_sha256;
        if (value.severity !== (exact ? 'warning' : 'error')) {
          context.addIssue({
            code: 'custom',
            message: 'candle_repeated es warning si la repetición es exacta y error si no.',
            path: ['severity'],
          });
        }
        break;
      }
      case 'candle_missing': {
        if (!BATCH_INCIDENT_SCHEMA_VERSIONS.has(value.schema_version)) {
          context.addIssue({
            code: 'custom',
            message: 'candle_missing requiere el esquema de incidencias 3.0.0 o 3.1.0.',
            path: ['schema_version'],
          });
        }
        if (value.severity !== 'error') {
          context.addIssue({
            code: 'custom',
            message: 'candle_missing es siempre error.',
            path: ['severity'],
          });
        }
        const from = Date.parse(value.evidence.from_open_time_utc);
        const to = Date.parse(value.evidence.to_open_time_utc);
        if (from % 60_000 !== 0 || to % 60_000 !== 0 || from > to) {
          context.addIssue({
            code: 'custom',
            message: 'El tramo sin velas va de un minuto entero a otro, sin invertirse.',
            path: ['evidence'],
          });
        }
        break;
      }
      case 'tick_gap': {
        if (value.schema_version !== '3.1.0') {
          context.addIssue({
            code: 'custom',
            message: 'tick_gap requiere el esquema de incidencias 3.1.0.',
            path: ['schema_version'],
          });
        }
        if (value.severity !== 'error') {
          context.addIssue({
            code: 'custom',
            message: 'tick_gap es siempre error.',
            path: ['severity'],
          });
        }
        const from = Date.parse(value.evidence.from_event_time_utc);
        const to = Date.parse(value.evidence.to_event_time_utc);
        const maximum = value.evidence.maximum_tick_gap_ms;
        if (
          from % 1000 !== 0 ||
          to % 1000 !== 0 ||
          from > to ||
          maximum === 0 ||
          maximum % 1000 !== 0 ||
          to - from + 1000 < maximum
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'El tramo sin ticks va de un segundo entero a otro, sin invertirse, y dura al menos su umbral, de segundos enteros.',
            path: ['evidence'],
          });
        }
        break;
      }
      case 'duplicate_exact':
      case 'persistence_unavailable':
        break;
    }
  },
);

/**
 * Todos los tipos de `DataQualityIncident`: los de `qualityIncidentTypeSchema` y los que solo dan
 * los esquemas 3.0.0 y 3.1.0 de los lotes (`contract_rejected`, `candle_repeated`, `candle_missing`
 * y `tick_gap`). Es el tipo
 * de una incidencia de un dataset (`dataset_quality_incidents`). `qualityIncidentTypeSchema` no
 * cambia: es también el de las `quality_flags` de `MarketTick` y `MarketCandle`, y sumarle estos
 * cambiaría esos contratos.
 */
export const dataQualityIncidentTypeSchema = z.enum([
  ...qualityIncidentTypeSchema.options,
  'contract_rejected',
  'candle_repeated',
  'candle_missing',
  'tick_gap',
]);

export { qualityIncidentTypeSchema };
export type DataQualityIncident = z.infer<typeof dataQualityIncidentSchema>;
export type DataQualityIncidentType = z.infer<typeof dataQualityIncidentTypeSchema>;
