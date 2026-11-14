import {
  datasetIdSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
  type JsonValue,
} from '@buoh/contracts';
import { z } from 'zod';

import { failureReason } from '../source-log/source-event-log.js';
import { isLogExpired, type CaptureLog } from '../successive-logs.js';
import type { ChildResult } from './child.js';
import { CODE_VERSION, publishEnvironment, replayEnvironment } from './config.js';
import type { PublicationToVerify } from './owner-database.js';
import type { OperationsInput, StepOutcome } from './run.js';
import { SANITIZED } from './sanitized.js';

// Los pasos 6 y 7 de `buoh-operaciones` (ADR-0020 §8): la publicación de los datasets vivos, con
// `datasets:publish` en un proceso aparte con `buoh_publicacion` y el token `operaciones`, y su
// verificación en los dos modos, con `data:replay` en un proceso aparte con `buoh_salud` y el token
// `salud`. Cada uno guarda lo que necesita la ejecución siguiente en su propio informe: los logs
// detenidos y las ejecuciones seguidas sin un resultado concluyente.

/** El paso 6: la publicación. */
export const PUBLICATION_STEP = 'publication';
/** El paso 7: la verificación de los datasets publicados. */
export const DATASET_VERIFICATION_STEP = 'dataset_verification';
/** Los dos pasos solo empiezan si la ejecución lleva menos de esto (ADR-0020 §8). */
export const DATASETS_START_LIMIT_MS = 150_000;
/** El plazo de cada paso. */
export const DATASETS_STEP_DEADLINE_MS = 60_000;
/** Ejecuciones seguidas sin un resultado concluyente con el mismo dataset antes de rendirse. */
export const INCONCLUSIVE_RUNS = 3;

/** Los motivos de `datasets:publish` que repetir no cambia: detienen el log (ADR-0020 §8). */
export const PUBLICATION_STOP_REASONS = [
  'publication_conflict',
  'publication_incomplete',
  'publication_limit_exceeded',
  'publication_not_derivable',
  'publication_segment_too_large',
] as const;
/** Los que se repiten en la ejecución siguiente, sin contar: un almacén, un `COMMIT` ambiguo. */
const PUBLICATION_REPEAT_REASONS: ReadonlySet<string> = new Set([
  'commit_outcome_unknown',
  'storage_unavailable',
]);

type Report = Record<string, JsonValue>;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sanitized = z.string().regex(SANITIZED);
const logNumber = z.number().int().min(1).max(999_999);
const behindSchema = z.strictObject({ expires_at_utc: utcTimestampMsSchema, log: logNumber });

// Las líneas de `datasets:publish` (runbook, «Publicación de los datasets vivos»). `z.object` deja
// fuera cualquier campo que no esté aquí: al informe solo pasan conteos, códigos y horas.
const measured = { duration_ms: count, max_rss_bytes: count };
const publishedLineSchema = z.object({
  ...measured,
  behind: behindSchema.nullable(),
  clean: z.boolean(),
  dataset_id: datasetIdSchema,
  elements: count,
  first_segment: count,
  incident_count: count.optional(),
  last_segment: count,
  log: logNumber,
  normalized_tick_count: count.optional(),
  open_condition_types: z.array(sanitized),
  pending_continuity_symbols: z.array(sanitized),
  publication_id: uuidV7Schema,
  source_event_count: count.optional(),
  status: z.enum(['already_published', 'published']),
});
const nothingDueLineSchema = z.object({
  ...measured,
  behind: behindSchema.nullable(),
  status: z.literal('nothing_due'),
});
const failedLineSchema = z.object({
  ...measured,
  behind: behindSchema.nullable().optional(),
  detail: sanitized,
  first_segment: count.optional(),
  log: logNumber.nullable(),
  reason: sanitized,
  stage: sanitized,
  status: z.literal('failed'),
});
const publishLineSchema = z.discriminatedUnion('status', [
  publishedLineSchema,
  nothingDueLineSchema,
  failedLineSchema,
]);
const attemptLineSchema = z.object({
  event: z.literal('publication_attempt'),
  first_segment: count,
  log: logNumber,
});

/** Un log detenido: el dataset que no se pudo publicar, por qué y con qué código. */
const stopSchema = z.strictObject({
  code_version: z.string().regex(CODE_VERSION).nullable(),
  first_segment: count,
  log: logNumber,
  reason: z.enum(PUBLICATION_STOP_REASONS),
});
type Stop = z.infer<typeof stopSchema>;
const publicationStateSchema = z.strictObject({
  /** Las ejecuciones seguidas sin un resultado concluyente con ese dataset. */
  attempts: z.strictObject({ count, first_segment: count, log: logNumber }).nullable(),
  stopped: z.array(stopSchema),
});
type PublicationState = z.infer<typeof publicationStateSchema>;

const replayModeSchema = z.enum(['verify-only', 'recompute']);
type ReplayMode = z.infer<typeof replayModeSchema>;
const verificationStateSchema = z.strictObject({
  attempts: z
    .strictObject({ count, mode: replayModeSchema, publication_id: uuidV7Schema })
    .nullable(),
});
type VerificationState = z.infer<typeof verificationStateSchema>;

/** El informe saneado de `data:replay` con salida 0: el `ReplayReport` y su memoria. */
const replayPassedSchema = z.object({
  condition_event_count: count,
  dataset_id: datasetIdSchema,
  deployment_environment: z.literal('production'),
  incident_count: count,
  logical_artifact_count: count,
  max_rss_bytes: count,
  mode: replayModeSchema,
  normalized_tick_count: count,
  publication_id: uuidV7Schema,
  raw_frame_count: count,
  source_event_count: count,
  status: z.enum(['reproduced', 'verified']),
  storage_object_count: count,
});
const replayFailedSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/u),
  max_rss_bytes: count.optional(),
  status: z.literal('failed'),
});

/** La única línea JSON de stdout de un proceso, o `null`. */
function stdoutLine(stdout: string): unknown {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    return null;
  }
  try {
    return JSON.parse(lines[0] ?? '') as unknown;
  } catch {
    return null;
  }
}

/** Si la ejecución lleva ya `DATASETS_START_LIMIT_MS` o más: el paso espera a la siguiente. */
function tooLate(input: OperationsInput, startedAt: string): boolean {
  return Date.parse(input.now()) - Date.parse(startedAt) >= DATASETS_START_LIMIT_MS;
}

const DEFERRED: StepOutcome = {
  log: null,
  report: { deferred: true },
  status: 'completed',
  store: false,
};

/**
 * El estado que dejó el informe más reciente del paso, de cualquier log que se puede leer: el de
 * mayor `report_id`, un UUIDv7, que crece con el tiempo. Sin ninguno, el estado vacío. `invalid` si
 * el informe no tiene la forma que escribe el paso.
 */
async function loadState<T>(
  input: OperationsInput,
  logs: readonly CaptureLog[],
  step: string,
  schema: z.ZodType<T>,
  empty: T,
): Promise<T | 'invalid'> {
  let latest: { readonly report: JsonValue; readonly report_id: string } | null = null;
  for (const log of logs) {
    if (!log.readable) {
      continue;
    }
    const found = await input.database.latestReportWithState(log.location, step);
    if (found !== null && (latest === null || found.report_id > latest.report_id)) {
      latest = found;
    }
  }
  if (latest === null) {
    return empty;
  }
  const report = latest.report;
  const state =
    typeof report === 'object' && report !== null && !Array.isArray(report)
      ? report['state']
      : undefined;
  const parsed = schema.safeParse(state);
  return parsed.success ? parsed.data : 'invalid';
}

/** Por qué un proceso no dio una línea concluyente: su plazo, una señal o su salida. */
function childFailure(result: ChildResult, invalid: string): string {
  if (result.timedOut) {
    return 'child_timeout';
  }
  if (result.exitCode === null) {
    return 'child_killed';
  }
  return invalid;
}

/** El último aviso `publication_attempt` de stderr: el dataset que intentaba el proceso. */
function lastAttempt(stderr: string): { first_segment: number; log: number } | null {
  let found: { first_segment: number; log: number } | null = null;
  for (const line of stderr.split('\n')) {
    try {
      const parsed = attemptLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        found = { first_segment: parsed.data.first_segment, log: parsed.data.log };
      }
    } catch {
      // Otra línea.
    }
  }
  return found;
}

/** El resultado de una ejecución de `datasets:publish`, ya clasificado. */
type PublishResult =
  | { readonly kind: 'published'; readonly line: z.infer<typeof publishedLineSchema> }
  | { readonly kind: 'nothing_due'; readonly line: z.infer<typeof nothingDueLineSchema> }
  | {
      readonly behind: z.infer<typeof behindSchema> | null;
      readonly dataset: { readonly first_segment: number; readonly log: number } | null;
      readonly kind: 'inconclusive' | 'repeat' | 'stop';
      readonly report: Report;
    }
  | { readonly kind: 'invalid'; readonly report: Report };

function classifyPublish(result: ChildResult): PublishResult {
  const parsed = result.timedOut ? null : publishLineSchema.safeParse(stdoutLine(result.stdout));
  const line = parsed?.success === true ? parsed.data : null;
  if (line !== null && result.exitCode === 0 && line.status !== 'failed') {
    return line.status === 'nothing_due'
      ? { kind: 'nothing_due', line }
      : { kind: 'published', line };
  }
  if (line?.status === 'failed' && result.exitCode === 1) {
    const dataset =
      line.log !== null && line.first_segment !== undefined
        ? { first_segment: line.first_segment, log: line.log }
        : lastAttempt(result.stderr);
    // El atraso sale también de un fallo: justo cuando el log más viejo no se publica.
    const behind = line.behind ?? null;
    const report: Report = {
      detail: line.detail,
      exit_code: 1,
      first_segment: line.first_segment ?? null,
      log: line.log,
      reason: line.reason,
      stage: line.stage,
    };
    const stops: ReadonlySet<string> = new Set(PUBLICATION_STOP_REASONS);
    if (stops.has(line.reason)) {
      // Sin dataset identificado no hay log que detener: el paso falla y nada más.
      return { behind, dataset, kind: 'stop', report };
    }
    if (PUBLICATION_REPEAT_REASONS.has(line.reason)) {
      return { behind, dataset, kind: 'repeat', report };
    }
    return { behind, dataset, kind: 'inconclusive', report };
  }
  if (result.exitCode === 2 && !result.timedOut) {
    // Un error de uso o de configuración no es de ningún dataset: lo arregla un cambio del código.
    return { kind: 'invalid', report: { exit_code: 2, reason: 'publish_config_invalid' } };
  }
  const reason = childFailure(result, 'publish_output_invalid');
  const dataset = lastAttempt(result.stderr);
  return {
    behind: null,
    dataset,
    kind: 'inconclusive',
    report: {
      exit_code: result.exitCode,
      first_segment: dataset?.first_segment ?? null,
      log: dataset?.log ?? null,
      reason,
    },
  };
}

/**
 * Paso 6 (ADR-0020 §8): `datasets:publish` en un proceso aparte, con `buoh_publicacion`, el token
 * `operaciones` y un plazo de 60 s, que publica como mucho un dataset.
 *
 * - **Logs detenidos.** Un log se detiene cuando su publicación falla por una causa que repetir no
 *   cambia (`PUBLICATION_STOP_REASONS`), y sigue detenido mientras el código es el mismo
 *   (`codeVersion`, el commit que da Render): la orden lo salta (`--skip`), y el paso deja su
 *   alerta, con el nombre del motivo, en cada ejecución. Un log que venció o ya no existe deja de
 *   contar.
 * - **Sin un resultado concluyente.** Un plazo vencido, un proceso que muere, una salida sin su
 *   línea o un error inesperado (`unexpected`) cuentan como una ejecución sin resultado del dataset
 *   que intentaba, que dicen su línea o su aviso `publication_attempt`. A la tercera seguida con el
 *   mismo dataset, el log se detiene con `publication_incomplete`. Un almacén que no responde o un
 *   `COMMIT` ambiguo se repiten sin contar; una publicación, o nada pendiente, ponen la cuenta a
 *   cero.
 * - **Atraso.** Con `behind`, también en una línea `failed`, la alerta `publication_behind`.
 *
 * El estado (los logs detenidos y la cuenta) va en el informe del paso, en el log activo, y la
 * ejecución siguiente lo lee del más reciente de cualquier log que lo lleva: el informe de un fallo
 * de antes de leerlo no lo lleva, y no lo cambia. El paso falla si la orden falló o hay algún log
 * detenido. El informe se guarda si publicó, si el paso falló o si el estado cambió.
 */
export async function publicationStep(
  input: OperationsInput,
  startedAt: string,
): Promise<StepOutcome> {
  if (tooLate(input, startedAt)) {
    return DEFERRED;
  }
  const empty: PublicationState = { attempts: null, stopped: [] };
  let logs: CaptureLog[];
  let loaded: PublicationState | 'invalid';
  try {
    logs = await input.database.listLogs();
    loaded = await loadState(input, logs, PUBLICATION_STEP, publicationStateSchema, empty);
  } catch (error) {
    return { log: null, report: { reason: failureReason(error) }, status: 'failed', store: true };
  }
  if (loaded === 'invalid') {
    return {
      log: null,
      report: { reason: 'publication_state_invalid' },
      status: 'failed',
      store: true,
    };
  }
  const now = input.now();
  const live = new Set(
    logs.filter((log) => !isLogExpired(log, now)).map((log) => log.location.number),
  );
  const code = input.config.codeVersion;
  let stopped: Stop[] = loaded.stopped.filter(
    (stop) => live.has(stop.log) && stop.code_version === code,
  );
  let attempts = loaded.attempts !== null && live.has(loaded.attempts.log) ? loaded.attempts : null;
  const skip = [...new Set(stopped.map((stop) => stop.log))].sort((a, b) => a - b);

  const result = await input.runChild(
    'publish',
    skip.length === 0 ? [] : ['--skip', skip.join(',')],
    publishEnvironment(input.config),
    { timeoutMs: DATASETS_STEP_DEADLINE_MS },
  );
  if (result.stderr.length > 0) {
    input.forwardChildStderr(result.stderr);
  }
  const classified = classifyPublish(result);

  let outcome: Report;
  let failed = false;
  let behind: z.infer<typeof behindSchema> | null = null;
  switch (classified.kind) {
    case 'published': {
      const { behind: lineBehind, ...rest } = classified.line;
      behind = lineBehind;
      outcome = Object.fromEntries(
        Object.entries(rest).filter((entry) => entry[1] !== undefined),
      ) as Report;
      attempts = null;
      break;
    }
    case 'nothing_due':
      behind = classified.line.behind;
      outcome = { status: 'nothing_due' };
      attempts = null;
      break;
    case 'stop':
    case 'repeat':
    case 'inconclusive':
    case 'invalid': {
      failed = true;
      behind = classified.kind === 'invalid' ? null : classified.behind;
      outcome = { status: 'failed', ...classified.report };
      if (classified.kind === 'stop' && classified.dataset !== null) {
        stopped = [
          ...stopped.filter((stop) => stop.log !== classified.dataset?.log),
          {
            code_version: code,
            ...classified.dataset,
            reason: classified.report['reason'] as Stop['reason'],
          },
        ];
        attempts = null;
      } else if (classified.kind === 'inconclusive' && classified.dataset !== null) {
        const { dataset } = classified;
        const same =
          attempts !== null &&
          attempts.log === dataset.log &&
          attempts.first_segment === dataset.first_segment;
        const next = same && attempts !== null ? attempts.count + 1 : 1;
        if (next >= INCONCLUSIVE_RUNS) {
          stopped = [
            ...stopped.filter((stop) => stop.log !== dataset.log),
            { code_version: code, ...dataset, reason: 'publication_incomplete' },
          ];
          attempts = null;
        } else {
          attempts = { count: next, ...dataset };
        }
      }
      break;
    }
  }
  stopped.sort((left, right) => left.log - right.log);

  for (const stop of stopped) {
    input.alert({
      event: stop.reason,
      first_segment: String(stop.first_segment),
      log: String(stop.log),
    });
  }
  if (behind !== null) {
    input.alert({
      event: 'publication_behind',
      expires_at_utc: behind.expires_at_utc,
      log: String(behind.log),
    });
  }
  const state: PublicationState = { attempts, stopped };
  const changed = JSON.stringify(state) !== JSON.stringify(loaded);
  const reason =
    typeof outcome['reason'] === 'string' ? outcome['reason'] : (stopped[0]?.reason ?? null);
  const status = failed || stopped.length > 0 ? 'failed' : 'completed';
  return {
    log: null,
    report: {
      behind,
      code_version: code,
      ...(reason === null ? {} : { reason }),
      result: outcome,
      skipped: skip,
      state,
    },
    status,
    // Siempre que falla (§8), también con un log detenido y nada nuevo; y si el estado cambió.
    store: status === 'failed' || classified.kind === 'published' || changed,
  };
}

/** Lo que dio una ejecución de `data:replay` en un modo. */
type ReplayOutcome =
  | { readonly kind: 'passed'; readonly report: Report }
  | {
      readonly code: string;
      readonly kind: 'failed';
      readonly maxRssBytes: number | null;
    }
  | { readonly kind: 'config' }
  | { readonly kind: 'storage' }
  | { readonly code: string; readonly exitCode: number | null; readonly kind: 'inconclusive' };

function classifyReplay(
  result: ChildResult,
  target: PublicationToVerify,
  mode: ReplayMode,
): ReplayOutcome {
  const line = result.timedOut ? null : stdoutLine(result.stdout);
  if (result.exitCode === 0 && !result.timedOut) {
    const passed = replayPassedSchema.safeParse(line);
    if (
      passed.success &&
      passed.data.dataset_id === target.dataset_id &&
      passed.data.publication_id === target.publication_id &&
      passed.data.mode === mode
    ) {
      return { kind: 'passed', report: passed.data };
    }
    return { code: 'REPLAY_OUTPUT_INVALID', exitCode: 0, kind: 'inconclusive' };
  }
  if (result.exitCode === 1 && !result.timedOut) {
    const failed = replayFailedSchema.safeParse(line);
    if (!failed.success) {
      return { code: 'REPLAY_OUTPUT_INVALID', exitCode: 1, kind: 'inconclusive' };
    }
    if (failed.data.code === 'STORAGE_UNAVAILABLE') {
      return { kind: 'storage' };
    }
    if (failed.data.code === 'UNEXPECTED') {
      return { code: 'UNEXPECTED', exitCode: 1, kind: 'inconclusive' };
    }
    return {
      code: failed.data.code,
      kind: 'failed',
      maxRssBytes: failed.data.max_rss_bytes ?? null,
    };
  }
  if (result.timedOut) {
    return { code: 'CHILD_TIMEOUT', exitCode: null, kind: 'inconclusive' };
  }
  if (result.exitCode === null) {
    return { code: 'CHILD_KILLED', exitCode: null, kind: 'inconclusive' };
  }
  if (result.exitCode === 2) {
    // Un error de uso o de configuración no es del dataset: lo arregla un cambio del código.
    return { kind: 'config' };
  }
  return { code: 'REPLAY_OUTPUT_INVALID', exitCode: result.exitCode, kind: 'inconclusive' };
}

/**
 * Paso 7 (ADR-0020 §8): para la publicación activa de `production` más antigua sin resultado en los
 * dos modos, `data:replay` en un proceso aparte, con `buoh_salud` y el token `salud`, primero con
 * `--verify-only` y después en recomputación, los modos que le falten, los dos dentro de los 60 s
 * del paso. Guarda cada resultado en `buoh_datasets.dataset_verifications`, como `buoh_dueno`:
 *
 * - `passed`, la salida 0 con su informe saneado (el `ReplayReport`, sin precios, y su memoria);
 * - `failed`, la salida 1 de un fallo de integridad, de contrato, de versión o de recomputación,
 *   con su código, y la alerta `dataset_verification_failed`;
 * - `incomplete`, a la tercera ejecución seguida sin un resultado concluyente en ese modo (un plazo
 *   vencido, un proceso que muere, `UNEXPECTED` o una salida sin su línea), con la misma alerta: el
 *   modo ya tiene resultado, y el paso sigue.
 *
 * Un almacén que no responde (`STORAGE_UNAVAILABLE`) o una salida 2, un error de uso o de
 * configuración (`replay_config_invalid`), no guardan nada ni cuentan: el paso falla y lo intenta en
 * la ejecución siguiente. La cuenta va en el informe del paso, como en el 6. El paso
 * falla si no consiguió un resultado concluyente; un `failed` o un `incomplete` son resultados, con
 * su alerta. El informe se guarda si ejecutó algo o falló.
 */
export async function datasetVerificationStep(
  input: OperationsInput,
  startedAt: string,
  runId: string,
): Promise<StepOutcome> {
  if (tooLate(input, startedAt)) {
    return DEFERRED;
  }
  const stepStartedMs = Date.parse(input.now());
  let target: PublicationToVerify | null;
  let loaded: VerificationState | 'invalid';
  try {
    const logs = await input.database.listLogs();
    loaded = await loadState(input, logs, DATASET_VERIFICATION_STEP, verificationStateSchema, {
      attempts: null,
    });
    target = await input.database.nextPublicationToVerify();
  } catch (error) {
    return { log: null, report: { reason: failureReason(error) }, status: 'failed', store: true };
  }
  if (loaded === 'invalid') {
    return {
      log: null,
      report: { reason: 'verification_state_invalid' },
      status: 'failed',
      store: true,
    };
  }
  if (target === null) {
    return { log: null, report: { dataset_id: null }, status: 'completed', store: false };
  }
  const verified = target;
  let { attempts } = loaded;
  if (attempts !== null && attempts.publication_id !== verified.publication_id) {
    attempts = null;
  }
  const results: Report[] = [];
  let reason: string | null = null;
  const modes = (['verify-only', 'recompute'] as const).filter(
    (mode) => !verified.modes_done.includes(mode),
  );
  for (const mode of modes) {
    const remaining = DATASETS_STEP_DEADLINE_MS - (Date.parse(input.now()) - stepStartedMs);
    if (remaining <= 0) {
      reason = 'deadline_exceeded';
      break;
    }
    const child = await input.runChild(
      'replay',
      ['--dataset', verified.dataset_id, ...(mode === 'verify-only' ? ['--verify-only'] : [])],
      replayEnvironment(input.config),
      { timeoutMs: remaining },
    );
    if (child.stderr.length > 0) {
      input.forwardChildStderr(child.stderr);
    }
    const outcome = classifyReplay(child, verified, mode);
    const row = (fields: {
      error_code: string | null;
      exit_code: number | null;
      report: Report | null;
      status: 'failed' | 'incomplete' | 'passed';
    }) =>
      input.database.appendDatasetVerification({
        dataset_id: verified.dataset_id,
        mode,
        publication_id: verified.publication_id,
        run_id: runId,
        verification_id: input.nextId(),
        verified_at_utc: input.now(),
        ...fields,
      });
    try {
      if (outcome.kind === 'storage') {
        results.push({ mode, status: 'storage_unavailable' });
        reason = 'storage_unavailable';
        break;
      }
      if (outcome.kind === 'config') {
        results.push({ mode, status: 'replay_config_invalid' });
        reason = 'replay_config_invalid';
        break;
      }
      if (outcome.kind === 'passed') {
        await row({ error_code: null, exit_code: 0, report: outcome.report, status: 'passed' });
        results.push({
          max_rss_bytes: outcome.report['max_rss_bytes'] ?? null,
          mode,
          status: 'passed',
        });
        if (attempts?.mode === mode) {
          attempts = null;
        }
        continue;
      }
      if (outcome.kind === 'failed') {
        await row({
          error_code: outcome.code,
          exit_code: 1,
          report: {
            code: outcome.code,
            dataset_id: verified.dataset_id,
            max_rss_bytes: outcome.maxRssBytes,
            mode,
          },
          status: 'failed',
        });
        results.push({ error_code: outcome.code, mode, status: 'failed' });
        input.alert({
          dataset_id: verified.dataset_id,
          error_code: outcome.code,
          event: 'dataset_verification_failed',
          mode,
        });
        if (attempts?.mode === mode) {
          attempts = null;
        }
        continue;
      }
      const next = attempts?.mode === mode ? attempts.count + 1 : 1;
      if (next < INCONCLUSIVE_RUNS) {
        attempts = { count: next, mode, publication_id: verified.publication_id };
        results.push({ attempts: next, error_code: outcome.code, mode, status: 'inconclusive' });
        reason = outcome.code.toLowerCase();
        break;
      }
      await row({
        error_code: outcome.code,
        exit_code: outcome.exitCode === 0 ? null : outcome.exitCode,
        report: null,
        status: 'incomplete',
      });
      results.push({ error_code: outcome.code, mode, status: 'incomplete' });
      input.alert({
        dataset_id: verified.dataset_id,
        error_code: outcome.code,
        event: 'dataset_verification_failed',
        mode,
      });
      attempts = null;
    } catch (error) {
      reason = failureReason(error);
      break;
    }
  }
  return {
    log: null,
    report: {
      dataset_id: verified.dataset_id,
      publication_id: verified.publication_id,
      ...(reason === null ? {} : { reason }),
      results,
      state: { attempts },
    },
    status: reason === null ? 'completed' : 'failed',
    store: true,
  };
}
