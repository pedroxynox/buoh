import { createHash } from 'node:crypto';

import { compileSourceSchema, evaluateSourceLimit, type SourceLimitViolation } from '@buoh/domain';
import { unzipSync } from 'fflate';

import { type OperationalRegistry } from '../operational/registry.js';

/** Operaciones que usa buoh; de cada una se extraen el esquema de petición y el de respuesta. */
export const DERIV_OPERATIONS = [
  'active_symbols',
  'forget',
  'forget_all',
  'ping',
  'ticks',
  'ticks_history',
  'time',
] as const;

export type DerivOperation = (typeof DERIV_OPERATIONS)[number];
export type SchemaKind = 'request' | 'response';
export type SchemaEntryName = `${DerivOperation}_${SchemaKind}.schema.json`;

export function schemaEntryName(operation: DerivOperation, kind: SchemaKind): SchemaEntryName {
  return `${operation}_${kind}.schema.json`;
}

/** Archivo de esquemas esperado: su SHA-256 y el de cada una de las 14 entradas que usa buoh. */
export interface ExpectedSchemaArchive {
  readonly archive_sha256: string;
  readonly entries_sha256: Readonly<Record<SchemaEntryName, string>>;
  readonly release: string;
}

/**
 * Esquemas de la release fijada de Deriv (ADR-0004 §2 y §7; ADR-0012 §2). buoh no guarda estos
 * archivos en Git, porque su repositorio no tiene licencia: los descarga al arrancar, comprueba el
 * SHA-256 del archivo antes de abrirlo y aplica los límites antes de descomprimir.
 *
 * `entries_sha256` son los SHA-256 de los bytes de cada entrada, calculados con un lector
 * independiente que comprueba el CRC-32 (`zipfile` de Python). Fijan también la extracción: fflate
 * no comprueba el CRC-32 y corta una entrada más larga de lo que declara, así que una entrada
 * extraída que no coincide hace inválida la carga.
 */
export const DERIV_SCHEMA_RELEASE = {
  archive_sha256: 'adaab0acaf33bd159e45912995af2b78101049f43683d223f0ac11be0a39e7c3',
  archive_url:
    'https://github.com/deriv-com/deriv-api-schemas/releases/download/production_v20260901_0/schemas.zip',
  entries_sha256: {
    'active_symbols_request.schema.json':
      '72cc70c556e48f1cea442bc411d47337257167463b004ab5e9867b550f06bf6c',
    'active_symbols_response.schema.json':
      '91367694bbcad7af20088ce3a6463d4bfaf7b2bd6aba12df78a5ba95ee20e49f',
    'forget_request.schema.json':
      '6d7a1aa32c1e5f341f52fdd6b2023d590ba663fb4aa1e83a4f2e74ea3bbdd344',
    'forget_response.schema.json':
      '0f94315c2a6d3b70b9dfe81701003cdf26293c670cb47ddc984b0655d319090a',
    'forget_all_request.schema.json':
      '73d0118738bf66711cc8af9e9d04b225e6216c3b0f27a24a4089d1c6eb627b7b',
    'forget_all_response.schema.json':
      '31bb3b328ef0805e57392a6736c7d95736ceb0ff45ac5d6969339b2f5cb3b8ec',
    'ping_request.schema.json': 'b9a60fb1ab51eeca7e5e068ac0d37ea21d738db3372ad4acb800557b2c99ed74',
    'ping_response.schema.json': '1c864851e0c173ca8ca00e5738c90fc3501fdd8441177267ad7ff629e16f5d26',
    'ticks_request.schema.json': 'e66308a3bee3d2ffc02df96ef35b38bf15b2051ed23301677542d85a2b1e7de2',
    'ticks_response.schema.json':
      'e45cb48b2d3bdcc02f89456b2a3d7e9745c0c6ca1588233b15b7c6732b41ea5b',
    'ticks_history_request.schema.json':
      '3768ec3b34f05d61e4860481b481ab40503da5f7ca6af69903242ae5662ee4be',
    'ticks_history_response.schema.json':
      'fc19cb71a06417c4dcd4f30b084fb9a3e2fc2bd7312e6e6d3855e20244a7d23a',
    'time_request.schema.json': '9a5f6f3600d641ec101ba191e470638ecdbc5693bda44e2cbb30cb9b69064118',
    'time_response.schema.json': '7fd4580176c76fae3be0fa114adf8d55b3351058e2f35a1768dedb87420dc303',
  },
  release: 'production_v20260901_0',
} as const satisfies ExpectedSchemaArchive & { readonly archive_url: string };

/**
 * Tiempo máximo de la descarga (ADR-0004 §7). Lo aplica quien llama, con su reloj inyectado
 * (ADR-0004 §4): crea el `signal` que vence a este tiempo.
 */
export const SCHEMA_DOWNLOAD_TIMEOUT_MS = 30_000;

const WANTED_ENTRY_NAMES: readonly SchemaEntryName[] = DERIV_OPERATIONS.flatMap((operation) => [
  schemaEntryName(operation, 'request'),
  schemaEntryName(operation, 'response'),
]).sort();
const WANTED_ENTRIES: ReadonlySet<string> = new Set(WANTED_ENTRY_NAMES);

export interface DerivSchema {
  /** Bytes exactos de la entrada, tal como vienen en el archivo. */
  readonly bytes: Uint8Array;
  /** Validador del dialecto del documento (draft-04 en esta release), en modo estricto. */
  readonly validate: (value: unknown) => boolean;
}

export interface DerivSchemaSet {
  readonly archive_sha256: string;
  readonly release: string;
  schema(operation: DerivOperation, kind: SchemaKind): DerivSchema;
}

/** Motivo de una carga fallida. Todos dejan la salud en `failed` (ADR-0004 §12). */
export type SchemaLoadFailure =
  | 'archive_invalid'
  | 'archive_sha256_mismatch'
  | 'download_failed'
  | 'download_status'
  | 'download_timeout'
  | 'schema_entry_invalid'
  | 'schema_entry_missing'
  | 'source_limit_exceeded';

export type SchemaLoadResult =
  | { readonly schemas: DerivSchemaSet; readonly status: 'loaded' }
  | {
      /**
       * Dato saneado para diagnosticar: un código HTTP, un recurso, un nombre de entrada, `zip64` o
       * el hash recibido. Nunca contenido del archivo.
       */
      readonly detail: string | null;
      readonly reason: SchemaLoadFailure;
      readonly service_health: 'failed';
      readonly status: 'failed';
      /** Solo con `source_limit_exceeded`: la evidencia que va al registro operativo. */
      readonly violation: SourceLimitViolation | null;
    };

function failed(
  reason: SchemaLoadFailure,
  detail: string | null = null,
  violation: SourceLimitViolation | null = null,
): SchemaLoadResult {
  return { detail, reason, service_health: 'failed', status: 'failed', violation };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/**
 * Si el archivo usa ZIP64: `null` si no tiene final de directorio central. Lo busca como fflate,
 * desde el final y con un comentario de hasta 65 535 bytes, y mira si lo precede el localizador
 * ZIP64. buoh no admite ZIP64: los límites de ADR-0004 §7 nunca lo necesitan, y así todos los
 * tamaños que lee fflate caben en 32 bits y la cantidad de entradas en 16.
 */
function usesZip64(bytes: Uint8Array): boolean | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - 22 - 65_535);
  for (let end = bytes.length - 22; end >= lowest; end -= 1) {
    if (view.getUint32(end, true) === END_OF_CENTRAL_DIRECTORY) {
      return end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR;
    }
  }
  return null;
}

/**
 * Abre el archivo ya descargado. Es pura y va en este orden: tamaño del archivo, SHA-256, rechazo de
 * ZIP64, lectura del directorio sin descomprimir, límites de entradas (cantidad, la mayor y el total
 * expandido), presencia de las 14 entradas que usa buoh, extracción solo de esas, tamaño y SHA-256
 * fijado de cada una y, por último, compilación con su validador estricto.
 */
export function openSchemaArchive(
  bytes: Uint8Array,
  expected: ExpectedSchemaArchive,
): SchemaLoadResult {
  const archiveLimit = evaluateSourceLimit('schema_archive', bytes.length);
  if (archiveLimit !== null) {
    return failed('source_limit_exceeded', 'schema_archive', archiveLimit);
  }
  const archiveSha256 = sha256(bytes);
  if (archiveSha256 !== expected.archive_sha256) {
    // Un archivo distinto del fijado no se abre: no se confía en su contenido (ADR-0004 §2).
    return failed('archive_sha256_mismatch', archiveSha256);
  }
  const zip64 = usesZip64(bytes);
  if (zip64 !== false) {
    return failed('archive_invalid', zip64 ? 'zip64' : null);
  }

  // Primera pasada: solo el directorio central, sin descomprimir nada.
  const declared = new Map<string, number>();
  let entries = 0;
  let expanded = 0;
  let largest = 0;
  try {
    unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        expanded += file.originalSize;
        largest = Math.max(largest, file.originalSize);
        declared.set(file.name, file.originalSize);
        return false;
      },
    });
  } catch {
    return failed('archive_invalid');
  }
  for (const [resource, observed] of [
    ['schema_entries', entries],
    ['schema_entry', largest],
    ['schema_expanded', expanded],
  ] as const) {
    const violation = evaluateSourceLimit(resource, observed);
    if (violation !== null) {
      return failed('source_limit_exceeded', resource, violation);
    }
  }
  const missing = WANTED_ENTRY_NAMES.filter((name) => !declared.has(name));
  if (missing.length > 0) {
    return failed('schema_entry_missing', missing.join(','));
  }

  // Segunda pasada: solo las entradas que usa buoh, ya acotadas por los límites.
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, { filter: (file) => WANTED_ENTRIES.has(file.name) });
  } catch {
    return failed('archive_invalid');
  }
  const schemas = new Map<string, DerivSchema>();
  for (const name of WANTED_ENTRY_NAMES) {
    const content = extracted[name];
    // Las dos comprobaciones cubren lo que fflate no hace: no valida el CRC-32 y corta una entrada
    // más larga de lo que declara. Así nunca se compila una entrada que no sea la fijada.
    if (
      content === undefined ||
      content.length !== declared.get(name) ||
      sha256(content) !== expected.entries_sha256[name]
    ) {
      return failed('archive_invalid', name);
    }
    try {
      // `compileSourceSchema` también rechaza un `$schema` que no sea 2020-12 ni draft-04.
      const document = JSON.parse(decoder.decode(content)) as unknown;
      schemas.set(name, { bytes: content, validate: compileSourceSchema(document) });
    } catch {
      return failed('schema_entry_invalid', name);
    }
  }

  return {
    schemas: {
      archive_sha256: archiveSha256,
      release: expected.release,
      schema(operation, kind) {
        const schema = schemas.get(schemaEntryName(operation, kind));
        if (schema === undefined) {
          throw new TypeError(`Esquema no cargado: ${schemaEntryName(operation, kind)}`);
        }
        return schema;
      },
    },
    status: 'loaded',
  };
}

export type ArchiveDownload =
  | { readonly bytes: Uint8Array; readonly ok: true }
  | { readonly failure: SchemaLoadResult; readonly ok: false };

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Descarga el archivo con el límite de tamaño de ADR-0004 §7: rechaza un `Content-Length` mayor
 * que el máximo sin leer el cuerpo, y si no lo declara, deja de leer en cuanto lo supera. Nunca
 * guarda más de un trozo por encima del máximo.
 */
export async function downloadSchemaArchive(input: {
  readonly fetch: typeof fetch;
  /**
   * Corta la descarga. Quien llama lo hace vencer a los `SCHEMA_DOWNLOAD_TIMEOUT_MS` de su reloj
   * inyectado; esta función no mide el tiempo.
   */
  readonly signal: AbortSignal;
  readonly url: string;
}): Promise<ArchiveDownload> {
  let response: Response;
  try {
    // GitHub sirve las releases con una redirección a otro host; la integridad la da el SHA-256.
    response = await input.fetch(input.url, { redirect: 'follow', signal: input.signal });
  } catch (error) {
    return { failure: failed(isAbort(error) ? 'download_timeout' : 'download_failed'), ok: false };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { failure: failed('download_status', String(response.status)), ok: false };
  }

  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isSafeInteger(declaredLength) && declaredLength >= 0) {
    const violation = evaluateSourceLimit('schema_archive', declaredLength);
    if (violation !== null) {
      await response.body?.cancel();
      return {
        failure: failed('source_limit_exceeded', 'schema_archive', violation),
        ok: false,
      };
    }
  }

  // El cuerpo de `fetch` son bytes; los tipos de Node lo declaran sin tipo de trozo.
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) {
    return { failure: failed('download_failed'), ok: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      const violation = evaluateSourceLimit('schema_archive', total);
      if (violation !== null) {
        await reader.cancel();
        return {
          failure: failed('source_limit_exceeded', 'schema_archive', violation),
          ok: false,
        };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { failure: failed(isAbort(error) ? 'download_timeout' : 'download_failed'), ok: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, ok: true };
}

/**
 * Descarga y abre la release fijada. Si un límite se supera, lo registra como `source_limit_exceeded`
 * en el registro operativo (severidad `critical`, porque impone `failed`), con un UUIDv7 nuevo como
 * `observed_ref`: no hay frame. Cualquier otro fallo solo deja la salud en `failed`.
 */
export async function loadDerivSchemas(input: {
  /** Archivo esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly registry: OperationalRegistry;
  /** Último source event durable de la fuente, o `[]`. */
  readonly related_refs: readonly string[];
  /** Vence a los `SCHEMA_DOWNLOAD_TIMEOUT_MS` del reloj inyectado de quien llama. */
  readonly signal: AbortSignal;
  readonly url?: string;
}): Promise<SchemaLoadResult> {
  const expected = input.expected ?? DERIV_SCHEMA_RELEASE;
  const download = await downloadSchemaArchive({
    fetch: input.fetch,
    signal: input.signal,
    url: input.url ?? DERIV_SCHEMA_RELEASE.archive_url,
  });
  const result = download.ok ? openSchemaArchive(download.bytes, expected) : download.failure;
  if (result.status === 'failed' && result.violation !== null) {
    await input.registry.recordSourceLimitExceeded({
      observed_at_utc: input.now(),
      observed_ref: input.nextId(),
      related_refs: input.related_refs,
      violation: result.violation,
    });
  }
  return result;
}
