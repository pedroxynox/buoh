import type { LinkPurpose } from '@buoh/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Las consultas de las cuentas sobre las tablas de la migración `0002_cuentas.sql` (ADR-0019 §7).
 * Solo leen e insertan: nada se modifica ni se borra, y lo que cambia es una fila nueva.
 */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * El bloqueo de las cuentas, de la transacción: lo toman la orden `cuenta` y cada uso de un enlace,
 * que son raros, para que dos no se crucen. Va en la forma de dos claves, que no choca con la de una
 * clave de las migraciones (4 100 019).
 */
const ACCOUNTS_LOCK = [4_100_019, 1] as const;

export async function lockAccounts(client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ACCOUNTS_LOCK]);
}

export interface AccountRow {
  readonly accountId: string;
  /** Si la cuenta tiene alguna credencial: está dada de alta. */
  readonly enrolled: boolean;
}

export async function findAccount(client: Queryable, username: string): Promise<AccountRow | null> {
  const { rows } = await client.query<{ account_id: string; enrolled: boolean }>(
    `SELECT a.account_id,
            EXISTS (SELECT 1 FROM buoh_api.credentials c WHERE c.account_id = a.account_id) AS enrolled
       FROM buoh_api.accounts a WHERE a.username = $1`,
    [username],
  );
  const row = rows[0];
  return row === undefined ? null : { accountId: row.account_id, enrolled: row.enrolled };
}

/** Si alguna cuenta está dada de alta. */
export async function anyEnrolledAccount(client: Queryable): Promise<boolean> {
  const { rows } = await client.query<{ enrolled: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM buoh_api.credentials) AS enrolled',
  );
  return rows[0]?.enrolled === true;
}

export async function insertAccount(
  client: Queryable,
  account: { readonly accountId: string; readonly username: string; readonly createdAtUtc: string },
): Promise<void> {
  await client.query(
    'INSERT INTO buoh_api.accounts (account_id, username, created_at_utc) VALUES ($1, $2, $3)',
    [account.accountId, account.username, account.createdAtUtc],
  );
}

export async function insertLink(
  client: Queryable,
  link: {
    readonly linkId: string;
    readonly accountId: string;
    readonly purpose: LinkPurpose;
    readonly tokenHmac: Buffer;
    readonly createdAtUtc: string;
    readonly expiresAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.account_links
       (link_id, account_id, purpose, token_hmac, created_at_utc, expires_at_utc)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      link.linkId,
      link.accountId,
      link.purpose,
      link.tokenHmac,
      link.createdAtUtc,
      link.expiresAtUtc,
    ],
  );
}

/** Un enlace con lo que decide si vale (ADR-0019 §3). */
export interface LinkRow {
  readonly linkId: string;
  readonly accountId: string;
  readonly username: string;
  readonly purpose: LinkPurpose;
  readonly expiresAtUtc: string;
  /** Si es el último enlace de su cuenta: uno más nuevo lo anula. */
  readonly latest: boolean;
  /** Si ya creó su credencial. */
  readonly used: boolean;
  /** Si su cuenta está dada de alta. */
  readonly enrolled: boolean;
  /** Si otra cuenta está dada de alta. */
  readonly otherEnrolled: boolean;
}

/** El enlace cuyo token tiene esa huella, o `null`. */
export async function findLinkByDigest(
  client: Queryable,
  tokenHmac: Buffer,
): Promise<LinkRow | null> {
  const { rows } = await client.query<{
    link_id: string;
    account_id: string;
    username: string;
    purpose: LinkPurpose;
    expires_at_utc: string;
    latest: boolean;
    used: boolean;
    enrolled: boolean;
    other_enrolled: boolean;
  }>(
    `SELECT l.link_id, l.account_id, a.username, l.purpose, l.expires_at_utc,
            NOT EXISTS (SELECT 1 FROM buoh_api.account_links n
                         WHERE n.account_id = l.account_id AND n.write_order > l.write_order) AS latest,
            EXISTS (SELECT 1 FROM buoh_api.credentials c WHERE c.link_id = l.link_id) AS used,
            EXISTS (SELECT 1 FROM buoh_api.credentials c WHERE c.account_id = l.account_id) AS enrolled,
            EXISTS (SELECT 1 FROM buoh_api.credentials c WHERE c.account_id <> l.account_id) AS other_enrolled
       FROM buoh_api.account_links l
       JOIN buoh_api.accounts a ON a.account_id = l.account_id
      WHERE l.token_hmac = $1`,
    [tokenHmac],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        linkId: row.link_id,
        accountId: row.account_id,
        username: row.username,
        purpose: row.purpose,
        expiresAtUtc: row.expires_at_utc,
        latest: row.latest,
        used: row.used,
        enrolled: row.enrolled,
        otherEnrolled: row.other_enrolled,
      };
}

export async function insertLinkSecret(
  client: Queryable,
  secret: {
    readonly credentialId: string;
    readonly linkId: string;
    readonly sealed: Buffer;
    readonly createdAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.link_totp_secrets (credential_id, link_id, totp_secret_sealed, created_at_utc)
     VALUES ($1, $2, $3, $4)`,
    [secret.credentialId, secret.linkId, secret.sealed, secret.createdAtUtc],
  );
}

/** El último secreto TOTP que dio el enlace, con la credencial que será, o `null`. */
export async function latestLinkSecret(
  client: Queryable,
  linkId: string,
): Promise<{ readonly credentialId: string; readonly sealed: Buffer } | null> {
  const { rows } = await client.query<{ credential_id: string; totp_secret_sealed: Buffer }>(
    `SELECT credential_id, totp_secret_sealed FROM buoh_api.link_totp_secrets
      WHERE link_id = $1 ORDER BY write_order DESC LIMIT 1`,
    [linkId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { credentialId: row.credential_id, sealed: row.totp_secret_sealed };
}

/** La credencial vigente de la cuenta, la última, con si está deshabilitada, o `null`. */
export async function currentCredential(
  client: Queryable,
  accountId: string,
): Promise<{ readonly credentialId: string; readonly disabled: boolean } | null> {
  const { rows } = await client.query<{ credential_id: string; disabled: boolean }>(
    `SELECT c.credential_id,
            EXISTS (SELECT 1 FROM buoh_api.credential_disablements d
                     WHERE d.credential_id = c.credential_id) AS disabled
       FROM buoh_api.credentials c
      WHERE c.account_id = $1 ORDER BY c.write_order DESC LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  return row === undefined ? null : { credentialId: row.credential_id, disabled: row.disabled };
}

export async function insertCredential(
  client: Queryable,
  credential: {
    readonly credentialId: string;
    readonly accountId: string;
    readonly linkId: string;
    readonly passwordHash: string;
    readonly createdAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.credentials
       (credential_id, account_id, link_id, password_hash, created_at_utc)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      credential.credentialId,
      credential.accountId,
      credential.linkId,
      credential.passwordHash,
      credential.createdAtUtc,
    ],
  );
}

export async function insertCredentialDisablement(
  client: Queryable,
  disablement: {
    readonly credentialId: string;
    readonly reason: 'replaced' | 'failure_limit';
    readonly disabledAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.credential_disablements (credential_id, reason, disabled_at_utc)
     VALUES ($1, $2, $3)`,
    [disablement.credentialId, disablement.reason, disablement.disabledAtUtc],
  );
}

export async function insertTotpStepUsed(
  client: Queryable,
  use: { readonly credentialId: string; readonly step: number; readonly usedAtUtc: string },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.totp_steps_used (credential_id, totp_step, used_at_utc)
     VALUES ($1, $2, $3)`,
    [use.credentialId, use.step, use.usedAtUtc],
  );
}
