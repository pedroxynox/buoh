import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { buildApp } from '../app.js';
import { ApiConfigError, loadApiConfig } from '../config.js';
import { errorName, jsonLines } from '../log.js';
import { serve } from '../serve.js';

/**
 * `node apps/api/dist/cli/serve.js`: arranca la API (ADR-0019 §10). Escribe una línea JSON por
 * evento en stdout. Salida 2: configuración inválida, con los nombres de las variables; 1: no pudo
 * escuchar o no pudo cerrar.
 */
const log = jsonLines((text) => process.stdout.write(text));

let config;
try {
  config = loadApiConfig(process.env);
} catch (error) {
  if (!(error instanceof ApiConfigError)) {
    throw error;
  }
  process.stderr.write(
    `${JSON.stringify({ event: 'api_config_error', variables: error.variables })}\n`,
  );
  process.exitCode = 2;
}

if (config !== undefined) {
  const app = buildApp({
    log,
    now: () => performance.now(),
    requestId: () => randomUUID(),
  });
  try {
    await serve({
      app,
      config,
      log,
      onSignal: (signal, listener) => process.once(signal, listener),
      setExitCode: (code) => {
        process.exitCode = code;
      },
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: 'api_listen_failed', error: errorName(error) })}\n`,
    );
    process.exitCode = 1;
    await app.close().catch(() => undefined);
  }
}
