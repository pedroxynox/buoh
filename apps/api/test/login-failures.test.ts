import { describe, expect, it } from 'vitest';

import {
  createLoginFailureBuffer,
  LOGIN_FAILURE_WINDOW_MS,
} from '../src/accounts/login-failures.js';

// El agrupado de los intentos fallidos (ADR-0019 §5): una entrada por cada ventana de 5 minutos y
// por clase (y, si la hay, por cuenta).

const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const ACCOUNT = '01900000-0000-7000-8000-00000000a001';

describe('createLoginFailureBuffer', () => {
  it('acumula los fallos de una clase en su ventana sin escribir nada todavía', () => {
    const buffer = createLoginFailureBuffer();
    expect(buffer.add('unknown_username', null, T0)).toBeNull();
    expect(buffer.add('unknown_username', null, T0 + 1000)).toBeNull();
    expect(buffer.add('unknown_username', null, T0 + 2000)).toBeNull();
    expect(buffer.expired(T0 + 3000)).toEqual([]);
  });

  it('cierra la ventana al pasar 5 minutos y empieza otra', () => {
    const buffer = createLoginFailureBuffer();
    buffer.add('unknown_username', null, T0);
    buffer.add('unknown_username', null, T0 + 1000);
    const closed = buffer.add('unknown_username', null, T0 + LOGIN_FAILURE_WINDOW_MS);
    expect(closed).toEqual({
      reason: 'unknown_username',
      accountId: null,
      count: 2,
      windowStartMs: T0,
    });
    // La ventana nueva arranca en 1.
    const next = buffer.expired(T0 + 2 * LOGIN_FAILURE_WINDOW_MS);
    expect(next).toEqual([
      {
        reason: 'unknown_username',
        accountId: null,
        count: 1,
        windowStartMs: T0 + LOGIN_FAILURE_WINDOW_MS,
      },
    ]);
  });

  it('separa por clase y por cuenta', () => {
    const buffer = createLoginFailureBuffer();
    buffer.add('unknown_username', null, T0);
    buffer.add('disabled_credential', ACCOUNT, T0);
    buffer.add('disabled_credential', ACCOUNT, T0 + 1000);
    buffer.add('rate_limited', null, T0);
    const drained = buffer.drainAll().sort((a, b) => a.reason.localeCompare(b.reason));
    expect(drained).toEqual([
      { reason: 'disabled_credential', accountId: ACCOUNT, count: 2, windowStartMs: T0 },
      { reason: 'rate_limited', accountId: null, count: 1, windowStartMs: T0 },
      { reason: 'unknown_username', accountId: null, count: 1, windowStartMs: T0 },
    ]);
    expect(buffer.drainAll()).toEqual([]);
  });

  it('expired solo devuelve las ventanas cuyos 5 minutos pasaron, y las quita', () => {
    const buffer = createLoginFailureBuffer();
    buffer.add('unknown_username', null, T0);
    buffer.add('rate_limited', null, T0 + 4 * 60_000);
    const expired = buffer.expired(T0 + LOGIN_FAILURE_WINDOW_MS);
    expect(expired).toEqual([
      { reason: 'unknown_username', accountId: null, count: 1, windowStartMs: T0 },
    ]);
    // La de rate_limited aún no ha cumplido su ventana.
    expect(buffer.expired(T0 + LOGIN_FAILURE_WINDOW_MS)).toEqual([]);
    expect(buffer.drainAll()).toEqual([
      { reason: 'rate_limited', accountId: null, count: 1, windowStartMs: T0 + 4 * 60_000 },
    ]);
  });
});
