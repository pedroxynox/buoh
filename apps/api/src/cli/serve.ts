import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createAccountService } from '../accounts/links.js';
import { createRateLimiter } from '../accounts/limits.js';
import { createLoginFailureBuffer } from '../accounts/login-failures.js';
import { createSessionService } from '../accounts/sessions.js';
import { buildApp } from '../app.js';
import { loadCommonPasswords } from '../auth/common-passwords.js';
import { createPasswordHasher } from '../auth/password-hash.js';
import { ApiConfigError, loadApiConfig } from '../config.js';
import { createDataReader } from '../data/reader.js';
import { createUuidV7Generator } from '../ids.js';
import { errorName, jsonLines } from '../log.js';
import { createPool, createReaderPool, SERVICE_POOL_TIMEOUTS } from '../postgres/pool.js';
import { migrationState } from '../postgres/readiness.js';
import { createReadiness } from '../readiness.js';
import { apiRoutes } from '../routes.js';
import { serve, signalsOf } from '../serve.js';
import { loadWebAssets } from '../web.js';

/**
 * `node apps/api/dist/cli/serve.js`: arranca la API (ADR-0019 §10). Escribe una línea JSON por
 * evento en stdout, y las que impiden arrancar en stderr. Salida 2: configuración inválida, con
 * los nombres de las variables; 1: no pudo escuchar o no pudo cerrar.
 */
const log = jsonLines((text) => process.stdout.write(text));
const errorLog = jsonLines((text) => process.stderr.write(text));

/** Cada cuánto vuelve a mirar sus migraciones mientras faltan (ADR-0019 §7). */
const READINESS_INTERVAL_MS = 5000;
/** Contraseñas que esperan su hash con una en curso (ADR-0019 §1); la siguiente es `rate_limited`. */
const HASHES_WAITING = 4;

let config;
try {
  config = loadApiConfig(process.env);
} catch (error) {
  if (!(error instanceof ApiConfigError)) {
    throw error;
  }
  errorLog({ event: 'api_config_error', variables: error.variables });
  process.exitCode = 2;
}

if (config !== undefined) {
  const pool = createPool(config.postgres, SERVICE_POOL_TIMEOUTS);
  // El error de una conexión inactiva del pool no tumba la API: la consulta siguiente falla con
  // él, y la petición responde postgres_unavailable.
  pool.on('error', () => undefined);
  const clock = () => Date.now();
  const readiness = createReadiness({
    check: () => migrationState(pool),
    intervalMs: READINESS_INTERVAL_MS,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    log,
  });
  // El hasher y el generador de identificadores se comparten entre las cuentas y las sesiones: así
  // la cola de los hashes es una sola (ADR-0019 §1) y los UUIDv7 crecen siempre dentro del proceso.
  const hasher = createPasswordHasher({
    pepper: config.keys.passwordPepper,
    maxWaiting: HASHES_WAITING,
    randomBytes,
  });
  const newId = createUuidV7Generator({ now: clock, randomBytes });
  const limiter = createRateLimiter();
  const failures = createLoginFailureBuffer();
  const links = createAccountService({
    pool,
    environment: config.environment,
    origin: config.origin,
    keys: config.keys,
    hasher,
    commonPasswords: loadCommonPasswords(),
    clock,
    randomBytes,
    newId,
  });
  const sessions = createSessionService({
    pool,
    keys: config.keys,
    hasher,
    clock,
    randomBytes,
    newId,
    limiter,
    failures,
  });
  // Las lecturas del sistema de datos, con su propio pool y `buoh_api_lectura` (ADR-0019 §8). Sin
  // su contraseña, sus rutas responden not_ready, y lo demás de la API no cambia.
  const readerPool = config.reader === null ? null : createReaderPool(config.reader);
  readerPool?.on('error', () => undefined);
  const data = readerPool === null ? null : createDataReader({ pool: readerPool, clock });
  // La exportación `out-api` de la web, junto a la API en el repositorio; `apps/web/out-api` desde
  // `apps/api/dist/cli/`. Sin ella, la API sirve solo JSON (el despliegue la compila, ADR-0019 §10).
  const web = loadWebAssets(fileURLToPath(new URL('../../../web/out-api/', import.meta.url)));
  const app = buildApp({
    log,
    now: () => performance.now(),
    requestId: () => randomUUID(),
    origin: config.origin,
    routes: apiRoutes({ readiness, links, sessions, limiter, clock, data }),
    rateLimit: (address) => limiter.requestWait(address, clock()),
    ...(web === null ? {} : { web }),
  });
  app.addHook('onClose', async () => {
    readiness.stop();
    await sessions.flushPendingFailures().catch(() => undefined);
    await Promise.all([pool.end(), readerPool?.end()]);
  });
  readiness.start();
  try {
    await serve({
      app,
      config,
      log,
      onSignal: signalsOf(process),
      setExitCode: (code) => {
        process.exitCode = code;
      },
    });
  } catch (error) {
    errorLog({ event: 'api_listen_failed', error: errorName(error) });
    process.exitCode = 1;
    await app.close().catch(() => undefined);
  }
}
