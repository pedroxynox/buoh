import { argon2, timingSafeEqual } from 'node:crypto';

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

/** El formato PHC de un hash de la contraseña: algoritmo, versión, parámetros, sal y hash. */
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=([1-9][0-9]*),t=([1-9][0-9]*),p=([1-9][0-9]*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

/**
 * Los parámetros de un hash que `verify` acepta recomputar. Son holgados sobre los de producción,
 * para poder subirlos, pero acotados: un hash con parámetros enormes, que solo podría insertar quien
 * tenga la contraseña de `buoh_api`, no obliga a la API a gastar memoria o tiempo sin límite.
 */
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;
const MIN_TAG_BYTES = 16;
const MAX_TAG_BYTES = 64;

/**
 * Un hash de ejemplo con los parámetros de producción, para el trabajo en balde de un inicio de
 * sesión con un nombre que no existe: `verify` lo recomputa igual que uno real y devuelve `false`,
 * para que el tiempo de respuesta no diga qué nombres existen (ADR-0019 §1). Su sal y su hash son
 * ceros; el hash nunca coincide con el recomputado.
 */
export const DUMMY_PASSWORD_HASH = `$argon2id$v=19$m=${String(65_536)},t=${String(3)},p=${String(1)}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

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
  /**
   * Si la contraseña (normalizada a NFC) corresponde al hash PHC, en tiempo constante. Un hash mal
   * formado o con parámetros fuera de rango da `false`, pero calcula igual, para que el tiempo no lo
   * delate. Para un nombre que no existe se pasa `DUMMY_PASSWORD_HASH`. Comparte el límite de hashes
   * en curso con `hash`: si hay demasiados esperando, lanza `PasswordHasherBusyError`.
   */
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/** Los parámetros con los que `verify` recomputa un hash, o `null` si el PHC no vale o se pasa. */
function parsePhc(passwordHash: string): {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
} | null {
  const match = PHC_PATTERN.exec(passwordHash);
  if (match?.[1] === undefined) {
    return null;
  }
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4] ?? '', 'base64');
  const tag = Buffer.from(match[5] ?? '', 'base64');
  if (
    memory > MAX_MEMORY_KIB ||
    passes > MAX_PASSES ||
    parallelism > MAX_PARALLELISM ||
    tag.length < MIN_TAG_BYTES ||
    tag.length > MAX_TAG_BYTES
  ) {
    return null;
  }
  return { memory, passes, parallelism, salt, tag };
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

    async verify(passwordHash, password) {
      await acquire();
      try {
        const parsed = parsePhc(passwordHash);
        const message = Buffer.from(password.normalize('NFC'), 'utf8');
        if (parsed === null) {
          // Un hash que no vale: calcula igual, con los parámetros de producción, y no acierta.
          await compute({
            message,
            nonce: Buffer.alloc(PASSWORD_SALT_BYTES),
            secret: deps.pepper,
            ...ARGON2ID_PARAMETERS,
          });
          return false;
        }
        const tag = await compute({
          message,
          nonce: parsed.salt,
          secret: deps.pepper,
          memory: parsed.memory,
          passes: parsed.passes,
          parallelism: parsed.parallelism,
          tagLength: parsed.tag.length,
        });
        return timingSafeEqual(tag, parsed.tag);
      } finally {
        release();
      }
    },
  };
}
