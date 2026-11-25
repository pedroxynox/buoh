import {
  canonicalJson,
  deriveCatalogContentSha256,
  deriveCatalogSnapshotId,
  derivActiveSymbolEntrySchema,
  sha256Hex,
  sourceCatalogSnapshotSchema,
  type DerivActiveSymbolEntry,
  type JsonValue,
  type RawSourceFrame,
  type SourceCatalogSnapshot,
} from '@buoh/contracts';

import { getMember, parseJsonPreservingNumbers, type JsonNode } from './json-lexeme.js';
import {
  checkRequestedResponse,
  type RequestedResponseInvalidReason,
} from './requested-response.js';
import { compileSourceSchema, parseJsonDocument } from './source-schema.js';

/**
 * Esquema de respuesta de `active_symbols` con que se valida el catálogo, con su identidad: el de la
 * release fijada sin exigir `underlying_symbol_type` (`relaxCatalogResponseSchema`). El SHA-256 del
 * JCS de ese documento es el `source_schema_sha256` del snapshot.
 */
export interface CatalogResponseSchema {
  readonly release: string;
  readonly sha256: string;
  readonly validate: (value: unknown) => boolean;
}

/**
 * Campos de cada entrada que la release fijada exige y Deriv ya no manda. Desde el 2026-11-24, entre
 * las 13:18 y las 14:12 UTC, `active_symbols` llega sin `underlying_symbol_type`, aunque el esquema
 * publicado de `production_v20260901_0`, y el de las releases posteriores hasta la
 * `production_v20261119_0`, lo siguen exigiendo (ADR-0012 §2 y §7).
 */
export const CATALOG_FIELDS_NO_LONGER_SENT = ['underlying_symbol_type'] as const;

/**
 * El documento de esquema con `CATALOG_FIELDS_NO_LONGER_SENT` fuera de la lista `required` de cada
 * entrada (`properties.active_symbols.items.required`). No cambia nada más: el campo sigue descrito,
 * así que si llega tiene que ser texto, y una entrada sigue sin admitir campos ajenos. Sin esa ruta,
 * o sin esos campos en ella, el documento queda igual. No modifica el documento recibido.
 */
export function relaxCatalogResponseSchema(document: JsonValue): JsonValue {
  const items = memberOf(memberOf(memberOf(document, 'properties'), 'active_symbols'), 'items');
  const required = memberOf(items, 'required');
  if (
    items === undefined ||
    !Array.isArray(required) ||
    !required.some((field) => (CATALOG_FIELDS_NO_LONGER_SENT as readonly unknown[]).includes(field))
  ) {
    return document;
  }
  const relaxed = structuredClone(document) as Record<string, JsonValue>;
  const relaxedItems = memberOf(
    memberOf(memberOf(relaxed, 'properties'), 'active_symbols'),
    'items',
  ) as Record<string, JsonValue>;
  relaxedItems['required'] = required.filter(
    (field) => !(CATALOG_FIELDS_NO_LONGER_SENT as readonly unknown[]).includes(field),
  );
  return relaxed;
}

function memberOf(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;
}

export function createCatalogResponseSchema(input: {
  readonly source_schema_bytes: Uint8Array;
  readonly source_schema_release: string;
}): CatalogResponseSchema {
  if (input.source_schema_release.length === 0) {
    throw new TypeError('source_schema_release es obligatorio.');
  }
  const document = relaxCatalogResponseSchema(
    parseJsonDocument(input.source_schema_bytes, 'El esquema de catálogo'),
  );
  return {
    release: input.source_schema_release,
    sha256: sha256Hex(canonicalJson(document)),
    validate: compileSourceSchema(document),
  };
}

export type CatalogConversionResult =
  | { readonly ok: true; readonly snapshot: SourceCatalogSnapshot }
  | { readonly ok: false; readonly reason: RequestedResponseInvalidReason };

const TEXT_FIELDS = [
  'underlying_symbol',
  'underlying_symbol_name',
  'market',
  'submarket',
  'subgroup',
] as const;
const FLAG_FIELDS = ['exchange_is_open', 'is_trading_suspended'] as const;

/**
 * Proyecta los ocho campos del contrato 2.0.0 desde el árbol que conserva los lexemas: los textos
 * tal cual, `pip_size` como el lexema recibido y los indicadores como número. `trade_count`,
 * `underlying_symbol_type`, aunque llegue, y cualquier otro campo quedan fuera. `null` si la entrada
 * no cumple el contrato.
 */
function projectEntry(node: JsonNode): DerivActiveSymbolEntry | null {
  if (node.type !== 'object') {
    return null;
  }
  const candidate: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const value = node.entries.get(field);
    candidate[field] = value?.type === 'string' ? value.value : undefined;
  }
  const pipSize = node.entries.get('pip_size');
  candidate['pip_size'] = pipSize?.type === 'number' ? pipSize.lexeme : undefined;
  for (const field of FLAG_FIELDS) {
    const value = node.entries.get(field);
    candidate[field] = value?.type === 'number' ? Number(value.lexeme) : undefined;
  }
  const parsed = derivActiveSymbolEntrySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Convierte un frame durable de respuesta a `active_symbols` en un `SourceCatalogSnapshot` 2.0.0,
 * con el normalizador de catálogo 2.0.0 (contratos de dominio, «SourceCatalogSnapshot»; ADR-0012
 * §7). Es pura: el mismo frame y el mismo esquema dan siempre el mismo resultado, así que el
 * snapshot y la incidencia se pueden volver a derivar del frame.
 *
 * Las comprobaciones van en el orden del contrato, y la primera que falla da el motivo. El frame
 * tiene que ser JSON, porque quien lo correlacionó ya lo leyó con el mismo lector; si no lo es, es un
 * error del llamador y se lanza.
 */
export function deriveCatalogSnapshot(
  frame: RawSourceFrame,
  schema: CatalogResponseSchema,
): CatalogConversionResult {
  let root: JsonNode;
  try {
    root = parseJsonPreservingNumbers(frame.payload_utf8);
  } catch (error) {
    throw new TypeError(
      `El frame ${frame.observation_id} no es JSON; solo se convierten respuestas ya correlacionadas.`,
      { cause: error },
    );
  }

  // 1 y 2: un objeto `error`, y después el esquema fijado.
  const common = checkRequestedResponse(root, schema.validate);
  if (common !== null) {
    return { ok: false, reason: common };
  }

  // 3: la lista falta, no es una lista o está vacía.
  const list = getMember(root, 'active_symbols');
  if (list?.type !== 'array' || list.items.length === 0) {
    return { ok: false, reason: 'catalog_empty' };
  }

  // 4: un `pip_size` con exponente. Va antes que el contrato de la entrada, que también rechazaría
  // el exponente, para que el motivo sea el preciso.
  if (
    list.items.some((item) => {
      const pipSize = getMember(item, 'pip_size');
      return pipSize?.type === 'number' && /[eE]/u.test(pipSize.lexeme);
    })
  ) {
    return { ok: false, reason: 'catalog_exponent_not_supported' };
  }

  // 5: cada entrada cumple el contrato del snapshot.
  const entries: DerivActiveSymbolEntry[] = [];
  for (const item of list.items) {
    const entry = projectEntry(item);
    if (entry === null) {
      return { ok: false, reason: 'catalog_entry_invalid' };
    }
    entries.push(entry);
  }

  // 6: ningún código se repite.
  if (new Set(entries.map((entry) => entry.underlying_symbol)).size !== entries.length) {
    return { ok: false, reason: 'catalog_duplicate_symbol' };
  }

  // Orden por unidades UTF-16: el mismo `<` de `isSortedUnique`, que valida el contrato. Los
  // códigos ya son únicos, así que nunca hay empate.
  entries.sort((left, right) => (left.underlying_symbol < right.underlying_symbol ? -1 : 1));

  const body = {
    catalog_format: 'deriv_active_symbols' as const,
    catalog_normalizer_version: '2.0.0' as const,
    connector_version: frame.connector_version,
    content_sha256: deriveCatalogContentSha256(entries),
    entries,
    entry_count: entries.length,
    observation_id: frame.observation_id,
    raw_payload_sha256: frame.raw_payload_sha256,
    received_at_utc: frame.received_at_utc,
    schema_version: '2.0.0' as const,
    source: frame.source,
    source_schema_release: schema.release,
    source_schema_sha256: schema.sha256,
  };
  return {
    ok: true,
    snapshot: sourceCatalogSnapshotSchema.parse({
      ...body,
      snapshot_id: deriveCatalogSnapshotId(body),
    }),
  };
}
