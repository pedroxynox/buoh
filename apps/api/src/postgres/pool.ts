import pg from 'pg';

import { API_SCHEMA, type PostgresConfig, type PostgresSslMode } from './config.js';

/**
 * Las conexiones de cada pool de la API, como mucho (ADR-0019 §7): así no le quita a la captura
 * los 0,1 CPU de la base.
 */
export const POOL_MAX_CONNECTIONS = 3;

/**
 * Los plazos del pool de la API y de la orden `cuenta`: esperar una conexión como mucho 5 s, una
 * consulta 10 s y una transacción abierta sin consultas 30 s. Así, una base que no responde no deja
 * las peticiones esperando ni las 3 conexiones ocupadas. `db:migrate` no los lleva: su bloqueo
 * puede esperar a que termine otra migración.
 */
export const SERVICE_POOL_TIMEOUTS = {
  connectionTimeoutMillis: 5000,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
} as const;

/**
 * La opción `ssl` de `pg` para cada modo (ADR-0018 §9), como en el worker: `disable` no cifra,
 * `require` cifra sin verificar el certificado y `verify-full` verifica la autoridad y el nombre del
 * servidor, con las comprobaciones por defecto de Node. Con `require` o `verify-full`, `pg` falla si
 * el servidor no admite TLS, en lugar de conectar sin cifrar. La opción siempre va explícita: sin
 * ella, `pg` leería `PGSSLMODE`, y el cifrado dependería de otra variable.
 */
export function postgresSslOption(mode: PostgresSslMode): {
  readonly ssl: boolean | { readonly rejectUnauthorized: false };
} {
  switch (mode) {
    case 'disable':
      return { ssl: false };
    case 'require':
      return { ssl: { rejectUnauthorized: false } };
    case 'verify-full':
      return { ssl: true };
  }
}

/**
 * Las opciones de cada sesión del pool de lectura (ADR-0019 §8): sin esquema propio en el
 * `search_path`, porque cada consulta nombra el esquema de su log, y en solo lectura. Lo que deja a
 * `buoh_api_lectura` sin escribir son sus privilegios; `default_transaction_read_only` es una
 * segunda barrera, que rechaza una escritura (`25006`) antes de mirarlos.
 */
export const READER_SESSION_OPTIONS =
  '-c search_path=pg_catalog -c default_transaction_read_only=on';

/**
 * El pool de las lecturas del sistema de datos (ADR-0019 §8), con `buoh_api_lectura`: como mucho 3
 * conexiones, los plazos de la API, su cifrado explícito y las opciones de `READER_SESSION_OPTIONS`.
 * Es aparte del de `buoh_api`, así que una lectura lenta de los logs no ocupa sus conexiones.
 */
export function createReaderPool(config: PostgresConfig): pg.Pool {
  return new pg.Pool({
    ...postgresSslOption(config.sslMode),
    ...SERVICE_POOL_TIMEOUTS,
    database: config.database,
    host: config.host,
    max: POOL_MAX_CONNECTIONS,
    options: READER_SESSION_OPTIONS,
    password: config.password,
    port: config.port,
    user: config.user,
  });
}

/** Un pool de la API, sobre su esquema (`search_path`) y con su cifrado explícito. */
export function createPool(
  config: PostgresConfig,
  timeouts?: typeof SERVICE_POOL_TIMEOUTS,
): pg.Pool {
  return new pg.Pool({
    ...postgresSslOption(config.sslMode),
    ...(timeouts ?? {}),
    database: config.database,
    host: config.host,
    max: POOL_MAX_CONNECTIONS,
    options: `-c search_path=${API_SCHEMA}`,
    password: config.password,
    port: config.port,
    user: config.user,
  });
}
