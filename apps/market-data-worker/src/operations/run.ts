import { healthReportSchema, type HealthReport, type JsonValue } from '@buoh/contracts';

import { ConfigError } from '../config.js';
import { type Scheduler } from '../deriv/ports.js';
import { type OperationalAlert } from '../operational/registry.js';
import { LOGIN_ROLES } from '../postgres/roles.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  isLogExpired,
  logLocation,
  MAX_LOG_NUMBER,
  selectActiveLog,
  type CaptureLog,
  type LogLocation,
} from '../successive-logs.js';
import { type RunChild } from './child.js';
import {
  healthEnvironment,
  loadOperationsConfig,
  migrateEnvironment,
  type OperationsConfig,
} from './config.js';
import { type OwnerDatabase, type OperationsReportRow } from './owner-database.js';
import {
  deleteKeys,
  RETENTION_DEADLINE_MS,
  RETENTION_PAGE_KEYS,
  type DeletionProgress,
  type LogDeletion,
} from './retention.js';
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
// retención, la verificación por partes y el espacio.

/**
 * Los pasos de una ejecución, en orden. `final_health` es la segunda parte del paso 2 de §11: el
 * informe final de un log que terminó (§6, «Traspaso»). `retention` es el paso 3.
 */
export const OPERATIONS_STEPS = [
  'roles_and_logs',
  'health',
  'final_health',
  'retention',
  'verification',
  'space',
] as const;
export type OperationsStep = (typeof OPERATIONS_STEPS)[number];

/** Un informe: solo códigos, nombres, números y horas, nunca un mensaje de error ni un precio. */
type Report = Record<string, JsonValue>;

/** Un código, un evento o un motivo saneado: letras, cifras, `_`, `.` y `-`, de 1 a 64. */
const SANITIZED = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Lo que dejó un paso, y el log en cuya tabla de informes se guarda, si lo hay. */
interface StepOutcome {
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
 * El log que hay que preparar (ADR-0018 §6): el log 1 si no hay ninguno, y el log *n*+1 en cuanto
 * el de mayor número tiene una escritura; si no, ninguno, porque ya hay uno vacío por delante.
 */
export function nextLogToPrepare(logs: readonly CaptureLog[]): LogLocation | null {
  const highest = logs.reduce<CaptureLog | null>(
    (best, log) => (best === null || log.location.number > best.location.number ? log : best),
    null,
  );
  if (highest === null) {
    return logLocation(1);
  }
  if (highest.lastWriteUtc === null || highest.location.number >= MAX_LOG_NUMBER) {
    return null;
  }
  return logLocation(highest.location.number + 1);
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

/** Corre `db:migrate` sobre el esquema del log; da las aplicadas o el motivo saneado del fallo. */
async function migrateLog(
  input: OperationsInput,
  log: LogLocation,
): Promise<{ readonly applied: string[] } | { readonly reason: string }> {
  const result = await input.runChild('migrate', [], migrateEnvironment(input.config, log.schema));
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

/**
 * Paso 1 (ADR-0018 §11): crea y ajusta los roles; aplica las migraciones pendientes a cada log que
 * existe, cada uno con `db:migrate` en un proceso aparte, y le da los privilegios; prepara el log
 * siguiente, o el log 1 si no hay ninguno (`nextLogToPrepare`); y pone la contraseña a cada rol de
 * ejecución que no inicia sesión con la suya (§8). Una que no se puede comprobar porque no hay
 * conexiones libres queda en `passwords_unchecked`, sin fallo. Sin los roles no sigue. Si falla otra
 * acción, sigue con las demás, y el paso termina `failed` con todas en `failures`.
 */
async function rolesAndLogs(input: OperationsInput): Promise<StepOutcome> {
  const { database } = input;
  const failures: Report[] = [];
  const migrated: Report[] = [];
  const passwordsSet: string[] = [];
  const passwordsUnchecked: string[] = [];
  let prepared: number | null = null;
  const outcome = (): StepOutcome => ({
    log: null,
    report: {
      failures,
      migrated,
      passwords_set: passwordsSet,
      passwords_unchecked: passwordsUnchecked,
      prepared,
    },
    status: failures.length === 0 ? 'completed' : 'failed',
    store:
      failures.length > 0 || migrated.length > 0 || prepared !== null || passwordsSet.length > 0,
  });
  try {
    await database.ensureRuntimeRoles();
  } catch (error) {
    failures.push({ action: 'ensure_roles', reason: failureReason(error) });
    return outcome();
  }
  /** Migra el log y, si migró, le da los privilegios. */
  const prepareSchema = async (log: LogLocation): Promise<boolean> => {
    const result = await migrateLog(input, log);
    if ('reason' in result) {
      failures.push({ action: 'migrate', log: log.number, reason: result.reason });
      return false;
    }
    if (result.applied.length > 0) {
      migrated.push({ applied: result.applied, log: log.number });
    }
    try {
      await database.grantLogPrivileges(log);
    } catch (error) {
      failures.push({ action: 'grant', log: log.number, reason: failureReason(error) });
      return false;
    }
    return true;
  };
  try {
    for (const log of await database.listLogs()) {
      await prepareSchema(log.location);
    }
    // El log siguiente se decide con los logs ya migrados.
    const next = nextLogToPrepare(await database.listLogs());
    if (next !== null) {
      await database.createLogSchema(next);
      if (await prepareSchema(next)) {
        prepared = next.number;
      }
    }
  } catch (error) {
    failures.push({ action: 'logs', reason: failureReason(error) });
  }
  for (const role of LOGIN_ROLES) {
    const password = input.config.passwords[role];
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
 * Paso 2 (ADR-0018 §11): `data:health` sobre el log activo (`observeLog`). Sin log activo, el paso
 * falla con `log_not_prepared`.
 */
async function health(input: OperationsInput): Promise<StepOutcome> {
  let log: LogLocation | null;
  try {
    log = selectActiveLog(await input.database.listLogs(), input.now());
  } catch (error) {
    return failedHealth(null, { reason: failureReason(error) });
  }
  if (log === null) {
    return failedHealth(null, { reason: 'log_not_prepared' });
  }
  return observeLog(input, log);
}

/**
 * Paso 2 de ADR-0018 §11, su segunda parte: el informe final de un log que terminó (§6,
 * «Traspaso»). Un log terminó cuando un log posterior, el activo, tiene una escritura: después de un
 * corte, `ingest` nunca vuelve a escribir en él. De los que terminaron, que tienen alguna escritura,
 * se pueden leer, no han vencido y todavía no tienen un informe final `completed`, el de menor
 * número recibe `data:health --log`, que lo observa sin escritor vivo (regla 4), y su informe se
 * guarda en ese log. Uno por ejecución: el siguiente, en la ejecución siguiente. Si no hay ninguno,
 * el paso termina sin guardar nada. Un informe que falla se guarda `failed`, y la ejecución
 * siguiente lo vuelve a intentar: también uno sin observación (`health_not_observed`), porque un
 * almacén no respondió o la reconstrucción no terminó, que en el paso de la salud no es un fallo.
 */
async function finalHealth(input: OperationsInput): Promise<StepOutcome> {
  let target: LogLocation | null = null;
  try {
    const logs = await input.database.listLogs();
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
    return failedHealth(null, { reason: failureReason(error) });
  }
  if (target === null) {
    return { log: null, report: { log: null }, status: 'completed', store: false };
  }
  const outcome = await observeLog(input, target);
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
 * `data:health --log` sobre el log, en un proceso aparte con el entorno de `healthEnvironment`. Su
 * `HealthReport` va al informe, que se guarda en ese log. Una salud que no es `healthy` no es un
 * fallo; sí lo son la salida 2, un proceso que no termina en su plazo o una línea que no es un
 * `HealthReport`.
 */
async function observeLog(input: OperationsInput, log: LogLocation): Promise<StepOutcome> {
  const result = await input.runChild(
    'health',
    ['--json', '--log', String(log.number)],
    healthEnvironment(input.config),
  );
  if (result.stderr.length > 0) {
    input.forwardChildStderr(result.stderr);
  }
  if (result.timedOut) {
    return failedHealth(log, { reason: 'child_timeout' });
  }
  const report =
    result.exitCode === 0 || result.exitCode === 1 ? healthReportOf(result.stdout) : null;
  if (report === null) {
    return failedHealth(log, {
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
    },
    status: 'completed',
    store: true,
  };
}

function failedHealth(log: LogLocation | null, fields: Report): StepOutcome {
  return {
    log,
    report: { ...fields, log: log?.number ?? null },
    status: 'failed',
    store: true,
  };
}

/**
 * Paso 3 (ADR-0018 §7 y §11): la retención. Del log vencido de menor número, uno por ejecución, borra
 * con el token `operaciones` los objetos de su prefijo, por páginas de `RETENTION_PAGE_KEYS` claves
 * y con `RETENTION_CONCURRENCY` borrados a la vez. Un objeto que la regla de bloqueo del bucket
 * todavía protege queda para una ejecución siguiente (`locked`). Cuando no queda ninguno así y el
 * listado del prefijo vuelve vacío, borra el esquema del log (`dropExpiredLog`), que vuelve a mirar en
 * la misma transacción que sigue vencido. Al vencer `RETENTION_DEADLINE_MS` para sin fallar
 * (`deadline_reached`), y lo que queda sigue en la ejecución siguiente: borrar un log lleva varias.
 * Son fallos que PostgreSQL o el almacenamiento no respondan, con su motivo saneado, y que el log ya
 * no haya vencido al borrar su esquema (`log_not_expired`), porque entonces se borraron objetos de un
 * log que volvió a recibir escrituras. El informe se guarda en el log activo, solo si había un log
 * vencido o si el paso falló.
 */
async function retention(input: OperationsInput): Promise<StepOutcome> {
  const startedMs = Date.parse(input.now());
  let target: LogLocation | undefined;
  try {
    const now = input.now();
    target = (await input.database.listLogs())
      .filter((log) => isLogExpired(log, now))
      .map((log) => log.location)
      .sort((left, right) => left.number - right.number)[0];
  } catch (error) {
    return {
      log: null,
      report: { log: null, reason: failureReason(error) },
      status: 'failed',
      store: true,
    };
  }
  if (target === undefined) {
    return { log: null, report: { log: null }, status: 'completed', store: false };
  }
  const expired = target;
  const progress: DeletionProgress = { deleted: 0, locked: 0, stopped: false };
  const outcome = (fields: Report = {}): StepOutcome => ({
    log: null,
    report: {
      deleted: progress.deleted,
      locked: progress.locked,
      log: expired.number,
      schema_dropped: false,
      ...fields,
    },
    status: 'reason' in fields ? 'failed' : 'completed',
    store: true,
  });
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
    const dropped = await input.database.dropExpiredLog(expired, input.now());
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
 * los segmentos cerrados que le tocan, todos antes de leer ningún objeto. Después vuelve a leer sus
 * objetos con el token `operaciones` y compara sus hashes (`verifySegment`). Cada segmento que no
 * coincide va al informe y deja la alerta `operations_segment_mismatch`: es un resultado, no un fallo
 * del paso. Sí lo son que PostgreSQL o el almacenamiento no respondan y que no termine en
 * `VERIFICATION_DEADLINE_MS`; lo que queda espera a su ejecución del día siguiente. El informe se
 * guarda en cada ejecución, en el log activo.
 */
async function verification(input: OperationsInput, startedAt: string): Promise<StepOutcome> {
  const slot = verificationSlot(startedAt);
  const startedMs = Date.parse(input.now());
  const mismatched: Report[] = [];
  let due: number | null = null;
  let read = 0;
  const outcome = (fields: Report = {}): StepOutcome => ({
    log: null,
    report: { due, mismatched, read, slot, ...fields },
    status: 'reason' in fields ? 'failed' : 'completed',
    store: true,
  });
  const work: { readonly log: LogLocation; readonly segments: DueSegment[] }[] = [];
  try {
    const logs = await input.database.listLogs();
    const now = input.now();
    for (const log of logs) {
      if (log.readable && !isLogExpired(log, now)) {
        work.push({
          log: log.location,
          segments: await input.database.listSegmentsDue(log.location, slot),
        });
      }
    }
  } catch (error) {
    return outcome({ reason: failureReason(error) });
  }
  due = work.reduce((sum, item) => sum + item.segments.length, 0);
  for (const { log, segments } of work) {
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
          });
        }
        if (checked === null) {
          return outcome({
            log: log.number,
            reason: 'deadline_exceeded',
            segment_index: segment.segment_index,
          });
        }
        const { mismatch } = checked;
        read += 1;
        if (mismatch !== null) {
          mismatched.push({
            log: log.number,
            reason: mismatch,
            segment_index: segment.segment_index,
          });
          input.alert({
            event: 'operations_segment_mismatch',
            log: String(log.number),
            reason: mismatch,
            segment_index: String(segment.segment_index),
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
 * PostgreSQL (`measureSpace`), con su informe en el log activo. Mide si el log activo todavía no
 * tiene un informe `completed` de este paso de ese día, así que una medida que falla se vuelve a
 * intentar en la ejecución siguiente; si ya lo tiene, el paso termina sin medir ni guardar nada. El
 * espacio de R2 lo copia el propietario del panel de Cloudflare (§13).
 */
async function space(input: OperationsInput): Promise<StepOutcome> {
  try {
    const now = input.now();
    const active = selectActiveLog(await input.database.listLogs(), now);
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
        logs: measure.logs.map((item) => ({ bytes: item.bytes, log: item.log })),
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
 * alerta `operations_step_failed` con el primer motivo. El informe de cada paso se guarda en la
 * tabla `operations_reports` de su log (el de la salud) o del log activo después del paso, salvo
 * el del paso 1 cuando no cambió nada, el de la retención cuando no había ningún log vencido y el
 * del espacio cuando ya se midió ese día. Si no se puede
 * guardar, deja la alerta `operations_report_unavailable` y la ejecución termina `failed`. La
 * última línea (`operations_run`) dice cómo terminó.
 */
export async function runOperations(input: OperationsInput): Promise<OperationsRun> {
  const runId = input.nextId();
  const startedAt = input.now();
  const lines: string[] = [];
  let failed = false;
  const steps: Record<OperationsStep, () => Promise<StepOutcome>> = {
    final_health: () => finalHealth(input),
    health: () => health(input),
    retention: () => retention(input),
    roles_and_logs: () => rolesAndLogs(input),
    space: () => space(input),
    verification: () => verification(input, startedAt),
  };
  for (const step of OPERATIONS_STEPS) {
    let outcome: StepOutcome;
    try {
      outcome = await steps[step]();
    } catch (error) {
      outcome = {
        log: null,
        report: { reason: failureReason(error) },
        status: 'failed',
        store: true,
      };
    }
    const observedAt = input.now();
    if (outcome.status === 'failed') {
      failed = true;
      input.alert({ event: 'operations_step_failed', reason: firstReason(outcome.report), step });
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
 * Guarda el informe del paso en su log, o en el log activo si el paso no lo dice. Sin ningún log no
 * hay dónde guardarlo, y no es un fallo: lo dice la línea del paso. Si PostgreSQL no responde, deja
 * la alerta `operations_report_unavailable` y da `false`.
 */
async function storeReport(
  input: OperationsInput,
  step: OperationsStep,
  outcome: StepOutcome,
  meta: { readonly observedAt: string; readonly runId: string },
): Promise<boolean> {
  try {
    const log = outcome.log ?? selectActiveLog(await input.database.listLogs(), input.now());
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
