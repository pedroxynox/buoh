import { uuidV7Schema } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import { createUuidV7Generator } from '../src/ids.js';
import { useDeterminismGuards } from './support.js';

// Los identificadores UUIDv7 de la API (RFC 9562), con reloj y azar inyectados: los de una misma
// transacción, como `link_used` y `account_enrolled`, salen en el orden en que se crean.
useDeterminismGuards();

function sequenceOf(bytes: readonly number[]) {
  let call = 0;
  return (size: number) => {
    call += 1;
    return new Uint8Array(size).fill(bytes[(call - 1) % bytes.length] ?? 0);
  };
}

describe('createUuidV7Generator', () => {
  it('pone los 48 bits de la hora en milisegundos, la versión 7 y la variante RFC', () => {
    const next = createUuidV7Generator({
      now: () => 0x0190_0000_0000,
      randomBytes: () => new Uint8Array(10),
    });
    expect(next()).toBe('01900000-0000-7000-8000-000000000000');
    const ones = createUuidV7Generator({
      now: () => 0x0190_0000_0001,
      randomBytes: () => new Uint8Array(10).fill(0xff),
    });
    expect(ones()).toBe('01900000-0001-7fff-bfff-ffffffffffff');
  });

  it('con otra hora usa azar nuevo, y en la misma hora sube el anterior en uno', () => {
    let now = 0x0190_0000_0000;
    const next = createUuidV7Generator({ now: () => now, randomBytes: sequenceOf([0x00, 0x11]) });
    expect(next()).toBe('01900000-0000-7000-8000-000000000000');
    expect(next()).toBe('01900000-0000-7000-8000-000000000001');
    now += 1;
    expect(next()).toBe('01900000-0001-7111-9111-111111111111');
  });

  it('si el reloj vuelve atrás, sigue después del último', () => {
    let now = 0x0190_0000_0005;
    const next = createUuidV7Generator({ now: () => now, randomBytes: sequenceOf([0x00]) });
    const first = next();
    now -= 3;
    const second = next();
    expect(first).toBe('01900000-0005-7000-8000-000000000000');
    expect(second).toBe('01900000-0005-7000-8000-000000000001');
  });

  it('cuando el azar de un milisegundo se agota, pasa al milisegundo siguiente', () => {
    const next = createUuidV7Generator({
      now: () => 0x0190_0000_0000,
      randomBytes: sequenceOf([0xff, 0x00]),
    });
    expect(next()).toBe('01900000-0000-7fff-bfff-ffffffffffff');
    expect(next()).toBe('01900000-0001-7000-8000-000000000000');
  });

  it('cada identificador cumple UuidV7 y es mayor que el anterior', () => {
    let now = 0x0190_0000_0000;
    const next = createUuidV7Generator({
      now: () => (now += 0.5) | 0,
      randomBytes: sequenceOf([0x3c, 0xa5, 0x00, 0xff]),
    });
    const ids = Array.from({ length: 50 }, next);
    for (const id of ids) {
      expect(uuidV7Schema.safeParse(id).success, id).toBe(true);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rechaza una hora que no es un entero de 48 bits y un azar que no son 10 bytes', () => {
    for (const now of [-1, 1.5, 2 ** 48, Number.NaN]) {
      expect(() =>
        createUuidV7Generator({ now: () => now, randomBytes: () => new Uint8Array(10) })(),
      ).toThrow(TypeError);
    }
    expect(() =>
      createUuidV7Generator({ now: () => 1, randomBytes: () => new Uint8Array(9) })(),
    ).toThrow(TypeError);
  });
});
