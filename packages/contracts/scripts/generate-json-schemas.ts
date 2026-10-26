import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { operationalConditionEventStructuralSchema } from '../src/conditions.js';
import { dataQualityIncidentStructuralSchema } from '../src/data-quality.js';
import {
  datasetManifestStructuralSchema,
  publishedManifestRecordStructuralSchema,
} from '../src/dataset.js';
import { healthReportStructuralSchema } from '../src/health.js';
import { marketTickStructuralSchema } from '../src/market-tick.js';
import { sourceCatalogSnapshotStructuralSchema } from '../src/source-catalog.js';
import { ingestionCursorSchema, sourceEventStructuralSchema } from '../src/source-events.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageRoot, 'generated/json-schema');
const checkOnly = process.argv.includes('--check');

const schemas = [
  ['data-quality-incident.schema.json', dataQualityIncidentStructuralSchema],
  ['dataset-manifest.schema.json', datasetManifestStructuralSchema],
  ['health-report.schema.json', healthReportStructuralSchema],
  ['ingestion-cursor.schema.json', ingestionCursorSchema],
  ['market-tick.schema.json', marketTickStructuralSchema],
  ['operational-condition-event.schema.json', operationalConditionEventStructuralSchema],
  ['published-manifest-record.schema.json', publishedManifestRecordStructuralSchema],
  ['source-catalog-snapshot.schema.json', sourceCatalogSnapshotStructuralSchema],
  ['source-event.schema.json', sourceEventStructuralSchema],
] as const;

let mismatch = false;
if (!checkOnly) {
  await mkdir(outputDirectory, { recursive: true });
}
for (const [fileName, schema] of schemas) {
  const jsonSchema = z.toJSONSchema(schema, {
    cycles: 'throw',
    target: 'draft-2020-12',
    unrepresentable: 'throw',
  });
  const content = `${JSON.stringify(jsonSchema, null, 2)}\n`;
  const path = resolve(outputDirectory, fileName);

  if (checkOnly) {
    let current: string;
    try {
      current = await readFile(path, 'utf8');
    } catch {
      mismatch = true;
      console.error(`Falta esquema generado: ${fileName}`);
      continue;
    }
    if (current !== content) {
      mismatch = true;
      console.error(`Esquema desactualizado: ${fileName}`);
    }
  } else {
    await writeFile(path, content, 'utf8');
    console.log(`generated ${fileName}`);
  }
}

if (mismatch) {
  process.exitCode = 1;
}
