import { createHash } from 'node:crypto';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DERIV_OPERATIONS,
  downloadSchemaArchive,
  loadDerivSchemas,
  openSchemaArchive,
  schemaEntryName,
  type SchemaLoadResult,
} from '../src/deriv/schema-archive.js';
import { OperationalRegistry } from '../src/operational/registry.js';
import { MemoryOperationalStore } from './support/memory-stores.js';

// Carga de `schemas.zip` (ADR-0004 §2, §7 y §12; ADR-0012 §2), sin red. Los archivos son sintéticos
// y se crean aquí con fflate: buoh no guarda los esquemas de Deriv, cuyo repositorio no tiene
// licencia. El SHA-256 esperado de cada archivo se calcula con `node:crypto`, no con el código
// probado.
const DRAFT_04 = 'http://json-schema.org/draft-04/schema#';
const MTIME = new Date('2026-01-01T00:00:00.000Z');
const MIB = 1024 * 1024;

/** Esquema draft-04 sintético, con una regla propia de draft-04 (`exclusiveMinimum` booleano). */
function schemaText(title: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: DRAFT_04,
    properties: { n: { exclusiveMinimum: true, minimum: 0, type: 'integer' } },
    title,
    type: 'object',
    ...extra,
  });
}

/** Las 14 entradas que usa buoh, más dos que no usa. */
function entries(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    'README.md': strToU8('sintético'),
    'unused_request.schema.json': strToU8(schemaText('unused')),
  };
  for (const operation of DERIV_OPERATIONS) {
    for (const kind of ['request', 'response'] as const) {
      files[schemaEntryName(operation, kind)] = strToU8(schemaText(`${operation} ${kind}`));
    }
  }
  return files;
}

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 9, mtime: MTIME });
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pinned = (bytes: Uint8Array) => ({ archive_sha256: sha256(bytes), release: 'synthetic' });

/**
 * Cambia el tamaño sin comprimir que declara el directorio central para cada entrada (offset 24 de
 * su cabecera), sin tocar los datos. Sirve para probar que los límites se aplican a lo declarado,
 * antes de descomprimir.
 */
function withDeclaredSizes(archive: Uint8Array, size: (name: string) => number | null): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) {
    end -= 1;
  }
  let offset = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const declared = size(name);
    if (declared !== null) {
      view.setUint32(offset + 24, declared, true);
    }
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return bytes;
}

/**
 * Rompe los datos comprimidos de una entrada (un bloque deflate de tipo 3, que no existe). Si se
 * descomprimiera, fflate lanzaría un error, así que un límite que salta antes demuestra que no se
 * descomprimió nada.
 */
function withCorruptData(archive: Uint8Array, entryName: string): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 30 < bytes.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (name === entryName) {
      const data = offset + 30 + nameLength + view.getUint16(offset + 28, true);
      bytes.fill(0xff, data, data + 4);
      return bytes;
    }
  }
  throw new TypeError(`Entrada no encontrada: ${entryName}`);
}

function failure(result: SchemaLoadResult) {
  if (result.status !== 'failed') {
    throw new TypeError('Se esperaba una carga fallida.');
  }
  return result;
}

beforeEach(() => {
  // Ninguna prueba usa la red: la descarga recibe un `fetch` falso.
  vi.stubGlobal('fetch', () => {
    throw new Error('fetch global prohibido en las pruebas.');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openSchemaArchive', () => {
  it('extrae y compila las 14 entradas que usa buoh, sin cambiar sus bytes', () => {
    const files = entries();
    const archive = zip(files);
    const result = openSchemaArchive(archive, pinned(archive));

    if (result.status !== 'loaded') {
      throw new TypeError(`Carga fallida: ${result.reason}`);
    }
    expect(result.schemas.archive_sha256).toBe(sha256(archive));
    expect(result.schemas.release).toBe('synthetic');
    for (const operation of DERIV_OPERATIONS) {
      for (const kind of ['request', 'response'] as const) {
        expect(result.schemas.schema(operation, kind).bytes).toEqual(
          files[schemaEntryName(operation, kind)],
        );
      }
    }
    // Validador draft-04: `exclusiveMinimum: true` excluye el 0.
    const ticks = result.schemas.schema('ticks', 'response');
    expect(ticks.validate({ n: 1 })).toBe(true);
    expect(ticks.validate({ n: 0 })).toBe(false);
  });

  it('no abre un archivo distinto del fijado', () => {
    // Las entradas están rotas, pero el hash se comprueba antes de leer nada.
    const archive = zip({ ...entries(), 'ticks_response.schema.json': strToU8('no es json') });
    const result = failure(
      openSchemaArchive(archive, { ...pinned(archive), archive_sha256: '0'.repeat(64) }),
    );

    expect(result).toMatchObject({
      detail: sha256(archive),
      reason: 'archive_sha256_mismatch',
      service_health: 'failed',
      violation: null,
    });
  });

  it('rechaza un archivo de más de 5 MiB antes de calcular su hash', () => {
    const archive = new Uint8Array(5 * MIB + 1);
    const result = failure(
      openSchemaArchive(archive, { archive_sha256: '0'.repeat(64), release: 'x' }),
    );

    expect(result.reason).toBe('source_limit_exceeded');
    expect(result.violation?.evidence).toEqual({
      maximum_value: 5_242_880,
      observed_value: 5_242_881,
      resource: 'schema_archive',
      unit: 'bytes',
    });
  });

  it('aplica los límites de entradas a lo que declara el directorio, antes de descomprimir', () => {
    // Cada archivo lleva una entrada que no se puede descomprimir: si se descomprimiera antes de
    // los límites, el motivo sería `archive_invalid`.
    const corrupt = (archive: Uint8Array) => withCorruptData(archive, 'ticks_response.schema.json');
    const cases = [
      {
        archive: corrupt(
          zip({
            ...entries(),
            ...Object.fromEntries(
              Array.from({ length: 1001 - Object.keys(entries()).length }, (_, index) => [
                `extra_${String(index)}.json`,
                strToU8('{}'),
              ]),
            ),
          }),
        ),
        evidence: {
          maximum_value: 1000,
          observed_value: 1001,
          resource: 'schema_entries',
          unit: 'entries',
        },
      },
      {
        archive: withDeclaredSizes(corrupt(zip(entries())), (name) =>
          name === 'README.md' ? 10 * MIB + 1 : null,
        ),
        evidence: {
          maximum_value: 10_485_760,
          observed_value: 10 * MIB + 1,
          resource: 'schema_entry',
          unit: 'bytes',
        },
      },
      {
        // 16 entradas de 3,5 MB declarados: cada una cabe, el total no.
        archive: withDeclaredSizes(corrupt(zip(entries())), () => 3_500_000),
        evidence: {
          maximum_value: 52_428_800,
          observed_value: 16 * 3_500_000,
          resource: 'schema_expanded',
          unit: 'bytes',
        },
      },
    ];
    for (const { archive, evidence } of cases) {
      const result = failure(openSchemaArchive(archive, pinned(archive)));
      expect(result.reason, evidence.resource).toBe('source_limit_exceeded');
      expect(result.violation?.evidence, evidence.resource).toEqual(evidence);
      expect(result.violation?.service_health, evidence.resource).toBe('failed');
    }
  });

  it('falla si falta una entrada, si una no es un esquema admitido o si el archivo no es un ZIP', () => {
    const withoutTime = entries();
    delete withoutTime['time_response.schema.json'];
    const notJson = { ...entries(), 'ping_request.schema.json': strToU8('{') };
    const draft07 = {
      ...entries(),
      'forget_response.schema.json': strToU8(
        schemaText('draft-07', { $schema: 'http://json-schema.org/draft-07/schema#' }),
      ),
    };
    const unknownKeyword = {
      ...entries(),
      'active_symbols_response.schema.json': strToU8(schemaText('extra', { x_buoh: 1 })),
    };
    const notZip = strToU8('esto no es un ZIP');
    const cases = [
      [zip(withoutTime), 'schema_entry_missing', 'time_response.schema.json'],
      [zip(notJson), 'schema_entry_invalid', 'ping_request.schema.json'],
      [zip(draft07), 'schema_entry_invalid', 'forget_response.schema.json'],
      [zip(unknownKeyword), 'schema_entry_invalid', 'active_symbols_response.schema.json'],
      [notZip, 'archive_invalid', null],
      [withCorruptData(zip(entries()), 'ticks_response.schema.json'), 'archive_invalid', null],
    ] as const;

    for (const [archive, reason, detail] of cases) {
      expect(failure(openSchemaArchive(archive, pinned(archive))), reason).toMatchObject({
        detail,
        reason,
        violation: null,
      });
    }
  });

  it('falla si una entrada no mide lo que declara', () => {
    const archive = withDeclaredSizes(zip(entries()), (name) =>
      name === 'ticks_request.schema.json' ? schemaText('ticks request').length + 5 : null,
    );

    expect(failure(openSchemaArchive(archive, pinned(archive)))).toMatchObject({
      detail: 'ticks_request.schema.json',
      reason: 'archive_invalid',
    });
  });
});

/** Cuerpo de respuesta en trozos; `pulled` cuenta cuántas veces se leyó y `cancelled`, si se cortó. */
function body(chunks: readonly Uint8Array[]) {
  const state = { cancelled: false, pulled: 0 };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
    pull(controller) {
      state.pulled += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
  });
  return { state, stream };
}

const fakeFetch = (response: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(() => Promise.resolve(response()));

describe('downloadSchemaArchive', () => {
  const url = 'https://example.invalid/schemas.zip';

  it('devuelve los bytes completos de una descarga dentro del límite', async () => {
    const { stream } = body([strToU8('abc'), strToU8('def')]);
    const fetchImpl = fakeFetch(() => new Response(stream, { status: 200 }));
    const signal = new AbortController().signal;

    await expect(downloadSchemaArchive({ fetch: fetchImpl, signal, url })).resolves.toEqual({
      bytes: strToU8('abcdef'),
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(url, { redirect: 'follow', signal });
  });

  it('rechaza un Content-Length mayor que el máximo sin leer el cuerpo', async () => {
    const { state, stream } = body([strToU8('abc')]);
    const fetchImpl = fakeFetch(
      () => new Response(stream, { headers: { 'content-length': '5242881' }, status: 200 }),
    );
    const result = await downloadSchemaArchive({
      fetch: fetchImpl,
      signal: new AbortController().signal,
      url,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure).toMatchObject({
      reason: 'source_limit_exceeded',
      violation: { evidence: { observed_value: 5_242_881, resource: 'schema_archive' } },
    });
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(state.cancelled).toBe(true);
  });

  it('deja de leer en cuanto el cuerpo supera el máximo', async () => {
    const chunk = new Uint8Array(MIB);
    const { state, stream } = body(Array.from({ length: 8 }, () => chunk));
    const result = await downloadSchemaArchive({
      fetch: fakeFetch(() => new Response(stream, { status: 200 })),
      signal: new AbortController().signal,
      url,
    });

    expect(!result.ok && result.failure).toMatchObject({
      reason: 'source_limit_exceeded',
      violation: { evidence: { observed_value: 6 * MIB, resource: 'schema_archive' } },
    });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(8);
  });

  it('da un motivo saneado cuando la descarga falla', async () => {
    const signal = new AbortController().signal;
    const notFound = await downloadSchemaArchive({
      fetch: fakeFetch(() => new Response('no', { status: 404 })),
      signal,
      url,
    });
    const network = await downloadSchemaArchive({
      fetch: vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed'))),
      signal,
      url,
    });

    expect(!notFound.ok && notFound.failure).toMatchObject({
      detail: '404',
      reason: 'download_status',
    });
    expect(!network.ok && network.failure).toMatchObject({
      detail: null,
      reason: 'download_failed',
    });
  });

  it('corta la descarga cuando vence el tiempo', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('vencido', 'TimeoutError'));
          });
        }),
    );
    const pending = downloadSchemaArchive({ fetch: fetchImpl, signal: controller.signal, url });
    controller.abort();

    const result = await pending;
    expect(!result.ok && result.failure).toMatchObject({
      reason: 'download_timeout',
      service_health: 'failed',
    });
  });
});

describe('loadDerivSchemas', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  const ATTEMPT = '019b76da-a800-7000-8000-00000000c001';

  async function load(
    response: () => Response,
    expected?: { archive_sha256: string; release: string },
  ) {
    const store = new MemoryOperationalStore();
    const registry = await OperationalRegistry.open({
      alert: () => undefined,
      source: 'deriv_options',
      store,
    });
    const result = await loadDerivSchemas({
      ...(expected === undefined ? {} : { expected }),
      fetch: fakeFetch(response),
      nextId: () => ATTEMPT,
      now: () => NOW,
      registry,
      related_refs: [],
      signal: new AbortController().signal,
    });
    return { registry, result, store };
  }

  it('carga la release esperada sin registrar nada', async () => {
    const archive = zip(entries());
    const { result, store } = await load(
      () => new Response(archive, { status: 200 }),
      pinned(archive),
    );

    expect(result.status).toBe('loaded');
    expect(store.incidents).toEqual([]);
  });

  it('registra un límite superado como `source_limit_exceeded` crítico, con la condición abierta', async () => {
    const { registry, result, store } = await load(
      () =>
        new Response(body([]).stream, { headers: { 'content-length': '6000000' }, status: 200 }),
    );

    expect(result.status).toBe('failed');
    expect(store.incidents).toHaveLength(1);
    expect(store.incidents[0]).toMatchObject({
      evidence: {
        maximum_value: 5_242_880,
        observed_value: 6_000_000,
        resource: 'schema_archive',
        unit: 'bytes',
      },
      incident_type: 'source_limit_exceeded',
      observed_at_utc: NOW,
      observed_ref: ATTEMPT,
      related_refs: [],
      severity: 'critical',
      source: 'deriv_options',
      symbol: null,
    });
    expect(registry.openConditionTypes()).toEqual(['source_limit_exceeded']);
  });

  it('un archivo distinto del fijado deja la salud en `failed` sin incidencia de límite', async () => {
    const archive = zip(entries());
    // Sin `expected`, se espera el SHA-256 de la release fijada de Deriv.
    const { result, store } = await load(() => new Response(archive, { status: 200 }));

    expect(failure(result)).toMatchObject({
      reason: 'archive_sha256_mismatch',
      service_health: 'failed',
    });
    expect(store.incidents).toEqual([]);
  });
});
