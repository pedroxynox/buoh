import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/openapi.js';
import { API_ROUTES } from '../src/routes.js';
import { testRequestId, useDeterminismGuards } from './support.js';

// El OpenAPI de la API sale de la tabla de rutas y de los contratos (ADR-0019 §6).
useDeterminismGuards();

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

interface OpenApiDocument {
  readonly openapi: string;
  readonly jsonSchemaDialect: string;
  readonly paths: Record<string, Record<string, { readonly operationId: string }>>;
  readonly components: { readonly schemas: Record<string, object> };
}

const document = buildOpenApiDocument(API_ROUTES) as unknown as OpenApiDocument;

/** Un validador de Ajv, en modo estricto, del esquema `id` de `components.schemas`. */
function validatorFor(id: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    const references = JSON.stringify(schema).replaceAll('"#/components/schemas/', '"component:');
    ajv.addSchema(JSON.parse(references) as object, `component:${name}`);
  }
  return ajv.compile({ $ref: `component:${id}` });
}

describe('buildOpenApiDocument', () => {
  it('es OpenAPI 3.1 con el dialecto de JSON Schema 2020-12', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('describe cada ruta de la tabla con su método y su operationId', () => {
    for (const route of API_ROUTES) {
      expect(document.paths[route.url]?.[route.method.toLowerCase()]?.operationId).toBe(
        route.operationId,
      );
    }
    expect(Object.keys(document.paths)).toEqual(API_ROUTES.map((route) => route.url).sort());
  });

  it('sus esquemas compilan en modo estricto y validan los mensajes', () => {
    expect(Object.keys(document.components.schemas)).toEqual(['ApiError', 'ApiHealth']);
    const health = validatorFor('ApiHealth');
    expect(health({ status: 'ok' })).toBe(true);
    expect(health({ status: 'ok', extra: 1 })).toBe(false);
    const error = validatorFor('ApiError');
    expect(error({ error: { code: 'internal', request_id: testRequestId(1) } })).toBe(true);
    expect(error({ error: { code: 'internal', request_id: testRequestId(1), message: 'x' } })).toBe(
      false,
    );
    expect(error({ error: { code: 'otro', request_id: testRequestId(1) } })).toBe(false);
  });

  it('coincide con apps/api/generated/openapi.json', () => {
    const committed = readFileSync(new URL('../generated/openapi.json', import.meta.url), 'utf8');
    expect(committed).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});
