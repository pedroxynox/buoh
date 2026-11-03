import { describe, expect, it } from 'vitest';

import {
  ADDRESS_FAILURE_LIMIT,
  BASE_WAIT_MS,
  createRateLimiter,
  escalatingWaitMs,
  GENERAL_REQUEST_LIMIT,
  GENERAL_REQUEST_WINDOW_MS,
  MAX_WAIT_MS,
  NAME_THROTTLE_FAILURES,
} from '../src/accounts/limits.js';

// Los límites de intentos en memoria (ADR-0019 §1). El reloj llega en cada llamada, así que no hay
// reloj real ni temporizadores.

const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const ADDR = '203.0.113.7';
const OTHER = '198.51.100.9';
const NAME = 'pedro';

describe('escalatingWaitMs', () => {
  it('no espera en los cuatro primeros fallos; el quinto espera 30 s, que se duplican hasta 1 hora', () => {
    for (let failures = 0; failures <= 4; failures += 1) {
      expect(escalatingWaitMs(failures), String(failures)).toBe(0);
    }
    expect(escalatingWaitMs(5)).toBe(BASE_WAIT_MS);
    expect(escalatingWaitMs(6)).toBe(BASE_WAIT_MS * 2);
    expect(escalatingWaitMs(7)).toBe(BASE_WAIT_MS * 4);
    // Desde algún punto, todas las esperas quedan en el tope de 1 hora.
    expect(escalatingWaitMs(11)).toBe(BASE_WAIT_MS * 64);
    expect(escalatingWaitMs(12)).toBe(MAX_WAIT_MS);
    expect(escalatingWaitMs(50)).toBe(MAX_WAIT_MS);
  });
});

describe('nameAddressWait', () => {
  it('empieza tras el quinto fallo seguido y se agota al pasar la espera', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0 + i, unknownName: false });
    }
    expect(limiter.nameAddressWait(NAME, ADDR, T0 + 4)).toBe(0);
    limiter.recordFailure({ username: NAME, address: ADDR, now: T0 + 5, unknownName: false });
    expect(limiter.nameAddressWait(NAME, ADDR, T0 + 5)).toBe(30);
    // Pasada la espera de 30 s, ya puede intentar.
    expect(limiter.nameAddressWait(NAME, ADDR, T0 + 5 + 30_000)).toBe(0);
  });

  it('la espera de un atacante no afecta a otra dirección hasta el vigésimo fallo', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 19; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: false });
    }
    // El propietario, desde otra dirección, no espera.
    expect(limiter.nameAddressWait(NAME, OTHER, T0)).toBe(0);
    // El atacante, en cambio, sí.
    expect(limiter.nameAddressWait(NAME, ADDR, T0)).toBe(3600);
  });

  it('un acierto borra la espera por nombre y dirección', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 6; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: false });
    }
    expect(limiter.nameAddressWait(NAME, ADDR, T0)).toBeGreaterThan(0);
    limiter.recordSuccess({ username: NAME, address: ADDR, unknownName: false });
    expect(limiter.nameAddressWait(NAME, ADDR, T0)).toBe(0);
  });

  it('olvida la entrada una hora después del último intento', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 6; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: false });
    }
    expect(limiter.nameAddressWait(NAME, ADDR, T0 + 60 * 60_000)).toBe(0);
  });
});

describe('unknownNameWait', () => {
  it('un nombre que no existe con 20 fallos admite un intento por minuto', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < NAME_THROTTLE_FAILURES - 1; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: true });
    }
    expect(limiter.unknownNameWait(NAME, T0)).toBe(0);
    limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: true });
    expect(limiter.unknownNameWait(NAME, T0)).toBe(60);
    expect(limiter.unknownNameWait(NAME, T0 + 60_000)).toBe(0);
  });

  it('solo cuenta por nombre los fallos de un nombre que no existe', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 25; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: false });
    }
    expect(limiter.unknownNameWait(NAME, T0)).toBe(0);
  });
});

describe('addressFailureWait', () => {
  it('bloquea tras 10 fallos en 15 minutos y se libera al pasar la ventana', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < ADDRESS_FAILURE_LIMIT; i += 1) {
      expect(limiter.addressFailureWait(ADDR, T0)).toBe(0);
      limiter.recordAddressFailure(ADDR, T0);
    }
    expect(limiter.addressFailureWait(ADDR, T0)).toBe(15 * 60);
    expect(limiter.addressFailureWait(ADDR, T0 + 15 * 60_000)).toBe(0);
    // Otra dirección no se ve afectada.
    expect(limiter.addressFailureWait(OTHER, T0)).toBe(0);
  });

  it('recordFailure también cuenta por dirección', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < ADDRESS_FAILURE_LIMIT; i += 1) {
      limiter.recordFailure({ username: NAME, address: ADDR, now: T0, unknownName: false });
    }
    expect(limiter.addressFailureWait(ADDR, T0)).toBeGreaterThan(0);
  });
});

describe('requestWait', () => {
  it('cuenta cada petición y bloquea al pasar del tope en la ventana', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < GENERAL_REQUEST_LIMIT; i += 1) {
      expect(limiter.requestWait(ADDR, T0), String(i)).toBe(0);
    }
    expect(limiter.requestWait(ADDR, T0)).toBe(GENERAL_REQUEST_WINDOW_MS / 1000);
    // La ventana siguiente arranca de cero.
    expect(limiter.requestWait(ADDR, T0 + GENERAL_REQUEST_WINDOW_MS)).toBe(0);
    // Cada dirección va por su cuenta.
    expect(limiter.requestWait(OTHER, T0)).toBe(0);
  });
});
