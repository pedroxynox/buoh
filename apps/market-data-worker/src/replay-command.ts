import { ConfigError, loadConfig, type WorkerConfig } from './config.js';
import { DATASETS_PREFIX, DATASETS_SCHEMA } from './datasets/location.js';
import { ReplayError } from './errors.js';
import type { MetadataStore, ObjectStore } from './ports.js';
import { parseReplayArgs, UsageError } from './replay-args.js';
import { replayDataset } from './replay.js';
import { productionLogConfigErrors } from './successive-logs.js';

/** Los almacenes que lee `data:replay`. */
export interface ReplayCommandStores {
  readonly metadata: MetadataStore;
  readonly objects: ObjectStore;
  close(): Promise<void>;
}

export interface ReplayCommandDependencies {
  /** El máximo de memoria residente del proceso, en bytes (`process.resourceUsage().maxRSS`). */
  readonly maxRssBytes: () => number;
  readonly openStores: (config: WorkerConfig) => ReplayCommandStores;
}

/**
 * La configuración de `data:replay`. En `production` lee siempre los datasets vivos (ADR-0020 §8):
 * el esquema `buoh_datasets` y el bucket sin prefijo, porque las claves de sus objetos llevan el
 * suyo, `datasets/`, y no admite `BUOH_POSTGRES_SCHEMA`, como `data:health` con el log activo. Fuera
 * de `production`, la de siempre. Con `buoh_datasets`, en cualquier entorno, las claves de los
 * objetos tienen que llevar ese prefijo. Lanza un solo `ConfigError` con todas las variables rechazadas.
 */
function loadReplayConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const production = env['BUOH_DEPLOYMENT_ENVIRONMENT'] === 'production';
  const rejected = new Set<string>(production ? productionLogConfigErrors(env) : []);
  let config: WorkerConfig | null = null;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    for (const variable of error.variables) {
      rejected.add(variable);
    }
  }
  if (config === null || rejected.size > 0) {
    throw new ConfigError([...rejected].sort());
  }
  return production
    ? {
        ...config,
        postgres: { ...config.postgres, schema: DATASETS_SCHEMA },
        s3: { ...config.s3, keyPrefix: '' },
      }
    : config;
}

/**
 * `pnpm run data:replay -- --dataset <id> [--verify-only]` completo: devuelve la línea JSON del
 * informe y el código de salida. Salida 0: reproducido o verificado; 1: integridad, contrato,
 * recomputación, un almacén que no responde o un error inesperado (`UNEXPECTED`, con solo el nombre
 * del error); 2: uso o configuración, sin abrir nada. Las líneas de las salidas 0 y 1 llevan la
 * memoria máxima del proceso (`max_rss_bytes`; ADR-0020 §7).
 */
export async function replayCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: ReplayCommandDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let request;
  let config;
  try {
    request = parseReplayArgs(argv);
    config = loadReplayConfig(env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      return {
        exitCode: 2,
        line: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
      };
    }
    throw error;
  }
  let stores: ReplayCommandStores | null = null;
  try {
    stores = dependencies.openStores(config);
    const report = await replayDataset({
      datasetId: request.datasetId,
      environment: config.environment,
      // Los objetos de buoh_datasets viven bajo su prefijo, en cualquier entorno (ADR-0020 §5).
      ...(config.postgres.schema === DATASETS_SCHEMA ? { keyPrefix: DATASETS_PREFIX } : {}),
      metadata: stores.metadata,
      mode: request.mode,
      objects: stores.objects,
    });
    return {
      exitCode: 0,
      line: JSON.stringify({ ...report, max_rss_bytes: dependencies.maxRssBytes() }),
    };
  } catch (error) {
    const failure =
      error instanceof ReplayError
        ? { code: error.code, details: error.details, message: error.message }
        : { code: 'UNEXPECTED', message: error instanceof Error ? error.name : 'Error' };
    return {
      exitCode: 1,
      line: JSON.stringify({
        ...failure,
        dataset_id: request.datasetId,
        max_rss_bytes: dependencies.maxRssBytes(),
        mode: request.mode,
        status: 'failed',
      }),
    };
  } finally {
    await stores?.close().catch(() => undefined);
  }
}
