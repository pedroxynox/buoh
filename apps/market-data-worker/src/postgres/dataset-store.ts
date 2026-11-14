import {
  confirmedPublicationSchema,
  type ConfirmedPublication,
  type DeploymentEnvironment,
  type PublishedManifestRecord,
} from '@buoh/contracts';
import type pg from 'pg';

import type {
  CommitPublicationInput,
  DatasetLogRange,
  DatasetStore,
  PublishedDataset,
} from '../ports.js';
import { PublicationConflictError } from '../errors.js';
import { commitPublicationIn, PostgresMetadataStore } from './metadata-store.js';

interface RangeRow {
  clean: boolean;
  first_segment: number;
  last_segment: number;
  log_number: number;
  open_condition_types: string[];
  pending_continuity_symbols: string[];
}

/**
 * Los rechazos de la fila de rango que son un choque con lo ya publicado: la clave única
 * (`unique_violation`) y la contigüidad o la coherencia de su final (`check_violation`).
 */
const RANGE_CONFLICTS: ReadonlySet<unknown> = new Set(['23505', '23514']);

const RANGE_COLUMNS = `log_number, first_segment, last_segment, clean, open_condition_types,
  pending_continuity_symbols`;

function rangeOf(row: RangeRow): DatasetLogRange {
  return {
    clean: row.clean,
    first_segment: row.first_segment,
    last_segment: row.last_segment,
    log_number: row.log_number,
    open: {
      open_condition_types: row.open_condition_types,
      pending_continuity_symbols: row.pending_continuity_symbols,
    },
  };
}

/**
 * Los metadatos de `buoh_datasets` sobre PostgreSQL (migración `0001_datasets` de su secuencia;
 * ADR-0020 §5 y §9). El pool tiene `buoh_datasets` en su `search_path`. Publica como
 * `PostgresMetadataStore`, y el mismo `COMMIT` inserta la fila de rango del dataset, con la
 * publicación que lo hace visible: la base rechaza un rango que no empieza en el segmento siguiente
 * al último del anterior de su log.
 */
export class PostgresDatasetStore extends PostgresMetadataStore implements DatasetStore {
  readonly #datasetsPool: pg.Pool;

  constructor(pool: pg.Pool) {
    super(pool);
    this.#datasetsPool = pool;
  }

  override async commitPublication(input: CommitPublicationInput): Promise<void> {
    const { logRange, record } = input;
    if (logRange === undefined) {
      throw new TypeError('Un dataset de buoh_datasets necesita su fila de rango.');
    }
    await commitPublicationIn(this.#datasetsPool, input, async (client) => {
      try {
        await client.query(
          `INSERT INTO dataset_log_ranges
             (dataset_id, publication_id, ${RANGE_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[])`,
          [
            record.dataset_id,
            record.publication_id,
            logRange.log_number,
            logRange.first_segment,
            logRange.last_segment,
            logRange.clean,
            logRange.open.open_condition_types,
            logRange.open.pending_continuity_symbols,
          ],
        );
      } catch (error) {
        // Un rango que se solapa, deja un hueco o repite el dataset: choca con lo ya publicado, y
        // repetir no lo cambia (`publication_conflict`).
        if (RANGE_CONFLICTS.has((error as { code?: unknown } | null)?.code)) {
          throw new PublicationConflictError(record.dataset_id, {
            cause: error,
            message: `El rango del dataset ${record.dataset_id} choca con los ya publicados.`,
          });
        }
        throw error;
      }
    });
  }

  async findPublishedDataset(
    datasetId: string,
    environment: DeploymentEnvironment,
  ): Promise<PublishedDataset | null> {
    const record: PublishedManifestRecord | null = await this.findActivePublication(
      datasetId,
      environment,
    );
    if (record === null) {
      return null;
    }
    const { rows } = await this.#datasetsPool.query<RangeRow>(
      `SELECT ${RANGE_COLUMNS} FROM dataset_log_ranges WHERE dataset_id = $1`,
      [datasetId],
    );
    const [row] = rows;
    return { range: row === undefined ? null : rangeOf(row), record };
  }

  async lastConfirmedPublication(
    environment: DeploymentEnvironment,
  ): Promise<ConfirmedPublication | null> {
    const { rows } = await this.#datasetsPool.query<ConfirmedPublication>(
      `SELECT publication_id::text AS publication_id, published_at_utc
         FROM published_manifest_records
        WHERE deployment_environment = $1
        ORDER BY published_at_utc DESC, publication_id DESC
        LIMIT 1`,
      [environment],
    );
    const [row] = rows;
    return row === undefined ? null : confirmedPublicationSchema.parse(row);
  }

  async lastLogRange(logNumber: number): Promise<DatasetLogRange | null> {
    const { rows } = await this.#datasetsPool.query<RangeRow>(
      `SELECT ${RANGE_COLUMNS} FROM dataset_log_ranges
        WHERE log_number = $1 ORDER BY last_segment DESC LIMIT 1`,
      [logNumber],
    );
    const [row] = rows;
    return row === undefined ? null : rangeOf(row);
  }
}
