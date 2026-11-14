import { canonicalJson, type JsonValue } from '@buoh/contracts';
import pg, { type PoolClient } from 'pg';

import { stderrAlert, type OperationalAlert } from '../operational/registry.js';
import { createPool, postgresSslOption } from '../postgres/metadata-store.js';
import {
  ensureApiReaderRole,
  ensureApiRole,
  ensurePublicationRole,
  ensureRuntimeRoles,
  grantApiPrivileges,
  grantDatasetsPrivileges,
  grantLogPrivileges,
  POSTGRES_ROLES,
  setRolePassword,
  type PasswordRole,
} from '../postgres/roles.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  isLogExpired,
  listCaptureLogs,
  logNumberOf,
  readCaptureLog,
  type CaptureLog,
  type LogLocation,
} from '../successive-logs.js';
import { DATASETS_SCHEMA } from '../datasets/location.js';
import type { LogQualityProfileRow } from '../deriv/log-profile.js';
import type { ReplayMode } from '../replay.js';
import type { OperationsConfig } from './config.js';
import { VERIFICATION_SLOTS, type DueSegment } from './verification.js';

/** Contraseña rechazada (`invalid_password`): el rol no puede iniciar sesión con ella. */
const INVALID_PASSWORD = '28P01';
/**
 * Sin conexiones libres (`too_many_connections`): las del rol, como las 4 de `buoh_agente`, las de
 * la base o las del servidor. PostgreSQL comprueba las del rol después de aceptar la contraseña, y
 * las del servidor antes, así que este código no dice si la contraseña vale.
 */
const TOO_MANY_CONNECTIONS = '53300';

/**
 * Lo que dijo PostgreSQL de la contraseña de un rol: la aceptó, la rechazó (`28P01`) o no se pudo
 * comprobar porque no había conexiones libres (`53300`).
 */
export type LoginCheck = 'accepted' | 'rejected' | 'unchecked';

/** El plazo de cada conexión del servicio a PostgreSQL. */
export const OPERATIONS_CONNECTION_TIMEOUT_MS = 5_000;
/** El plazo de cada consulta del servicio. */
export const OPERATIONS_QUERY_TIMEOUT_MS = 30_000;
/**
 * El plazo para tomar los bloqueos de las tablas de un log al borrar su esquema (`lock_timeout`): si
 * alguien las está leyendo, como un `data:health` o el agente, el borrado falla con `55P03` y se
 * intenta otra vez en la ejecución siguiente, en lugar de dejar en espera a quien llegue después.
 */
export const DROP_LOG_LOCK_TIMEOUT_MS = 5_000;

/**
 * Lo que pasó al borrar el esquema de un log vencido: `dropped`; `not_expired`, si al mirarlo otra
 * vez tiene una escritura de hace menos de 30 días, y no se borra nada; o `absent`, si su esquema ya
 * no existe.
 */
export type LogSchemaDrop = 'absent' | 'dropped' | 'not_expired';

/** El espacio de la base y el de cada log, en bytes, en orden de log. */
export interface SpaceMeasure {
  readonly database_bytes: number;
  readonly logs: readonly { readonly bytes: number; readonly log: number }[];
}

/** Un informe de un paso de `buoh-operaciones`, como lo guarda `operations_reports` (`0006`). */
export interface OperationsReportRow {
  readonly observed_at_utc: string;
  /** El informe, sin precios ni payloads: se guarda en JCS. */
  readonly report: Readonly<Record<string, JsonValue>>;
  readonly report_id: string;
  readonly run_id: string;
  readonly status: 'completed' | 'failed';
  readonly step: string;
}

/** La fila de `log_quality_profile` que inserta `buoh-operaciones`, con su ejecución y su hora. */
export interface LogProfileAssignment extends LogQualityProfileRow {
  readonly assigned_at_utc: string;
  readonly run_id: string;
}

/** Un informe guardado de un paso, el más reciente: su ID (UUIDv7), cómo terminó y su contenido. */
export interface StoredReport {
  readonly report: JsonValue;
  readonly report_id: string;
  readonly status: 'completed' | 'failed';
}

/**
 * La publicación activa de `production` que toca verificar (ADR-0020 §8, paso 7), con los modos que
 * ya tienen un resultado en `dataset_verifications`.
 */
export interface PublicationToVerify {
  readonly dataset_id: string;
  readonly modes_done: readonly ReplayMode[];
  readonly publication_id: string;
}

/** Una fila de `buoh_datasets.dataset_verifications` (ADR-0020 §8, paso 7). */
export interface DatasetVerificationRow {
  readonly dataset_id: string;
  readonly error_code: string | null;
  readonly exit_code: number | null;
  readonly mode: ReplayMode;
  readonly publication_id: string;
  /** El informe saneado de `data:replay`, sin precios: se guarda en JCS. */
  readonly report: Readonly<Record<string, JsonValue>> | null;
  readonly run_id: string;
  readonly status: 'failed' | 'incomplete' | 'passed';
  readonly verification_id: string;
  readonly verified_at_utc: string;
}

/**
 * Lo que hace `buoh-operaciones` con la credencial dueña (ADR-0018 §8 y §11). Las lecturas de los
 * logs y las escrituras van como `buoh_dueno` (`SET ROLE`), el dueño de los esquemas: así no
 * dependen de que el usuario de Render herede sus privilegios.
 */
export interface OwnerDatabase {
  /** Crea los roles que falten y fija sus atributos (`ensureRuntimeRoles`). */
  ensureRuntimeRoles(): Promise<void>;
  /** Los logs que existen, con su última escritura (`listCaptureLogs`). */
  listLogs(): Promise<CaptureLog[]>;
  /** Da a los roles de ejecución sus privilegios en el esquema del log (`grantLogPrivileges`). */
  grantLogPrivileges(log: LogLocation): Promise<void>;
  /** Crea el esquema del log como `buoh_dueno`, si no existe. */
  createLogSchema(log: LogLocation): Promise<void>;
  /**
   * Da su perfil al log (ADR-0020 §4): como `buoh_dueno`, inserta la fila de `log_quality_profile`
   * solo si el log no tiene ninguna, no tiene escrituras (ni source events ni latidos) y
   * `buoh_ingesta` todavía no tiene el uso de su esquema, en una sola sentencia. `true` si la
   * insertó. Necesita la migración 0007 del log.
   */
  assignLogProfile(log: LogLocation, row: LogProfileAssignment): Promise<boolean>;
  /** Crea el rol `buoh_api` o le vuelve a fijar sus atributos (`ensureApiRole`, ADR-0019 §7). */
  ensureApiRole(): Promise<void>;
  /** Da a `buoh_api` sus privilegios en el esquema de la API (`grantApiPrivileges`). */
  grantApiPrivileges(): Promise<void>;
  /**
   * Crea el rol `buoh_api_lectura`, miembro de `buoh_lectura`, o le vuelve a fijar sus atributos
   * (`ensureApiReaderRole`, ADR-0019 §7 y §8).
   */
  ensureApiReaderRole(): Promise<void>;
  /**
   * Crea el rol `buoh_publicacion`, miembro de `buoh_lectura`, o le vuelve a fijar sus atributos
   * (`ensurePublicationRole`, ADR-0020 §5).
   */
  ensurePublicationRole(): Promise<void>;
  /** Da sus privilegios en `buoh_datasets` (`grantDatasetsPrivileges`, ADR-0020 §5). */
  grantDatasetsPrivileges(): Promise<void>;
  /**
   * El informe más reciente del paso que lleva su estado (`state`) en la tabla `operations_reports`
   * del log, el de mayor `report_id`, o `null` si no hay ninguno. Un informe sin estado, como el de un
   * fallo antes de leerlo, no cuenta: el estado sigue siendo el del anterior.
   */
  latestReportWithState(log: LogLocation, step: string): Promise<StoredReport | null>;
  /**
   * La publicación activa de `production` más antigua (por `published_at_utc` y `publication_id`)
   * que no tiene un resultado en los dos modos en `buoh_datasets.dataset_verifications`, o `null`.
   */
  nextPublicationToVerify(): Promise<PublicationToVerify | null>;
  /** Añade el resultado de una verificación a `buoh_datasets.dataset_verifications`, como `buoh_dueno`. */
  appendDatasetVerification(row: DatasetVerificationRow): Promise<void>;
  /**
   * Si el rol inicia sesión con esa contraseña: `accepted`, `rejected` si PostgreSQL la rechaza
   * (`28P01`), o `unchecked` si no hay conexiones libres (`53300`), como con las 4 de `buoh_agente`
   * abiertas. La conexión de la comprobación cuenta en el límite del rol mientras dura. Cualquier
   * otro error, como un PostgreSQL que no responde, la rechaza con él.
   */
  checkLogin(role: PasswordRole, password: string): Promise<LoginCheck>;
  /** Pone la contraseña del rol con su verificador SCRAM (`setRolePassword`). */
  setRolePassword(role: PasswordRole, password: string): Promise<void>;
  /** Añade el informe a la tabla `operations_reports` del log. */
  appendReport(log: LogLocation, row: OperationsReportRow): Promise<void>;
  /**
   * La hora UTC del último informe `completed` del paso en la tabla `operations_reports` del log, o
   * `null` si no hay ninguno.
   */
  lastCompletedReport(log: LogLocation, step: string): Promise<string | null>;
  /**
   * Los segmentos cerrados de la fuente en el log que tocan en la ejecución `slot` de la
   * verificación por partes: los de índice *i* con *i* mod 288 = `slot`, en orden (ADR-0018 §11).
   */
  listSegmentsDue(log: LogLocation, slot: number): Promise<DueSegment[]>;
  /**
   * El espacio de la base (`pg_database_size`) y el de cada log que existe, la suma de sus tablas con
   * sus índices y su TOAST (`pg_total_relation_size`), en bytes (ADR-0018 §7).
   */
  measureSpace(): Promise<SpaceMeasure>;
  /**
   * Borra el esquema del log entero, con sus tablas (`DROP SCHEMA … CASCADE`), como `buoh_dueno`,
   * si a la hora `now` sigue vencido (ADR-0018 §7): en la misma transacción vuelve a leer su última
   * escritura (`readCaptureLog`) y no borra nada si ya no venció o si el esquema no existe. Espera
   * los bloqueos de sus tablas como mucho `DROP_LOG_LOCK_TIMEOUT_MS`. Ninguna fila se modifica: se
   * borran las tablas enteras.
   */
  dropExpiredLog(log: LogLocation, now: string): Promise<LogSchemaDrop>;
  /** Libera las conexiones. */
  close(): Promise<void>;
}

/**
 * La base de datos con la credencial dueña de la configuración, sobre un pool con plazos. Si
 * PostgreSQL cierra una conexión libre del pool, deja la alerta `postgres_connection_lost`, como
 * `openStores`. Un cliente que falló con el rol `buoh_dueno` puesto se descarta en lugar de volver al
 * pool, para que la operación siguiente empiece con el usuario de la conexión.
 */
export function openOwnerDatabase(
  config: OperationsConfig,
  input: { readonly alert?: OperationalAlert; readonly source: string },
): OwnerDatabase {
  const alert = input.alert ?? stderrAlert;
  const pool = createPool(config.owner, {
    connectionTimeoutMillis: OPERATIONS_CONNECTION_TIMEOUT_MS,
    query_timeout: OPERATIONS_QUERY_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });

  /** `work` con un cliente del pool, con el usuario de la conexión. */
  const withClient = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      const value = await work(client);
      client.release();
      return value;
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  };

  /** `work` como `buoh_dueno`, con el rol de la sesión restaurado al terminar. */
  const asOwner = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
    withClient(async (client) => {
      await client.query(`SET ROLE ${pg.escapeIdentifier(POSTGRES_ROLES.owner)}`);
      const value = await work(client);
      await client.query('RESET ROLE');
      return value;
    });

  const datasets = pg.escapeIdentifier(DATASETS_SCHEMA);
  return {
    appendDatasetVerification: (row) =>
      asOwner(async (client) => {
        await client.query(
          `INSERT INTO ${datasets}.dataset_verifications
             (verification_id, dataset_id, publication_id, mode, status, exit_code, error_code,
              report_jcs, run_id, verified_at_utc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            row.verification_id,
            row.dataset_id,
            row.publication_id,
            row.mode,
            row.status,
            row.exit_code,
            row.error_code,
            row.report === null ? null : canonicalJson(row.report),
            row.run_id,
            row.verified_at_utc,
          ],
        );
      }),
    appendReport: (log, row) =>
      asOwner(async (client) => {
        await client.query(
          `INSERT INTO ${pg.escapeIdentifier(log.schema)}.operations_reports
             (report_id, run_id, step, status, observed_at_utc, report_jcs)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            row.report_id,
            row.run_id,
            row.step,
            row.status,
            row.observed_at_utc,
            canonicalJson(row.report),
          ],
        );
      }),
    checkLogin: async (role, password) => {
      const client = new pg.Client({
        ...postgresSslOption(config.owner.sslMode),
        connectionTimeoutMillis: OPERATIONS_CONNECTION_TIMEOUT_MS,
        database: config.owner.database,
        host: config.owner.host,
        password,
        port: config.owner.port,
        user: role,
      });
      client.on('error', () => undefined);
      try {
        await client.connect();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === INVALID_PASSWORD) {
          return 'rejected';
        }
        if (code === TOO_MANY_CONNECTIONS) {
          return 'unchecked';
        }
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
      return 'accepted';
    },
    close: () => pool.end(),
    assignLogProfile: (log, row) =>
      asOwner(async (client) => {
        const s = pg.escapeIdentifier(log.schema);
        const { rowCount } = await client.query(
          `INSERT INTO ${s}.log_quality_profile
             (profile_id, quality_profile_sha256, run_id, assigned_at_utc)
           SELECT $1, $2, $3, $4
            WHERE NOT has_schema_privilege($5, $6, 'USAGE')
              AND NOT EXISTS (SELECT 1 FROM ${s}.source_event_index)
              AND NOT EXISTS (SELECT 1 FROM ${s}.ingestion_heartbeats)
           ON CONFLICT (profile_slot) DO NOTHING`,
          [
            row.profile_id,
            row.quality_profile_sha256,
            row.run_id,
            row.assigned_at_utc,
            POSTGRES_ROLES.ingest,
            log.schema,
          ],
        );
        return rowCount === 1;
      }),
    createLogSchema: (log) =>
      asOwner(async (client) => {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(log.schema)}`);
      }),
    dropExpiredLog: (log, now) =>
      asOwner(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = ${String(DROP_LOG_LOCK_TIMEOUT_MS)}`);
          const current = await readCaptureLog(client, {
            number: log.number,
            source: input.source,
          });
          let result: LogSchemaDrop = 'absent';
          if (current !== null) {
            result = isLogExpired(current, now) ? 'dropped' : 'not_expired';
          }
          if (result === 'dropped') {
            await client.query(`DROP SCHEMA ${pg.escapeIdentifier(log.schema)} CASCADE`);
            await client.query('COMMIT');
          } else {
            await client.query('ROLLBACK');
          }
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    ensureApiReaderRole: () => withClient((client) => ensureApiReaderRole(client)),
    ensureApiRole: () => withClient((client) => ensureApiRole(client)),
    ensurePublicationRole: () => withClient((client) => ensurePublicationRole(client)),
    ensureRuntimeRoles: () => withClient((client) => ensureRuntimeRoles(client)),
    grantApiPrivileges: () => withClient((client) => grantApiPrivileges(client)),
    grantDatasetsPrivileges: () => withClient((client) => grantDatasetsPrivileges(client)),
    grantLogPrivileges: (log) => withClient((client) => grantLogPrivileges(client, log.schema)),
    lastCompletedReport: (log, step) =>
      asOwner(async (client) => {
        const { rows } = await client.query<{ last: string | null }>(
          `SELECT max(observed_at_utc) AS last FROM ${pg.escapeIdentifier(log.schema)}.operations_reports
            WHERE step = $1 AND status = 'completed'`,
          [step],
        );
        return rows[0]?.last ?? null;
      }),
    latestReportWithState: (log, step) =>
      asOwner(async (client) => {
        const { rows } = await client.query<{
          report_id: string;
          report_jcs: string;
          status: 'completed' | 'failed';
        }>(
          `SELECT report_id::text AS report_id, status, report_jcs
             FROM ${pg.escapeIdentifier(log.schema)}.operations_reports
            WHERE step = $1 AND (report_jcs::jsonb) ? 'state'
            ORDER BY report_id DESC LIMIT 1`,
          [step],
        );
        const [row] = rows;
        return row === undefined
          ? null
          : {
              report: JSON.parse(row.report_jcs) as JsonValue,
              report_id: row.report_id,
              status: row.status,
            };
      }),
    listLogs: () => asOwner((client) => listCaptureLogs(client, input.source)),
    nextPublicationToVerify: () =>
      asOwner(async (client) => {
        const { rows } = await client.query<{
          dataset_id: string;
          modes_done: ReplayMode[];
          publication_id: string;
        }>(
          `SELECT records.dataset_id, records.publication_id::text AS publication_id,
                  ARRAY(SELECT DISTINCT v.mode FROM ${datasets}.dataset_verifications AS v
                         WHERE v.publication_id = records.publication_id ORDER BY 1) AS modes_done
             FROM ${datasets}.published_manifest_records AS records
            WHERE records.deployment_environment = 'production' AND records.state = 'active'
              AND (SELECT count(DISTINCT v.mode) FROM ${datasets}.dataset_verifications AS v
                    WHERE v.publication_id = records.publication_id) < 2
            ORDER BY records.published_at_utc, records.publication_id
            LIMIT 1`,
        );
        return rows[0] ?? null;
      }),
    listSegmentsDue: (log, slot) =>
      asOwner(async (client) => {
        const { rows } = await client.query<
          Omit<DueSegment, 'object_size_bytes'> & { object_size_bytes: string }
        >(
          `SELECT segment_index, object_bytes_sha256, object_size_bytes, logical_content_sha256,
                  compression
             FROM ${pg.escapeIdentifier(log.schema)}.closed_source_segments
            WHERE source = $1 AND segment_index % $2 = $3
            ORDER BY segment_index`,
          [input.source, VERIFICATION_SLOTS, slot],
        );
        return rows.map((row) => ({ ...row, object_size_bytes: Number(row.object_size_bytes) }));
      }),
    measureSpace: () =>
      withClient(async (client) => {
        const database = await client.query<{ bytes: string }>(
          'SELECT pg_database_size(current_database()) AS bytes',
        );
        const logs = await client.query<{ bytes: string; schema: string }>(
          `SELECT n.nspname AS schema,
                  COALESCE(sum(pg_total_relation_size(c.oid)), 0) AS bytes
             FROM pg_namespace n
             LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r'
            WHERE n.nspname ~ '^buoh_log_[0-9]{6}$'
            GROUP BY n.nspname
            ORDER BY n.nspname`,
        );
        return {
          database_bytes: Number(database.rows[0]?.bytes ?? 0),
          logs: logs.rows.flatMap((row) => {
            const log = logNumberOf(row.schema);
            return log === null ? [] : [{ bytes: Number(row.bytes), log }];
          }),
        };
      }),
    setRolePassword: (role, password) =>
      withClient((client) => setRolePassword(client, role, password)),
  };
}
