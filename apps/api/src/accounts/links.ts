import { totpUri, type AuditEvent, type AuditObject, type LinkSecret } from '@buoh/contracts';
import type { Pool } from 'pg';

import { insertAuditEvent } from '../audit.js';
import { base32Encode } from '../auth/base32.js';
import type { PasswordHasher } from '../auth/password-hash.js';
import { checkPassword } from '../auth/password-policy.js';
import { openTotpSecret, SEAL_NONCE_BYTES, sealTotpSecret } from '../auth/seal.js';
import { linkTokenDigest, newLinkToken } from '../auth/tokens.js';
import { matchTotpCode, TOTP_SECRET_BYTES } from '../auth/totp.js';
import type { ApiKeys } from '../config.js';
import type { ApiEnvironment } from '../environment.js';
import { withTransaction } from '../postgres/transaction.js';
import { AccountCommandError, LinkError, PasswordRejectedError } from './errors.js';
import type { AccountCommandService, LinkService } from './service.js';
import {
  anyEnrolledAccount,
  currentCredential,
  findAccount,
  findLinkByDigest,
  insertAccount,
  insertCredential,
  insertCredentialDisablement,
  insertLink,
  insertLinkSecret,
  insertTotpStepUsed,
  latestLinkSecret,
  lockAccounts,
  type LinkRow,
} from './store.js';

/** Un enlace vale 15 minutos desde que lo crea la orden `cuenta` (ADR-0019 §3). */
export const LINK_LIFETIME_MS = 15 * 60 * 1000;

export interface AccountServiceDeps {
  readonly pool: Pick<Pool, 'connect' | 'query'>;
  readonly environment: ApiEnvironment;
  /** El origen público de la API, el de los enlaces (`BUOH_API_ORIGIN`). */
  readonly origin: string;
  readonly keys: Pick<ApiKeys, 'totpKey' | 'tokenKey'>;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: ReadonlySet<string>;
  /** Milisegundos desde 1970: la hora de cada fila y de cada entrada, y la del código TOTP. */
  readonly clock: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
  /** Un UUIDv7 nuevo, para las cuentas, los enlaces, las credenciales y las entradas. */
  readonly newId: () => string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Los campos de una entrada de auditoría, salvo su versión, su identificador y su hora. */
type WithoutIdentity<T> = T extends unknown
  ? Omit<T, 'schema_version' | 'audit_event_id' | 'occurred_at_utc'>
  : never;
type AuditFields = WithoutIdentity<AuditEvent>;

/** Los objetos de una entrada de auditoría, en el orden del contrato: por clase y por identificador. */
function auditObjects(...objects: AuditObject[]): AuditObject[] {
  return objects.sort((a, b) => {
    const left = `${a.kind}:${a.id}`;
    const right = `${b.kind}:${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Si un enlace vale (ADR-0019 §3): es el último de su cuenta, no se usó y no venció. Uno de alta
 * es de una cuenta sin dar de alta y, en `production`, sin ninguna otra dada de alta. Uno de
 * restablecimiento es de una cuenta dada de alta.
 */
function linkIsValid(
  link: LinkRow | null,
  nowUtc: string,
  environment: ApiEnvironment,
): link is LinkRow {
  if (link === null || !link.latest || link.used || nowUtc >= link.expiresAtUtc) {
    return false;
  }
  return link.purpose === 'enrollment'
    ? !link.enrolled && (environment !== 'production' || !link.otherEnrolled)
    : link.enrolled;
}

/** Las cuentas sobre PostgreSQL: la orden `cuenta` y los enlaces de alta y de restablecimiento. */
export function createAccountService(
  deps: AccountServiceDeps,
): LinkService & AccountCommandService {
  /** Una entrada de auditoría con su identificador nuevo y su hora. */
  const event = (fields: AuditFields, nowUtc: string): AuditEvent => ({
    schema_version: '1.0.0',
    audit_event_id: deps.newId(),
    occurred_at_utc: nowUtc,
    ...fields,
  });

  return {
    async createLink({ username, purpose }) {
      return withTransaction(deps.pool, async (client) => {
        await lockAccounts(client);
        const account = await findAccount(client, username);
        if (purpose === 'enrollment') {
          if (account?.enrolled === true) {
            throw new AccountCommandError('account_already_enrolled');
          }
          if (deps.environment === 'production' && (await anyEnrolledAccount(client))) {
            throw new AccountCommandError('enrolled_account_exists');
          }
        } else if (account === null) {
          throw new AccountCommandError('account_not_found');
        } else if (!account.enrolled) {
          throw new AccountCommandError('account_not_enrolled');
        }
        const now = deps.clock();
        const nowUtc = iso(now);
        const expiresAtUtc = iso(now + LINK_LIFETIME_MS);
        let accountId = account?.accountId;
        if (accountId === undefined) {
          accountId = deps.newId();
          await insertAccount(client, { accountId, username, createdAtUtc: nowUtc });
        }
        const token = newLinkToken(deps.randomBytes);
        const linkId = deps.newId();
        await insertLink(client, {
          linkId,
          accountId,
          purpose,
          tokenHmac: linkTokenDigest(deps.keys.tokenKey, token),
          createdAtUtc: nowUtc,
          expiresAtUtc,
        });
        await insertAuditEvent(
          client,
          event(
            {
              account_id: accountId,
              actor: 'operator',
              action: 'link_created',
              reason: purpose,
              objects: auditObjects(
                { kind: 'account', id: accountId },
                { kind: 'link', id: linkId },
              ),
              request_id: null,
            },
            nowUtc,
          ),
        );
        return { purpose, username, url: `${deps.origin}/enlace/#${token}`, expiresAtUtc };
      });
    },

    async issueSecret({ token }) {
      const digest = linkTokenDigest(deps.keys.tokenKey, token);
      return withTransaction(deps.pool, async (client): Promise<LinkSecret> => {
        await lockAccounts(client);
        const link = await findLinkByDigest(client, digest);
        const nowUtc = iso(deps.clock());
        if (!linkIsValid(link, nowUtc, deps.environment)) {
          throw new LinkError('invalid_link');
        }
        const secret = deps.randomBytes(TOTP_SECRET_BYTES);
        const credentialId = deps.newId();
        await insertLinkSecret(client, {
          credentialId,
          linkId: link.linkId,
          sealed: sealTotpSecret({
            key: deps.keys.totpKey,
            secret,
            accountId: link.accountId,
            credentialId,
            nonce: deps.randomBytes(SEAL_NONCE_BYTES),
          }),
          createdAtUtc: nowUtc,
        });
        const encoded = base32Encode(secret);
        return {
          purpose: link.purpose,
          username: link.username,
          expires_at_utc: link.expiresAtUtc,
          totp: { secret: encoded, uri: totpUri(link.username, encoded) },
        };
      });
    },

    async useLink({ token, password, code, requestId }) {
      const digest = linkTokenDigest(deps.keys.tokenKey, token);
      // Primero, sin bloqueo ni transacción, lo que se puede rechazar sin escribir nada; así el hash
      // de la contraseña, que tarda, no retiene una conexión ni el bloqueo.
      const link = await findLinkByDigest(deps.pool, digest);
      if (!linkIsValid(link, iso(deps.clock()), deps.environment)) {
        throw new LinkError('invalid_link');
      }
      const pending = await latestLinkSecret(deps.pool, link.linkId);
      if (pending === null) {
        throw new LinkError('invalid_code');
      }
      const policy = checkPassword(password, {
        username: link.username,
        commonPasswords: deps.commonPasswords,
      });
      if (!policy.ok) {
        throw new PasswordRejectedError(policy.reason);
      }
      const secret = openTotpSecret({
        key: deps.keys.totpKey,
        sealed: pending.sealed,
        accountId: link.accountId,
        credentialId: pending.credentialId,
      });
      const step = matchTotpCode({ secret, code, nowMs: deps.clock(), lastUsedStep: null });
      if (step === null) {
        throw new LinkError('invalid_code');
      }
      const passwordHash = await deps.hasher.hash(policy.normalized);

      // Después, con el bloqueo, se vuelve a comprobar todo antes de escribir: el enlace puede haberse
      // usado o anulado, o haber dado otro secreto, mientras tanto.
      return withTransaction(deps.pool, async (client) => {
        await lockAccounts(client);
        const nowUtc = iso(deps.clock());
        const current = await findLinkByDigest(client, digest);
        if (!linkIsValid(current, nowUtc, deps.environment) || current.linkId !== link.linkId) {
          throw new LinkError('invalid_link');
        }
        const latest = await latestLinkSecret(client, current.linkId);
        if (latest?.credentialId !== pending.credentialId) {
          throw new LinkError('invalid_code');
        }
        const previous =
          current.purpose === 'reset' ? await currentCredential(client, current.accountId) : null;
        const credentialId = pending.credentialId;
        await insertCredential(client, {
          credentialId,
          accountId: current.accountId,
          linkId: current.linkId,
          passwordHash,
          createdAtUtc: nowUtc,
        });
        await insertTotpStepUsed(client, { credentialId, step, usedAtUtc: nowUtc });
        if (previous !== null && !previous.disabled) {
          await insertCredentialDisablement(client, {
            credentialId: previous.credentialId,
            reason: 'replaced',
            disabledAtUtc: nowUtc,
          });
        }
        const account: AuditObject = { kind: 'account', id: current.accountId };
        await insertAuditEvent(
          client,
          event(
            {
              account_id: current.accountId,
              actor: 'anonymous',
              action: 'link_used',
              reason: current.purpose,
              objects: auditObjects(account, { kind: 'link', id: current.linkId }),
              request_id: requestId,
            },
            nowUtc,
          ),
        );
        if (current.purpose === 'enrollment') {
          await insertAuditEvent(
            client,
            event(
              {
                account_id: current.accountId,
                actor: 'anonymous',
                action: 'account_enrolled',
                reason: 'enrollment_link',
                objects: auditObjects(account, { kind: 'credential', id: credentialId }),
                request_id: requestId,
              },
              nowUtc,
            ),
          );
          return { result: 'account_enrolled' as const };
        }
        const credentials: AuditObject[] = [{ kind: 'credential', id: credentialId }];
        if (previous !== null) {
          credentials.push({ kind: 'credential', id: previous.credentialId });
        }
        await insertAuditEvent(
          client,
          event(
            {
              account_id: current.accountId,
              actor: 'anonymous',
              action: 'credential_reset',
              reason: 'reset_link',
              objects: auditObjects(account, ...credentials),
              request_id: requestId,
            },
            nowUtc,
          ),
        );
        return { result: 'credential_reset' as const };
      });
    },
  };
}
