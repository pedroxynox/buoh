import {
  canonicalJson,
  sha256Hex,
  sourceCatalogSnapshotSchema,
  type SourceCatalogSnapshot,
} from '@buoh/contracts';
import { utf8 } from '@buoh/domain';
import { type Pool } from 'pg';

import { type CatalogStore, type CatalogVersion } from '../deriv/ports.js';
import { contentKey } from '../object-keys.js';
import { type ObjectStore } from '../ports.js';
import { writeVerified } from '../source-log/source-event-log.js';

interface VersionRow {
  content_sha256: string;
  document_byte_length: number;
  document_sha256: string;
  snapshot_id: string;
  version: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Versiones del catálogo sobre PostgreSQL y almacenamiento de objetos (migración
 * `0003_catalogo_y_respuestas_pedidas`; ADR-0012 §7). El índice `source_catalog_versions` asigna
 * versiones contiguas desde 1 por fuente y formato, y su trigger rechaza una versión que no cambie
 * el contenido. El documento JCS del snapshot va primero al almacenamiento, con clave por contenido
 * y releído; si después falla el índice, solo queda un objeto huérfano sin referencias.
 */
export class PostgresCatalogStore implements CatalogStore {
  readonly #objects: ObjectStore;
  readonly #pool: Pool;

  constructor(pool: Pool, objects: ObjectStore) {
    this.#objects = objects;
    this.#pool = pool;
  }

  async #last(source: string, catalogFormat: string): Promise<VersionRow | null> {
    const { rows } = await this.#pool.query<VersionRow>(
      `SELECT version, snapshot_id, content_sha256, document_sha256, document_byte_length
         FROM source_catalog_versions
        WHERE source = $1 AND catalog_format = $2
        ORDER BY version DESC
        LIMIT 1`,
      [source, catalogFormat],
    );
    return rows[0] ?? null;
  }

  /** Última versión, releída del almacenamiento y comprobada contra su fila del índice. */
  async latest(
    source: string,
    catalogFormat: SourceCatalogSnapshot['catalog_format'],
  ): Promise<CatalogVersion | null> {
    const row = await this.#last(source, catalogFormat);
    if (row === null) {
      return null;
    }
    const bytes = await this.#objects.get(
      contentKey(row.document_sha256),
      row.document_byte_length,
    );
    if (bytes.byteLength !== row.document_byte_length || sha256Hex(bytes) !== row.document_sha256) {
      throw new TypeError(
        `El documento de la versión ${String(row.version)} del catálogo de ${source} no coincide con su hash.`,
      );
    }
    const text = decoder.decode(bytes);
    const snapshot = sourceCatalogSnapshotSchema.parse(JSON.parse(text));
    if (
      canonicalJson(snapshot) !== text ||
      snapshot.snapshot_id !== row.snapshot_id ||
      snapshot.content_sha256 !== row.content_sha256 ||
      snapshot.source !== source
    ) {
      throw new TypeError(
        `El documento de la versión ${String(row.version)} del catálogo de ${source} no corresponde a su índice.`,
      );
    }
    return { snapshot, version: row.version };
  }

  async record(input: SourceCatalogSnapshot): Promise<{
    readonly status: 'created' | 'unchanged';
    readonly version: number;
  }> {
    const snapshot = sourceCatalogSnapshotSchema.parse(input);
    const last = await this.#last(snapshot.source, snapshot.catalog_format);
    if (last !== null && last.content_sha256 === snapshot.content_sha256) {
      return { status: 'unchanged', version: last.version };
    }
    const document = utf8(canonicalJson(snapshot));
    const digest = sha256Hex(document);
    await writeVerified(this.#objects, contentKey(digest), document, 'application/json');
    const version = (last?.version ?? 0) + 1;
    await this.#pool.query(
      `INSERT INTO source_catalog_versions
         (source, catalog_format, version, snapshot_id, content_sha256, entry_count,
          observation_id, received_at_utc, document_sha256, document_byte_length)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        snapshot.source,
        snapshot.catalog_format,
        version,
        snapshot.snapshot_id,
        snapshot.content_sha256,
        snapshot.entry_count,
        snapshot.observation_id,
        snapshot.received_at_utc,
        digest,
        document.byteLength,
      ],
    );
    return { status: 'created', version };
  }
}
