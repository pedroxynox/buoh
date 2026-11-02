import { apiErrorSchema } from '@buoh/contracts';
import { z, type ZodType } from 'zod';

import type { ApiRoute } from './routes.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;

const DEFS_REFERENCE = '#/$defs/';
const COMPONENTS_REFERENCE = '#/components/schemas/';

/** Las respuestas de error que puede dar cualquier ruta de la tabla (ADR-0019 §6). */
const ERROR_RESPONSES = {
  400: 'La petición no cumple su contrato, también si trae parámetros de consulta que la ruta no admite.',
  500: 'Un fallo del servidor, también una respuesta que no cumple su contrato.',
} as const;

/**
 * La descripción OpenAPI 3.1 de la API, desde la misma tabla de rutas que registra Fastify y desde
 * los contratos (ADR-0019 §6). Los esquemas salen de `z.toJSONSchema` en el dialecto 2020-12, el de
 * OpenAPI 3.1, y cada esquema con `id` va una sola vez en `components.schemas`.
 */
export function buildOpenApiDocument(routes: readonly ApiRoute[]): JsonObject {
  const components = new Map<string, Json>();

  const schemaOf = (schema: ZodType, io: 'input' | 'output'): Json => {
    const generated = z.toJSONSchema(schema, {
      cycles: 'throw',
      io,
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    }) as JsonObject;
    const $defs = generated['$defs'];
    const root: JsonObject = Object.fromEntries(
      Object.entries(generated).filter(([key]) => key !== '$schema' && key !== '$defs'),
    );
    if ($defs !== undefined) {
      if (typeof $defs !== 'object' || $defs === null || Array.isArray($defs)) {
        throw new TypeError('$defs inesperado.');
      }
      for (const [id, definition] of Object.entries($defs)) {
        const component = toComponentReferences(definition);
        const existing = components.get(id);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(component)) {
          throw new TypeError(`Dos esquemas distintos con el id ${id}.`);
        }
        components.set(id, component);
      }
    }
    return toComponentReferences(root);
  };

  const jsonContent = (schema: ZodType): JsonObject => ({
    'application/json': { schema: schemaOf(schema, 'output') },
  });

  const paths: Record<string, JsonObject> = {};
  for (const route of routes) {
    const responses: JsonObject = {};
    for (const [status, schema] of Object.entries(route.responses)) {
      responses[status] = { description: 'Respuesta correcta.', content: jsonContent(schema) };
    }
    for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
      responses[status] = { description, content: jsonContent(apiErrorSchema) };
    }
    const operation: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      parameters: queryParameters(schemaOf(route.querystring, 'input')),
      responses,
    };
    const path = toOpenApiPath(route.url);
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API de buoh',
      version: '1',
      description:
        'Generado desde apps/api/src/routes.ts y packages/contracts (ADR-0019 §6). No se edita a mano: pnpm run openapi:generate.',
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    paths: sortedObject(paths),
    components: { schemas: sortedObject(Object.fromEntries(components)) },
  };
}

/** Los parámetros de consulta de un esquema de objeto: uno por propiedad. */
function queryParameters(schema: Json): Json[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new TypeError('La consulta de una ruta tiene que ser un objeto.');
  }
  const properties = schema['properties'];
  if (properties === undefined) {
    return [];
  }
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new TypeError('Propiedades de consulta inesperadas.');
  }
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: property,
  }));
}

/** `/api/v1/x/:id` de Fastify pasa a `/api/v1/x/{id}` de OpenAPI. */
function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
}

/** Cambia las referencias `#/$defs/…` de `z.toJSONSchema` por `#/components/schemas/…`. */
function toComponentReferences(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(toComponentReferences);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] =
      key === '$ref' && typeof child === 'string' && child.startsWith(DEFS_REFERENCE)
        ? `${COMPONENTS_REFERENCE}${child.slice(DEFS_REFERENCE.length)}`
        : toComponentReferences(child);
  }
  return result;
}

function sortedObject<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
