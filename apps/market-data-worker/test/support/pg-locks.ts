import { type Pool } from 'pg';

import { sourceLockKey } from '../../src/postgres/source-lock.js';

/**
 * El PID de la sesión de PostgreSQL que tiene el bloqueo de la fuente según `pg_locks`, o `null`.
 * Es la consulta del runbook («Una sola instancia por fuente»): un bloqueo de 64 bits guarda los 32
 * bits altos de la clave en `classid`, los 32 bajos en `objid` y `objsubid = 1`. `admin` es un pool
 * con permiso para leer `pg_locks`; lo usan las pruebas de integración.
 */
export async function sourceLockHolder(admin: Pool, source: string): Promise<number | null> {
  const key = BigInt.asUintN(64, BigInt(sourceLockKey(source)));
  const { rows } = await admin.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND classid = $1::bigint::oid AND objid = $2::bigint::oid`,
    [(key >> 32n).toString(), (key & 0xffff_ffffn).toString()],
  );
  return rows[0]?.pid ?? null;
}
