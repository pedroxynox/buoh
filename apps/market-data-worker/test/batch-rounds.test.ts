import { describe, expect, it } from 'vitest';

import {
  BATCH_RUN_INTERVAL_MS,
  batchProfileKindOf,
  batchRound,
} from '../src/deriv/batch-rounds.js';
import {
  BATCH_CANDLES_SEQUENCE,
  BATCH_QUOTES_SEQUENCE,
  BATCH_SCHEDULES_SEQUENCE,
  GOLD_SEQUENCE,
  R_100_SEQUENCE,
} from '../src/index.js';

// Las vueltas de los lotes (ADR-0021 §3; precisión del PR 5c1 de su §9): los vectores salen de §3,
// cada día los horarios y las velas del día anterior, y cada media hora las 126 cotizaciones
// repartidas entre sus seis ejecuciones, y de la regla de la vuelta que cambia.

describe('batchRound: los horarios y las velas, una vuelta por día UTC', () => {
  it('los horarios piden las 11 del día, desde la primera ejecución del día, y una vez hechas no piden más', () => {
    const first = batchRound(BATCH_SCHEDULES_SEQUENCE, '2026-11-26T00:00:07.000Z', null);
    expect(first).toMatchObject({ abandoned: null, from: 0, round: '2026-11-26', until: 11 });
    expect(first.requests[0]).toEqual({ date: '2026-11-26', operation: 'trading_times' });
    expect(first.requests[1]).toEqual({ date: '2026-11-27', operation: 'trading_times' });
    const done = batchRound(BATCH_SCHEDULES_SEQUENCE, '2026-11-26T23:59:59.999Z', {
      next: 11,
      round: '2026-11-26',
    });
    expect(done.from).toBe(11);
    expect(done.from >= done.until).toBe(true);
    // A medias, la misma vuelta sigue donde quedó.
    expect(
      batchRound(BATCH_SCHEDULES_SEQUENCE, '2026-11-26T08:00:00.000Z', {
        next: 4,
        round: '2026-11-26',
      }),
    ).toMatchObject({ from: 4, until: 11 });
  });

  it('las velas piden las 14 páginas del día anterior, ya completo', () => {
    const round = batchRound(BATCH_CANDLES_SEQUENCE, '2026-11-26T00:00:07.000Z', null);
    expect(round).toMatchObject({ from: 0, round: '2026-11-25', until: 14 });
    expect(round.requests[0]).toMatchObject({
      end: Date.UTC(2026, 10, 25, 12) / 1000 - 1,
      operation: 'ticks_history',
      start: Date.UTC(2026, 10, 25) / 1000,
    });
    // El 1 de enero, las del 31 de diciembre.
    expect(batchRound(BATCH_CANDLES_SEQUENCE, '2027-01-01T00:05:00.000Z', null).round).toBe(
      '2026-12-31',
    );
  });

  it('una vuelta nueva que llega con la anterior sin terminar empieza en 0 y deja lo que faltaba en abandoned', () => {
    expect(
      batchRound(BATCH_SCHEDULES_SEQUENCE, '2026-11-27T00:00:07.000Z', {
        next: 7,
        round: '2026-11-26',
      }),
    ).toMatchObject({
      abandoned: { remaining: 4, round: '2026-11-26' },
      from: 0,
      round: '2026-11-27',
    });
    // Una vuelta anterior terminada no deja nada.
    expect(
      batchRound(BATCH_SCHEDULES_SEQUENCE, '2026-11-27T00:00:07.000Z', {
        next: 11,
        round: '2026-11-26',
      }).abandoned,
    ).toBeNull();
  });
});

describe('batchRound: las cotizaciones, una vuelta por media hora repartida entre sus seis ejecuciones', () => {
  it('la ejecución k de la media hora pide hasta la ⌈126 (k + 1) / 6⌉, y la media hora empieza en el minuto 0 o 30', () => {
    expect(BATCH_RUN_INTERVAL_MS).toBe(300_000);
    const untilAt = (time: string) => batchRound(BATCH_QUOTES_SEQUENCE, time, null).until;
    expect(
      [
        '10:00:00.000',
        '10:05:00.000',
        '10:10:00.000',
        '10:15:00.000',
        '10:20:00.000',
        '10:25:00.000',
      ].map((time) => untilAt(`2026-11-26T${time}Z`)),
    ).toEqual([21, 42, 63, 84, 105, 126]);
    expect(untilAt('2026-11-26T10:04:59.999Z')).toBe(21);
    expect(untilAt('2026-11-26T10:29:59.999Z')).toBe(126);
    const round = batchRound(BATCH_QUOTES_SEQUENCE, '2026-11-26T10:31:00.000Z', null);
    expect(round).toMatchObject({ from: 0, round: '2026-11-26T10:30:00.000Z', until: 21 });
    expect(round.requests).toHaveLength(126);
  });

  it('una ejecución que se salta la recupera la siguiente, y la que para sigue desde su cursor', () => {
    expect(
      batchRound(BATCH_QUOTES_SEQUENCE, '2026-11-26T10:10:30.000Z', {
        next: 21,
        round: '2026-11-26T10:00:00.000Z',
      }),
    ).toMatchObject({ abandoned: null, from: 21, until: 63 });
    expect(
      batchRound(BATCH_QUOTES_SEQUENCE, '2026-11-26T10:07:00.000Z', {
        next: 30,
        round: '2026-11-26T10:00:00.000Z',
      }),
    ).toMatchObject({ from: 30, until: 42 });
  });

  it('con la media hora siguiente, lo que faltaba de la anterior queda abandonado', () => {
    expect(
      batchRound(BATCH_QUOTES_SEQUENCE, '2026-11-26T10:30:10.000Z', {
        next: 100,
        round: '2026-11-26T10:00:00.000Z',
      }),
    ).toMatchObject({
      abandoned: { remaining: 26, round: '2026-11-26T10:00:00.000Z' },
      from: 0,
      round: '2026-11-26T10:30:00.000Z',
      until: 21,
    });
  });
});

describe('batchRound: lo que rechaza', () => {
  it('una secuencia sin perfil de los lotes, una hora que no es UTC y un cursor que no es un entero de 0 en adelante', () => {
    for (const sequence of [R_100_SEQUENCE, GOLD_SEQUENCE]) {
      expect(() => batchProfileKindOf(sequence)).toThrow(TypeError);
      expect(() => batchRound(sequence, '2026-11-26T10:00:00.000Z', null)).toThrow(TypeError);
    }
    expect(() => batchRound(BATCH_QUOTES_SEQUENCE, 'ayer', null)).toThrow(TypeError);
    for (const next of [-1, 1.5, Number.NaN]) {
      expect(() =>
        batchRound(BATCH_QUOTES_SEQUENCE, '2026-11-26T10:00:00.000Z', {
          next,
          round: '2026-11-26T10:00:00.000Z',
        }),
      ).toThrow(TypeError);
    }
    expect(batchProfileKindOf(BATCH_SCHEDULES_SEQUENCE)).toBe('schedules');
    expect(batchProfileKindOf(BATCH_QUOTES_SEQUENCE)).toBe('quotes');
    expect(batchProfileKindOf(BATCH_CANDLES_SEQUENCE)).toBe('candles');
  });
});
