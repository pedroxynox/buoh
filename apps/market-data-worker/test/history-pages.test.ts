import type { SourceEvent } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import { planHistoryDataset } from '../src/datasets/batch-plan.js';
import { derivCandleHistoryProfile, derivHistoryProfile } from '../src/deriv/batch-profile.js';
import type { BatchRequest } from '../src/deriv/batch-requests.js';
import {
  blockOfRequest,
  closesHistoryBlock,
  historyAnswerOf,
  historyAnswersIn,
  historyPlan,
  historyResumeIndex,
  trancheIndexOf,
} from '../src/deriv/history-pages.js';
import {
  batchFrame,
  candleErrorText,
  candlePageText,
  historyErrorText,
  historyPageText,
  historyRateLimitText,
  sessionText,
} from './support/batch-frames.js';

// Las respuestas de la historia en su log (precisión del PR 6c de ADR-0021 §9), sin red ni reloj
// real: qué petición respondió cada frame, desde cuál sigue el comando de la historia sin pedir
// ninguna otra vez, y dónde termina el dataset de cada bloque, uno por dataset.

const GOLD = historyPlan(derivHistoryProfile('frxXAUUSD'));
const R_100 = historyPlan(derivHistoryProfile('R_100'));

type Tranche = Extract<BatchRequest, { readonly start: number }>;
const tranche = (request: BatchRequest | undefined): Tranche => {
  if (request?.operation !== 'ticks_history') {
    throw new TypeError('No es un tramo.');
  }
  return request;
};
const dateOf = (request: BatchRequest | undefined): string => {
  if (request?.operation !== 'trading_times') {
    throw new TypeError('No es un horario.');
  }
  return request.date;
};

/** El último bloque del oro, el corto, y el anterior, entero. */
const LAST = GOLD.blocks.length - 1;
const lastFirst = GOLD.firsts[LAST] ?? 0;
const previousFirst = GOLD.firsts[LAST - 1] ?? 0;

const frame = (text: string) => batchFrame(text, '2027-01-01T00:00:00.000Z');
const page = (index: number) => {
  const { end, start } = tranche(GOLD.requests[index]);
  return historyPageText('frxXAUUSD', start, end, [start]);
};
const session = (index: number) => sessionText(dateOf(GOLD.requests[index]));

describe('historyAnswerOf: qué petición de la historia respondió un frame', () => {
  it('una página o un error cuentan, un RateLimit no, y solo los de la historia del símbolo', () => {
    const { end, start } = tranche(GOLD.requests[lastFirst + 1]);
    expect(historyAnswerOf(historyPageText('frxXAUUSD', start, end), GOLD.profile)).toEqual({
      end,
      kind: 'tranche',
      start,
      symbol: 'frxXAUUSD',
    });
    expect(historyAnswerOf(historyErrorText('frxXAUUSD', start, end), GOLD.profile)).toEqual({
      end,
      kind: 'tranche',
      start,
      symbol: 'frxXAUUSD',
    });
    expect(historyAnswerOf(historyRateLimitText('frxXAUUSD', start, end), GOLD.profile)).toBeNull();
    expect(historyAnswerOf(historyPageText('R_100', start, end), GOLD.profile)).toBeNull();
    expect(historyAnswerOf(sessionText('2026-11-25'), GOLD.profile)).toEqual({
      date: '2026-11-25',
      kind: 'schedule',
    });
    expect(historyAnswerOf('no es JSON', GOLD.profile)).toBeNull();
    // Una página de velas, o su error, no es de la historia de ticks.
    expect(
      historyAnswerOf(
        historyPageText('frxXAUUSD', start, end).replace('"style":"ticks"', '"style":"candles"'),
        GOLD.profile,
      ),
    ).toBeNull();
    expect(historyAnswerOf(candlePageText('frxXAUUSD', start, end), GOLD.profile)).toBeNull();
    expect(historyAnswerOf(candleErrorText('frxXAUUSD', start, end), GOLD.profile)).toBeNull();
  });
});

describe('las peticiones de la historia en una lista', () => {
  it('cada tramo tiene su índice, y el último de cada bloque lo cierra, también el último, corto', () => {
    const first = tranche(GOLD.requests[1]);
    expect(trancheIndexOf(GOLD, 'frxXAUUSD', first.start, first.end)).toBe(1);
    const lastOfFirst = tranche(GOLD.requests[16]);
    expect(closesHistoryBlock(GOLD, 'frxXAUUSD', lastOfFirst.start, lastOfFirst.end)).toBe(true);
    expect(closesHistoryBlock(GOLD, 'frxXAUUSD', first.start, first.end)).toBe(false);
    const final = tranche(GOLD.requests.at(-1));
    expect(final.end).toBe(GOLD.profile.end_epoch);
    expect(trancheIndexOf(GOLD, 'frxXAUUSD', final.start, final.end)).toBe(
      GOLD.requests.length - 1,
    );
    expect(closesHistoryBlock(GOLD, 'frxXAUUSD', final.start, final.end)).toBe(true);
    // Un tramo de otro símbolo, con otro final, o que no empieza en un tramo, no es de la historia.
    expect(trancheIndexOf(GOLD, 'R_100', first.start, first.end)).toBeNull();
    expect(trancheIndexOf(GOLD, 'frxXAUUSD', first.start, first.end + 1)).toBeNull();
    expect(trancheIndexOf(GOLD, 'frxXAUUSD', first.start + 1, first.end)).toBeNull();
    expect(
      trancheIndexOf(
        GOLD,
        'frxXAUUSD',
        GOLD.profile.start_epoch - 900,
        GOLD.profile.start_epoch - 1,
      ),
    ).toBeNull();
    // En R_100, bloques de 13 peticiones.
    const r100 = tranche(R_100.requests[13 + 12]);
    expect(closesHistoryBlock(R_100, 'R_100', r100.start, r100.end)).toBe(true);
    expect(blockOfRequest(R_100, 13)).toBe(1);
    expect(blockOfRequest(R_100, 25)).toBe(1);
    expect(blockOfRequest(R_100, 26)).toBe(2);
    expect(blockOfRequest(GOLD, GOLD.requests.length - 1)).toBe(LAST);
  });
});

describe('historyResumeIndex: desde qué petición sigue la historia', () => {
  const answers = (texts: readonly string[]) => historyAnswersIn(texts.map(frame), GOLD.profile);

  it('después del último tramo respondido; el horario que le seguía no se pide otra vez', () => {
    expect(
      historyResumeIndex(GOLD, answers([session(previousFirst), page(previousFirst + 1)])),
    ).toBe(previousFirst + 2);
    // Un RateLimit no cuenta: esa página se pide otra vez.
    const { end, start } = tranche(GOLD.requests[previousFirst + 2]);
    expect(
      historyResumeIndex(
        GOLD,
        answers([page(previousFirst + 1), historyRateLimitText('frxXAUUSD', start, end)]),
      ),
    ).toBe(previousFirst + 2);
    // El bloque anterior terminó y llegó el horario del siguiente: sigue en su primer tramo.
    expect(historyResumeIndex(GOLD, answers([page(lastFirst - 1), session(lastFirst)]))).toBe(
      lastFirst + 1,
    );
    // Un horario de otro día no es el que seguía.
    expect(
      historyResumeIndex(GOLD, answers([page(lastFirst - 1), sessionText('2020-01-01')])),
    ).toBe(lastFirst);
    // Sin ningún tramo, no se sabe.
    expect(historyResumeIndex(GOLD, answers([session(lastFirst)]))).toBeNull();
    expect(historyResumeIndex(GOLD, [])).toBeNull();
    // Todo pedido.
    expect(historyResumeIndex(GOLD, answers([page(GOLD.requests.length - 1)]))).toBe(
      GOLD.requests.length,
    );
  });
});

describe('planHistoryDataset: un bloque por dataset', () => {
  /** Segmentos sintéticos con sus textos; anota lo que lee. */
  function plan(
    segments: readonly (readonly string[])[],
    options: { logTerminated?: boolean; segmentCeiling?: number; ceiling?: number } = {},
  ) {
    const events = segments.map((texts) => texts.map(frame) as SourceEvent[]);
    const reads: number[] = [];
    const result = planHistoryDataset({
      closedSegments: events.map((_, index) => ({
        first_event_time_utc: '2027-01-01T00:00:00.000Z',
        raw_frame_count: segments[index]?.length ?? 0,
        segment_index: 3 + index,
      })),
      elementsOf: (items) => items.length,
      from: 3,
      logTerminated: options.logTerminated ?? false,
      plan: GOLD,
      readSegment: (index) => {
        reads.push(index);
        return Promise.resolve(events[index - 3] ?? []);
      },
      ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
      ...(options.segmentCeiling === undefined ? {} : { segmentCeiling: options.segmentCeiling }),
    });
    return { reads, result };
  }
  const block = Array.from({ length: 17 }, (_, offset) =>
    offset === 0 ? session(previousFirst) : page(previousFirst + offset),
  );

  it('termina en el segmento con la respuesta del último tramo del bloque, y no lee más', async () => {
    // Un bloque en dos ejecuciones, la primera parada por un RateLimit, y el bloque siguiente.
    const { end, start } = tranche(GOLD.requests[previousFirst + 6]);
    const { reads, result } = plan([
      [...block.slice(0, 6), historyRateLimitText('frxXAUUSD', start, end)],
      block.slice(6, 15),
      block.slice(15),
      [session(lastFirst), page(lastFirst + 1)],
    ]);
    expect(await result).toMatchObject({ from: 3, status: 'due', to: 5 });
    expect(reads).toEqual([3, 4, 5]);
  });

  it('un error al último tramo también lo cierra; un RateLimit no', async () => {
    const last = tranche(GOLD.requests[previousFirst + 16]);
    expect(
      await plan([[...block.slice(0, 16), historyErrorText('frxXAUUSD', last.start, last.end)]])
        .result,
    ).toMatchObject({ status: 'due', to: 3 });
    expect(
      await plan([[...block.slice(0, 16), historyRateLimitText('frxXAUUSD', last.start, last.end)]])
        .result,
    ).toEqual({ reason: 'awaiting_segments', status: 'not_due' });
  });

  it('sin el último tramo, espera; en un log terminado, o en el techo de segmentos o de elementos, termina antes', async () => {
    const half = [block.slice(0, 8), block.slice(8, 12)];
    expect(await plan(half).result).toEqual({ reason: 'awaiting_segments', status: 'not_due' });
    expect(await plan(half, { logTerminated: true }).result).toMatchObject({
      status: 'due',
      to: 4,
    });
    expect(await plan(half, { segmentCeiling: 1 }).result).toMatchObject({ status: 'due', to: 3 });
    expect(await plan(half, { ceiling: 10 }).result).toMatchObject({ status: 'due', to: 3 });
    expect(await plan(half, { ceiling: 7 }).result).toEqual({
      elements: 8,
      segment_index: 3,
      status: 'segment_too_large',
    });
    expect(await plan([], { logTerminated: true }).result).toEqual({ status: 'nothing_due' });
    expect(await plan([]).result).toEqual({ reason: 'awaiting_segments', status: 'not_due' });
  });
});

describe('la historia de las velas (precisión del PR 6d de ADR-0021 §9): un día por bloque', () => {
  const CANDLES = historyPlan(derivCandleHistoryProfile());
  const MARKETS = [
    'cryBTCUSD',
    'cryETHUSD',
    'frxEURUSD',
    'frxGBPUSD',
    'frxUSDJPY',
    'frxXAGUSD',
    'frxXAUUSD',
  ];
  const DAY = 86_400;
  const HALF = 43_200;
  const candleFrame = (index: number) => {
    const request = CANDLES.requests[index];
    if (request?.operation === 'trading_times') {
      return frame(sessionText(request.date, MARKETS));
    }
    const { end, start, symbol } = tranche(request);
    return frame(candlePageText(symbol, start, end, [start]));
  };

  it('del 2025-11-26 al 2026-11-25: el horario de cada día y sus 14 páginas, de 12 horas por mercado', () => {
    expect(CANDLES.blocks).toHaveLength(365);
    expect(CANDLES.requests).toHaveLength(365 * 15);
    expect(CANDLES.requests[0]).toEqual({ date: '2025-11-26', operation: 'trading_times' });
    expect(CANDLES.requests.at(-15)).toEqual({ date: '2026-11-25', operation: 'trading_times' });
    const first = CANDLES.profile.start_epoch;
    expect(new Date(first * 1000).toISOString()).toBe('2025-11-26T00:00:00.000Z');
    expect(new Date((CANDLES.profile.end_epoch + 1) * 1000).toISOString()).toBe(
      '2026-11-26T00:00:00.000Z',
    );
    expect(CANDLES.requests.slice(1, 15)).toEqual(
      MARKETS.flatMap((symbol) =>
        [0, 1].map((page) => ({
          count: 1000,
          end: first + (page + 1) * HALF - 1,
          granularity: 60,
          operation: 'ticks_history',
          start: first + page * HALF,
          symbol,
        })),
      ),
    );
    expect(CANDLES.firsts.slice(0, 3)).toEqual([0, 15, 30]);
    expect(CANDLES.blocks[1]?.start).toBe(first + DAY);
  });

  it('una página de velas de sus mercados, o su error, cuenta; un RateLimit, los ticks y otro mercado, no', () => {
    const start = CANDLES.profile.start_epoch;
    const end = start + HALF - 1;
    expect(historyAnswerOf(candlePageText('cryETHUSD', start, end), CANDLES.profile)).toEqual({
      end,
      kind: 'tranche',
      start,
      symbol: 'cryETHUSD',
    });
    expect(historyAnswerOf(candleErrorText('frxEURUSD', start, end), CANDLES.profile)).toEqual({
      end,
      kind: 'tranche',
      start,
      symbol: 'frxEURUSD',
    });
    expect(
      historyAnswerOf(candleErrorText('frxEURUSD', start, end, 'RateLimit'), CANDLES.profile),
    ).toBeNull();
    expect(historyAnswerOf(candlePageText('R_100', start, end), CANDLES.profile)).toBeNull();
    expect(historyAnswerOf(historyPageText('frxXAUUSD', start, end), CANDLES.profile)).toBeNull();
    expect(historyAnswerOf(historyErrorText('frxXAUUSD', start, end), CANDLES.profile)).toBeNull();
    expect(
      historyAnswerOf(
        candlePageText('frxXAUUSD', start, end).replace('"granularity":60', '"granularity":120'),
        CANDLES.profile,
      ),
    ).toBeNull();
    expect(historyAnswerOf(sessionText('2025-11-26', MARKETS), CANDLES.profile)).toEqual({
      date: '2025-11-26',
      kind: 'schedule',
    });
  });

  it('cada página tiene su índice por mercado, y la segunda del oro cierra el día', () => {
    const start = CANDLES.profile.start_epoch;
    expect(trancheIndexOf(CANDLES, 'cryBTCUSD', start, start + HALF - 1)).toBe(1);
    expect(trancheIndexOf(CANDLES, 'cryETHUSD', start, start + HALF - 1)).toBe(3);
    expect(trancheIndexOf(CANDLES, 'frxXAUUSD', start + HALF, start + DAY - 1)).toBe(14);
    expect(trancheIndexOf(CANDLES, 'R_100', start, start + HALF - 1)).toBeNull();
    expect(trancheIndexOf(CANDLES, 'cryBTCUSD', start, start + HALF)).toBeNull();
    expect(closesHistoryBlock(CANDLES, 'frxXAUUSD', start + HALF, start + DAY - 1)).toBe(true);
    expect(closesHistoryBlock(CANDLES, 'frxXAGUSD', start + HALF, start + DAY - 1)).toBe(false);
    expect(closesHistoryBlock(CANDLES, 'frxXAUUSD', start, start + HALF - 1)).toBe(false);
    const last = CANDLES.profile.end_epoch;
    expect(trancheIndexOf(CANDLES, 'frxXAUUSD', last + 1 - HALF, last)).toBe(
      CANDLES.requests.length - 1,
    );
    expect(blockOfRequest(CANDLES, 14)).toBe(0);
    expect(blockOfRequest(CANDLES, 15)).toBe(1);
  });

  it('sigue después de la última página respondida, y del horario del día siguiente', () => {
    const answers = (indexes: readonly number[]) =>
      historyAnswersIn(indexes.map(candleFrame), CANDLES.profile);
    expect(historyResumeIndex(CANDLES, answers([0, 1, 2, 3]))).toBe(4);
    expect(historyResumeIndex(CANDLES, answers([13, 14, 15]))).toBe(16);
    expect(historyResumeIndex(CANDLES, answers([14]))).toBe(15);
    expect(historyResumeIndex(CANDLES, answers([0]))).toBeNull();
  });

  it('un dataset por día: termina en el segmento con la última página del oro', async () => {
    const day = Array.from({ length: 15 }, (_, index) => candleFrame(15 + index));
    const segments = [day.slice(0, 10), day.slice(10), [candleFrame(30)]];
    const events = segments.map((items) => items as SourceEvent[]);
    const reads: number[] = [];
    const result = await planHistoryDataset({
      closedSegments: events.map((items, index) => ({
        first_event_time_utc: '2027-01-01T00:00:00.000Z',
        raw_frame_count: items.length,
        segment_index: index,
      })),
      elementsOf: (items) => items.length,
      from: 0,
      logTerminated: false,
      plan: CANDLES,
      readSegment: (index) => {
        reads.push(index);
        return Promise.resolve(events[index] ?? []);
      },
    });
    expect(result).toMatchObject({ elements: 15, from: 0, status: 'due', to: 1 });
    expect(reads).toEqual([0, 1]);
  });
});
