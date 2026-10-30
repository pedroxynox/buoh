/**
 * `LiveDerivationCheckpoint` (ADR-0017 §5 y §6; contratos de dominio, `LiveDerivationCheckpoint`):
 * el estado vivo de un log al final de un segmento cerrado, lo que la derivación del log hasta ese
 * segmento deja para los lectores en vivo. No es un artefacto de dataset ni entra en `dataset_id`.
 */
import { z } from 'zod';

import {
  deriveConnectionConditionKey,
  deriveGapConditionKey,
  operationalConditionEventSchema,
  operationalConditionEventStructuralSchema,
} from './conditions.js';
import { dataQualityIncidentSchema, dataQualityIncidentStructuralSchema } from './data-quality.js';
import {
  decimalStringSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  schemaVersionSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

/**
 * Versión del formato del estado vivo (ADR-0017 §6, «Versión del formato»). Sube con cualquier
 * cambio de lo que el pliegue produce para un mismo log, aunque no cambie ninguna regla de calidad.
 */
export const LIVE_STATE_VERSION = '1.0.0';

/** El primer tick de un instante en orden canónico (`tick_fingerprint_sha256`, `observation_id`). */
const canonicalTickSchema = z.strictObject({
  observation_id: uuidV7Schema,
  quote_decimal: decimalStringSchema,
  tick_fingerprint_sha256: sha256HexSchema,
});

/** High-watermark de un símbolo, el tick que lo fijó y el canónico de su instante. */
const watermarkSchema = z.strictObject({
  canonical_tick: canonicalTickSchema,
  event_time_utc: utcTimestampMsSchema,
  observation_id: uuidV7Schema,
  symbol: symbolSchema,
});

/**
 * Continuidad pendiente de un símbolo, como en `deriveMarketData`, con los ticks de los dos extremos
 * del hueco que usan la vigilancia (`gapState`) y la incidencia de un hueco no resuelto
 * (`gapBoundaries`).
 */
const pendingContinuitySchema = z.strictObject({
  /** El primero observado con el menor tiempo posterior al fin del rango pendiente. */
  after_tick: z
    .strictObject({ event_time_utc: utcTimestampMsSchema, observation_id: uuidV7Schema })
    .nullable(),
  close_watermark_utc: utcTimestampMsSchema,
  /** El canónico del instante siguiente al fin del rango pendiente. */
  end_canonical_tick: canonicalTickSchema.nullable(),
  end_utc: utcTimestampMsSchema.nullable(),
  exceeded: z.boolean(),
  /** El canónico del instante del inicio, que cambia si llega más tarde otro tick con ese tiempo. */
  start_canonical_tick: canonicalTickSchema,
  symbol: symbolSchema,
  /** El primer tick observado en el instante del inicio. */
  watermark_observation_id: uuidV7Schema,
  watermark_utc: utcTimestampMsSchema,
});

const openConditionStructuralSchema = z.strictObject({
  closed_connection_id: uuidV7Schema.nullable(),
  condition: operationalConditionEventStructuralSchema,
  incident: dataQualityIncidentStructuralSchema,
});

const liveDerivationStateStructuralSchema = z.strictObject({
  connected_in_log: z.boolean(),
  last_connection_event_time_utc: utcTimestampMsSchema.nullable(),
  last_event_connection_id: uuidV7Schema.nullable(),
  last_raw: z
    .strictObject({ observation_id: uuidV7Schema, received_at_utc: utcTimestampMsSchema })
    .nullable(),
  open_conditions: z.array(openConditionStructuralSchema),
  pending_continuity: z.array(pendingContinuitySchema),
  previous_connection: z
    .strictObject({
      closed_at_utc: utcTimestampMsSchema.nullable(),
      connection_id: uuidV7Schema,
    })
    .nullable(),
  symbol_not_allowed_seen: z.boolean(),
  watermarks: z.array(watermarkSchema),
});

/** Las versiones de ADR-0017 §6; su SHA-256 entra en la clave de la tabla (§5). */
export const liveCheckpointVersionsSchema = z.strictObject({
  connector_version: nonEmptyStringSchema,
  live_state_version: schemaVersionSchema,
  quality_profile_sha256: sha256HexSchema,
  quality_rule_version: schemaVersionSchema,
  segment_policy_version: schemaVersionSchema,
  source_event_schema_version: schemaVersionSchema,
  source_schema_sha256: sha256HexSchema,
});

export const liveDerivationCheckpointStructuralSchema = z
  .strictObject({
    event_count: nonNegativeIntegerSchema,
    raw_frame_count: nonNegativeIntegerSchema,
    schema_version: schemaVersionSchema,
    segment_index: nonNegativeIntegerSchema,
    segment_logical_content_sha256: sha256HexSchema,
    source: nonEmptyStringSchema,
    state: liveDerivationStateStructuralSchema,
    symbol: symbolSchema,
    versions: liveCheckpointVersionsSchema,
  })
  .meta({ id: 'LiveDerivationCheckpoint', title: 'LiveDerivationCheckpoint' });

/**
 * Esquema runtime: además de la estructura, exige listas del estado ordenadas y sin repetir por su
 * clave, y no más raw frames que eventos. Cada condición abierta tiene que ser una apertura de la
 * misma fuente y el mismo símbolo que su incidencia causal, con la `condition_key` que resuelve el
 * pliegue: la de la `connection_id` cerrada de un `connection_lost`, o la del rango de la incidencia
 * de un `event_gap_unresolved`, como en `validateConditionCausality`.
 */
export const liveDerivationCheckpointSchema = liveDerivationCheckpointStructuralSchema.superRefine(
  (value, context) => {
    const { state } = value;
    if (value.raw_frame_count > value.event_count) {
      context.addIssue({
        code: 'custom',
        message: 'raw_frame_count no puede superar event_count.',
        path: ['raw_frame_count'],
      });
    }
    const keyed = [
      ['watermarks', state.watermarks.map((item) => item.symbol)],
      ['pending_continuity', state.pending_continuity.map((item) => item.symbol)],
      ['open_conditions', state.open_conditions.map((item) => item.condition.condition_key)],
    ] as const;
    for (const [field, keys] of keyed) {
      if (!isSortedUnique(keys)) {
        context.addIssue({
          code: 'custom',
          message: `${field} tiene que estar en orden y sin repetir.`,
          path: ['state', field],
        });
      }
    }
    state.open_conditions.forEach((open, index) => {
      const condition = operationalConditionEventSchema.safeParse(open.condition);
      const incident = dataQualityIncidentSchema.safeParse(open.incident);
      if (
        !condition.success ||
        !incident.success ||
        condition.data.action !== 'opened' ||
        condition.data.source !== value.source ||
        incident.data.source !== value.source ||
        condition.data.symbol !== incident.data.symbol ||
        !condition.data.cause_refs.includes(incident.data.incident_id) ||
        condition.data.condition_type !== incident.data.incident_type ||
        (condition.data.condition_type === 'connection_lost') !==
          (open.closed_connection_id !== null) ||
        (open.closed_connection_id !== null &&
          condition.data.condition_key !==
            deriveConnectionConditionKey(value.source, open.closed_connection_id)) ||
        (incident.data.incident_type === 'event_gap_unresolved' &&
          condition.data.condition_key !==
            deriveGapConditionKey({
              from_event_time_utc: incident.data.evidence.from_event_time_utc,
              source: value.source,
              symbol: incident.data.symbol,
              to_event_time_utc: incident.data.evidence.to_event_time_utc,
            }))
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Una condición abierta tiene que ser una apertura de la fuente, causada por su incidencia y con la condition_key de su conexión cerrada o de su rango.',
          path: ['state', 'open_conditions', index],
        });
      }
    });
  },
);

export type LiveCheckpointVersions = z.infer<typeof liveCheckpointVersionsSchema>;
export type LiveDerivationCheckpoint = z.infer<typeof liveDerivationCheckpointSchema>;
export type LiveDerivationState = LiveDerivationCheckpoint['state'];
