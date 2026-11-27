import type { SourceEvent } from '@buoh/contracts';
import {
  BATCH_SOURCE_SCHEMA_OPERATIONS,
  batchSourceSchemaBytes,
  createBatchLogConfig,
} from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import {
  BATCH_DATASET_SEGMENT_CEILING,
  batchElementsOf,
  nextBatchMark,
  planBatchDataset,
  type BatchPlanSegment,
} from '../src/datasets/batch-plan.js';
import { DATASET_ELEMENT_CEILING } from '../src/datasets/plan.js';
import {
  batchFrame,
  catalogText,
  pageText,
  quoteText,
  rateLimitText,
  sessionText,
} from './support/batch-frames.js';

// Dónde termina cada dataset de los lotes (precisión del PR 5d2 de ADR-0021 §9), sin red ni reloj
// real: las marcas de cada clase (las cotizaciones cada 3 horas, las velas cada día y los horarios
// cada semana), el techo de 72 segmentos, el de 16 000 elementos, que cuenta los registros y las
// respuestas que no dan ninguno, y lo que lee el plan.

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Segmentos contiguos desde `from`, uno por hora de `starts`, con `frames` respuestas cada uno. */
function rows(from: number, starts: readonly string[], frames = 10): BatchPlanSegment[] {
  return starts.map((start, offset) => ({
    first_event_time_utc: start,
    raw_frame_count: frames,
    segment_index: from + offset,
  }));
}

/** Un plan con segmentos sintéticos: cada uno con `elements` elementos; anota lo que lee. */
function plan(
  input: Partial<Parameters<typeof planBatchDataset>[0]> & {
    readonly closedSegments: readonly BatchPlanSegment[];
  },
  elements: (index: number) => number = () => 10,
) {
  const reads: number[] = [];
  const result = planBatchDataset({
    elementsOf: (events) => elements(Number((events[0] as { event_id: string }).event_id)),
    from: input.closedSegments[0]?.segment_index ?? 0,
    kind: 'quotes',
    logTerminated: false,
    readSegment: (index) => {
      reads.push(index);
      return Promise.resolve([{ event_id: String(index) } as unknown as SourceEvent]);
    },
    ...input,
  });
  return { reads, result };
}

describe('nextBatchMark: las marcas de cada clase', () => {
  it('cotizaciones cada 3 horas desde la medianoche UTC, velas cada medianoche y horarios cada lunes', () => {
    expect(iso(nextBatchMark('quotes', '2026-11-26T02:59:59.999Z'))).toBe(
      '2026-11-26T03:00:00.000Z',
    );
    expect(iso(nextBatchMark('quotes', '2026-11-26T03:00:00.000Z'))).toBe(
      '2026-11-26T06:00:00.000Z',
    );
    expect(iso(nextBatchMark('quotes', '2026-11-26T22:10:00.000Z'))).toBe(
      '2026-11-27T00:00:00.000Z',
    );
    expect(iso(nextBatchMark('candles', '2026-11-26T00:00:00.000Z'))).toBe(
      '2026-11-27T00:00:00.000Z',
    );
    expect(iso(nextBatchMark('candles', '2026-11-26T23:59:59.999Z'))).toBe(
      '2026-11-27T00:00:00.000Z',
    );
    // El jueves 2026-11-26 da el lunes 2026-11-30; un lunes a las 00:00, el lunes siguiente.
    expect(iso(nextBatchMark('schedules', '2026-11-26T00:01:00.000Z'))).toBe(
      '2026-11-30T00:00:00.000Z',
    );
    expect(iso(nextBatchMark('schedules', '2026-11-30T00:00:00.000Z'))).toBe(
      '2026-12-07T00:00:00.000Z',
    );
    expect(() => nextBatchMark('quotes', 'no es una hora')).toThrow(TypeError);
  });
});

describe('planBatchDataset: dónde termina un dataset de los lotes', () => {
  it('mientras la marca no llega, espera sin leer nada', async () => {
    const { reads, result } = plan({
      closedSegments: rows(0, ['2026-11-26T00:00:30.000Z', '2026-11-26T02:55:30.000Z']),
    });
    expect(await result).toEqual({ reason: 'mark_not_reached', status: 'not_due' });
    expect(reads).toEqual([]);
  });

  it('con la marca alcanzada, termina en el último segmento que empieza antes de ella y no lee más', async () => {
    const { reads, result } = plan({
      closedSegments: rows(4, [
        '2026-11-26T00:00:30.000Z',
        '2026-11-26T02:55:30.000Z',
        '2026-11-26T03:00:30.000Z',
        '2026-11-26T03:05:30.000Z',
      ]),
    });
    expect(await result).toMatchObject({
      clean: true,
      elements: 20,
      from: 4,
      open: { open_condition_types: [], pending_continuity_symbols: [] },
      status: 'due',
      to: 5,
    });
    expect(reads).toEqual([4, 5]);
  });

  it('cada clase, con su marca: un día de velas y una semana de horarios', async () => {
    const candles = plan({
      closedSegments: rows(0, [
        '2026-11-26T00:01:00.000Z',
        '2026-11-26T00:06:00.000Z',
        '2026-11-27T00:01:00.000Z',
      ]),
      kind: 'candles',
    });
    expect(await candles.result).toMatchObject({ status: 'due', to: 1 });
    const week = [
      '2026-11-24T00:01:00.000Z',
      '2026-11-25T00:01:00.000Z',
      '2026-11-29T00:01:00.000Z',
    ];
    const open = plan({ closedSegments: rows(0, week), kind: 'schedules' });
    expect(await open.result).toEqual({ reason: 'mark_not_reached', status: 'not_due' });
    const monday = plan({
      closedSegments: rows(0, [...week, '2026-11-30T00:01:00.000Z']),
      kind: 'schedules',
    });
    expect(await monday.result).toMatchObject({ status: 'due', to: 2 });
  });

  it('un log terminado termina en su último segmento, sin esperar la marca', async () => {
    const { result } = plan({
      closedSegments: rows(0, ['2026-11-26T00:00:30.000Z', '2026-11-26T00:05:30.000Z']),
      logTerminated: true,
    });
    expect(await result).toMatchObject({ from: 0, status: 'due', to: 1 });
  });

  it('sin segmentos desde from: nada en un log terminado, y espera en el activo', async () => {
    expect(await plan({ closedSegments: [], logTerminated: true }).result).toEqual({
      status: 'nothing_due',
    });
    expect(await plan({ closedSegments: [] }).result).toEqual({
      reason: 'awaiting_segments',
      status: 'not_due',
    });
  });

  it(`como mucho ${String(BATCH_DATASET_SEGMENT_CEILING)} segmentos, también antes de la marca`, async () => {
    expect(BATCH_DATASET_SEGMENT_CEILING).toBe(72);
    const starts = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        iso(Date.parse('2026-11-26T00:00:30.000Z') + index * MINUTE),
      );
    // 71 segmentos antes de la marca: espera.
    expect(await plan({ closedSegments: rows(0, starts(71)) }).result).toMatchObject({
      status: 'not_due',
    });
    // 72: el dataset está decidido, sin esperar a las 03:00.
    const full = plan({ closedSegments: rows(0, starts(80)) });
    expect(await full.result).toMatchObject({ from: 0, status: 'due', to: 71 });
    expect(full.reads).toHaveLength(72);
    // Con la marca alcanzada después de 72, también 72.
    const reached = plan({
      closedSegments: rows(0, [...starts(80), '2026-11-26T03:00:30.000Z']),
    });
    expect(await reached.result).toMatchObject({ status: 'due', to: 71 });
  });

  it('el techo de elementos: termina en el último segmento que cabe, y el primero que no cabe solo lo detiene', async () => {
    const starts = [
      '2026-11-26T00:00:30.000Z',
      '2026-11-26T00:05:30.000Z',
      '2026-11-26T00:10:30.000Z',
      '2026-11-26T03:00:30.000Z',
    ];
    const cut = plan({ closedSegments: rows(0, starts) }, (index) => (index === 2 ? 9_000 : 7_000));
    expect(await cut.result).toMatchObject({ elements: 14_000, status: 'due', to: 1 });
    expect(cut.reads).toEqual([0, 1, 2]);
    // En el techo justo, cabe.
    const exact = plan({ closedSegments: rows(0, starts) }, (index) =>
      index === 2 ? DATASET_ELEMENT_CEILING - 14_000 : 7_000,
    );
    expect(await exact.result).toMatchObject({ elements: DATASET_ELEMENT_CEILING, to: 2 });
    const large = plan({ closedSegments: rows(0, starts) }, () => DATASET_ELEMENT_CEILING + 1);
    expect(await large.result).toEqual({
      elements: DATASET_ELEMENT_CEILING + 1,
      segment_index: 0,
      status: 'segment_too_large',
    });
  });

  it('antes de la marca, solo lee si sus respuestas ya pasan el techo: cada una es al menos un elemento', async () => {
    const starts = ['2026-11-26T00:00:30.000Z', '2026-11-26T00:05:30.000Z'];
    const quiet = plan({ ceiling: 30, closedSegments: rows(0, starts, 15) });
    expect(await quiet.result).toEqual({ reason: 'mark_not_reached', status: 'not_due' });
    expect(quiet.reads).toEqual([]);
    const over = plan({ ceiling: 29, closedSegments: rows(0, starts, 15) }, () => 15);
    expect(await over.result).toMatchObject({ elements: 15, status: 'due', to: 0 });
  });

  it('rechaza segmentos que no son contiguos o sin hora', async () => {
    await expect(
      plan({
        closedSegments: [
          ...rows(0, ['2026-11-26T00:00:30.000Z']),
          ...rows(2, ['2026-11-26T00:05:30.000Z']),
        ],
      }).result,
    ).rejects.toThrow(TypeError);
    await expect(plan({ closedSegments: rows(0, ['ayer']) }).result).rejects.toThrow(TypeError);
  });
});

describe('batchElementsOf: los elementos de un segmento de los lotes (ADR-0021 §3)', () => {
  const OPEN = '{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}';
  const config = createBatchLogConfig({
    source_schema_bytes: batchSourceSchemaBytes(
      Object.fromEntries(
        BATCH_SOURCE_SCHEMA_OPERATIONS.map((operation) => [
          operation,
          new TextEncoder().encode(OPEN),
        ]),
      ) as Parameters<typeof batchSourceSchemaBytes>[0],
    ),
    source_schema_release: 'synthetic-v1',
    trading_times_symbols: ['frxXAUUSD'],
  });
  const T = Date.parse('2026-11-24T12:00:00.000Z') / 1000;
  const at = (seconds: number) => iso((T + seconds) * 1000);

  it('cuenta los registros de sus respuestas y una por cada respuesta que no da ninguno', () => {
    const events = [
      batchFrame(quoteText(100, T), at(1)),
      batchFrame(rateLimitText, at(2)),
      batchFrame(catalogText, at(3)),
      // Tres velas.
      batchFrame(pageText(T, T + 179, [T, T + 60, T + 120]), at(3600)),
      // Dos intervalos del horario del oro: una sesión.
      batchFrame(sessionText('2026-11-24'), at(3601)),
    ];
    // 1 cotización, 1 error, 1 catálogo, 3 velas y 1 sesión.
    expect(batchElementsOf(events, config)).toBe(7);
    expect(batchElementsOf([], config)).toBe(0);
  });

  it('una vela repetida en el mismo segmento no es un registro, y su página sigue contando las suyas', () => {
    const page = pageText(T, T + 59, [T]);
    const events = [batchFrame(page, at(3600)), batchFrame(page, at(3601))];
    // La segunda página solo da un candle_repeated: cuenta como una respuesta sin registros.
    expect(batchElementsOf(events, config)).toBe(2);
  });
});
