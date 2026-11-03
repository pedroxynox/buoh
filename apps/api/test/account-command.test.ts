import { describe, expect, it } from 'vitest';

import { accountCommand, type AccountCommandDeps } from '../src/account-command.js';
import { AccountCommandError } from '../src/accounts/errors.js';
import type { AccountCommandService } from '../src/accounts/service.js';
import type { MigrationState } from '../src/readiness.js';
import { useDeterminismGuards } from './support.js';

// La orden `cuenta` (ADR-0019 §3): sus usos, su salida para quien la ejecuta en la consola de
// Render, y sus errores con un código, nunca con el mensaje de PostgreSQL.
useDeterminismGuards();

const KEY = (byte: number) => Buffer.alloc(32, byte).toString('base64');
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_API_ORIGIN: 'https://buoh.test',
  BUOH_API_PASSWORD_PEPPER: KEY(1),
  BUOH_API_TOTP_KEY: KEY(2),
  BUOH_API_TOKEN_KEY: KEY(3),
  BUOH_POSTGRES_PASSWORD: 'contraseña-de-la-prueba',
};
const URL_WITH_TOKEN = 'https://buoh.test/enlace/#AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function deps(behavior: {
  readonly state?: MigrationState | Error;
  readonly createLink?: AccountCommandService['createLink'];
}) {
  const calls: unknown[] = [];
  let closed = 0;
  const value: AccountCommandDeps = {
    open: (config) => {
      calls.push({ origin: config.origin, user: config.postgres.user });
      return {
        migrationState: () =>
          behavior.state instanceof Error
            ? Promise.reject(behavior.state)
            : Promise.resolve(behavior.state ?? 'ready'),
        service: {
          createLink: (input) => {
            calls.push(input);
            return (
              behavior.createLink?.(input) ??
              Promise.resolve({
                purpose: input.purpose,
                username: input.username,
                url: URL_WITH_TOKEN,
                expiresAtUtc: '2026-11-03T12:15:00.000Z',
              })
            );
          },
        },
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
    },
  };
  return { value, calls, closed: () => closed };
}

describe('accountCommand', () => {
  it('alta escribe el enlace de alta en su propia línea, y cierra la conexión', async () => {
    const fake = deps({});
    expect(await accountCommand(['alta', 'pedro'], ENV, fake.value)).toEqual({
      exitCode: 0,
      stdout: `Enlace de alta de la cuenta «pedro», de un solo uso, válido hasta 2026-11-03T12:15:00.000Z:\n${URL_WITH_TOKEN}\n`,
      stderr: '',
    });
    expect(fake.calls).toEqual([
      { origin: 'https://buoh.test', user: 'buoh' },
      { username: 'pedro', purpose: 'enrollment' },
    ]);
    expect(fake.closed()).toBe(1);
  });

  it('restablecer escribe el enlace de restablecimiento', async () => {
    const fake = deps({});
    const result = await accountCommand(['restablecer', 'pedro'], ENV, fake.value);
    expect(result).toEqual({
      exitCode: 0,
      stdout: `Enlace de restablecimiento de la cuenta «pedro», de un solo uso, válido hasta 2026-11-03T12:15:00.000Z. Al usarlo, la contraseña y el código actuales dejan de valer:\n${URL_WITH_TOKEN}\n`,
      stderr: '',
    });
    expect(fake.calls[1]).toEqual({ username: 'pedro', purpose: 'reset' });
  });

  it.each([
    [[]],
    [['alta']],
    [['alta', 'pedro', 'otra']],
    [['borrar', 'pedro']],
    [['cerrar-sesiones', 'pedro']],
    [['alta', 'Pedro']],
    [['alta', 'pé']],
    [['alta', 'p'.repeat(33)]],
  ])('%j sale con 2 y su uso, sin abrir la base', async (args) => {
    const fake = deps({});
    expect(await accountCommand(args, ENV, fake.value)).toEqual({
      exitCode: 2,
      stdout: '',
      stderr:
        'Uso: cuenta alta <usuario> | cuenta restablecer <usuario>. El usuario tiene de 3 a 32 caracteres: minúsculas sin acentos, cifras, - y _.\n',
    });
    expect(fake.calls).toEqual([]);
  });

  it('una configuración inválida sale con 2 y los nombres de las variables, nunca sus valores', async () => {
    const fake = deps({});
    const result = await accountCommand(
      ['alta', 'pedro'],
      { ...ENV, BUOH_API_TOKEN_KEY: 'valor-secreto-9c1d', BUOH_API_ORIGIN: undefined },
      fake.value,
    );
    expect(result).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'Configuración inválida o ausente: BUOH_API_ORIGIN, BUOH_API_TOKEN_KEY.\n',
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [
      'account_already_enrolled',
      'alta',
      'No se creó el enlace: la cuenta «pedro» ya está dada de alta. Para una contraseña o un código nuevos: cuenta restablecer pedro (account_already_enrolled).',
    ],
    [
      'enrolled_account_exists',
      'alta',
      'No se creó el enlace: en production ya hay una cuenta dada de alta, y no se crea otra (enrolled_account_exists).',
    ],
    [
      'account_not_found',
      'restablecer',
      'No se creó el enlace: no existe la cuenta «pedro» (account_not_found).',
    ],
    [
      'account_not_enrolled',
      'restablecer',
      'No se creó el enlace: la cuenta «pedro» todavía no está dada de alta. Para darla de alta: cuenta alta pedro (account_not_enrolled).',
    ],
  ] as const)('%s sale con 1 y lo explica', async (code, command, message) => {
    const fake = deps({ createLink: () => Promise.reject(new AccountCommandError(code)) });
    expect(await accountCommand([command, 'pedro'], ENV, fake.value)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `${message}\n`,
    });
    expect(fake.closed()).toBe(1);
  });

  it('sin las migraciones de la API, o con una cambiada, sale con 1 sin crear nada', async () => {
    for (const [state, message] of [
      [
        'migrations_pending',
        'No se creó el enlace: faltan las migraciones de la API; buoh-operaciones las aplica cada 5 minutos (not_ready).',
      ],
      [
        'migration_changed',
        'No se creó el enlace: una migración aplicada de la API no coincide con la de esta versión (migration_changed).',
      ],
    ] as const) {
      const fake = deps({ state });
      expect(await accountCommand(['alta', 'pedro'], ENV, fake.value)).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `${message}\n`,
      });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('un error de PostgreSQL sale con su código, nunca con su mensaje', async () => {
    const leaky = (code: string) =>
      Object.assign(
        new Error(`password authentication failed for user "buoh_api" at dpg-1 (${code})`),
        {
          code,
        },
      );
    const down = deps({ state: leaky('28P01') });
    expect(await accountCommand(['alta', 'pedro'], ENV, down.value)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'No se creó el enlace: PostgreSQL no respondió (28P01).\n',
    });
    const denied = deps({ createLink: () => Promise.reject(leaky('42501')) });
    expect(await accountCommand(['alta', 'pedro'], ENV, denied.value)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'No se creó el enlace: PostgreSQL rechazó la orden (42501).\n',
    });
    const other = deps({ createLink: () => Promise.reject(new TypeError('dpg-1 secreto')) });
    expect(await accountCommand(['alta', 'pedro'], ENV, other.value)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'No se creó el enlace: error inesperado (TypeError).\n',
    });
    expect(down.closed() + denied.closed() + other.closed()).toBe(3);
  });
});
