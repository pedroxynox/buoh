import { type Pool } from 'pg';

/** Cada cuánto se vuelve a mirar `pg_stat_activity`. */
const POLL_MS = 20;

/**
 * Espera a que `database` no tenga ninguna sesión de cliente, para borrarla sin terminar ninguna.
 * `pool.end()` de pg-pool resuelve antes de que sus conexiones se cierren, y `DROP DATABASE … WITH
 * (FORCE)` termina las que todavía se están cerrando (`57P01`): un pool sin oyente de `error` lo
 * vuelve una excepción no capturada, y Vitest falla la ejecución aunque pasen todas las pruebas.
 * Mira `pg_stat_activity` con `server`, una conexión a otra base, cada 20 ms; los procesos de
 * autovacuum no cuentan, porque el borrado los para. Si en `timeoutMs` sigue habiendo sesiones,
 * falla: alguna prueba dejó un pool abierto.
 */
export async function waitForNoSessions(
  server: Pool,
  database: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await server.query<{ sessions: number }>(
      `SELECT count(*)::int AS sessions FROM pg_stat_activity
        WHERE datname = $1 AND backend_type = 'client backend'`,
      [database],
    );
    if (rows[0]?.sessions === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`La base ${database} sigue con sesiones abiertas.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
