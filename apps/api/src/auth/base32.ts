const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 de RFC 4648 (§6), sin relleno, como lo leen las apps de autenticación en la URI
 * `otpauth://` (ADR-0019 §1). Un secreto TOTP de 20 bytes son 32 caracteres.
 */
export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET.charAt((buffer >>> bits) & 0x1f);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += ALPHABET.charAt((buffer << (5 - bits)) & 0x1f);
  }
  return output;
}
