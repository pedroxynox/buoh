/**
 * Punto de entrada de @buoh/domain: lógica pura de Fase 1, sin red, reloj ni almacenamiento.
 * Normaliza frames crudos, aplica las reglas de calidad, arma la publicación de un dataset y deriva
 * la salud. El worker (apps/market-data-worker) le pasa los datos y guarda lo que devuelve.
 */
export {
  createCatalogResponseSchema,
  deriveCatalogSnapshot,
  type CatalogConversionResult,
  type CatalogResponseSchema,
} from './catalog.js';
export { CONDITION_HEALTH, deriveHealthReport, type HealthInput } from './health.js';
export {
  JsonLexemeError,
  parseJsonPreservingNumbers,
  toPlainJson,
  type JsonNode,
} from './json-lexeme.js';
export {
  normalizeRawFrame,
  SymbolAttributionError,
  type InvalidFrameReason,
  type NormalizationResult,
  type UnflaggedTick,
} from './normalizer.js';
export {
  CANONICALIZATION_VERSION,
  CONTRACT_SCHEMA_VERSION,
  createPipelineProfile,
  NORMALIZER_VERSION,
  publicationThresholds,
  QUALITY_RULE_VERSION,
  qualityProfileSchema,
  RULE_SETS,
  ruleSetFor,
  SEGMENT_POLICY_VERSION,
  type PipelineProfile,
  type PipelineProfileInput,
  type ProfilePurpose,
  type QualityProfile,
  type RuleSet,
} from './profile.js';
export {
  buildDatasetPublication,
  MEDIA_TYPES,
  type DatasetPublication,
  type EncodedObject,
  type ObjectEncoder,
  type PublicationInput,
} from './publication.js';
export {
  DERIVABLE_INCIDENT_SEVERITY,
  deriveMarketData,
  RESOLUTION_REASONS,
  type DerivedMarketData,
} from './quality.js';
export {
  appendSegmentStats,
  EMPTY_SEGMENT_STATS,
  evaluateSegmentRotation,
  SEGMENT_POLICY,
  sourceEventLine,
  sourceEventTime,
  type SegmentCloseReason,
  type SegmentStats,
} from './segment-policy.js';
export {
  checkRequestedResponse,
  deriveRequestedResponseIncident,
  type RequestedResponseInvalidReason,
} from './requested-response.js';
export { canonicalJsonBytes, ndjsonBytes, prettyCanonicalJson, utf8 } from './serialization.js';
export {
  compileSourceSchema,
  DRAFT_04_ANNOTATIONS,
  SOURCE_SCHEMA_DIALECTS,
  sourceSchemaDialect,
  type SourceSchemaDialect,
} from './source-schema.js';
export {
  evaluateSourceLimit,
  SOURCE_LIMITS,
  type SourceLimitViolation,
  type SourceResource,
} from './source-limits.js';
export {
  ingestSyntheticStimuli,
  parseSyntheticStimuli,
  type PersistenceFailureOutcome,
  type SyntheticIngestionResult,
  type SyntheticStimulus,
} from './synthetic-ingestion.js';
