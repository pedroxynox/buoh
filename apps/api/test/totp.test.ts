import { describe, expect, it } from 'vitest';

import { base32Encode } from '../src/auth/base32.js';
import { hotp, matchTotpCode, totpStep } from '../src/auth/totp.js';
import { useDeterminismGuards } from './support.js';

// El código de 6 cifras (ADR-0019 §1 y §13): HOTP de RFC 4226, TOTP de RFC 6238 con SHA-1 y pasos
// de 30 s, la ventana de un paso a cada lado y el paso que vale una sola vez. Los valores esperados
// son los de los apéndices de las RFC, no los de la implementación.
useDeterminismGuards();

/** La semilla de los vectores SHA-1 de RFC 4226 y RFC 6238: "12345678901234567890" en ASCII. */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('base32 (RFC 4648 §10)', () => {
  it('codifica los vectores de la RFC, sin relleno', () => {
    const vectors: readonly (readonly [string, string])[] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [input, expected] of vectors) {
      expect(base32Encode(new TextEncoder().encode(input)), input).toBe(expected);
    }
  });

  it('un secreto de 20 bytes son 32 caracteres de A-Z y 2-7', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Encode(new Uint8Array(20).fill(0xff))).toBe('7'.repeat(32));
  });
});

describe('HOTP (RFC 4226, apéndice D)', () => {
  it('reproduce los diez códigos de 6 cifras de la RFC', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });
});

describe('TOTP (RFC 6238, apéndice B, SHA-1)', () => {
  // Los vectores de la RFC son de 8 cifras: los de 6 son sus 6 últimas.
  it.each([
    [59, 1, '287082'],
    [1_111_111_109, 0x0235_23ec, '081804'],
    [1_111_111_111, 0x0235_23ed, '050471'],
    [1_234_567_890, 0x0273_ef07, '005924'],
    [2_000_000_000, 0x03f9_40aa, '279037'],
    [20_000_000_000, 0x27bc_86aa, '353130'],
  ])('a los %i s, el paso es %i y el código %s', (seconds, step, code) => {
    expect(totpStep(seconds * 1000)).toBe(step);
    expect(hotp(RFC_SECRET, step)).toBe(code);
    expect(
      matchTotpCode({ secret: RFC_SECRET, code, nowMs: seconds * 1000, lastUsedStep: null }),
    ).toBe(step);
  });

  it('el paso cambia cada 30 s exactos', () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(59_999)).toBe(1);
  });
});

describe('matchTotpCode', () => {
  // A los 1 111 111 111 s el paso es 0x023523ed; los vectores dan el código del paso anterior.
  const now = 1_111_111_111_000;
  const step = 0x0235_23ed;
  const codeAt = (n: number) => hotp(RFC_SECRET, n);

  it('acepta el paso actual y uno a cada lado, y devuelve el paso aceptado', () => {
    for (const candidate of [step - 1, step, step + 1]) {
      expect(
        matchTotpCode({
          secret: RFC_SECRET,
          code: codeAt(candidate),
          nowMs: now,
          lastUsedStep: null,
        }),
      ).toBe(candidate);
    }
  });

  it('rechaza dos pasos o más de distancia', () => {
    for (const candidate of [step - 3, step - 2, step + 2, step + 3]) {
      expect(
        matchTotpCode({
          secret: RFC_SECRET,
          code: codeAt(candidate),
          nowMs: now,
          lastUsedStep: null,
        }),
        String(candidate - step),
      ).toBeNull();
    }
  });

  it('un paso vale una sola vez, y nunca uno anterior al último aceptado', () => {
    const used = (lastUsedStep: number, candidate: number) =>
      matchTotpCode({ secret: RFC_SECRET, code: codeAt(candidate), nowMs: now, lastUsedStep });
    expect(used(step, step)).toBeNull();
    expect(used(step, step - 1)).toBeNull();
    expect(used(step, step + 1)).toBe(step + 1);
    expect(used(step + 1, step)).toBeNull();
    expect(used(step - 1, step)).toBe(step);
    expect(used(step - 2, step - 1)).toBe(step - 1);
  });

  it('rechaza un código que no es de 6 cifras ASCII, y uno de otro secreto', () => {
    for (const code of ['', '12345', '1234567', ' 50471', '٠٥٠٤٧١', '05047a']) {
      expect(
        matchTotpCode({ secret: RFC_SECRET, code, nowMs: now, lastUsedStep: null }),
        code,
      ).toBeNull();
    }
    const other = new TextEncoder().encode('09876543210987654321');
    expect(
      matchTotpCode({ secret: other, code: codeAt(step), nowMs: now, lastUsedStep: null }),
    ).toBeNull();
  });
});
