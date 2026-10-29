import { ConfigError, loadConfig, type WorkerConfig } from '../config.js';
import { type Scheduler } from '../deriv/ports.js';
import { DERIV_SOURCE } from '../deriv/profile.js';
import { type ExpectedSchemaArchive } from '../deriv/schema-archive.js';
import { parseHealthArgs } from '../health-args.js';
import { UsageError } from '../replay-args.js';
import { evaluateDataHealth, type HealthEvaluation } from './evaluate.js';
import { observeDataHealth, type HealthStores } from './observe.js';

/** Las lecturas de `data:health` ya abiertas, y cómo liberar sus conexiones. */
export interface HealthCommandStores extends HealthStores {
  close(): Promise<void>;
}

/** Lo que necesita `healthCommand`: la hora, los IDs y cómo abrir sus almacenes. */
export interface HealthDependencies {
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  /** UUIDv7 para el cierre que la regla 4 añade en memoria. */
  readonly nextId: () => string;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  /**
   * Abre las lecturas con esa configuración, ya comprobada: `openHealthStores` en `data:health`,
   * sobre `openStores` y su pool.
   */
  readonly openStores: (config: WorkerConfig) => HealthCommandStores;
  /** El temporizador del plazo total y del cierre; en `data:health`, el real. */
  readonly scheduler: Scheduler;
}

/**
 * El plazo total de la observación y la evaluación, en milisegundos. Si no terminan antes, el
 * informe es el de la regla 3 con el motivo `deadline_exceeded` (ADR-0015 §8): un almacén no
 * contestó a tiempo.
 */
export const HEALTH_DEADLINE_MS = 30_000;
/** Lo que espera, como mucho, al cierre de los almacenes, después del plazo total o no. */
export const HEALTH_CLOSE_DEADLINE_MS = 5_000;

/** Las líneas que escribe `data:health`, sin el salto final, y su código de salida. */
export interface HealthCommandResult {
  /** 0 si la salud es `healthy`, 1 si es otra y 2 en la regla 1 (ADR-0015 §8, «Salida»). */
  readonly exitCode: 0 | 1 | 2;
  /** La línea de stderr: la alerta de las reglas 2 y 3, el error de la regla 1, o `null`. */
  readonly stderr: string | null;
  /** La línea de stdout: el `HealthReport`, o `null` en la regla 1, que no tiene informe. */
  readonly stdout: string | null;
}

/**
 * El motivo de un error de programación al observar o al evaluar. Nada de lo observado es fiable,
 * así que el informe es `failed`, como en la regla 2, y nunca lleva el mensaje del error.
 */
const UNEXPECTED_ERROR = 'unexpected_error';

/** El motivo de la regla 3 cuando la observación y la evaluación no terminan en el plazo total. */
const DEADLINE_EXCEEDED = 'deadline_exceeded';

/**
 * Lo que da `work`, o lo que da `onDeadline` si `work` no termina en `ms` milisegundos del
 * temporizador. Si termina antes, cancela el temporizador; si no, `work` sigue sin que nadie lo
 * espere.
 */
function withinDeadline<T>(
  scheduler: Scheduler,
  ms: number,
  work: Promise<T>,
  onDeadline: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = scheduler.schedule(ms, () => {
      resolve(onDeadline());
    });
    work.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Observa la fuente con los almacenes ya abiertos y evalúa lo observado. */
async function observeAndEvaluate(
  dependencies: HealthDependencies,
  stores: HealthCommandStores,
  input: { readonly environment: WorkerConfig['environment']; readonly symbol: string },
): Promise<HealthEvaluation> {
  const observation = await observeDataHealth({
    environment: input.environment,
    ...(dependencies.expected === undefined ? {} : { expected: dependencies.expected }),
    nextId: dependencies.nextId,
    now: dependencies.now,
    stores,
    symbol: input.symbol,
  });
  return evaluateDataHealth(observation);
}

/**
 * `pnpm run data:health -- --json [--symbol R_100]` completo, sin efectos propios (ADR-0015 §8):
 * interpreta los argumentos, carga la configuración, abre las lecturas, observa la fuente sin tomar
 * el bloqueo ni escribir nada, la evalúa y devuelve las líneas de stdout y stderr y el código de
 * salida. Cierra los almacenes al terminar, de cualquier forma, y no espera ese cierre más de
 * `HEALTH_CLOSE_DEADLINE_MS`.
 *
 * - Argumentos o variables de entorno inválidos (`UsageError`, `ConfigError`, regla 1): salida 2,
 *   nada en stdout y en stderr una línea con `code` y el mensaje, que solo nombra variables, sin
 *   abrir nada.
 * - Si no, stdout lleva el `HealthReport` y stderr la alerta saneada de las reglas 2 y 3, si la hay.
 *   Un error de programación da el informe `failed` con la alerta `unexpected_error`.
 * - Si la observación y la evaluación no terminan en `HEALTH_DEADLINE_MS`, el informe es el de la
 *   regla 3 (`paused`) con la alerta `deadline_exceeded`, sin esperarlas más.
 */
export async function healthCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: HealthDependencies,
): Promise<HealthCommandResult> {
  let symbol: string;
  let config: WorkerConfig;
  try {
    ({ symbol } = parseHealthArgs(argv));
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      return {
        exitCode: 2,
        stderr: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
        stdout: null,
      };
    }
    throw error;
  }
  const { scheduler } = dependencies;
  let stores: HealthCommandStores | null = null;
  let evaluation: HealthEvaluation;
  try {
    stores = dependencies.openStores(config);
    evaluation = await withinDeadline(
      scheduler,
      HEALTH_DEADLINE_MS,
      observeAndEvaluate(dependencies, stores, { environment: config.environment, symbol }),
      () =>
        evaluateDataHealth({
          reason: DEADLINE_EXCEEDED,
          source: DERIV_SOURCE,
          status: 'storage_unavailable',
        }),
    );
  } catch {
    evaluation = evaluateDataHealth({
      reason: UNEXPECTED_ERROR,
      source: DERIV_SOURCE,
      status: 'incompatible',
    });
  } finally {
    if (stores !== null) {
      await withinDeadline(scheduler, HEALTH_CLOSE_DEADLINE_MS, stores.close(), () => undefined);
    }
  }
  return {
    exitCode: evaluation.exitCode,
    stderr: evaluation.alert === null ? null : JSON.stringify(evaluation.alert),
    stdout: JSON.stringify(evaluation.report),
  };
}
