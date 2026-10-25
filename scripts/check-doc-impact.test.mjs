import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateDocumentationImpact,
  globToRegExp,
  matchesAny,
  parseAcknowledgements,
  validateImpactMap,
} from './check-doc-impact.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actualMap = validateImpactMap(
  JSON.parse(readFileSync(resolve(repositoryRoot, 'docs/impact-map.json'), 'utf8')),
);
const syntheticMap = validateImpactMap({
  schema_version: '1.0.0',
  rules: [
    {
      id: 'contracts',
      description: 'Revisar contratos.',
      includes: ['packages/contracts/**'],
      requires_any: ['docs/contracts.md'],
    },
  ],
});

test('convierte globs de rutas sin aceptar directorios vecinos', () => {
  const pattern = globToRegExp('packages/contracts/**');

  assert.equal(pattern.test('packages/contracts/src/index.ts'), true);
  assert.equal(pattern.test('packages/domain/src/index.ts'), false);
  assert.equal(matchesAny('tsconfig.base.json', ['tsconfig*.json']), true);
});

test('reporta una violación cuando falta la fuente canónica', () => {
  const result = evaluateDocumentationImpact(['packages/contracts/src/index.ts'], syntheticMap);

  assert.equal(result.triggered.length, 1);
  assert.equal(result.violations.length, 1);
  assert.deepEqual(result.violations[0]?.affectedFiles, ['packages/contracts/src/index.ts']);
});

test('acepta el cambio cuando una fuente requerida fue revisada', () => {
  const result = evaluateDocumentationImpact(
    ['docs/contracts.md', 'packages/contracts/src/index.ts'],
    syntheticMap,
  );

  assert.equal(result.triggered.length, 1);
  assert.equal(result.violations.length, 0);
  assert.deepEqual(result.triggered[0]?.reviewedFiles, ['docs/contracts.md']);
});

test('exige justificación explícita y rechaza texto insuficiente', () => {
  const acknowledgements = parseAcknowledgements([
    '--acknowledge=contracts:Cambio interno sin modificación semántica del contrato',
  ]);
  const result = evaluateDocumentationImpact(
    ['packages/contracts/src/index.ts'],
    syntheticMap,
    acknowledgements,
  );

  assert.equal(result.violations.length, 0);
  assert.equal(result.acknowledged.length, 1);
  assert.throws(() => parseAcknowledgements(['--acknowledge=contracts:muy corto']), /20/u);
});

test('ignora cambios que no activan una regla', () => {
  const result = evaluateDocumentationImpact(['README.md'], syntheticMap);

  assert.equal(result.triggered.length, 0);
  assert.equal(result.violations.length, 0);
});

test('rechaza IDs de regla duplicados', () => {
  assert.throws(
    () =>
      validateImpactMap({
        schema_version: '1.0.0',
        rules: [syntheticMap.rules[0], syntheticMap.rules[0]],
      }),
    /duplicado/u,
  );
});

test('fija las reglas productivas y sus rutas críticas', () => {
  assert.deepEqual(
    actualMap.rules.map((rule) => rule.id),
    [
      'contracts',
      'toolchain',
      'market-data-worker',
      'infrastructure',
      'test-vectors',
      'design-system',
      'web-clients',
      'documentation-guard',
    ],
  );

  const cases = [
    ['packages/contracts/src/index.ts', 'docs/arquitectura/contratos-de-dominio.md'],
    ['.prettierrc.json', 'PROJECT_STATUS.md'],
    ['scripts/check-runtime.mjs', 'docs/arquitectura/adr/0003-lenguajes-y-limites.md'],
    ['apps/market-data-worker/src/index.ts', 'docs/operacion/runbook-ingesta-de-datos.md'],
    ['infra/compose.yaml', 'docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md'],
    ['test-vectors/market-data/v1/manifest.json', 'docs/arquitectura/contratos-de-dominio.md'],
    ['packages/design-system/src/tokens.ts', 'docs/diseno/marca-buoh.md'],
    ['apps/web/app/page.tsx', 'docs/diseno/concepto-de-interfaz.md'],
    ['apps/site/app/page.tsx', 'docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md'],
    ['scripts/check-doc-impact.mjs', 'CONTRIBUTING.md'],
  ];

  for (const [changed, documentation] of cases) {
    const missing = evaluateDocumentationImpact([changed], actualMap);
    assert.equal(missing.violations.length, 1, changed);

    const satisfied = evaluateDocumentationImpact([changed, documentation], actualMap);
    assert.equal(satisfied.violations.length, 0, changed);
  }
});
