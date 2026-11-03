import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/openapi.js';
import { API_ROUTE_SPECS } from '../src/routes.js';
import { testRequestId, useDeterminismGuards } from './support.js';

// El OpenAPI de la API sale de la tabla de rutas y de los contratos (ADR-0019 §6).
useDeterminismGuards();

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

interface OpenApiOperation {
  readonly operationId: string;
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: Record<string, { readonly schema: object }>;
  };
  readonly responses: Record<string, { readonly description: string; readonly content: object }>;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly jsonSchemaDialect: string;
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components: { readonly schemas: Record<string, object> };
}

const document = buildOpenApiDocument(API_ROUTE_SPECS) as unknown as OpenApiDocument;

function operation(url: string, method: string): OpenApiOperation {
  const found = document.paths[url]?.[method];
  if (found === undefined) {
    throw new Error(`Falta ${method} ${url} en el OpenAPI.`);
  }
  return found;
}

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
    for (const route of API_ROUTE_SPECS) {
      expect(operation(route.url, route.method.toLowerCase()).operationId).toBe(route.operationId);
    }
    expect(Object.keys(document.paths)).toEqual(
      [...new Set(API_ROUTE_SPECS.map((route) => route.url))].sort(),
    );
  });

  it('un POST declara su cuerpo JSON obligatorio, y un GET no lleva cuerpo', () => {
    expect(operation('/api/v1/enlace/secreto', 'post').requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/LinkSecretRequest' } },
      },
    });
    expect(operation('/api/v1/enlace', 'post').requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkUseRequest' } } },
    });
    expect(operation('/api/salud', 'get').requestBody).toBeUndefined();
  });

  it('cada ruta declara 400 y 500 y sus propios errores, todos con ApiError', () => {
    const statuses = (url: string, method: string) =>
      Object.keys(operation(url, method).responses).sort();
    expect(statuses('/api/salud', 'get')).toEqual(['200', '400', '500', '503']);
    expect(statuses('/api/v1/enlace/secreto', 'post')).toEqual(['200', '400', '403', '500', '503']);
    expect(statuses('/api/v1/enlace', 'post')).toEqual([
      '200',
      '400',
      '403',
      '422',
      '429',
      '500',
      '503',
    ]);
    for (const [status, response] of Object.entries(
      operation('/api/v1/enlace', 'post').responses,
    )) {
      if (status !== '200') {
        expect(response.content, status).toEqual({
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        });
      }
    }
  });

  it('sus esquemas compilan en modo estricto y validan los mensajes', () => {
    expect(Object.keys(document.components.schemas)).toEqual([
      'ApiError',
      'ApiHealth',
      'LinkSecret',
      'LinkSecretRequest',
      'LinkUse',
      'LinkUseRequest',
    ]);
    const health = validatorFor('ApiHealth');
    expect(health({ status: 'ok' })).toBe(true);
    expect(health({ status: 'ok', extra: 1 })).toBe(false);
    const error = validatorFor('ApiError');
    const requestId = testRequestId(1);
    expect(error({ error: { code: 'internal', request_id: requestId } })).toBe(true);
    expect(error({ error: { code: 'internal', request_id: requestId, message: 'x' } })).toBe(false);
    expect(error({ error: { code: 'otro', request_id: requestId } })).toBe(false);
    expect(
      error({ error: { code: 'rate_limited', request_id: requestId, retry_after_seconds: 30 } }),
    ).toBe(true);
    expect(error({ error: { code: 'rate_limited', request_id: requestId } })).toBe(false);
    expect(
      error({ error: { code: 'password_rejected', request_id: requestId, reason: 'too_short' } }),
    ).toBe(true);
    expect(error({ error: { code: 'password_rejected', request_id: requestId } })).toBe(false);
    const use = validatorFor('LinkUseRequest');
    expect(use({ token: 'A'.repeat(43), password: 'x', code: '123456' })).toBe(true);
    expect(use({ token: 'A'.repeat(43), password: 'x', code: '12345' })).toBe(false);
  });

  it('coincide con apps/api/generated/openapi.json', () => {
    const committed = readFileSync(new URL('../generated/openapi.json', import.meta.url), 'utf8');
    expect(committed).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});
