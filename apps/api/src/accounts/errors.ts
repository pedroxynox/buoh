import type { PasswordRejectionReason } from '@buoh/contracts';

/**
 * Por qué no vale el uso de un enlace (ADR-0019 §3): el enlace no existe, venció, ya se usó o lo
 * anuló otro (`invalid_link`), o el código no corresponde a su último secreto TOTP (`invalid_code`).
 */
export class LinkError extends Error {
  readonly code: 'invalid_link' | 'invalid_code';

  constructor(code: LinkError['code']) {
    super(`El enlace no vale: ${code}.`);
    this.name = 'LinkError';
    this.code = code;
  }
}

/** La contraseña nueva no cumple la política, con su motivo (ADR-0019 §1). */
export class PasswordRejectedError extends Error {
  readonly reason: PasswordRejectionReason;

  constructor(reason: PasswordRejectionReason) {
    super(`La contraseña no cumple la política: ${reason}.`);
    this.name = 'PasswordRejectedError';
    this.reason = reason;
  }
}

/**
 * Por qué la orden `cuenta` no crea un enlace (ADR-0019 §3):
 * - `account_already_enrolled`: `alta` de una cuenta que ya está dada de alta;
 * - `enrolled_account_exists`: `alta` en `production` con otra cuenta ya dada de alta;
 * - `account_not_found`: `restablecer` de una cuenta que no existe;
 * - `account_not_enrolled`: `restablecer` de una cuenta que todavía no está dada de alta.
 */
export class AccountCommandError extends Error {
  readonly code:
    | 'account_already_enrolled'
    | 'enrolled_account_exists'
    | 'account_not_found'
    | 'account_not_enrolled';

  constructor(code: AccountCommandError['code']) {
    super(`La orden cuenta no creó el enlace: ${code}.`);
    this.name = 'AccountCommandError';
    this.code = code;
  }
}
