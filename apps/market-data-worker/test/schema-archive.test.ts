import { createHash } from 'node:crypto';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadSchemaArchive,
  loadDerivSchemas,
  openSchemaArchive,
  type SchemaLoadResult,
} from '../src/deriv/schema-archive.js';
import {
  DERIV_BATCH_OPERATIONS,
  DERIV_OPERATIONS,
  DERIV_PINNED_OPERATIONS,
  DERIV_SCHEMA_RELEASE,
  schemaEntryName,
  type ExpectedSchemaArchive,
  type SchemaEntryName,
} from '../src/deriv/schema-release.js';
import { OperationalRegistry } from '../src/operational/registry.js';
import { MemoryOperationalStore } from './support/memory-stores.js';

// Carga de `schemas.zip` (ADR-0004 §2, §7 y §12; ADR-0012 §2), sin red. Los archivos son sintéticos
// y se crean aquí con fflate: buoh no guarda los esquemas de Deriv, cuyo repositorio no tiene
// licencia. Los SHA-256 esperados se calculan con `node:crypto` sobre los bytes que se comprimen, no
// con el código probado.
const DRAFT_04 = 'http://json-schema.org/draft-04/schema#';
const MTIME = new Date('2026-01-01T00:00:00.000Z');
const MIB = 1024 * 1024;

/** Operaciones de la captura en vivo (ADR-0012 §1 y §2), escritas aquí como oráculo. */
const OPERATIONS = [
  'active_symbols',
  'forget',
  'forget_all',
  'ping',
  'ticks',
  'ticks_history',
  'time',
] as const;
/** Operaciones de los lotes (ADR-0021 §3), también como oráculo. */
const BATCH_OPERATIONS = [
  'active_symbols',
  'contracts_for',
  'proposal',
  'ticks_history',
  'trading_times',
] as const;
const namesOf = (operations: readonly string[]) =>
  operations.flatMap((operation) => [
    `${operation}_request.schema.json`,
    `${operation}_response.schema.json`,
  ]) as SchemaEntryName[];
const WANTED = namesOf(OPERATIONS);
const BATCH_WANTED = namesOf(BATCH_OPERATIONS);
/** Las 6 entradas que fija el PR 4a de ADR-0021 §9, las que solo usan los lotes. */
const BATCH_ONLY = BATCH_WANTED.filter((name) => !WANTED.includes(name));

/**
 * Los SHA-256 de las 6 entradas nuevas de la release fijada, calculados el 2026-11-25 fuera del
 * código, con `zipfile` de Python (`read()` comprueba el CRC-32), sobre el `schemas.zip` de
 * `production_v20260901_0`, cuyo SHA-256 es el fijado. El archivo no está en el repositorio, porque
 * el de Deriv no tiene licencia (ADR-0012 §2).
 */
const PINNED_BATCH_ONLY_SHA256 = {
  'contracts_for_request.schema.json':
    '544e1f971d87ab606b2432724bec1ea5bb1a97d5c5a2446722a6ff9c72e978f9',
  'contracts_for_response.schema.json':
    'cebbf1b1de0deae297e597c820a8bf32c4c9a30fbc8daca892edabdb5fc5e199',
  'proposal_request.schema.json':
    '21163dbe0ac64a04d14187c7c332aae5ce9702649f68874315b63f505b4d7c62',
  'proposal_response.schema.json':
    '295c704a8885c31042f5be513ba989981e365f7d0d93f3432f8282e1d03b8640',
  'trading_times_request.schema.json':
    '37d39686111396918f0529034e9816f45ab734aa3a374082ae8126f8a916b85a',
  'trading_times_response.schema.json':
    '247d5eeb61e3f3619e095d049b14ec24f29895b5bbc2ac9b1c60e6906305f233',
};

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

/** Las 14 entradas de la captura en vivo, más dos que no usa buoh; o las de `names`. */
function entries(names: readonly SchemaEntryName[] = WANTED): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    'README.md': strToU8('sintético'),
    'unused_request.schema.json': strToU8(schemaText('unused')),
  };
  for (const name of names) {
    files[name] = strToU8(schemaText(name));
  }
  return files;
}

/** Las 20 entradas fijadas: las de la captura en vivo y las de los lotes. */
const allEntries = () => entries([...new Set([...WANTED, ...BATCH_WANTED])]);

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 9, mtime: MTIME });
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Lo esperado de un archivo sintético: su SHA-256 y el de los bytes de cada entrada que usa buoh. */
function expectedFor(
  archive: Uint8Array,
  files: Record<string, Uint8Array> = entries(),
): ExpectedSchemaArchive {
  return {
    archive_sha256: sha256(archive),
    entries_sha256: Object.fromEntries(
      [...new Set([...WANTED, ...BATCH_WANTED])].map((name) => [
        name,
        sha256(files[name] ?? new Uint8Array()),
      ]),
    ) as Record<SchemaEntryName, string>,
    release: 'synthetic',
  };
}

/** Un esperado cualquiera, para casos que fallan antes de mirar el archivo. */
const ANY_EXPECTED: ExpectedSchemaArchive = {
  archive_sha256: '0'.repeat(64),
  entries_sha256: Object.fromEntries(WANTED.map((name) => [name, '0'.repeat(64)])) as Record<
    SchemaEntryName,
    string
  >,
  release: 'x',
};

/** Posición del final del directorio central (EOCD) de un archivo creado con fflate. */
function endOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) {
    end -= 1;
  }
  return end;
}

/**
 * Cambia el tamaño sin comprimir que declara el directorio central para cada entrada (offset 24 de
 * su cabecera), sin tocar los datos. Sirve para probar que los límites se aplican a lo declarado,
 * antes de descomprimir.
 */
function withDeclaredSizes(archive: Uint8Array, size: (name: string) => number | null): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer);
  const end = endOfCentralDirectory(bytes);
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

/**
 * Inserta un localizador ZIP64 justo antes del final del directorio. fflate lo sigue hasta el
 * offset 0, no encuentra allí un registro ZIP64 y lee el archivo como uno normal: sin el rechazo de
 * ZIP64, este archivo se cargaría.
 */
function withZip64Locator(archive: Uint8Array): Uint8Array {
  const end = endOfCentralDirectory(archive);
  const locator = new Uint8Array(20);
  new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
  const bytes = new Uint8Array(archive.length + locator.length);
  bytes.set(archive.subarray(0, end), 0);
  bytes.set(locator, end);
  bytes.set(archive.subarray(end), end + locator.length);
  return bytes;
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
    const result = openSchemaArchive(archive, expectedFor(archive, files));

    expect(DERIV_OPERATIONS).toEqual(OPERATIONS);
    if (result.status !== 'loaded') {
      throw new TypeError(`Carga fallida: ${result.reason}`);
    }
    expect(result.schemas.archive_sha256).toBe(sha256(archive));
    expect(result.schemas.release).toBe('synthetic');
    for (const operation of OPERATIONS) {
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

  it('no lee nada de un archivo distinto del fijado', () => {
    // Cada archivo fallaría por otra causa si se leyera antes de comprobar su hash.
    const brokenEntry = zip({ ...entries(), 'ticks_response.schema.json': strToU8('no es json') });
    const withoutEntries = zip({ 'README.md': strToU8('sin esquemas') });
    const notZip = strToU8('esto no es un ZIP');

    for (const archive of [brokenEntry, withoutEntries, notZip]) {
      expect(failure(openSchemaArchive(archive, ANY_EXPECTED))).toMatchObject({
        detail: sha256(archive),
        reason: 'archive_sha256_mismatch',
        service_health: 'failed',
        violation: null,
      });
    }
  });

  it('rechaza un archivo de más de 5 MiB antes de calcular su hash', () => {
    const result = failure(openSchemaArchive(new Uint8Array(5 * MIB + 1), ANY_EXPECTED));

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
    const extra = Object.fromEntries(
      Array.from({ length: 1001 - Object.keys(entries()).length }, (_, index) => [
        `extra_${String(index)}.json`,
        strToU8('{}'),
      ]),
    );
    const cases = [
      {
        archive: corrupt(zip({ ...entries(), ...extra })),
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
      const result = failure(openSchemaArchive(archive, expectedFor(archive)));
      expect(result.reason, evidence.resource).toBe('source_limit_exceeded');
      expect(result.violation?.evidence, evidence.resource).toEqual(evidence);
      expect(result.violation?.service_health, evidence.resource).toBe('failed');
    }
  });

  it('no admite ZIP64', () => {
    const archive = withZip64Locator(zip(entries()));

    expect(failure(openSchemaArchive(archive, expectedFor(archive)))).toMatchObject({
      detail: 'zip64',
      reason: 'archive_invalid',
      violation: null,
    });
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
    const corruptWanted = withCorruptData(zip(entries()), 'ticks_response.schema.json');
    const cases = [
      [zip(withoutTime), withoutTime, 'schema_entry_missing', 'time_response.schema.json'],
      [zip(notJson), notJson, 'schema_entry_invalid', 'ping_request.schema.json'],
      [zip(draft07), draft07, 'schema_entry_invalid', 'forget_response.schema.json'],
      [
        zip(unknownKeyword),
        unknownKeyword,
        'schema_entry_invalid',
        'active_symbols_response.schema.json',
      ],
      [notZip, entries(), 'archive_invalid', null],
      [corruptWanted, entries(), 'archive_invalid', null],
    ] as const;

    for (const [archive, files, reason, detail] of cases) {
      expect(
        failure(openSchemaArchive(archive, expectedFor(archive, files))),
        reason,
      ).toMatchObject({
        detail,
        reason,
        violation: null,
      });
    }
  });

  it('solo descomprime las entradas que usa buoh', () => {
    // Una entrada que buoh no usa está rota: si se descomprimiera, la carga fallaría.
    const archive = withCorruptData(zip(entries()), 'unused_request.schema.json');

    expect(openSchemaArchive(archive, expectedFor(archive)).status).toBe('loaded');
  });

  it('rechaza una entrada que no mide lo que declara, más corta o más larga', () => {
    const name = 'ticks_request.schema.json';
    const text = schemaText(name);
    const shorter = withDeclaredSizes(zip(entries()), (entry) =>
      entry === name ? text.length + 5 : null,
    );
    // fflate corta una entrada más larga de lo que declara: sale con el tamaño declarado, y solo su
    // SHA-256 delata el corte. El JSON del principio sigue siendo válido.
    const padded = { ...entries(), [name]: strToU8(`${text}${' '.repeat(64)}`) };
    const longer = withDeclaredSizes(zip(padded), (entry) => (entry === name ? text.length : null));

    expect(failure(openSchemaArchive(shorter, expectedFor(shorter)))).toMatchObject({
      detail: name,
      reason: 'archive_invalid',
    });
    expect(failure(openSchemaArchive(longer, expectedFor(longer, padded)))).toMatchObject({
      detail: name,
      reason: 'archive_invalid',
    });
  });

  it('la release fija 20 entradas: las 14 de la captura en vivo y 6 que solo usan los lotes', () => {
    expect(DERIV_BATCH_OPERATIONS).toEqual(BATCH_OPERATIONS);
    expect(DERIV_PINNED_OPERATIONS).toEqual(
      [...new Set([...OPERATIONS, ...BATCH_OPERATIONS])].sort(),
    );
    expect(Object.keys(DERIV_SCHEMA_RELEASE.entries_sha256).sort()).toEqual(
      [...new Set([...WANTED, ...BATCH_WANTED])].sort(),
    );
    expect(BATCH_ONLY.sort()).toEqual(Object.keys(PINNED_BATCH_ONLY_SHA256).sort());
    for (const [name, pinned] of Object.entries(PINNED_BATCH_ONLY_SHA256)) {
      expect(DERIV_SCHEMA_RELEASE.entries_sha256[name as SchemaEntryName], name).toBe(pinned);
    }
  });

  it('la captura en vivo no exige ni descomprime las entradas que solo usan los lotes', () => {
    // Sin ellas, o con una rota, la carga de la captura en vivo es la de antes.
    const files = allEntries();
    const corrupt = withCorruptData(zip(files), 'proposal_response.schema.json');
    const withoutBatch = zip(entries());

    for (const archive of [corrupt, withoutBatch]) {
      const result = openSchemaArchive(archive, expectedFor(archive, files));
      if (result.status !== 'loaded') {
        throw new TypeError(`Carga fallida: ${result.reason}`);
      }
      for (const name of BATCH_ONLY) {
        const [operation, kind] = name.replace('.schema.json', '').split(/_(?=[a-z]+$)/u) as [
          (typeof BATCH_OPERATIONS)[number],
          'request' | 'response',
        ];
        expect(() => result.schemas.schema(operation, kind), name).toThrow(/no cargado/u);
      }
    }
  });

  it('con las operaciones de los lotes extrae y compila sus 10 entradas, y no las demás', () => {
    const files = allEntries();
    // `ping` es de la captura en vivo y no de los lotes: rota, no cambia la carga de los lotes.
    const archive = withCorruptData(zip(files), 'ping_response.schema.json');
    const result = openSchemaArchive(archive, expectedFor(archive, files), DERIV_BATCH_OPERATIONS);

    if (result.status !== 'loaded') {
      throw new TypeError(`Carga fallida: ${result.reason}`);
    }
    for (const operation of BATCH_OPERATIONS) {
      for (const kind of ['request', 'response'] as const) {
        expect(result.schemas.schema(operation, kind).bytes).toEqual(
          files[schemaEntryName(operation, kind)],
        );
      }
    }
    expect(() => result.schemas.schema('ping', 'response')).toThrow(/no cargado/u);
    expect(() => result.schemas.schema('ticks', 'request')).toThrow(/no cargado/u);
  });

  it('con las operaciones de los lotes, falla si falta una de sus entradas o no es la fijada', () => {
    const withoutTimes = allEntries();
    delete withoutTimes['trading_times_response.schema.json'];
    const missing = zip(withoutTimes);
    const files = allEntries();
    const archive = zip(files);
    const otherPin = expectedFor(archive, {
      ...files,
      'contracts_for_request.schema.json': strToU8(schemaText('otro contenido')),
    });

    expect(
      failure(
        openSchemaArchive(missing, expectedFor(missing, withoutTimes), DERIV_BATCH_OPERATIONS),
      ),
    ).toMatchObject({
      detail: 'trading_times_response.schema.json',
      reason: 'schema_entry_missing',
    });
    expect(failure(openSchemaArchive(archive, otherPin, DERIV_BATCH_OPERATIONS))).toMatchObject({
      detail: 'contracts_for_request.schema.json',
      reason: 'archive_invalid',
    });
  });

  it('rechaza una entrada cuyo contenido no es el fijado, aunque el archivo sí lo sea', () => {
    const archive = zip(entries());
    const otherPin = expectedFor(archive, {
      ...entries(),
      'ping_response.schema.json': strToU8(schemaText('otro contenido')),
    });

    expect(failure(openSchemaArchive(archive, otherPin))).toMatchObject({
      detail: 'ping_response.schema.json',
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

  it('da un motivo saneado cuando la descarga falla, y no lee el cuerpo de un error', async () => {
    const signal = new AbortController().signal;
    const { state, stream } = body([strToU8('no')]);
    const notFound = await downloadSchemaArchive({
      fetch: fakeFetch(() => new Response(stream, { status: 404 })),
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
    expect(state.cancelled).toBe(true);
    expect(!network.ok && network.failure).toMatchObject({
      detail: null,
      reason: 'download_failed',
    });
  });

  it('corta la descarga si el tiempo vence mientras espera la respuesta', async () => {
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

  it('corta la descarga si el tiempo vence mientras lee el cuerpo', async () => {
    const controller = new AbortController();
    let pulls = 0;
    // Como el cuerpo de `fetch`: al vencer el `signal`, la lectura falla con el motivo del corte.
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulls += 1;
        if (pulls === 1) {
          streamController.enqueue(strToU8('abc'));
          return;
        }
        controller.abort();
        streamController.error(new DOMException('vencido', 'TimeoutError'));
      },
    });
    const result = await downloadSchemaArchive({
      fetch: fakeFetch(() => new Response(stream, { status: 200 })),
      signal: controller.signal,
      url,
    });

    expect(pulls).toBeGreaterThan(1);
    expect(!result.ok && result.failure).toMatchObject({
      reason: 'download_timeout',
      service_health: 'failed',
    });
  });
});

describe('loadDerivSchemas', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  const ATTEMPT = '019b76da-a800-7000-8000-00000000c001';
  const LAST_DURABLE = '019b76da-a800-7000-8000-00000000c000';

  async function load(
    response: () => Response,
    expected?: ExpectedSchemaArchive,
    related: readonly string[] = [],
    operations?: typeof DERIV_BATCH_OPERATIONS,
  ) {
    const store = new MemoryOperationalStore();
    const registry = await OperationalRegistry.open({
      alert: () => undefined,
      source: 'deriv_options',
      store,
    });
    const result = await loadDerivSchemas({
      ...(expected === undefined ? {} : { expected }),
      ...(operations === undefined ? {} : { operations }),
      fetch: fakeFetch(response),
      nextId: () => ATTEMPT,
      now: () => NOW,
      registry,
      related_refs: related,
      signal: new AbortController().signal,
    });
    return { registry, result, store };
  }

  it('carga la release esperada sin registrar nada', async () => {
    const archive = zip(entries());
    const { result, store } = await load(
      () => new Response(archive, { status: 200 }),
      expectedFor(archive),
    );

    expect(result.status).toBe('loaded');
    expect(store.incidents).toEqual([]);
  });

  it('carga las operaciones que se le piden: las de los lotes, sin las de la captura en vivo', async () => {
    const files = entries(BATCH_WANTED);
    const archive = zip(files);
    const { result } = await load(
      () => new Response(archive, { status: 200 }),
      expectedFor(archive, files),
      [],
      DERIV_BATCH_OPERATIONS,
    );

    if (result.status !== 'loaded') {
      throw new TypeError(`Carga fallida: ${result.reason}`);
    }
    expect(result.schemas.schema('trading_times', 'response').bytes).toEqual(
      files['trading_times_response.schema.json'],
    );
    // Sin `operations`, el mismo archivo no basta: le faltan las de la captura en vivo.
    const live = await load(
      () => new Response(archive, { status: 200 }),
      expectedFor(archive, files),
    );
    expect(failure(live.result).reason).toBe('schema_entry_missing');
  });

  it('registra un límite superado como `source_limit_exceeded` crítico, con la condición abierta', async () => {
    const { registry, result, store } = await load(
      () =>
        new Response(body([]).stream, { headers: { 'content-length': '6000000' }, status: 200 }),
      undefined,
      [LAST_DURABLE],
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
      related_refs: [LAST_DURABLE],
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
