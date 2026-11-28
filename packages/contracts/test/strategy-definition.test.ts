import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveStrategyVersionId,
  STRATEGY_DEFINITION_ERROR_CODES,
  strategyDefinitionSchema,
  validateStrategyDefinition,
  type StrategyDefinition,
} from '../src/index.js';

// Vectores compartidos con el motor de investigación (ADR-0022 §11): los errores esperados salen de
// la ADR, y los identificadores, del JCS calculado fuera de este paquete.
const root = new URL('../../../test-vectors/strategy-definition/v1/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, root));

interface ManifestFile {
  bytes: number;
  path: string;
  sha256: string;
}

interface ValidVector {
  definition: StrategyDefinition;
  name: string;
  version_id: string;
}

interface InvalidVector {
  errors: { code: string; path: (number | string)[] }[];
  input: unknown;
  name: string;
}

const manifest = JSON.parse(read('manifest.json').toString('utf8')) as {
  files: ManifestFile[];
  vector_id: string;
};
// Sin red, reloj real ni azar (ADR-0022 §12, como F1-VECTOR-001): las guardas se ponen después de
// leer los vectores.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en la validación.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en la validación.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en la validación.');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const valid = JSON.parse(read('valid.json').toString('utf8')) as ValidVector[];
const invalid = JSON.parse(read('invalid.json').toString('utf8')) as InvalidVector[];

describe('vectores de StrategyDefinition', () => {
  it('coinciden con su manifiesto, byte a byte', () => {
    expect(manifest.vector_id).toBe('strategy-definition-v1');
    expect(manifest.files.map((file) => file.path)).toEqual(['invalid.json', 'valid.json']);
    for (const file of manifest.files) {
      const bytes = read(file.path);
      expect(bytes.length, file.path).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });

  it('tienen nombres únicos y solo códigos de la lista cerrada', () => {
    const names = [...valid, ...invalid].map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
    for (const vector of invalid) {
      for (const item of vector.errors) {
        expect(STRATEGY_DEFINITION_ERROR_CODES, vector.name).toContain(item.code);
      }
    }
  });

  it.each(valid.map((vector) => [vector.name, vector] as const))(
    'acepta %s con su identificador',
    (_name, vector) => {
      const result = validateStrategyDefinition(vector.definition);
      expect(result).toMatchObject({ ok: true, version_id: vector.version_id });
      expect(strategyDefinitionSchema.safeParse(vector.definition).success).toBe(true);
    },
  );

  it.each(invalid.map((vector) => [vector.name, vector] as const))(
    'rechaza %s con sus errores',
    (_name, vector) => {
      const result = validateStrategyDefinition(vector.input);
      expect(result.ok).toBe(false);
      const errors = result.ok ? [] : result.errors;
      expect(errors.map(({ code, path }) => ({ code, path }))).toEqual(vector.errors);
      for (const item of errors) {
        expect(item.message.length).toBeGreaterThan(0);
      }
      const parsed = strategyDefinitionSchema.safeParse(vector.input);
      expect(parsed.success).toBe(false);
      const issues = (parsed.error?.issues ?? []).map(
        (issue) => `${issue.message.split(':')[0] ?? ''} ${JSON.stringify(issue.path)}`,
      );
      expect(new Set(issues).size).toBe(issues.length);
    },
  );

  it('cubren cada código de la lista cerrada', () => {
    const covered = new Set(invalid.flatMap((vector) => vector.errors.map((item) => item.code)));
    expect([...STRATEGY_DEFINITION_ERROR_CODES].filter((code) => !covered.has(code))).toEqual([]);
  });
});

describe('identidad de una versión', () => {
  const [first] = valid;
  if (first === undefined) {
    throw new TypeError('Faltan los vectores válidos.');
  }

  it('es el hash del JCS: no depende del orden de los campos', () => {
    const reordered = Object.fromEntries(Object.entries(first.definition).reverse());
    expect(deriveStrategyVersionId(reordered as StrategyDefinition)).toBe(first.version_id);
  });

  it('cambia con cualquier campo, también la descripción', () => {
    const changed = { ...first.definition, description: `${first.definition.description} ` };
    const result = validateStrategyDefinition(changed);
    expect(result.ok).toBe(true);
    expect(result.ok && result.version_id).not.toBe(first.version_id);
  });

  it('no modifica la definición que recibe', () => {
    const input = structuredClone(first.definition);
    validateStrategyDefinition(input);
    expect(input).toEqual(first.definition);
  });
});
