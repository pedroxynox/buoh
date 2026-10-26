import type { JsonValue } from '@buoh/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvDraft04 from 'ajv-draft-04';

/**
 * Validador del esquema de fuente según su dialecto (contratos de dominio, «Validador del esquema
 * de fuente»; ADR-0012 §2). Se elige por el `$schema` del documento, así que el replay obtiene el
 * mismo validador del esquema que el dataset publica, sin configuración externa.
 */
export const SOURCE_SCHEMA_DIALECTS = {
  'https://json-schema.org/draft/2020-12/schema': '2020-12',
  'http://json-schema.org/draft-04/schema#': 'draft-04',
} as const;

export type SourceSchemaDialect =
  (typeof SOURCE_SCHEMA_DIALECTS)[keyof typeof SOURCE_SCHEMA_DIALECTS];

/**
 * Palabras clave de la release fijada de Deriv que no validan nada (`auth_required` en las
 * peticiones y `examples` en algunas respuestas). En draft-04 se admiten solo como anotación; en
 * modo estricto, cualquier otra palabra desconocida hace fallar la compilación.
 */
export const DRAFT_04_ANNOTATIONS = ['auth_required', 'examples'] as const;

// `ajv-draft-04` es CommonJS y declara la clase como `export default`; con NodeNext, el default
// importado es el objeto del módulo y la clase está en `.default`.
const AjvDraft04 = ajvDraft04.default;

/** Dialecto de un documento de esquema, o error si su `$schema` no es uno de los admitidos. */
export function sourceSchemaDialect(document: unknown): SourceSchemaDialect {
  const declared =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)['$schema']
      : undefined;
  if (typeof declared === 'string' && Object.hasOwn(SOURCE_SCHEMA_DIALECTS, declared)) {
    return SOURCE_SCHEMA_DIALECTS[declared as keyof typeof SOURCE_SCHEMA_DIALECTS];
  }
  throw new TypeError(
    `$schema ${JSON.stringify(declared ?? null)} no está admitido; se esperaba uno de ${Object.keys(SOURCE_SCHEMA_DIALECTS).join(', ')}.`,
  );
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Lee un documento JSON firmado (esquema o perfil) desde sus bytes exactos. */
export function parseJsonDocument(bytes: Uint8Array, label: string): JsonValue {
  try {
    return JSON.parse(decoder.decode(bytes)) as JsonValue;
  } catch (error) {
    throw new TypeError(`${label} no es JSON UTF-8 válido.`, { cause: error });
  }
}

/** Compila el esquema de fuente con el validador de su dialecto, en modo estricto. */
export function compileSourceSchema(document: unknown): (value: unknown) => boolean {
  const dialect = sourceSchemaDialect(document);
  if (dialect === '2020-12') {
    const validate = new Ajv2020({ allErrors: false, strict: true }).compile(document as object);
    return (value) => validate(value);
  }
  const ajv = new AjvDraft04({ allErrors: false, strict: true });
  for (const keyword of DRAFT_04_ANNOTATIONS) {
    ajv.addKeyword(keyword);
  }
  const validate = ajv.compile(document as object);
  return (value) => validate(value);
}
