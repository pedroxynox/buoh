import type { SourceEvent } from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contentKey } from '../src/object-keys.js';
import type { OperationalAlert } from '../src/operational/registry.js';
import {
  assembleChartWindow,
  CHART_FOLD_LIMIT,
  ChartCheckpointError,
  chartItemsOf,
  readChartWindow,
  type ChartGap,
  type ChartItem,
  type ChartSegmentCache,
} from '../src/source-log/chart-window.js';
import { LiveCheckpointLookup } from '../src/source-log/live-checkpoint.js';
import { SourceEventLog } from '../src/source-log/source-event-log.js';
import {
  A,
  at,
  B,
  C,
  close,
  open,
  ping,
  recovery,
  T0,
  tick,
} from '../../../packages/domain/test/support/live-corpus.js';
import {
  captureEvents,
  ms,
  NO_START,
  reconnectedEvents,
  ticksBetween,
  wholeLogChart,
  writeCapture,
} from './support/chart-capture.js';
import { checkpointRowsOf } from './support/live-checkpoint-rows.js';
import { eventsOf, measurement, SYMBOL } from './support/live-corpus.js';
import { MemoryObjectStore, MemorySourceLogStore } from './support/memory-stores.js';

// El gráfico de una ventana (ADR-0019 §8; concepto de interfaz §9): los ticks del flujo, uno por
// instante, y los huecos que marca el log, con su motivo, leyendo solo los segmentos que tocan la
// ventana y partiendo de los puntos de control. Los valores esperados están calculados a mano; la
// lectura desde los puntos de control se compara además con la del log entero. Almacenes en memoria,
// sin red, reloj real ni azar; ningún precio es de mercado.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida.');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tickItem = (epoch: number, quote: string, fingerprint = 'b'.repeat(64)): ChartItem => ({
  fingerprint,
  kind: 'tick',
  quote_decimal: quote,
  time_ms: ms(epoch),
});

function gap(
  from: number,
  to: number | null,
  rest: Pick<ChartGap, 'cause' | 'history'> & Partial<ChartGap>,
): ChartGap {
  return { from_ms: from, reason: null, recovered_ticks: null, to_ms: to, ...rest };
}

describe('assembleChartWindow', () => {
  it('un tick por instante de la ventana, en orden, con el de menor huella si llegan varios', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0 + 2),
      items: [
        tickItem(T0, '100.000'),
        tickItem(T0 + 4, '100.400'),
        tickItem(T0 + 2, '100.200', 'c'.repeat(64)),
        // El mismo instante, otra cotización y una huella menor: gana este.
        tickItem(T0 + 2, '100.250', 'a'.repeat(64)),
        // Repetido, como el que repite la suscripción al reconectar.
        tickItem(T0 + 4, '100.400'),
        tickItem(T0 + 6, '100.600'),
        tickItem(T0 + 8, '100.800'),
      ],
      pending: [],
      start: NO_START,
      to_ms: ms(T0 + 6),
    });
    expect(window).toEqual({
      gaps: [],
      ticks: [
        { quote_decimal: '100.250', time_ms: ms(T0 + 2) },
        { quote_decimal: '100.400', time_ms: ms(T0 + 4) },
        { quote_decimal: '100.600', time_ms: ms(T0 + 6) },
      ],
    });
  });

  it('cada resultado de la historia es un hueco de conexión, con su motivo y los ticks que trajo', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [
        tickItem(T0, '100.000'),
        {
          from_ms: ms(T0, 1),
          kind: 'recovery',
          reason: null,
          recovered_ticks: 2,
          status: 'complete',
          to_ms: ms(T0 + 5, 999),
        },
        {
          from_ms: ms(T0 + 10, 1),
          kind: 'recovery',
          reason: 'history_page_limit',
          recovered_ticks: 3,
          status: 'partial',
          to_ms: ms(T0 + 19, 999),
        },
        {
          from_ms: ms(T0 + 30, 1),
          kind: 'recovery',
          reason: 'history_timeout',
          recovered_ticks: null,
          status: 'unavailable',
          to_ms: ms(T0 + 39, 999),
        },
      ],
      pending: [],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window.gaps).toEqual([
      gap(ms(T0, 1), ms(T0 + 5, 999), {
        cause: 'connection_lost',
        history: 'recovered',
        recovered_ticks: 2,
      }),
      gap(ms(T0 + 10, 1), ms(T0 + 19, 999), {
        cause: 'connection_lost',
        history: 'partial',
        reason: 'history_page_limit',
        recovered_ticks: 3,
      }),
      gap(ms(T0 + 30, 1), ms(T0 + 39, 999), {
        cause: 'connection_lost',
        history: 'unavailable',
        reason: 'history_timeout',
      }),
    ]);
  });

  it('un partial que después resuelve un complete del mismo rango queda como recuperado', () => {
    const range = { from_ms: ms(T0, 1), to_ms: ms(T0 + 5, 999) };
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [
        {
          ...range,
          kind: 'recovery',
          reason: 'history_page_limit',
          recovered_ticks: 0,
          status: 'partial',
        },
        { ...range, kind: 'recovery', reason: null, recovered_ticks: 2, status: 'complete' },
      ],
      pending: [],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window.gaps).toEqual([
      gap(range.from_ms, range.to_ms, {
        cause: 'connection_lost',
        history: 'recovered',
        recovered_ticks: 2,
      }),
    ]);
  });

  it('un hueco pendiente del final, con fin o sin él', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [],
      pending: [
        { from_ms: ms(T0 + 2, 1), to_ms: ms(T0 + 7, 999) },
        { from_ms: ms(T0 + 20, 1), to_ms: null },
      ],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window.gaps).toEqual([
      gap(ms(T0 + 2, 1), ms(T0 + 7, 999), { cause: 'connection_lost', history: 'pending' }),
      gap(ms(T0 + 20, 1), null, { cause: 'connection_lost', history: 'pending' }),
    ]);
  });

  it('una parada pedida va del último tick al primero posterior, y el repetido no la termina', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [
        tickItem(T0, '100.000'),
        tickItem(T0 + 2, '100.200'),
        { kind: 'stop' },
        tickItem(T0 + 2, '100.200'),
        tickItem(T0 + 30, '103.000'),
        tickItem(T0 + 32, '103.200'),
        { kind: 'stop' },
      ],
      pending: [],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window.gaps).toEqual([
      gap(ms(T0 + 2, 1), ms(T0 + 29, 999), {
        cause: 'capture_stopped',
        history: 'not_requested',
      }),
      // La segunda sigue: no llegó ningún tick después.
      gap(ms(T0 + 32, 1), null, { cause: 'capture_stopped', history: 'not_requested' }),
    ]);
    expect(window.ticks.map((item) => item.time_ms)).toEqual([
      ms(T0),
      ms(T0 + 2),
      ms(T0 + 30),
      ms(T0 + 32),
    ]);
  });

  it('una parada que cubre un hueco de conexión cuenta como ese hueco', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [
        tickItem(T0, '100.000'),
        { kind: 'stop' },
        tickItem(T0 + 10, '101.000'),
        {
          from_ms: ms(T0, 1),
          kind: 'recovery',
          reason: null,
          recovered_ticks: 4,
          status: 'complete',
          to_ms: ms(T0 + 9, 999),
        },
        tickItem(T0 + 20, '102.000'),
        { kind: 'stop' },
      ],
      pending: [{ from_ms: ms(T0 + 20, 1), to_ms: null }],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window.gaps).toEqual([
      gap(ms(T0, 1), ms(T0 + 9, 999), {
        cause: 'connection_lost',
        history: 'recovered',
        recovered_ticks: 4,
      }),
      gap(ms(T0 + 20, 1), null, { cause: 'connection_lost', history: 'pending' }),
    ]);
  });

  it('con la captura parada al principio, la parada empieza en el último tick de antes', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0 + 100),
      items: [tickItem(T0 + 140, '104.000')],
      pending: [],
      start: { stopped: true, watermark_ms: ms(T0 + 40) },
      to_ms: ms(T0 + 200),
    });
    expect(window.gaps).toEqual([
      gap(ms(T0 + 40, 1), ms(T0 + 139, 999), {
        cause: 'capture_stopped',
        history: 'not_requested',
      }),
    ]);
  });

  it('una parada sin ningún tick antes no tiene de dónde empezar: no hay hueco', () => {
    const window = assembleChartWindow({
      from_ms: ms(T0),
      items: [{ kind: 'stop' }, tickItem(T0 + 10, '101.000')],
      pending: [],
      start: NO_START,
      to_ms: ms(T0 + 60),
    });
    expect(window).toEqual({
      gaps: [],
      ticks: [{ quote_decimal: '101.000', time_ms: ms(T0 + 10) }],
    });
  });

  it('solo quedan los huecos que tocan la ventana, también los que empiezan antes, en orden', () => {
    const recovered = (from: number, to: number): ChartItem => ({
      from_ms: from,
      kind: 'recovery',
      reason: null,
      recovered_ticks: 1,
      status: 'complete',
      to_ms: to,
    });
    const window = assembleChartWindow({
      from_ms: ms(T0 + 100),
      items: [
        recovered(ms(T0 + 150, 1), ms(T0 + 151, 999)),
        recovered(ms(T0 + 10, 1), ms(T0 + 99, 999)),
        recovered(ms(T0 + 90, 1), ms(T0 + 100)),
        recovered(ms(T0 + 200), ms(T0 + 210)),
        recovered(ms(T0 + 201), ms(T0 + 210)),
      ],
      pending: [{ from_ms: ms(T0 + 60, 1), to_ms: null }],
      start: NO_START,
      to_ms: ms(T0 + 200),
    });
    expect(window.gaps.map((item) => [item.from_ms, item.to_ms])).toEqual([
      [ms(T0 + 60, 1), null],
      [ms(T0 + 90, 1), ms(T0 + 100)],
      [ms(T0 + 150, 1), ms(T0 + 151, 999)],
      [ms(T0 + 200), ms(T0 + 210)],
    ]);
  });

  it('sin nada, ni ticks ni huecos', () => {
    expect(
      assembleChartWindow({
        from_ms: ms(T0),
        items: [],
        pending: [],
        start: NO_START,
        to_ms: ms(T0 + 60),
      }),
    ).toEqual({ gaps: [], ticks: [] });
  });
});

describe('chartItemsOf', () => {
  it('los ticks del símbolo, sus cierres pedidos y sus resultados de la historia, en orden', () => {
    const events = eventsOf(
      [
        open(1, A, null, at(T0 - 1)),
        tick(2, A, T0, { quote: '100.125' }),
        ping(3, A, at(T0, 500)),
        // Un símbolo que el perfil no admite no aporta nada.
        tick(4, A, T0 + 1, { symbol: 'SYNTH_050' }),
        close(5, A, at(T0 + 2), 'timeout'),
        open(6, B, A, at(T0 + 3)),
        tick(7, B, T0 + 4, { quote: '100.250' }),
        recovery(
          8,
          { from: at(T0, 1), to: at(T0 + 3, 999) },
          { recovered_event_count: 1, status: 'complete' },
          at(T0 + 6),
          B,
        ),
        { ...close(9, B, at(T0 + 7), 'requested'), affected_symbols: [] },
        open(10, C, B, at(T0 + 8)),
        tick(11, C, T0 + 9, { quote: '100.375' }),
        close(12, C, at(T0 + 10), 'requested'),
      ],
      measurement,
    );
    const items = chartItemsOf(events, measurement, SYMBOL);
    expect(
      items.map((item) => (item.kind === 'tick' ? { ...item, fingerprint: '…' } : item)),
    ).toEqual([
      { fingerprint: '…', kind: 'tick', quote_decimal: '100.125', time_ms: ms(T0) },
      { fingerprint: '…', kind: 'tick', quote_decimal: '100.250', time_ms: ms(T0 + 4) },
      {
        from_ms: ms(T0, 1),
        kind: 'recovery',
        reason: null,
        recovered_ticks: 1,
        status: 'complete',
        to_ms: ms(T0 + 3, 999),
      },
      { fingerprint: '…', kind: 'tick', quote_decimal: '100.375', time_ms: ms(T0 + 9) },
      { kind: 'stop' },
    ]);
    const fingerprints = items.flatMap((item) => (item.kind === 'tick' ? [item.fingerprint] : []));
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints.every((value) => /^[0-9a-f]{64}$/u.test(value))).toBe(true);
  });
});

/**
 * El log en memoria, con un segmento cerrado cada 60 eventos y después de cada cierre pedido, como
 * en la parada de `ingest`, y los puntos de control de `ingest` en los segmentos que no están en
 * `withoutCheckpoints`. `reads` anota cada segmento cerrado cuyo objeto se lee después.
 */
async function memoryLog(
  events: readonly SourceEvent[],
  withoutCheckpoints: (index: number, count: number) => boolean = () => false,
) {
  const objects = new MemoryObjectStore();
  const store = new MemorySourceLogStore();
  const writer = await SourceEventLog.open({
    objects,
    source: measurement.source,
    store,
    zlibVersion: 'test',
  });
  await writeCapture(writer, events);
  const rows = await checkpointRowsOf({
    log: writer,
    profile: measurement,
    symbol: SYMBOL,
    writtenAt: '2026-01-02T00:00:00.000Z',
  });
  for (const row of rows) {
    if (!withoutCheckpoints(row.segment_index, rows.length)) {
      await store.insertLiveCheckpoint(row);
    }
  }
  const segmentOfKey = new Map(
    store.closed.map((segment) => [contentKey(segment.object_bytes_sha256), segment.segment_index]),
  );
  const reads: number[] = [];
  objects.onRead = (key, bytes) => {
    const segment = segmentOfKey.get(key);
    if (segment !== undefined) {
      reads.push(segment);
    }
    return bytes;
  };
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const read = async (from: number, to: number, cache?: ChartSegmentCache) => {
    const log = await SourceEventLog.open({
      objects,
      source: measurement.source,
      store,
      zlibVersion: 'test',
    });
    const lookup = new LiveCheckpointLookup({
      alert: (alert) => alerts.push(alert),
      profile: measurement,
      symbol: SYMBOL,
    });
    return readChartWindow({
      ...(cache === undefined ? {} : { cache }),
      fromUtc: new Date(from).toISOString(),
      log,
      lookup,
      segments: store,
      toUtc: new Date(to).toISOString(),
    });
  };
  return { alerts, objects, read, reads, store };
}

function mapCache(): ChartSegmentCache & { readonly entries: Map<string, readonly ChartItem[]> } {
  const entries = new Map<string, readonly ChartItem[]>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, items) => {
      entries.set(key, items);
    },
  };
}

describe('readChartWindow', () => {
  const events = captureEvents();

  it('da los ticks y los huecos de la ventana con su motivo, y solo lee sus segmentos', async () => {
    const log = await memoryLog(events);
    const from = ms(T0 + 800);
    const to = ms(T0 + 2500);
    const window = await log.read(from, to);
    expect(window.gaps).toEqual([
      // La parada pedida empezó antes de la ventana: sale del punto de control de su principio.
      gap(ms(T0 + 598, 1), ms(T0 + 901, 999), {
        cause: 'capture_stopped',
        history: 'not_requested',
      }),
      gap(ms(T0 + 1200, 1), ms(T0 + 1205, 999), {
        cause: 'connection_lost',
        history: 'recovered',
        recovered_ticks: 2,
      }),
      gap(ms(T0 + 1800, 1), ms(T0 + 1809, 999), {
        cause: 'connection_lost',
        history: 'partial',
        reason: 'history_page_limit',
        recovered_ticks: 3,
      }),
      gap(ms(T0 + 2400, 1), null, { cause: 'connection_lost', history: 'pending' }),
    ]);
    const times = window.ticks.map((item) => item.time_ms);
    expect(times[0]).toBe(ms(T0 + 902));
    expect(times.at(-1)).toBe(ms(T0 + 2400));
    // Los ticks de 902 a 1200, de 1206 a 1800 y de 1810 a 2400, cada 2 s.
    expect(times).toHaveLength(150 + 298 + 296);
    expect(window).toEqual(wholeLogChart(events, from, to));

    // El segmento que termina con la parada, el último antes de la ventana, no se lee.
    const stopSegment = log.store.closed.find(
      (segment) => segment.close_reason === 'requested',
    )?.segment_index;
    expect(stopSegment).toBeDefined();
    expect(log.reads.length).toBeGreaterThan(0);
    expect(Math.min(...log.reads)).toBe((stopSegment ?? 0) + 1);
    expect(log.alerts).toEqual([]);
  });

  // Unos 4 s en el sandbox, y hasta 6 s con los demás paquetes probándose a la vez.
  it(
    'da lo mismo que el log entero en ventanas que empiezan en cualquier parte',
    { timeout: 30_000 },
    async () => {
      const log = await memoryLog(events);
      for (let start = T0 - 60; start <= T0 + 2460; start += 300) {
        for (const length of [60, 600, 2600]) {
          const from = ms(start);
          const to = ms(start + length);
          expect(await log.read(from, to), `${String(start - T0)} + ${String(length)}`).toEqual(
            wholeLogChart(events, from, to),
          );
        }
      }
    },
  );

  it('con la caché, una lectura repetida no vuelve a leer los segmentos cerrados', async () => {
    const log = await memoryLog(events);
    const cache = mapCache();
    const from = ms(T0 + 800);
    const to = ms(T0 + 2500);
    const first = await log.read(from, to, cache);
    const read = log.reads.length;
    expect(read).toBeGreaterThan(0);
    expect(cache.entries.size).toBe(read);
    expect(await log.read(from, to, cache)).toEqual(first);
    expect(log.reads).toHaveLength(read);
  });

  it(
    `pliega hasta ${String(CHART_FOLD_LIMIT)} segmentos sin punto de control, y con más falla sin derivar el log`,
    { timeout: 30_000 },
    async () => {
      const from = ms(T0 + 2300);
      const to = ms(T0 + 2500);
      const tail = await memoryLog(events, (index, count) => index >= count - 5);
      expect(await tail.read(from, to)).toEqual(wholeLogChart(events, from, to));

      // Con la caché llena, el pliegue del final vuelve a leer los segmentos que le tocan: en ellos
      // están el cierre, la conexión nueva y el tick que fija el fin del hueco pendiente.
      const reconnected = reconnectedEvents();
      const later = await memoryLog(reconnected, (index, count) => index >= count - 5);
      const cache = mapCache();
      const window = await later.read(ms(T0 + 2300), ms(T0 + 2700), cache);
      expect(window).toEqual(wholeLogChart(reconnected, ms(T0 + 2300), ms(T0 + 2700)));
      expect(window.gaps).toEqual([
        gap(ms(T0 + 2400, 1), ms(T0 + 2409, 999), { cause: 'connection_lost', history: 'pending' }),
      ]);
      expect(await later.read(ms(T0 + 2300), ms(T0 + 2700), cache)).toEqual(window);

      // Sin el punto de control del segmento de la parada ni el del anterior, el principio se pliega
      // desde uno más viejo: la parada sigue empezando antes de la ventana.
      const stopSegment =
        (await memoryLog(events)).store.closed.find(
          (segment) => segment.close_reason === 'requested',
        )?.segment_index ?? -1;
      const beforeWindow = await memoryLog(
        events,
        (index) => index === stopSegment || index === stopSegment - 1,
      );
      const stopped = await beforeWindow.read(ms(T0 + 800), ms(T0 + 2500));
      expect(stopped).toEqual(wholeLogChart(events, ms(T0 + 800), ms(T0 + 2500)));
      expect(stopped.gaps[0]).toMatchObject({ cause: 'capture_stopped', from_ms: ms(T0 + 598, 1) });

      const none = await memoryLog(events, () => true);
      await expect(none.read(from, to)).rejects.toBeInstanceOf(ChartCheckpointError);
      // Falla antes de leer ningún segmento.
      expect(none.reads).toEqual([]);
    },
  );

  it('lee también el segmento de un tick que llegó antes de su hora, con el reloj de la fuente adelantado', async () => {
    const stimuli: unknown[] = [open(1, A, null, at(T0 - 1))];
    ticksBetween(stimuli, A, T0, T0 + 114);
    // El último evento del primer segmento: su hora de fuente está en la ventana, y su recepción, antes.
    stimuli.push(tick(stimuli.length + 1, A, T0 + 200, { delayMs: -500, quote: '101.500' }));
    ticksBetween(stimuli, A, T0 + 202, T0 + 240);
    const skewed = eventsOf(stimuli, measurement);
    const log = await memoryLog(skewed);
    expect(log.store.closed[0]?.last_event_time_utc).toBe(at(T0 + 199, 500));
    const window = await log.read(ms(T0 + 200), ms(T0 + 260));
    expect(window.ticks[0]).toEqual({ quote_decimal: '101.500', time_ms: ms(T0 + 200) });
    expect(window).toEqual(wholeLogChart(skewed, ms(T0 + 200), ms(T0 + 260)));
  });

  it('un segmento que se cierra mientras lee no entra dos veces: cuenta la foto del abierto', async () => {
    const stimuli: unknown[] = [open(1, A, null, at(T0 - 1))];
    ticksBetween(stimuli, A, T0, T0 + 238);
    const all = eventsOf(stimuli, measurement);
    // 121 eventos: dos segmentos cerrados de 60 y el último en el abierto.
    const log = await memoryLog(all);
    const reader = await SourceEventLog.open({
      objects: log.objects,
      source: measurement.source,
      store: log.store,
      zlibVersion: 'test',
    });
    const lookup = new LiveCheckpointLookup({
      alert: () => undefined,
      profile: measurement,
      symbol: SYMBOL,
    });
    // Después de la foto, `ingest` cierra el abierto.
    const writer = await SourceEventLog.open({
      objects: log.objects,
      source: measurement.source,
      store: log.store,
      zlibVersion: 'test',
    });
    await writer.close('window');
    expect(log.store.closed.length).toBe(reader.openSegmentIndex + 1);
    const from = ms(T0);
    const to = ms(T0 + 300);
    const window = await readChartWindow({
      fromUtc: new Date(from).toISOString(),
      log: reader,
      lookup,
      segments: log.store,
      toUtc: new Date(to).toISOString(),
    });
    expect(window).toEqual(wholeLogChart(all, from, to));
    expect(window.ticks).toHaveLength(120);
  });

  it('el objeto leído tiene que ser el de la fila de la ventana, la clave de la caché', async () => {
    const log = await memoryLog(events);
    const store = log.store;
    const finder = {
      listClosedSegmentsSince: async (source: string, since: string) =>
        (await store.listClosedSegmentsSince(source, since)).map((row) => ({
          ...row,
          logical_content_sha256: 'e'.repeat(64),
        })),
    };
    const reader = await SourceEventLog.open({
      objects: log.objects,
      source: measurement.source,
      store,
      zlibVersion: 'test',
    });
    const cache = mapCache();
    await expect(
      readChartWindow({
        cache,
        fromUtc: new Date(ms(T0 + 2300)).toISOString(),
        log: reader,
        lookup: new LiveCheckpointLookup({
          alert: () => undefined,
          profile: measurement,
          symbol: SYMBOL,
        }),
        segments: finder,
        toUtc: new Date(ms(T0 + 2500)).toISOString(),
      }),
    ).rejects.toMatchObject({ name: 'LogIntegrityError' });
    expect(cache.entries.size).toBe(0);
  });

  it('un log vacío no tiene ticks ni huecos', async () => {
    const log = await memoryLog([]);
    expect(await log.read(ms(T0), ms(T0 + 60))).toEqual({ gaps: [], ticks: [] });
  });

  it('un segmento cuyo contenido no es el de su fila no pasa: LogIntegrityError', async () => {
    const log = await memoryLog(events);
    const [segment] = log.store.closed.slice(-1);
    if (segment === undefined) {
      throw new TypeError('Se esperaba un segmento cerrado.');
    }
    log.store.closed[log.store.closed.length - 1] = {
      ...segment,
      logical_content_sha256: 'f'.repeat(64),
    };
    await expect(log.read(ms(T0 + 2300), ms(T0 + 2500))).rejects.toMatchObject({
      name: 'LogIntegrityError',
    });
  });
});
