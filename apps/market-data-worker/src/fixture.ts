import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type SourceEvent, validateMarketDataVectors } from '@buoh/contracts';
import { createPipelineProfile, ingestSyntheticStimuli, type PipelineProfile } from '@buoh/domain';
import { z } from 'zod';

/** Ubicación de `test-vectors/market-data/v1` relativa a este módulo (src/ o dist/). */
export const DEFAULT_VECTOR_ROOT = new URL(
  '../../../test-vectors/market-data/v1/',
  import.meta.url,
);

export interface FixtureScenario {
  readonly name: 'principal' | 'zero-valid-ticks';
  /** Segmentos que produce el harness puro de `packages/domain`. */
  readonly segments: SourceEvent[][];
  /** Estímulos del driver, para recorrer el pipeline raw-first real. */
  readonly stimuli: readonly unknown[];
}

export interface SyntheticFixture {
  readonly profile: PipelineProfile;
  readonly scenarios: readonly FixtureScenario[];
}

const profileSchema = z.object({
  connector_version: z.string().min(1),
  source_schema_release: z.string().min(1),
});

async function readNdjson(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  return text.length === 0
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
}

/**
 * Carga el oráculo sintético verificado y ejecuta el harness de `packages/domain` para obtener los
 * segmentos de source events de cada escenario publicable. Datos sintéticos; nunca de Deriv.
 */
export async function loadSyntheticFixture(vectorRoot: string): Promise<SyntheticFixture> {
  await validateMarketDataVectors(vectorRoot);
  const manifest = JSON.parse(await readFile(resolve(vectorRoot, 'manifest.json'), 'utf8')) as {
    profile?: unknown;
  };
  const connector = profileSchema.parse(manifest.profile);
  const profile = createPipelineProfile({
    connector_version: connector.connector_version,
    quality_profile_bytes: await readFile(resolve(vectorRoot, 'quality-profile.json')),
    source_schema_bytes: await readFile(resolve(vectorRoot, 'source-schema.json')),
    source_schema_release: connector.source_schema_release,
  });

  const ingest = async (name: FixtureScenario['name'], input: string): Promise<FixtureScenario> => {
    const stimuli = await readNdjson(resolve(vectorRoot, input));
    const result = ingestSyntheticStimuli(stimuli, profile);
    if (result.status !== 'persisted') {
      throw new TypeError(`El escenario ${name} debe persistir todos sus source events.`);
    }
    return { name, segments: result.segments, stimuli };
  };

  return {
    profile,
    scenarios: [
      await ingest('principal', 'input-frames.ndjson'),
      await ingest('zero-valid-ticks', 'zero-valid-ticks/input.ndjson'),
    ],
  };
}
