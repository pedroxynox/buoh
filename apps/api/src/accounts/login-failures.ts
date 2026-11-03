/**
 * El agrupado de los intentos fallidos que no quedan uno a uno (ADR-0019 §5): los de un nombre que
 * no existe (`unknown_username`), los que llegan a una credencial deshabilitada (`disabled_credential`)
 * y los que rechaza un límite (`rate_limited`). Se cuentan en memoria y se escriben como una entrada
 * `login_failures` por cada ventana de 5 minutos y por clase (y, si la hay, por cuenta), para que un
 * ataque no llene el disco de 1 GB que comparte la captura.
 */
export const LOGIN_FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_WINDOWS = 1_000;

export type GroupedFailureReason = 'unknown_username' | 'disabled_credential' | 'rate_limited';

/** Una ventana de fallos agrupados, lista para escribirse como una entrada `login_failures`. */
export interface LoginFailureWindow {
  readonly reason: GroupedFailureReason;
  readonly accountId: string | null;
  readonly count: number;
  readonly windowStartMs: number;
}

interface MutableWindow {
  count: number;
  windowStartMs: number;
}

export interface LoginFailureBuffer {
  /**
   * Suma un fallo a su ventana. Si la ventana anterior de esa clase ya se cerró (pasaron 5 minutos),
   * la devuelve para escribirla y empieza otra; si no, devuelve `null`.
   */
  add(
    reason: GroupedFailureReason,
    accountId: string | null,
    now: number,
  ): LoginFailureWindow | null;
  /** Devuelve y quita las ventanas cuyos 5 minutos ya pasaron, para escribirlas. */
  expired(now: number): LoginFailureWindow[];
  /** Devuelve y quita todas las ventanas, al parar la API. */
  drainAll(): LoginFailureWindow[];
}

function keyOf(reason: GroupedFailureReason, accountId: string | null): string {
  return `${reason}\u0000${accountId ?? ''}`;
}

export function createLoginFailureBuffer(): LoginFailureBuffer {
  const windows = new Map<
    string,
    MutableWindow & { reason: GroupedFailureReason; accountId: string | null }
  >();

  const evictIfNeeded = (): void => {
    if (windows.size <= MAX_WINDOWS) {
      return;
    }
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, window] of windows) {
      if (window.windowStartMs < oldest) {
        oldest = window.windowStartMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      windows.delete(oldestKey);
    }
  };

  return {
    add(reason, accountId, now) {
      const key = keyOf(reason, accountId);
      const existing = windows.get(key);
      if (existing === undefined) {
        windows.set(key, { reason, accountId, count: 1, windowStartMs: now });
        evictIfNeeded();
        return null;
      }
      if (now - existing.windowStartMs < LOGIN_FAILURE_WINDOW_MS) {
        existing.count += 1;
        return null;
      }
      const closed: LoginFailureWindow = {
        reason: existing.reason,
        accountId: existing.accountId,
        count: existing.count,
        windowStartMs: existing.windowStartMs,
      };
      existing.count = 1;
      existing.windowStartMs = now;
      return closed;
    },

    expired(now) {
      const closed: LoginFailureWindow[] = [];
      for (const [key, window] of windows) {
        if (now - window.windowStartMs >= LOGIN_FAILURE_WINDOW_MS) {
          closed.push({
            reason: window.reason,
            accountId: window.accountId,
            count: window.count,
            windowStartMs: window.windowStartMs,
          });
          windows.delete(key);
        }
      }
      return closed;
    },

    drainAll() {
      const all = [...windows.values()].map((window) => ({
        reason: window.reason,
        accountId: window.accountId,
        count: window.count,
        windowStartMs: window.windowStartMs,
      }));
      windows.clear();
      return all;
    },
  };
}
