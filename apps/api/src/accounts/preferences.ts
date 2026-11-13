import type { AccountPreferences, Theme } from '@buoh/contracts';
import type { Pool } from 'pg';

import type { AuthenticatedSession } from './sessions.js';
import type { Queryable } from './store.js';

/**
 * Las preferencias de cada cuenta (ADR-0019 §4 y §7; `F2-UI-001`), en la tabla append-only
 * `buoh_api.account_preferences` (migración `0004_preferencias.sql`). En la Fase 2, solo el tema
 * de la web. Un cambio es una fila nueva, y vale la última de la cuenta por `write_order`. Cada
 * función recibe la cuenta de la sesión: no hay consulta sin cuenta.
 */

/** El tema sin ninguna preferencia guardada: noche, el de por defecto (guía de marca). */
export const DEFAULT_THEME: Theme = 'night';

const THEME_VALUES: ReadonlySet<string> = new Set<Theme>(['night', 'day']);

/** Una fila guardada con un tema que la migración no admite, como si se cambiara el `CHECK`. */
export class StoredPreferenceError extends TypeError {
  constructor() {
    super('La preferencia guardada no tiene un tema que la API conozca.');
    this.name = 'StoredPreferenceError';
  }
}

/** El último tema guardado de la cuenta, o `null` si no tiene ninguno. */
export async function latestTheme(client: Queryable, accountId: string): Promise<Theme | null> {
  const { rows } = await client.query<{ theme: string }>(
    `SELECT theme FROM buoh_api.account_preferences
      WHERE account_id = $1 ORDER BY write_order DESC LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (!THEME_VALUES.has(row.theme)) {
    throw new StoredPreferenceError();
  }
  return row.theme as Theme;
}

export async function insertThemePreference(
  client: Queryable,
  row: {
    readonly preferenceId: string;
    readonly accountId: string;
    readonly theme: Theme;
    readonly setAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.account_preferences (preference_id, account_id, theme, set_at_utc)
     VALUES ($1, $2, $3, $4)`,
    [row.preferenceId, row.accountId, row.theme, row.setAtUtc],
  );
}

export interface PreferenceService {
  /** Las preferencias de la cuenta de la sesión: su último tema, o el de por defecto. */
  get(session: AuthenticatedSession): Promise<AccountPreferences>;
  /**
   * Guarda el tema para la cuenta de la sesión y devuelve sus preferencias. Si ya es el que vale,
   * no escribe nada: así repetirlo no hace crecer la tabla.
   */
  set(session: AuthenticatedSession, theme: Theme): Promise<AccountPreferences>;
}

export interface PreferenceServiceDeps {
  readonly pool: Pick<Pool, 'query'>;
  /** Milisegundos desde 1970: la hora de cada fila. */
  readonly clock: () => number;
  readonly newId: () => string;
}

export function createPreferenceService(deps: PreferenceServiceDeps): PreferenceService {
  return {
    get: async (session) => ({
      theme: (await latestTheme(deps.pool, session.accountId)) ?? DEFAULT_THEME,
    }),
    set: async (session, theme) => {
      const current = (await latestTheme(deps.pool, session.accountId)) ?? DEFAULT_THEME;
      if (current !== theme) {
        await insertThemePreference(deps.pool, {
          preferenceId: deps.newId(),
          accountId: session.accountId,
          theme,
          setAtUtc: new Date(deps.clock()).toISOString(),
        });
      }
      return { theme };
    },
  };
}
