import {
  type IngestionCursor,
  type LiveDerivationCheckpoint,
  type SourceEvent,
} from '@buoh/contracts';
import {
  buildLiveDerivationCheckpoint,
  deriveMarketData,
  emptyLiveDerivationState,
  foldLiveDerivation,
  liveDerivationView,
  sourceEventTime,
  type DerivedMarketData,
  type PipelineProfile,
} from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gapState, type GapState } from '../src/deriv/gap-watch.js';
import {
  checkLogContent,
  checkLogSinceCheckpoint,
  isCursorAheadOfLog,
  type StartupCheck,
  type StoredCursors,
} from '../src/deriv/log-check.js';
import { contentKey } from '../src/object-keys.js';
import { type OperationalAlert } from '../src/operational/registry.js';
import {
  checkpointRow,
  LiveCheckpointLookup,
  LiveCheckpointWriter,
} from '../src/source-log/live-checkpoint.js';
import {
  liveWatermark,
  readLiveState,
  readPreviousConnection,
} from '../src/source-log/live-reader.js';
import { type StoredLiveCheckpoint } from '../src/source-log/ports.js';
import { previousConnection } from '../src/source-log/previous-connection.js';
import {
  failureReason,
  LogIntegrityError,
  LogNotDerivableError,
  LogReadError,
  SourceEventLog,
} from '../src/source-log/source-event-log.js';
import {
  CORPUS,
  eventsOf,
  failureLogs,
  foreignFrame,
  id,
  measurement,
  outOfDomainLogs,
  publication,
  randomStimuli,
  SYMBOL,
  VECTOR_SCENARIOS,
  vectorEvents,
  vectorProfile,
} from './support/live-corpus.js';
import { MemoryObjectStore, MemorySourceLogStore } from './support/memory-stores.js';

// Equivalencia de los lectores en vivo del worker (ADR-0017 §4 y §9, PR 4 de §11): en cada límite de
// segmento cerrado del corpus de la equivalencia del dominio, el arranque (`checkLogSinceCheckpoint`),
// la reparación de cierres (`readPreviousConnection`) y la vigilancia de huecos (`readLiveState` con
// `gapState`) dan desde el punto de control de ese límite lo mismo que daban con el log entero, y no
// leen los segmentos anteriores a él. Lo de antes se repite aquí con las funciones que comparte
// `data:health` (`checkLogContent`, `isCursorAheadOfLog`, `previousConnection`) y con
// `deriveMarketData`. Almacenes en memoria, sin red, reloj real ni azar; ningún precio es de mercado.

function forbidAmbientEffects(): void {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida.');
  });
}

beforeEach(() => {
  forbidAmbientEffects();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const WRITTEN_AT = '2026-01-02T00:00:00.000Z';
/** La hora del arranque: mucho después del corpus, que empieza el 2026-01-01. */
const NOW = '2026-01-01T12:00:00.000Z';

/** Lo que hacían los tres lectores con el log entero, o lo que hacen ahora desde un punto de control. */
interface Readers {
  /** El estado del hueco del símbolo y su high-watermark, o `not_derivable` si no se deriva. */
  readonly gap: { readonly state: GapState; readonly watermark: string | null } | 'not_derivable';
  readonly previous: ReturnType<typeof previousConnection>;
  readonly startup: StartupCheck;
}

/** Con `log_not_derivable` se compara el motivo, no su detalle saneado (ADR-0017 §9). */
function comparable(check: StartupCheck): StartupCheck {
  return check.status === 'failed' && check.reason === 'log_not_derivable'
    ? { ...check, detail: 'detalle saneado' }
    : check;
}

/** `gapState` antes de ADR-0017: los extremos, buscados en los ticks derivados del log entero. */
function gapStateOfTicks(derived: DerivedMarketData, symbol: string): GapState {
  const shift = (instant: string, ms: number) => new Date(Date.parse(instant) + ms).toISOString();
  const gap = derived.pendingGaps.find((item) => item.symbol === symbol);
  if (gap === undefined) {
    return { status: 'none' };
  }
  const watermark = shift(gap.from_event_time_utc, -1);
  if (gap.to_event_time_utc === null) {
    return { status: 'open', watermark_utc: watermark };
  }
  const quoteAt = (instant: string) =>
    derived.ticks.find((tick) => tick.symbol === symbol && tick.event_time_utc === instant)
      ?.quote_decimal;
  const startQuote = quoteAt(watermark);
  const endQuote = quoteAt(shift(gap.to_event_time_utc, 1));
  if (startQuote === undefined || endQuote === undefined) {
    return { status: 'boundary_unavailable', watermark_utc: watermark };
  }
  return {
    request: {
      end_quote: endQuote,
      from_event_time_utc: gap.from_event_time_utc,
      start_quote: startQuote,
      symbol,
      to_event_time_utc: gap.to_event_time_utc,
    },
    status: 'ready',
    watermark_utc: watermark,
  };
}

interface StartupInput {
  readonly cursors: StoredCursors | null;
  readonly now: () => string;
  readonly retentionMs: number | undefined;
}

const NO_CURSORS: StartupInput = { cursors: null, now: () => NOW, retentionMs: undefined };

/**
 * Lo que daban los lectores con el log entero: el arranque de antes (`checkLogContent`,
 * `isCursorAheadOfLog` y la retención desde el primer evento leído), `previousConnection` y la
 * vigilancia con `deriveMarketData`.
 */
function wholeLogReaders(
  segments: readonly (readonly SourceEvent[])[],
  profile: PipelineProfile,
  input: StartupInput = NO_CURSORS,
): Readers {
  const events = segments.flat();
  const failed = (reason: Extract<StartupCheck, { status: 'failed' }>['reason']) =>
    ({ detail: null, reason, status: 'failed' }) as const;
  const startup = ((): StartupCheck => {
    const checked = checkLogContent({
      cursorSymbols: input.cursors?.symbols ?? [],
      profile,
      segments,
      symbol: SYMBOL,
    });
    if (checked.status === 'failed') {
      return { detail: checked.detail, reason: checked.reason, status: 'failed' };
    }
    if (isCursorAheadOfLog({ cursor: input.cursors?.latest ?? null, segments })) {
      return failed('cursor_ahead_of_log');
    }
    const first = events[0];
    const oldest = first === undefined ? null : sourceEventTime(first);
    if (
      input.retentionMs !== undefined &&
      oldest !== null &&
      Date.parse(input.now()) >= Date.parse(oldest) + input.retentionMs
    ) {
      return failed('retention_expired');
    }
    return {
      startup: {
        connection_id: events.at(-1)?.connection_id ?? null,
        high_watermark_utc:
          checked.derived.ticks.findLast((tick) => tick.symbol === SYMBOL)?.event_time_utc ?? null,
        oldest_utc: oldest,
      },
      status: 'passed',
    };
  })();
  let gap: Readers['gap'];
  try {
    const derived = deriveMarketData(segments, profile);
    gap = {
      state: gapStateOfTicks(derived, SYMBOL),
      watermark: derived.ticks.findLast((tick) => tick.symbol === SYMBOL)?.event_time_utc ?? null,
    };
  } catch {
    gap = 'not_derivable';
  }
  return { gap, previous: previousConnection(segments), startup: comparable(startup) };
}

/** Dónde cierra el log del corpus sus segmentos: después de qué eventos, por su índice. */
type Layout = (event: SourceEvent, index: number, count: number) => boolean;

/** Cierra un segmento después de cada evento: un límite en cada evento. */
const eachEvent: Layout = () => true;
/** Cierra un segmento después de cada evento de la primera mitad; el resto queda abierto. */
const secondHalfOpen: Layout = (_event, index, count) => index < count / 2;

const LAYOUTS: readonly (readonly [string, Layout])[] = [
  ['un segmento por evento', eachEvent],
  ['la segunda mitad en el segmento abierto', secondHalfOpen],
];

/** Cierra un segmento después de cada evento de conexión o de historia, como el vector del dominio. */
const atTransitions: Layout = (event) => event.kind !== 'raw_source_frame';

/**
 * Un log en memoria con los eventos y sus segmentos cerrados según `layout`, y la fila de cada
 * punto de control que escribiría `ingest`: el pliegue del log desde el vacío hasta cada segmento
 * cerrado, mientras se pliegue. `reads` anota el índice de cada segmento cerrado cuyo objeto se lee.
 */
async function memoryLog(events: readonly SourceEvent[], profile: PipelineProfile, layout: Layout) {
  const objects = new MemoryObjectStore();
  const store = new MemorySourceLogStore();
  const source = events[0]?.source ?? profile.source;
  const log = await SourceEventLog.open({ objects, source, store, zlibVersion: 'test' });
  for (const [index, event] of events.entries()) {
    await log.append(event);
    if (layout(event, index, events.length)) {
      await log.close('requested');
    }
  }
  const last = log.openSegmentIndex - 1;
  const closed = last < 0 ? [] : await log.readClosedSegments(0, last);
  const rows: StoredLiveCheckpoint[] = [];
  let state = emptyLiveDerivationState();
  let eventCount = 0;
  let rawFrameCount = 0;
  for (const [k, segment] of closed.entries()) {
    try {
      state = foldLiveDerivation(state, segment, profile);
    } catch {
      break;
    }
    eventCount += segment.length;
    rawFrameCount += segment.filter((event) => event.kind === 'raw_source_frame').length;
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: eventCount,
      profile,
      raw_frame_count: rawFrameCount,
      segment_index: k,
      segment_logical_content_sha256: store.closed[k]?.logical_content_sha256 ?? '',
      state,
      symbol: SYMBOL,
    });
    rows.push(checkpointRow(checkpoint, WRITTEN_AT));
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
  return { log, objects, profile, reads, rows, store };
}

type MemoryLog = Awaited<ReturnType<typeof memoryLog>>;

/** La fila del punto de control del segmento `k`. */
function rowAt(run: MemoryLog, k: number): StoredLiveCheckpoint {
  const row = run.rows[k];
  if (row === undefined) {
    throw new TypeError(`Falta el punto de control del segmento ${String(k)}.`);
  }
  return row;
}

/** Deja guardados los puntos de control de los segmentos 0 a `c`; ninguno con −1. */
function keepCheckpointsUpTo(run: MemoryLog, c: number): void {
  run.store.checkpoints.splice(
    0,
    run.store.checkpoints.length,
    ...run.rows.filter((row) => row.segment_index <= c),
  );
}

/** Una búsqueda del último punto de control válido del log, que anota sus alertas. */
function lookupOf(run: MemoryLog, alerts: Parameters<OperationalAlert>[0][] = []) {
  return new LiveCheckpointLookup({
    alert: (payload) => alerts.push(payload),
    profile: run.profile,
    symbol: SYMBOL,
  });
}

/** Lo que dan los tres lectores desde el último punto de control válido que esté guardado. */
async function liveReaders(
  run: MemoryLog,
  lookup: LiveCheckpointLookup,
  input: StartupInput = NO_CURSORS,
): Promise<Readers> {
  const startup = comparable(await checkLogSinceCheckpoint(run.log, lookup, input));
  const previous = await readPreviousConnection(run.log, lookup);
  let gap: Readers['gap'];
  try {
    const view = liveDerivationView(await readLiveState(run.log, lookup));
    gap = { state: gapState(view, SYMBOL), watermark: liveWatermark(view, SYMBOL) };
  } catch (error) {
    if (!(error instanceof LogNotDerivableError)) {
      throw error;
    }
    gap = 'not_derivable';
  }
  return { gap, previous, startup };
}

/**
 * En cada punto de control guardado, y sin ninguno, los lectores dan lo que daban con el log entero,
 * sin avisar de nada, y solo leen los objetos de los segmentos cerrados posteriores a él.
 */
async function expectSameFromEveryCheckpoint(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
  layout: Layout,
  label: string,
): Promise<void> {
  const run = await memoryLog(events, profile, layout);
  const expected = wholeLogReaders(await run.log.readDurableSegments(), profile);
  const open = run.log.openSegmentIndex;
  for (let c = -1; c < run.rows.length; c += 1) {
    keepCheckpointsUpTo(run, c);
    const alerts: Parameters<OperationalAlert>[0][] = [];
    run.reads.length = 0;
    expect(
      await liveReaders(run, lookupOf(run, alerts)),
      `${label}, punto de control ${String(c)}`,
    ).toEqual(expected);
    expect(alerts, label).toEqual([]);
    const after = Array.from({ length: open - c - 1 }, (_item, index) => c + 1 + index);
    expect(
      [...new Set(run.reads)].sort((left, right) => left - right),
      label,
    ).toEqual(after);
  }
}

describe('lectores en vivo desde el punto de control: equivalencia en el worker (ADR-0017 §9)', () => {
  it.each(
    CORPUS.flatMap(([name, stimuli, profile]) =>
      LAYOUTS.map(([layout, closes]) => [`${name}, ${layout}`, stimuli, profile, closes] as const),
    ),
  )(
    '%s: lo mismo que con el log entero desde cada punto de control',
    async (name, stimuli, profile, closes) => {
      await expectSameFromEveryCheckpoint(eventsOf(stimuli, profile), profile, closes, name);
    },
  );

  it.each(VECTOR_SCENARIOS)(
    'el vector %s: lo mismo que con el log entero desde cada punto de control',
    async (name, files) => {
      for (const [layout, closes] of LAYOUTS) {
        await expectSameFromEveryCheckpoint(
          vectorEvents(files),
          vectorProfile(),
          closes,
          `${name}, ${layout}`,
        );
      }
    },
  );

  it(
    '300 logs aleatorios del dominio de §3, con los dos perfiles y un segmento por transición: lo mismo desde cada punto de control',
    // Sola tarda unos 11 s y con las demás suites del worker, unos 16 s (2026-10-30). En el runner
    // de CI, con las suites de todos los paquetes en paralelo, una prueba así llegó a tardar el
    // doble o más (ver «Verificación periódica» del runbook de ingesta).
    { timeout: 120_000 },
    async () => {
      // Las mismas semillas que la equivalencia del dominio.
      const profiles = [
        ['medición', measurement, 0],
        ['publicación', publication, 1000],
      ] as const;
      for (const [name, profile, first] of profiles) {
        for (let seed = first + 1; seed <= first + 150; seed += 1) {
          await expectSameFromEveryCheckpoint(
            eventsOf(randomStimuli(seed, profile), profile),
            profile,
            atTransitions,
            `semilla ${String(seed)} (${name})`,
          );
        }
      }
    },
  );

  it.each(failureLogs())(
    'un log que no se deriva, %s: falla igual, con el mismo motivo, desde cada punto de control',
    async (name, events) => {
      for (const [layout, closes] of LAYOUTS) {
        await expectSameFromEveryCheckpoint(events, measurement, closes, `${name}, ${layout}`);
      }
    },
  );

  it.each(outOfDomainLogs())(
    'fuera del dominio de §3, %s: el arranque y la vigilancia fallan cerrados con log_not_derivable, y la reparación da la conexión de siempre',
    async (name, events) => {
      for (const [layout, closes] of LAYOUTS) {
        const run = await memoryLog(events, measurement, closes);
        const segments = await run.log.readDurableSegments();
        const before = wholeLogReaders(segments, measurement);
        // `deriveMarketData` lo acepta.
        expect(before.startup.status, name).toBe('passed');
        for (let c = -1; c < run.rows.length; c += 1) {
          keepCheckpointsUpTo(run, c);
          expect(await liveReaders(run, lookupOf(run)), `${name}, ${layout}, ${String(c)}`).toEqual(
            {
              gap: 'not_derivable',
              previous: before.previous,
              startup: comparable({ detail: null, reason: 'log_not_derivable', status: 'failed' }),
            },
          );
        }
      }
    },
  );
});

/** Una fila guardada con el punto de control de `row` cambiado por `change`, con su JCS y SHA-256. */
function rewritten(
  row: StoredLiveCheckpoint,
  change: (checkpoint: LiveDerivationCheckpoint) => LiveDerivationCheckpoint,
): StoredLiveCheckpoint {
  const checkpoint = JSON.parse(row.checkpoint_jcs) as LiveDerivationCheckpoint;
  return checkpointRow(change(checkpoint), row.written_at_utc);
}

describe('lectores en vivo: puntos de control rechazados y almacenes que fallan (ADR-0017 §4, §6 y §9)', () => {
  /** Un log del corpus con un segmento cerrado por evento: ocho segmentos y sus ocho filas. */
  async function corpusLog() {
    const [, stimuli, profile] =
      CORPUS.find(([name]) => name === 'historia parcial y después completa del mismo rango') ?? [];
    if (stimuli === undefined || profile === undefined) {
      throw new TypeError('Falta el log del corpus.');
    }
    const run = await memoryLog(eventsOf(stimuli, profile), profile, eachEvent);
    const expected = wholeLogReaders(await run.log.readDurableSegments(), profile);
    return { expected, run };
  }

  it.each<[string, (row: StoredLiveCheckpoint) => StoredLiveCheckpoint, string | null]>([
    [
      'de otras versiones',
      (row) =>
        rewritten(row, (checkpoint) => ({
          ...checkpoint,
          versions: { ...checkpoint.versions, live_state_version: '9.9.9' },
        })),
      null,
    ],
    [
      'con otro SHA-256',
      (row) => ({ ...row, checkpoint_sha256: 'f'.repeat(64) }),
      'checkpoint_digest_mismatch',
    ],
    [
      'con otro enlace',
      (row) =>
        rewritten(row, (checkpoint) => ({
          ...checkpoint,
          segment_logical_content_sha256: 'e'.repeat(64),
        })),
      'checkpoint_binding_mismatch',
    ],
    [
      'de otro símbolo',
      (row) => rewritten(row, (checkpoint) => ({ ...checkpoint, symbol: 'SYNTH_050' })),
      'checkpoint_identity_mismatch',
    ],
  ])(
    'el último punto de control, %s, no se usa: los lectores parten del anterior y dan lo mismo, y solo uno que no es de otra versión avisa, una vez',
    async (_label, change, reason) => {
      const { expected, run } = await corpusLog();
      const top = run.rows.length - 1;
      keepCheckpointsUpTo(run, top - 1);
      const bad = change(rowAt(run, top));
      run.store.checkpoints.push(bad);
      const alerts: Parameters<OperationalAlert>[0][] = [];
      const lookup = lookupOf(run, alerts);
      run.reads.length = 0;

      // Los tres lectores, con la misma búsqueda, como en una sesión.
      expect(await liveReaders(run, lookup)).toEqual(expected);
      expect(alerts).toEqual(
        reason === null
          ? []
          : [{ event: 'checkpoint_rejected', reason, segment_index: String(top) }],
      );
      expect(lookup.hasRejected(top)).toBe(reason !== null);
      // Parten del penúltimo: solo leen el último segmento cerrado, y la fila rechazada sigue igual.
      expect([...new Set(run.reads)]).toEqual([top]);
      expect(run.store.checkpoints.at(-1)).toEqual(bad);
    },
  );

  it('uno del segmento abierto o posterior no se usa ni avisa: el lector busca por debajo del abierto', async () => {
    const { expected, run } = await corpusLog();
    const top = run.rows.length - 1;
    keepCheckpointsUpTo(run, top);
    const open = run.log.openSegmentIndex;
    for (const segment of [open, open + 1]) {
      run.store.checkpoints.push(
        rewritten(rowAt(run, top), (checkpoint) => ({
          ...checkpoint,
          segment_index: segment,
        })),
      );
    }
    const alerts: Parameters<OperationalAlert>[0][] = [];

    expect(await liveReaders(run, lookupOf(run, alerts))).toEqual(expected);
    expect(alerts).toEqual([]);
  });

  it('si PostgreSQL no responde al leer los puntos de control o al buscar el cursor, lanza LogReadError', async () => {
    const { run } = await corpusLog();
    keepCheckpointsUpTo(run, 3);
    run.store.failCheckpointReads = true;
    const lookup = lookupOf(run);
    for (const read of [
      checkLogSinceCheckpoint(run.log, lookup, NO_CURSORS),
      readPreviousConnection(run.log, lookup),
      readLiveState(run.log, lookup),
    ]) {
      await expect(read).rejects.toThrow(LogReadError);
      await expect(read).rejects.toMatchObject({ reason: 'ECONNREFUSED' });
    }

    run.store.failCheckpointReads = false;
    run.store.failEventLookups = true;
    const cursors = { latest: cursorAt(id(1)), symbols: [SYMBOL] };
    await expect(
      checkLogSinceCheckpoint(run.log, lookup, { ...NO_CURSORS, cursors }),
    ).rejects.toMatchObject({ name: 'LogReadError', reason: 'ECONNREFUSED' });
  });

  it('un segmento que se cierra mientras leen, con su punto de control ya escrito, no se aplica dos veces: los tres dan el estado de su foto', async () => {
    const [, stimuli, profile] =
      CORPUS.find(
        ([name]) => name === 'cierre pedido con el hueco pendiente y su fin ya conocido',
      ) ?? [];
    if (stimuli === undefined || profile === undefined) {
      throw new TypeError('Falta el log del corpus.');
    }
    const events = eventsOf(stimuli, profile);
    const objects = new MemoryObjectStore();
    const store = new MemorySourceLogStore();
    const log = await SourceEventLog.open({
      objects,
      source: 'synthetic',
      store,
      zlibVersion: 'test',
    });
    const alerts: Parameters<OperationalAlert>[0][] = [];
    const failures: unknown[] = [];
    const lookup = new LiveCheckpointLookup({
      alert: (payload) => alerts.push(payload),
      profile,
      symbol: SYMBOL,
    });
    // El escritor de `ingest`, con la misma búsqueda que los lectores.
    const writer = new LiveCheckpointWriter({
      alert: (payload) => alerts.push(payload),
      log: () => log,
      lookup,
      now: () => WRITTEN_AT,
      onFailure: (failure) => failures.push(failure),
      profile,
      symbol: SYMBOL,
    });
    const append = async (from: number, to: number) => {
      for (const event of events.slice(from, to)) {
        await log.append(event);
      }
    };
    const closeAndWrite = async () => {
      const closed = await log.close('requested');
      if (closed === null) {
        throw new TypeError('No había nada que cerrar.');
      }
      writer.onClosed(closed);
      await writer.settle();
    };
    await append(0, 2);
    await closeAndWrite();
    await append(2, 4);
    await closeAndWrite();
    await append(4, 6);
    // La foto: los segmentos 0 y 1, con sus puntos de control, y el 2 abierto con dos eventos.
    const snapshot = events.slice(0, 6);
    const gate = Promise.withResolvers<undefined>();
    const read = store.readLiveCheckpoint.bind(store);
    const held = vi.spyOn(store, 'readLiveCheckpoint').mockImplementation(async (...args) => {
      await gate.promise;
      return read(...args);
    });
    const state = readLiveState(log, lookup);
    const previous = readPreviousConnection(log, lookup);
    const startup = checkLogSinceCheckpoint(log, lookup, NO_CURSORS);
    held.mockImplementation(read);
    // Mientras esperan los puntos de control: el segmento 2 se cierra, el escritor escribe el suyo
    // y el 3 recibe los dos eventos siguientes.
    await closeAndWrite();
    await append(6, 8);
    expect(store.checkpoints.map((row) => row.segment_index)).toEqual([0, 1, 2]);
    gate.resolve(undefined);

    expect(await state).toEqual(foldLiveDerivation(emptyLiveDerivationState(), snapshot, profile));
    expect(await previous).toEqual(previousConnection([snapshot]));
    expect(await startup).toEqual(wholeLogReaders([snapshot], profile).startup);
    expect(alerts).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('un pliegue que falla lanza LogNotDerivableError, un LogIntegrityError, con el motivo saneado de su error, como cuando fallaba deriveMarketData', async () => {
    const [, events] = failureLogs()[0] ?? [];
    if (events === undefined) {
      throw new TypeError('Falta el log.');
    }
    const run = await memoryLog(events, measurement, eachEvent);
    let before: unknown = null;
    try {
      deriveMarketData([events], measurement);
    } catch (error) {
      before = error;
    }
    const error: unknown = await readLiveState(run.log, lookupOf(run)).catch(
      (rejected: unknown) => rejected,
    );

    expect(error).toBeInstanceOf(LogNotDerivableError);
    expect(error).toBeInstanceOf(LogIntegrityError);
    expect(failureReason(before)).toBe('TypeError');
    expect(failureReason(error)).toBe(failureReason(before));
  });

  it('solo leen los objetos posteriores al punto de control: uno anterior que falta no se nota, y uno posterior es LogIntegrityError', async () => {
    const { expected, run } = await corpusLog();
    keepCheckpointsUpTo(run, 3);
    const keyOf = (segment: number) =>
      contentKey(run.store.closed[segment]?.object_bytes_sha256 ?? '');
    run.objects.objects.delete(keyOf(2));
    const lookup = lookupOf(run);

    expect(await liveReaders(run, lookup)).toEqual(expected);

    run.objects.objects.delete(keyOf(5));
    for (const read of [
      checkLogSinceCheckpoint(run.log, lookup, NO_CURSORS),
      readPreviousConnection(run.log, lookup),
      readLiveState(run.log, lookup),
    ]) {
      await expect(read).rejects.toThrow(LogIntegrityError);
    }
  });
});

describe('liveWatermark', () => {
  it('da el high-watermark del símbolo pedido, no el de otro, o null si no tiene ticks', () => {
    const view = liveDerivationView(emptyLiveDerivationState());
    const watermarks = [
      { event_time_utc: '2026-01-01T00:00:05.000Z', symbol: 'SYNTH_050' },
      { event_time_utc: '2026-01-01T00:00:03.000Z', symbol: SYMBOL },
    ];

    expect(liveWatermark({ ...view, watermarks }, SYMBOL)).toBe('2026-01-01T00:00:03.000Z');
    expect(liveWatermark({ ...view, watermarks: watermarks.slice(0, 1) }, SYMBOL)).toBeNull();
    expect(liveWatermark(view, SYMBOL)).toBeNull();
  });
});

/** Un cursor del símbolo que apunta al evento `eventId`. */
const cursorAt = (eventId: string): IngestionCursor => ({
  active_segment_index: 0,
  connection_id: id(9000),
  high_watermark_event_time_utc: null,
  last_durable_observation_id: null,
  last_durable_source_event_id: eventId,
  schema_version: '1.0.0',
  source: 'synthetic',
  source_event_count: 1,
  symbol: SYMBOL,
  updated_at_utc: NOW,
});

/** El ID de cada evento en el índice: el `observation_id` de un frame y el `event_id` de los demás. */
const eventIdOf = (event: SourceEvent): string =>
  event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;

describe('el arranque desde el punto de control: cursor, símbolo, retención y conector (ADR-0017 §4)', () => {
  it.each(CORPUS)(
    '%s: el cursor se busca en el índice, y el símbolo y la retención dan lo mismo que con el log entero',
    async (name, stimuli, profile) => {
      const events = eventsOf(stimuli, profile);
      const run = await memoryLog(events, profile, secondHalfOpen);
      const segments = await run.log.readDurableSegments();
      const first = events[0];
      if (first === undefined) {
        throw new TypeError('Log vacío.');
      }
      const oldest = Date.parse(sourceEventTime(first));
      const RETENTION = 60_000;
      const inputs: StartupInput[] = [
        // Un cursor en cada evento del log, en un segmento cerrado o en el abierto.
        ...events.map((event) => ({
          cursors: { latest: cursorAt(eventIdOf(event)), symbols: [SYMBOL] },
          now: () => NOW,
          retentionMs: undefined,
        })),
        // Uno que apunta a un evento que el log no tiene, también con la retención cumplida, que
        // va después, y uno de otro símbolo.
        {
          cursors: { latest: cursorAt(id(9999)), symbols: [SYMBOL] },
          now: () => NOW,
          retentionMs: undefined,
        },
        {
          cursors: { latest: cursorAt(id(9999)), symbols: [SYMBOL] },
          now: () => new Date(oldest + RETENTION).toISOString(),
          retentionMs: RETENTION,
        },
        {
          cursors: { latest: null, symbols: ['SYNTH_050', SYMBOL] },
          now: () => NOW,
          retentionMs: undefined,
        },
        // La retención, 1 ms antes de cumplirse y al cumplirse.
        {
          cursors: null,
          now: () => new Date(oldest + RETENTION - 1).toISOString(),
          retentionMs: RETENTION,
        },
        {
          cursors: null,
          now: () => new Date(oldest + RETENTION).toISOString(),
          retentionMs: RETENTION,
        },
      ];
      const reasons = new Set<string>();
      for (const input of inputs) {
        const expected = wholeLogReaders(segments, profile, input).startup;
        reasons.add(expected.status === 'failed' ? expected.reason : 'passed');
        for (let c = -1; c < run.rows.length; c += 1) {
          keepCheckpointsUpTo(run, c);
          run.store.eventLookups.length = 0;
          expect(
            comparable(await checkLogSinceCheckpoint(run.log, lookupOf(run), input)),
            `${name}, ${String(c)}`,
          ).toEqual(expected);
          // Solo el cursor del símbolo, y solo si el contenido pasó sus comprobaciones.
          const latest = input.cursors?.latest ?? null;
          expect(run.store.eventLookups).toEqual(
            latest === null ||
              (expected.status === 'failed' && expected.reason === 'symbol_mismatch')
              ? []
              : [latest.last_durable_source_event_id],
          );
        }
      }
      // Salvo en el log con un frame de otro símbolo, que siempre es `symbol_mismatch`, las entradas
      // recorren todos los motivos del arranque que no dependen del contenido.
      if (wholeLogReaders(segments, profile).startup.status === 'passed') {
        expect([...reasons].sort(), name).toEqual([
          'cursor_ahead_of_log',
          'passed',
          'retention_expired',
          'symbol_mismatch',
        ]);
      }
    },
  );

  /** El arranque da `connector_version_mismatch` desde cada punto de control, como con el log entero. */
  async function expectForeignFromEveryCheckpoint(
    events: readonly SourceEvent[],
    profile: PipelineProfile,
    layout: Layout,
    label: string,
  ): Promise<void> {
    const run = await memoryLog(events, profile, layout);
    const mismatch = { detail: null, reason: 'connector_version_mismatch', status: 'failed' };
    expect(wholeLogReaders(await run.log.readDurableSegments(), profile).startup, label).toEqual(
      mismatch,
    );
    for (let c = -1; c < run.rows.length; c += 1) {
      keepCheckpointsUpTo(run, c);
      expect(
        await checkLogSinceCheckpoint(run.log, lookupOf(run), NO_CURSORS),
        `${label}, ${String(c)}`,
      ).toEqual(mismatch);
    }
  }

  it.each(CORPUS)(
    '%s: un frame de otro conector posterior al punto de control da connector_version_mismatch, en el segmento abierto o en uno cerrado',
    async (name, stimuli, profile) => {
      const events = eventsOf(stimuli, profile);
      await expectForeignFromEveryCheckpoint(
        [...events, foreignFrame(9001)],
        profile,
        secondHalfOpen,
        `${name}, en el abierto`,
      );
      await expectForeignFromEveryCheckpoint(
        [...events.slice(0, -1), foreignFrame(9001), ...events.slice(-1)],
        profile,
        eachEvent,
        `${name}, en uno cerrado`,
      );
    },
  );

  it.each(failureLogs().slice(0, 2))(
    'un frame de otro conector después de un segmento que no se pliega, %s, también da connector_version_mismatch',
    async (name, events) => {
      await expectForeignFromEveryCheckpoint(
        [...events, foreignFrame(9002)],
        measurement,
        eachEvent,
        name,
      );
    },
  );
});
