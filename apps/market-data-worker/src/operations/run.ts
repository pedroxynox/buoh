import { healthReportSchema, type HealthReport, type JsonValue } from '@buoh/contracts';

import { ConfigError } from '../config.js';
import type { Scheduler } from '../deriv/ports.js';
import type { OperationalAlert } from '../operational/registry.js';
import {
  API_READER_ROLE,
  API_ROLE,
  LOGIN_ROLES,
  PUBLICATION_ROLE,
  type PasswordRole,
} from '../postgres/roles.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  isLogExpired,
  LOG_SEQUENCES,
  logLocation,
  MAX_LOG_NUMBER,
  R_100_SEQUENCE,
  selectActiveLog,
  type CaptureLog,
  type LogLocation,
  type LogSequence,
} from '../successive-logs.js';
import type { RunChild } from './child.js';
import {
  apiMigrateEnvironment,
  healthEnvironment,
  loadOperationsConfig,
  migrateEnvironment,
  type OperationsConfig,
} from './config.js';
import { derivLogProfileRow, type LogQualityProfileRow } from '../deriv/log-profile.js';
import { DERIV_PUBLICATION_THRESHOLDS } from '../deriv/profile.js';
import { datasetVerificationStep, publicationStep } from './datasets-steps.js';
import type { OwnerDatabase, OperationsReportRow } from './owner-database.js';
import {
  deleteKeys,
  RETENTION_DEADLINE_MS,
  RETENTION_PAGE_KEYS,
  type DeletionProgress,
  type LogDeletion,
} from './retention.js';
import { SANITIZED } from './sanitized.js';
import {
  VERIFICATION_DEADLINE_MS,
  verificationSlot,
  verifySegment,
  type DueSegment,
  type LogObjects,
} from './verification.js';

// Una ejecución de `buoh-operaciones` (ADR-0018 §11): los pasos en orden, cada uno con su informe.
// Un paso que falla deja su alerta saneada y su informe, si PostgreSQL responde, y no impide los
// siguientes. Están los roles y los logs, la salud con el informe final de un log cortado, la
// retención, la verificación por partes y el espacio. Desde ADR-0021 §1, cada paso trabaja con los
// logs de cada secuencia de `BUOH_OPERACIONES_SIMBOLOS`, y la salud y el informe final dejan un
// informe por secuencia, en su log; los demás informes van al log activo de R_100.

/**
 * Los pasos de una ejecución, en orden. `final_health` es la segunda parte del paso 2 de §11: el
 * informe final de un log que terminó (§6, «Traspaso»). `retention` es el paso 3. `publication` y
 * `dataset_verification` son los pasos 6 y 7 de ADR-0020 §8, que solo corren con la contraseña de
 * `buoh_publicacion`. `memory` es el último, en todas las ejecuciones: la memoria residente máxima
 * del proceso principal y la de cada proceso que lanzó (precisión del PR 9 de ADR-0018 §13).
 */
export const OPERATIONS_STEPS = [
  'roles_and_logs',
  'health',
  'final_health',
  'retention',
  'verification',
  'space',
  'publication',
  'dataset_verification',
  'memory',
] as const;
export type OperationsStep = (typeof OPERATIONS_STEPS)[number];

/** Un informe: solo códigos, nombres, números y horas, nunca un mensaje de error ni un precio. */
type Report = Record<string, JsonValue>;

/**
 * Lo que dejó un paso, y el log en cuya tabla de informes se guarda, si lo hay; sin él, el log
 * activo de R_100.
 */
export interface StepOutcome {
  readonly log: LogLocation | null;
  readonly report: Report;
  readonly status: 'completed' | 'failed';
  /** Si el informe se guarda aunque el paso no haya cambiado nada. */
  readonly store: boolean;
}

export interface OperationsInput {
  /**
   * Recibe cada alerta saneada: `operations_step_failed`, `operations_report_unavailable` y
   * `operations_segment_mismatch`.
   */
  readonly alert: OperationalAlert;
  readonly config: OperationsConfig;
  readonly database: OwnerDatabase;
  /** Los objetos de un log para borrarlos, con el token `operaciones`: `openLogDeletion`. */
  readonly deletion: (log: LogLocation) => LogDeletion;
  /** Recibe el stderr de cada proceso de `data:health` y de `db:migrate`, sus alertas saneadas. */
  readonly forwardChildStderr: (text: string) => void;
  /**
   * La memoria residente máxima del proceso principal hasta ese momento, en bytes:
   * `process.resourceUsage().maxRSS * 1024` en el servicio.
   */
  readonly maxRssBytes: () => number;
  /** UUIDv7 de la ejecución y de cada informe. */
  readonly nextId: () => string;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  /** Los objetos de un log con el token `operaciones`: `openLogObjects` en el servicio. */
  readonly objects: (log: LogLocation) => LogObjects;
  readonly runChild: RunChild;
  /** El temporizador de los plazos de la retención y de la verificación. */
  readonly scheduler: Scheduler;
}

/** Lo que dejó una ejecución: su ID, cómo terminó y una línea JSON por paso y otra al final. */
export interface OperationsRun {
  readonly lines: readonly string[];
  readonly run_id: string;
  readonly status: 'completed' | 'failed';
}

/**
 * El log que hay que preparar en una secuencia (ADR-0018 §6; ADR-0021 §1), con los logs que existen
 * de ella: el log 1 si no hay ninguno, y el log *n*+1 en cuanto el de mayor número tiene una
 * escritura; si no, ninguno, porque ya hay uno vacío por delante. Sin secuencia, en la de R_100.
 */
export function nextLogToPrepare(
  logs: readonly CaptureLog[],
  sequence: LogSequence = R_100_SEQUENCE,
): LogLocation | null {
  const highest = logs.reduce<CaptureLog | null>(
    (best, log) => (best === null || log.location.number > best.location.number ? log : best),
    null,
  );
  if (highest === null) {
    return logLocation(1, sequence);
  }
  if (highest.lastWriteUtc === null || highest.location.number >= MAX_LOG_NUMBER) {
    return null;
  }
  return logLocation(highest.location.number + 1, sequence);
}

/**
 * La fila del perfil que reciben los logs nuevos de la secuencia (ADR-0020 §4; ADR-0021 §2): la del
 * perfil de publicación de su símbolo, si tiene umbrales medidos (ADR-0020 §1), como R_100; si no,
 * ninguna, y sus logs se derivan con el perfil de medición, como el oro hasta su PR 7.
 */
function sequenceProfileRow(sequence: LogSequence): LogQualityProfileRow | null {
  return Object.hasOwn(DERIV_PUBLICATION_THRESHOLDS, sequence.name)
    ? derivLogProfileRow(sequence.name)
    : null;
}

/** El motivo saneado de una línea JSON de `db:migrate` que no es `migrated`, o el código de salida. */
function migrateFailure(stdout: string, exitCode: number | null, timedOut: boolean): string {
  if (timedOut) {
    return 'child_timeout';
  }
  try {
    const line = JSON.parse(stdout.trim()) as { code?: unknown; reason?: unknown };
    for (const candidate of [line.reason, line.code]) {
      if (typeof candidate === 'string' && SANITIZED.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Sin línea JSON: el motivo es el código de salida.
  }
  return `exit_${String(exitCode)}`;
}

/**
 * Corre un `db:migrate` en un proceso aparte, el del worker sobre el esquema de un log o el de la
 * API, con su entorno; da las aplicadas o el motivo saneado del fallo. Los dos escriben la misma
 * línea JSON.
 */
async function runMigrate(
  input: OperationsInput,
  child: 'api_migrate' | 'datasets_migrate' | 'migrate',
  env: Readonly<Record<string, string>>,
): Promise<{ readonly applied: string[] } | { readonly reason: string }> {
  const result = await input.runChild(child, [], env);
  if (result.stderr.length > 0) {
    input.forwardChildStderr(result.stderr);
  }
  if (result.exitCode === 0 && !result.timedOut) {
    try {
      const line = JSON.parse(result.stdout.trim()) as { applied?: unknown; status?: unknown };
      if (
        line.status === 'migrated' &&
        Array.isArray(line.applied) &&
        line.applied.every((name) => typeof name === 'string')
      ) {
        return { applied: line.applied };
      }
    } catch {
      // Una salida 0 sin su línea es un fallo del proceso.
    }
    return { reason: 'migrate_output_invalid' };
  }
  return { reason: migrateFailure(result.stdout, result.exitCode, result.timedOut) };
}

/** Corre `db:migrate` sobre el esquema del log. */
function migrateLog(
  input: OperationsInput,
  log: LogLocation,
): Promise<{ readonly applied: string[] } | { readonly reason: string }> {
  return runMigrate(input, 'migrate', migrateEnvironment(input.config, log.schema));
}

/**
 * El esquema y el rol de la API (ADR-0019 §7): crea o ajusta `buoh_api`, migra el esquema
 * `buoh_api` con el `db:migrate` de la API, en un proceso aparte con solo la credencial dueña, y le
 * da al rol sus privilegios. Anota los fallos y las migraciones aplicadas. Da si el rol existe, para
 * ponerle después su contraseña.
 */
async function prepareApi(
  input: OperationsInput,
  failures: Report[],
  applied: string[],
): Promise<boolean> {
  try {
    await input.database.ensureApiRole();
  } catch (error) {
    failures.push({ action: 'api_role', reason: failureReason(error) });
    return false;
  }
  const result = await runMigrate(input, 'api_migrate', apiMigrateEnvironment(input.config));
  if ('reason' in result) {
    failures.push({ action: 'api_migrate', reason: result.reason });
    return true;
  }
  applied.push(...result.applied);
  try {
    await input.database.grantApiPrivileges();
  } catch (error) {
    failures.push({ action: 'api_grant', reason: failureReason(error) });
  }
  return true;
}

/**
 * El rol de lectura de la API (ADR-0019 §7 y §8): crea o ajusta `buoh_api_lectura`, miembro de
 * `buoh_lectura`. Anota el fallo. Da si el rol existe, para ponerle después su contraseña.
 */
async function prepareApiReader(input: OperationsInput, failures: Report[]): Promise<boolean> {
  try {
    await input.database.ensureApiReaderRole();
    return true;
  } catch (error) {
    failures.push({ action: 'api_reader_role', reason: failureReason(error) });
    return false;
  }
}

/**
 * Los datasets vivos (ADR-0020 §5): crea o ajusta `buoh_publicacion`, migra `buoh_datasets` con
 * sus propias migraciones, en un proceso aparte con solo la credencial dueña, y da los privilegios de
 * sus roles. Anota los fallos y las migraciones aplicadas. Da si el rol existe, para ponerle después
 * su contraseña.
 */
async function prepareDatasets(
  input: OperationsInput,
  failures: Report[],
  applied: string[],
): Promise<boolean> {
  try {
    await input.database.ensurePublicationRole();
  } catch (error) {
    failures.push({ action: 'publication_role', reason: failureReason(error) });
    return false;
  }
  const result = await runMigrate(input, 'datasets_migrate', apiMigrateEnvironment(input.config));
  if ('reason' in result) {
    failures.push({ action: 'datasets_migrate', reason: result.reason });
    return true;
  }
  applied.push(...result.applied);
  try {
    await input.database.grantDatasetsPrivileges();
  } catch (error) {
    failures.push({ action: 'datasets_grant', reason: failureReason(error) });
  }
  return true;
}

/**
 * Paso 1 (ADR-0018 §11): crea y ajusta los roles; en cada secuencia de la configuración (ADR-0021
 * §1), aplica las migraciones pendientes a cada log que existe, cada uno con `db:migrate` en un
 * proceso aparte, le da su perfil si su símbolo tiene umbrales (`sequenceProfileRow`) y los
 * privilegios, y prepara el log siguiente, o el log 1 si no hay ninguno (`nextLogToPrepare`); y pone
 * la contraseña a cada rol de
 * ejecución que no inicia sesión con la suya (§8). Una que no se puede comprobar porque no hay
 * conexiones libres queda en `passwords_unchecked`, sin fallo. Sin los roles no sigue. Si falla otra
 * acción, sigue con las demás, y el paso termina `failed` con todas en `failures`.
 *
 * Con la contraseña de `buoh_api`, después de los logs, prepara también la API (`prepareApi`,
 * ADR-0019 §7) y le pone esa contraseña; el informe lleva entonces `api_migrated`. Sin ella no toca
 * la API: así es en producción hasta el PR 6 de ADR-0019 §14. Con la de `buoh_api_lectura`, crea o
 * ajusta ese rol (`prepareApiReader`, ADR-0019 §8) y le pone su contraseña; sin ella, no lo toca.
 * Con la de `buoh_publicacion`, prepara `buoh_datasets` (`prepareDatasets`, ADR-0020 §5) y le
 * pone su contraseña; el informe lleva entonces `datasets_migrated`. Sin ella, no los toca.
 */
async function rolesAndLogs(input: OperationsInput, runId: string): Promise<StepOutcome> {
  const { database } = input;
  const { apiPassword, apiReaderPassword, publicationPassword } = input.config;
  const failures: Report[] = [];
  const migrated: Report[] = [];
  const apiMigrated: string[] = [];
  const datasetsMigrated: string[] = [];
  const passwordsSet: string[] = [];
  const passwordsUnchecked: string[] = [];
  const profilesAssigned: Report[] = [];
  const prepared: Report[] = [];
  const outcome = (): StepOutcome => ({
    log: null,
    report: {
      ...(apiPassword === null ? {} : { api_migrated: apiMigrated }),
      ...(publicationPassword === null ? {} : { datasets_migrated: datasetsMigrated }),
      failures,
      migrated,
      passwords_set: passwordsSet,
      passwords_unchecked: passwordsUnchecked,
      prepared,
      profiles_assigned: profilesAssigned,
    },
    status: failures.length === 0 ? 'completed' : 'failed',
    store:
      failures.length > 0 ||
      migrated.length > 0 ||
      apiMigrated.length > 0 ||
      datasetsMigrated.length > 0 ||
      prepared.length > 0 ||
      profilesAssigned.length > 0 ||
      passwordsSet.length > 0,
  });
  try {
    await database.ensureRuntimeRoles();
  } catch (error) {
    failures.push({ action: 'ensure_roles', reason: failureReason(error) });
    return outcome();
  }
  /**
   * Migra el log de la secuencia, le da su perfil si la secuencia tiene uno y todavía no lo usa
   * nadie (ADR-0020 §4) y, si las dos cosas salieron, le da los privilegios: un log de R_100 sin su
   * perfil no llega a `buoh_ingesta`. Un log sin perfil que dar, como los del oro, solo se migra y
   * recibe sus privilegios.
   */
  const prepareSchema = async (
    log: LogLocation,
    sequence: LogSequence,
    profile: LogQualityProfileRow | null,
  ): Promise<boolean> => {
    const where = { log: log.number, sequence: sequence.name };
    const result = await migrateLog(input, log);
    if ('reason' in result) {
      failures.push({ action: 'migrate', ...where, reason: result.reason });
      return false;
    }
    if (result.applied.length > 0) {
      migrated.push({ applied: result.applied, ...where });
    }
    if (profile !== null) {
      try {
        const row = { ...profile, assigned_at_utc: input.now(), run_id: runId };
        if (await database.assignLogProfile(log, row)) {
          profilesAssigned.push(where);
        }
      } catch (error) {
        failures.push({ action: 'profile', ...where, reason: failureReason(error) });
        return false;
      }
    }
    try {
      await database.grantLogPrivileges(log);
    } catch (error) {
      failures.push({ action: 'grant', ...where, reason: failureReason(error) });
      return false;
    }
    return true;
  };
  for (const sequence of input.config.sequences) {
    const profile = sequenceProfileRow(sequence);
    try {
      for (const log of await database.listLogs(sequence)) {
        await prepareSchema(log.location, sequence, profile);
      }
      // El log siguiente se decide con los logs ya migrados.
      const next = nextLogToPrepare(await database.listLogs(sequence), sequence);
      if (next !== null) {
        await database.createLogSchema(next);
        if (await prepareSchema(next, sequence, profile)) {
          prepared.push({ log: next.number, sequence: sequence.name });
        }
      }
    } catch (error) {
      // Una secuencia que falla no impide las demás.
      failures.push({ action: 'logs', reason: failureReason(error), sequence: sequence.name });
    }
  }
  const apiRoleReady = apiPassword !== null && (await prepareApi(input, failures, apiMigrated));
  const apiReaderReady = apiReaderPassword !== null && (await prepareApiReader(input, failures));
  const publicationReady =
    publicationPassword !== null && (await prepareDatasets(input, failures, datasetsMigrated));
  const passwords: (readonly [PasswordRole, string])[] = LOGIN_ROLES.map(
    (role) => [role, input.config.passwords[role]] as const,
  );
  if (apiRoleReady) {
    passwords.push([API_ROLE, apiPassword]);
  }
  if (apiReaderReady) {
    passwords.push([API_READER_ROLE, apiReaderPassword]);
  }
  if (publicationReady) {
    passwords.push([PUBLICATION_ROLE, publicationPassword]);
  }
  for (const [role, password] of passwords) {
    try {
      const login = await database.checkLogin(role, password);
      if (login === 'rejected') {
        await database.setRolePassword(role, password);
        passwordsSet.push(role);
      } else if (login === 'unchecked') {
        // Sin conexiones libres no se sabe si vale: la ejecución siguiente la vuelve a comprobar.
        passwordsUnchecked.push(role);
      }
    } catch (error) {
      failures.push({ action: 'password', reason: failureReason(error), role });
    }
  }
  return outcome();
}

/** El `HealthReport` de la única línea de stdout de `data:health`, o `null` si no lo es. */
function healthReportOf(stdout: string): HealthReport | null {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0] === undefined) {
    return null;
  }
  try {
    const parsed = healthReportSchema.safeParse(JSON.parse(lines[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Las alertas que dejó `data:health` en stderr, como las de las reglas 2 y 3 o un punto de control
 * rechazado: de cada una, solo su evento y su motivo, si son códigos saneados. Así el informe dice
 * por qué la salud no se pudo observar, sin guardar nada más de su salida.
 */
function childAlerts(stderr: string): Report[] {
  const alerts: Report[] = [];
  for (const line of stderr.split('\n')) {
    try {
      const { event, reason } = JSON.parse(line) as { event?: unknown; reason?: unknown };
      if (typeof event === 'string' && SANITIZED.test(event)) {
        alerts.push({
          event,
          reason: typeof reason === 'string' && SANITIZED.test(reason) ? reason : null,
        });
      }
    } catch {
      // Otra línea.
    }
  }
  return alerts;
}

/** El código saneado de la línea de error de `data:health` en stderr, si la hay. */
function healthErrorCode(stderr: string): string | null {
  for (const line of stderr.split('\n')) {
    try {
      const { code } = JSON.parse(line) as { code?: unknown };
      if (typeof code === 'string' && SANITIZED.test(code)) {
        return code;
      }
    } catch {
      // Otra línea.
    }
  }
  return null;
}

/**
 * Paso 2 (ADR-0018 §11): en cada secuencia de la configuración (ADR-0021 §1), `data:health` sobre
 * su log activo (`observeLog`), con un informe por secuencia. Sin log activo, el de esa secuencia
 * falla con `log_not_prepared`.
 */
async function health(input: OperationsInput): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const sequence of input.config.sequences) {
    outcomes.push(await sequenceHealth(input, sequence));
  }
  return outcomes;
}

async function sequenceHealth(input: OperationsInput, sequence: LogSequence): Promise<StepOutcome> {
  let log: LogLocation | null;
  try {
    log = selectActiveLog(await input.database.listLogs(sequence), input.now());
  } catch (error) {
    return failedHealth(null, sequence, { reason: failureReason(error) });
  }
  if (log === null) {
    return failedHealth(null, sequence, { reason: 'log_not_prepared' });
  }
  return observeLog(input, log, sequence);
}

/**
 * Paso 2 de ADR-0018 §11, su segunda parte, en cada secuencia de la configuración (ADR-0021 §1),
 * con un informe por secuencia: el informe final de un log que terminó (§6,
 * «Traspaso»). Un log terminó cuando un log posterior, el activo, tiene una escritura: después de un
 * corte, `ingest` nunca vuelve a escribir en él. De los que terminaron, que tienen alguna escritura,
 * se pueden leer, no han vencido y todavía no tienen un informe final `completed`, el de menor
 * número recibe `data:health --log`, que lo observa sin escritor vivo (regla 4), y su informe se
 * guarda en ese log. Uno por ejecución: el siguiente, en la ejecución siguiente. Si no hay ninguno,
 * el paso termina sin guardar nada. Un informe que falla se guarda `failed`, y la ejecución
 * siguiente lo vuelve a intentar: también uno sin observación (`health_not_observed`), porque un
 * almacén no respondió o la reconstrucción no terminó, que en el paso de la salud no es un fallo.
 */
async function finalHealth(input: OperationsInput): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const sequence of input.config.sequences) {
    outcomes.push(await sequenceFinalHealth(input, sequence));
  }
  return outcomes;
}

async function sequenceFinalHealth(
  input: OperationsInput,
  sequence: LogSequence,
): Promise<StepOutcome> {
  let target: LogLocation | null = null;
  try {
    const logs = await input.database.listLogs(sequence);
    const now = input.now();
    const active = selectActiveLog(logs, now);
    const ended = logs
      .filter(
        (log) =>
          active !== null &&
          log.location.number < active.number &&
          log.readable &&
          log.lastWriteUtc !== null &&
          !isLogExpired(log, now),
      )
      .sort((left, right) => left.location.number - right.location.number);
    for (const log of ended) {
      if ((await input.database.lastCompletedReport(log.location, 'final_health')) === null) {
        target = log.location;
        break;
      }
    }
  } catch (error) {
    return failedHealth(null, sequence, { reason: failureReason(error) });
  }
  if (target === null) {
    return {
      log: null,
      report: { log: null, sequence: sequence.name },
      status: 'completed',
      store: false,
    };
  }
  const outcome = await observeLog(input, target, sequence);
  // Un informe sin observación, porque un almacén no respondió (regla 3) o la reconstrucción del
  // estado vivo no terminó, no registra lo que quedó abierto: es un fallo, y se repite.
  const alerts = outcome.report['alerts'];
  const unobserved =
    Array.isArray(alerts) &&
    alerts.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        typeof item['event'] === 'string' &&
        UNOBSERVED_HEALTH_ALERTS.has(item['event']),
    );
  return outcome.status === 'completed' && unobserved
    ? { ...outcome, report: { ...outcome.report, reason: 'health_not_observed' }, status: 'failed' }
    : outcome;
}

/** Las alertas de `data:health` que dicen que no pudo observar el log (ADR-0015 §8 y ADR-0017 §6). */
const UNOBSERVED_HEALTH_ALERTS: ReadonlySet<string> = new Set([
  'data_health_checkpoint_rebuild_incomplete',
  'data_health_storage_unavailable',
]);

/**
 * `data:health --symbol <símbolo> --log <n>` sobre el log de la secuencia, en un proceso aparte con
 * el entorno de `healthEnvironment`. Su `HealthReport` va al informe, con la secuencia, que se
 * guarda en ese log. Una salud que no es `healthy` no es un fallo; sí lo son la salida 2, un proceso
 * que no termina en su plazo, uno que no arranca, con su motivo saneado, o una línea que no es un
 * `HealthReport`. Nunca rechaza: así el fallo de una secuencia no se lleva el informe de otra.
 */
async function observeLog(
  input: OperationsInput,
  log: LogLocation,
  sequence: LogSequence,
): Promise<StepOutcome> {
  let result: Awaited<ReturnType<RunChild>>;
  try {
    result = await input.runChild(
      'health',
      ['--json', '--symbol', sequence.name, '--log', String(log.number)],
      healthEnvironment(input.config),
    );
  } catch (error) {
    return failedHealth(log, sequence, { reason: failureReason(error) });
  }
  if (result.stderr.length > 0) {
    input.forwardChildStderr(result.stderr);
  }
  if (result.timedOut) {
    return failedHealth(log, sequence, { reason: 'child_timeout' });
  }
  const report =
    result.exitCode === 0 || result.exitCode === 1 ? healthReportOf(result.stdout) : null;
  if (report === null) {
    return failedHealth(log, sequence, {
      code: healthErrorCode(result.stderr),
      exit_code: result.exitCode,
      reason: 'health_command_failed',
    });
  }
  return {
    log,
    report: {
      alerts: childAlerts(result.stderr),
      exit_code: result.exitCode,
      log: log.number,
      report,
      sequence: sequence.name,
    },
    status: 'completed',
    store: true,
  };
}

/**
 * El informe de una salud que falló, con la secuencia. Se guarda en su log, o, sin log, en el log
 * activo de R_100 solo si es de R_100: el paso de la salud de ese log es la salud que leen la API y
 * el motor (`readLatestStoredHealth`), y no puede ser la de otra secuencia. Uno de otra secuencia sin
 * log se queda en su línea y su alerta.
 */
function failedHealth(log: LogLocation | null, sequence: LogSequence, fields: Report): StepOutcome {
  return {
    log,
    report: { ...fields, log: log?.number ?? null, sequence: sequence.name },
    status: 'failed',
    store: log !== null || sequence === R_100_SEQUENCE,
  };
}

/**
 * Paso 3 (ADR-0018 §7 y §11): la retención. De los logs vencidos de todas las secuencias de
 * `LOG_SEQUENCES` (ADR-0021 §1), también la de un símbolo que ya no está en la configuración, para
 * que sus logs se borren igual, uno por ejecución: el de menor número de cada secuencia y, de esos, el
 * de la última escritura más antigua, o, con la misma, el de la secuencia que va antes en la tabla.
 * Una secuencia cuyos logs no se pueden listar va en `unlisted` con su motivo, y el paso falla, pero
 * sigue con las demás. Borra
 * con el token `operaciones` los objetos de su prefijo, por páginas de `RETENTION_PAGE_KEYS` claves
 * y con `RETENTION_CONCURRENCY` borrados a la vez. Un objeto que la regla de bloqueo del bucket
 * todavía protege queda para una ejecución siguiente (`locked`). Cuando no queda ninguno así y el
 * listado del prefijo vuelve vacío, borra el esquema del log (`dropExpiredLog`), que vuelve a mirar en
 * la misma transacción que sigue vencido. Al vencer `RETENTION_DEADLINE_MS` para sin fallar
 * (`deadline_reached`), y lo que queda sigue en la ejecución siguiente: borrar un log lleva varias.
 * Son fallos que PostgreSQL o el almacenamiento no respondan, con su motivo saneado, y que el log ya
 * no haya vencido al borrar su esquema (`log_not_expired`), porque entonces se borraron objetos de un
 * log que volvió a recibir escrituras. El informe, con la secuencia del log, se guarda en el log
 * activo de R_100, solo si había un log vencido o si el paso falló.
 */
async function retention(input: OperationsInput): Promise<StepOutcome> {
  const startedMs = Date.parse(input.now());
  const now = input.now();
  const candidates: { readonly log: CaptureLog; readonly sequence: LogSequence }[] = [];
  const unlisted: Report[] = [];
  for (const sequence of LOG_SEQUENCES) {
    try {
      const [lowest] = (await input.database.listLogs(sequence))
        .filter((log) => isLogExpired(log, now))
        .sort((left, right) => left.location.number - right.location.number);
      if (lowest !== undefined) {
        candidates.push({ log: lowest, sequence });
      }
    } catch (error) {
      unlisted.push({ reason: failureReason(error), sequence: sequence.name });
    }
  }
  // Un log vencido tiene escrituras. Con la misma hora gana el primero: la secuencia que va antes.
  const target = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, item) =>
      best === undefined ||
      Date.parse(item.log.lastWriteUtc ?? '') < Date.parse(best.log.lastWriteUtc ?? '')
        ? item
        : best,
    undefined,
  );
  /** Las secuencias sin listar: el paso falla con el motivo de la primera. */
  const listing: Report =
    unlisted[0] === undefined ? {} : { reason: unlisted[0]['reason'] ?? null, unlisted };
  if (target === undefined) {
    return unlisted.length === 0
      ? { log: null, report: { log: null }, status: 'completed', store: false }
      : { log: null, report: { log: null, ...listing }, status: 'failed', store: true };
  }
  const expired = target.log.location;
  const { sequence } = target;
  const progress: DeletionProgress = { deleted: 0, locked: 0, stopped: false };
  const outcome = (fields: Report = {}): StepOutcome => {
    const report: Report = {
      deleted: progress.deleted,
      locked: progress.locked,
      log: expired.number,
      schema_dropped: false,
      sequence: sequence.name,
      ...listing,
      ...fields,
    };
    return { log: null, report, status: 'reason' in report ? 'failed' : 'completed', store: true };
  };
  /** `work` con lo que queda del plazo de la retención, o `null` si ya venció o vence antes. */
  const timed = <T>(work: () => Promise<T>): Promise<T | null> => {
    const left = RETENTION_DEADLINE_MS - (Date.parse(input.now()) - startedMs);
    return left <= 0 ? Promise.resolve(null) : withinDeadline(input.scheduler, left, work());
  };
  const objects = input.deletion(expired);
  try {
    let startAfter: string | null = null;
    for (;;) {
      const after: string | null = startAfter;
      const page: string[] | null = await timed(() => objects.list(after, RETENTION_PAGE_KEYS));
      if (page === null) {
        return outcome({ deadline_reached: true });
      }
      const last: string | undefined = page.at(-1);
      if (last === undefined) {
        break;
      }
      if ((await timed(() => deleteKeys(objects, page, progress))) === null) {
        return outcome({ deadline_reached: true });
      }
      startAfter = last;
    }
    if (progress.locked > 0) {
      return outcome();
    }
    // Solo con el listado del prefijo vacío desde el principio se borra el esquema (§7).
    const left = await timed(() => objects.list(null, 1));
    if (left === null) {
      return outcome({ deadline_reached: true });
    }
    if (left.length > 0) {
      return outcome();
    }
  } catch (error) {
    return outcome({ reason: failureReason(error) });
  } finally {
    // Ningún borrado empieza otro, y los que siguen en marcha se cortan al cerrar sus conexiones.
    progress.stopped = true;
    objects.close();
  }
  try {
    const dropped = await input.database.dropExpiredLog(expired, input.now(), sequence);
    return dropped === 'not_expired'
      ? outcome({ reason: 'log_not_expired' })
      : outcome({ schema_dropped: dropped === 'dropped' });
  } catch (error) {
    return outcome({ reason: failureReason(error) });
  }
}

/**
 * Paso 4 (ADR-0018 §11): la verificación por partes, la periódica de ADR-0017 §4. Toma la ejecución
 * del día de la hora de inicio (`verificationSlot`) y, de cada log que se puede leer y no ha vencido,
 * de cada secuencia de la configuración (ADR-0021 §1), los segmentos cerrados que le tocan, todos
 * antes de leer ningún objeto. Después vuelve a leer sus
 * objetos con el token `operaciones` y compara sus hashes (`verifySegment`). Cada segmento que no
 * coincide va al informe y deja la alerta `operations_segment_mismatch`: es un resultado, no un fallo
 * del paso. Sí lo son que PostgreSQL o el almacenamiento no respondan y que no termine en
 * `VERIFICATION_DEADLINE_MS`; lo que queda espera a su ejecución del día siguiente. Cada segmento
 * del informe y de la alerta lleva la secuencia de su log. Una secuencia cuyos logs o segmentos no se
 * pueden buscar va en `unlisted` con su motivo, y el paso falla, pero lee los de las demás. El
 * informe se guarda en cada ejecución, en el log activo de R_100.
 */
async function verification(input: OperationsInput, startedAt: string): Promise<StepOutcome> {
  const slot = verificationSlot(startedAt);
  const startedMs = Date.parse(input.now());
  const mismatched: Report[] = [];
  let due: number | null = null;
  let read = 0;
  interface Work {
    readonly log: LogLocation;
    readonly segments: DueSegment[];
    readonly sequence: LogSequence;
  }
  const work: Work[] = [];
  const unlisted: Report[] = [];
  for (const sequence of input.config.sequences) {
    // Una secuencia entra entera o no entra.
    const found: Work[] = [];
    try {
      const logs = await input.database.listLogs(sequence);
      const now = input.now();
      for (const log of logs) {
        if (log.readable && !isLogExpired(log, now)) {
          found.push({
            log: log.location,
            segments: await input.database.listSegmentsDue(log.location, slot),
            sequence,
          });
        }
      }
      work.push(...found);
    } catch (error) {
      unlisted.push({ reason: failureReason(error), sequence: sequence.name });
    }
  }
  /** Las secuencias sin buscar: el paso falla con el motivo de la primera. */
  const listing: Report =
    unlisted[0] === undefined ? {} : { reason: unlisted[0]['reason'] ?? null, unlisted };
  const outcome = (fields: Report = {}): StepOutcome => {
    const report: Report = { due, mismatched, read, slot, ...listing, ...fields };
    return { log: null, report, status: 'reason' in report ? 'failed' : 'completed', store: true };
  };
  // Sin ningún log buscado, los que tocaban no se saben.
  due =
    unlisted.length > 0 && work.length === 0
      ? null
      : work.reduce((sum, item) => sum + item.segments.length, 0);
  for (const { log, segments, sequence } of work) {
    if (segments.length === 0) {
      continue;
    }
    const objects = input.objects(log);
    try {
      for (const segment of segments) {
        const remaining = VERIFICATION_DEADLINE_MS - (Date.parse(input.now()) - startedMs);
        if (remaining <= 0) {
          return outcome({ reason: 'deadline_exceeded' });
        }
        let checked: { readonly mismatch: string | null } | null;
        try {
          // Una lectura cuyo cuerpo se detiene no tiene otro plazo: el cliente S3 solo acota la
          // conexión y la espera de las cabeceras. Si vence, el `finally` cierra los objetos, y
          // con ellos sus conexiones, lo que corta la lectura.
          checked = await withinDeadline(
            input.scheduler,
            remaining,
            verifySegment(objects, segment).then((mismatch) => ({ mismatch })),
          );
        } catch (error) {
          return outcome({
            log: log.number,
            reason: failureReason(error),
            segment_index: segment.segment_index,
            sequence: sequence.name,
          });
        }
        if (checked === null) {
          return outcome({
            log: log.number,
            reason: 'deadline_exceeded',
            segment_index: segment.segment_index,
            sequence: sequence.name,
          });
        }
        const { mismatch } = checked;
        read += 1;
        if (mismatch !== null) {
          mismatched.push({
            log: log.number,
            reason: mismatch,
            segment_index: segment.segment_index,
            sequence: sequence.name,
          });
          input.alert({
            event: 'operations_segment_mismatch',
            log: String(log.number),
            reason: mismatch,
            segment_index: String(segment.segment_index),
            sequence: sequence.name,
          });
        }
      }
    } finally {
      objects.close();
    }
  }
  return outcome();
}

/**
 * `work`, o `null` si no termina en `ms`. Una vez vencido, lo que dé `work` después se ignora,
 * también si rechaza; cortarlo es cosa de quien llama.
 */
function withinDeadline<T>(scheduler: Scheduler, ms: number, work: Promise<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = scheduler.schedule(ms, () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    work.then(
      (value) => {
        if (!settled) {
          settled = true;
          cancel();
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}

/**
 * Paso 5 (ADR-0018 §11 y §7): una vez al día UTC, el espacio de la base y el de cada log en
 * PostgreSQL, de cualquier secuencia, cada uno con la suya (`measureSpace`; ADR-0021 §1), con su
 * informe en el log activo de R_100. Mide si ese log todavía no
 * tiene un informe `completed` de este paso de ese día, así que una medida que falla se vuelve a
 * intentar en la ejecución siguiente; si ya lo tiene, el paso termina sin medir ni guardar nada. El
 * espacio de R2 lo copia el propietario del panel de Cloudflare (§13).
 */
async function space(input: OperationsInput): Promise<StepOutcome> {
  try {
    const now = input.now();
    const active = selectActiveLog(await input.database.listLogs(R_100_SEQUENCE), now);
    if (active !== null) {
      const last = await input.database.lastCompletedReport(active, 'space');
      if (last !== null && last.slice(0, 10) === now.slice(0, 10)) {
        return {
          log: active,
          report: { last_measured_at_utc: last, measured: false },
          status: 'completed',
          store: false,
        };
      }
    }
    const measure = await input.database.measureSpace();
    return {
      log: active,
      report: {
        database_bytes: measure.database_bytes,
        logs: measure.logs.map((item) => ({
          bytes: item.bytes,
          log: item.log,
          sequence: item.sequence,
        })),
        measured: true,
      },
      status: 'completed',
      store: true,
    };
  } catch (error) {
    return { log: null, report: { reason: failureReason(error) }, status: 'failed', store: true };
  }
}

/**
 * Una ejecución de `buoh-operaciones` (ADR-0018 §11), con la configuración ya cargada: los pasos en
 * orden. Cada uno deja una línea JSON en stdout (`operations_step`), y uno que falla, además, la
 * alerta `operations_step_failed` con el primer motivo y, si su informe la lleva, la secuencia. La
 * salud y el informe final dejan una línea y un informe por secuencia (ADR-0021 §1). El informe de
 * cada paso se guarda en la tabla `operations_reports` de su log (el de la salud) o del log activo
 * de R_100 después del paso, salvo
 * el del paso 1 cuando no cambió nada, el de la retención cuando no había ningún log vencido y el
 * del espacio cuando ya se midió ese día, y los de los pasos 6 y 7 cuando no hicieron nada. Sin la
 * contraseña de `buoh_publicacion`, los pasos 6 y 7 no corren ni dejan línea. Si no se puede
 * guardar, deja la alerta `operations_report_unavailable` y la ejecución termina `failed`. La
 * última línea (`operations_run`) dice cómo terminó.
 */
export async function runOperations(input: OperationsInput): Promise<OperationsRun> {
  const runId = input.nextId();
  const startedAt = input.now();
  const lines: string[] = [];
  let failed = false;
  const launches: Report[] = [];
  const measured: OperationsInput = {
    ...input,
    runChild: recordedRunChild(input.runChild, launches),
  };
  const steps: Record<OperationsStep, () => Promise<StepOutcome | StepOutcome[]>> = {
    final_health: () => finalHealth(measured),
    health: () => health(measured),
    retention: () => retention(measured),
    dataset_verification: () => datasetVerificationStep(measured, startedAt, runId),
    memory: () =>
      Promise.resolve({
        log: null,
        report: { children: launches, max_rss_bytes: input.maxRssBytes() },
        status: 'completed',
        store: true,
      }),
    publication: () => publicationStep(measured, startedAt),
    roles_and_logs: () => rolesAndLogs(measured, runId),
    space: () => space(measured),
    verification: () => verification(measured, startedAt),
  };
  // Los pasos 6 y 7 solo existen con la contraseña de buoh_publicacion (ADR-0020 §13, PR 4).
  const enabled = OPERATIONS_STEPS.filter(
    (step) =>
      input.config.publicationPassword !== null ||
      (step !== 'publication' && step !== 'dataset_verification'),
  );
  for (const step of enabled) {
    let outcomes: StepOutcome[];
    try {
      const result = await steps[step]();
      outcomes = Array.isArray(result) ? result : [result];
    } catch (error) {
      outcomes = [
        {
          log: null,
          report: { reason: failureReason(error) },
          status: 'failed',
          store: true,
        },
      ];
    }
    for (const outcome of outcomes) {
      const observedAt = input.now();
      if (outcome.status === 'failed') {
        failed = true;
        const sequence = outcome.report['sequence'];
        input.alert({
          event: 'operations_step_failed',
          reason: firstReason(outcome.report),
          ...(typeof sequence === 'string' ? { sequence } : {}),
          step,
        });
      }
      lines.push(
        JSON.stringify({
          event: 'operations_step',
          log: outcome.log?.number ?? null,
          report: outcome.report,
          run_id: runId,
          status: outcome.status,
          step,
        }),
      );
      if (outcome.store && !(await storeReport(input, step, outcome, { observedAt, runId }))) {
        failed = true;
      }
    }
  }
  const status = failed ? 'failed' : 'completed';
  lines.push(
    JSON.stringify({
      event: 'operations_run',
      finished_at_utc: input.now(),
      run_id: runId,
      started_at_utc: startedAt,
      status,
    }),
  );
  return { lines, run_id: runId, status };
}

/**
 * `runChild`, que anota en `launches`, en orden, cada proceso que lanza con la memoria residente
 * máxima que dio (`maxRssBytes`), o `null` si no la dio o no arrancó, para el paso `memory`.
 */
function recordedRunChild(runChild: RunChild, launches: Report[]): RunChild {
  return async (child, args, env, options) => {
    let maxRssBytes: number | null = null;
    try {
      const result = await runChild(child, args, env, options);
      maxRssBytes = result.maxRssBytes ?? null;
      return result;
    } finally {
      launches.push({ child, max_rss_bytes: maxRssBytes });
    }
  };
}

/** El primer motivo saneado de un informe: el suyo o el de su primer fallo. */
function firstReason(report: Report): string {
  if (typeof report['reason'] === 'string') {
    return report['reason'];
  }
  const failures = report['failures'];
  if (Array.isArray(failures)) {
    const [first] = failures;
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      const reason = first['reason'];
      if (typeof reason === 'string') {
        return reason;
      }
    }
  }
  return 'unknown_error';
}

/**
 * Guarda el informe del paso en su log, o en el log activo de R_100 si el paso no lo dice. Sin
 * ningún log no hay dónde guardarlo, y no es un fallo: lo dice la línea del paso. Si PostgreSQL no
 * responde, deja la alerta `operations_report_unavailable` y da `false`.
 */
async function storeReport(
  input: OperationsInput,
  step: OperationsStep,
  outcome: StepOutcome,
  meta: { readonly observedAt: string; readonly runId: string },
): Promise<boolean> {
  try {
    const log =
      outcome.log ?? selectActiveLog(await input.database.listLogs(R_100_SEQUENCE), input.now());
    if (log === null) {
      return true;
    }
    const row: OperationsReportRow = {
      observed_at_utc: meta.observedAt,
      report: outcome.report,
      report_id: input.nextId(),
      run_id: meta.runId,
      status: outcome.status,
      step,
    };
    await input.database.appendReport(log, row);
    return true;
  } catch (error) {
    input.alert({ event: 'operations_report_unavailable', reason: failureReason(error), step });
    return false;
  }
}

/** Lo que necesita `operationsCommand` además del entorno. */
export interface OperationsDependencies extends Omit<
  OperationsInput,
  'config' | 'database' | 'deletion' | 'objects'
> {
  /** Abre la base con la credencial dueña de la configuración: `openOwnerDatabase`. */
  readonly openDatabase: (config: OperationsConfig) => OwnerDatabase;
  /**
   * Abre los objetos de un log para borrarlos, con el token `operaciones` de la configuración:
   * `openLogDeletion`.
   */
  readonly openDeletion: (config: OperationsConfig, log: LogLocation) => LogDeletion;
  /** Abre los objetos de un log con el token `operaciones` de la configuración: `openLogObjects`. */
  readonly openObjects: (config: OperationsConfig, log: LogLocation) => LogObjects;
}

/**
 * `buoh-operaciones` completo (ADR-0018 §11): carga la configuración y corre una ejecución. Devuelve
 * sus líneas de stdout y el código de salida: 0 si todos los pasos terminaron y sus informes se
 * guardaron, 1 si no, y 2 con una configuración inválida, con una línea `ConfigError` que solo nombra
 * las variables, sin abrir nada. Cierra la base al terminar, de cualquier forma. Un error inesperado
 * da `code: UNEXPECTED` y salida 1.
 */
export async function operationsCommand(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: OperationsDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly lines: readonly string[] }> {
  let config: OperationsConfig;
  try {
    config = loadOperationsConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        exitCode: 2,
        lines: [JSON.stringify({ code: error.name, message: error.message, status: 'failed' })],
      };
    }
    throw error;
  }
  const { openDatabase, openDeletion, openObjects, ...ports } = dependencies;
  const database = openDatabase(config);
  try {
    const run = await runOperations({
      ...ports,
      config,
      database,
      deletion: (log) => openDeletion(config, log),
      objects: (log) => openObjects(config, log),
    });
    return { exitCode: run.status === 'completed' ? 0 : 1, lines: run.lines };
  } catch (error) {
    return {
      exitCode: 1,
      lines: [
        JSON.stringify({
          code: 'UNEXPECTED',
          message: error instanceof Error ? error.name : 'Error',
          status: 'failed',
        }),
      ],
    };
  } finally {
    await database.close().catch(() => undefined);
  }
}
