/**
 * Los límites de intentos en memoria (ADR-0019 §1). Una dirección IP es un dato personal, así que no
 * se guardan: cada tabla tiene un tope de entradas y olvida cada entrada una hora después de su
 * último intento, la espera más larga. Descartar una entrada no debilita la cuenta del propietario,
 * cuyo límite por nombre y cuyo tope de 100 salen de la base (`store.ts`, `credentialFailureStats`).
 *
 * Aquí viven:
 * - un límite general de peticiones por dirección;
 * - el límite por dirección de 10 intentos fallidos cada 15 minutos, compartido con los enlaces;
 * - la espera por nombre y dirección, que empieza tras el quinto fallo y se duplica hasta 1 hora;
 * - la espera por nombre de un nombre que no existe (≥ 20 fallos → 1 intento por minuto). La de una
 *   cuenta que existe sale de la base.
 */

/** El límite general: como mucho estas peticiones por dirección en la ventana de abajo. */
export const GENERAL_REQUEST_LIMIT = 120;
export const GENERAL_REQUEST_WINDOW_MS = 60_000;
/** Por dirección: 10 intentos fallidos cada 15 minutos (ADR-0019 §1). */
export const ADDRESS_FAILURE_LIMIT = 10;
export const ADDRESS_FAILURE_WINDOW_MS = 15 * 60_000;
/** Los cuatro primeros fallos seguidos no esperan; el quinto espera 30 s, que se duplican hasta 1 h. */
export const FIRST_FREE_FAILURES = 4;
export const BASE_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 60 * 60_000;
/** Por nombre: con 20 fallos seguidos o más, un intento por minuto (ADR-0019 §1). */
export const NAME_THROTTLE_FAILURES = 20;
export const NAME_THROTTLE_INTERVAL_MS = 60_000;
/** Por credencial: 100 fallos seguidos la deshabilitan (lo aplica el servicio sobre la base). */
export const CREDENTIAL_FAILURE_LIMIT = 100;
/** Cada entrada se olvida una hora después de su último intento, y cada tabla tiene un tope. */
const FORGET_MS = 60 * 60_000;
const MAX_ENTRIES = 10_000;

/** La espera en segundos de un tiempo en milisegundos, de 1 a 3600 (los de `rate_limited`). */
function clampSeconds(ms: number): number {
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

/** La espera de un número de fallos seguidos por nombre y dirección (ADR-0019 §1). */
export function escalatingWaitMs(failures: number): number {
  if (failures <= FIRST_FREE_FAILURES) {
    return 0;
  }
  return Math.min(BASE_WAIT_MS * 2 ** (failures - FIRST_FREE_FAILURES - 1), MAX_WAIT_MS);
}

interface Counter {
  count: number;
  /** El inicio de la ventana (límites de ventana fija) o la hora del último intento (fallos). */
  stampMs: number;
}

/** Una tabla en memoria con tope de entradas, que olvida una entrada una hora después de su hora. */
class LimitMap {
  private readonly entries = new Map<string, Counter>();

  get(key: string, now: number): Counter | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && now - entry.stampMs >= FORGET_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, counter: Counter): void {
    this.entries.set(key, counter);
    if (this.entries.size > MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of this.entries) {
        if (entry.stampMs < oldest) {
          oldest = entry.stampMs;
          oldestKey = entryKey;
        }
      }
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

const NUL = '\u0000';

export interface RateLimiter {
  /** Cuenta una petición por su dirección; devuelve los segundos que faltan si pasa del tope, o 0. */
  requestWait(address: string, now: number): number;
  /** Los segundos que faltan por el límite de 10 fallos cada 15 minutos de la dirección, o 0. */
  addressFailureWait(address: string, now: number): number;
  /** Los segundos de la espera por nombre y dirección, o 0. */
  nameAddressWait(username: string, address: string, now: number): number;
  /** Los segundos del límite por nombre de un nombre que no existe (≥ 20 → 1/min), o 0. */
  unknownNameWait(username: string, now: number): number;
  /** Anota un fallo: la ventana de la dirección y la espera por nombre y dirección. */
  recordFailure(input: {
    readonly username: string;
    readonly address: string;
    readonly now: number;
    /** Un nombre que no existe se cuenta también por nombre en memoria. */
    readonly unknownName: boolean;
  }): void;
  /** Anota un fallo solo por dirección (los enlaces, que no llevan nombre). */
  recordAddressFailure(address: string, now: number): void;
  /** Un acierto borra la espera por nombre y dirección (y por nombre, si se llevaba en memoria). */
  recordSuccess(input: {
    readonly username: string;
    readonly address: string;
    readonly unknownName: boolean;
  }): void;
}

/** Crea el limitador en memoria. El reloj llega en cada llamada, para las pruebas. */
export function createRateLimiter(): RateLimiter {
  const requests = new LimitMap();
  const addressFailures = new LimitMap();
  const nameAddressFailures = new LimitMap();
  const nameFailures = new LimitMap();

  const fixedWindowWait = (
    map: LimitMap,
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    count: boolean,
  ): number => {
    const entry = map.get(key, now);
    if (entry === undefined || now - entry.stampMs >= windowMs) {
      if (count) {
        map.set(key, { count: 1, stampMs: now });
      }
      return 0;
    }
    if (entry.count >= limit) {
      return clampSeconds(windowMs - (now - entry.stampMs));
    }
    if (count) {
      entry.count += 1;
      map.set(key, entry);
    }
    return 0;
  };

  return {
    requestWait(address, now) {
      return fixedWindowWait(
        requests,
        address,
        now,
        GENERAL_REQUEST_WINDOW_MS,
        GENERAL_REQUEST_LIMIT,
        true,
      );
    },

    addressFailureWait(address, now) {
      return fixedWindowWait(
        addressFailures,
        address,
        now,
        ADDRESS_FAILURE_WINDOW_MS,
        ADDRESS_FAILURE_LIMIT,
        false,
      );
    },

    nameAddressWait(username, address, now) {
      const entry = nameAddressFailures.get(`${username}${NUL}${address}`, now);
      if (entry === undefined) {
        return 0;
      }
      const remaining = escalatingWaitMs(entry.count) - (now - entry.stampMs);
      return remaining > 0 ? clampSeconds(remaining) : 0;
    },

    unknownNameWait(username, now) {
      const entry = nameFailures.get(username, now);
      if (entry === undefined || entry.count < NAME_THROTTLE_FAILURES) {
        return 0;
      }
      const remaining = NAME_THROTTLE_INTERVAL_MS - (now - entry.stampMs);
      return remaining > 0 ? clampSeconds(remaining) : 0;
    },

    recordFailure({ username, address, now, unknownName }) {
      const addressEntry = addressFailures.get(address, now);
      if (addressEntry === undefined || now - addressEntry.stampMs >= ADDRESS_FAILURE_WINDOW_MS) {
        addressFailures.set(address, { count: 1, stampMs: now });
      } else {
        addressEntry.count += 1;
        addressFailures.set(address, addressEntry);
      }
      const key = `${username}${NUL}${address}`;
      const nameAddressEntry = nameAddressFailures.get(key, now);
      nameAddressFailures.set(key, {
        count: (nameAddressEntry?.count ?? 0) + 1,
        stampMs: now,
      });
      if (unknownName) {
        const nameEntry = nameFailures.get(username, now);
        nameFailures.set(username, { count: (nameEntry?.count ?? 0) + 1, stampMs: now });
      }
    },

    recordAddressFailure(address, now) {
      const entry = addressFailures.get(address, now);
      if (entry === undefined || now - entry.stampMs >= ADDRESS_FAILURE_WINDOW_MS) {
        addressFailures.set(address, { count: 1, stampMs: now });
      } else {
        entry.count += 1;
        addressFailures.set(address, entry);
      }
    },

    recordSuccess({ username, address, unknownName }) {
      nameAddressFailures.delete(`${username}${NUL}${address}`);
      if (unknownName) {
        nameFailures.delete(username);
      }
    },
  };
}
