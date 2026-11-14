import { sha256Hex } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  CommitOutcomeUnknownError,
  contentKey,
  DATASETS_PREFIX,
  InMemoryObjectStore,
  InMemorySourceLogStore,
  LogIntegrityError,
  LogReadError,
  logLocation,
  logReader,
  PublicationConflictError,
  PublicationError,
  PublicationLimitError,
  publicationFailure,
  publishDatasetCommand,
  replayDataset,
  type CaptureLog,
  type PublicationStores,
  type PublishCommandDependencies,
} from '../src/index.js';
import { createDerivPublicationProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { SOURCE_SCHEMA_ENTRY } from '../src/deriv/schema-release.js';
import { syntheticSchemas } from './support/connection-harness.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';
import {
  MemoryDatasetStore,
  MemoryObjectStore,
  MemoryOperationalStore,
} from './support/memory-stores.js';
import { liveEvents, writeLiveLog, type LiveConnection } from './support/live-log.js';

// `datasets:publish` (ADR-0020 §7 y §8; PR 3c de su §13), sin red, reloj real ni azar: los logs
// sucesivos en almacenes en memoria, escritos con el `SourceEventLog` del worker, y `buoh_datasets`
// en memoria. Las expectativas salen de §7 y §8: como mucho un dataset por ejecución, del log de
// menor número que no venció, tiene uno pendiente y no está detenido; una línea JSON con
// `published`, `nothing_due` o `failed`.

const fixture = syntheticSchemaArchive();
const profile = createDerivPublicationProfile({ schemas: syntheticSchemas(), symbol: 'R_100' });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-10T00:00:30.000Z');
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_PASSWORD: 'sintetica-0123456789',
  BUOH_POSTGRES_SSLMODE: 'verify-full',
  BUOH_POSTGRES_USER: 'buoh_publicacion',
  BUOH_S3_ACCESS_KEY_ID: 'sintetica',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'sintetica',
};

interface FakeLog {
  readonly number: number;
  readonly objects: MemoryObjectStore;
  readonly store: InMemorySourceLogStore;
  lastWriteUtc: string | null;
  readable: boolean;
}

async function fakeLog(
  number: number,
  connections: readonly LiveConnection[],
  options: { schema?: boolean } = {},
): Promise<FakeLog> {
  const objects = new MemoryObjectStore('buoh-captura');
  const store = new InMemorySourceLogStore();
  if (options.schema !== false) {
    await objects.putIfAbsent(
      contentKey(fixture.expected.entries_sha256[SOURCE_SCHEMA_ENTRY]),
      fixture.entries[SOURCE_SCHEMA_ENTRY],
    );
  }
  const events = liveEvents(profile, connections);
  if (events.length > 0) {
    await writeLiveLog({ events, objects, source: DERIV_SOURCE, store });
  }
  const last = connections.at(-1);
  return {
    lastWriteUtc: last === undefined ? null : new Date(last.toMs).toISOString(),
    number,
    objects,
    readable: true,
    store,
  };
}

function harness(logs: FakeLog[], nowUtc: string) {
  const datasets = new MemoryDatasetStore();
  const datasetObjects = new MemoryObjectStore('buoh-captura');
  const operational = new MemoryOperationalStore();
  const opened: { schema: string; keyPrefix: string; closed: number } = {
    closed: 0,
    keyPrefix: '?',
    schema: '?',
  };
  let ids = 0;
  let failList = false;
  const dependencies: PublishCommandDependencies = {
    alert: () => undefined,
    elapsedMs: () => 1234,
    maxRssBytes: () => 100 * 1048576,
    nextId: () => {
      ids += 1;
      return `019a9000-0000-7000-8000-${ids.toString().padStart(12, '0')}`;
    },
    now: () => nowUtc,
    open: (config): PublicationStores => {
      opened.schema = config.postgres.schema;
      opened.keyPrefix = config.s3.keyPrefix;
      return {
        close: () => {
          opened.closed += 1;
          return Promise.resolve();
        },
        datasetObjects,
        datasets,
        listLogs: () =>
          failList
            ? Promise.reject(Object.assign(new Error('caído'), { code: 'ECONNREFUSED' }))
            : Promise.resolve(
                logs.map((log): CaptureLog => ({
                  lastWriteUtc: log.lastWriteUtc,
                  location: logLocation(log.number),
                  readable: log.readable,
                })),
              ),
        log: (location) => {
          const found = logs.find((log) => log.number === location.number);
          if (found === undefined) throw new TypeError('sin log');
          return logReader({
            objects: found.objects,
            schemas: fixture.expected,
            source: DERIV_SOURCE,
            store: found.store,
          });
        },
        operational,
      };
    },
    schemas: fixture.expected,
    zlibVersion: 'test-zlib',
  };
  const run = async (argv: readonly string[] = [], env: Record<string, string> = ENV) => {
    const result = await publishDatasetCommand(argv, env, dependencies);
    return { ...result, report: JSON.parse(result.line) as Record<string, unknown> };
  };
  return {
    datasetObjects,
    datasets,
    dependencies,
    failList: () => {
      failList = true;
    },
    opened,
    operational,
    run,
  };
}

const requested = (fromMs: number, toMs: number): LiveConnection => ({
  end: 'requested',
  fromMs,
  toMs,
});

describe('datasets:publish (ADR-0020 §8, paso 6)', () => {
  it('publica un dataset del log terminado de menor número, con su línea JSON, en gzip y bajo datasets/', async () => {
    // El log 1 terminó: el 2 ya tiene escrituras.
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { datasetObjects, datasets, opened, run } = harness(
      [one, two],
      '2026-11-11T01:00:00.000Z',
    );
    const { exitCode, report } = await run();
    expect(exitCode).toBe(0);
    const segments = one.store.closed.length;
    expect(report).toMatchObject({
      behind: null,
      clean: true,
      duration_ms: 1234,
      first_segment: 0,
      last_segment: segments - 1,
      log: 1,
      max_rss_bytes: 100 * 1048576,
      open_condition_types: [],
      pending_continuity_symbols: [],
      status: 'published',
    });
    expect(report['source_event_count']).toBe(one.store.rows.length);
    expect(report['normalized_tick_count']).toBe(600);
    expect(report['incident_count']).toBe(0);
    expect(report['elements']).toBe(one.store.rows.length);
    // En buoh_datasets, con el prefijo de los objetos en la clave.
    expect(opened).toEqual({ closed: 1, keyPrefix: '', schema: 'buoh_datasets' });
    expect(datasets.records).toHaveLength(1);
    const record = datasets.records[0]?.record;
    expect(record?.dataset_id).toBe(report['dataset_id']);
    expect(record?.publication_id).toBe(report['publication_id']);
    expect(record?.manifest_object_uri).toMatch(/^s3:\/\/buoh-captura\/datasets\/manifests\//u);
    expect([...datasetObjects.objects.keys()].every((key) => key.startsWith(DATASETS_PREFIX))).toBe(
      true,
    );
    // Con el perfil de publicación de R_100 y los derivados en gzip, y se reproduce en los dos modos.
    const root = new InMemoryObjectStore('buoh-captura', datasetObjects.objects);
    for (const mode of ['verify-only', 'recompute'] as const) {
      const replay = await replayDataset({
        datasetId: String(report['dataset_id']),
        environment: 'production',
        keyPrefix: DATASETS_PREFIX,
        metadata: datasets,
        mode,
        objects: root,
      });
      expect(replay.dataset_id).toBe(report['dataset_id']);
    }
    expect(datasets.ranges.get(String(report['dataset_id']))?.range).toEqual({
      clean: true,
      first_segment: 0,
      last_segment: segments - 1,
      log_number: 1,
      open: { open_condition_types: [], pending_continuity_symbols: [] },
    });
  });

  it('publica como mucho uno por ejecución y sigue desde el segmento siguiente al último publicado', async () => {
    // El log 1, de 7 horas: su primer dataset termina antes de las 06:00, y el siguiente empieza
    // en el segmento que sigue y termina con el log.
    const one = await fakeLog(1, [requested(T0, T0 + 7 * HOUR)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { datasets, run } = harness([one, two], '2026-11-11T01:00:00.000Z');
    const first = await run();
    expect(first.report).toMatchObject({ first_segment: 0, log: 1, status: 'published' });
    expect(datasets.records).toHaveLength(1);
    const second = await run();
    expect(second.report).toMatchObject({
      first_segment: Number(first.report['last_segment']) + 1,
      log: 1,
      status: 'published',
    });
    expect(second.report['last_segment']).toBe(one.store.closed.length - 1);
    expect(datasets.records).toHaveLength(2);
    expect((await run()).report['status']).toBe('nothing_due');
  }, 60_000);

  it('sin nada pendiente: nothing_due, salida 0; el log activo espera a su marca', async () => {
    // El log 1 ya está publicado entero; el 2 es el activo y no llegó a su primera marca.
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 30 * 60_000)]);
    const { datasets, run } = harness([one, two], '2026-11-11T01:00:00.000Z');
    expect((await run()).report['status']).toBe('published');
    const { exitCode, report } = await run();
    expect(exitCode).toBe(0);
    expect(report).toEqual({
      behind: null,
      duration_ms: 1234,
      max_rss_bytes: 100 * 1048576,
      status: 'nothing_due',
    });
    expect(datasets.records).toHaveLength(1);
  });

  it('un log preparado sin escrituras no termina el anterior, y no se lee su esquema', async () => {
    // El log 2 está preparado, sin escrituras ni esquema de fuente, como antes de que ingest arranque.
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [], { schema: false });
    const { datasets, run } = harness([one, two], '2026-11-10T01:00:00.000Z');
    const { exitCode, report } = await run();
    expect(exitCode).toBe(0);
    expect(report['status']).toBe('nothing_due');
    expect(datasets.records).toHaveLength(0);
  });

  it('salta los logs vencidos, los que no se pueden leer y los detenidos de --skip', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 20 * 60_000)]);
    const three = await fakeLog(3, [requested(T0 + 2 * DAY, T0 + 2 * DAY + 20 * 60_000)]);
    const four = await fakeLog(4, [requested(T0 + 3 * DAY, T0 + 3 * DAY + 20 * 60_000)]);
    const five = await fakeLog(5, [requested(T0 + 4 * DAY, T0 + 4 * DAY + 10 * 60_000)]);
    two.readable = false;
    // El log 1 venció: su última escritura tiene 30 días.
    const now = new Date(T0 + 20 * 60_000 + 30 * DAY).toISOString();
    const { run } = harness([one, two, three, four, five], now);
    expect((await run(['--skip', '3'])).report).toMatchObject({ log: 4, status: 'published' });
    const again = harness([one, two, three, four, five], now);
    expect((await again.run()).report).toMatchObject({ log: 3, status: 'published' });
  });

  it('avisa con behind si al log más viejo con segmentos sin publicar le quedan menos de 3 días', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 20 * 60_000)]);
    const end = T0 + 20 * 60_000;
    const expires = new Date(end + 30 * DAY).toISOString();
    // Con 3 días justos todavía no; un milisegundo menos, sí. También si está detenido.
    const early = harness([one, two], new Date(end + 27 * DAY).toISOString());
    expect((await early.run(['--skip', '1'])).report['behind']).toBe(null);
    const late = harness([one, two], new Date(end + 27 * DAY + 1).toISOString());
    expect((await late.run(['--skip', '1'])).report['behind']).toEqual({
      expires_at_utc: expires,
      log: 1,
    });
    // Con dos logs atrasados, el más viejo.
    const three = await fakeLog(3, [requested(T0 + 2 * HOUR, T0 + 2 * HOUR + 20 * 60_000)]);
    // Los dos con menos de 3 días: el 3 terminó 2 horas después del 1.
    const both = harness(
      [one, three, two],
      new Date(T0 + 2 * HOUR + 20 * 60_000 + 27 * DAY + 1).toISOString(),
    );
    expect((await both.run(['--skip', '1,3'])).report['behind']).toEqual({
      expires_at_utc: expires,
      log: 1,
    });
    // Publicado entero, ya no está atrasado.
    expect((await late.run()).report['status']).toBe('published');
    expect((await late.run(['--skip', '1'])).report['behind']).toBe(null);
  });

  it('un final que no fue limpio queda en la línea y en la fila de rango', async () => {
    // Una caída a la 01:00 sin historia: la continuidad queda pendiente hasta el final del log.
    const one = await fakeLog(1, [
      { end: 'dropped', fromMs: T0, toMs: T0 + HOUR },
      requested(T0 + HOUR + 10_000, T0 + 2 * HOUR),
    ]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { run } = harness([one, two], '2026-11-11T01:00:00.000Z');
    expect((await run()).report).toMatchObject({
      clean: false,
      pending_continuity_symbols: ['R_100'],
      status: 'published',
    });
  });

  it('un segmento que pasa el techo por sí solo: failed con publication_segment_too_large, salida 1', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { datasets, dependencies } = harness([one, two], '2026-11-11T01:00:00.000Z');
    const small: PublishCommandDependencies = { ...dependencies, ceiling: 10 };
    const result = await publishDatasetCommand([], ENV, small);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toMatchObject({
      first_segment: 0,
      log: 1,
      reason: 'publication_segment_too_large',
      stage: 'plan',
      status: 'failed',
    });
    expect(datasets.records).toHaveLength(0);
  });

  it('sin el esquema de fuente guardado, el log no se deriva: publication_not_derivable', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)], { schema: false });
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { run } = harness([one, two], '2026-11-11T01:00:00.000Z');
    const { exitCode, report } = await run();
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({
      detail: 'source_schema_missing',
      log: 1,
      reason: 'publication_not_derivable',
      stage: 'plan',
      status: 'failed',
    });
  });

  it('un segmento alterado tampoco se deriva, y un almacén que no responde es storage_unavailable', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const segment = one.store.closed[0]?.object_bytes_sha256 ?? '';
    one.objects.onRead = (key, bytes) => (key === contentKey(segment) ? bytes.slice(1) : bytes);
    const altered = harness([one, two], '2026-11-11T01:00:00.000Z');
    expect((await altered.run()).report).toMatchObject({
      detail: 'LogIntegrityError',
      reason: 'publication_not_derivable',
    });
    const down = harness([one, two], '2026-11-11T01:00:00.000Z');
    down.failList();
    const { exitCode, report } = await down.run();
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({
      detail: 'ECONNREFUSED',
      log: null,
      reason: 'storage_unavailable',
      stage: 'precondition',
      status: 'failed',
    });
    expect(down.opened.closed).toBe(1);
    // Sin la lista de logs no se sabe si alguno va atrasado: la línea no lo dice.
    expect(report).not.toHaveProperty('behind');
  });

  it('un fallo al leer el rango de un log no lleva el primer segmento del log anterior', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [], { schema: false });
    const { datasets, run } = harness([one, two], '2026-11-10T01:00:00.000Z');
    const original = datasets.lastLogRange.bind(datasets);
    datasets.lastLogRange = (number) =>
      number === 2
        ? Promise.reject(Object.assign(new Error('caído'), { code: 'ECONNRESET' }))
        : original(number);
    const { report } = await run();
    expect(report).toMatchObject({ log: 2, reason: 'storage_unavailable', status: 'failed' });
    expect(report).not.toHaveProperty('first_segment');
    expect(report['behind']).toBe(null);
  });

  it('un perfil que no se arma con el esquema guardado es publication_not_derivable, no unexpected', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)], { schema: false });
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    // Unos bytes con el SHA-256 que espera la release, pero que no son un esquema JSON.
    const garbage = new TextEncoder().encode('no es un esquema');
    const expected = {
      ...fixture.expected,
      entries_sha256: {
        ...fixture.expected.entries_sha256,
        [SOURCE_SCHEMA_ENTRY]: sha256Hex(garbage),
      },
    };
    await one.objects.putIfAbsent(contentKey(sha256Hex(garbage)), garbage);
    const { dependencies } = harness([one, two], '2026-11-11T01:00:00.000Z');
    const opened = dependencies.open;
    const result = await publishDatasetCommand([], ENV, {
      ...dependencies,
      open: (config) => {
        const stores = opened(config);
        return {
          ...stores,
          log: (location) =>
            logReader({
              objects: location.number === 1 ? one.objects : two.objects,
              schemas: expected,
              source: DERIV_SOURCE,
              store: location.number === 1 ? one.store : two.store,
            }),
        };
      },
      schemas: expected,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.line)).toMatchObject({
      log: 1,
      reason: 'publication_not_derivable',
      stage: 'plan',
    });
  });

  it('una escritura que falla: failed con su etapa, y la incidencia en el registro de buoh_datasets', async () => {
    const one = await fakeLog(1, [requested(T0, T0 + 20 * 60_000)]);
    const two = await fakeLog(2, [requested(T0 + DAY, T0 + DAY + 10 * 60_000)]);
    const { datasetObjects, operational, run } = harness([one, two], '2026-11-11T01:00:00.000Z');
    datasetObjects.armNextPutFailure('ECONNRESET');
    const { exitCode, report } = await run();
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({
      detail: 'ECONNRESET',
      first_segment: 0,
      log: 1,
      reason: 'storage_unavailable',
      stage: 'normalized_object_write',
      status: 'failed',
    });
    expect(operational.incidents).toHaveLength(1);
  });

  it('errores de uso y de configuración: salida 2, sin abrir nada', async () => {
    const { opened, run } = harness([], '2026-11-11T01:00:00.000Z');
    for (const argv of [
      ['--skip', 'x'],
      ['--skip', '0'],
      ['--skip', '1e2'],
      ['--skip', '01'],
      ['--skip', '1,'],
      ['--otro'],
      ['posicional'],
    ]) {
      const { exitCode, report } = await run(argv);
      expect(exitCode, argv.join(' ')).toBe(2);
      expect(report).toMatchObject({ code: 'UsageError', status: 'failed' });
    }
    const schema = await run([], { ...ENV, BUOH_POSTGRES_SCHEMA: 'buoh_log_000001' });
    expect(schema.exitCode).toBe(2);
    expect(schema.report).toMatchObject({ code: 'ConfigError' });
    expect(String(schema.report['message'])).toContain('BUOH_POSTGRES_SCHEMA');
    const missing = await run([], { BUOH_DEPLOYMENT_ENVIRONMENT: 'production' });
    expect(missing.exitCode).toBe(2);
    expect(opened.closed).toBe(0);
  });

  it('acepta el separador -- de pnpm, --skip con varios logs y --symbol R_100', async () => {
    const { run } = harness([], '2026-11-11T01:00:00.000Z');
    expect((await run(['--', '--skip', '1,2', '--symbol', 'R_100'])).report['status']).toBe(
      'nothing_due',
    );
    expect((await run(['--symbol', 'R_50'])).exitCode).toBe(2);
  });
});

describe('publicationFailure (ADR-0020 §8)', () => {
  it('nombra la causa: lo que repetir no cambia, un almacén, el COMMIT ambiguo y lo inesperado', () => {
    const cause = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    expect(publicationFailure(new PublicationLimitError('object_bytes', 'grande'))).toEqual({
      detail: 'object_bytes',
      reason: 'publication_limit_exceeded',
      stage: 'precondition',
    });
    expect(
      publicationFailure(new PublicationConflictError('sha256:x', { kind: 'log_range' })),
    ).toEqual({ detail: 'log_range', reason: 'publication_conflict', stage: 'manifest_commit' });
    expect(publicationFailure(new CommitOutcomeUnknownError('sha256:x', { cause }))).toEqual({
      detail: 'ECONNRESET',
      reason: 'commit_outcome_unknown',
      stage: 'manifest_commit',
    });
    expect(publicationFailure(new PublicationError('manifest_write', 'x', { cause }))).toEqual({
      detail: 'ECONNRESET',
      reason: 'storage_unavailable',
      stage: 'manifest_write',
    });
    expect(publicationFailure(new LogReadError('ECONNRESET', { cause }))).toEqual({
      detail: 'ECONNRESET',
      reason: 'storage_unavailable',
      stage: 'plan',
    });
    expect(publicationFailure(new LogIntegrityError('x'))).toEqual({
      detail: 'LogIntegrityError',
      reason: 'publication_not_derivable',
      stage: 'plan',
    });
    expect(publicationFailure(new RangeError('derivación'), 'plan')).toEqual({
      detail: 'RangeError',
      reason: 'publication_not_derivable',
      stage: 'plan',
    });
    expect(publicationFailure(new RangeError('otro'))).toEqual({
      detail: 'RangeError',
      reason: 'unexpected',
      stage: 'unknown',
    });
  });
});
