import pg from 'pg';

import { API_SCHEMA, type PostgresConfig, type PostgresSslMode } from './config.js';

/**
 * Las conexiones de cada pool de la API, como mucho (ADR-0019 §7): así no le quita a la captura
 * los 0,1 CPU de la base.
 */
export const POOL_MAX_CONNECTIONS = 3;

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

/** Un pool de la API, sobre su esquema (`search_path`) y con su cifrado explícito. */
export function createPool(config: PostgresConfig): pg.Pool {
  return new pg.Pool({
    ...postgresSslOption(config.sslMode),
    database: config.database,
    host: config.host,
    max: POOL_MAX_CONNECTIONS,
    options: `-c search_path=${API_SCHEMA}`,
    password: config.password,
    port: config.port,
    user: config.user,
  });
}
