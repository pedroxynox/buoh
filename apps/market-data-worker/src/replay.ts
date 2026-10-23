import {
  canonicalJson,
  dataQualityIncidentSchema,
  datasetManifestSchema,
  marketTickSchema,
  sha256Hex,
  sourceEventSchema,
  validateConditionCausality,
  validatePublicationRecord,
  type DatasetManifest,
  type DatasetManifestCore,
  type DeploymentEnvironment,
  type JsonValue,
  type PublishedManifestRecord,
  type SourceEvent,
  type StorageObjectRef,
} from '@buoh/contracts';
import {
  buildDatasetPublication,
  CANONICALIZATION_VERSION,
  CONTRACT_SCHEMA_VERSION,
  createPipelineProfile,
  NORMALIZER_VERSION,
  QUALITY_RULE_VERSION,
  SEGMENT_POLICY_VERSION,
} from '@buoh/domain';

import { decodeObject } from './encoding.js';
import { ObjectReadError, ReplayError, type ReplayErrorCode } from './errors.js';
import { contentKey, keyFromUri } from './object-keys.js';
import { type MetadataStore, type ObjectStore } from './ports.js';

/** Límites internos de lectura del replay; nunca se carga contenido por encima de ellos. */
export const MAX_MANIFEST_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_REPLAY_OBJECT_BYTES = 256 * 1024 * 1024;

export type ReplayMode = 'recompute' | 'verify-only';

export interface ReplayInput {
  readonly datasetId: string;
  readonly environment: DeploymentEnvironment;
  readonly metadata: MetadataStore;
  readonly mode: ReplayMode;
  readonly objects: ObjectStore;
}

export interface ReplayReport {
  readonly condition_event_count: number;
  readonly dataset_id: string;
  readonly deployment_environment: DeploymentEnvironment;
  readonly incident_count: number;
  readonly logical_artifact_count: number;
  readonly mode: ReplayMode;
  readonly normalized_tick_count: number;
  readonly publication_id: string;
  readonly raw_frame_count: number;
  readonly source_event_count: number;
  /** `verified`: integridad (`--verify-only`); `reproduced`: recomputación idéntica. */
  readonly status: 'reproduced' | 'verified';
  readonly storage_object_count: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const JSON_ROLES = new Set<StorageObjectRef['role']>(['quality_profile', 'source_schema']);

function fail(
  code: ReplayErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new ReplayError(code, message, details, cause === undefined ? undefined : { cause });
}

async function readObject(
  objects: ObjectStore,
  key: string,
  maxBytes: number,
  integrityCode: ReplayErrorCode,
): Promise<Uint8Array> {
  try {
    return await objects.get(key, maxBytes);
  } catch (error) {
    if (error instanceof ObjectReadError) {
      fail(integrityCode, `Objeto ${error.reason === 'not_found' ? 'ausente' : 'excedido'}.`, {
        key,
        reason: error.reason,
      });
    }
    fail('STORAGE_UNAVAILABLE', 'El almacenamiento de objetos no respondió.', { key }, error);
  }
}

function decodeText(bytes: Uint8Array, code: ReplayErrorCode, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    fail(code, `${label} no es UTF-8 válido.`, {}, error);
  }
}

/** Secuencia lógica NDJSON: cada línea en JCS, newline final, cero bytes si está vacía. */
function parseCanonicalNdjson(bytes: Uint8Array, artifactId: string): JsonValue[] {
  const text = decodeText(bytes, 'OBJECT_INTEGRITY', artifactId);
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith('\n')) {
    fail('OBJECT_INTEGRITY', 'NDJSON lógico sin newline final.', { artifact_id: artifactId });
  }
  return text
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      let value: JsonValue;
      try {
        value = JSON.parse(line) as JsonValue;
      } catch (error) {
        fail(
          'OBJECT_INTEGRITY',
          'Línea NDJSON inválida.',
          { artifact_id: artifactId, index },
          error,
        );
      }
      if (canonicalJson(value) !== line) {
        fail('OBJECT_INTEGRITY', 'Línea NDJSON no canónica.', { artifact_id: artifactId, index });
      }
      return value;
    });
}

async function resolveActiveRecord(input: ReplayInput): Promise<PublishedManifestRecord> {
  let record: PublishedManifestRecord | null;
  try {
    record = await input.metadata.findActivePublication(input.datasetId, input.environment);
  } catch (error) {
    fail('STORAGE_UNAVAILABLE', 'El registro de metadatos no respondió.', {}, error);
  }
  if (record === null) {
    fail('DATASET_NOT_PUBLISHED', 'No existe publicación activa para el dataset.', {
      dataset_id: input.datasetId,
      deployment_environment: input.environment,
    });
  }
  return record;
}

async function loadManifest(
  input: ReplayInput,
  record: PublishedManifestRecord,
): Promise<DatasetManifest> {
  const key = keyFromUri(record.manifest_object_uri, input.objects.bucket);
  if (key === null) {
    fail('OBJECT_LOCATION_UNSUPPORTED', 'El manifiesto está fuera del bucket configurado.');
  }
  const bytes = await readObject(
    input.objects,
    key,
    MAX_MANIFEST_DOCUMENT_BYTES,
    'MANIFEST_INTEGRITY',
  );
  if (sha256Hex(bytes) !== record.manifest_object_bytes_sha256) {
    fail('MANIFEST_INTEGRITY', 'Los bytes del manifiesto no coinciden con su record.');
  }
  const text = decodeText(bytes, 'MANIFEST_INTEGRITY', 'El manifiesto');
  let document: JsonValue;
  try {
    document = JSON.parse(text) as JsonValue;
  } catch (error) {
    fail('MANIFEST_INTEGRITY', 'El manifiesto no es JSON.', {}, error);
  }
  if (canonicalJson(document) !== text) {
    fail('MANIFEST_INTEGRITY', 'El manifiesto almacenado no es JCS sin newline.');
  }
  const parsed = datasetManifestSchema.safeParse(document);
  if (!parsed.success) {
    fail('CONTRACT_INVALID', 'El manifiesto incumple DatasetManifest.', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  try {
    validatePublicationRecord(record, parsed.data);
  } catch (error) {
    fail('MANIFEST_INTEGRITY', 'El record activo no autentica el manifiesto.', {}, error);
  }
  if (parsed.data.dataset_id !== input.datasetId) {
    fail('MANIFEST_INTEGRITY', 'El manifiesto pertenece a otro dataset.');
  }
  return parsed.data;
}

/** Lee cada objeto, valida tamaño, hash físico, decodificación y hash lógico. */
async function loadLogicalObjects(
  input: ReplayInput,
  manifest: DatasetManifest,
): Promise<Map<string, Uint8Array>> {
  const logicalById = new Map<string, Uint8Array>();
  for (const object of manifest.storage_objects) {
    const key = keyFromUri(object.uri, input.objects.bucket);
    if (key !== contentKey(object.object_bytes_sha256)) {
      fail('OBJECT_LOCATION_UNSUPPORTED', 'El objeto no está en su clave content-addressed.', {
        artifact_id: object.artifact_id,
      });
    }
    if (object.size_bytes > MAX_REPLAY_OBJECT_BYTES) {
      fail('OBJECT_INTEGRITY', 'El objeto excede el límite de lectura del replay.', {
        artifact_id: object.artifact_id,
      });
    }
    const bytes = await readObject(input.objects, key, object.size_bytes, 'OBJECT_INTEGRITY');
    if (bytes.byteLength !== object.size_bytes || sha256Hex(bytes) !== object.object_bytes_sha256) {
      fail('OBJECT_INTEGRITY', 'Hash físico o tamaño no coinciden.', {
        artifact_id: object.artifact_id,
      });
    }
    let logical: Uint8Array;
    try {
      logical = decodeObject(object, bytes);
    } catch (error) {
      fail(
        object.media_type === 'application/vnd.apache.parquet'
          ? 'FORMAT_UNSUPPORTED'
          : 'OBJECT_INTEGRITY',
        'No se pudo decodificar el objeto.',
        { artifact_id: object.artifact_id },
        error,
      );
    }
    let logicalDigest: string;
    if (JSON_ROLES.has(object.role)) {
      try {
        logicalDigest = sha256Hex(
          canonicalJson(
            JSON.parse(decodeText(logical, 'OBJECT_INTEGRITY', object.artifact_id)) as JsonValue,
          ),
        );
      } catch (error) {
        if (error instanceof ReplayError) {
          throw error;
        }
        fail(
          'OBJECT_INTEGRITY',
          'Documento JSON inválido.',
          { artifact_id: object.artifact_id },
          error,
        );
      }
    } else {
      logicalDigest = sha256Hex(logical);
    }
    if (logicalDigest !== object.logical_content_sha256) {
      fail('OBJECT_INTEGRITY', 'Hash lógico no coincide.', { artifact_id: object.artifact_id });
    }
    logicalById.set(object.artifact_id, logical);
  }
  return logicalById;
}

interface ValidatedDataset {
  readonly segments: SourceEvent[][];
}

/** Reconstruye y valida cada artefacto lógico contra contratos, conteos y `DatasetManifestCore`. */
function validateLogicalArtifacts(
  core: DatasetManifestCore,
  logicalById: ReadonlyMap<string, Uint8Array>,
): ValidatedDataset {
  const recordsByRole = new Map<string, JsonValue[][]>();
  for (const artifact of core.logical_artifacts) {
    const logical = logicalById.get(artifact.artifact_id);
    if (logical === undefined) {
      fail('OBJECT_INTEGRITY', 'Artefacto lógico sin objeto.', {
        artifact_id: artifact.artifact_id,
      });
    }
    const records = parseCanonicalNdjson(logical, artifact.artifact_id);
    if (records.length !== artifact.record_count) {
      fail('OBJECT_INTEGRITY', 'record_count no coincide.', { artifact_id: artifact.artifact_id });
    }
    const list = recordsByRole.get(artifact.role) ?? [];
    list.push(records);
    recordsByRole.set(artifact.role, list);
  }

  const parseAll = <T>(
    role: string,
    parse: (value: unknown) => { success: true; data: T } | { success: false },
  ): T[][] =>
    (recordsByRole.get(role) ?? []).map((records) =>
      records.map((record, index) => {
        const parsed = parse(record);
        if (!parsed.success) {
          fail('CONTRACT_INVALID', `Registro inválido en ${role}.`, { index, role });
        }
        return parsed.data;
      }),
    );

  const segments = parseAll('source_events', (value) => sourceEventSchema.safeParse(value));
  parseAll('normalized_ticks', (value) => marketTickSchema.safeParse(value));
  const incidents = parseAll('quality_incidents', (value) =>
    dataQualityIncidentSchema.safeParse(value),
  ).flat();
  const conditions = (recordsByRole.get('operational_conditions') ?? []).flat();
  const sourceEvents = segments.flat();
  try {
    validateConditionCausality({ conditions, incidents, sourceEvents });
  } catch (error) {
    fail('CONTRACT_INVALID', 'Las condiciones no son causales respecto del dataset.', {}, error);
  }

  const rawFrames = sourceEvents.filter((event) => event.kind === 'raw_source_frame').length;
  if (rawFrames !== core.raw_frame_count) {
    fail('CONTRACT_INVALID', 'raw_frame_count no corresponde a los source events.');
  }
  return { segments };
}

function versionMismatches(core: DatasetManifestCore): string[] {
  const expected: Partial<Record<keyof DatasetManifestCore, string>> = {
    canonicalization_version: CANONICALIZATION_VERSION,
    condition_event_schema_version: CONTRACT_SCHEMA_VERSION,
    incident_schema_version: CONTRACT_SCHEMA_VERSION,
    market_tick_schema_version: CONTRACT_SCHEMA_VERSION,
    normalizer_version: NORMALIZER_VERSION,
    quality_rule_version: QUALITY_RULE_VERSION,
    schema_version: CONTRACT_SCHEMA_VERSION,
    segment_policy_version: SEGMENT_POLICY_VERSION,
    source_event_schema_version: CONTRACT_SCHEMA_VERSION,
  };
  return Object.entries(expected)
    .filter(([field, version]) => core[field as keyof DatasetManifestCore] !== version)
    .map(([field]) => field);
}

function recompute(
  manifest: DatasetManifest,
  record: PublishedManifestRecord,
  logicalById: ReadonlyMap<string, Uint8Array>,
  segments: readonly SourceEvent[][],
): void {
  const core = manifest.manifest_core;
  const unsupported = versionMismatches(core);
  if (unsupported.length > 0) {
    fail('VERSION_UNSUPPORTED', 'El dataset declara versiones no implementadas; no se migra.', {
      fields: unsupported,
    });
  }
  const sourceSchema = logicalById.get('source_schema:000000');
  const qualityProfile = logicalById.get('quality_profile:000000');
  if (sourceSchema === undefined || qualityProfile === undefined) {
    fail('OBJECT_INTEGRITY', 'Faltan esquema de fuente o perfil de calidad.');
  }
  const uriById = new Map(
    manifest.storage_objects.map((object) => [object.artifact_id, object.uri]),
  );

  let rebuilt: { core: DatasetManifestCore; dataset_id: string };
  try {
    const profile = createPipelineProfile({
      connector_version: core.connector_version,
      quality_profile_bytes: qualityProfile,
      source_schema_bytes: sourceSchema,
      source_schema_release: core.source_schema_release,
    });
    // Solo source events + esquema + perfil + versiones; la identidad física no participa en core.
    rebuilt = buildDatasetPublication({
      locateManifest: () => record.manifest_object_uri,
      locateObject: (artifactId) => uriById.get(artifactId) ?? record.manifest_object_uri,
      profile,
      publication_id: manifest.publication_id,
      published_at_utc: manifest.published_at_utc,
      segments,
    });
  } catch (error) {
    fail('RECOMPUTATION_FAILED', 'La recomputación abortó.', {}, error);
  }

  if (
    rebuilt.dataset_id !== manifest.dataset_id ||
    canonicalJson(rebuilt.core) !== canonicalJson(core)
  ) {
    const stored = new Map(
      core.logical_artifacts.map((artifact) => [artifact.artifact_id, artifact]),
    );
    const recomputed = new Map(
      rebuilt.core.logical_artifacts.map((artifact) => [artifact.artifact_id, artifact]),
    );
    const artifactIds = [...new Set([...stored.keys(), ...recomputed.keys()])].sort();
    fail('RECOMPUTATION_MISMATCH', 'La recomputación no reproduce el dataset.', {
      differing_artifacts: artifactIds.filter((id) => {
        const left = stored.get(id);
        const right = recomputed.get(id);
        return (
          left?.logical_content_sha256 !== right?.logical_content_sha256 ||
          left?.record_count !== right?.record_count
        );
      }),
      recomputed_dataset_id: rebuilt.dataset_id,
    });
  }
}

/**
 * `pnpm run data:replay` (ADR-0004 §9, contratos de dominio «Replay de dataset»). Sin red de
 * mercado, reloj ni IDs nuevos. `verify-only` termina tras validar record, documento, hashes
 * físicos, contratos, hashes lógicos y core; `recompute` además regenera derivados desde source
 * events, esquema, perfil y versiones, y compara core e ID.
 */
export async function replayDataset(input: ReplayInput): Promise<ReplayReport> {
  const record = await resolveActiveRecord(input);
  const manifest = await loadManifest(input, record);
  const logicalById = await loadLogicalObjects(input, manifest);
  const { segments } = validateLogicalArtifacts(manifest.manifest_core, logicalById);

  if (input.mode === 'recompute') {
    recompute(manifest, record, logicalById, segments);
  }

  const core = manifest.manifest_core;
  return {
    condition_event_count: core.condition_event_count,
    dataset_id: manifest.dataset_id,
    deployment_environment: input.environment,
    incident_count: core.incident_count,
    logical_artifact_count: core.logical_artifacts.length,
    mode: input.mode,
    normalized_tick_count: core.normalized_tick_count,
    publication_id: manifest.publication_id,
    raw_frame_count: core.raw_frame_count,
    source_event_count: core.source_event_count,
    status: input.mode === 'recompute' ? 'reproduced' : 'verified',
    storage_object_count: manifest.storage_objects.length,
  };
}
