import { healthReportSchema, type HealthReport, type JsonValue } from '@buoh/contracts';

import { ConfigError } from '../config.js';
import { type OperationalAlert } from '../operational/registry.js';
import { LOGIN_ROLES } from '../postgres/roles.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
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

// Una ejecución de `buoh-operaciones` (ADR-0018 §11): los pasos en orden, cada uno con su informe.
// Un paso que falla deja su alerta saneada y su informe, si PostgreSQL responde, y no impide los
// siguientes. Este PR trae los dos primeros: los roles y los logs, y la salud. La retención, la
// verificación por partes y el espacio llegan con los PR siguientes de §16.

/** Los pasos de una ejecución, en orden. */
export const OPERATIONS_STEPS = ['roles_and_logs', 'health'] as const;
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
  /** Recibe cada alerta saneada: `operations_step_failed` y `operations_report_unavailable`. */
  readonly alert: OperationalAlert;
  readonly config: OperationsConfig;
  readonly database: OwnerDatabase;
  /** Recibe el stderr de cada proceso de `data:health` y de `db:migrate`, sus alertas saneadas. */
  readonly forwardChildStderr: (text: string) => void;
  /** UUIDv7 de la ejecución y de cada informe. */
  readonly nextId: () => string;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  readonly runChild: RunChild;
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
 * ejecución que no inicia sesión con la suya (§8). Sin los roles no sigue. Si falla otra acción,
 * sigue con las demás, y el paso termina `failed` con todas en `failures`.
 */
async function rolesAndLogs(input: OperationsInput): Promise<StepOutcome> {
  const { database } = input;
  const failures: Report[] = [];
  const migrated: Report[] = [];
  const passwordsSet: string[] = [];
  let prepared: number | null = null;
  const outcome = (): StepOutcome => ({
    log: null,
    report: { failures, migrated, passwords_set: passwordsSet, prepared },
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
      if (!(await database.canLogin(role, password))) {
        await database.setRolePassword(role, password);
        passwordsSet.push(role);
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
 * Paso 2 (ADR-0018 §11): `data:health` sobre el log activo, con `--log`, en un proceso aparte con el
 * entorno de `healthEnvironment`. Su `HealthReport` va al informe, que se guarda en ese log. Una
 * salud que no es `healthy` no es un fallo del paso; sí lo son la salida 2, un proceso que no termina
 * en su plazo o una línea que no es un `HealthReport`.
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
 * Una ejecución de `buoh-operaciones` (ADR-0018 §11), con la configuración ya cargada: los pasos en
 * orden. Cada uno deja una línea JSON en stdout (`operations_step`), y uno que falla, además, la
 * alerta `operations_step_failed` con el primer motivo. El informe de cada paso se guarda en la
 * tabla `operations_reports` de su log (el de la salud) o del log activo después del paso 1, salvo
 * el del paso 1 cuando no cambió nada. Si no se puede guardar, deja la alerta
 * `operations_report_unavailable` y la ejecución termina `failed`. La última línea
 * (`operations_run`) dice cómo terminó.
 */
export async function runOperations(input: OperationsInput): Promise<OperationsRun> {
  const runId = input.nextId();
  const startedAt = input.now();
  const lines: string[] = [];
  let failed = false;
  const steps: Record<OperationsStep, () => Promise<StepOutcome>> = {
    health: () => health(input),
    roles_and_logs: () => rolesAndLogs(input),
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
export interface OperationsDependencies extends Omit<OperationsInput, 'config' | 'database'> {
  /** Abre la base con la credencial dueña de la configuración: `openOwnerDatabase`. */
  readonly openDatabase: (config: OperationsConfig) => OwnerDatabase;
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
  const { openDatabase, ...ports } = dependencies;
  const database = openDatabase(config);
  try {
    const run = await runOperations({ ...ports, config, database });
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
