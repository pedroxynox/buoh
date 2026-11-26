import type { JsonValue } from '@buoh/contracts';
import { z } from 'zod';

import { BATCH_SEQUENCE_STATUSES, batchStateSchema } from '../batch/command.js';
import { failureReason } from '../source-log/source-event-log.js';
import {
  BATCH_SEQUENCES,
  isLogExpired,
  R_100_SEQUENCE,
  selectActiveLog,
  type LogLocation,
  type LogSequence,
} from '../successive-logs.js';
import { batchEnvironment } from './config.js';
import { childFailure, loadState, stdoutLine } from './datasets-steps.js';
import type { OperationsInput, StepOutcome } from './run.js';
import { SANITIZED } from './sanitized.js';

// Los pasos de los lotes de `buoh-operaciones` (ADR-0021 §3; precisión del PR 5c2 de su §9): lanzar
// `batch` en un proceso aparte, con `buoh_lotes` y el token `lotes`, con el estado que dejó la
// ejecución anterior, y guardar el nuevo en su informe; y el informe final de cada log de una
// secuencia por lotes que terminó, en ese log.

/** El paso que lanza `batch` y guarda su estado. */
export const BATCH_STEP = 'batch';
/** El paso del informe final de un log de los lotes. */
export const BATCH_FINAL_STEP = 'batch_final';

type BatchState = z.infer<typeof batchStateSchema>;

/** Lo que el paso lee de cada secuencia de la línea de `batch`; el resto se guarda como llega. */
const sequenceLineSchema = z.looseObject({
  detail: z.string().regex(SANITIZED).nullable(),
  reason: z.string().regex(SANITIZED).nullable(),
  sequence: z.enum(BATCH_SEQUENCES.map((item) => item.name) as [string, ...string[]]),
  status: z.enum(BATCH_SEQUENCE_STATUSES),
});

/** La única línea de stdout de `batch` con salida 0 o 1. */
const batchLineSchema = z.looseObject({
  reason: z.string().regex(SANITIZED).optional(),
  sequences: z.array(sequenceLineSchema),
  state: batchStateSchema,
  status: z.enum(['completed', 'failed']),
});

/**
 * El paso de los lotes: lanza `batch -- --json --state <estado>` con el estado del informe más
 * reciente del paso en los logs de R_100, o el vacío, y guarda en el log activo de R_100 un informe
 * con lo que hizo cada secuencia y el estado nuevo. Con salida 1, el paso falla, y el estado nuevo
 * se guarda igual: el comando lo devuelve también cuando una secuencia falla. Sin una línea válida,
 * como con un proceso cortado por su plazo, el informe no lleva estado, y la ejecución siguiente
 * sigue con el anterior. Un estado guardado que no tiene la forma del comando para el paso sin
 * lanzarlo (`batch_state_invalid`).
 */
export async function batchStep(input: OperationsInput): Promise<StepOutcome> {
  let state: BatchState | 'invalid';
  try {
    const logs = await input.database.listLogs(R_100_SEQUENCE);
    state = await loadState(input, logs, BATCH_STEP, batchStateSchema, {});
  } catch (error) {
    return failed({ reason: failureReason(error) });
  }
  if (state === 'invalid') {
    return failed({ reason: 'batch_state_invalid' });
  }
  const result = await input.runChild(
    'batch',
    ['--json', '--state', JSON.stringify(state)],
    batchEnvironment(input.config),
  );
  input.forwardChildStderr(result.stderr);
  const line =
    result.exitCode === 0 || result.exitCode === 1
      ? batchLineSchema.safeParse(stdoutLine(result.stdout))
      : null;
  if (!line?.success) {
    return failed({
      exit_code: result.exitCode,
      reason: childFailure(
        result,
        result.exitCode === 2 ? 'batch_usage_or_config' : 'batch_output_invalid',
      ),
    });
  }
  const value = line.data;
  const report: Record<string, JsonValue> = {
    sequences: value.sequences as JsonValue[],
    state: value.state as Record<string, JsonValue>,
  };
  if (result.exitCode === 0 && value.status === 'completed') {
    return { log: null, report, status: 'completed', store: true };
  }
  const firstFailed = value.sequences.find((item) => item.status === 'failed');
  return {
    log: null,
    report: { ...report, reason: value.reason ?? firstFailed?.reason ?? 'batch_failed' },
    status: 'failed',
    store: true,
  };
}

function failed(report: Record<string, JsonValue>): StepOutcome {
  return { log: null, report, status: 'failed', store: true };
}

/**
 * El informe final de un log de cada secuencia por lotes que terminó (ADR-0021 §3, «Corte y log
 * activo»), con sus conteos y su último segmento cerrado, en ese log. Un log terminó cuando uno
 * posterior, el activo, tiene una escritura: `batch` cierra el segmento abierto del log que deja
 * antes de escribir en el siguiente. De los que terminaron, que tienen alguna escritura, se pueden
 * leer, no han vencido y todavía no tienen un informe final `completed`, el de menor número, uno
 * por ejecución y secuencia, como el informe final de las secuencias en vivo. Sin ninguno, no
 * guarda nada. Uno que falla se guarda `failed` y se repite en la ejecución siguiente.
 */
export async function batchFinalStep(input: OperationsInput): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const sequence of BATCH_SEQUENCES) {
    outcomes.push(await sequenceBatchFinal(input, sequence));
  }
  return outcomes;
}

async function sequenceBatchFinal(
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
      if ((await input.database.lastCompletedReport(log.location, BATCH_FINAL_STEP)) === null) {
        target = log.location;
        break;
      }
    }
  } catch (error) {
    return failed({ reason: failureReason(error), sequence: sequence.name });
  }
  if (target === null) {
    return {
      log: null,
      report: { log: null, sequence: sequence.name },
      status: 'completed',
      store: false,
    };
  }
  try {
    const summary = await input.database.batchLogSummary(target);
    return {
      log: target,
      report: { ...summary, log: target.number, sequence: sequence.name },
      status: 'completed',
      store: true,
    };
  } catch (error) {
    return {
      log: target,
      report: { log: target.number, reason: failureReason(error), sequence: sequence.name },
      status: 'failed',
      store: true,
    };
  }
}
