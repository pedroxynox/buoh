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

// --- PR 4b: el inicio de sesión y las sesiones (ADR-0019 §1 y §2) ---

/**
 * El bloqueo por cuenta del inicio de sesión, de la transacción. Va en una clave distinta de la del
 * bloqueo de las cuentas (4 100 019), para que los inicios de sesión no esperen a la orden `cuenta`
 * ni entre sí salvo en la misma cuenta. La segunda clave es el hash del identificador de la cuenta,
 * así que dos cuentas no se cruzan (una colisión solo las serializaría, sin efecto en los datos).
 */
const SESSIONS_LOCK_KEY1 = 4_100_020;

export async function lockAccountSessions(
  client: Pick<PoolClient, 'query'>,
  accountId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    SESSIONS_LOCK_KEY1,
    accountId,
  ]);
}

/** La credencial vigente de una cuenta para el inicio de sesión: el hash, el secreto y si está deshabilitada. */
export interface LoginCredentialRow {
  readonly credentialId: string;
  readonly passwordHash: string;
  readonly createdAtUtc: string;
  readonly totpSecretSealed: Buffer;
  readonly disabled: boolean;
}

export async function currentCredentialForLogin(
  client: Queryable,
  accountId: string,
): Promise<LoginCredentialRow | null> {
  const { rows } = await client.query<{
    credential_id: string;
    password_hash: string;
    created_at_utc: string;
    totp_secret_sealed: Buffer;
    disabled: boolean;
  }>(
    `SELECT c.credential_id, c.password_hash, c.created_at_utc, s.totp_secret_sealed,
            EXISTS (SELECT 1 FROM buoh_api.credential_disablements d
                     WHERE d.credential_id = c.credential_id) AS disabled
       FROM buoh_api.credentials c
       JOIN buoh_api.link_totp_secrets s ON s.credential_id = c.credential_id
      WHERE c.account_id = $1
      ORDER BY c.write_order DESC LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        credentialId: row.credential_id,
        passwordHash: row.password_hash,
        createdAtUtc: row.created_at_utc,
        totpSecretSealed: row.totp_secret_sealed,
        disabled: row.disabled,
      };
}

/**
 * Los fallos seguidos de la credencial vigente y la hora del último (ADR-0019 §1): los `login_failed`
 * desde el último acierto (`session_started`) o el alta de la credencial, lo que sea más reciente. No
 * hay contador que se modifique, y el recuento sobrevive a un reinicio.
 */
export async function credentialFailureStats(
  client: Queryable,
  accountId: string,
  credentialId: string,
): Promise<{ readonly failures: number; readonly lastFailureAtUtc: string | null }> {
  const { rows } = await client.query<{ failures: number; last_failure: string | null }>(
    `WITH baseline AS (
       SELECT greatest(
         (SELECT max(occurred_at_utc) FROM buoh_api.audit_events
            WHERE account_id = $1 AND action = 'session_started'),
         (SELECT created_at_utc FROM buoh_api.credentials WHERE credential_id = $2)
       ) AS at
     )
     SELECT count(*)::int AS failures, max(e.occurred_at_utc) AS last_failure
       FROM buoh_api.audit_events e, baseline b
      WHERE e.account_id = $1 AND e.action = 'login_failed'
        AND (b.at IS NULL OR e.occurred_at_utc > b.at)`,
    [accountId, credentialId],
  );
  const row = rows[0];
  return { failures: row?.failures ?? 0, lastFailureAtUtc: row?.last_failure ?? null };
}

/**
 * El mayor paso TOTP ya usado por una credencial que no pase de `maxStep` (ADR-0019 §1). El tope
 * descarta un paso con el máximo de `bigint` que alguien con la contraseña de `buoh_api` hubiera
 * insertado para dejar la credencial sin aceptar códigos: así ese paso no cuenta como el último.
 */
export async function maxTotpStepUsedUpTo(
  client: Queryable,
  credentialId: string,
  maxStep: number,
): Promise<number | null> {
  const { rows } = await client.query<{ step: string | null }>(
    `SELECT max(totp_step)::text AS step FROM buoh_api.totp_steps_used
      WHERE credential_id = $1 AND totp_step <= $2`,
    [credentialId, maxStep],
  );
  const step = rows[0]?.step;
  return step === null || step === undefined ? null : Number(step);
}

export async function insertSession(
  client: Queryable,
  session: {
    readonly sessionId: string;
    readonly accountId: string;
    readonly tokenHmac: Buffer;
    readonly createdAtUtc: string;
    readonly expiresAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.sessions (session_id, account_id, token_hmac, created_at_utc, expires_at_utc)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      session.sessionId,
      session.accountId,
      session.tokenHmac,
      session.createdAtUtc,
      session.expiresAtUtc,
    ],
  );
}

/** Una sesión con lo que decide si vale (ADR-0019 §2). */
export interface SessionRow {
  readonly sessionId: string;
  readonly accountId: string;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  /** La última actividad, o `null` si solo tiene la creación. */
  readonly lastActivityUtc: string | null;
  readonly closed: boolean;
}

export async function findSessionByDigest(
  client: Queryable,
  tokenHmac: Buffer,
): Promise<SessionRow | null> {
  const { rows } = await client.query<{
    session_id: string;
    account_id: string;
    created_at_utc: string;
    expires_at_utc: string;
    last_activity: string | null;
    closed: boolean;
  }>(
    `SELECT s.session_id, s.account_id, s.created_at_utc, s.expires_at_utc,
            (SELECT max(a.activity_at_utc) FROM buoh_api.session_activity a
              WHERE a.session_id = s.session_id) AS last_activity,
            EXISTS (SELECT 1 FROM buoh_api.session_closures c WHERE c.session_id = s.session_id) AS closed
       FROM buoh_api.sessions s
      WHERE s.token_hmac = $1`,
    [tokenHmac],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        sessionId: row.session_id,
        accountId: row.account_id,
        createdAtUtc: row.created_at_utc,
        expiresAtUtc: row.expires_at_utc,
        lastActivityUtc: row.last_activity,
        closed: row.closed,
      };
}

export async function insertSessionActivity(
  client: Queryable,
  activity: {
    readonly sessionActivityId: string;
    readonly sessionId: string;
    readonly activityAtUtc: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO buoh_api.session_activity (session_activity_id, session_id, activity_at_utc)
     VALUES ($1, $2, $3)`,
    [activity.sessionActivityId, activity.sessionId, activity.activityAtUtc],
  );
}

export async function insertSessionClosure(
  client: Queryable,
  closure: {
    readonly sessionId: string;
    readonly reason:
      'logout' | 'session_limit' | 'other_sessions' | 'operator_command' | 'credential_reset';
    readonly closedAtUtc: string;
  },
): Promise<void> {
  // ON CONFLICT DO NOTHING hace el cierre idempotente: una sesión que otro camino ya cerró (por
  // ejemplo el tope de 10 bajo el bloqueo de sesiones, mientras un restablecimiento la cierra bajo
  // el de las cuentas) no choca. No es un UPDATE, así que el trigger append-only no lo rechaza.
  await client.query(
    `INSERT INTO buoh_api.session_closures (session_id, reason, closed_at_utc)
     VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING`,
    [closure.sessionId, closure.reason, closure.closedAtUtc],
  );
}

/**
 * Las sesiones abiertas de una cuenta (ni cerradas ni vencidas a `nowUtc`), de la más antigua a la
 * más nueva por `write_order`. Con `exceptSessionId`, deja fuera esa sesión (para «Cerrar las demás»).
 */
export async function openSessions(
  client: Queryable,
  accountId: string,
  nowUtc: string,
  exceptSessionId?: string,
): Promise<string[]> {
  const { rows } = await client.query<{ session_id: string }>(
    `SELECT s.session_id FROM buoh_api.sessions s
      WHERE s.account_id = $1
        AND s.expires_at_utc > $2
        AND ($3::uuid IS NULL OR s.session_id <> $3)
        AND NOT EXISTS (SELECT 1 FROM buoh_api.session_closures c WHERE c.session_id = s.session_id)
      ORDER BY s.write_order ASC`,
    [accountId, nowUtc, exceptSessionId ?? null],
  );
  return rows.map((row) => row.session_id);
}

/** Las entradas de auditoría de una cuenta, de la más nueva a la más vieja (ADR-0019 §5). */
export async function auditEventsForAccount(
  client: Queryable,
  accountId: string,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ event_jcs: string }>(
    `SELECT event_jcs FROM buoh_api.audit_events
      WHERE account_id = $1 ORDER BY audit_event_id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => row.event_jcs);
}
