import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex, type JsonValue } from '@buoh/contracts';
import { z } from 'zod';

/** Versiones implementadas por este paquete. Un input con otra versión aborta; no se migra. */
export const NORMALIZER_VERSION = '1.0.0';
export const QUALITY_RULE_VERSION = '1.0.0';
export const SEGMENT_POLICY_VERSION = '1.0.0';
/** Versión de los contratos emitidos (SourceEvent, MarketTick, incidencias, condiciones, manifiesto, salud). */
export const CONTRACT_SCHEMA_VERSION = '1.0.0';
export const CANONICALIZATION_VERSION = 'RFC8785';

export const qualityProfileSchema = z.strictObject({
  allowed_symbols: z.array(z.string().min(1)).min(1),
  gap_detection: z.literal('after_reconnection'),
  maximum_delivery_delay_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maximum_event_gap_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  profile_id: z.string().min(1),
  quality_rule_version: z.string().min(1),
  source: z.string().min(1),
});

export type QualityProfile = z.infer<typeof qualityProfileSchema>;

export interface PipelineProfileInput {
  /** Versión del conector que produjo/produce los source events. */
  connector_version: string;
  /** Release fijada del esquema de fuente. */
  source_schema_release: string;
  /** Bytes exactos del esquema de fuente (JSON Schema 2020-12). */
  source_schema_bytes: Uint8Array;
  /** Bytes exactos del perfil de calidad firmado. */
  quality_profile_bytes: Uint8Array;
}

export interface PipelineProfile {
  readonly connector_version: string;
  readonly quality_profile: QualityProfile;
  readonly quality_profile_bytes: Uint8Array;
  readonly quality_profile_sha256: string;
  readonly source: string;
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
  readonly source_schema_sha256: string;
  readonly validateSourcePayload: (value: unknown) => boolean;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function parseJsonDocument(bytes: Uint8Array, label: string): JsonValue {
  try {
    return JSON.parse(decoder.decode(bytes)) as JsonValue;
  } catch (error) {
    throw new TypeError(`${label} no es JSON UTF-8 válido.`, { cause: error });
  }
}

/**
 * Construye el perfil inmutable del pipeline a partir de artefactos firmados.
 * Los digests lógicos (JCS) son los que participan en `DatasetManifestCore`.
 */
export function createPipelineProfile(input: PipelineProfileInput): PipelineProfile {
  const schemaDocument = parseJsonDocument(input.source_schema_bytes, 'El esquema de fuente');
  const profileDocument = parseJsonDocument(input.quality_profile_bytes, 'El perfil de calidad');
  const qualityProfile = qualityProfileSchema.parse(profileDocument);

  if (qualityProfile.quality_rule_version !== QUALITY_RULE_VERSION) {
    throw new TypeError(
      `quality_rule_version ${qualityProfile.quality_rule_version} no está implementada; se esperaba ${QUALITY_RULE_VERSION}.`,
    );
  }
  if (input.connector_version.length === 0 || input.source_schema_release.length === 0) {
    throw new TypeError('connector_version y source_schema_release son obligatorios.');
  }

  const ajv = new Ajv2020({ allErrors: false, strict: true });
  const validate = ajv.compile(schemaDocument as object);

  return {
    connector_version: input.connector_version,
    quality_profile: qualityProfile,
    quality_profile_bytes: input.quality_profile_bytes,
    quality_profile_sha256: sha256Hex(canonicalJson(profileDocument)),
    source: qualityProfile.source,
    source_schema_bytes: input.source_schema_bytes,
    source_schema_release: input.source_schema_release,
    source_schema_sha256: sha256Hex(canonicalJson(schemaDocument)),
    validateSourcePayload: (value) => validate(value),
  };
}
