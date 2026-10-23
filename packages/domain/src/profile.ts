import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex, type JsonValue } from '@buoh/contracts';
import { z } from 'zod';

/**
 * Conjuntos de reglas implementados. El perfil elige uno con `quality_rule_version`; cada conjunto
 * fija la versión del normalizador y del esquema de incidencias que emite. Un input con otra
 * versión aborta; no se migra.
 * - 1.0.0: vectores sintéticos v1 (todo frame es candidato a tick).
 * - 2.0.0: fuentes con varios tipos de mensaje como Deriv (contratos de dominio, reglas 2.0.0).
 *   Es mayor porque cambia el resultado de entradas que 1.0.0 ya define.
 */
export const RULE_SETS = {
  '1.0.0': {
    classifies_msg_type: false,
    incident_schema_version: '1.0.0',
    normalizer_version: '1.0.0',
    quality_rule_version: '1.0.0',
  },
  '2.0.0': {
    classifies_msg_type: true,
    incident_schema_version: '2.0.0',
    normalizer_version: '2.0.0',
    quality_rule_version: '2.0.0',
  },
} as const;

export type RuleSet = (typeof RULE_SETS)[keyof typeof RULE_SETS];

/** Conjunto de reglas de una versión, o `null` si no está implementada. */
export function ruleSetFor(qualityRuleVersion: string): RuleSet | null {
  return Object.hasOwn(RULE_SETS, qualityRuleVersion)
    ? RULE_SETS[qualityRuleVersion as keyof typeof RULE_SETS]
    : null;
}

/** Versión de las reglas de los vectores v1 y del registro operativo. */
export const NORMALIZER_VERSION = RULE_SETS['1.0.0'].normalizer_version;
export const QUALITY_RULE_VERSION = RULE_SETS['1.0.0'].quality_rule_version;
export const SEGMENT_POLICY_VERSION = '1.0.0';
/** Versión de los contratos emitidos (SourceEvent, MarketTick, incidencias, condiciones, manifiesto, salud). */
export const CONTRACT_SCHEMA_VERSION = '1.0.0';
export const CANONICALIZATION_VERSION = 'RFC8785';

export const qualityProfileSchema = z.strictObject({
  allowed_symbols: z.array(z.string().min(1)).min(1),
  gap_detection: z.literal('after_reconnection'),
  maximum_delivery_delay_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maximum_event_gap_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /**
   * Reglas 2.0.0 (obligatorio en ellas, prohibido en 1.0.0): tipos de respuesta de la fuente que no
   * son ticks y se conservan raw sin incidencia. Cualquier otro `msg_type` sigue siendo candidato a
   * tick y, si no lo es, `invalid_source_frame`.
   */
  non_tick_msg_types: z.array(z.string().min(1)).min(1).optional(),
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
  /** Tipos de mensaje que no son ticks (reglas 2.0.0); vacío con reglas 1.0.0. */
  readonly nonTickMsgTypes: ReadonlySet<string>;
  /** Conjunto de reglas elegido por `quality_profile.quality_rule_version`. */
  readonly rules: RuleSet;
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

  const rules = ruleSetFor(qualityProfile.quality_rule_version);
  if (rules === null) {
    throw new TypeError(
      `quality_rule_version ${qualityProfile.quality_rule_version} no está implementada; se esperaba una de ${Object.keys(RULE_SETS).join(', ')}.`,
    );
  }
  const nonTick = qualityProfile.non_tick_msg_types;
  if (rules.classifies_msg_type !== (nonTick !== undefined)) {
    throw new TypeError(
      `non_tick_msg_types es obligatorio con reglas ${RULE_SETS['2.0.0'].quality_rule_version} y está prohibido con ${RULE_SETS['1.0.0'].quality_rule_version}.`,
    );
  }
  if (
    nonTick !== undefined &&
    (nonTick.includes('tick') ||
      nonTick.some((value, index) => index > 0 && (nonTick[index - 1] ?? '') >= value))
  ) {
    throw new TypeError('non_tick_msg_types debe ser único, ordenado y no incluir "tick".');
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
    nonTickMsgTypes: new Set(nonTick ?? []),
    quality_profile_sha256: sha256Hex(canonicalJson(profileDocument)),
    rules,
    source: qualityProfile.source,
    source_schema_bytes: input.source_schema_bytes,
    source_schema_release: input.source_schema_release,
    source_schema_sha256: sha256Hex(canonicalJson(schemaDocument)),
    validateSourcePayload: (value) => validate(value),
  };
}
