import { usernameSchema, type LinkPurpose } from '@buoh/contracts';

import { AccountCommandError } from './accounts/errors.js';
import type { AccountCommandService } from './accounts/service.js';
import { loadApiConfig, type ApiConfig } from './config.js';
import { ApiConfigError } from './environment.js';
import { errorName } from './log.js';
import { isPostgresUnavailable } from './postgres/errors.js';
import type { MigrationState } from './readiness.js';

/** Lo que abre la orden con su configuración: el estado de las migraciones y el servicio. */
export interface AccountCommandDeps {
  readonly open: (config: ApiConfig) => {
    readonly migrationState: () => Promise<MigrationState>;
    readonly service: AccountCommandService;
    readonly close: () => Promise<void>;
  };
}

export interface AccountCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE =
  'Uso: cuenta alta <usuario> | cuenta restablecer <usuario> | cuenta cerrar-sesiones <usuario>. El usuario tiene de 3 a 32 caracteres: minúsculas sin acentos, cifras, - y _.';

/** Lo que pide cada orden: un enlace de alta o de restablecimiento, o cerrar las sesiones. */
type AccountAction =
  { readonly kind: 'link'; readonly purpose: LinkPurpose } | { readonly kind: 'close-sessions' };

function parseAction(command: string | undefined): AccountAction | null {
  if (command === 'alta') {
    return { kind: 'link', purpose: 'enrollment' };
  }
  if (command === 'restablecer') {
    return { kind: 'link', purpose: 'reset' };
  }
  if (command === 'cerrar-sesiones') {
    return { kind: 'close-sessions' };
  }
  return null;
}

/** Cuántas sesiones cerró `cerrar-sesiones`, para quien la ejecuta. */
function closedSessionsMessage(username: string, closed: number): string {
  if (closed === 0) {
    return `La cuenta «${username}» no tenía sesiones abiertas.`;
  }
  if (closed === 1) {
    return `Se cerró 1 sesión de la cuenta «${username}».`;
  }
  return `Se cerraron ${String(closed)} sesiones de la cuenta «${username}».`;
}

/** El motivo de un fallo, para quien ejecuta la orden: un código, nunca el mensaje del error. */
function failureMessage(error: unknown, username: string): string {
  if (error instanceof AccountCommandError) {
    switch (error.code) {
      case 'account_already_enrolled':
        return `la cuenta «${username}» ya está dada de alta. Para una contraseña o un código nuevos: cuenta restablecer ${username} (account_already_enrolled)`;
      case 'enrolled_account_exists':
        return 'en production ya hay una cuenta dada de alta, y no se crea otra (enrolled_account_exists)';
      case 'account_not_found':
        return `no existe la cuenta «${username}» (account_not_found)`;
      case 'account_not_enrolled':
        return `la cuenta «${username}» todavía no está dada de alta. Para darla de alta: cuenta alta ${username} (account_not_enrolled)`;
    }
  }
  if (isPostgresUnavailable(error)) {
    return `PostgreSQL no respondió (${errorName(error)})`;
  }
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) {
    return `PostgreSQL rechazó la orden (${code})`;
  }
  return `error inesperado (${errorName(error)})`;
}

/**
 * La orden `cuenta` (ADR-0019 §2 y §3), que el propietario ejecuta en la consola de `buoh-api`, con
 * el entorno del servicio:
 * - `alta <usuario>` crea el enlace de alta: la cuenta, sin credencial, si no existe;
 * - `restablecer <usuario>` crea el enlace para poner una contraseña y un código nuevos;
 * - `cerrar-sesiones <usuario>` cierra todas las sesiones abiertas de la cuenta.
 *
 * Cada enlace vale 15 minutos y una sola vez, y anula el anterior de la cuenta. Su dirección, con el
 * token, solo sale aquí, en stdout, en su propia línea. Salida 0: el enlace o cuántas sesiones se
 * cerraron; 1: no se pudo, con el motivo y su código en stderr; 2: un uso o una configuración que no
 * valen, sin abrir la base.
 */
export async function accountCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AccountCommandDeps,
): Promise<AccountCommandResult> {
  // `pnpm --filter @buoh/api run cuenta -- alta <usuario>` pasa el `--` al script: se quita uno, y
  // solo delante.
  const [command, username, ...rest] = argv[0] === '--' ? argv.slice(1) : argv;
  const action = parseAction(command);
  if (
    action === null ||
    username === undefined ||
    rest.length > 0 ||
    !usernameSchema.safeParse(username).success
  ) {
    return { exitCode: 2, stdout: '', stderr: `${USAGE}\n` };
  }
  let config: ApiConfig;
  try {
    config = loadApiConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigError) {
      return { exitCode: 2, stdout: '', stderr: `${error.message}\n` };
    }
    throw error;
  }
  const prefix =
    action.kind === 'close-sessions' ? 'No se cerraron las sesiones' : 'No se creó el enlace';
  const failed = (message: string): AccountCommandResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `${prefix}: ${message}.\n`,
  });
  const opened = deps.open(config);
  try {
    const state = await opened.migrationState();
    if (state === 'migrations_pending') {
      return failed(
        'faltan las migraciones de la API; buoh-operaciones las aplica cada 5 minutos (not_ready)',
      );
    }
    if (state === 'migration_changed') {
      return failed(
        'una migración aplicada de la API no coincide con la de esta versión (migration_changed)',
      );
    }
    if (action.kind === 'close-sessions') {
      const closed = await opened.service.closeSessions({ username });
      return { exitCode: 0, stdout: `${closedSessionsMessage(username, closed)}\n`, stderr: '' };
    }
    const link = await opened.service.createLink({ username, purpose: action.purpose });
    const description =
      action.purpose === 'enrollment'
        ? `Enlace de alta de la cuenta «${username}», de un solo uso, válido hasta ${link.expiresAtUtc}:`
        : `Enlace de restablecimiento de la cuenta «${username}», de un solo uso, válido hasta ${link.expiresAtUtc}. Al usarlo, la contraseña y el código actuales dejan de valer:`;
    return { exitCode: 0, stdout: `${description}\n${link.url}\n`, stderr: '' };
  } catch (error) {
    return failed(failureMessage(error, username));
  } finally {
    await opened.close().catch(() => undefined);
  }
}
