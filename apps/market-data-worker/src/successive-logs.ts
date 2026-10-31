import { type Pool } from 'pg';

import { type WorkerConfig } from './config.js';

// Los logs sucesivos de producción (ADR-0018 §6 y §7): cada log tiene un número, su esquema de
// PostgreSQL y su prefijo en el bucket de la captura, y el log activo se busca, sin tabla de
// registro, por la última escritura de cada uno. En `development` y `test`, un log sigue siendo el
// esquema de `BUOH_POSTGRES_SCHEMA` y el bucket de `BUOH_S3_BUCKET`, sin prefijo.

/** Las cifras del número de un log en su esquema y en su prefijo: `buoh_log_000001`. */
export const LOG_NUMBER_DIGITS = 6;
/** El mayor número de log que cabe en esas cifras. */
export const MAX_LOG_NUMBER = 999_999;
/**
 * La retención de producción (ADR-0018 §7): un log vence cuando su última escritura, un evento o
 * un latido, tiene 30 días o más.
 */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** El esquema de un log: `buoh_log_` y su número en seis cifras. */
const LOG_SCHEMA = /^buoh_log_([0-9]{6})$/u;

/** La tabla no existe (`undefined_table`): al esquema le faltan las migraciones del worker. */
const UNDEFINED_TABLE = '42P01';
/** Sin privilegios (`insufficient_privilege`): el esquema todavía no tiene los del rol. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Dónde vive el log *n* (ADR-0018 §6). */
export interface LogLocation {
  readonly number: number;
  /** `logs/<n>/`, con *n* en seis cifras: el prefijo de sus objetos en el bucket de la captura. */
  readonly prefix: string;
  /** `buoh_log_<n>`, con *n* en seis cifras: su esquema de PostgreSQL. */
  readonly schema: string;
}

/** El esquema y el prefijo del log `number`, un entero de 1 a `MAX_LOG_NUMBER`. */
export function logLocation(number: number): LogLocation {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LOG_NUMBER) {
    throw new TypeError(`El número de un log es un entero de 1 a ${String(MAX_LOG_NUMBER)}.`);
  }
  const digits = String(number).padStart(LOG_NUMBER_DIGITS, '0');
  return { number, prefix: `logs/${digits}/`, schema: `buoh_log_${digits}` };
}

/** El número del log de un esquema `buoh_log_<n>`, o `null` si el nombre no es el de un log. */
export function logNumberOf(schema: string): number | null {
  const digits = LOG_SCHEMA.exec(schema)?.[1];
  if (digits === undefined) {
    return null;
  }
  const number = Number(digits);
  return number >= 1 ? number : null;
}

/** Un log que existe, con la hora de su última escritura. */
export interface CaptureLog {
  readonly location: LogLocation;
  /**
   * La hora UTC de su última escritura de la fuente, la más tardía entre la del último evento del
   * índice y la del último latido, o `null` si no tiene ninguna: un log preparado, o uno que el rol
   * todavía no puede leer.
   */
  readonly lastWriteUtc: string | null;
}

/** Si el log venció (ADR-0018 §7): su última escritura tiene 30 días o más. Uno sin escrituras, no. */
export function isLogExpired(log: CaptureLog, now: string): boolean {
  return (
    log.lastWriteUtc !== null && Date.parse(now) - Date.parse(log.lastWriteUtc) >= LOG_RETENTION_MS
  );
}

/**
 * El log activo (ADR-0018 §6): sin contar los vencidos, el de mayor número con alguna escritura,
 * o, si no hay ninguno así, el preparado de menor número. `null` si no queda ninguno.
 */
export function selectActiveLog(logs: readonly CaptureLog[], now: string): LogLocation | null {
  const live = logs.filter((log) => !isLogExpired(log, now));
  const written = live.filter((log) => log.lastWriteUtc !== null);
  const numbers = (written.length > 0 ? written : live).map((log) => log.location.number);
  if (numbers.length === 0) {
    return null;
  }
  return logLocation(written.length > 0 ? Math.max(...numbers) : Math.min(...numbers));
}

/** La más tardía de dos horas UTC, o `null` si no hay ninguna. */
function latest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Los logs que existen, en orden, con la última escritura de `source` en cada uno (ADR-0018 §6):
 * los esquemas con nombre de log de `pg_namespace` y, de cada uno, el último evento del índice
 * (por su posición, con la clave primaria) y el último latido (por su orden de escritura). Un
 * esquema sin las tablas (`42P01`) o que el rol de la conexión todavía no puede leer (`42501`) es
 * un log que se está preparando: no tiene escrituras. Cualquier otro error rechaza la lectura.
 */
export async function listCaptureLogs(
  pool: Pick<Pool, 'query'>,
  source: string,
): Promise<CaptureLog[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT nspname AS name FROM pg_namespace WHERE nspname ~ '^buoh_log_[0-9]{6}$'",
  );
  const numbers = rows
    .map((row) => logNumberOf(row.name))
    .filter((number): number is number => number !== null)
    .sort((a, b) => a - b);
  const logs: CaptureLog[] = [];
  for (const number of numbers) {
    const location = logLocation(number);
    logs.push({ lastWriteUtc: await lastWriteOf(pool, location.schema, source), location });
  }
  return logs;
}

/** La última escritura de `source` en el esquema de un log, o `null`. */
async function lastWriteOf(
  pool: Pick<Pool, 'query'>,
  schema: string,
  source: string,
): Promise<string | null> {
  try {
    // El nombre del esquema pasó por `LOG_SCHEMA`: solo minúsculas, cifras y `_`.
    const { rows } = await pool.query<{ event: string | null; heartbeat: string | null }>(
      `SELECT
         (SELECT event_time_utc FROM ${schema}.source_event_index WHERE source = $1
           ORDER BY segment_index DESC, position DESC LIMIT 1) AS event,
         (SELECT observed_at_utc FROM ${schema}.ingestion_heartbeats WHERE source = $1
           ORDER BY write_order DESC LIMIT 1) AS heartbeat`,
      [source],
    );
    return latest(rows[0]?.event ?? null, rows[0]?.heartbeat ?? null);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === UNDEFINED_TABLE || code === INSUFFICIENT_PRIVILEGE) {
      return null;
    }
    throw error;
  }
}

/**
 * Busca el log activo de `source` (ADR-0018 §6) con `pool`, de cualquier esquema: lee los logs y
 * después toma la hora (`now`), para que una escritura de mientras tanto no lo deje vencido.
 */
export async function findActiveLog(
  pool: Pick<Pool, 'query'>,
  input: { readonly now: () => string; readonly source: string },
): Promise<LogLocation | null> {
  const logs = await listCaptureLogs(pool, input.source);
  return selectActiveLog(logs, input.now());
}

/** La configuración para trabajar sobre un log: su esquema y el prefijo de sus objetos. */
export function withLog(config: WorkerConfig, log: LogLocation): WorkerConfig {
  return {
    ...config,
    postgres: { ...config.postgres, schema: log.schema },
    s3: { ...config.s3, keyPrefix: log.prefix },
  };
}

/**
 * Las variables que un comando que trabaja sobre el log activo no admite en `production`
 * (ADR-0018 §4 y §6): `BUOH_POSTGRES_SCHEMA`, porque el esquema sale del número del log. Así una
 * variable que nadie leería no da a entender otro log.
 */
export function productionLogConfigErrors(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return env['BUOH_POSTGRES_SCHEMA'] === undefined ? [] : ['BUOH_POSTGRES_SCHEMA'];
}
