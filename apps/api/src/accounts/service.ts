import type { LinkPurpose, LinkSecret, LinkUse } from '@buoh/contracts';

/**
 * Lo que las rutas de los enlaces piden a las cuentas (ADR-0019 §3). La implementación con
 * PostgreSQL es `createAccountService`, en `links.ts`.
 */
export interface LinkService {
  /**
   * Un secreto TOTP nuevo para un enlace válido, que pasa a ser el suyo: el anterior, si lo había,
   * deja de valer. Lanza `LinkError` con `invalid_link` si el enlace no vale.
   */
  issueSecret(input: { readonly token: string }): Promise<LinkSecret>;
  /**
   * Usa el enlace con la contraseña nueva y un código de su último secreto: da de alta la cuenta o
   * restablece su credencial. Lanza `LinkError`, `PasswordRejectedError` o
   * `PasswordHasherBusyError`, sin gastar el enlace.
   */
  useLink(input: {
    readonly token: string;
    readonly password: string;
    readonly code: string;
    readonly requestId: string;
  }): Promise<LinkUse>;
}

/** Un enlace que crea la orden `cuenta`: su dirección, con el token, y su vencimiento. */
export interface CreatedLink {
  readonly purpose: LinkPurpose;
  readonly username: string;
  readonly url: string;
  readonly expiresAtUtc: string;
}

/** Lo que la orden `cuenta` pide a las cuentas (ADR-0019 §3). */
export interface AccountCommandService {
  /**
   * `alta` (`enrollment`) o `restablecer` (`reset`): crea el enlace, que anula el anterior de la
   * cuenta, y su entrada `link_created`. Lanza `AccountCommandError` si no se puede.
   */
  createLink(input: {
    readonly username: string;
    readonly purpose: LinkPurpose;
  }): Promise<CreatedLink>;
}
