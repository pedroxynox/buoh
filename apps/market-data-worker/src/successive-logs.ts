import type { Pool } from 'pg';

import type { WorkerConfig } from './config.js';

// Los logs sucesivos de producción (ADR-0018 §6 y §7): cada log tiene un número, su esquema de
// PostgreSQL y su prefijo en el bucket de la captura, y el log activo se busca, sin tabla de
// registro, por la última escritura de cada uno. Desde ADR-0021 §1, los logs forman secuencias,
// una por símbolo capturado en vivo, y cada secuencia tiene sus propios nombres. En `development` y
// `test`, un log sigue siendo el esquema de `BUOH_POSTGRES_SCHEMA` y el bucket de `BUOH_S3_BUCKET`,
// sin prefijo.

/** Las cifras del número de un log en su esquema y en su prefijo: `buoh_log_000001`. */
export const LOG_NUMBER_DIGITS = 6;
/** El mayor número de log que cabe en esas cifras. */
export const MAX_LOG_NUMBER = 999_999;
/**
 * La retención de producción (ADR-0018 §7): un log vence cuando su última escritura, un evento o
 * un latido, tiene 30 días o más.
 */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Una secuencia de logs (ADR-0021 §1): una serie de logs de una fuente con su nombre, su esquema y
 * su prefijo por log, su bloqueo, su log activo, su corte semanal y su vencimiento. Cada símbolo que
 * se captura en vivo tiene la suya, y dos secuencias nunca comparten un log. `name` es el nombre que
 * guarda `buoh_datasets` en cada rango (`dataset_log_ranges.sequence`): en una secuencia en vivo, su
 * símbolo.
 */
export interface LogSequence {
  readonly name: string;
  /** El esquema del log *n* es este comienzo seguido de *n* en seis cifras. */
  readonly schemaStem: string;
  /** El prefijo de los objetos del log *n* es este comienzo, *n* en seis cifras y `/`. */
  readonly prefixStem: string;
}

/**
 * La secuencia de R_100, la de la captura desde el 2026-11-01. Conserva los nombres de antes de las
 * secuencias, `buoh_log_<n>` y `logs/<n>/` (ADR-0021 §1), así que nada de lo guardado cambia.
 */
export const R_100_SEQUENCE: LogSequence = Object.freeze({
  name: 'R_100',
  prefixStem: 'logs/',
  schemaStem: 'buoh_log_',
});

/**
 * La secuencia del oro (`frxXAUUSD`; ADR-0021 §2): su nombre en minúsculas en el esquema,
 * `buoh_frxxauusd_log_<n>`, que no casa con el de R_100, y en el prefijo, `logs/frxxauusd/<n>/`,
 * bajo `logs/`, para que lo cubran la regla de 30 días de `buoh-captura` y la retención.
 */
export const GOLD_SEQUENCE: LogSequence = Object.freeze({
  name: 'frxXAUUSD',
  prefixStem: 'logs/frxxauusd/',
  schemaStem: 'buoh_frxxauusd_log_',
});

/**
 * Las secuencias que existen (ADR-0021 §1: «su PR fija los nombres exactos»). Es una tabla fija, y
 * no una regla sobre el símbolo, para que dos símbolos que solo difieren en mayúsculas nunca
 * compartan un esquema ni un prefijo: una secuencia nueva entra aquí con su PR, y una prueba
 * comprueba que ninguna comparte su nombre, su esquema ni su prefijo con otra.
 */
export const LOG_SEQUENCES: readonly LogSequence[] = Object.freeze([R_100_SEQUENCE, GOLD_SEQUENCE]);

/** La secuencia en vivo de `symbol`, o `null` si el símbolo no tiene ninguna. */
export function liveSequenceOf(symbol: string): LogSequence | null {
  return LOG_SEQUENCES.find((sequence) => sequence.name === symbol) ?? null;
}

/**
 * Solo las secuencias de `LOG_SEQUENCES`: sus comienzos van tal cual en el SQL y en las expresiones
 * regulares, y solo los de la tabla están revisados (minúsculas, cifras y `_` en el esquema).
 */
function knownSequence(sequence: LogSequence): LogSequence {
  if (!LOG_SEQUENCES.includes(sequence)) {
    throw new TypeError(`La secuencia ${sequence.name} no está en LOG_SEQUENCES.`);
  }
  return sequence;
}

/**
 * El esquema de un log de `sequence` como expresión regular, que vale igual en POSIX, para
 * `pg_namespace`, y en JavaScript. Con `capture`, el número va entre paréntesis. El comienzo del
 * esquema solo lleva minúsculas, cifras y `_`, que no son especiales en ninguna de las dos.
 */
function schemaRegex(sequence: LogSequence, capture: boolean): string {
  const digits = `[0-9]{${String(LOG_NUMBER_DIGITS)}}`;
  return `^${knownSequence(sequence).schemaStem}${capture ? `(${digits})` : digits}$`;
}

/** La tabla no existe (`undefined_table`): al esquema le faltan las migraciones del worker. */
const UNDEFINED_TABLE = '42P01';
/** Sin privilegios (`insufficient_privilege`): el esquema todavía no tiene los del rol. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Dónde vive el log *n* de una secuencia (ADR-0018 §6; ADR-0021 §1). */
export interface LogLocation {
  readonly number: number;
  /**
   * El prefijo de sus objetos en el bucket de la captura: en R_100, `logs/<n>/`, con *n* en seis
   * cifras; en otra secuencia, el comienzo de su prefijo seguido de *n* y `/`.
   */
  readonly prefix: string;
  /**
   * Su esquema de PostgreSQL: en R_100, `buoh_log_<n>`, con *n* en seis cifras; en otra secuencia,
   * el comienzo de su esquema seguido de *n*.
   */
  readonly schema: string;
}

/**
 * El esquema y el prefijo del log `number` de `sequence`, un entero de 1 a `MAX_LOG_NUMBER`. Sin
 * secuencia, los de R_100.
 */
export function logLocation(number: number, sequence: LogSequence = R_100_SEQUENCE): LogLocation {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LOG_NUMBER) {
    throw new TypeError(`El número de un log es un entero de 1 a ${String(MAX_LOG_NUMBER)}.`);
  }
  const digits = String(number).padStart(LOG_NUMBER_DIGITS, '0');
  const known = knownSequence(sequence);
  return {
    number,
    prefix: `${known.prefixStem}${digits}/`,
    schema: `${known.schemaStem}${digits}`,
  };
}

/**
 * El número del log de un esquema de `sequence` (en R_100, `buoh_log_<n>`), o `null` si el nombre no
 * es el de un log de esa secuencia.
 */
export function logNumberOf(schema: string, sequence: LogSequence = R_100_SEQUENCE): number | null {
  const digits = new RegExp(schemaRegex(sequence, true), 'u').exec(schema)?.[1];
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
   * índice y la del último latido, o `null` si no tiene ninguna o no se pudo leer.
   */
  readonly lastWriteUtc: string | null;
  /**
   * Si se pudo leer. Un esquema sin las tablas (`42P01`) o que el rol todavía no puede leer
   * (`42501`), como mientras `buoh-operaciones` lo prepara, no cuenta como escrito ni como
   * preparado (ADR-0018 §6, «Preparación»: el esquema, sus migraciones y sus privilegios).
   */
  readonly readable: boolean;
}

/** Si el log venció (ADR-0018 §7): su última escritura tiene 30 días o más. Uno sin escrituras, no. */
export function isLogExpired(log: CaptureLog, now: string): boolean {
  return (
    log.lastWriteUtc !== null && Date.parse(now) - Date.parse(log.lastWriteUtc) >= LOG_RETENTION_MS
  );
}

/**
 * El log activo (ADR-0018 §6): sin contar los vencidos, el de mayor número con alguna escritura,
 * o, si no hay ninguno así, el preparado de menor número: uno que se pudo leer y no tiene
 * escrituras. `null` si no queda ninguno.
 */
export function selectActiveLog(logs: readonly CaptureLog[], now: string): LogLocation | null {
  const live = logs.filter((log) => !isLogExpired(log, now));
  const written = live.filter((log) => log.lastWriteUtc !== null);
  if (written.length > 0) {
    return written.reduce((a, b) => (b.location.number > a.location.number ? b : a)).location;
  }
  const prepared = live.filter((log) => log.readable);
  return prepared.length > 0
    ? prepared.reduce((a, b) => (b.location.number < a.location.number ? b : a)).location
    : null;
}

/** La más tardía de dos horas UTC, o `null` si no hay ninguna. */
function latest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Los logs de `sequence` que existen, en orden, con la última escritura de `source` en cada uno
 * (ADR-0018 §6; ADR-0021 §1): los esquemas con el nombre de un log de la secuencia, de
 * `pg_namespace`, y, de cada uno, el último evento del índice
 * (por su posición, con la clave primaria) y el último latido (por su orden de escritura, con el
 * índice `(source, write_order)` de la `0006`). Un esquema sin las tablas (`42P01`) o que el rol
 * de la conexión todavía no puede leer (`42501`) es un log que se está preparando: queda como no
 * legible (`readable: false`), sin escrituras. Cualquier otro error rechaza la lectura.
 */
export async function listCaptureLogs(
  pool: Pick<Pool, 'query'>,
  source: string,
  sequence: LogSequence = R_100_SEQUENCE,
): Promise<CaptureLog[]> {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT nspname AS name FROM pg_namespace WHERE nspname ~ $1',
    [schemaRegex(sequence, false)],
  );
  const numbers = rows
    .map((row) => logNumberOf(row.name, sequence))
    .filter((number): number is number => number !== null)
    .sort((a, b) => a - b);
  const logs: CaptureLog[] = [];
  for (const number of numbers) {
    const location = logLocation(number, sequence);
    const lastWrite = await lastWriteOf(pool, location.schema, source);
    logs.push(
      lastWrite === UNREADABLE
        ? { lastWriteUtc: null, location, readable: false }
        : { lastWriteUtc: lastWrite, location, readable: true },
    );
  }
  return logs;
}

/**
 * El log `number` de `sequence` (sin ella, de R_100), con la última escritura de `source`, si su
 * esquema existe; `null` si no. Lee solo ese log, como `listCaptureLogs` lee cada uno.
 */
export async function readCaptureLog(
  pool: Pick<Pool, 'query'>,
  input: {
    readonly number: number;
    readonly sequence?: LogSequence;
    readonly source: string;
  },
): Promise<CaptureLog | null> {
  const location = logLocation(input.number, input.sequence);
  const { rows } = await pool.query<{ name: string }>(
    'SELECT nspname AS name FROM pg_namespace WHERE nspname = $1',
    [location.schema],
  );
  if (rows.length === 0) {
    return null;
  }
  const lastWrite = await lastWriteOf(pool, location.schema, input.source);
  return lastWrite === UNREADABLE
    ? { lastWriteUtc: null, location, readable: false }
    : { lastWriteUtc: lastWrite, location, readable: true };
}

/** El esquema de un log que todavía no se puede leer: sin las tablas o sin los privilegios. */
const UNREADABLE = Symbol('unreadable');

/** La última escritura de `source` en el esquema de un log, `null`, o `UNREADABLE`. */
async function lastWriteOf(
  pool: Pick<Pool, 'query'>,
  schema: string,
  source: string,
): Promise<string | null | typeof UNREADABLE> {
  try {
    // El nombre del esquema sale de `logLocation`: solo minúsculas, cifras y `_`.
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
      return UNREADABLE;
    }
    throw error;
  }
}

/** La más temprana de dos horas UTC, o `null` si no hay ninguna. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * La hora UTC de la primera escritura de `source` en el log (ADR-0018 §6, «Hora de corte»): la más
 * temprana entre la del primer evento del índice, por su posición, y la del primer latido, por su
 * orden de escritura, con la clave primaria del índice y el índice `(source, write_order)` de la
 * `0006`, sin recorrer el log. `null` si no tiene ninguna. Es la misma definición que la de la última
 * escritura (`listCaptureLogs`), desde el otro extremo. Rechaza si el esquema no se puede leer.
 */
export async function firstWriteOf(
  pool: Pick<Pool, 'query'>,
  log: LogLocation,
  source: string,
): Promise<string | null> {
  // El nombre del esquema sale de `logLocation`: solo minúsculas, cifras y `_`.
  const { rows } = await pool.query<{ event: string | null; heartbeat: string | null }>(
    `SELECT
       (SELECT event_time_utc FROM ${log.schema}.source_event_index WHERE source = $1
         ORDER BY segment_index, position LIMIT 1) AS event,
       (SELECT observed_at_utc FROM ${log.schema}.ingestion_heartbeats WHERE source = $1
         ORDER BY write_order LIMIT 1) AS heartbeat`,
    [source],
  );
  return earliest(rows[0]?.event ?? null, rows[0]?.heartbeat ?? null);
}

/**
 * Busca el log activo de `source` en `sequence` (ADR-0018 §6; sin ella, en R_100) con `pool`, de
 * cualquier esquema: lee los logs y después toma la hora (`now`), para que una escritura de
 * mientras tanto no lo deje vencido.
 */
export async function findActiveLog(
  pool: Pick<Pool, 'query'>,
  input: {
    readonly now: () => string;
    readonly sequence?: LogSequence;
    readonly source: string;
  },
): Promise<LogLocation | null> {
  const logs = await listCaptureLogs(pool, input.source, input.sequence);
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
