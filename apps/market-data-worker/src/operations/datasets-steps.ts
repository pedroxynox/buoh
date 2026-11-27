import {
  datasetIdSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
  type JsonValue,
} from '@buoh/contracts';
import { z } from 'zod';

import { failureReason } from '../source-log/source-event-log.js';
import {
  isLogExpired,
  LOG_SEQUENCES,
  R_100_SEQUENCE,
  ROUND_BATCH_SEQUENCES,
  type CaptureLog,
  type LogSequence,
} from '../successive-logs.js';
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
/**
 * La secuencia que publica el paso 6, la única con umbrales medidos (ADR-0020 §1): pasa su símbolo a
 * `datasets:publish` (`--symbol`). En el estado, solo un log de otra secuencia lleva `sequence`;
 * uno sin ella es de R_100 (`storedState`; ADR-0021 §1).
 * El PR 7 de ADR-0021 §9 publica también el oro.
 */
export const PUBLISHED_SEQUENCE = R_100_SEQUENCE;
/**
 * Las secuencias por lotes que publica el paso 6 después de la de `PUBLISHED_SEQUENCE`, con el tiempo
 * que sobra (ADR-0021 §3; precisión del PR 5d2 de su §9): pasa su nombre a `datasets:publish`
 * (`--sequence`). Una por ejecución, por turnos (`BATCH_PUBLICATION_TURN_MS`), entre las que tienen
 * algún log que no venció. No están las dos historias, que publica su propio comando (precisión del
 * PR 6c de ADR-0021 §9).
 */
export const PUBLISHED_BATCH_SEQUENCES: readonly LogSequence[] = ROUND_BATCH_SEQUENCES;
/** El turno de cada secuencia por lotes: el de cada ejecución de `buoh-operaciones`, cada 5 minutos. */
export const BATCH_PUBLICATION_TURN_MS = 300_000;
/**
 * Lo que tiene que quedar de los 60 s del paso para lanzar los lotes: más que lo que tardó como
 * mucho en producción la publicación de un dataset vivo de unos 72 segmentos, 20,2 s (evidencia de
 * los datasets vivos, «Memoria y duración de cada proceso»). Con menos, esa ejecución no lanza los
 * lotes, y la secuencia lo intenta en su turno siguiente.
 */
export const BATCH_PUBLICATION_MIN_MS = 25_000;
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
/**
 * La secuencia de cada línea de `datasets:publish`: una de las que publica el paso. Tiene que ser la
 * que pidió (`classifyPublish`).
 */
const publishedSequence = z.enum([
  PUBLISHED_SEQUENCE.name,
  ...PUBLISHED_BATCH_SEQUENCES.map((sequence) => sequence.name),
] as [string, ...string[]]);

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
  sequence: publishedSequence,
  source_event_count: count.optional(),
  status: z.enum(['already_published', 'published']),
});
const nothingDueLineSchema = z.object({
  ...measured,
  behind: behindSchema.nullable(),
  sequence: publishedSequence,
  status: z.literal('nothing_due'),
});
const failedLineSchema = z.object({
  ...measured,
  behind: behindSchema.nullable().optional(),
  detail: sanitized,
  first_segment: count.optional(),
  log: logNumber.nullable(),
  reason: sanitized,
  sequence: publishedSequence,
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

/**
 * La secuencia de un log del estado (ADR-0021 §1). Los de R_100 se guardan sin ella, como antes de
 * las secuencias (`storedState`), así que una entrada sin ella es de R_100.
 */
const stateSequence = z
  .enum(LOG_SEQUENCES.map((item) => item.name) as [string, ...string[]])
  .default(R_100_SEQUENCE.name);
/** Un log detenido: el dataset que no se pudo publicar, por qué y con qué código. */
const stopSchema = z.strictObject({
  code_version: z.string().regex(CODE_VERSION).nullable(),
  first_segment: count,
  log: logNumber,
  reason: z.enum(PUBLICATION_STOP_REASONS),
  sequence: stateSequence,
});
type Stop = z.infer<typeof stopSchema>;
const publicationStateSchema = z.strictObject({
  /** Las ejecuciones seguidas sin un resultado concluyente con ese dataset. */
  attempts: z
    .strictObject({ count, first_segment: count, log: logNumber, sequence: stateSequence })
    .nullable(),
  stopped: z.array(stopSchema),
});
type PublicationState = z.infer<typeof publicationStateSchema>;
/** Una cuenta sin resultado: el dataset, por su log y su primer segmento, y las ejecuciones. */
type Attempts = NonNullable<PublicationState['attempts']>;
/**
 * Las cuentas sin resultado de los lotes (precisión del PR 5d2 de ADR-0021 §9), una por secuencia,
 * en `batch_state` del informe y no en `state`: así no comparten la de R_100 ni se sustituyen entre
 * ellas, y el código anterior, que solo lee `state`, no las ve.
 */
const batchPublicationStateSchema = z.strictObject({
  attempts: z
    .array(
      z.strictObject({
        count,
        first_segment: count,
        log: logNumber,
        sequence: z.enum(
          PUBLISHED_BATCH_SEQUENCES.map((sequence) => sequence.name) as [string, ...string[]],
        ),
      }),
    )
    .refine(
      (items) => new Set(items.map((item) => item.sequence)).size === items.length,
      'Una cuenta por secuencia.',
    ),
});
type BatchPublicationState = z.infer<typeof batchPublicationStateSchema>;

/**
 * El estado como se guarda en el informe: los logs de R_100 sin `sequence`, como antes de las
 * secuencias, para que el paso 6 del código anterior, cuyo esquema no admite otros campos, lo siga
 * leyendo si Render vuelve atrás un despliegue (ADR-0018 §5). Los de otra secuencia la llevan. Al
 * leerlo, uno sin secuencia es de R_100 (`stateSequence`).
 */
function storedState(state: PublicationState): Report {
  const stored = (item: Readonly<Record<string, JsonValue>>): Report => {
    const { sequence, ...rest } = item;
    return sequence === R_100_SEQUENCE.name ? rest : { ...item };
  };
  return {
    attempts: state.attempts === null ? null : stored(state.attempts),
    stopped: state.stopped.map(stored),
  };
}

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
export function stdoutLine(stdout: string): unknown {
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
 * El informe más reciente del paso que lleva estado, de cualquier log que se puede leer: el de mayor
 * `report_id`, un UUIDv7, que crece con el tiempo. `null` sin ninguno.
 */
async function latestStateReport(
  input: OperationsInput,
  logs: readonly CaptureLog[],
  step: string,
): Promise<JsonValue | null> {
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
  return latest?.report ?? null;
}

/** Un campo del informe con su forma: sin informe, `empty`; con otra forma, `invalid`. */
function reportField<T>(
  report: JsonValue | null,
  field: string,
  schema: z.ZodType<T>,
  empty: T,
): T | 'invalid' {
  if (report === null) {
    return empty;
  }
  const value = typeof report === 'object' && !Array.isArray(report) ? report[field] : undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : 'invalid';
}

/**
 * El estado que dejó el informe más reciente del paso, de cualquier log que se puede leer
 * (`latestStateReport`). Sin ninguno, el estado vacío. `invalid` si el informe no tiene la forma que
 * escribe el paso. Lo usan también los lotes (`batch-steps.ts`).
 */
export async function loadState<T>(
  input: OperationsInput,
  logs: readonly CaptureLog[],
  step: string,
  schema: z.ZodType<T>,
  empty: T,
): Promise<T | 'invalid'> {
  return reportField(await latestStateReport(input, logs, step), 'state', schema, empty);
}

/** Por qué un proceso no dio una línea concluyente: su plazo, una señal o su salida. */
export function childFailure(result: ChildResult, invalid: string): string {
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

/** Clasifica lo que dio `datasets:publish` con la secuencia `sequence`; una línea de otra no vale. */
function classifyPublish(result: ChildResult, sequence: string): PublishResult {
  const parsed = result.timedOut ? null : publishLineSchema.safeParse(stdoutLine(result.stdout));
  const line = parsed?.success === true && parsed.data.sequence === sequence ? parsed.data : null;
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
 * Paso 6 (ADR-0020 §8): `datasets:publish --symbol R_100` en un proceso aparte, con
 * `buoh_publicacion`, el token `operaciones` y un plazo de 60 s, que publica como mucho un dataset
 * de los logs de esa secuencia (`PUBLISHED_SEQUENCE`; ADR-0021 §1). Una línea de otra secuencia no
 * es concluyente (`publish_output_invalid`).
 *
 * - **Los lotes, después** (ADR-0021 §3; precisión del PR 5d2 de su §9). Si R_100 no tiene nada
 *   pendiente (`nothing_due`), la ejecución lleva menos de `DATASETS_START_LIMIT_MS` y quedan al
 *   menos `BATCH_PUBLICATION_MIN_MS` de los 60 s del paso, busca los logs de las secuencias por
 *   lotes y publica como mucho un dataset de una de ellas, con `datasets:publish --sequence
 *   <nombre>` y lo que queda del plazo. Le toca a una por ejecución, por turnos
 *   (`BATCH_PUBLICATION_TURN_MS`), entre las de `PUBLISHED_BATCH_SEQUENCES` que tienen algún log que
 *   no venció y se puede leer. Sin ninguna, no lanza nada. Si al lanzarlo ya no quedan
 *   `BATCH_PUBLICATION_MIN_MS`, no lo lanza, y la secuencia lo intenta en su turno siguiente.
 * - **Logs detenidos.** Un log se detiene cuando su publicación falla por una causa que repetir no
 *   cambia (`PUBLICATION_STOP_REASONS`), y sigue detenido mientras el código es el mismo
 *   (`codeVersion`, el commit que da Render): la orden de su secuencia lo salta (`--skip`), y el
 *   paso deja su alerta, con el nombre del motivo y la secuencia, en cada ejecución. Un log que
 *   venció o ya no existe deja de contar, y uno de una secuencia que el paso no publica también.
 * - **Sin un resultado concluyente.** Un plazo vencido, un proceso que muere, una salida sin su
 *   línea o un error inesperado (`unexpected`) cuentan como una ejecución sin resultado del dataset
 *   que intentaba, que dicen su línea o su aviso `publication_attempt`. A la tercera seguida con el
 *   mismo dataset, el log se detiene con `publication_incomplete`. Un almacén que no responde o un
 *   `COMMIT` ambiguo se repiten sin contar; una publicación, o nada pendiente, ponen la cuenta a
 *   cero. Cada secuencia lleva su cuenta: la de R_100 en `state`, como antes, y la de cada secuencia
 *   por lotes en `batch_state`, que el código anterior no lee. La tercera seguida de sus turnos con
 *   el mismo dataset detiene su log.
 * - **Atraso.** Con `behind`, también en una línea `failed`, la alerta `publication_behind`, con su
 *   secuencia.
 *
 * El estado va en el informe del paso, en el log activo de R_100, y la ejecución siguiente lo lee del
 * más reciente de cualquier log que lo lleva: el informe de un fallo de antes de leerlo no lo lleva,
 * y no lo cambia. El paso falla si una orden falló o hay algún log detenido. El informe se guarda si
 * publicó, si el paso falló o si el estado cambió; lo de los lotes va en su `batch`.
 */
export async function publicationStep(
  input: OperationsInput,
  startedAt: string,
): Promise<StepOutcome> {
  if (tooLate(input, startedAt)) {
    return DEFERRED;
  }
  const stepStartedMs = Date.parse(input.now());
  let logs: CaptureLog[];
  let loaded: PublicationState | 'invalid';
  let loadedBatch: BatchPublicationState | 'invalid';
  try {
    // El estado va en los informes del paso, en el log activo de R_100.
    logs = await input.database.listLogs(R_100_SEQUENCE);
    const report = await latestStateReport(input, logs, PUBLICATION_STEP);
    loaded = reportField(report, 'state', publicationStateSchema, { attempts: null, stopped: [] });
    // Un informe sin `batch_state`, como los de antes del 5d2, no tiene cuenta de los lotes.
    loadedBatch = reportField(
      report,
      'batch_state',
      batchPublicationStateSchema.optional(),
      undefined,
    ) ?? { attempts: [] };
  } catch (error) {
    return { log: null, report: { reason: failureReason(error) }, status: 'failed', store: true };
  }
  if (loaded === 'invalid' || loadedBatch === 'invalid') {
    return {
      log: null,
      report: { reason: 'publication_state_invalid' },
      status: 'failed',
      store: true,
    };
  }
  const notExpired = (of: readonly CaptureLog[]) => {
    const now = input.now();
    return new Set(of.filter((log) => !isLogExpired(log, now)).map((log) => log.location.number));
  };
  const code = input.config.codeVersion;
  const sequence = PUBLISHED_SEQUENCE.name;
  const batchNames: ReadonlySet<string> = new Set(
    PUBLISHED_BATCH_SEQUENCES.map((item) => item.name),
  );
  // Los logs de la secuencia que publica primero: `logs` son los de R_100, que es esa.
  const liveLogs = notExpired(logs);
  const state: { attempts: PublicationState['attempts']; stopped: Stop[] } = {
    attempts:
      loaded.attempts !== null &&
      loaded.attempts.sequence === sequence &&
      liveLogs.has(loaded.attempts.log)
        ? loaded.attempts
        : null,
    // Los de R_100, con sus logs que no vencieron; los de los lotes, hasta que se buscan sus logs.
    stopped: loaded.stopped.filter(
      (stop) =>
        stop.code_version === code &&
        (stop.sequence === sequence ? liveLogs.has(stop.log) : batchNames.has(stop.sequence)),
    ),
  };
  const batchState: BatchPublicationState = { attempts: [...loadedBatch.attempts] };
  /** La cuenta de una secuencia por lotes, que solo cambia la suya. */
  const batchCounter = (of: string) => ({
    get: () => batchState.attempts.find((item) => item.sequence === of) ?? null,
    set: (value: Attempts | null) => {
      batchState.attempts = [
        ...batchState.attempts.filter((item) => item.sequence !== of),
        ...(value === null ? [] : [value]),
      ].sort((left, right) => sequenceOrder(left.sequence) - sequenceOrder(right.sequence));
    },
  });

  /** Una orden de `datasets:publish` de una secuencia, con su cuenta, y lo que dio. */
  const publish = async (
    of: string,
    selector: readonly string[],
    timeoutMs: number,
    counter: { get(): Attempts | null; set(value: Attempts | null): void },
  ): Promise<{
    readonly behind: z.infer<typeof behindSchema> | null;
    readonly failed: boolean;
    readonly kind: PublishResult['kind'];
    readonly outcome: Report;
    readonly skipped: number[];
  }> => {
    const skipped = [
      ...new Set(state.stopped.filter((stop) => stop.sequence === of).map((stop) => stop.log)),
    ].sort((a, b) => a - b);
    const result = await input.runChild(
      'publish',
      [...selector, ...(skipped.length === 0 ? [] : ['--skip', skipped.join(',')])],
      publishEnvironment(input.config),
      { timeoutMs },
    );
    if (result.stderr.length > 0) {
      input.forwardChildStderr(result.stderr);
    }
    const classified = classifyPublish(result, of);
    const current = counter.get();
    const mine = current?.sequence === of ? current : null;
    switch (classified.kind) {
      case 'published': {
        const { behind, ...rest } = classified.line;
        if (mine !== null) {
          counter.set(null);
        }
        return {
          behind,
          failed: false,
          kind: classified.kind,
          outcome: Object.fromEntries(
            Object.entries(rest).filter((entry) => entry[1] !== undefined),
          ) as Report,
          skipped,
        };
      }
      case 'nothing_due':
        if (mine !== null) {
          counter.set(null);
        }
        return {
          behind: classified.line.behind,
          failed: false,
          kind: classified.kind,
          outcome: { status: 'nothing_due' },
          skipped,
        };
      case 'stop':
      case 'repeat':
      case 'inconclusive':
      case 'invalid': {
        const stopLog = (
          dataset: { first_segment: number; log: number },
          reason: Stop['reason'],
        ) => {
          state.stopped = [
            ...state.stopped.filter((stop) => stop.sequence !== of || stop.log !== dataset.log),
            { code_version: code, ...dataset, reason, sequence: of },
          ];
        };
        if (classified.kind === 'stop' && classified.dataset !== null) {
          stopLog(classified.dataset, classified.report['reason'] as Stop['reason']);
          if (mine !== null) {
            counter.set(null);
          }
        } else if (classified.kind === 'inconclusive' && classified.dataset !== null) {
          const { dataset } = classified;
          const same =
            mine !== null &&
            mine.log === dataset.log &&
            mine.first_segment === dataset.first_segment;
          const next = same ? mine.count + 1 : 1;
          if (next >= INCONCLUSIVE_RUNS) {
            stopLog(dataset, 'publication_incomplete');
            counter.set(null);
          } else {
            counter.set({ count: next, ...dataset, sequence: of });
          }
        }
        return {
          behind: classified.kind === 'invalid' ? null : classified.behind,
          failed: true,
          kind: classified.kind,
          outcome: { status: 'failed', ...classified.report },
          skipped,
        };
      }
    }
  };

  const first = await publish(sequence, ['--symbol', sequence], DATASETS_STEP_DEADLINE_MS, {
    get: () => state.attempts,
    set: (value) => {
      state.attempts = value;
    },
  });
  // Los lotes, solo si R_100 no tiene nada pendiente y queda tiempo (ADR-0021 §3).
  let batch:
    | (Awaited<ReturnType<typeof publish>> & { readonly sequence: string })
    | { readonly failure: string }
    | null = null;
  /** Lo que queda de los 60 s del paso. */
  const remaining = () => DATASETS_STEP_DEADLINE_MS - (Date.parse(input.now()) - stepStartedMs);
  if (
    first.kind === 'nothing_due' &&
    remaining() >= BATCH_PUBLICATION_MIN_MS &&
    !tooLate(input, startedAt)
  ) {
    try {
      const candidates: LogSequence[] = [];
      const live = new Map<string, Set<number>>();
      for (const item of PUBLISHED_BATCH_SEQUENCES) {
        const found = await input.database.listLogs(item);
        live.set(item.name, notExpired(found));
        // `datasets:publish` solo publica los que se pueden leer.
        if (notExpired(found.filter((log) => log.readable)).size > 0) {
          candidates.push(item);
        }
      }
      const isLive = (name: string, log: number) => live.get(name)?.has(log) === true;
      state.stopped = state.stopped.filter(
        (stop) => stop.sequence === sequence || isLive(stop.sequence, stop.log),
      );
      // La cuenta de un log que venció o ya no existe deja de contar.
      batchState.attempts = batchState.attempts.filter((item) => isLive(item.sequence, item.log));
      const turn =
        candidates[
          Math.floor(Date.parse(startedAt) / BATCH_PUBLICATION_TURN_MS) % candidates.length
        ];
      // El mínimo, otra vez después de buscar los logs: si ya no queda, en su turno siguiente.
      const left = remaining();
      if (turn !== undefined && left >= BATCH_PUBLICATION_MIN_MS) {
        batch = {
          ...(await publish(turn.name, ['--sequence', turn.name], left, batchCounter(turn.name))),
          sequence: turn.name,
        };
      }
    } catch (error) {
      batch = { failure: failureReason(error) };
    }
  }
  state.stopped.sort(
    (left, right) =>
      sequenceOrder(left.sequence) - sequenceOrder(right.sequence) || left.log - right.log,
  );

  for (const stop of state.stopped) {
    input.alert({
      event: stop.reason,
      first_segment: String(stop.first_segment),
      log: String(stop.log),
      sequence: stop.sequence,
    });
  }
  const ran = batch !== null && 'sequence' in batch ? batch : null;
  for (const [behind, of] of [
    [first.behind, sequence],
    [ran?.behind ?? null, ran?.sequence ?? sequence],
  ] as const) {
    if (behind !== null) {
      input.alert({
        event: 'publication_behind',
        expires_at_utc: behind.expires_at_utc,
        log: String(behind.log),
        sequence: of,
      });
    }
  }
  const next: PublicationState = { attempts: state.attempts, stopped: state.stopped };
  const changed =
    JSON.stringify(storedState(next)) !== JSON.stringify(storedState(loaded)) ||
    JSON.stringify(batchState) !== JSON.stringify(loadedBatch);
  const failureOf = (outcome: Report) =>
    typeof outcome['reason'] === 'string' ? outcome['reason'] : null;
  const batchFailure =
    batch === null ? null : 'failure' in batch ? batch.failure : failureOf(batch.outcome);
  const reason = failureOf(first.outcome) ?? batchFailure ?? state.stopped[0]?.reason ?? null;
  const failed =
    first.failed ||
    (batch !== null && ('failure' in batch || batch.failed)) ||
    next.stopped.length > 0;
  return {
    log: null,
    report: {
      behind: first.behind,
      code_version: code,
      ...(reason === null ? {} : { reason }),
      result: first.outcome,
      skipped: first.skipped,
      ...(batch === null
        ? {}
        : {
            batch:
              'failure' in batch
                ? { reason: batch.failure, status: 'failed' }
                : {
                    behind: batch.behind,
                    result: batch.outcome,
                    sequence: batch.sequence,
                    skipped: batch.skipped,
                  },
          }),
      // Sin cuenta, no hace falta: un informe sin `batch_state` no la tiene.
      ...(batchState.attempts.length === 0
        ? {}
        : { batch_state: { attempts: batchState.attempts } }),
      state: storedState(next),
    },
    status: failed ? 'failed' : 'completed',
    // Siempre que falla (§8), también con un log detenido y nada nuevo; y si el estado cambió.
    store: failed || first.kind === 'published' || ran?.kind === 'published' || changed,
  };
}

/** El orden de una secuencia en `LOG_SEQUENCES`, para ordenar los logs detenidos. */
function sequenceOrder(name: string): number {
  return LOG_SEQUENCES.findIndex((item) => item.name === name);
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
 * dos modos, con las de las historias después de las demás (`nextPublicationToVerify`; precisión del
 * PR 6e de ADR-0021 §9), `data:replay` en un proceso aparte, con `buoh_salud` y el token `salud`, primero con
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
    // El estado va en los informes del paso, en el log activo de R_100.
    const logs = await input.database.listLogs(R_100_SEQUENCE);
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
