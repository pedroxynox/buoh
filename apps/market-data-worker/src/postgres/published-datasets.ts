import {
  conditionTypeSchema,
  datasetManifestCoreSchema,
  deriveDatasetId,
  isSortedUnique,
  qualityIncidentTypeSchema,
  severitySchema,
  symbolSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
  type DatasetManifestCore,
  type DeploymentEnvironment,
} from '@buoh/contracts';
import pg, { type Pool } from 'pg';
import type { z } from 'zod';

import { DATASETS_SCHEMA } from '../datasets/location.js';
import { MAX_LOG_NUMBER } from '../successive-logs.js';

// Los datasets publicados para la sección Datos (ADR-0020 §10): de `buoh_datasets`, cada dataset por
// su publicación activa, con su `DatasetManifestCore`, su rango de `dataset_log_ranges`, sus
// incidencias por tipo y gravedad y la última verificación de cada modo. Lo escriben la publicación
// y `buoh-operaciones`; aquí solo se lee, con el esquema en cada tabla, para un pool cuyas sesiones
// no lo tienen en el `search_path`, como el de la API. No lee R2.

/** El último resultado de la verificación de un dataset en un modo (`dataset_verifications`). */
export interface StoredDatasetVerification {
  readonly status: 'failed' | 'incomplete' | 'passed';
  readonly verified_at_utc: string;
  readonly error_code: string | null;
}

/** Cuántas incidencias de un tipo y una gravedad tiene el dataset (`dataset_quality_incidents`). */
export interface StoredDatasetIncidentCount {
  readonly incident_type: z.infer<typeof qualityIncidentTypeSchema>;
  readonly severity: z.infer<typeof severitySchema>;
  readonly count: number;
}

/** Un dataset publicado, por su publicación activa. */
export interface StoredPublishedDataset {
  readonly dataset_id: string;
  readonly publication_id: string;
  readonly published_at_utc: string;
  readonly core: DatasetManifestCore;
  readonly log: number;
  readonly first_segment: number;
  readonly last_segment: number;
  readonly clean: boolean;
  readonly pending_continuity_symbols: readonly string[];
  readonly open_condition_types: readonly z.infer<typeof conditionTypeSchema>[];
  readonly incidents: readonly StoredDatasetIncidentCount[];
  readonly verifications: {
    readonly verify_only: StoredDatasetVerification | null;
    readonly recompute: StoredDatasetVerification | null;
  };
}

export interface ReadPublishedDatasetsInput {
  readonly source: string;
  /** Solo los publicados en este entorno (`published_manifest_records.deployment_environment`). */
  readonly environment: DeploymentEnvironment;
  /** Cuántos lee como mucho: los publicados más recientemente. */
  readonly limit: number;
}

/**
 * Una fila de un dataset publicado que no pasa sus comprobaciones: un `manifest_core` que no es JSON,
 * que no cumple su contrato, un identificador que no es el SHA-256 del JCS de su núcleo, otra
 * fuente, un dataset activo sin su fila de rango, un rango, una incidencia o una verificación que no
 * tienen sus formatos, unos símbolos pendientes o unos tipos de condición abiertos sin orden o
 * repetidos, o unas incidencias que no suman el `incident_count` de su núcleo. No repite nada de su
 * contenido.
 */
export class DatasetIntegrityError extends TypeError {
  constructor() {
    super('Un dataset publicado no pasa sus comprobaciones.');
    this.name = 'DatasetIntegrityError';
  }
}

function check(condition: boolean): void {
  if (!condition) {
    throw new DatasetIntegrityError();
  }
}

/** Una tabla que no existe: con el nombre del esquema, también si es el esquema el que falta. */
const UNDEFINED_TABLE = '42P01';

// Las columnas del rango son null en un dataset sin su fila de `dataset_log_ranges` (LEFT JOIN).
interface DatasetRow {
  publication_id: string;
  published_at_utc: string;
  dataset_id: string;
  source: string;
  manifest_core_jcs: string;
  log_number: number | null;
  first_segment: number | null;
  last_segment: number | null;
  clean: boolean | null;
  pending_continuity_symbols: string[] | null;
  open_condition_types: string[] | null;
}

interface IncidentRow {
  dataset_id: string;
  incident_type: string;
  severity: string;
  count: number;
}

interface VerificationRow {
  publication_id: string;
  mode: string;
  status: string;
  error_code: string | null;
  verified_at_utc: string;
}

const isSegment = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isLogNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LOG_NUMBER;

/** El log y los segmentos de un dataset, y cómo terminó (`dataset_log_ranges`). */
type StoredDatasetRange = Pick<
  StoredPublishedDataset,
  | 'clean'
  | 'first_segment'
  | 'last_segment'
  | 'log'
  | 'open_condition_types'
  | 'pending_continuity_symbols'
>;

/**
 * El rango del dataset, comprobado: su log y sus segmentos, y lo que dejó abierto, en orden y sin
 * repetir, como lo escribe la publicación y lo pide el contrato. Un dataset activo sin su fila de
 * rango, que la publicación inserta en el mismo `COMMIT` que lo hace visible, llega con esas columnas
 * en null y no pasa: es un error de programación (ADR-0020 §9), y la lista no lo omite en silencio.
 */
function rangeOf(row: DatasetRow): StoredDatasetRange {
  const { clean, first_segment: first, last_segment: last, log_number: log } = row;
  const pending = row.pending_continuity_symbols;
  const open = row.open_condition_types;
  if (
    !isLogNumber(log) ||
    !isSegment(first) ||
    !isSegment(last) ||
    last < first ||
    typeof clean !== 'boolean' ||
    !Array.isArray(pending) ||
    !pending.every((symbol) => symbolSchema.safeParse(symbol).success) ||
    !isSortedUnique(pending) ||
    !Array.isArray(open) ||
    !open.every((type) => conditionTypeSchema.safeParse(type).success) ||
    !isSortedUnique(open)
  ) {
    throw new DatasetIntegrityError();
  }
  return {
    clean,
    first_segment: first,
    last_segment: last,
    log,
    open_condition_types: open as StoredPublishedDataset['open_condition_types'],
    pending_continuity_symbols: pending,
  };
}

/**
 * El núcleo del manifiesto, validado con su contrato y con su identificador, el SHA-256 de su JCS: el
 * mismo contenido que la base guardó para ese dataset, que comprueba que `dataset_id` es el SHA-256 de
 * `manifest_core_jcs`. Un texto que no está en JCS da otro identificador, así que no pasa.
 */
function coreOf(row: DatasetRow): DatasetManifestCore {
  let stored: unknown;
  try {
    stored = JSON.parse(row.manifest_core_jcs);
  } catch {
    throw new DatasetIntegrityError();
  }
  const parsed = datasetManifestCoreSchema.safeParse(stored);
  check(
    parsed.success &&
      deriveDatasetId(parsed.data) === row.dataset_id &&
      parsed.data.source === row.source,
  );
  return (parsed as { data: DatasetManifestCore }).data;
}

function verificationOf(row: VerificationRow): StoredDatasetVerification {
  check(
    (row.status === 'passed' || row.status === 'failed' || row.status === 'incomplete') &&
      utcTimestampMsSchema.safeParse(row.verified_at_utc).success &&
      (row.error_code === null || /^[A-Z][A-Z0-9_]{0,62}$/u.test(row.error_code)),
  );
  return {
    error_code: row.error_code,
    status: row.status as StoredDatasetVerification['status'],
    verified_at_utc: row.verified_at_utc,
  };
}

/**
 * Lo que falta por qué: sin el esquema `buoh_datasets`, que crea `buoh-operaciones` antes de la
 * primera publicación, `true`; con él, el error es otro, y se propaga.
 */
async function schemaMissing(pool: Pick<Pool, 'query'>, error: unknown): Promise<boolean> {
  if ((error as { code?: unknown } | null)?.code !== UNDEFINED_TABLE) {
    return false;
  }
  const { rows } = await pool.query<{ missing: boolean }>(
    'SELECT to_regnamespace($1) IS NULL AS missing',
    [DATASETS_SCHEMA],
  );
  return rows[0]?.missing === true;
}

/**
 * Los datasets publicados (ADR-0020 §10): los `limit` de `source` en `environment` con la publicación
 * activa más reciente, de la más nueva a la más vieja, cada uno con su núcleo, su rango, sus
 * incidencias por tipo y gravedad, en orden, y la última verificación de cada modo de esa
 * publicación (por `verification_id`, un UUIDv7), o `null` si no tiene. Sin el esquema
 * `buoh_datasets`, ninguno; con el esquema, un fallo al leerlo, como sin privilegios (`42501`) o sin
 * una de sus tablas, rechaza con el error de PostgreSQL. Lanza `DatasetIntegrityError` si una fila no
 * pasa sus comprobaciones, también si a un dataset activo le falta su rango, que no se omite. No
 * escribe nada.
 */
export async function readPublishedDatasets(
  pool: Pick<Pool, 'query'>,
  input: ReadPublishedDatasetsInput,
): Promise<StoredPublishedDataset[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new TypeError('El límite de datasets es un entero positivo.');
  }
  const schema = pg.escapeIdentifier(DATASETS_SCHEMA);
  let datasets: DatasetRow[];
  let incidents: IncidentRow[];
  let verifications: VerificationRow[];
  try {
    ({ rows: datasets } = await pool.query<DatasetRow>(
      `SELECT r.publication_id::text AS publication_id, r.published_at_utc, d.dataset_id, d.source,
              d.manifest_core_jcs, g.log_number, g.first_segment, g.last_segment, g.clean,
              g.pending_continuity_symbols, g.open_condition_types
         FROM ${schema}.published_manifest_records r
         JOIN ${schema}.datasets d USING (dataset_id)
         LEFT JOIN ${schema}.dataset_log_ranges g USING (dataset_id)
        WHERE d.source = $1 AND r.deployment_environment = $2 AND r.state = 'active'
        ORDER BY r.published_at_utc DESC, r.publication_id DESC
        LIMIT $3`,
      [input.source, input.environment, input.limit],
    ));
    const ids = datasets.map((row) => row.dataset_id);
    const publications = datasets.map((row) => row.publication_id);
    ({ rows: incidents } = await pool.query<IncidentRow>(
      `SELECT dataset_id, incident_type, severity, count(*)::int AS count
         FROM ${schema}.dataset_quality_incidents
        WHERE dataset_id = ANY($1::text[])
        GROUP BY dataset_id, incident_type, severity`,
      [ids],
    ));
    ({ rows: verifications } = await pool.query<VerificationRow>(
      `SELECT DISTINCT ON (publication_id, mode)
              publication_id::text AS publication_id, mode, status, error_code, verified_at_utc
         FROM ${schema}.dataset_verifications
        WHERE publication_id = ANY($1::uuid[])
        ORDER BY publication_id, mode, verification_id DESC`,
      [publications],
    ));
  } catch (error) {
    if (await schemaMissing(pool, error)) {
      return [];
    }
    throw error;
  }
  return datasets.map((row) => {
    check(
      uuidV7Schema.safeParse(row.publication_id).success &&
        utcTimestampMsSchema.safeParse(row.published_at_utc).success,
    );
    const range = rangeOf(row);
    const core = coreOf(row);
    const own = incidents
      .filter((item) => item.dataset_id === row.dataset_id)
      .map((item): StoredDatasetIncidentCount => {
        const type = qualityIncidentTypeSchema.safeParse(item.incident_type);
        const severity = severitySchema.safeParse(item.severity);
        if (!type.success || !severity.success || !Number.isSafeInteger(item.count)) {
          throw new DatasetIntegrityError();
        }
        return { count: item.count, incident_type: type.data, severity: severity.data };
      })
      // Por tipo y gravedad, en el orden de las unidades UTF-16, como el contrato: el de la base
      // depende de su intercalación.
      .sort((a, b) => {
        const left = `${a.incident_type} ${a.severity}`;
        const right = `${b.incident_type} ${b.severity}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    // Las incidencias de su núcleo, ni una más ni una menos: los grupos suman su `incident_count`.
    check(own.reduce((sum, item) => sum + item.count, 0) === core.incident_count);
    const latest = (mode: string) => {
      const found = verifications.find(
        (item) => item.publication_id === row.publication_id && item.mode === mode,
      );
      return found === undefined ? null : verificationOf(found);
    };
    return {
      clean: range.clean,
      core,
      dataset_id: row.dataset_id,
      first_segment: range.first_segment,
      incidents: own,
      last_segment: range.last_segment,
      log: range.log,
      open_condition_types: range.open_condition_types,
      pending_continuity_symbols: range.pending_continuity_symbols,
      publication_id: row.publication_id,
      published_at_utc: row.published_at_utc,
      verifications: { recompute: latest('recompute'), verify_only: latest('verify-only') },
    };
  });
}
