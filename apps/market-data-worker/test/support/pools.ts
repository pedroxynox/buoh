import { type Pool } from 'pg';

/**
 * Cierra el pool y espera a que cada una de sus conexiones se cierre de verdad. `pool.end()` de
 * pg-pool resuelve en cuanto saca las conexiones libres de su lista, antes de que se cierren. Si la
 * prueba borra enseguida su base con `DROP DATABASE … WITH (FORCE)`, PostgreSQL termina las que
 * todavía se cierran (`57P01`), y el pool, sin oyente de `error`, lo vuelve una excepción no
 * capturada que hace fallar la ejecución de Vitest aunque pasen todas las pruebas. Cada conexión
 * emite `remove` en el pool cuando ya se cerró. Es para el final de una prueba: el pool no puede
 * tener conexiones prestadas.
 */
export async function closePool(pool: Pool | undefined): Promise<void> {
  if (pool === undefined) {
    return;
  }
  const open = pool.totalCount;
  let removed = 0;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) {
      resolve();
      return;
    }
    pool.on('remove', () => {
      removed += 1;
      if (removed === open) {
        resolve();
      }
    });
  });
  await pool.end();
  await closed;
}
