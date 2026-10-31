import { canonicalJson, type JsonValue } from '@buoh/contracts';
import pg, { type PoolClient } from 'pg';

import { stderrAlert, type OperationalAlert } from '../operational/registry.js';
import { createPool, postgresSslOption } from '../postgres/metadata-store.js';
import {
  ensureRuntimeRoles,
  grantLogPrivileges,
  POSTGRES_ROLES,
  setRolePassword,
  type LoginRole,
} from '../postgres/roles.js';
import { failureReason } from '../source-log/source-event-log.js';
import { listCaptureLogs, type CaptureLog, type LogLocation } from '../successive-logs.js';
import { type OperationsConfig } from './config.js';

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
   * Si el rol inicia sesión con esa contraseña: `accepted`, `rejected` si PostgreSQL la rechaza
   * (`28P01`), o `unchecked` si no hay conexiones libres (`53300`), como con las 4 de `buoh_agente`
   * abiertas. La conexión de la comprobación cuenta en el límite del rol mientras dura. Cualquier
   * otro error, como un PostgreSQL que no responde, la rechaza con él.
   */
  checkLogin(role: LoginRole, password: string): Promise<LoginCheck>;
  /** Pone la contraseña del rol con su verificador SCRAM (`setRolePassword`). */
  setRolePassword(role: LoginRole, password: string): Promise<void>;
  /** Añade el informe a la tabla `operations_reports` del log. */
  appendReport(log: LogLocation, row: OperationsReportRow): Promise<void>;
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

  return {
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
    createLogSchema: (log) =>
      asOwner(async (client) => {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(log.schema)}`);
      }),
    ensureRuntimeRoles: () => withClient((client) => ensureRuntimeRoles(client)),
    grantLogPrivileges: (log) => withClient((client) => grantLogPrivileges(client, log.schema)),
    listLogs: () => asOwner((client) => listCaptureLogs(client, input.source)),
    setRolePassword: (role, password) =>
      withClient((client) => setRolePassword(client, role, password)),
  };
}
