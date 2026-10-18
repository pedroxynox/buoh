import { z } from 'zod';

export const deploymentEnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);
export const executionModeSchema = z.enum(['disabled', 'shadow', 'demo', 'real']);
export const strategyLifecycleSchema = z.enum(['draft', 'reviewed', 'active', 'paused', 'retired']);
export const serviceHealthSchema = z.enum([
  'starting',
  'healthy',
  'degraded',
  'recovering',
  'paused',
  'failed',
]);
export const qualityIncidentTypeSchema = z.enum([
  'invalid_source_frame',
  'duplicate_exact',
  'source_time_conflict',
  'out_of_order',
  'delivery_delayed',
  'connection_lost',
  'event_gap_unresolved',
  'persistence_unavailable',
  'source_limit_exceeded',
]);
export const conditionTypeSchema = z.enum([
  'connection_lost',
  'event_gap_unresolved',
  'persistence_unavailable',
  'source_limit_exceeded',
]);
export const severitySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const closureTypeSchema = z.enum(['requested', 'remote', 'transport_error', 'timeout']);
export const persistenceStageSchema = z.enum([
  'raw_object_write',
  'source_event_index',
  'normalized_object_write',
  'incident_write',
  'manifest_write',
  'manifest_commit',
]);
export const sourceResourceSchema = z.enum([
  'websocket_frame',
  'in_memory_queue_events',
  'in_memory_queue_bytes',
  'schema_archive',
  'schema_entry',
  'schema_entries',
  'schema_expanded',
]);
export const limitUnitSchema = z.enum(['bytes', 'events', 'entries']);

export type DeploymentEnvironment = z.infer<typeof deploymentEnvironmentSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type StrategyLifecycle = z.infer<typeof strategyLifecycleSchema>;
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
export type QualityIncidentType = z.infer<typeof qualityIncidentTypeSchema>;
export type ConditionType = z.infer<typeof conditionTypeSchema>;
