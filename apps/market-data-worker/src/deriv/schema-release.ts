/**
 * La release fijada de los esquemas de Deriv y los nombres de sus entradas, sin cargar `fflate` ni
 * `ws` (ADR-0019 §8): los usan la carga de `schemas.zip` (`schema-archive.ts`), la sesión
 * (`session.ts`) y `data:health`, y la ruta `@buoh/market-data-worker/lectura`, que arma el perfil
 * de medición con el esquema de fuente que guardó la ingesta.
 */

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
 * La entrada de la release que es el esquema de fuente del perfil de medición (`profile.ts`): la que
 * la sesión guarda y `data:health` lee (ADR-0015 §7 y §8).
 */
export const SOURCE_SCHEMA_ENTRY = schemaEntryName('ticks', 'response');
