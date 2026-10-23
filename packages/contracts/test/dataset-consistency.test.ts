import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ContractContextError,
  dataQualityIncidentSchema,
  datasetManifestSchema,
  marketTickSchema,
  operationalConditionEventSchema,
  sourceEventSchema,
  validateDatasetConsistency,
  type DatasetConsistencyInput,
} from '../src/index.js';

// Cada registro declara la versión de su contrato que fija el manifiesto, y cada incidencia sus
// reglas (contratos de dominio, «Semántica ejecutable de reglas 2.0.0»).
function lines(path: string): unknown[] {
  const text = readFileSync(
    new URL(`../../../test-vectors/market-data/v1/${path}`, import.meta.url),
    'utf8',
  );
  return text.length === 0
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
}

function principal(): DatasetConsistencyInput {
  const manifest = datasetManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../test-vectors/market-data/v1/expected-dataset.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  return {
    conditions: lines('expected-conditions.ndjson').map((item) =>
      operationalConditionEventSchema.parse(item),
    ),
    core: manifest.manifest_core,
    incidents: lines('expected-incidents.ndjson').map((item) =>
      dataQualityIncidentSchema.parse(item),
    ),
    sourceEvents: [
      ...lines('expected-source-events-000000.ndjson'),
      ...lines('expected-source-events-000001.ndjson'),
    ].map((item) => sourceEventSchema.parse(item)),
    ticks: lines('expected-ticks.ndjson').map((item) => marketTickSchema.parse(item)),
  };
}

describe('validateDatasetConsistency: versiones ligadas al manifiesto', () => {
  it('acepta el dataset principal del vector v1', () => {
    expect(() => {
      validateDatasetConsistency(principal());
    }).not.toThrow();
  });

  it.each([
    [
      'source_events',
      (input: DatasetConsistencyInput) => ({
        ...input,
        sourceEvents: input.sourceEvents.map((item, index) =>
          index === 0 ? { ...item, schema_version: '2.0.0' } : item,
        ),
      }),
    ],
    [
      'ticks',
      (input: DatasetConsistencyInput) => ({
        ...input,
        ticks: input.ticks.map((item, index) =>
          index === 0 ? { ...item, schema_version: '2.0.0' } : item,
        ),
      }),
    ],
    [
      'incidents',
      (input: DatasetConsistencyInput) => ({
        ...input,
        incidents: input.incidents.map((item, index) =>
          index === 0 ? { ...item, schema_version: '2.0.0' } : item,
        ),
      }),
    ],
    [
      'conditions',
      (input: DatasetConsistencyInput) => ({
        ...input,
        conditions: input.conditions.map((item, index) =>
          index === 0 ? { ...item, schema_version: '2.0.0' } : item,
        ),
      }),
    ],
    [
      'quality_rule_version',
      (input: DatasetConsistencyInput) => ({
        ...input,
        incidents: input.incidents.map((item, index) =>
          index === 0 ? { ...item, quality_rule_version: '2.0.0' } : item,
        ),
      }),
    ],
  ] as const)('rechaza %s con otra versión que la del manifiesto', (_label, change) => {
    let error: unknown;
    try {
      validateDatasetConsistency(change(principal()) as DatasetConsistencyInput);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ContractContextError);
    expect((error as ContractContextError).code).toBe('DATASET_VERSION_MISMATCH');
  });
});
