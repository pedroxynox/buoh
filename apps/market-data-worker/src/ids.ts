/**
 * Generador UUIDv7 (RFC 9562) con reloj y entropía inyectados. El pipeline y las pruebas reciben
 * IDs ya generados; solo los comandos operativos conectan este generador al reloj real.
 */
export function createUuidV7Generator(input: {
  readonly now: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
}): () => string {
  return () => {
    const milliseconds = input.now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds >= 2 ** 48) {
      throw new TypeError('El reloj debe devolver milisegundos enteros representables en 48 bits.');
    }
    const random = input.randomBytes(10);
    if (random.byteLength !== 10) {
      throw new TypeError('Se requieren 10 bytes de entropía.');
    }
    const bytes = new Uint8Array(16);
    let remaining = milliseconds;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    bytes.set(random, 6);
    bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    const hex = Buffer.from(bytes).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
