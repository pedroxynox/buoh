import type { Pool, PoolClient } from 'pg';

/**
 * Ejecuta `work` en una transacción de un cliente del pool, y la deshace entera si falla. Mientras
 * el cliente está fuera del pool, un corte de la conexión emite `error` en él, y sin oyente tumbaría
 * el proceso: la consulta en curso, o la siguiente, falla con ese error. Un cliente cuyo `ROLLBACK`
 * falla vuelve al pool roto, para que lo descarte.
 */
export async function withTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const ignoreConnectionError = (): void => undefined;
  client.on('error', ignoreConnectionError);
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK falló.');
    });
    throw error;
  } finally {
    client.off('error', ignoreConnectionError);
    client.release(broken);
  }
}
