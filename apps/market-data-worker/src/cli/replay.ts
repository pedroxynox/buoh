import { ConfigError, loadConfig } from '../config.js';
import { ReplayError } from '../errors.js';
import { replayDataset } from '../replay.js';
import { parseReplayArgs, UsageError } from '../replay-args.js';
import { openStores } from '../runtime.js';

/**
 * `pnpm run data:replay -- --dataset <id> [--verify-only]`. Escribe un informe JSON en stdout.
 * Salida 0: reproducido/verificado; 1: integridad, contrato o recomputación; 2: uso o configuración.
 */
async function main(): Promise<number> {
  let request;
  let config;
  try {
    request = parseReplayArgs(process.argv.slice(2));
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.log(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
      return 2;
    }
    throw error;
  }

  const stores = openStores(config);
  try {
    const report = await replayDataset({
      datasetId: request.datasetId,
      environment: config.environment,
      metadata: stores.metadata,
      mode: request.mode,
      objects: stores.objects,
    });
    console.log(JSON.stringify(report));
    return 0;
  } catch (error) {
    const failure =
      error instanceof ReplayError
        ? { code: error.code, details: error.details, message: error.message }
        : { code: 'UNEXPECTED', message: error instanceof Error ? error.name : 'Error' };
    console.log(
      JSON.stringify({
        ...failure,
        dataset_id: request.datasetId,
        mode: request.mode,
        status: 'failed',
      }),
    );
    return 1;
  } finally {
    await stores.close();
  }
}

process.exitCode = await main();
