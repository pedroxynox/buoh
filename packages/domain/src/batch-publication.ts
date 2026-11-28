import {
  BATCH_MANIFEST_CORE_SCHEMA_VERSION,
  canonicalJson,
  datasetManifestCoreSchema,
  sha256Hex,
  symbolSchema,
  type JsonValue,
} from '@buoh/contracts';
import { z } from 'zod';

import {
  BATCH_HISTORY_RULE_SET,
  BATCH_RULE_SET,
  batchRuleSetFor,
  relaxContractsForResponseSchema,
  type BatchRuleSet,
} from './batch-rules.js';
import { deriveBatchLog, type BatchLogConfig, type DerivedBatchLog } from './batch-series.js';
import { createCatalogResponseSchema } from './catalog.js';
import { CANONICALIZATION_VERSION, CONTRACT_SCHEMA_VERSION } from './profile.js';
import {
  assemblePublication,
  derivedSequences,
  logicalArtifactsOf,
  parseSegments,
  segmentSequences,
  type DatasetPublication,
  type PublicationInput,
} from './publication.js';
import { BATCH_SEGMENT_POLICY } from './segment-policy.js';
import { compileSourceSchema, parseJsonDocument } from './source-schema.js';
import { canonicalJsonBytes } from './serialization.js';

/**
 * La publicación de un dataset de los lotes (ADR-0021 §3; precisión del PR 5d1 de su §9): sus
 * segmentos, derivados con las reglas de los lotes de su perfil, 4.0.0 o 4.1.0 (`deriveBatchLog`),
 * en un `DatasetManifestCore` 1.1.0, con el perfil de su secuencia y los esquemas de respuesta de la
 * release fijada como esquema de fuente. Pura.
 */

/** Las operaciones cuyos esquemas de respuesta usan las reglas de los lotes 4.0.0. */
export const BATCH_SOURCE_SCHEMA_OPERATIONS = [
  'active_symbols',
  'contracts_for',
  'proposal',
  'ticks_history',
  'trading_times',
] as const;
export type BatchSourceSchemaOperation = (typeof BATCH_SOURCE_SCHEMA_OPERATIONS)[number];

/** Versiones de los registros que dan las reglas de los lotes 4.0.0. */
const BATCH_RECORD_SCHEMA_VERSIONS = {
  contract_offer: '1.0.0',
  contract_quote: '1.0.0',
  market_candle: '1.0.0',
  /** Los ticks de la descarga de la historia: `MarketTick` 1.1.0, con `history_download`. */
  market_tick: '1.1.0',
  trading_session: '1.0.0',
} as const;

/**
 * El esquema de fuente de un dataset de los lotes: un objeto con el esquema de respuesta de cada
 * operación de `BATCH_SOURCE_SCHEMA_OPERATIONS`, tal como lo trae la release, en JCS.
 */
export function batchSourceSchemaBytes(
  schemas: Readonly<Record<BatchSourceSchemaOperation, Uint8Array>>,
): Uint8Array {
  const document = Object.fromEntries(
    BATCH_SOURCE_SCHEMA_OPERATIONS.map((operation) => [
      operation,
      parseJsonDocument(schemas[operation], `El esquema de respuesta de ${operation}`),
    ]),
  ) as JsonValue;
  return canonicalJsonBytes(document);
}

function batchSourceSchemaDocument(
  bytes: Uint8Array,
): Record<BatchSourceSchemaOperation, JsonValue> {
  const document = parseJsonDocument(bytes, 'El esquema de fuente de los lotes');
  const isObject = (value: unknown): value is Record<string, JsonValue> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (
    !isObject(document) ||
    Object.keys(document).sort().join() !== [...BATCH_SOURCE_SCHEMA_OPERATIONS].join() ||
    BATCH_SOURCE_SCHEMA_OPERATIONS.some((operation) => !isObject(document[operation]))
  ) {
    throw new TypeError(
      `El esquema de fuente de los lotes es un objeto con un esquema por operación: ${BATCH_SOURCE_SCHEMA_OPERATIONS.join(', ')}.`,
    );
  }
  return document as Record<BatchSourceSchemaOperation, JsonValue>;
}

/**
 * La configuración de las reglas de los lotes desde el esquema de fuente de un dataset
 * (`batchSourceSchemaBytes`): cada esquema compilado como lo aplican esas reglas, `active_symbols`
 * con `relaxCatalogResponseSchema` y `contracts_for` con `relaxContractsForResponseSchema`.
 */
export function createBatchLogConfig(input: {
  readonly maximum_tick_gap_ms?: Readonly<Record<string, number>>;
  readonly quality_rule_version?: BatchRuleSet['quality_rule_version'];
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
  readonly trading_times_symbols: readonly string[];
}): BatchLogConfig {
  const document = batchSourceSchemaDocument(input.source_schema_bytes);
  const compiled = (operation: BatchSourceSchemaOperation) => ({
    validate: compileSourceSchema(document[operation]),
  });
  return {
    schemas: {
      active_symbols: createCatalogResponseSchema({
        source_schema_bytes: canonicalJsonBytes(document.active_symbols),
        source_schema_release: input.source_schema_release,
      }),
      contracts_for: {
        validate: compileSourceSchema(relaxContractsForResponseSchema(document.contracts_for)),
      },
      proposal: compiled('proposal'),
      ticks_history: compiled('ticks_history'),
      trading_times: compiled('trading_times'),
    },
    trading_times_symbols: input.trading_times_symbols,
    ...(input.quality_rule_version === undefined
      ? {}
      : { quality_rule_version: input.quality_rule_version }),
    ...(input.maximum_tick_gap_ms === undefined
      ? {}
      : { maximum_tick_gap_ms: input.maximum_tick_gap_ms }),
  };
}

/**
 * Lo que las reglas de los lotes leen del perfil de una secuencia por lotes: su identidad, sus
 * reglas y, si pide `trading_times`, los símbolos que se buscan en él (`symbols`). El perfil de las
 * cotizaciones no tiene `symbols`: no pide horarios. El de una historia de ticks (PR 6b de ADR-0021
 * §9) tiene un solo símbolo (`symbol`), que es el que se busca, y su umbral del tramo sin ticks
 * (`maximum_tick_gap_ms`), con las reglas 4.1.0.
 */
const batchProfileSchema = z
  .looseObject({
    maximum_tick_gap_ms: z.number().int().positive().optional(),
    profile_id: z.string().min(1),
    quality_rule_version: z.enum([
      BATCH_RULE_SET.quality_rule_version,
      BATCH_HISTORY_RULE_SET.quality_rule_version,
    ]),
    source: z.string().min(1),
    symbol: symbolSchema.optional(),
    symbols: z.array(symbolSchema).optional(),
  })
  .refine(
    (profile) =>
      (profile.symbol === undefined) === (profile.maximum_tick_gap_ms === undefined) &&
      (profile.symbol === undefined || profile.symbols === undefined) &&
      (profile.symbol !== undefined) ===
        (profile.quality_rule_version === BATCH_HISTORY_RULE_SET.quality_rule_version),
    'Un perfil de historia tiene su símbolo, su umbral y las reglas 4.1.0, y ningún otro los tiene.',
  );

export interface BatchPublicationInput extends Omit<PublicationInput, 'profile'> {
  readonly connector_version: string;
  /** El perfil de la secuencia, como lo guarda su log (`log_quality_profile`). */
  readonly quality_profile_bytes: Uint8Array;
  /** Los esquemas de respuesta de la release (`batchSourceSchemaBytes`). */
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
}

export interface BatchDatasetPublication extends Omit<DatasetPublication, 'derived'> {
  /** Lo que derivan las reglas de los lotes de los segmentos. */
  readonly derived: DerivedBatchLog;
}

/**
 * Construye la publicación de un dataset de los lotes como `buildDatasetPublication` la de uno en
 * vivo: los `source_events` de cada segmento, los registros de las reglas de los lotes por rol en
 * partes de `derived_part_records`, el core 1.1.0, el `dataset_id`, los objetos, el documento y el record.
 * Sus símbolos son los de sus registros y sus incidencias; sin ninguno no es publicable.
 */
export function buildBatchDatasetPublication(
  input: BatchPublicationInput,
): BatchDatasetPublication {
  if (input.connector_version.length === 0 || input.source_schema_release.length === 0) {
    throw new TypeError('connector_version y source_schema_release son obligatorios.');
  }
  const profileDocument = parseJsonDocument(input.quality_profile_bytes, 'El perfil de los lotes');
  const profile = batchProfileSchema.parse(profileDocument);
  const sourceSchemaDocument = batchSourceSchemaDocument(input.source_schema_bytes);
  const rules = batchRuleSetFor(profile.quality_rule_version) ?? BATCH_RULE_SET;
  const config = createBatchLogConfig({
    ...(profile.symbol === undefined || profile.maximum_tick_gap_ms === undefined
      ? {}
      : { maximum_tick_gap_ms: { [profile.symbol]: profile.maximum_tick_gap_ms } }),
    quality_rule_version: rules.quality_rule_version,
    source_schema_bytes: input.source_schema_bytes,
    source_schema_release: input.source_schema_release,
    trading_times_symbols:
      profile.symbols ?? (profile.symbol === undefined ? [] : [profile.symbol]),
  });

  const segments = parseSegments(input.segments);
  const events = segments.flat();
  const derived = deriveBatchLog(events, config);
  const size = rules.derived_part_records;
  const sequences = [
    ...segmentSequences(segments),
    ...derivedSequences('normalized_ticks', derived.ticks, size),
    ...derivedSequences('market_candles', derived.candles, size),
    ...derivedSequences('trading_sessions', derived.sessions, size),
    ...derivedSequences('contract_offers', derived.offers, size),
    ...derivedSequences('contract_quotes', derived.quotes, size),
    ...derivedSequences('quality_incidents', derived.incidents, size),
    ...derivedSequences('operational_conditions', [], size),
  ];

  const symbols = new Set<string>();
  for (const records of [
    derived.ticks,
    derived.candles,
    derived.sessions,
    derived.offers,
    derived.quotes,
  ]) {
    records.forEach((record) => symbols.add(record.symbol));
  }
  derived.incidents.forEach((incident) => {
    if (incident.symbol !== null) {
      symbols.add(incident.symbol);
    }
  });
  if (symbols.size === 0) {
    throw new TypeError('El dataset no tiene símbolos atribuibles; no es publicable.');
  }

  const qualityProfileSha256 = sha256Hex(canonicalJson(profileDocument));
  const sourceSchemaSha256 = sha256Hex(canonicalJson(sourceSchemaDocument));
  const core = datasetManifestCoreSchema.parse({
    canonicalization_version: CANONICALIZATION_VERSION,
    candle_time_from_utc: derived.candles[0]?.open_time_utc ?? null,
    candle_time_to_utc: derived.candles.at(-1)?.open_time_utc ?? null,
    condition_event_count: 0,
    condition_event_schema_version: CONTRACT_SCHEMA_VERSION,
    connector_version: input.connector_version,
    contract_offer_count: derived.offers.length,
    contract_offer_schema_version: BATCH_RECORD_SCHEMA_VERSIONS.contract_offer,
    contract_quote_count: derived.quotes.length,
    contract_quote_schema_version: BATCH_RECORD_SCHEMA_VERSIONS.contract_quote,
    event_time_from_utc: derived.ticks[0]?.event_time_utc ?? null,
    event_time_to_utc: derived.ticks.at(-1)?.event_time_utc ?? null,
    incident_count: derived.incidents.length,
    incident_schema_version: rules.incident_schema_version,
    logical_artifacts: logicalArtifactsOf(sequences),
    market_candle_count: derived.candles.length,
    market_candle_schema_version: BATCH_RECORD_SCHEMA_VERSIONS.market_candle,
    market_tick_schema_version: BATCH_RECORD_SCHEMA_VERSIONS.market_tick,
    normalized_tick_count: derived.ticks.length,
    normalizer_version: rules.normalizer_version,
    quality_profile_id: profile.profile_id,
    quality_profile_sha256: qualityProfileSha256,
    quality_rule_version: rules.quality_rule_version,
    raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
    schema_version: BATCH_MANIFEST_CORE_SCHEMA_VERSION,
    segment_policy_version: BATCH_SEGMENT_POLICY.version,
    source: profile.source,
    source_event_count: events.length,
    source_event_schema_version: CONTRACT_SCHEMA_VERSION,
    source_schema_release: input.source_schema_release,
    source_schema_sha256: sourceSchemaSha256,
    symbols: [...symbols].sort(),
    trading_session_count: derived.sessions.length,
    trading_session_schema_version: BATCH_RECORD_SCHEMA_VERSIONS.trading_session,
  });

  return {
    ...assemblePublication({
      ...input,
      core,
      quality_profile: { bytes: input.quality_profile_bytes, sha256: qualityProfileSha256 },
      sequences,
      source_schema: { bytes: input.source_schema_bytes, sha256: sourceSchemaSha256 },
    }),
    derived,
  };
}
