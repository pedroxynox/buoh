import { z } from 'zod';

import { closureTypeSchema } from './enums.js';
import { sha256Hex } from './identity.js';
import {
  compareUtc,
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
 * `SourceEvent`: lo que llega de una fuente, en orden de observación (contratos de dominio,
 * «SourceEvent»). El frame crudo se guarda tal cual (`payload_utf8`) con su hash; normalizar o
 * clasificar calidad nunca lo reescribe.
 */
export const rawSourceFrameStructuralSchema = z.strictObject({
  kind: z.literal('raw_source_frame'),
  schema_version: schemaVersionSchema,
  observation_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  connector_version: nonEmptyStringSchema,
  connection_id: uuidV7Schema,
  received_at_utc: utcTimestampMsSchema,
  payload_utf8: z.string().refine((value) => value.isWellFormed(), {
    message: 'payload_utf8 debe ser texto Unicode bien formado.',
  }),
  raw_payload_sha256: sha256HexSchema,
});

export const rawSourceFrameSchema = rawSourceFrameStructuralSchema.superRefine((value, context) => {
  if (sha256Hex(value.payload_utf8) !== value.raw_payload_sha256) {
    context.addIssue({
      code: 'custom',
      message: 'raw_payload_sha256 no corresponde a payload_utf8.',
      path: ['raw_payload_sha256'],
    });
  }
});

export const connectionOpenedSchema = z.strictObject({
  kind: z.literal('connection_opened'),
  schema_version: schemaVersionSchema,
  event_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  supersedes_connection_id: uuidV7Schema.nullable(),
});

export const connectionClosedStructuralSchema = z.strictObject({
  kind: z.literal('connection_closed'),
  schema_version: schemaVersionSchema,
  event_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  closure_type: closureTypeSchema,
  affected_symbols: z.array(symbolSchema),
  reason: nonEmptyStringSchema,
});

export const connectionClosedSchema = connectionClosedStructuralSchema.superRefine(
  (value, context) => {
    if (!isSortedUnique(value.affected_symbols)) {
      context.addIssue({
        code: 'custom',
        message: 'affected_symbols debe ser único y estar ordenado.',
        path: ['affected_symbols'],
      });
    }
  },
);

const recoveryBase = {
  kind: z.literal('history_recovery_result'),
  schema_version: schemaVersionSchema,
  event_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  from_event_time_utc: utcTimestampMsSchema,
  to_event_time_utc: utcTimestampMsSchema,
  symbol: symbolSchema,
};

const recoveryCompleteSchema = z.strictObject({
  ...recoveryBase,
  status: z.literal('complete'),
  recovered_event_count: nonNegativeIntegerSchema,
});
const recoveryPartialSchema = z.strictObject({
  ...recoveryBase,
  status: z.literal('partial'),
  recovered_event_count: nonNegativeIntegerSchema,
  reason: nonEmptyStringSchema,
});
const recoveryUnavailableSchema = z.strictObject({
  ...recoveryBase,
  status: z.literal('unavailable'),
  reason: nonEmptyStringSchema,
});

export const historyRecoveryResultStructuralSchema = z.discriminatedUnion('status', [
  recoveryCompleteSchema,
  recoveryPartialSchema,
  recoveryUnavailableSchema,
]);

export const historyRecoveryResultSchema = historyRecoveryResultStructuralSchema.superRefine(
  (value, context) => {
    if (compareUtc(value.from_event_time_utc, value.to_event_time_utc) > 0) {
      context.addIssue({
        code: 'custom',
        message: 'El inicio de recuperación no puede ser posterior al final.',
        path: ['to_event_time_utc'],
      });
    }
  },
);

export const sourceEventStructuralSchema = z
  .union([
    rawSourceFrameStructuralSchema,
    connectionOpenedSchema,
    connectionClosedStructuralSchema,
    historyRecoveryResultStructuralSchema,
  ])
  .meta({ id: 'SourceEvent', title: 'SourceEvent' });

export const sourceEventSchema = z.union([
  rawSourceFrameSchema,
  connectionOpenedSchema,
  connectionClosedSchema,
  historyRecoveryResultSchema,
]);

// Estado de avance por fuente y símbolo. El esquema existe desde F1.1, pero todavía no se
// persiste: llega con la reconexión (F1.5, ADR-0005).
export const ingestionCursorSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    source: nonEmptyStringSchema,
    symbol: symbolSchema,
    connection_id: uuidV7Schema,
    active_segment_index: nonNegativeIntegerSchema,
    source_event_count: nonNegativeIntegerSchema,
    last_durable_source_event_id: uuidV7Schema,
    last_durable_observation_id: uuidV7Schema.nullable(),
    high_watermark_event_time_utc: utcTimestampMsSchema.nullable(),
    updated_at_utc: utcTimestampMsSchema,
  })
  .meta({ id: 'IngestionCursor', title: 'IngestionCursor' });

export type RawSourceFrame = z.infer<typeof rawSourceFrameSchema>;
export type ConnectionOpened = z.infer<typeof connectionOpenedSchema>;
export type ConnectionClosed = z.infer<typeof connectionClosedSchema>;
export type HistoryRecoveryResult = z.infer<typeof historyRecoveryResultSchema>;
export type SourceEvent = z.infer<typeof sourceEventSchema>;
export type IngestionCursor = z.infer<typeof ingestionCursorSchema>;
