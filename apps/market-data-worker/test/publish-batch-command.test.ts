import { describe, expect, it } from 'vitest';

import { derivBatchLogProfileRow, type BatchProfileKind } from '../src/deriv/batch-profile.js';
import type { LogQualityProfileRow } from '../src/deriv/log-profile.js';
import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { DERIV_BATCH_OPERATIONS, schemaEntryName } from '../src/deriv/schema-release.js';
import { BATCH_SOURCE_SCHEMA_ENTRIES } from '../src/deriv/stored-source-schema.js';
import { derivHistoryProfile } from '../src/deriv/batch-profile.js';
import { historyPlan } from '../src/deriv/history-pages.js';
import {
  BATCH_CANDLES_SEQUENCE,
  BATCH_QUOTES_SEQUENCE,
  contentKey,
  HISTORY_GOLD_SEQUENCE,
  DATASETS_PREFIX,
  InMemoryObjectStore,
  InMemorySourceLogStore,
  logLocation,
  logReader,
  publishDatasetCommand,
  replayDataset,
  type CaptureLog,
  type LogSequence,
  type PublicationStores,
  type PublishCommandDependencies,
} from '../src/index.js';
import {
  historyPageText,
  historyRateLimitText,
  pageText,
  quoteText,
  sessionText,
  writeBatchLog,
  type BatchRun,
} from './support/batch-frames.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';
import {
  MemoryDatasetStore,
  MemoryObjectStore,
  MemoryOperationalStore,
} from './support/memory-stores.js';

// `datasets:publish --sequence` (precisión del PR 5d2 de ADR-0021 §9), sin red, reloj real ni azar:
// logs de los lotes escritos como los escribe el comando de los lotes, con el esquema de fuente que
// guarda en cada log y la fila del perfil de su secuencia, y `buoh_datasets` en memoria. Las
// expectativas salen de la precisión: un dataset de cotizaciones cada 3 horas, cada día de velas
// con su horario en un solo dataset, y un log sin su esquema o con otro perfil no se deriva.

const OPEN = { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' };
/** Los esquemas de respuesta de los lotes, abiertos: las respuestas sintéticas los cumplen. */
const fixture = syntheticSchemaArchive(
  Object.fromEntries(BATCH_SOURCE_SCHEMA_ENTRIES.map((entry) => [entry, OPEN])),
  DERIV_BATCH_OPERATIONS,
);
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_PASSWORD: 'sintetica-0123456789',
  BUOH_POSTGRES_SSLMODE: 'verify-full',
  BUOH_POSTGRES_USER: 'buoh_publicacion',
  BUOH_S3_ACCESS_KEY_ID: 'sintetica',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'sintetica',
};

interface BatchLog {
  readonly lastWriteUtc: string | null;
  readonly number: number;
  readonly objects: MemoryObjectStore;
  readonly profile: LogQualityProfileRow | null;
  readonly sequence: LogSequence;
  readonly store: InMemorySourceLogStore;
}

async function batchLog(
  sequence: LogSequence,
  number: number,
  kind: BatchProfileKind,
  runs: readonly BatchRun[],
  options: { readonly profile?: LogQualityProfileRow | null; readonly schema?: boolean } = {},
): Promise<BatchLog> {
  const objects = new MemoryObjectStore('buoh-captura');
  const store = new InMemorySourceLogStore();
  if (options.schema !== false) {
    // Lo que guarda el comando de los lotes antes del primer evento del log.
    for (const entry of BATCH_SOURCE_SCHEMA_ENTRIES) {
      await objects.putIfAbsent(
        contentKey(fixture.expected.entries_sha256[entry]),
        fixture.entries[entry],
      );
    }
  }
  const last = (await writeBatchLog({ objects, runs, store })).at(-1);
  return {
    lastWriteUtc: last !== undefined && 'occurred_at_utc' in last ? last.occurred_at_utc : null,
    number,
    objects,
    profile: options.profile === undefined ? derivBatchLogProfileRow(kind) : options.profile,
    sequence,
    store,
  };
}

function harness(logs: readonly BatchLog[], nowUtc: string) {
  const datasets = new MemoryDatasetStore();
  const datasetObjects = new MemoryObjectStore('buoh-captura');
  let ids = 0;
  const dependencies: PublishCommandDependencies = {
    alert: () => undefined,
    elapsedMs: () => 1234,
    maxRssBytes: () => 100 * 1048576,
    nextId: () => {
      ids += 1;
      return `019a9000-0000-7000-8000-${ids.toString().padStart(12, '0')}`;
    },
    now: () => nowUtc,
    open: (): PublicationStores => ({
      close: () => Promise.resolve(),
      datasetObjects,
      datasets,
      listLogs: (sequence) =>
        Promise.resolve(
          logs
            .filter((log) => log.sequence === sequence)
            .map((log): CaptureLog => ({
              lastWriteUtc: log.lastWriteUtc,
              location: logLocation(log.number, sequence),
              readable: true,
            })),
        ),
      log: (location) => {
        const found = logs.find(
          (log) => logLocation(log.number, log.sequence).schema === location.schema,
        );
        if (found === undefined) throw new TypeError('sin log');
        return logReader({
          objects: found.objects,
          profile: () => Promise.resolve(found.profile),
          schemas: fixture.expected,
          source: DERIV_SOURCE,
          store: found.store,
        });
      },
      operational: new MemoryOperationalStore(),
    }),
    schemas: fixture.expected,
    zlibVersion: 'test-zlib',
  };
  const run = async (argv: readonly string[]) => {
    const result = await publishDatasetCommand(argv, ENV, dependencies);
    return { ...result, report: JSON.parse(result.line) as Record<string, unknown> };
  };
  const replay = (datasetId: string, mode: 'recompute' | 'verify-only') =>
    replayDataset({
      datasetId,
      environment: 'production',
      keyPrefix: DATASETS_PREFIX,
      metadata: datasets,
      mode,
      objects: new InMemoryObjectStore('buoh-captura', datasetObjects.objects),
    });
  return { datasets, replay, run };
}

/** El core guardado de un dataset en `buoh_datasets`. */
const coreOf = (datasets: MemoryDatasetStore, id: string) =>
  JSON.parse(datasets.datasets.get(id) ?? 'null') as Record<string, unknown> | null;

/** 2026-11-26T00:00:00Z en segundos. */
const DAY0 = Date.parse('2026-11-26T00:00:00.000Z') / 1000;
const quotes = (atUtc: string, count = 3): BatchRun => ({
  atUtc,
  texts: Array.from({ length: count }, (_, index) =>
    quoteText(50 * (index + 1), Date.parse(atUtc) / 1000),
  ),
});

describe('datasets:publish --sequence (precisión del PR 5d2 de ADR-0021 §9)', () => {
  it('publica las cotizaciones de 3 horas del log, con su rango por secuencia, y data:replay las reproduce en los dos modos', async () => {
    const one = await batchLog(BATCH_QUOTES_SEQUENCE, 1, 'quotes', [
      quotes('2026-11-26T00:00:30.000Z'),
      quotes('2026-11-26T01:00:30.000Z'),
      quotes('2026-11-26T02:55:30.000Z'),
      quotes('2026-11-26T03:00:30.000Z', 1),
    ]);
    expect(one.store.closed).toHaveLength(4);
    const { datasets, replay, run } = harness([one], '2026-11-26T03:05:00.000Z');
    const { exitCode, report } = await run(['--sequence', 'lotes_cotizaciones']);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      behind: null,
      clean: true,
      elements: 9,
      first_segment: 0,
      incident_count: 0,
      last_segment: 2,
      log: 1,
      normalized_tick_count: 0,
      open_condition_types: [],
      pending_continuity_symbols: [],
      sequence: 'lotes_cotizaciones',
      status: 'published',
    });
    const id = String(report['dataset_id']);
    expect(datasets.ranges.get(id)?.range).toEqual({
      clean: true,
      first_segment: 0,
      last_segment: 2,
      log_number: 1,
      open: { open_condition_types: [], pending_continuity_symbols: [] },
      sequence: 'lotes_cotizaciones',
    });
    expect(coreOf(datasets, id)).toMatchObject({
      connector_version: 'deriv-options-lotes-1.0.0',
      contract_quote_count: 9,
      quality_profile_id: derivBatchLogProfileRow('quotes').profile_id,
      schema_version: '1.1.0',
      segment_policy_version: '2.0.0',
      source_schema_release: fixture.expected.release,
    });
    for (const mode of ['verify-only', 'recompute'] as const) {
      expect(await replay(id, mode)).toMatchObject({ contract_quote_count: 9, dataset_id: id });
    }
    // El segmento de las 03:00 espera a la marca de las 06:00.
    expect((await run(['--sequence', 'lotes_cotizaciones'])).report).toMatchObject({
      sequence: 'lotes_cotizaciones',
      status: 'nothing_due',
    });
  });

  it('cada día de velas va con su horario en un solo dataset, que comprueba con él las velas que faltan', async () => {
    // La vuelta del 2026-11-26 pide el horario del 25 y sus páginas en dos ejecuciones; la del 27
    // empieza su día.
    const day = DAY0 - 86_400;
    const one = await batchLog(BATCH_CANDLES_SEQUENCE, 1, 'candles', [
      {
        atUtc: '2026-11-26T00:01:00.000Z',
        // Falta la vela de las 00:02 del 25 del oro, dentro del horario. La plata no se pidió.
        texts: [
          sessionText('2026-11-25', ['frxXAGUSD', 'frxXAUUSD']),
          pageText(day, day + 179, [day, day + 60]),
        ],
      },
      { atUtc: '2026-11-26T00:06:00.000Z', texts: [pageText(day + 180, day + 239, [day + 180])] },
      {
        atUtc: '2026-11-27T00:01:00.000Z',
        texts: [sessionText('2026-11-26'), pageText(DAY0, DAY0 + 59, [DAY0])],
      },
    ]);
    const { datasets, replay, run } = harness([one], '2026-11-27T00:10:00.000Z');
    const { report } = await run(['--sequence', 'lotes_velas']);
    // Dos horarios y tres velas, con los símbolos del perfil de las velas.
    expect(report).toMatchObject({
      elements: 5,
      first_segment: 0,
      incident_count: 1,
      last_segment: 1,
      sequence: 'lotes_velas',
      status: 'published',
    });
    const id = String(report['dataset_id']);
    expect(coreOf(datasets, id)).toMatchObject({
      candle_time_from_utc: '2026-11-25T00:00:00.000Z',
      candle_time_to_utc: '2026-11-25T00:03:00.000Z',
      market_candle_count: 3,
      trading_session_count: 2,
    });
    expect(datasets.incidents.get(id)?.map((incident) => incident.incident_type)).toEqual([
      'candle_missing',
    ]);
    expect(await replay(id, 'recompute')).toMatchObject({
      incident_count: 1,
      market_candle_count: 3,
    });
  });

  it('sin el esquema de fuente del log, sin la fila de su perfil o con otra, no se deriva', async () => {
    const runs = [quotes('2026-11-26T00:00:30.000Z'), quotes('2026-11-26T03:00:30.000Z')];
    for (const [options, detail] of [
      [{ schema: false }, 'source_schema_missing'],
      [{ profile: null }, 'profile_missing'],
      [{ profile: derivBatchLogProfileRow('candles') }, 'profile_mismatch'],
      [
        {
          profile: { ...derivBatchLogProfileRow('quotes'), quality_profile_sha256: 'f'.repeat(64) },
        },
        'profile_mismatch',
      ],
    ] as const) {
      const one = await batchLog(BATCH_QUOTES_SEQUENCE, 1, 'quotes', runs, options);
      const { exitCode, report } = (await harness([one], '2026-11-26T03:05:00.000Z').run([
        '--sequence',
        'lotes_cotizaciones',
      ])) as { exitCode: number; report: Record<string, unknown> };
      expect(exitCode, detail).toBe(1);
      expect(report).toMatchObject({
        detail,
        first_segment: 0,
        log: 1,
        reason: 'publication_not_derivable',
        sequence: 'lotes_cotizaciones',
        stage: 'plan',
        status: 'failed',
      });
    }
  });

  it('una entrada del esquema con otros bytes es source_schema_mismatch', async () => {
    const one = await batchLog(BATCH_QUOTES_SEQUENCE, 1, 'quotes', [
      quotes('2026-11-26T00:00:30.000Z'),
      quotes('2026-11-26T03:00:30.000Z'),
    ]);
    const entry = schemaEntryName('proposal', 'response');
    one.objects.onRead = (key, bytes) =>
      key === contentKey(fixture.expected.entries_sha256[entry]) ? new Uint8Array([1]) : bytes;
    const { report } = await harness([one], '2026-11-26T03:05:00.000Z').run([
      '--sequence',
      'lotes_cotizaciones',
    ]);
    expect(report).toMatchObject({
      detail: 'source_schema_mismatch',
      reason: 'publication_not_derivable',
    });
  });

  it('--sequence solo admite una secuencia por lotes con perfil, y no va con --symbol', async () => {
    const { run } = harness([], '2026-11-26T03:05:00.000Z');
    for (const argv of [
      ['--sequence', 'R_100'],
      ['--sequence', 'frxXAUUSD'],
      ['--sequence', 'lotes_otra'],
      ['--sequence', 'lotes_velas', '--symbol', 'R_100'],
    ]) {
      const { exitCode, report } = await run(argv);
      expect(exitCode, argv.join(' ')).toBe(2);
      expect(report).toMatchObject({ code: 'UsageError', status: 'failed' });
    }
    for (const name of [
      'lotes_horarios',
      'lotes_cotizaciones',
      'lotes_velas',
      'lotes_historia_r_100',
      'lotes_historia_frxxauusd',
    ]) {
      expect((await run(['--', '--sequence', name, '--skip', '1'])).report).toMatchObject({
        sequence: name,
        status: 'nothing_due',
      });
    }
  });

  it('la historia, un bloque por dataset, con las reglas 4.1.0 y su tick_gap, y un bloque a medias espera a su último tramo (precisión del PR 6c)', async () => {
    const plan = historyPlan(derivHistoryProfile('frxXAUUSD'));
    const last = plan.blocks.length - 1;
    const previous = plan.blocks[last - 1];
    const final = plan.blocks[last];
    if (previous === undefined || final === undefined) throw new TypeError('sin bloques');
    const day = new Date(previous.start * 1000).toISOString().slice(0, 10);
    // Cada tramo con un tick por segundo, salvo el primero del bloque, con 120 s sin ticks.
    const pages = (block: typeof previous) =>
      block.requests.slice(1).map((request, offset) => {
        if (request.operation !== 'ticks_history') throw new TypeError('no es un tramo');
        const epochs = Array.from(
          { length: request.end - request.start + 1 },
          (_, second) => request.start + second,
        ).filter((epoch) => offset > 0 || epoch >= request.start + 120);
        return historyPageText('frxXAUUSD', request.start, request.end, epochs);
      });
    const [p1, ...rest] = pages(previous);
    const firstTranche = previous.requests[2];
    if (p1 === undefined || firstTranche?.operation !== 'ticks_history') throw new TypeError('x');
    const at = (offsetMinutes: number) =>
      new Date(Date.parse('2027-01-01T00:00:00.000Z') + offsetMinutes * 60_000).toISOString();
    const runs: BatchRun[] = [
      // Un RateLimit para la ejecución, y la siguiente sigue en ese tramo.
      {
        atUtc: at(0),
        texts: [
          sessionText(day),
          p1,
          historyRateLimitText('frxXAUUSD', firstTranche.start, firstTranche.end),
        ],
      },
      { atUtc: at(5), texts: rest },
      // El último bloque, a medias.
      { atUtc: at(10), texts: [sessionText(day), ...pages(final).slice(0, 2)] },
    ];
    const one = await batchLog(HISTORY_GOLD_SEQUENCE, 1, 'history_frxxauusd', runs);
    const { datasets, replay, run } = harness([one], at(20));
    const first = await run(['--sequence', 'lotes_historia_frxxauusd']);
    // El horario, la primera página y el RateLimit en el segmento 0, y las 15 páginas que faltan en
    // el 1: el bloque entero, sin el horario del bloque siguiente.
    expect(first.report).toMatchObject({
      first_segment: 0,
      incident_count: 2,
      last_segment: 1,
      sequence: 'lotes_historia_frxxauusd',
      status: 'published',
    });
    const id = String(first.report['dataset_id']);
    // El tramo sin ticks y el RateLimit, una respuesta con error.
    expect(datasets.incidents.get(id)?.map((incident) => incident.incident_type)).toEqual([
      'tick_gap',
      'invalid_source_frame',
    ]);
    expect(coreOf(datasets, id)).toMatchObject({
      normalized_tick_count: 14_400 - 120,
      quality_rule_version: '4.1.0',
    });
    expect(await replay(id, 'recompute')).toMatchObject({ incident_count: 2 });
    // El último bloque no tiene todavía su último tramo.
    expect((await run(['--sequence', 'lotes_historia_frxxauusd'])).report).toMatchObject({
      status: 'nothing_due',
    });
  });
});
