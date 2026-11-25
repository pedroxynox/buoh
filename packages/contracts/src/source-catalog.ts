import { z } from 'zod';

import { canonicalSequence, deriveEventId, sha256Hex, type JsonValue } from './identity.js';
import {
  decimalStringSchema,
  derivedEventIdSchema,
  isSortedUnique,
  nonEmptyStringSchema,
  sha256HexSchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

const entryFields = {
  underlying_symbol: symbolSchema,
  underlying_symbol_name: z.string(),
  market: z.string(),
  submarket: z.string(),
  subgroup: z.string(),
  pip_size: decimalStringSchema,
  exchange_is_open: z.literal([0, 1]),
  is_trading_suspended: z.literal([0, 1]),
};

/**
 * Entrada del catálogo `active_symbols` de Deriv en `SourceCatalogSnapshot` 2.0.0 (contratos de
 * dominio, «SourceCatalogSnapshot»; ADR-0012 §7). Conserva los nombres y valores oficiales sin
 * traducirlos. `pip_size` es el lexema decimal recibido, sin exponente: la variación mínima que
 * publica Deriv (por ejemplo `0.01`), no los decimales de `MarketTick`. `trade_count` no entra,
 * porque cambia en cada consulta, y `underlying_symbol_type` tampoco: Deriv dejó de mandarlo el
 * 2026-11-24, aunque su esquema publicado lo sigue exigiendo.
 */
export const derivActiveSymbolEntrySchema = z.strictObject(entryFields);

/** Entrada de `SourceCatalogSnapshot` 1.0.0, con `underlying_symbol_type`: la de los ya guardados. */
export const derivActiveSymbolEntryV1Schema = z.strictObject({
  ...entryFields,
  underlying_symbol_type: z.string(),
});

const snapshotFields = {
  snapshot_id: derivedEventIdSchema,
  source: nonEmptyStringSchema,
  catalog_format: z.literal('deriv_active_symbols'),
  connector_version: nonEmptyStringSchema,
  source_schema_release: nonEmptyStringSchema,
  source_schema_sha256: sha256HexSchema,
  observation_id: uuidV7Schema,
  raw_payload_sha256: sha256HexSchema,
  received_at_utc: utcTimestampMsSchema,
  entry_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  content_sha256: sha256HexSchema,
};

/**
 * `SourceCatalogSnapshot`: una versión inmutable del catálogo oficial de una fuente, derivada de un
 * `RawSourceFrame` durable con la respuesta completa. La 2.0.0 es la que deriva buoh desde la
 * precisión del 2026-11-25 de ADR-0012 §7, sin `underlying_symbol_type`; la 1.0.0, con él, sigue teniendo lector, porque los logs
 * guardan sus documentos hasta que vencen. El esquema `…Structural` describe la forma y se publica
 * como JSON Schema; el refinado añade orden, conteo y hashes.
 */
export const sourceCatalogSnapshotStructuralSchema = z
  .discriminatedUnion('schema_version', [
    z.strictObject({
      schema_version: z.literal('2.0.0'),
      ...snapshotFields,
      catalog_normalizer_version: z.literal('2.0.0'),
      entries: z.array(derivActiveSymbolEntrySchema).min(1),
    }),
    z.strictObject({
      schema_version: z.literal('1.0.0'),
      ...snapshotFields,
      catalog_normalizer_version: z.literal('1.0.0'),
      entries: z.array(derivActiveSymbolEntryV1Schema).min(1),
    }),
  ])
  .meta({ id: 'SourceCatalogSnapshot', title: 'SourceCatalogSnapshot' });

type StructuralSnapshot = z.infer<typeof sourceCatalogSnapshotStructuralSchema>;

/**
 * Hash de secuencia de las entradas (JCS por línea, unidas por `\n`, con newline final). Solo
 * depende del contenido del catálogo, no de cuándo ni por qué conexión llegó: es la clave que decide
 * si un snapshot nuevo es otra versión.
 */
export function deriveCatalogContentSha256(entries: StructuralSnapshot['entries']): string {
  return sha256Hex(canonicalSequence(entries));
}

/**
 * `snapshot_id`: `sha256:` + SHA-256 del JCS del snapshot sin `snapshot_id`. El cuerpo se arma con
 * los campos del contrato, uno por uno, así que un campo ajeno de primer nivel no entra en la
 * identidad, y `satisfies` obliga a añadir aquí todo campo nuevo del esquema. Las entradas entran
 * tal como llegan: quien llame directamente a esta función debe pasar entradas ya validadas.
 */
export function deriveCatalogSnapshotId(
  snapshot: Omit<StructuralSnapshot, 'snapshot_id'>,
): `sha256:${string}` {
  const body = {
    catalog_format: snapshot.catalog_format,
    catalog_normalizer_version: snapshot.catalog_normalizer_version,
    connector_version: snapshot.connector_version,
    content_sha256: snapshot.content_sha256,
    entries: snapshot.entries,
    entry_count: snapshot.entry_count,
    observation_id: snapshot.observation_id,
    raw_payload_sha256: snapshot.raw_payload_sha256,
    received_at_utc: snapshot.received_at_utc,
    schema_version: snapshot.schema_version,
    source: snapshot.source,
    source_schema_release: snapshot.source_schema_release,
    source_schema_sha256: snapshot.source_schema_sha256,
  } satisfies Record<Exclude<keyof StructuralSnapshot, 'snapshot_id'>, JsonValue>;
  return deriveEventId(body);
}

export const sourceCatalogSnapshotSchema = sourceCatalogSnapshotStructuralSchema.superRefine(
  (value, context) => {
    if (!isSortedUnique(value.entries.map((entry) => entry.underlying_symbol))) {
      context.addIssue({
        code: 'custom',
        message: 'entries debe ir ordenada por underlying_symbol, sin códigos repetidos.',
        path: ['entries'],
      });
    }

    if (value.entry_count !== value.entries.length) {
      context.addIssue({
        code: 'custom',
        message: 'entry_count debe ser el número de entradas.',
        path: ['entry_count'],
      });
    }

    if (deriveCatalogContentSha256(value.entries) !== value.content_sha256) {
      context.addIssue({
        code: 'custom',
        message: 'content_sha256 no corresponde a las entradas.',
        path: ['content_sha256'],
      });
    }

    if (deriveCatalogSnapshotId(value) !== value.snapshot_id) {
      context.addIssue({
        code: 'custom',
        message: 'snapshot_id no corresponde a la identidad canónica del snapshot.',
        path: ['snapshot_id'],
      });
    }
  },
);

export type DerivActiveSymbolEntry = z.infer<typeof derivActiveSymbolEntrySchema>;
export type DerivActiveSymbolEntryV1 = z.infer<typeof derivActiveSymbolEntryV1Schema>;
export type SourceCatalogSnapshot = z.infer<typeof sourceCatalogSnapshotSchema>;
