/**
 * La release fijada de los esquemas de Deriv y los nombres de sus entradas, sin cargar `fflate` ni
 * `ws` (ADR-0019 §8): los usan la carga de `schemas.zip` (`schema-archive.ts`), la sesión
 * (`session.ts`) y `data:health`, y la ruta `@buoh/market-data-worker/lectura`, que arma el perfil
 * de medición con el esquema de fuente que guardó la ingesta.
 */

/**
 * Operaciones con su esquema fijado en la release, en orden alfabético: de cada una, el de petición y
 * el de respuesta. Las de la captura en vivo (`DERIV_OPERATIONS`) y, desde el PR 4a de ADR-0021 §9,
 * las de los lotes (`DERIV_BATCH_OPERATIONS`, ADR-0021 §3).
 */
export const DERIV_PINNED_OPERATIONS = [
  'active_symbols',
  'contracts_for',
  'forget',
  'forget_all',
  'ping',
  'proposal',
  'ticks',
  'ticks_history',
  'time',
  'trading_times',
] as const;

export type DerivOperation = (typeof DERIV_PINNED_OPERATIONS)[number];

/**
 * Operaciones de la captura en vivo, las del conector `deriv-options-ws-1.1.0` (ADR-0012 §1 y §2;
 * ADR-0015): son las que extrae y compila cada sesión de `ingest` y de `data:smoke`, sus 14
 * entradas.
 */
export const DERIV_OPERATIONS = [
  'active_symbols',
  'forget',
  'forget_all',
  'ping',
  'ticks',
  'ticks_history',
  'time',
] as const satisfies readonly DerivOperation[];

export type LiveOperation = (typeof DERIV_OPERATIONS)[number];

/**
 * Operaciones de los lotes (ADR-0021 §3): `active_symbols` como catálogo de los lotes,
 * `contracts_for`, `proposal`, `ticks_history` para la historia y las velas, y `trading_times`.
 * Desde el PR 5 de ADR-0021 §9, el conector de los lotes cargará estas. La captura en vivo no extrae
 * ni compila `contracts_for`, `proposal` ni `trading_times`.
 */
export const DERIV_BATCH_OPERATIONS = [
  'active_symbols',
  'contracts_for',
  'proposal',
  'ticks_history',
  'trading_times',
] as const satisfies readonly DerivOperation[];

export type BatchOperation = (typeof DERIV_BATCH_OPERATIONS)[number];

export type SchemaKind = 'request' | 'response';
export type SchemaEntryName = `${DerivOperation}_${SchemaKind}.schema.json`;

export function schemaEntryName(operation: DerivOperation, kind: SchemaKind): SchemaEntryName {
  return `${operation}_${kind}.schema.json`;
}

/**
 * Archivo de esquemas esperado: su SHA-256 y el de cada una de las 20 entradas de
 * `DERIV_PINNED_OPERATIONS`.
 */
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
    'contracts_for_request.schema.json':
      '544e1f971d87ab606b2432724bec1ea5bb1a97d5c5a2446722a6ff9c72e978f9',
    'contracts_for_response.schema.json':
      'cebbf1b1de0deae297e597c820a8bf32c4c9a30fbc8daca892edabdb5fc5e199',
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
    'proposal_request.schema.json':
      '21163dbe0ac64a04d14187c7c332aae5ce9702649f68874315b63f505b4d7c62',
    'proposal_response.schema.json':
      '295c704a8885c31042f5be513ba989981e365f7d0d93f3432f8282e1d03b8640',
    'ticks_request.schema.json': 'e66308a3bee3d2ffc02df96ef35b38bf15b2051ed23301677542d85a2b1e7de2',
    'ticks_response.schema.json':
      'e45cb48b2d3bdcc02f89456b2a3d7e9745c0c6ca1588233b15b7c6732b41ea5b',
    'ticks_history_request.schema.json':
      '3768ec3b34f05d61e4860481b481ab40503da5f7ca6af69903242ae5662ee4be',
    'ticks_history_response.schema.json':
      'fc19cb71a06417c4dcd4f30b084fb9a3e2fc2bd7312e6e6d3855e20244a7d23a',
    'time_request.schema.json': '9a5f6f3600d641ec101ba191e470638ecdbc5693bda44e2cbb30cb9b69064118',
    'time_response.schema.json': '7fd4580176c76fae3be0fa114adf8d55b3351058e2f35a1768dedb87420dc303',
    'trading_times_request.schema.json':
      '37d39686111396918f0529034e9816f45ab734aa3a374082ae8126f8a916b85a',
    'trading_times_response.schema.json':
      '247d5eeb61e3f3619e095d049b14ec24f29895b5bbc2ac9b1c60e6906305f233',
  },
  release: 'production_v20260901_0',
} as const satisfies ExpectedSchemaArchive & { readonly archive_url: string };

/**
 * La entrada de la release que es el esquema de fuente del perfil de medición (`profile.ts`): la que
 * la sesión guarda y `data:health` lee (ADR-0015 §7 y §8).
 */
export const SOURCE_SCHEMA_ENTRY = schemaEntryName('ticks', 'response');
