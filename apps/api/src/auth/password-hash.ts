import { argon2 } from 'node:crypto';

/**
 * El guardado de la contraseña (ADR-0019 §1): Argon2id de `node:crypto`, con una sal aleatoria de
 * 16 bytes, 64 MiB de memoria, 3 pasadas, un hilo y 32 bytes de salida, y la clave del servidor
 * `BUOH_API_PASSWORD_PEPPER` como entrada `secret`. Cada hash guarda su algoritmo y sus parámetros
 * en el formato PHC (`$argon2id$v=19$m=…,t=…,p=…$<sal>$<hash>`, en base64 sin relleno), para poder
 * subirlos después. La clave del servidor no va en el hash: es siempre la de la configuración.
 */
export const ARGON2ID_PARAMETERS = {
  memory: 65_536,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
} as const;
export const PASSWORD_SALT_BYTES = 16;
const PEPPER_BYTES = 32;

/** Las entradas de Argon2id de `node:crypto`; `memory` va en KiB. */
export interface Argon2Parameters {
  readonly message: Uint8Array;
  readonly nonce: Uint8Array;
  readonly secret: Uint8Array;
  readonly associatedData?: Uint8Array;
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
}

export type Argon2Function = (parameters: Argon2Parameters) => Promise<Buffer>;

/** Argon2id de `node:crypto`, en el grupo de hilos de libuv, sin bloquear el proceso. */
export const argon2idTag: Argon2Function = (parameters) =>
  new Promise((resolve, reject) => {
    argon2('argon2id', parameters, (error, tag) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(tag);
    });
  });

/** Hay demasiados hashes esperando: la API responde `rate_limited` (ADR-0019 §1). */
export class PasswordHasherBusyError extends Error {
  constructor() {
    super('Hay demasiadas contraseñas esperando su hash.');
    this.name = 'PasswordHasherBusyError';
  }
}

export interface PasswordHasher {
  /** El hash PHC de la contraseña, normalizada a NFC. */
  hash(password: string): Promise<string>;
}

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/=+$/u, '');

/**
 * El cálculo de los hashes, uno a la vez en el proceso: Argon2id ocupa 64 MiB mientras dura. Con
 * uno en curso, como mucho `maxWaiting` esperan su turno, y el siguiente se rechaza con
 * `PasswordHasherBusyError`, sin calcular nada.
 */
export function createPasswordHasher(deps: {
  readonly pepper: Uint8Array;
  readonly maxWaiting: number;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly argon2?: Argon2Function;
}): PasswordHasher {
  if (deps.pepper.byteLength !== PEPPER_BYTES) {
    throw new TypeError(`La clave del servidor debe tener ${String(PEPPER_BYTES)} bytes.`);
  }
  const compute = deps.argon2 ?? argon2idTag;
  let active = false;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (!active) {
      active = true;
      return;
    }
    if (waiting.length >= deps.maxWaiting) {
      throw new PasswordHasherBusyError();
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      active = false;
    } else {
      next();
    }
  };

  return {
    async hash(password) {
      await acquire();
      try {
        const salt = deps.randomBytes(PASSWORD_SALT_BYTES);
        const tag = await compute({
          message: Buffer.from(password.normalize('NFC'), 'utf8'),
          nonce: salt,
          secret: deps.pepper,
          ...ARGON2ID_PARAMETERS,
        });
        const { memory, passes, parallelism } = ARGON2ID_PARAMETERS;
        return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${base64(salt)}$${base64(tag)}`;
      } finally {
        release();
      }
    },
  };
}
