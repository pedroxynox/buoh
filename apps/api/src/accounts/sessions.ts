import { auditEventSchema, type AuditEvent, type AuditObject } from '@buoh/contracts';
import type { Pool } from 'pg';

import { insertAuditEvent } from '../audit.js';
import {
  DUMMY_PASSWORD_HASH,
  PasswordHasherBusyError,
  type PasswordHasher,
} from '../auth/password-hash.js';
import { openTotpSecret } from '../auth/seal.js';
import {
  csrfTokenFor,
  isValidCsrfToken,
  newSessionSecret,
  sessionSecretBytes,
  sessionTokenDigest,
} from '../auth/session-token.js';
import { matchTotpCode, totpStep, TOTP_WINDOW_STEPS } from '../auth/totp.js';
import type { ApiKeys } from '../config.js';
import { withTransaction } from '../postgres/transaction.js';
import { auditEvent, auditObjects, type AuditFields } from './audit-helpers.js';
import { LoginError, RateLimitedError } from './errors.js';
import {
  CREDENTIAL_FAILURE_LIMIT,
  NAME_THROTTLE_FAILURES,
  NAME_THROTTLE_INTERVAL_MS,
  type RateLimiter,
} from './limits.js';
import {
  type GroupedFailureReason,
  type LoginFailureBuffer,
  type LoginFailureWindow,
} from './login-failures.js';
import {
  auditEventsForAccount,
  credentialFailureStats,
  currentCredentialForLogin,
  findAccount,
  findSessionByDigest,
  insertCredentialDisablement,
  insertSession,
  insertSessionActivity,
  insertSessionClosure,
  insertTotpStepUsed,
  lockAccountSessions,
  maxTotpStepUsedUpTo,
  openSessions,
  type LoginCredentialRow,
} from './store.js';

/** La sesión termina tras 1 hora sin actividad del propietario (ADR-0019 §2, AAL2). */
export const SESSION_IDLE_MS = 60 * 60_000;
/** La sesión termina siempre a las 24 horas de empezar (ADR-0019 §2). */
export const SESSION_MAX_MS = 24 * 60 * 60_000;
/** Una cuenta tiene como mucho 10 sesiones abiertas: una nueva cierra la más antigua (ADR-0019 §2). */
export const SESSION_LIMIT = 10;
/** La actividad se guarda como mucho una vez por minuto (ADR-0019 §2 y §7). */
export const ACTIVITY_MIN_INTERVAL_MS = 60_000;
/** Cuántas entradas devuelve `GET /api/v1/auditoria`, de la más nueva a la más vieja. */
export const AUDIT_PAGE_LIMIT = 100;
/** El segundo de retraso de `rate_limited` cuando la cola de hashes está llena (ADR-0019 §1). */
const HASHER_BUSY_SECONDS = 1;

/**
 * Una sesión ya autenticada: el `session_id` UUIDv7 de la fila (lo que nombran la auditoría y los
 * cierres), el identificador de 32 bytes de la cookie (para el token CSRF), la cuenta y la última
 * actividad conocida.
 */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly accountId: string;
  readonly lastActivityMs: number;
}

export interface SessionServiceDeps {
  readonly pool: Pick<Pool, 'connect' | 'query'>;
  readonly keys: Pick<ApiKeys, 'totpKey' | 'tokenKey'>;
  readonly hasher: PasswordHasher;
  /** Milisegundos desde 1970: la hora de cada fila y de cada entrada, y la del código TOTP. */
  readonly clock: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly newId: () => string;
  readonly limiter: RateLimiter;
  readonly failures: LoginFailureBuffer;
}

export interface SessionService {
  /**
   * Inicia sesión con el nombre, la contraseña y el código (ADR-0019 §1 y §2). Devuelve el
   * identificador de la sesión nueva y su token CSRF, o lanza `LoginError` o `RateLimitedError`. La
   * respuesta ante cualquier dato incorrecto es siempre `invalid_credentials`, y un nombre que no
   * existe calcula un hash igual que uno que sí, para que el tiempo no diga qué nombres existen.
   */
  login(input: {
    readonly username: string;
    readonly password: string;
    readonly code: string;
    readonly address: string;
    readonly requestId: string;
  }): Promise<{ readonly sessionSecret: string; readonly csrfToken: string }>;
  /** La sesión válida del identificador de la cookie, o `null` (cerrada, vencida o inactiva). */
  authenticate(sessionSecret: string | null): Promise<AuthenticatedSession | null>;
  /** Renueva la inactividad, con una fila nueva como mucho una vez por minuto (ADR-0019 §2). */
  renewActivity(session: AuthenticatedSession): Promise<void>;
  /** Cierra la sesión actual. Devuelve cuántas cerró (1, o 0 si ya no estaba abierta). */
  logout(input: {
    readonly session: AuthenticatedSession;
    readonly requestId: string;
  }): Promise<number>;
  /** Cierra las demás sesiones de la cuenta. Devuelve cuántas cerró. */
  closeOthers(input: {
    readonly session: AuthenticatedSession;
    readonly requestId: string;
  }): Promise<number>;
  /** Las entradas de auditoría de la cuenta de la sesión, de la más nueva a la más vieja (§5). */
  listAudit(session: AuthenticatedSession): Promise<AuditEvent[]>;
  /** El token CSRF de una sesión, desde el identificador de su cookie, para devolverlo (ADR-0019 §2). */
  csrfToken(sessionSecret: string): string;
  /** Comprueba el token CSRF de una sesión en tiempo constante (la tercera condición, §2). */
  validateCsrf(sessionSecret: string, token: unknown): boolean;
  /** Escribe las ventanas de fallos agrupados que queden, al parar la API (ADR-0019 §5). */
  flushPendingFailures(): Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** La espera en segundos de un tiempo en milisegundos, de 1 a 3600 (los de `rate_limited`). */
function secondsFrom(ms: number): number {
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

/** Las sesiones y el inicio de sesión sobre PostgreSQL (ADR-0019 §1, §2 y §5). */
export function createSessionService(deps: SessionServiceDeps): SessionService {
  const event = (fields: AuditFields, nowUtc: string): AuditEvent =>
    auditEvent(deps.newId, fields, nowUtc);
  const account = (accountId: string): AuditObject => ({ kind: 'account', id: accountId });
  const session = (sessionId: string): AuditObject => ({ kind: 'session', id: sessionId });
  const credentialObject = (credentialId: string): AuditObject => ({
    kind: 'credential',
    id: credentialId,
  });

  const lastActivityMs = (row: {
    readonly createdAtUtc: string;
    readonly lastActivityUtc: string | null;
  }): number => {
    const created = Date.parse(row.createdAtUtc);
    return row.lastActivityUtc === null
      ? created
      : Math.max(created, Date.parse(row.lastActivityUtc));
  };

  /** Comprueba una contraseña con el hasher; la cola llena pasa a `RateLimitedError`. */
  const verify = async (passwordHash: string, password: string): Promise<boolean> => {
    try {
      return await deps.hasher.verify(passwordHash, password);
    } catch (error) {
      if (error instanceof PasswordHasherBusyError) {
        throw new RateLimitedError(HASHER_BUSY_SECONDS);
      }
      throw error;
    }
  };

  /** Escribe una entrada `login_failures` de una ventana cerrada. Best-effort: no corta la respuesta. */
  const writeFailureWindow = async (window: LoginFailureWindow, now: number): Promise<void> => {
    try {
      await insertAuditEvent(
        deps.pool,
        event(
          {
            account_id: window.accountId,
            actor: 'anonymous',
            action: 'login_failures',
            reason: window.reason,
            objects: [],
            request_id: null,
            failure_count: window.count,
            window_started_at_utc: iso(window.windowStartMs),
          },
          iso(now),
        ),
      );
    } catch {
      // La auditoría agrupada es de protección y visibilidad; si PostgreSQL no responde, no corta la
      // respuesta del intento, que ya se rechaza por otro motivo.
    }
  };

  const recordGrouped = async (
    reason: GroupedFailureReason,
    accountId: string | null,
    now: number,
  ): Promise<void> => {
    const closed = deps.failures.add(reason, accountId, now);
    if (closed !== null) {
      await writeFailureWindow(closed, now);
    }
  };

  const flushExpired = async (now: number): Promise<void> => {
    for (const window of deps.failures.expired(now)) {
      await writeFailureWindow(window, now);
    }
  };

  const createSession = async (input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly code: string;
    readonly totpSecret: Buffer;
    readonly now: number;
    readonly requestId: string;
  }): Promise<{ readonly sessionSecret: string; readonly csrfToken: string }> => {
    const nowUtc = iso(input.now);
    const currentStep = totpStep(input.now);
    return withTransaction(deps.pool, async (client) => {
      await lockAccountSessions(client, input.accountId);
      const current = await currentCredentialForLogin(client, input.accountId);
      if (current?.credentialId !== input.credentialId || current.disabled) {
        // Un restablecimiento o un bloqueo entró entre la comprobación y el bloqueo.
        throw new LoginError('invalid_credentials');
      }
      const freshStep = await maxTotpStepUsedUpTo(
        client,
        input.credentialId,
        currentStep + TOTP_WINDOW_STEPS,
      );
      const step = matchTotpCode({
        secret: input.totpSecret,
        code: input.code,
        nowMs: input.now,
        lastUsedStep: freshStep,
      });
      if (step === null) {
        // Otro inicio de sesión a la vez usó el mismo código: solo entra uno.
        throw new LoginError('invalid_credentials');
      }
      await insertTotpStepUsed(client, {
        credentialId: input.credentialId,
        step,
        usedAtUtc: nowUtc,
      });
      const sessionId = deps.newId();
      const sessionSecret = newSessionSecret(deps.randomBytes);
      await insertSession(client, {
        sessionId,
        accountId: input.accountId,
        tokenHmac: sessionTokenDigest(deps.keys.tokenKey, sessionSecret),
        createdAtUtc: nowUtc,
        expiresAtUtc: iso(input.now + SESSION_MAX_MS),
      });
      await insertAuditEvent(
        client,
        event(
          {
            account_id: input.accountId,
            actor: 'account',
            action: 'session_started',
            reason: 'password_and_totp',
            objects: auditObjects(account(input.accountId), session(sessionId)),
            request_id: input.requestId,
          },
          nowUtc,
        ),
      );
      // Tope de 10: la nueva ya está abierta, así que mientras haya más de 10, cierra la más antigua.
      let open = await openSessions(client, input.accountId, nowUtc);
      while (open.length > SESSION_LIMIT) {
        const oldest = open[0];
        if (oldest === undefined) {
          break;
        }
        await insertSessionClosure(client, {
          sessionId: oldest,
          reason: 'session_limit',
          closedAtUtc: nowUtc,
        });
        await insertAuditEvent(
          client,
          event(
            {
              account_id: input.accountId,
              actor: 'system',
              action: 'session_closed',
              reason: 'session_limit',
              objects: auditObjects(account(input.accountId), session(oldest)),
              request_id: input.requestId,
            },
            nowUtc,
          ),
        );
        open = open.slice(1);
      }
      return { sessionSecret, csrfToken: csrfTokenFor(deps.keys.tokenKey, sessionSecret) };
    });
  };

  const recordActiveFailure = async (input: {
    readonly accountId: string;
    readonly credentialId: string;
    readonly now: number;
    readonly requestId: string;
  }): Promise<void> => {
    const nowUtc = iso(input.now);
    await withTransaction(deps.pool, async (client) => {
      await lockAccountSessions(client, input.accountId);
      const stats = await credentialFailureStats(client, input.accountId, input.credentialId);
      await insertAuditEvent(
        client,
        event(
          {
            account_id: input.accountId,
            actor: 'anonymous',
            action: 'login_failed',
            reason: 'invalid_credentials',
            objects: auditObjects(account(input.accountId), credentialObject(input.credentialId)),
            request_id: input.requestId,
          },
          nowUtc,
        ),
      );
      if (stats.failures + 1 >= CREDENTIAL_FAILURE_LIMIT) {
        const current = await currentCredentialForLogin(client, input.accountId);
        if (current !== null && current.credentialId === input.credentialId && !current.disabled) {
          await insertCredentialDisablement(client, {
            credentialId: input.credentialId,
            reason: 'failure_limit',
            disabledAtUtc: nowUtc,
          });
          await insertAuditEvent(
            client,
            event(
              {
                account_id: input.accountId,
                actor: 'system',
                action: 'credential_disabled',
                reason: 'failure_limit',
                objects: auditObjects(
                  account(input.accountId),
                  credentialObject(input.credentialId),
                ),
                request_id: input.requestId,
              },
              nowUtc,
            ),
          );
        }
      }
    });
  };

  return {
    async login({ username, password, code, address, requestId }) {
      const now = deps.clock();
      await flushExpired(now);

      const addressWait = deps.limiter.addressFailureWait(address, now);
      if (addressWait > 0) {
        await recordGrouped('rate_limited', null, now);
        throw new RateLimitedError(addressWait);
      }
      const nameAddressWait = deps.limiter.nameAddressWait(username, address, now);
      if (nameAddressWait > 0) {
        await recordGrouped('rate_limited', null, now);
        throw new RateLimitedError(nameAddressWait);
      }

      const found = await findAccount(deps.pool, username);
      const credential: LoginCredentialRow | null =
        found === null ? null : await currentCredentialForLogin(deps.pool, found.accountId);

      if (found === null || credential === null) {
        // Un nombre que no existe, o una cuenta sin credencial: el límite por nombre va en memoria.
        const unknownWait = deps.limiter.unknownNameWait(username, now);
        if (unknownWait > 0) {
          await recordGrouped('rate_limited', null, now);
          throw new RateLimitedError(unknownWait);
        }
        await verify(DUMMY_PASSWORD_HASH, password);
        deps.limiter.recordFailure({ username, address, now, unknownName: true });
        await recordGrouped('unknown_username', null, now);
        throw new LoginError('invalid_credentials');
      }

      // El límite por nombre de una cuenta que existe sale de la base y sobrevive a un reinicio.
      const stats = await credentialFailureStats(
        deps.pool,
        found.accountId,
        credential.credentialId,
      );
      if (stats.failures >= NAME_THROTTLE_FAILURES && stats.lastFailureAtUtc !== null) {
        const elapsed = now - Date.parse(stats.lastFailureAtUtc);
        if (elapsed < NAME_THROTTLE_INTERVAL_MS) {
          await recordGrouped('rate_limited', found.accountId, now);
          throw new RateLimitedError(secondsFrom(NAME_THROTTLE_INTERVAL_MS - elapsed));
        }
      }

      const okPassword = await verify(credential.passwordHash, password);
      const secret = openTotpSecret({
        key: deps.keys.totpKey,
        sealed: credential.totpSecretSealed,
        accountId: found.accountId,
        credentialId: credential.credentialId,
      });
      const lastStep = await maxTotpStepUsedUpTo(
        deps.pool,
        credential.credentialId,
        totpStep(now) + TOTP_WINDOW_STEPS,
      );
      const okCode =
        okPassword && matchTotpCode({ secret, code, nowMs: now, lastUsedStep: lastStep }) !== null;

      if (credential.disabled) {
        deps.limiter.recordFailure({ username, address, now, unknownName: false });
        await recordGrouped('disabled_credential', found.accountId, now);
        // Solo quien acierta los dos factores sabe que la credencial está deshabilitada.
        throw new LoginError(okPassword && okCode ? 'credential_disabled' : 'invalid_credentials');
      }

      if (okPassword && okCode) {
        const result = await createSession({
          accountId: found.accountId,
          credentialId: credential.credentialId,
          code,
          totpSecret: secret,
          now,
          requestId,
        });
        deps.limiter.recordSuccess({ username, address, unknownName: false });
        return result;
      }

      deps.limiter.recordFailure({ username, address, now, unknownName: false });
      await recordActiveFailure({
        accountId: found.accountId,
        credentialId: credential.credentialId,
        now,
        requestId,
      });
      throw new LoginError('invalid_credentials');
    },

    async authenticate(sessionSecret) {
      if (sessionSecret === null || sessionSecretBytes(sessionSecret) === null) {
        return null;
      }
      const row = await findSessionByDigest(
        deps.pool,
        sessionTokenDigest(deps.keys.tokenKey, sessionSecret),
      );
      if (row === null || row.closed) {
        return null;
      }
      const now = deps.clock();
      if (now >= Date.parse(row.expiresAtUtc)) {
        return null;
      }
      const activity = lastActivityMs(row);
      if (now - activity > SESSION_IDLE_MS) {
        return null;
      }
      return {
        sessionId: row.sessionId,
        sessionSecret,
        accountId: row.accountId,
        lastActivityMs: activity,
      };
    },

    async renewActivity(authenticated) {
      const now = deps.clock();
      if (now - authenticated.lastActivityMs < ACTIVITY_MIN_INTERVAL_MS) {
        return;
      }
      await insertSessionActivity(deps.pool, {
        sessionActivityId: deps.newId(),
        sessionId: authenticated.sessionId,
        activityAtUtc: iso(now),
      });
    },

    async logout({ session: authenticated, requestId }) {
      const now = deps.clock();
      const nowUtc = iso(now);
      return withTransaction(deps.pool, async (client) => {
        await lockAccountSessions(client, authenticated.accountId);
        const open = await openSessions(client, authenticated.accountId, nowUtc);
        if (!open.includes(authenticated.sessionId)) {
          return 0;
        }
        await insertSessionClosure(client, {
          sessionId: authenticated.sessionId,
          reason: 'logout',
          closedAtUtc: nowUtc,
        });
        await insertAuditEvent(
          client,
          event(
            {
              account_id: authenticated.accountId,
              actor: 'account',
              action: 'session_closed',
              reason: 'logout',
              objects: auditObjects(
                account(authenticated.accountId),
                session(authenticated.sessionId),
              ),
              request_id: requestId,
            },
            nowUtc,
          ),
        );
        return 1;
      });
    },

    async closeOthers({ session: authenticated, requestId }) {
      const now = deps.clock();
      const nowUtc = iso(now);
      return withTransaction(deps.pool, async (client) => {
        await lockAccountSessions(client, authenticated.accountId);
        const others = await openSessions(
          client,
          authenticated.accountId,
          nowUtc,
          authenticated.sessionId,
        );
        if (others.length === 0) {
          return 0;
        }
        for (const sessionId of others) {
          await insertSessionClosure(client, {
            sessionId,
            reason: 'other_sessions',
            closedAtUtc: nowUtc,
          });
        }
        await insertAuditEvent(
          client,
          event(
            {
              account_id: authenticated.accountId,
              actor: 'account',
              action: 'sessions_closed',
              reason: 'other_sessions',
              objects: auditObjects(
                account(authenticated.accountId),
                ...others.map((id) => session(id)),
              ),
              request_id: requestId,
            },
            nowUtc,
          ),
        );
        return others.length;
      });
    },

    async listAudit(authenticated) {
      const rows = await auditEventsForAccount(
        deps.pool,
        authenticated.accountId,
        AUDIT_PAGE_LIMIT,
      );
      return rows.map((jcs) => auditEventSchema.parse(JSON.parse(jcs)));
    },

    csrfToken(sessionSecret) {
      return csrfTokenFor(deps.keys.tokenKey, sessionSecret);
    },

    validateCsrf(sessionSecret, token) {
      return isValidCsrfToken(deps.keys.tokenKey, sessionSecret, token);
    },

    async flushPendingFailures() {
      const now = deps.clock();
      for (const window of deps.failures.drainAll()) {
        await writeFailureWindow(window, now);
      }
    },
  };
}
