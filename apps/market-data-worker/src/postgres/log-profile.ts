import pg from 'pg';
import type { Pool } from 'pg';

import { LogProfileUnknownError, type LogQualityProfileRow } from '../deriv/log-profile.js';

const SCHEMA_NAME = /^[a-z0-9_]{1,63}$/u;
const PROFILE_ID = /^[A-Za-z0-9_.-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * La fila de `log_quality_profile` del log (ADR-0020 §4), del esquema `schema` o, sin él, del
 * `search_path` del pool, o `null` si no tiene. Solo lee. Sin la tabla (`42P01`), como un log al
 * que todavía no se le aplicó la migración 0007, también `null`: la fila solo se inserta después de
 * esa migración, así que ese log no tiene perfil. Una fila con otra forma lanza
 * `LogProfileUnknownError`; cualquier otro error rechaza con él.
 */
export async function readLogQualityProfile(
  pool: Pick<Pool, 'query'>,
  schema?: string,
): Promise<LogQualityProfileRow | null> {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new TypeError('El esquema del log es de minúsculas, cifras y _.');
  }
  const table =
    schema === undefined
      ? 'log_quality_profile'
      : `${pg.escapeIdentifier(schema)}.log_quality_profile`;
  let rows: unknown[];
  try {
    ({ rows } = await pool.query(`SELECT profile_id, quality_profile_sha256 FROM ${table}`));
  } catch (error) {
    if ((error as { code?: unknown }).code === '42P01') {
      return null;
    }
    throw error;
  }
  if (rows.length === 0) {
    return null;
  }
  const [row] = rows as { profile_id?: unknown; quality_profile_sha256?: unknown }[];
  if (
    rows.length !== 1 ||
    typeof row?.profile_id !== 'string' ||
    !PROFILE_ID.test(row.profile_id) ||
    typeof row.quality_profile_sha256 !== 'string' ||
    !SHA256.test(row.quality_profile_sha256)
  ) {
    throw new LogProfileUnknownError('La fila de log_quality_profile no tiene la forma esperada.');
  }
  return { profile_id: row.profile_id, quality_profile_sha256: row.quality_profile_sha256 };
}
