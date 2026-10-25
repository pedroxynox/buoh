import { z } from 'zod';

import { conditionTypeSchema, serviceHealthSchema } from './enums.js';
import {
  datasetIdSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  schemaVersionSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

/**
 * `HealthReport` (contratos de dominio, «HealthReport»). En Fase 1 el worker nunca ejecuta, por eso
 * `execution_mode` solo admite `disabled`. La derivación pura vive en packages/domain/src/health.ts;
 * el comando que lo emite (`data:health`) llega en F1.5.
 */
export const healthReportStructuralSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    source: nonEmptyStringSchema,
    execution_mode: z.literal('disabled'),
    service_health: serviceHealthSchema,
    connection_state: z.enum(['disconnected', 'connecting', 'connected']),
    backlog_count: nonNegativeIntegerSchema,
    backlog_bytes: nonNegativeIntegerSchema,
    last_observation_id: uuidV7Schema.nullable(),
    last_received_at_utc: utcTimestampMsSchema.nullable(),
    last_event_time_utc: utcTimestampMsSchema.nullable(),
    last_published_dataset_id: datasetIdSchema.nullable(),
    open_condition_types: z.array(conditionTypeSchema),
  })
  .meta({ id: 'HealthReport', title: 'HealthReport' });

export const healthReportSchema = healthReportStructuralSchema.superRefine((value, context) => {
  if (!isSortedUnique(value.open_condition_types)) {
    context.addIssue({
      code: 'custom',
      message: 'open_condition_types debe ser único y estar ordenado.',
      path: ['open_condition_types'],
    });
  }

  if (
    value.service_health === 'healthy' &&
    (value.connection_state !== 'connected' ||
      value.open_condition_types.length > 0 ||
      value.last_observation_id === null ||
      value.last_received_at_utc === null)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'healthy requiere conexión, raw durable y ninguna condición abierta.',
      path: ['service_health'],
    });
  }
});

export type HealthReport = z.infer<typeof healthReportSchema>;
