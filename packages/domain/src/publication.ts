import {
  datasetManifestCoreSchema,
  datasetManifestSchema,
  deriveDatasetId,
  sha256Hex,
  sourceEventSchema,
  validatePublicationRecord,
  type DatasetManifest,
  type DatasetManifestCore,
  type PublishedManifestRecord,
  type SourceEvent,
  type StorageObjectRef,
} from '@buoh/contracts';

import {
  CANONICALIZATION_VERSION,
  CONTRACT_SCHEMA_VERSION,
  SEGMENT_POLICY_VERSION,
  type PipelineProfile,
} from './profile.js';
import { deriveMarketData, type DerivedMarketData } from './quality.js';
import { canonicalJsonBytes, ndjsonBytes } from './serialization.js';

type ArtifactRole = StorageObjectRef['role'];

/** Media type lógico por rol; la compresión se declara aparte en `StorageObjectRef.compression`. */
export const MEDIA_TYPES = {
  normalized_ticks: 'application/x-ndjson',
  operational_conditions: 'application/x-ndjson',
  quality_incidents: 'application/x-ndjson',
  quality_profile: 'application/json',
  source_events: 'application/x-ndjson',
  source_schema: 'application/schema+json',
} as const satisfies Record<ArtifactRole, string>;

/** Codificación física de un objeto. Cambiarla altera hashes físicos, nunca `dataset_id`. */
export interface EncodedObject {
  readonly bytes: Uint8Array;
  readonly compression: 'gzip' | 'none';
  /** Obligatorios para gzip (contratos de dominio, `StorageObjectRef`). */
  readonly writer_name?: string;
  readonly writer_version?: string;
}

export type ObjectEncoder = (input: {
  readonly artifact_id: string;
  readonly logical_bytes: Uint8Array;
  readonly role: ArtifactRole;
}) => EncodedObject;

/** Codificación de los vectores: bytes lógicos sin compresión. */
const identityEncoder: ObjectEncoder = ({ logical_bytes }) => ({
  bytes: logical_bytes,
  compression: 'none',
});

export interface PublicationInput {
  /** UUIDv7 inyectado para esta publicación física. */
  readonly publication_id: string;
  /** Reloj UTC inyectado. */
  readonly published_at_utc: string;
  readonly profile: PipelineProfile;
  /** Segmentos `source_events` en orden de observación; sus límites forman parte del input. */
  readonly segments: readonly (readonly unknown[])[];
  /**
   * Codificación física opcional por artefacto; por defecto `none`. Debe ser determinista y pura:
   * el hash lógico se calcula siempre sobre los bytes lógicos.
   */
  readonly encodeObject?: ObjectEncoder;
  /** Ubicación física del objeto de un artefacto; no participa en `dataset_id`. */
  readonly locateObject: (
    artifactId: string,
    object: { readonly object_bytes_sha256: string; readonly role: ArtifactRole },
  ) => string;
  /** Ubicación del documento canónico del manifiesto. */
  readonly locateManifest: (input: {
    dataset_id: string;
    manifest_document_sha256: string;
    publication_id: string;
  }) => string;
}

export interface DatasetPublication {
  readonly core: DatasetManifestCore;
  readonly dataset_id: string;
  /** Ticks, incidencias y condiciones recomputados desde `segments`. */
  readonly derived: DerivedMarketData;
  readonly manifest: DatasetManifest;
  /** Documento almacenable: JCS sin newline. */
  readonly manifest_bytes: Uint8Array;
  /** Bytes físicos por `artifact_id`, ya codificados por `encodeObject`. */
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly record: PublishedManifestRecord;
}

function artifactId(role: string, index: number): string {
  return `${role}:${index.toString().padStart(6, '0')}`;
}

function collectSymbols(events: readonly SourceEvent[], derived: DerivedMarketData): string[] {
  const symbols = new Set<string>();
  for (const tick of derived.ticks) {
    symbols.add(tick.symbol);
  }
  for (const incident of derived.incidents) {
    if (incident.symbol !== null) {
      symbols.add(incident.symbol);
    }
  }
  for (const event of events) {
    if (event.kind === 'history_recovery_result') {
      symbols.add(event.symbol);
    } else if (event.kind === 'connection_closed') {
      event.affected_symbols.forEach((symbol) => symbols.add(symbol));
    }
  }
  return [...symbols].sort();
}

/**
 * Recomputa los derivados desde source events y construye la publicación según ADR-0004 §8: artefactos lógicos (incluidos vacíos de cero
 * bytes), `DatasetManifestCore`, `dataset_id`, objetos, documento JCS y `PublishedManifestRecord`.
 * Pura: no escribe almacenamiento; F1.3 persiste estos bytes y hace el commit transaccional.
 */
export function buildDatasetPublication(input: PublicationInput): DatasetPublication {
  const { profile } = input;
  const segments = input.segments.map((segment) =>
    segment.map((event) => sourceEventSchema.parse(event)),
  );
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError('Se requiere al menos un segmento y ningún segmento vacío.');
  }
  const events = segments.flat();
  const derived = deriveMarketData(segments, profile);

  const sequences: {
    bytes: Uint8Array;
    count: number;
    id: string;
    index: number;
    role: ArtifactRole;
  }[] = [
    ...segments.map((segment, index) => ({
      bytes: ndjsonBytes(segment),
      count: segment.length,
      id: artifactId('source_events', index),
      index,
      role: 'source_events' as const,
    })),
    ...(
      [
        ['normalized_ticks', derived.ticks],
        ['quality_incidents', derived.incidents],
        ['operational_conditions', derived.conditions],
      ] as const
    ).map(([role, records]) => ({
      bytes: ndjsonBytes(records),
      count: records.length,
      id: artifactId(role, 0),
      index: 0,
      role,
    })),
  ];

  const firstTick = derived.ticks[0];
  const lastTick = derived.ticks.at(-1);
  const symbols = collectSymbols(events, derived);
  if (symbols.length === 0) {
    // Reglas 2.0.0: un dataset cuyos frames no permiten atribuir ningún símbolo no es publicable.
    throw new TypeError('El dataset no tiene símbolos atribuibles; no es publicable.');
  }

  const core = datasetManifestCoreSchema.parse({
    canonicalization_version: CANONICALIZATION_VERSION,
    condition_event_count: derived.conditions.length,
    condition_event_schema_version: CONTRACT_SCHEMA_VERSION,
    connector_version: profile.connector_version,
    event_time_from_utc: firstTick?.event_time_utc ?? null,
    event_time_to_utc: lastTick?.event_time_utc ?? null,
    incident_count: derived.incidents.length,
    incident_schema_version: profile.rules.incident_schema_version,
    logical_artifacts: sequences.map((sequence) => ({
      artifact_id: sequence.id,
      logical_content_sha256: sha256Hex(sequence.bytes),
      record_count: sequence.count,
      role: sequence.role,
      segment_index: sequence.index,
    })),
    market_tick_schema_version: CONTRACT_SCHEMA_VERSION,
    normalized_tick_count: derived.ticks.length,
    normalizer_version: profile.rules.normalizer_version,
    quality_profile_id: profile.quality_profile.profile_id,
    quality_profile_sha256: profile.quality_profile_sha256,
    quality_rule_version: profile.rules.quality_rule_version,
    raw_frame_count: events.filter((event) => event.kind === 'raw_source_frame').length,
    schema_version: CONTRACT_SCHEMA_VERSION,
    segment_policy_version: SEGMENT_POLICY_VERSION,
    source: profile.source,
    source_event_count: events.length,
    source_event_schema_version: CONTRACT_SCHEMA_VERSION,
    source_schema_release: profile.source_schema_release,
    source_schema_sha256: profile.source_schema_sha256,
    symbols,
  });
  const datasetId = deriveDatasetId(core);

  const physical = [
    ...sequences.map((sequence) => ({
      bytes: sequence.bytes,
      id: sequence.id,
      logical: sha256Hex(sequence.bytes),
      role: sequence.role,
    })),
    {
      bytes: profile.quality_profile_bytes,
      id: artifactId('quality_profile', 0),
      logical: profile.quality_profile_sha256,
      role: 'quality_profile' as const,
    },
    {
      bytes: profile.source_schema_bytes,
      id: artifactId('source_schema', 0),
      logical: profile.source_schema_sha256,
      role: 'source_schema' as const,
    },
  ].sort((left, right) => (left.id < right.id ? -1 : 1));

  const encode = input.encodeObject ?? identityEncoder;
  const encoded = physical.map((object) => ({
    ...object,
    encoding: encode({ artifact_id: object.id, logical_bytes: object.bytes, role: object.role }),
  }));

  const manifest = datasetManifestSchema.parse({
    dataset_id: datasetId,
    manifest_core: core,
    publication_id: input.publication_id,
    published_at_utc: input.published_at_utc,
    schema_version: CONTRACT_SCHEMA_VERSION,
    state: 'published',
    storage_objects: encoded.map((object) => {
      const objectBytesSha256 = sha256Hex(object.encoding.bytes);
      return {
        artifact_id: object.id,
        compression: object.encoding.compression,
        logical_content_sha256: object.logical,
        media_type: MEDIA_TYPES[object.role],
        object_bytes_sha256: objectBytesSha256,
        role: object.role,
        size_bytes: object.encoding.bytes.byteLength,
        uri: input.locateObject(object.id, {
          object_bytes_sha256: objectBytesSha256,
          role: object.role,
        }),
        ...(object.encoding.writer_name === undefined
          ? {}
          : { writer_name: object.encoding.writer_name }),
        ...(object.encoding.writer_version === undefined
          ? {}
          : { writer_version: object.encoding.writer_version }),
      };
    }),
  });

  const manifestBytes = canonicalJsonBytes(manifest);
  const manifestDigest = sha256Hex(manifestBytes);
  const record = validatePublicationRecord(
    {
      dataset_id: datasetId,
      manifest_document_sha256: manifestDigest,
      manifest_object_bytes_sha256: manifestDigest,
      manifest_object_uri: input.locateManifest({
        dataset_id: datasetId,
        manifest_document_sha256: manifestDigest,
        publication_id: input.publication_id,
      }),
      publication_id: input.publication_id,
      published_at_utc: input.published_at_utc,
      schema_version: CONTRACT_SCHEMA_VERSION,
      state: 'active',
    },
    manifest,
  );

  return {
    core,
    dataset_id: datasetId,
    derived,
    manifest,
    manifest_bytes: manifestBytes,
    objects: new Map(encoded.map((object) => [object.id, object.encoding.bytes])),
    record,
  };
}
