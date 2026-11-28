import { z } from 'zod';

import { conditionTypeSchema } from './enums.js';
import { healthReportSchema, healthReportStructuralSchema } from './health.js';
import { MARKET_TICK_ORIGINS } from './market-tick.js';
import {
  conditionKeySchema,
  datasetIdSchema,
  decimalStringSchema,
  eventRefSchema,
  isSortedUnique,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

export const DATA_VIEW_EVENT_SCHEMA_VERSION = '1.0.0';

/** Las marcas de un tick de la vista: la de la derivación que puede tener uno usado y la propia. */
export const DATA_VIEW_TICK_FLAGS = ['after_unrecorded', 'delivery_delayed'] as const;

const placeFields = {
  dataset_id: datasetIdSchema,
  segment_index: z.number().int().min(0).max(999_999),
};

/** Un tick que se puede usar, con su lugar en el log (ADR-0024 §2). */
const dataViewTickStructuralSchema = z.strictObject({
  schema_version: z.literal(DATA_VIEW_EVENT_SCHEMA_VERSION),
  kind: z.literal('tick'),
  ...placeFields,
  /** El instante en que la vista lo da (ADR-0024 §3). */
  instant_utc: utcTimestampMsSchema,
  observation_id: uuidV7Schema,
  symbol: symbolSchema,
  event_time_utc: utcTimestampMsSchema,
  quote_decimal: decimalStringSchema,
  origin: z.enum(MARKET_TICK_ORIGINS),
  tick_fingerprint_sha256: sha256HexSchema,
  quality_flags: z.array(z.enum(DATA_VIEW_TICK_FLAGS)),
  /**
   * Solo con `after_unrecorded`: la hora de la fuente del último tick usado antes, del mismo símbolo
   * y del mismo log, o `null` si es el primero del log.
   */
  unrecorded_since_utc: utcTimestampMsSchema.nullable().optional(),
});

/** La salud del log y lo que la impone, cada vez que cambian (ADR-0024 §2). */
const dataViewHealthStructuralSchema = z.strictObject({
  schema_version: z.literal(DATA_VIEW_EVENT_SCHEMA_VERSION),
  kind: z.literal('health'),
  ...placeFields,
  instant_utc: utcTimestampMsSchema,
  /** El `observation_id` o el `event_id` del source event que la cambió. */
  source_event_id: eventRefSchema,
  /** `deriveLiveHealthReport` de los hechos del log, sin lo que solo ve quien ingiere. */
  report: healthReportStructuralSchema,
  connected_in_log: z.boolean(),
  /** En orden de `condition_key`. */
  open_conditions: z.array(
    z.strictObject({
      condition_key: conditionKeySchema,
      condition_type: conditionTypeSchema,
      symbol: symbolSchema.nullable(),
    }),
  ),
  pending_continuity_symbols: z.array(symbolSchema),
});

/**
 * `DataViewEvent` 1.0.0 (contratos de dominio, «DataViewEvent»): lo que da la vista de cada instante
 * (`data-view-1.0.0`, ADR-0024 §2) después de cada source event, una línea por evento en las partes
 * que escribe `apps/backtest` para el motor (ADR-0024 §9).
 */
export const dataViewEventStructuralSchema = z
  .discriminatedUnion('kind', [dataViewTickStructuralSchema, dataViewHealthStructuralSchema])
  .meta({ id: 'DataViewEvent', title: 'DataViewEvent' });

export const dataViewEventSchema = dataViewEventStructuralSchema.superRefine((value, context) => {
  if (value.kind === 'tick') {
    if (!isSortedUnique(value.quality_flags)) {
      context.addIssue({
        code: 'custom',
        message: 'quality_flags debe ser único y estar ordenado.',
        path: ['quality_flags'],
      });
    }
    const flagged = value.quality_flags.includes('after_unrecorded');
    if (flagged !== (value.unrecorded_since_utc !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'unrecorded_since_utc va solo, y siempre, con after_unrecorded.',
        path: ['unrecorded_since_utc'],
      });
    }
    const since = value.unrecorded_since_utc;
    if (typeof since === 'string' && !(since < value.event_time_utc)) {
      context.addIssue({
        code: 'custom',
        message: 'unrecorded_since_utc es anterior a event_time_utc.',
        path: ['unrecorded_since_utc'],
      });
    }
    return;
  }

  if (!healthReportSchema.safeParse(value.report).success) {
    context.addIssue({
      code: 'custom',
      message: 'report incumple las invariantes de HealthReport.',
      path: ['report'],
    });
  }
  if (!isSortedUnique(value.open_conditions.map((condition) => condition.condition_key))) {
    context.addIssue({
      code: 'custom',
      message: 'open_conditions va en orden de condition_key, sin repetirlo.',
      path: ['open_conditions'],
    });
  }
  value.open_conditions.forEach((condition, index) => {
    if (!condition.condition_key.startsWith(`${condition.condition_type}:sha256:`)) {
      context.addIssue({
        code: 'custom',
        message: 'condition_key no corresponde a condition_type.',
        path: ['open_conditions', index, 'condition_key'],
      });
    }
  });
  const types = [...new Set(value.open_conditions.map((condition) => condition.condition_type))];
  types.sort();
  if (JSON.stringify(types) !== JSON.stringify(value.report.open_condition_types)) {
    context.addIssue({
      code: 'custom',
      message: 'report.open_condition_types son los tipos de open_conditions.',
      path: ['report', 'open_condition_types'],
    });
  }
  if (!isSortedUnique(value.pending_continuity_symbols)) {
    context.addIssue({
      code: 'custom',
      message: 'pending_continuity_symbols debe ser único y estar ordenado.',
      path: ['pending_continuity_symbols'],
    });
  }
});

export type DataViewEvent = z.infer<typeof dataViewEventStructuralSchema>;
export type DataViewTick = Extract<DataViewEvent, { kind: 'tick' }>;
export type DataViewHealth = Extract<DataViewEvent, { kind: 'health' }>;
export type DataViewTickFlag = (typeof DATA_VIEW_TICK_FLAGS)[number];
