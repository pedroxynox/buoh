import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { validateConditionCausality } from './conditions.js';
import { closureTypeSchema } from './enums.js';
import {
  datasetManifestSchema,
  validatePublicationRecord,
  type DatasetManifest,
} from './dataset.js';
import { dataQualityIncidentSchema } from './data-quality.js';
import { healthReportSchema } from './health.js';
import { canonicalJson, sha256Hex, type JsonValue } from './identity.js';
import { marketTickSchema } from './market-tick.js';
import {
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';
import { sourceEventSchema } from './source-events.js';

const fileEntrySchema = z.strictObject({
  path: z.string().min(1),
  bytes: nonNegativeIntegerSchema,
  sha256: sha256HexSchema,
  jcs_sha256: sha256HexSchema.optional(),
});

const vectorManifestSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    vector_id: z.string().min(1),
    files: z.array(fileEntrySchema).min(1),
    expected: z.record(z.string(), z.unknown()),
  })
  .loose();

const qualityProfileSchema = z.strictObject({
  allowed_symbols: z.array(z.string().min(1)).min(1),
  gap_detection: z.literal('after_reconnection'),
  maximum_delivery_delay_ms: nonNegativeIntegerSchema,
  maximum_event_gap_ms: nonNegativeIntegerSchema,
  profile_id: z.string().min(1),
  quality_rule_version: z.string().min(1),
  source: z.string().min(1),
});

const mainProfileSchema = z.strictObject({
  connector_version: z.string().min(1),
  execution_mode: z.literal('disabled'),
  maximum_delivery_delay_ms: nonNegativeIntegerSchema,
  maximum_event_gap_ms: nonNegativeIntegerSchema,
  normalizer_version: z.string().min(1),
  quality_profile_id: z.string().min(1),
  quality_rule_version: z.string().min(1),
  source: z.string().min(1),
  source_schema_release: z.string().min(1),
  symbol: z.string().min(1),
});

const fixtureSequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sourceFrameStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('source_frame'),
  connection_id: uuidV7Schema,
  observation_id: uuidV7Schema,
  payload_utf8: z.string().refine((value) => value.isWellFormed()),
  received_at_utc: utcTimestampMsSchema,
});
const connectionClosedStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('connection_closed'),
  event_id: uuidV7Schema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  closure_type: closureTypeSchema,
  affected_symbols: z.array(symbolSchema),
  reason: nonEmptyStringSchema,
});
const connectionOpenedStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('connection_opened'),
  event_id: uuidV7Schema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  supersedes_connection_id: uuidV7Schema.nullable(),
});
const recoveryUnavailableStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('history_recovery_result'),
  event_id: uuidV7Schema,
  connection_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  from_event_time_utc: utcTimestampMsSchema,
  to_event_time_utc: utcTimestampMsSchema,
  reason: nonEmptyStringSchema,
  status: z.literal('unavailable'),
  symbol: symbolSchema,
});
const rotationStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('segment_rotation_requested'),
  occurred_at_utc: utcTimestampMsSchema,
  reason: nonEmptyStringSchema,
});
const mainStimulusSchema = z.union([
  sourceFrameStimulusSchema,
  connectionClosedStimulusSchema,
  connectionOpenedStimulusSchema,
  recoveryUnavailableStimulusSchema,
  rotationStimulusSchema,
]);
const persistenceFaultStimulusSchema = z.strictObject({
  fixture_sequence: fixtureSequenceSchema,
  kind: z.literal('persistence_fault_armed'),
  fault_id: uuidV7Schema,
  occurred_at_utc: utcTimestampMsSchema,
  reason: nonEmptyStringSchema,
  scope: z.literal('next_raw_object_write'),
  stage: z.literal('raw_object_write'),
});
const persistenceStimulusSchema = z.union([
  persistenceFaultStimulusSchema,
  sourceFrameStimulusSchema,
]);

function parseStimuli<T extends z.ZodType>(values: readonly unknown[], schema: T): z.infer<T>[] {
  const parsed = values.map((value) => schema.parse(value));
  parsed.forEach((value, index) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('fixture_sequence' in value) ||
      value.fixture_sequence !== index + 1
    ) {
      throw new TypeError('fixture_sequence debe ser contiguo desde uno.');
    }
  });
  return parsed;
}

const persistenceFailureSchema = z.strictObject({
  dataset_state: z.literal('not_published'),
  emitted_tick_count: z.literal(0),
  execution_mode: z.literal('disabled'),
  incident_evidence: z.strictObject({
    reason: z.string().min(1),
    stage: z.literal('raw_object_write'),
  }),
  incident_type: z.literal('persistence_unavailable'),
  last_durable_observation_id: z.null(),
  required_action: z.literal('close_connection_then_recover'),
  schema_version: z.literal('1.0.0'),
  service_health: z.literal('paused'),
  source_event_count: z.literal(0),
});

type VectorManifest = z.infer<typeof vectorManifestSchema>;

function assertManifestFiles(manifest: VectorManifest, expectedPaths: readonly string[]): void {
  const actual = manifest.files.map((entry) => entry.path);
  if (JSON.stringify(actual) !== JSON.stringify([...expectedPaths].sort())) {
    throw new TypeError(`files[] no contiene el conjunto normativo de ${manifest.vector_id}.`);
  }
}

function assertExpected(manifest: VectorManifest, key: string, actual: unknown): void {
  if (manifest.expected[key] !== actual) {
    throw new TypeError(`expected.${key} no coincide en ${manifest.vector_id}.`);
  }
}

const MAX_VECTOR_FILE_BYTES = 8 * 1024 * 1024;
const MAX_VECTOR_TOTAL_BYTES = 64 * 1024 * 1024;

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new TypeError(`Ruta de vector no permitida: ${path}`);
  }
}

async function readContainedFile(root: string, path: string): Promise<Buffer> {
  const [rootPath, metadata] = await Promise.all([realpath(root), lstat(path)]);
  if (metadata.isSymbolicLink()) {
    throw new TypeError(`No se permiten symlinks en vectores: ${path}`);
  }
  if (metadata.size > MAX_VECTOR_FILE_BYTES) {
    throw new TypeError(`Archivo de vector excede ${String(MAX_VECTOR_FILE_BYTES)} bytes: ${path}`);
  }

  const resolvedPath = await realpath(path);
  const relativePath = relative(rootPath, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new TypeError(`La ruta escapa vectorRoot: ${path}`);
  }

  return readFile(resolvedPath);
}

async function readJson(path: string, root: string): Promise<unknown> {
  return JSON.parse((await readContainedFile(root, path)).toString('utf8')) as unknown;
}

async function readNdjson(path: string, root: string): Promise<unknown[]> {
  const text = (await readContainedFile(root, path)).toString('utf8');
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith('\n')) {
    throw new TypeError(`NDJSON sin newline final: ${path}`);
  }
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      const value = JSON.parse(line) as JsonValue;
      if (canonicalJson(value) !== line) {
        throw new TypeError(`Línea NDJSON no canónica: ${path}`);
      }
      return value;
    });
}

async function loadAndVerifyManifest(
  directory: string,
  vectorRoot: string,
): Promise<VectorManifest> {
  const manifest = vectorManifestSchema.parse(
    await readJson(resolve(directory, 'manifest.json'), vectorRoot),
  );
  const paths = manifest.files.map((entry) => entry.path);
  paths.forEach(assertSafeRelativePath);
  const declaredTotal = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (declaredTotal > MAX_VECTOR_TOTAL_BYTES) {
    throw new TypeError(`El manifiesto excede ${String(MAX_VECTOR_TOTAL_BYTES)} bytes declarados.`);
  }
  const pathsOutOfOrder = paths.slice(1).some((path, index) => {
    const previous = paths[index];
    return previous === undefined || previous >= path;
  });
  if (new Set(paths).size !== paths.length || pathsOutOfOrder) {
    throw new TypeError(`files[] debe ser único y estar ordenado en ${manifest.vector_id}.`);
  }

  for (const entry of manifest.files) {
    const bytes = await readContainedFile(vectorRoot, resolve(directory, entry.path));
    if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      throw new TypeError(`Checksum físico inválido: ${entry.path}`);
    }
    if (entry.jcs_sha256 !== undefined) {
      const canonical = canonicalJson(JSON.parse(bytes.toString('utf8')) as JsonValue);
      if (sha256Hex(canonical) !== entry.jcs_sha256) {
        throw new TypeError(`Checksum JCS inválido: ${entry.path}`);
      }
    }
  }

  return manifest;
}

function resolveFixtureUri(vectorRoot: string, uri: string): string {
  const prefix = 'fixture://';
  if (!uri.startsWith(prefix)) {
    throw new TypeError(`URI no soportada por el fixture: ${uri}`);
  }
  const relativePath = uri.slice(prefix.length);
  assertSafeRelativePath(relativePath);
  return resolve(vectorRoot, relativePath);
}

async function verifyStorageObjects(vectorRoot: string, dataset: DatasetManifest): Promise<void> {
  for (const object of dataset.storage_objects) {
    if (object.compression !== 'none') {
      throw new TypeError('Los vectores F1.1 solo admiten objetos sin compresión.');
    }

    const bytes = await readContainedFile(vectorRoot, resolveFixtureUri(vectorRoot, object.uri));
    if (bytes.byteLength !== object.size_bytes || sha256Hex(bytes) !== object.object_bytes_sha256) {
      throw new TypeError(`Objeto físico inválido: ${object.artifact_id}`);
    }

    const logicalBytes =
      object.media_type.includes('json') && !object.media_type.includes('ndjson')
        ? canonicalJson(JSON.parse(bytes.toString('utf8')) as JsonValue)
        : bytes;
    if (sha256Hex(logicalBytes) !== object.logical_content_sha256) {
      throw new TypeError(`Objeto lógico inválido: ${object.artifact_id}`);
    }
  }
}

async function verifyDatasetScenario(input: {
  datasetDirectory: string;
  sourceEventFiles: string[];
  vectorRoot: string;
}): Promise<{
  conditionCount: number;
  dataset: DatasetManifest;
  datasetId: string;
  incidentCount: number;
  rawFrameCount: number;
  serviceHealth: string | null;
  sourceEventCount: number;
  tickCount: number;
}> {
  const { datasetDirectory, sourceEventFiles, vectorRoot } = input;
  const sourceEventSegments = await Promise.all(
    sourceEventFiles.map((file) => readNdjson(resolve(datasetDirectory, file), vectorRoot)),
  );
  const sourceEvents = sourceEventSegments.flat();
  const ticks = await readNdjson(resolve(datasetDirectory, 'expected-ticks.ndjson'), vectorRoot);
  const incidents = await readNdjson(
    resolve(datasetDirectory, 'expected-incidents.ndjson'),
    vectorRoot,
  );
  const conditions = await readNdjson(
    resolve(datasetDirectory, 'expected-conditions.ndjson'),
    vectorRoot,
  );

  const parsedSourceEvents = sourceEvents.map((event) => sourceEventSchema.parse(event));
  const parsedTicks = ticks.map((tick) => marketTickSchema.parse(tick));
  const parsedIncidents = incidents.map((incident) => dataQualityIncidentSchema.parse(incident));
  const conditionValidation = validateConditionCausality({
    conditions,
    incidents,
    sourceEvents,
  });
  const parsedConditions = conditionValidation.conditions;

  const rawByObservation = new Map(
    parsedSourceEvents
      .filter((event) => event.kind === 'raw_source_frame')
      .map((event) => [event.observation_id, event]),
  );
  for (const raw of rawByObservation.values()) {
    if (sha256Hex(raw.payload_utf8) !== raw.raw_payload_sha256) {
      throw new TypeError(`Hash raw inválido: ${raw.observation_id}`);
    }
  }
  for (const tick of parsedTicks) {
    const raw = rawByObservation.get(tick.observation_id);
    if (raw?.raw_payload_sha256 !== tick.raw_payload_sha256) {
      throw new TypeError(`Tick sin raw correspondiente: ${tick.observation_id}`);
    }
  }

  const dataset = datasetManifestSchema.parse(
    await readJson(resolve(datasetDirectory, 'expected-dataset.json'), vectorRoot),
  );
  const canonicalBytes = await readContainedFile(
    vectorRoot,
    resolve(datasetDirectory, 'expected-dataset.canonical.json'),
  );
  if (canonicalBytes.toString('utf8') !== canonicalJson(dataset as JsonValue)) {
    throw new TypeError('El documento canónico no corresponde al manifiesto legible.');
  }

  const publication = validatePublicationRecord(
    await readJson(resolve(datasetDirectory, 'expected-publication-record.json'), vectorRoot),
    dataset,
  );
  const storedManifest = await readContainedFile(
    vectorRoot,
    resolveFixtureUri(vectorRoot, publication.manifest_object_uri),
  );
  if (
    !storedManifest.equals(canonicalBytes) ||
    sha256Hex(storedManifest) !== publication.manifest_object_bytes_sha256
  ) {
    throw new TypeError('El objeto físico del manifiesto no corresponde a su publicación.');
  }
  await verifyStorageObjects(vectorRoot, dataset);

  if (
    dataset.manifest_core.source_event_count !== parsedSourceEvents.length ||
    dataset.manifest_core.raw_frame_count !== rawByObservation.size ||
    dataset.manifest_core.normalized_tick_count !== parsedTicks.length ||
    dataset.manifest_core.incident_count !== parsedIncidents.length ||
    dataset.manifest_core.condition_event_count !== parsedConditions.length
  ) {
    throw new TypeError('Los conteos del manifiesto no corresponden a sus artefactos.');
  }

  const logicalById = new Map(
    dataset.manifest_core.logical_artifacts.map((artifact) => [artifact.artifact_id, artifact]),
  );
  sourceEventSegments.forEach((segment, index) => {
    const id = `source_events:${index.toString().padStart(6, '0')}`;
    if (logicalById.get(id)?.record_count !== segment.length) {
      throw new TypeError(`record_count no coincide para ${id}.`);
    }
  });
  if (
    logicalById.get('normalized_ticks:000000')?.record_count !== parsedTicks.length ||
    logicalById.get('quality_incidents:000000')?.record_count !== parsedIncidents.length ||
    logicalById.get('operational_conditions:000000')?.record_count !== parsedConditions.length
  ) {
    throw new TypeError('record_count no coincide con los artifacts derivados.');
  }

  const orderedTicks = parsedTicks.toSorted((left, right) =>
    left.event_time_utc === right.event_time_utc
      ? left.tick_fingerprint_sha256 === right.tick_fingerprint_sha256
        ? left.observation_id.localeCompare(right.observation_id)
        : left.tick_fingerprint_sha256.localeCompare(right.tick_fingerprint_sha256)
      : left.event_time_utc.localeCompare(right.event_time_utc),
  );
  const orderedIncidents = parsedIncidents.toSorted((left, right) =>
    left.observed_at_utc === right.observed_at_utc
      ? left.incident_type === right.incident_type
        ? left.incident_id.localeCompare(right.incident_id)
        : left.incident_type.localeCompare(right.incident_type)
      : left.observed_at_utc.localeCompare(right.observed_at_utc),
  );
  if (
    JSON.stringify(orderedTicks) !== JSON.stringify(parsedTicks) ||
    JSON.stringify(orderedIncidents) !== JSON.stringify(parsedIncidents)
  ) {
    throw new TypeError('Los artifacts derivados no están en orden canónico.');
  }

  const knownSourceRefs = new Set(
    parsedSourceEvents.map((event) =>
      event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
    ),
  );
  for (const incident of parsedIncidents) {
    if (
      !knownSourceRefs.has(incident.observed_ref) ||
      incident.related_refs.some((reference) => !knownSourceRefs.has(reference))
    ) {
      throw new TypeError(`Incidencia con referencia desconocida: ${incident.incident_id}.`);
    }
  }

  if (
    parsedSourceEvents.some((event) => event.source !== dataset.manifest_core.source) ||
    parsedTicks.some(
      (tick) =>
        tick.source !== dataset.manifest_core.source ||
        tick.connector_version !== dataset.manifest_core.connector_version ||
        !dataset.manifest_core.symbols.includes(tick.symbol),
    ) ||
    parsedIncidents.some((incident) => incident.source !== dataset.manifest_core.source)
  ) {
    throw new TypeError('La procedencia de artifacts no coincide con manifest_core.');
  }

  const firstTick = parsedTicks[0];
  const lastTick = parsedTicks.at(-1);
  if (
    (firstTick?.event_time_utc ?? null) !== dataset.manifest_core.event_time_from_utc ||
    (lastTick?.event_time_utc ?? null) !== dataset.manifest_core.event_time_to_utc
  ) {
    throw new TypeError('Los extremos temporales no coinciden con los ticks canónicos.');
  }

  let serviceHealth: string | null = null;
  const healthPath = resolve(datasetDirectory, 'expected-health.json');
  if (datasetDirectory === vectorRoot) {
    const health = healthReportSchema.parse(await readJson(healthPath, vectorRoot));
    serviceHealth = health.service_health;
    const lastRaw = [...rawByObservation.values()]
      .toSorted((left, right) =>
        left.received_at_utc === right.received_at_utc
          ? left.observation_id.localeCompare(right.observation_id)
          : left.received_at_utc.localeCompare(right.received_at_utc),
      )
      .at(-1);
    const lastCanonicalTick = parsedTicks.at(-1);
    const lastConnectionEvent = parsedSourceEvents
      .filter((event) => event.kind === 'connection_opened' || event.kind === 'connection_closed')
      .at(-1);
    const expectedConnectionState =
      lastConnectionEvent?.kind === 'connection_opened' ? 'connected' : 'disconnected';
    if (
      health.source !== dataset.manifest_core.source ||
      health.connection_state !== expectedConnectionState ||
      health.last_observation_id !== (lastRaw?.observation_id ?? null) ||
      health.last_received_at_utc !== (lastRaw?.received_at_utc ?? null) ||
      health.last_event_time_utc !== (lastCanonicalTick?.event_time_utc ?? null) ||
      health.backlog_count !== 0 ||
      health.backlog_bytes !== 0 ||
      health.last_published_dataset_id !== dataset.dataset_id ||
      JSON.stringify(health.open_condition_types) !==
        JSON.stringify(conditionValidation.openConditionTypes)
    ) {
      throw new TypeError('HealthReport no corresponde a las condiciones o dataset.');
    }
  }

  return {
    conditionCount: parsedConditions.length,
    dataset,
    datasetId: dataset.dataset_id,
    incidentCount: parsedIncidents.length,
    rawFrameCount: rawByObservation.size,
    serviceHealth,
    sourceEventCount: parsedSourceEvents.length,
    tickCount: parsedTicks.length,
  };
}

export interface VectorIntegritySummary {
  mainDatasetId: string;
  mainIncidentCount: number;
  mainTickCount: number;
  zeroTickDatasetId: string;
}

export async function validateMarketDataVectors(
  vectorRoot: string,
): Promise<VectorIntegritySummary> {
  const mainManifest = await loadAndVerifyManifest(vectorRoot, vectorRoot);
  assertManifestFiles(mainManifest, [
    'expected-conditions.ndjson',
    'expected-dataset.canonical.json',
    'expected-dataset.json',
    'expected-health.json',
    'expected-incidents.ndjson',
    'expected-persistence-failure.json',
    'expected-publication-record.json',
    'expected-source-events-000000.ndjson',
    'expected-source-events-000001.ndjson',
    'expected-ticks.ndjson',
    'input-frames.ndjson',
    'input-persistence-failure.ndjson',
    'quality-profile.json',
    'source-schema.json',
    'zero-valid-ticks/manifest.json',
  ]);
  const main = await verifyDatasetScenario({
    datasetDirectory: vectorRoot,
    sourceEventFiles: [
      'expected-source-events-000000.ndjson',
      'expected-source-events-000001.ndjson',
    ],
    vectorRoot,
  });

  assertExpected(mainManifest, 'condition_event_count', main.conditionCount);
  assertExpected(mainManifest, 'dataset_id', main.datasetId);
  assertExpected(mainManifest, 'final_service_health', main.serviceHealth);
  assertExpected(mainManifest, 'incident_count', main.incidentCount);
  assertExpected(mainManifest, 'normalized_tick_count', main.tickCount);
  assertExpected(mainManifest, 'raw_frame_count', main.rawFrameCount);
  assertExpected(mainManifest, 'source_event_count', main.sourceEventCount);

  const profile = mainProfileSchema.parse(mainManifest['profile']);
  const qualityProfile = qualityProfileSchema.parse(
    await readJson(resolve(vectorRoot, 'quality-profile.json'), vectorRoot),
  );
  const core = main.dataset.manifest_core;
  if (
    profile.source !== core.source ||
    profile.connector_version !== core.connector_version ||
    profile.normalizer_version !== core.normalizer_version ||
    profile.quality_profile_id !== core.quality_profile_id ||
    profile.quality_rule_version !== core.quality_rule_version ||
    profile.source_schema_release !== core.source_schema_release ||
    !core.symbols.includes(profile.symbol) ||
    qualityProfile.source !== profile.source ||
    qualityProfile.profile_id !== profile.quality_profile_id ||
    qualityProfile.quality_rule_version !== profile.quality_rule_version ||
    qualityProfile.maximum_delivery_delay_ms !== profile.maximum_delivery_delay_ms ||
    qualityProfile.maximum_event_gap_ms !== profile.maximum_event_gap_ms
  ) {
    throw new TypeError(
      'El perfil principal no coincide con manifest_core o quality-profile.json.',
    );
  }

  const input = parseStimuli(
    await readNdjson(resolve(vectorRoot, 'input-frames.ndjson'), vectorRoot),
    mainStimulusSchema,
  );
  const rotation = input.filter((event) => event.kind === 'segment_rotation_requested');
  if (rotation.length !== 1) {
    throw new TypeError('El fixture principal requiere una rotación explícita.');
  }

  const persistedSourceEvents = (
    await Promise.all([
      readNdjson(resolve(vectorRoot, 'expected-source-events-000000.ndjson'), vectorRoot),
      readNdjson(resolve(vectorRoot, 'expected-source-events-000001.ndjson'), vectorRoot),
    ])
  )
    .flat()
    .map((event) => sourceEventSchema.parse(event));
  const persistedById = new Map(
    persistedSourceEvents.map((event) => [
      event.kind === 'raw_source_frame' ? event.observation_id : event.event_id,
      event,
    ]),
  );
  if (
    input.filter((event) => event.kind !== 'segment_rotation_requested').length !==
    persistedSourceEvents.length
  ) {
    throw new TypeError('Los estímulos persistibles no coinciden con source events.');
  }
  for (const stimulus of input) {
    if (stimulus.kind === 'segment_rotation_requested') {
      continue;
    }
    const identifier =
      stimulus.kind === 'source_frame' ? stimulus.observation_id : stimulus.event_id;
    const persisted = persistedById.get(identifier);
    if (persisted?.kind !== stimulus.kind.replace('source_frame', 'raw_source_frame')) {
      throw new TypeError(`Estímulo sin source event correspondiente: ${identifier}.`);
    }
    const persistedRecord = persisted as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(stimulus)) {
      if (key === 'fixture_sequence' || key === 'kind') {
        continue;
      }
      if (JSON.stringify(persistedRecord[key]) !== JSON.stringify(value)) {
        throw new TypeError(`Estímulo divergente en ${key}: ${identifier}.`);
      }
    }
  }

  const failureInput = parseStimuli(
    await readNdjson(resolve(vectorRoot, 'input-persistence-failure.ndjson'), vectorRoot),
    persistenceStimulusSchema,
  );
  const failure = persistenceFailureSchema.parse(
    await readJson(resolve(vectorRoot, 'expected-persistence-failure.json'), vectorRoot),
  );
  const fault = failureInput[0];
  if (
    failureInput.length !== 2 ||
    fault?.kind !== 'persistence_fault_armed' ||
    failureInput[1]?.kind !== 'source_frame' ||
    failure.incident_evidence.reason !== fault.reason
  ) {
    throw new TypeError('El escenario de persistencia no está armado antes del frame.');
  }

  const zeroDirectory = resolve(vectorRoot, 'zero-valid-ticks');
  const zeroManifest = await loadAndVerifyManifest(zeroDirectory, vectorRoot);
  assertManifestFiles(zeroManifest, [
    'expected-conditions.ndjson',
    'expected-dataset.canonical.json',
    'expected-dataset.json',
    'expected-incidents.ndjson',
    'expected-publication-record.json',
    'expected-source-events.ndjson',
    'expected-ticks.ndjson',
    'input.ndjson',
  ]);
  const zero = await verifyDatasetScenario({
    datasetDirectory: zeroDirectory,
    sourceEventFiles: ['expected-source-events.ndjson'],
    vectorRoot,
  });
  const zeroInput = parseStimuli(
    await readNdjson(resolve(zeroDirectory, 'input.ndjson'), vectorRoot),
    sourceFrameStimulusSchema,
  );
  const zeroSourceEvents = (
    await readNdjson(resolve(zeroDirectory, 'expected-source-events.ndjson'), vectorRoot)
  ).map((event) => sourceEventSchema.parse(event));
  const zeroStimulus = zeroInput[0];
  const zeroSource = zeroSourceEvents[0];
  if (
    zeroInput.length !== 1 ||
    zeroSourceEvents.length !== 1 ||
    zeroStimulus === undefined ||
    zeroSource?.kind !== 'raw_source_frame' ||
    zeroStimulus.observation_id !== zeroSource.observation_id ||
    zeroStimulus.connection_id !== zeroSource.connection_id ||
    zeroStimulus.payload_utf8 !== zeroSource.payload_utf8 ||
    zeroStimulus.received_at_utc !== zeroSource.received_at_utc
  ) {
    throw new TypeError('El input de cero ticks no corresponde a su source event.');
  }
  assertExpected(zeroManifest, 'condition_event_count', zero.conditionCount);
  assertExpected(zeroManifest, 'dataset_id', zero.datasetId);
  assertExpected(
    zeroManifest,
    'event_time_from_utc',
    zero.dataset.manifest_core.event_time_from_utc,
  );
  assertExpected(zeroManifest, 'event_time_to_utc', zero.dataset.manifest_core.event_time_to_utc);
  assertExpected(zeroManifest, 'incident_count', zero.incidentCount);
  assertExpected(zeroManifest, 'normalized_tick_count', zero.tickCount);
  assertExpected(zeroManifest, 'raw_frame_count', zero.rawFrameCount);
  assertExpected(zeroManifest, 'source_event_count', zero.sourceEventCount);

  const profileReference = z.string().min(1).parse(zeroManifest['profile_ref']);
  const schemaReference = z.string().min(1).parse(zeroManifest['schema_ref']);
  const profileDigest = sha256Hex(
    canonicalJson(
      JSON.parse(
        (await readContainedFile(vectorRoot, resolve(zeroDirectory, profileReference))).toString(
          'utf8',
        ),
      ) as JsonValue,
    ),
  );
  const schemaDigest = sha256Hex(
    canonicalJson(
      JSON.parse(
        (await readContainedFile(vectorRoot, resolve(zeroDirectory, schemaReference))).toString(
          'utf8',
        ),
      ) as JsonValue,
    ),
  );
  if (
    profileDigest !== z.string().parse(zeroManifest['profile_jcs_sha256']) ||
    schemaDigest !== z.string().parse(zeroManifest['schema_jcs_sha256']) ||
    profileDigest !== zero.dataset.manifest_core.quality_profile_sha256 ||
    schemaDigest !== zero.dataset.manifest_core.source_schema_sha256 ||
    zero.tickCount !== 0 ||
    (await readContainedFile(vectorRoot, resolve(zeroDirectory, 'expected-ticks.ndjson')))
      .byteLength !== 0 ||
    (await readContainedFile(vectorRoot, resolve(zeroDirectory, 'expected-conditions.ndjson')))
      .byteLength !== 0
  ) {
    throw new TypeError('El subvector de cero ticks no cumple la identidad vacía.');
  }

  return {
    mainDatasetId: main.datasetId,
    mainIncidentCount: main.incidentCount,
    mainTickCount: main.tickCount,
    zeroTickDatasetId: zero.datasetId,
  };
}
