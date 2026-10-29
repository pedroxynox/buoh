import { ConfigError, loadConfig, type WorkerConfig } from '../config.js';
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
}

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

/**
 * `pnpm run data:health -- --json [--symbol R_100]` completo, sin efectos propios (ADR-0015 §8):
 * interpreta los argumentos, carga la configuración, abre las lecturas, observa la fuente sin tomar
 * el bloqueo ni escribir nada, la evalúa y devuelve las líneas de stdout y stderr y el código de
 * salida. Cierra los almacenes al terminar, de cualquier forma.
 *
 * - Argumentos o variables de entorno inválidos (`UsageError`, `ConfigError`, regla 1): salida 2,
 *   nada en stdout y en stderr una línea con `code` y el mensaje, que solo nombra variables, sin
 *   abrir nada.
 * - Si no, stdout lleva el `HealthReport` y stderr la alerta saneada de las reglas 2 y 3, si la hay.
 *   Un error de programación da el informe `failed` con la alerta `unexpected_error`.
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
  let stores: HealthCommandStores | null = null;
  let evaluation: HealthEvaluation;
  try {
    stores = dependencies.openStores(config);
    const observation = await observeDataHealth({
      environment: config.environment,
      ...(dependencies.expected === undefined ? {} : { expected: dependencies.expected }),
      nextId: dependencies.nextId,
      now: dependencies.now,
      stores,
      symbol,
    });
    evaluation = evaluateDataHealth(observation);
  } catch {
    evaluation = evaluateDataHealth({
      reason: UNEXPECTED_ERROR,
      source: DERIV_SOURCE,
      status: 'incompatible',
    });
  } finally {
    await stores?.close();
  }
  return {
    exitCode: evaluation.exitCode,
    stderr: evaluation.alert === null ? null : JSON.stringify(evaluation.alert),
    stdout: JSON.stringify(evaluation.report),
  };
}
