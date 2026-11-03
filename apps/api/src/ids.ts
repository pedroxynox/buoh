/** Los 74 bits aleatorios de un UUIDv7: 12 de `rand_a` y 62 de `rand_b` (RFC 9562 §5.7). */
const RANDOM_BITS = 74n;
const RANDOM_LIMIT = 1n << RANDOM_BITS;
const RAND_B_BITS = 62n;

/**
 * Un generador de UUIDv7 (RFC 9562) con el reloj y el azar inyectados, como el del worker, que la
 * API no importa. Sus identificadores crecen siempre dentro del proceso (§6.2, método 2): en el
 * mismo milisegundo, o si el reloj vuelve atrás, el siguiente es el anterior más uno. Así, las
 * entradas de auditoría de una misma transacción quedan en el orden en que se crean.
 */
export function createUuidV7Generator(input: {
  readonly now: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
}): () => string {
  let lastMs = -1;
  let lastRandom = 0n;

  const fresh = (): bigint => {
    const random = input.randomBytes(10);
    if (random.byteLength !== 10) {
      throw new TypeError('Se requieren 10 bytes de entropía.');
    }
    let value = BigInt((random[0] ?? 0) & 0x0f);
    value = (value << 8n) | BigInt(random[1] ?? 0);
    value = (value << 6n) | BigInt((random[2] ?? 0) & 0x3f);
    for (let index = 3; index < 10; index += 1) {
      value = (value << 8n) | BigInt(random[index] ?? 0);
    }
    return value;
  };

  return () => {
    const now = input.now();
    if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
      throw new TypeError('El reloj debe devolver milisegundos enteros representables en 48 bits.');
    }
    let ms = now;
    let random: bigint;
    if (ms > lastMs) {
      random = fresh();
    } else {
      ms = lastMs;
      random = lastRandom + 1n;
      if (random >= RANDOM_LIMIT) {
        ms = lastMs + 1;
        random = fresh();
      }
    }
    if (ms >= 2 ** 48) {
      throw new TypeError('El reloj de los identificadores se salió de 48 bits.');
    }
    lastMs = ms;
    lastRandom = random;

    const bytes = new Uint8Array(16);
    let remaining = ms;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    const randA = Number(random >> RAND_B_BITS);
    let randB = random & ((1n << RAND_B_BITS) - 1n);
    bytes[6] = 0x70 | (randA >> 8);
    bytes[7] = randA & 0xff;
    for (let index = 15; index >= 9; index -= 1) {
      bytes[index] = Number(randB & 0xffn);
      randB >>= 8n;
    }
    bytes[8] = 0x80 | Number(randB & 0x3fn);
    const hex = Buffer.from(bytes).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
