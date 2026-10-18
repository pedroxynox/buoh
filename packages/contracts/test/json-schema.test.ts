import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import * as publicContracts from '../src/index.js';
import { datasetManifestSchema, marketTickSchema, sourceEventSchema } from '../src/index.js';

function loadExportedSchema(name: string): object {
  const url = import.meta.resolve(`@buoh/contracts/json-schema/${name}`);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as object;
}

function loadVector(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../test-vectors/market-data/v1/${relativePath}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

function loadFirstLine(relativePath: string): unknown {
  const [line] = readFileSync(
    new URL(`../../../test-vectors/market-data/v1/${relativePath}`, import.meta.url),
    'utf8',
  ).split('\n');
  if (line === undefined || line.length === 0) {
    throw new TypeError(`Fixture vacío: ${relativePath}`);
  }
  return JSON.parse(line) as unknown;
}

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

describe('JSON Schema exportado', () => {
  it('no expone validadores estructurales como API runtime', () => {
    expect('marketTickStructuralSchema' in publicContracts).toBe(false);
    expect('datasetManifestStructuralSchema' in publicContracts).toBe(false);
    expect('sourceEventStructuralSchema' in publicContracts).toBe(false);
  });

  it('es accesible por subpath público y coincide en restricciones estructurales', () => {
    const sourceValidator = ajv.compile(loadExportedSchema('source-event'));
    const source = sourceEventSchema.parse(loadFirstLine('expected-source-events-000000.ndjson'));

    expect(sourceValidator(source)).toBe(true);
    expect(sourceEventSchema.safeParse({ ...source, unexpected: true }).success).toBe(false);
    expect(sourceValidator({ ...source, unexpected: true })).toBe(false);
    expect(sourceValidator({ ...source, received_at_utc: '2026-13-01T00:00:00.000Z' })).toBe(false);
  });

  it('valida URIs absolutas tanto en Zod como en JSON Schema', () => {
    const datasetValidator = ajv.compile(loadExportedSchema('dataset-manifest'));
    const dataset = datasetManifestSchema.parse(loadVector('expected-dataset.json'));
    const invalid = structuredClone(dataset);
    const firstObject = invalid.storage_objects[0];
    if (firstObject === undefined) {
      throw new TypeError('Fixture sin objetos físicos.');
    }
    firstObject.uri = 'ruta/relativa';

    expect(datasetManifestSchema.safeParse(invalid).success).toBe(false);
    expect(datasetValidator(invalid)).toBe(false);
  });

  it('mantiene las invariantes criptográficas como responsabilidad runtime explícita', () => {
    const tickValidator = ajv.compile(loadExportedSchema('market-tick'));
    const tick = marketTickSchema.parse(loadFirstLine('expected-ticks.ndjson'));
    const invalid = { ...tick, tick_fingerprint_sha256: '0'.repeat(64) };

    expect(tickValidator(invalid)).toBe(true);
    expect(marketTickSchema.safeParse(invalid).success).toBe(false);
  });
});
