import { z } from 'zod';

import { canonicalJson, deriveDatasetId, sha256Hex, type JsonValue } from './identity.js';
import {
  absoluteUriSchema,
  compareUtc,
  datasetIdSchema,
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
 * Manifiestos de dataset (contratos de dominio, «LogicalArtifactRef» a «PublishedManifestRecord»).
 * Un artefacto lógico es contenido (registros en JCS); un objeto de almacenamiento es su archivo
 * físico, que puede ir comprimido. El `dataset_id` sale solo de `manifest_core`: el mismo contenido
 * da el mismo identificador aunque se publique otra vez con otro `publication_id`.
 */

/** SHA-256 de cero bytes: el hash lógico obligatorio de un rol sin registros. */
export const EMPTY_SEQUENCE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const logicalArtifactRoleSchema = z.enum([
  'source_events',
  'normalized_ticks',
  'quality_incidents',
  'operational_conditions',
]);
const storageObjectRoleSchema = z.enum([
  ...logicalArtifactRoleSchema.options,
  'source_schema',
  'quality_profile',
]);
const segmentIndexSchema = z.number().int().min(0).max(999_999);
const artifactIdSchema = z
  .string()
  .regex(
    /^(?:source_events|normalized_ticks|quality_incidents|operational_conditions|source_schema|quality_profile):\d{6}$/u,
  );

export const logicalArtifactStructuralSchema = z.strictObject({
  artifact_id: artifactIdSchema,
  role: logicalArtifactRoleSchema,
  segment_index: segmentIndexSchema,
  record_count: nonNegativeIntegerSchema,
  logical_content_sha256: sha256HexSchema,
});

export const logicalArtifactSchema = logicalArtifactStructuralSchema.superRefine(
  (value, context) => {
    const expected = `${value.role}:${value.segment_index.toString().padStart(6, '0')}`;
    if (value.artifact_id !== expected) {
      context.addIssue({
        code: 'custom',
        message: `artifact_id debe ser ${expected}.`,
        path: ['artifact_id'],
      });
    }
  },
);

export const storageObjectStructuralSchema = z.strictObject({
  artifact_id: artifactIdSchema,
  role: storageObjectRoleSchema,
  uri: absoluteUriSchema,
  media_type: nonEmptyStringSchema,
  compression: z.enum(['none', 'gzip']),
  size_bytes: nonNegativeIntegerSchema,
  object_bytes_sha256: sha256HexSchema,
  logical_content_sha256: sha256HexSchema,
  writer_name: nonEmptyStringSchema.optional(),
  writer_version: nonEmptyStringSchema.optional(),
});

export const storageObjectSchema = storageObjectStructuralSchema.superRefine((value, context) => {
  if (!value.artifact_id.startsWith(`${value.role}:`)) {
    context.addIssue({
      code: 'custom',
      message: 'artifact_id no corresponde al rol físico.',
      path: ['artifact_id'],
    });
  }

  const encoded =
    value.compression === 'gzip' || value.media_type === 'application/vnd.apache.parquet';
  const hasWriter = value.writer_name !== undefined && value.writer_version !== undefined;
  const hasPartialWriter =
    (value.writer_name === undefined) !== (value.writer_version === undefined);

  if (hasPartialWriter || encoded !== hasWriter) {
    context.addIssue({
      code: 'custom',
      message: 'writer_name y writer_version son obligatorios solo para gzip o Parquet.',
      path: ['writer_name'],
    });
  }
});

export const datasetManifestCoreStructuralSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    canonicalization_version: z.literal('RFC8785'),
    source: nonEmptyStringSchema,
    source_schema_release: nonEmptyStringSchema,
    source_schema_sha256: sha256HexSchema,
    connector_version: nonEmptyStringSchema,
    normalizer_version: schemaVersionSchema,
    quality_rule_version: schemaVersionSchema,
    quality_profile_id: nonEmptyStringSchema,
    quality_profile_sha256: sha256HexSchema,
    segment_policy_version: schemaVersionSchema,
    source_event_schema_version: schemaVersionSchema,
    market_tick_schema_version: schemaVersionSchema,
    incident_schema_version: schemaVersionSchema,
    condition_event_schema_version: schemaVersionSchema,
    symbols: z.array(symbolSchema).min(1),
    event_time_from_utc: utcTimestampMsSchema.nullable(),
    event_time_to_utc: utcTimestampMsSchema.nullable(),
    source_event_count: nonNegativeIntegerSchema,
    raw_frame_count: nonNegativeIntegerSchema,
    normalized_tick_count: nonNegativeIntegerSchema,
    incident_count: nonNegativeIntegerSchema,
    condition_event_count: nonNegativeIntegerSchema,
    logical_artifacts: z.array(logicalArtifactStructuralSchema).min(4),
  })
  .meta({ id: 'DatasetManifestCore', title: 'DatasetManifestCore' });

// Orden canónico de los roles lógicos: el de la enumeración de arriba.
const roleOrder = new Map(logicalArtifactRoleSchema.options.map((role, index) => [role, index]));

export const datasetManifestCoreSchema = datasetManifestCoreStructuralSchema.superRefine(
  (value, context) => {
    if (!isSortedUnique(value.symbols)) {
      context.addIssue({
        code: 'custom',
        message: 'symbols debe ser único y estar ordenado.',
        path: ['symbols'],
      });
    }

    if (value.raw_frame_count > value.source_event_count) {
      context.addIssue({
        code: 'custom',
        message: 'raw_frame_count no puede superar source_event_count.',
        path: ['raw_frame_count'],
      });
    }

    const hasNoTicks = value.normalized_tick_count === 0;
    const hasNullRange = value.event_time_from_utc === null && value.event_time_to_utc === null;
    if (hasNoTicks !== hasNullRange) {
      context.addIssue({
        code: 'custom',
        message: 'El rango debe ser null exactamente cuando no hay ticks.',
        path: ['event_time_from_utc'],
      });
    }
    if (
      value.event_time_from_utc !== null &&
      value.event_time_to_utc !== null &&
      compareUtc(value.event_time_from_utc, value.event_time_to_utc) > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'El rango de eventos es inválido.',
        path: ['event_time_to_utc'],
      });
    }

    const artifactIds = value.logical_artifacts.map((artifact) => artifact.artifact_id);
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'logical_artifacts contiene artifact_id duplicado.',
        path: ['logical_artifacts'],
      });
    }

    let previousOrder = -1;
    const byRole = new Map<string, typeof value.logical_artifacts>();
    for (const [index, artifact] of value.logical_artifacts.entries()) {
      const parsed = logicalArtifactSchema.safeParse(artifact);
      if (!parsed.success) {
        context.addIssue({
          code: 'custom',
          message: 'LogicalArtifactRef inválido.',
          path: ['logical_artifacts', index],
        });
      }

      const order = roleOrder.get(artifact.role);
      if (order === undefined || order < previousOrder) {
        context.addIssue({
          code: 'custom',
          message: 'logical_artifacts no respeta el orden canónico de roles.',
          path: ['logical_artifacts', index],
        });
      }
      previousOrder = order ?? previousOrder;
      const list = byRole.get(artifact.role) ?? [];
      list.push(artifact);
      byRole.set(artifact.role, list);
    }

    const expectedCounts = {
      source_events: value.source_event_count,
      normalized_ticks: value.normalized_tick_count,
      quality_incidents: value.incident_count,
      operational_conditions: value.condition_event_count,
    } as const;

    for (const role of logicalArtifactRoleSchema.options) {
      const artifacts = byRole.get(role);
      if (artifacts === undefined || artifacts.length === 0) {
        context.addIssue({
          code: 'custom',
          message: `Falta el rol lógico ${role}.`,
          path: ['logical_artifacts'],
        });
        continue;
      }

      artifacts.forEach((artifact, index) => {
        if (artifact.segment_index !== index) {
          context.addIssue({
            code: 'custom',
            message: `Los segmentos de ${role} deben ser contiguos desde cero.`,
            path: ['logical_artifacts'],
          });
        }
      });

      const expectedCount = expectedCounts[role];
      const actualCount = artifacts.reduce((sum, artifact) => sum + artifact.record_count, 0);
      if (actualCount !== expectedCount) {
        context.addIssue({
          code: 'custom',
          message: `El conteo del rol ${role} no coincide.`,
          path: ['logical_artifacts'],
        });
      }

      if (expectedCount === 0) {
        const [artifact] = artifacts;
        if (
          artifacts.length !== 1 ||
          artifact?.segment_index !== 0 ||
          artifact.record_count !== 0 ||
          artifact.logical_content_sha256 !== EMPTY_SEQUENCE_SHA256
        ) {
          context.addIssue({
            code: 'custom',
            message: `El rol vacío ${role} debe usar el artefacto canónico de cero bytes.`,
            path: ['logical_artifacts'],
          });
        }
      } else if (artifacts.some((artifact) => artifact.record_count === 0)) {
        context.addIssue({
          code: 'custom',
          message: `El rol no vacío ${role} no admite segmentos vacíos.`,
          path: ['logical_artifacts'],
        });
      }
    }
  },
);

export const datasetManifestStructuralSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    dataset_id: datasetIdSchema,
    publication_id: uuidV7Schema,
    state: z.literal('published'),
    published_at_utc: utcTimestampMsSchema,
    manifest_core: datasetManifestCoreStructuralSchema,
    storage_objects: z.array(storageObjectStructuralSchema).min(6),
  })
  .meta({ id: 'DatasetManifest', title: 'DatasetManifest' });

export const datasetManifestSchema = datasetManifestStructuralSchema.superRefine(
  (value, context) => {
    if (!datasetManifestCoreSchema.safeParse(value.manifest_core).success) {
      context.addIssue({
        code: 'custom',
        message: 'manifest_core incumple sus invariantes.',
        path: ['manifest_core'],
      });
    }

    if (deriveDatasetId(value.manifest_core) !== value.dataset_id) {
      context.addIssue({
        code: 'custom',
        message: 'dataset_id no corresponde a manifest_core.',
        path: ['dataset_id'],
      });
    }

    const identifiers = value.storage_objects.map((object) => object.artifact_id);
    if (!isSortedUnique(identifiers)) {
      context.addIssue({
        code: 'custom',
        message: 'storage_objects debe tener artifact_id únicos y ordenados.',
        path: ['storage_objects'],
      });
    }

    // Además de un objeto por artefacto lógico, todo dataset guarda el perfil de calidad y el esquema de fuente.
    const expectedPhysicalIds = new Set([
      ...value.manifest_core.logical_artifacts.map((artifact) => artifact.artifact_id),
      'quality_profile:000000',
      'source_schema:000000',
    ]);
    if (
      identifiers.length !== expectedPhysicalIds.size ||
      identifiers.some((identifier) => !expectedPhysicalIds.has(identifier))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'storage_objects debe contener exactamente los artifacts lógicos, perfil y esquema.',
        path: ['storage_objects'],
      });
    }

    const physicalById = new Map(
      value.storage_objects.map((object) => [object.artifact_id, object]),
    );
    value.storage_objects.forEach((object, index) => {
      if (!storageObjectSchema.safeParse(object).success) {
        context.addIssue({
          code: 'custom',
          message: 'StorageObjectRef inválido.',
          path: ['storage_objects', index],
        });
      }
    });

    for (const [index, artifact] of value.manifest_core.logical_artifacts.entries()) {
      const physical = physicalById.get(artifact.artifact_id);
      if (
        physical?.role !== artifact.role ||
        physical.logical_content_sha256 !== artifact.logical_content_sha256
      ) {
        context.addIssue({
          code: 'custom',
          message: `No existe unión física exacta para ${artifact.artifact_id}.`,
          path: ['manifest_core', 'logical_artifacts', index],
        });
      }
    }

    const sourceSchema = physicalById.get('source_schema:000000');
    const qualityProfile = physicalById.get('quality_profile:000000');
    if (sourceSchema?.logical_content_sha256 !== value.manifest_core.source_schema_sha256) {
      context.addIssue({
        code: 'custom',
        message: 'El objeto de esquema fuente no coincide con manifest_core.',
        path: ['storage_objects'],
      });
    }
    if (qualityProfile?.logical_content_sha256 !== value.manifest_core.quality_profile_sha256) {
      context.addIssue({
        code: 'custom',
        message: 'El perfil de calidad no coincide con manifest_core.',
        path: ['storage_objects'],
      });
    }
  },
);

export const publishedManifestRecordStructuralSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    publication_id: uuidV7Schema,
    dataset_id: datasetIdSchema,
    manifest_document_sha256: sha256HexSchema,
    manifest_object_uri: absoluteUriSchema,
    manifest_object_bytes_sha256: sha256HexSchema,
    published_at_utc: utcTimestampMsSchema,
    state: z.enum(['active', 'superseded']),
  })
  .meta({ id: 'PublishedManifestRecord', title: 'PublishedManifestRecord' });

export const publishedManifestRecordSchema = publishedManifestRecordStructuralSchema;

export function canonicalManifestBytes(
  manifest: z.infer<typeof datasetManifestSchema>,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest as JsonValue));
}

export function validatePublicationRecord(
  recordInput: unknown,
  manifestInput: unknown,
): z.infer<typeof publishedManifestRecordSchema> {
  const record = publishedManifestRecordSchema.parse(recordInput);
  const manifest = datasetManifestSchema.parse(manifestInput);
  const digest = sha256Hex(canonicalManifestBytes(manifest));

  if (
    record.dataset_id !== manifest.dataset_id ||
    record.publication_id !== manifest.publication_id ||
    record.published_at_utc !== manifest.published_at_utc ||
    record.manifest_document_sha256 !== digest ||
    record.manifest_object_bytes_sha256 !== digest
  ) {
    throw new TypeError('PublishedManifestRecord no autentica el manifiesto indicado.');
  }

  return record;
}

export type LogicalArtifactRef = z.infer<typeof logicalArtifactSchema>;
export type StorageObjectRef = z.infer<typeof storageObjectSchema>;
export type DatasetManifestCore = z.infer<typeof datasetManifestCoreSchema>;
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;
export type PublishedManifestRecord = z.infer<typeof publishedManifestRecordSchema>;
