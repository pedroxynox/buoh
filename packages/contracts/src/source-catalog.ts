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

/**
 * Entrada del catálogo `active_symbols` de Deriv (contratos de dominio, «SourceCatalogSnapshot»;
 * ADR-0012 §7). Conserva los nombres y valores oficiales sin traducirlos. `pip_size` es el lexema
 * decimal recibido, sin exponente: la variación mínima que publica Deriv (por ejemplo `0.01`), no
 * los decimales de `MarketTick`. `trade_count` no entra, porque cambia en cada consulta.
 */
export const derivActiveSymbolEntrySchema = z.strictObject({
  underlying_symbol: symbolSchema,
  underlying_symbol_name: z.string(),
  underlying_symbol_type: z.string(),
  market: z.string(),
  submarket: z.string(),
  subgroup: z.string(),
  pip_size: decimalStringSchema,
  exchange_is_open: z.literal([0, 1]),
  is_trading_suspended: z.literal([0, 1]),
});

/**
 * `SourceCatalogSnapshot` 1.0.0: una versión inmutable del catálogo oficial de una fuente,
 * derivada de un `RawSourceFrame` durable con la respuesta completa. El esquema `…Structural`
 * describe la forma y se publica como JSON Schema; el refinado añade orden, conteo y hashes.
 */
export const sourceCatalogSnapshotStructuralSchema = z
  .strictObject({
    schema_version: z.literal('1.0.0'),
    snapshot_id: derivedEventIdSchema,
    source: nonEmptyStringSchema,
    catalog_format: z.literal('deriv_active_symbols'),
    catalog_normalizer_version: z.literal('1.0.0'),
    connector_version: nonEmptyStringSchema,
    source_schema_release: nonEmptyStringSchema,
    source_schema_sha256: sha256HexSchema,
    observation_id: uuidV7Schema,
    raw_payload_sha256: sha256HexSchema,
    received_at_utc: utcTimestampMsSchema,
    entry_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    content_sha256: sha256HexSchema,
    entries: z.array(derivActiveSymbolEntrySchema).min(1),
  })
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
 * `snapshot_id`: `sha256:` + SHA-256 del JCS del snapshot sin `snapshot_id`. Se construye con los
 * campos del contrato, uno por uno, para que un campo ajeno nunca entre en la identidad.
 */
export function deriveCatalogSnapshotId(
  snapshot: Omit<StructuralSnapshot, 'snapshot_id'>,
): `sha256:${string}` {
  const body: JsonValue = {
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
  };
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
export type SourceCatalogSnapshot = z.infer<typeof sourceCatalogSnapshotSchema>;
