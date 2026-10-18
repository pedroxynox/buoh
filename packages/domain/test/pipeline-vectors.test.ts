import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateMarketDataVectors } from '@buoh/contracts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildDatasetPublication,
  createPipelineProfile,
  deriveHealthReport,
  ingestSyntheticStimuli,
  prettyCanonicalJson,
  type PipelineProfile,
} from '../src/index.js';

const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');

function readVector(path: string): Buffer {
  return readFileSync(resolve(vectorRoot, path));
}

function readNdjson(path: string): unknown[] {
  const text = readVector(path).toString('utf8');
  return text.length === 0
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
}

function fixturePath(uri: string): string {
  expect(uri.startsWith('fixture://')).toBe(true);
  return uri.slice('fixture://'.length);
}

/** Igualdad byte a byte con el archivo firmado; el texto solo mejora el diff al fallar. */
function expectSameBytes(actual: Uint8Array | string, path: string): void {
  const actualBytes =
    typeof actual === 'string' ? Buffer.from(actual, 'utf8') : Buffer.from(actual);
  const expected = readVector(path);
  expect(actualBytes.toString('utf8'), path).toBe(expected.toString('utf8'));
  expect(actualBytes.equals(expected), path).toBe(true);
}

/**
 * Guardas de determinismo: el pipeline no puede leer reloj real, aleatoriedad ni red. El reloj se
 * congela en una fecha ajena al vector; cualquier lectura implícita cambiaría bytes y hashes.
 */
function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en el pipeline.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en el pipeline.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en el pipeline.');
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface VectorManifest {
  expected: Record<string, unknown>;
  profile?: { connector_version: string; source_schema_release: string };
}

const mainManifest = JSON.parse(readVector('manifest.json').toString('utf8')) as VectorManifest;
const zeroManifest = JSON.parse(
  readVector('zero-valid-ticks/manifest.json').toString('utf8'),
) as VectorManifest;

function loadProfile(): PipelineProfile {
  const connector = mainManifest.profile;
  if (connector === undefined) {
    throw new TypeError('manifest.json requiere profile.');
  }
  return createPipelineProfile({
    connector_version: connector.connector_version,
    quality_profile_bytes: readVector('quality-profile.json'),
    source_schema_bytes: readVector('source-schema.json'),
    source_schema_release: connector.source_schema_release,
  });
}

interface Scenario {
  directory: string;
  expectedDatasetId: string;
  input: string;
  manifest: VectorManifest;
  name: string;
  /** Identidad física inyectada (UUIDv7 + reloj) de la publicación firmada en el vector. */
  publication: { publication_id: string; published_at_utc: string };
  sourceEventFiles: string[];
}

const scenarios: Scenario[] = [
  {
    directory: '',
    expectedDatasetId: 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd',
    input: 'input-frames.ndjson',
    manifest: mainManifest,
    name: 'principal multi-segmento',
    publication: {
      publication_id: '019b76da-cb28-7003-8000-000000000001',
      published_at_utc: '2026-01-01T00:00:09.000Z',
    },
    sourceEventFiles: [
      'expected-source-events-000000.ndjson',
      'expected-source-events-000001.ndjson',
    ],
  },
  {
    directory: 'zero-valid-ticks/',
    expectedDatasetId: 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f',
    input: 'zero-valid-ticks/input.ndjson',
    manifest: zeroManifest,
    name: 'zero-valid-ticks',
    publication: {
      publication_id: '019b76da-abe8-7103-8000-000000000001',
      published_at_utc: '2026-01-01T00:00:01.000Z',
    },
    sourceEventFiles: ['zero-valid-ticks/expected-source-events.ndjson'],
  },
];

function locators(scenario: Scenario) {
  const sourceEventUris = new Map(
    scenario.sourceEventFiles.map((file, index) => [
      `source_events:${index.toString().padStart(6, '0')}`,
      `fixture://${file}`,
    ]),
  );
  const objectUris = new Map([
    ...sourceEventUris,
    ['normalized_ticks:000000', `fixture://${scenario.directory}expected-ticks.ndjson`],
    ['quality_incidents:000000', `fixture://${scenario.directory}expected-incidents.ndjson`],
    ['operational_conditions:000000', `fixture://${scenario.directory}expected-conditions.ndjson`],
    ['quality_profile:000000', 'fixture://quality-profile.json'],
    ['source_schema:000000', 'fixture://source-schema.json'],
  ]);
  return {
    locateManifest: () => `fixture://${scenario.directory}expected-dataset.canonical.json`,
    locateObject: (artifactId: string) => {
      const uri = objectUris.get(artifactId);
      if (uri === undefined) {
        throw new TypeError(`Artifact sin ubicación de fixture: ${artifactId}`);
      }
      return uri;
    },
  };
}

beforeAll(async () => {
  // El consumidor verifica checksums e integridad del oráculo antes de ejecutarlo.
  await validateMarketDataVectors(vectorRoot);
});

describe('F1-VECTOR-001 / F1-QUALITY-001: pipeline completo contra market-data v1', () => {
  describe.each(scenarios)('escenario $name', (scenario) => {
    function runFromStimuli() {
      const profile = loadProfile();
      forbidAmbientEffects();
      const ingestion = ingestSyntheticStimuli(readNdjson(scenario.input), profile);
      if (ingestion.status !== 'persisted') {
        throw new TypeError('El escenario debe persistir todos sus source events.');
      }
      const publication = buildDatasetPublication({
        ...locators(scenario),
        profile,
        publication_id: scenario.publication.publication_id,
        published_at_utc: scenario.publication.published_at_utc,
        segments: ingestion.segments,
      });
      return { ingestion, profile, publication };
    }

    it('reproduce cada segmento de source events byte a byte', () => {
      const { ingestion, publication } = runFromStimuli();
      expect(ingestion.segments).toHaveLength(scenario.sourceEventFiles.length);
      scenario.sourceEventFiles.forEach((file, index) => {
        const artifactId = `source_events:${index.toString().padStart(6, '0')}`;
        const bytes = publication.objects.get(artifactId);
        expect(bytes, artifactId).toBeDefined();
        expectSameBytes(bytes ?? new Uint8Array(), file);
      });
    });

    it('reproduce ticks, incidencias y condiciones byte a byte', () => {
      const { publication } = runFromStimuli();
      const objectFor = (id: string) => publication.objects.get(id) ?? new Uint8Array([0xff]);
      expectSameBytes(
        objectFor('normalized_ticks:000000'),
        `${scenario.directory}expected-ticks.ndjson`,
      );
      expectSameBytes(
        objectFor('quality_incidents:000000'),
        `${scenario.directory}expected-incidents.ndjson`,
      );
      expectSameBytes(
        objectFor('operational_conditions:000000'),
        `${scenario.directory}expected-conditions.ndjson`,
      );
    });

    it('reproduce manifiesto, documento canónico, publicación, objetos y hashes', () => {
      const { publication } = runFromStimuli();
      const expected = scenario.manifest.expected;

      expect(publication.dataset_id).toBe(scenario.expectedDatasetId);
      expect(publication.dataset_id).toBe(expected['dataset_id']);
      expect(publication.core.source_event_count).toBe(expected['source_event_count']);
      expect(publication.core.raw_frame_count).toBe(expected['raw_frame_count']);
      expect(publication.core.normalized_tick_count).toBe(expected['normalized_tick_count']);
      expect(publication.core.incident_count).toBe(expected['incident_count']);
      expect(publication.core.condition_event_count).toBe(expected['condition_event_count']);

      expectSameBytes(
        publication.manifest_bytes,
        `${scenario.directory}expected-dataset.canonical.json`,
      );
      expectSameBytes(
        prettyCanonicalJson(publication.manifest),
        `${scenario.directory}expected-dataset.json`,
      );
      expectSameBytes(
        prettyCanonicalJson(publication.record),
        `${scenario.directory}expected-publication-record.json`,
      );
      expectSameBytes(
        publication.manifest_bytes,
        fixturePath(publication.record.manifest_object_uri),
      );

      for (const object of publication.manifest.storage_objects) {
        const bytes = publication.objects.get(object.artifact_id);
        expect(bytes, object.artifact_id).toBeDefined();
        expectSameBytes(bytes ?? new Uint8Array(), fixturePath(object.uri));
      }
    });

    it('recomputa el mismo dataset solo desde source events persistidos', () => {
      const profile = loadProfile();
      forbidAmbientEffects();
      const replay = buildDatasetPublication({
        ...locators(scenario),
        profile,
        publication_id: scenario.publication.publication_id,
        published_at_utc: scenario.publication.published_at_utc,
        segments: scenario.sourceEventFiles.map(readNdjson),
      });
      expect(replay.dataset_id).toBe(scenario.expectedDatasetId);
      expectSameBytes(
        replay.manifest_bytes,
        `${scenario.directory}expected-dataset.canonical.json`,
      );
    });
  });

  it('deriva la salud final del escenario principal byte a byte', () => {
    const scenario = scenarios[0];
    if (scenario === undefined) {
      throw new TypeError('Falta el escenario principal.');
    }
    const profile = loadProfile();
    forbidAmbientEffects();
    const ingestion = ingestSyntheticStimuli(readNdjson(scenario.input), profile);
    if (ingestion.status !== 'persisted') {
      throw new TypeError('El escenario principal debe persistir.');
    }
    const publication = buildDatasetPublication({
      ...locators(scenario),
      profile,
      publication_id: scenario.publication.publication_id,
      published_at_utc: scenario.publication.published_at_utc,
      segments: ingestion.segments,
    });
    const health = deriveHealthReport({
      backlog_bytes: 0,
      backlog_count: 0,
      derived: publication.derived,
      last_published_dataset_id: publication.dataset_id,
      source: profile.source,
      sourceEvents: ingestion.segments.flat(),
    });

    expect(health.service_health).toBe(mainManifest.expected['final_service_health']);
    expectSameBytes(prettyCanonicalJson(health), 'expected-health.json');
  });

  it('falla cerrado ante persistencia raw no disponible', () => {
    const profile = loadProfile();
    forbidAmbientEffects();
    const result = ingestSyntheticStimuli(readNdjson('input-persistence-failure.ndjson'), profile);

    expect(result.status).toBe('fail_closed');
    if (result.status !== 'fail_closed') {
      return;
    }
    expect(result.durableSegments).toEqual([]);
    expectSameBytes(prettyCanonicalJson(result.outcome), 'expected-persistence-failure.json');
  });
});
