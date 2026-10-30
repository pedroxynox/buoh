import { connectionClosedSchema, sha256Hex, type SourceEvent } from '@buoh/contracts';
import { deriveMarketData, emptyLiveDerivationState, foldLiveDerivation } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDerivMeasurementProfile,
  createDerivMeasurementProfileFromSourceSchema,
  DERIV_SOURCE,
} from '../src/deriv/profile.js';
import {
  observeDataHealth,
  type HealthObservationProgress,
  type HealthStores,
} from '../src/health/observe.js';
import { contentKey } from '../src/object-keys.js';
import { OperationalRegistry } from '../src/operational/registry.js';
import { sourceEventId, SourceEventLog } from '../src/source-log/source-event-log.js';
import { syntheticSchemas, uuid } from './support/connection-harness.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';
import { checkpointRowsOf } from './support/live-checkpoint-rows.js';
import {
  MemoryIngestionStatusStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';
import {
  previousConnectionEvents,
  stoppedBeforeRecoveryEvents,
} from './support/recovery-harness.js';
import { cursorOf, heartbeatOf } from './support/status-store-rules.js';

// Lo que observa `data:health` (ADR-0015 §8, «Entradas») sin red ni servicios: almacenes en
// memoria, un lector falso del bloqueo, reloj e IDs inyectados y esquemas sintéticos. Ningún precio
// es de mercado.

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

const SYMBOL = 'SYNTH_100';
/** El archivo de esquemas sintético que cargó la ingesta, con su esquema de fuente. */
const FIXTURE = syntheticSchemaArchive();
const SOURCE_SCHEMA = FIXTURE.entries['ticks_response.schema.json'];
/** La clave del esquema de fuente guardado: su SHA-256 fijado (ADR-0015 §7). */
const SCHEMA_KEY = contentKey(FIXTURE.expected.entries_sha256['ticks_response.schema.json']);
/** El tamaño máximo de una entrada de `schemas.zip` (ADR-0004 §7). */
const SCHEMA_ENTRY_MAX_BYTES = 10_485_760;
/** El PID de PostgreSQL del escritor vivo. */
const WRITER_PID = 4242;
/** Un `dataset_id` sintético del último dataset activo de la fuente. */
const DATASET = `sha256:${'a'.repeat(64)}`;
/** La hora de la observación. */
const NOW = '2026-03-02T10:00:10.000Z';
/** El perfil de medición de la sesión, el mismo que arma la observación con el esquema guardado. */
const PROFILE = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });

/** El log que observa `data:health` cuando lo pliega entero, desde el log vacío. */
const foldedLog = (events: readonly SourceEvent[], cursorInLog: boolean | null) => ({
  cursor_in_log: cursorInLog,
  fold: {
    state: foldLiveDerivation(emptyLiveDerivationState(), events, PROFILE),
    status: 'derived',
  },
  status: 'folded',
});

/** El perfil sin su validador compilado, que es una función distinta en cada perfil. */
function comparable(profile: ReturnType<typeof createDerivMeasurementProfile>) {
  const { validateSourcePayload, ...rest } = profile;
  expect(typeof validateSourcePayload).toBe('function');
  return rest;
}

/** Un error de un almacén que no responde, con un mensaje que nunca debe salir. */
const unavailable = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 rol_sintetico base_sintetica'), {
    code: 'ECONNREFUSED',
  });

interface ObserveOptions {
  /**
   * Dónde se cierran segmentos: antes de cada uno de estos eventos, por su índice. El resto queda en
   * el segmento abierto.
   */
  readonly closedEvents?: readonly number[];
  /** El log durable; por defecto, el de una ejecución que paró antes de recuperar el hueco. */
  readonly events?: readonly SourceEvent[];
  /** Las migraciones que le faltan al esquema; por defecto, ninguna. */
  readonly pending?: readonly string[];
  /** Los bytes guardados bajo la clave del esquema de fuente; `null`, ninguno. */
  readonly schema?: Uint8Array | null;
}

/**
 * Lo que observa `data:health` sobre almacenes en memoria: el log (`events`, con un segmento
 * cerrado antes de cada índice de `closedEvents`), el esquema de fuente guardado, un cursor del
 * símbolo, un latido del escritor vivo, una condición abierta del registro operativo, el escritor
 * vivo y el último dataset. `timeline` anota cada lectura, en orden, y la hora de la observación.
 * `writeCheckpoints` guarda los puntos de control de los segmentos cerrados, como `ingest`.
 */
async function observeHarness(options: ObserveOptions = {}) {
  const timeline: string[] = [];
  const sourceLog = new MemorySourceLogStore();
  const objects = new MemoryObjectStore();
  const status = new MemoryIngestionStatusStore();
  const operational = new MemoryOperationalStore();
  const events = options.events ?? stoppedBeforeRecoveryEvents();
  const seed = await SourceEventLog.open({
    objects,
    source: DERIV_SOURCE,
    store: sourceLog,
    zlibVersion: 'test',
  });
  for (const [index, event] of events.entries()) {
    if (options.closedEvents?.includes(index) === true) {
      await seed.close('requested');
    }
    await seed.append(event);
  }
  const schema = options.schema === undefined ? SOURCE_SCHEMA : options.schema;
  if (schema !== null) {
    await objects.putIfAbsent(SCHEMA_KEY, schema);
  }
  await status.appendCursor(cursorOf(DERIV_SOURCE));
  const heartbeat = heartbeatOf(DERIV_SOURCE, 1, {
    connection_state: 'disconnected',
    observed_at_utc: '2026-03-02T09:59:55.000Z',
    pg_backend_pid: WRITER_PID,
  });
  await status.appendHeartbeat(heartbeat);
  const registry = await OperationalRegistry.open({ source: DERIV_SOURCE, store: operational });
  await registry.recordPersistenceUnavailable({
    observed_at_utc: '2026-03-02T09:59:20.000Z',
    observed_ref: uuid(8001),
    reason: 'ECONNREFUSED',
    related_refs: [],
    stage: 'raw_object_write',
  });
  const stores: HealthStores = {
    datasets: {
      lastActiveDatasetId: (source, environment) => {
        timeline.push(`lastActiveDatasetId:${source}:${environment}`);
        return Promise.resolve(DATASET);
      },
    },
    ingestionStatus: {
      cursorSymbols: (source) => {
        timeline.push(`cursorSymbols:${source}`);
        return status.cursorSymbols(source);
      },
      latestCursor: (source, symbol) => {
        timeline.push(`latestCursor:${source}:${symbol}`);
        return status.latestCursor(source, symbol);
      },
      latestHeartbeat: (source) => {
        timeline.push(`latestHeartbeat:${source}`);
        return status.latestHeartbeat(source);
      },
    },
    lockHolder: (source) => {
      timeline.push(`lockHolder:${source}`);
      return Promise.resolve(WRITER_PID);
    },
    objects: {
      bucket: objects.bucket,
      get: (key, maxBytes) => {
        timeline.push(`get:${key === SCHEMA_KEY ? 'schema' : 'log'}:${String(maxBytes)}`);
        return objects.get(key, maxBytes);
      },
    },
    operational: {
      load: (source) => {
        timeline.push(`load:${source}`);
        return operational.load(source);
      },
    },
    pendingMigrations: () => {
      timeline.push('pendingMigrations');
      return Promise.resolve(options.pending ?? []);
    },
    sourceLog: {
      hasSourceEvent: (source, eventId) => {
        timeline.push(`hasSourceEvent:${source}:${eventId}`);
        return sourceLog.hasSourceEvent(source, eventId);
      },
      listClosedSegments: (source, from, to) => {
        timeline.push(`listClosedSegments:${source}:${String(from)}`);
        return sourceLog.listClosedSegments(source, from, to);
      },
      readLiveCheckpoint: (source, versionsSha256, below) => {
        timeline.push(`readLiveCheckpoint:${source}:${String(below)}`);
        return sourceLog.readLiveCheckpoint(source, versionsSha256, below);
      },
      readLogState: (source) => {
        timeline.push(`readLogState:${source}`);
        return sourceLog.readLogState(source);
      },
    },
  };
  const nextId = () => uuid(7001);
  const observe = (overrides: Partial<HealthStores> = {}, progress?: HealthObservationProgress) =>
    observeDataHealth({
      environment: 'test',
      expected: FIXTURE.expected,
      nextId,
      now: () => {
        timeline.push('now');
        return NOW;
      },
      ...(progress === undefined ? {} : { progress }),
      stores: { ...stores, ...overrides },
      symbol: SYMBOL,
    });
  /**
   * Guarda los puntos de control de esos segmentos cerrados, como `ingest`, y devuelve las filas de
   * todos los cerrados.
   */
  const writeCheckpoints = async (...segments: readonly number[]) => {
    const rows = await checkpointRowsOf({
      log: seed,
      profile: PROFILE,
      symbol: SYMBOL,
      writtenAt: NOW,
    });
    for (const row of rows.filter((item) => segments.includes(item.segment_index))) {
      await sourceLog.insertLiveCheckpoint(row);
    }
    return rows;
  };
  /** Lo que guardan los almacenes, para comprobar que la observación no escribe nada. */
  const contents = () =>
    structuredClone({
      checkpoints: sourceLog.checkpoints,
      closed: sourceLog.closed,
      conditions: operational.conditions,
      cursors: status.cursors,
      heartbeats: status.heartbeats,
      incidents: operational.incidents,
      objects: [...objects.objects.entries()],
      rows: sourceLog.rows,
    });
  return {
    contents,
    events,
    heartbeat,
    nextId,
    objects,
    observe,
    seed,
    sourceLog,
    stores,
    timeline,
    writeCheckpoints,
  };
}

describe('createDerivMeasurementProfileFromSourceSchema (ADR-0015 §7 y §8)', () => {
  it('con los bytes del esquema de fuente guardado y su release da el mismo perfil que la sesión con los esquemas cargados, y deriva lo mismo', () => {
    const schemas = syntheticSchemas();
    const session = createDerivMeasurementProfile({ schemas, symbol: SYMBOL });
    // Una copia de los bytes, como los que devuelve el almacenamiento de objetos.
    const stored = createDerivMeasurementProfileFromSourceSchema({
      source_schema_bytes: Uint8Array.from(schemas.schema('ticks', 'response').bytes),
      source_schema_release: schemas.release,
      symbol: SYMBOL,
    });

    expect(comparable(stored)).toEqual(comparable(session));
    const segments = [stoppedBeforeRecoveryEvents()];
    expect(deriveMarketData(segments, stored)).toEqual(deriveMarketData(segments, session));
  });
});

describe('observeDataHealth: lo que lee (ADR-0015 §8, «Entradas»)', () => {
  it('lee el log durable plegado, el registro operativo, el último latido, los cursores, el escritor vivo y el último dataset de la fuente en el entorno', async () => {
    const run = await observeHarness({ closedEvents: [3] });
    const observation = await run.observe();

    expect(observation).toEqual({
      cursorSymbols: [SYMBOL],
      lastPublishedDatasetId: DATASET,
      latestCursor: cursorOf(DERIV_SOURCE),
      latestHeartbeat: run.heartbeat,
      // Sin puntos de control, pliega el log entero desde el vacío. El cursor apunta a `uuid(4)`,
      // que el log no tiene.
      log: foldedLog(run.events, false),
      nextId: run.nextId,
      now: NOW,
      operationalConditionTypes: ['persistence_unavailable'],
      profile: expect.anything() as unknown,
      source: DERIV_SOURCE,
      status: 'observed',
      symbol: SYMBOL,
      writerPid: WRITER_PID,
    });
    expect(run.timeline).toContain('lockHolder:deriv_options');
    expect(run.timeline).toContain('lastActiveDatasetId:deriv_options:test');
  });

  it('arma el perfil de medición con el esquema de fuente guardado: el mismo perfil que el de la sesión', async () => {
    const run = await observeHarness();
    const observation = await run.observe();
    if (observation.status !== 'observed' || observation.profile === null) {
      throw new TypeError('Se esperaba lo observado con perfil.');
    }
    expect(comparable(observation.profile)).toEqual(
      comparable(createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL })),
    );
  });

  it('lee el esquema de fuente guardado con la clave de su SHA-256 fijado y como mucho el tamaño máximo de una entrada de esquemas', async () => {
    const run = await observeHarness();
    await run.observe();
    expect(run.timeline).toContain(`get:schema:${String(SCHEMA_ENTRY_MAX_BYTES)}`);
  });

  it('lee el escritor vivo y el último latido antes que el log, y toma la hora al terminar de leer', async () => {
    const run = await observeHarness();
    await run.observe();
    const at = (entry: string) => run.timeline.indexOf(entry);
    expect(at('pendingMigrations')).toBe(0);
    expect(at('lockHolder:deriv_options')).toBeLessThan(at('readLogState:deriv_options'));
    expect(at('latestHeartbeat:deriv_options')).toBeLessThan(at('readLogState:deriv_options'));
    expect(run.timeline.filter((entry) => entry === 'now')).toHaveLength(1);
    expect(run.timeline.at(-1)).toBe('now');
  });

  it('lee el último cursor del símbolo pedido antes que el log, como el arranque: un cursor escrito después apunta a un evento que el log ya tiene', async () => {
    const run = await observeHarness();
    await run.observe();
    const at = (entry: string) => run.timeline.indexOf(entry);
    expect(at('latestCursor:deriv_options:SYNTH_100')).toBeGreaterThan(-1);
    expect(at('latestCursor:deriv_options:SYNTH_100')).toBeLessThan(
      at('readLogState:deriv_options'),
    );
  });

  it('sin escritor vivo, sin latido ni cursores y con el log vacío, lo observado lo dice: null, null y listas vacías', async () => {
    const run = await observeHarness({ events: [] });
    const observation = await run.observe({
      datasets: { lastActiveDatasetId: () => Promise.resolve(null) },
      ingestionStatus: {
        cursorSymbols: () => Promise.resolve([]),
        latestCursor: () => Promise.resolve(null),
        latestHeartbeat: () => Promise.resolve(null),
      },
      lockHolder: () => Promise.resolve(null),
      operational: { load: () => Promise.resolve({ conditions: [], incidents: [] }) },
    });
    expect(observation).toMatchObject({
      cursorSymbols: [],
      lastPublishedDatasetId: null,
      latestCursor: null,
      latestHeartbeat: null,
      log: foldedLog([], null),
      operationalConditionTypes: [],
      status: 'observed',
      writerPid: null,
    });
  });

  it('sin esquema de fuente guardado, el perfil es null y la evaluación decide: no pliega el log ni lee puntos de control, solo dice si tiene eventos', async () => {
    for (const events of [[], stoppedBeforeRecoveryEvents()]) {
      const run = await observeHarness({ closedEvents: [3], events, schema: null });
      expect(await run.observe()).toMatchObject({
        log: { empty: events.length === 0, status: 'unprofiled' },
        profile: null,
        status: 'observed',
      });
      expect(
        run.timeline.filter((entry) =>
          /^(listClosedSegments|readLiveCheckpoint|hasSourceEvent):/u.test(entry),
        ),
      ).toEqual([]);
    }
  });

  it('no escribe nada en ningún almacén, aunque los que recibe sepan escribir', async () => {
    const run = await observeHarness({ closedEvents: [3] });
    const before = run.contents();
    const writes = [
      vi.spyOn(run.sourceLog, 'insertIndexRow'),
      vi.spyOn(run.sourceLog, 'insertClosedSegment'),
      vi.spyOn(run.objects, 'putIfAbsent'),
    ];
    // Los almacenes completos, con sus escrituras, como los que da `openStores` en `data:health`.
    await run.observe({ objects: run.objects, sourceLog: run.sourceLog });
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(run.contents()).toEqual(before);
  });
});

describe('observeDataHealth: el log desde su último punto de control válido (ADR-0017 §4 y §6)', () => {
  type Harness = Awaited<ReturnType<typeof observeHarness>>;

  /** La clave del objeto del segmento cerrado `k`. */
  const segmentKey = (run: Harness, k: number) =>
    contentKey(run.sourceLog.closed[k]?.object_bytes_sha256 ?? '');

  /** Las lecturas de los puntos de control y de los segmentos cerrados, en orden. */
  const checkpointReads = (run: Harness) =>
    run.timeline.filter((entry) => /^(readLiveCheckpoint|listClosedSegments):/u.test(entry));

  const emptyProgress = (): HealthObservationProgress => ({ alerts: [], rebuilding: false });

  it('parte del último por debajo del segmento abierto y solo lee los segmentos cerrados posteriores: los objetos de los anteriores ni se leen, y el pliegue es el del log entero', async () => {
    // Los segmentos 0, 1 y 2 cerrados, con los puntos de control de 0 y 1, y el 3 abierto.
    const run = await observeHarness({ closedEvents: [2, 3, 4] });
    const rows = await run.writeCheckpoints(0, 1);
    run.objects.objects.delete(segmentKey(run, 0));
    run.objects.objects.delete(segmentKey(run, 1));
    const progress = emptyProgress();

    expect(await run.observe({}, progress)).toMatchObject({
      log: foldedLog(run.events, false),
      status: 'observed',
    });
    expect(checkpointReads(run)).toEqual([
      'readLiveCheckpoint:deriv_options:3',
      'listClosedSegments:deriv_options:2',
    ]);
    expect(progress).toEqual(emptyProgress());

    // Con el punto de control del último segmento cerrado, solo lee el segmento abierto.
    const last = rows[2];
    if (last === undefined) {
      throw new TypeError('Falta la fila del segmento 2.');
    }
    await run.sourceLog.insertLiveCheckpoint(last);
    run.objects.objects.delete(segmentKey(run, 2));
    run.timeline.length = 0;
    expect(await run.observe()).toMatchObject({ log: foldedLog(run.events, false) });
    expect(checkpointReads(run)).toEqual(['readLiveCheckpoint:deriv_options:3']);
  });

  it('sin un punto de control válido reconstruye en memoria desde el log vacío: anota en progress que reconstruye mientras lee los segmentos cerrados, y deja de hacerlo al terminar el pliegue', async () => {
    const run = await observeHarness({ closedEvents: [2, 3, 4] });
    const progress = emptyProgress();
    const seen: string[] = [];
    const note = (read: string) => seen.push(`${read}:${String(progress.rebuilding)}`);
    const closedKeys = new Set([0, 1, 2].map((k) => segmentKey(run, k)));
    const { objects, operational, sourceLog } = run.stores;
    const noting: Partial<HealthStores> = {
      objects: {
        bucket: objects.bucket,
        get: (key, maxBytes) => {
          if (closedKeys.has(key)) {
            note('segmento');
          }
          return objects.get(key, maxBytes);
        },
      },
      operational: {
        load: (source) => {
          note('registro');
          return operational.load(source);
        },
      },
      sourceLog: {
        ...sourceLog,
        hasSourceEvent: (source, eventId) => {
          note('cursor');
          return sourceLog.hasSourceEvent(source, eventId);
        },
        readLiveCheckpoint: (source, versionsSha256, below) => {
          note('punto de control');
          return sourceLog.readLiveCheckpoint(source, versionsSha256, below);
        },
      },
    };

    expect(await run.observe(noting, progress)).toMatchObject({
      log: foldedLog(run.events, false),
    });
    expect(seen).toEqual([
      'punto de control:false',
      'segmento:true',
      'segmento:true',
      'segmento:true',
      'cursor:false',
      'registro:false',
    ]);
    expect(progress).toEqual(emptyProgress());

    // Si una lectura de la reconstrucción falla, también deja de reconstruir.
    const failing = await observeHarness({ closedEvents: [2, 3, 4] });
    failing.objects.objects.delete(segmentKey(failing, 1));
    const failed = emptyProgress();
    expect(await failing.observe({}, failed)).toEqual({
      reason: 'log_not_derivable',
      source: DERIV_SOURCE,
      status: 'incompatible',
    });
    expect(failed).toEqual(emptyProgress());
  });

  it('avisa en progress de cada punto de control que rechaza, como la sesión, y parte del anterior', async () => {
    const run = await observeHarness({ closedEvents: [2, 3, 4] });
    const rows = await run.writeCheckpoints(0, 1);
    const last = rows[2];
    if (last === undefined) {
      throw new TypeError('Falta la fila del segmento 2.');
    }
    // El del segmento 2, con otro SHA-256.
    run.sourceLog.checkpoints.push({ ...last, checkpoint_sha256: 'f'.repeat(64) });
    const progress = emptyProgress();

    expect(await run.observe({}, progress)).toMatchObject({ log: foldedLog(run.events, false) });
    expect(progress).toEqual({
      alerts: [
        { event: 'checkpoint_rejected', reason: 'checkpoint_digest_mismatch', segment_index: '2' },
      ],
      rebuilding: false,
    });
    expect(checkpointReads(run)).toEqual([
      'readLiveCheckpoint:deriv_options:3',
      'readLiveCheckpoint:deriv_options:2',
      'listClosedSegments:deriv_options:2',
    ]);
  });

  it('un segmento que se cierra después de leer el estado del log, con su punto de control ya escrito, no se aplica dos veces: el pliegue es el de la foto', async () => {
    // El segmento 0 cerrado, con su punto de control, y el 1 abierto con el cierre remoto. Aplicar
    // dos veces ese cierre no se puede: la conexión se cerraría dos veces.
    const events = previousConnectionEvents();
    const run = await observeHarness({ closedEvents: [2], events });
    await run.writeCheckpoints(0);
    const { sourceLog } = run.stores;
    let raced = false;

    const observation = await run.observe({
      sourceLog: {
        ...sourceLog,
        readLiveCheckpoint: async (source, versionsSha256, below) => {
          if (!raced) {
            raced = true;
            // Mientras tanto, `ingest` cierra el segmento 1 y escribe su punto de control.
            await run.seed.close('requested');
            await run.writeCheckpoints(1);
          }
          return sourceLog.readLiveCheckpoint(source, versionsSha256, below);
        },
      },
    });

    expect(run.sourceLog.checkpoints.map((row) => row.segment_index)).toEqual([0, 1]);
    expect(observation).toMatchObject({ log: foldedLog(events, false), status: 'observed' });
    expect(checkpointReads(run)).toEqual(['readLiveCheckpoint:deriv_options:1']);
  });

  it('busca en el índice el evento del último cursor del símbolo, sin recorrer el log, solo si el pliegue llega al final', async () => {
    const run = await observeHarness({ closedEvents: [3] });
    const cursorAt = (eventId: string) => ({
      ingestionStatus: {
        ...run.stores.ingestionStatus,
        latestCursor: () =>
          Promise.resolve({
            cursor: cursorOf(DERIV_SOURCE, { last_durable_source_event_id: eventId }),
            version: 1,
          }),
      },
    });
    const lookups = () => run.timeline.filter((entry) => entry.startsWith('hasSourceEvent:'));

    // Un evento de un segmento cerrado y uno del abierto, y uno que el log no tiene.
    for (const [event, inLog] of [
      [run.events[0], true],
      [run.events[5], true],
      [undefined, false],
    ] as const) {
      const eventId = event === undefined ? uuid(9999) : sourceEventId(event);
      run.timeline.length = 0;
      expect(await run.observe(cursorAt(eventId))).toMatchObject({
        log: foldedLog(run.events, inLog),
      });
      expect(lookups()).toEqual([`hasSourceEvent:deriv_options:${eventId}`]);
    }

    // Sin cursor no busca nada.
    run.timeline.length = 0;
    expect(
      await run.observe({
        ingestionStatus: {
          ...run.stores.ingestionStatus,
          latestCursor: () => Promise.resolve(null),
        },
      }),
    ).toMatchObject({ log: foldedLog(run.events, null) });
    expect(lookups()).toEqual([]);

    // Con un log que no se pliega, tampoco: la regla 2 ya decide con su contenido.
    const closedTwice = connectionClosedSchema.parse({
      ...previousConnectionEvents()[2],
      event_id: uuid(9005),
    });
    const broken = await observeHarness({
      events: [...previousConnectionEvents(), closedTwice],
    });
    const observation = await broken.observe();
    expect(observation).toMatchObject({
      log: { cursor_in_log: null, fold: { status: 'not_derivable' }, status: 'folded' },
    });
    expect(broken.timeline.filter((entry) => entry.startsWith('hasSourceEvent:'))).toEqual([]);
  });
});

describe('observeDataHealth: lo incompatible (ADR-0015 §8, regla 2)', () => {
  const incompatible = (reason: string) => ({
    reason,
    source: DERIV_SOURCE,
    status: 'incompatible',
  });

  it('a un esquema PostgreSQL al que le faltan migraciones del worker le corresponde migrations_pending, sin leer nada más', async () => {
    const run = await observeHarness({ pending: ['0004_cursor_y_latido.sql'] });
    expect(await run.observe()).toEqual(incompatible('migrations_pending'));
    expect(run.timeline).toEqual(['pendingMigrations']);
  });

  it('una tabla que no existe (42P01) en cualquier lectura también es migrations_pending', async () => {
    const missing = () =>
      Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const run = await observeHarness();
    expect(
      await run.observe({
        ingestionStatus: {
          cursorSymbols: missing,
          latestCursor: missing,
          latestHeartbeat: missing,
        },
      }),
    ).toEqual(incompatible('migrations_pending'));
    expect(
      await run.observe({
        sourceLog: {
          hasSourceEvent: missing,
          listClosedSegments: missing,
          readLiveCheckpoint: missing,
          readLogState: missing,
        },
      }),
    ).toEqual(incompatible('migrations_pending'));
    // La tabla de los puntos de control, que crea la migración 0005.
    expect(
      await run.observe({ sourceLog: { ...run.stores.sourceLog, readLiveCheckpoint: missing } }),
    ).toEqual(incompatible('migrations_pending'));
  });

  it('si la clave del esquema de fuente tiene otros bytes, del mismo tamaño o menos, es source_schema_mismatch, también con el log vacío', async () => {
    const altered = Uint8Array.from(SOURCE_SCHEMA);
    altered[altered.length - 2] = 0x20;
    for (const schema of [altered, SOURCE_SCHEMA.subarray(0, 10)]) {
      for (const events of [[], stoppedBeforeRecoveryEvents()]) {
        const run = await observeHarness({ events, schema });
        expect(sha256Hex(schema)).not.toBe(
          FIXTURE.expected.entries_sha256['ticks_response.schema.json'],
        );
        expect(await run.observe()).toEqual(incompatible('source_schema_mismatch'));
      }
    }
  });

  it('si la clave del esquema de fuente tiene más bytes que cualquier entrada de esquemas, es source_schema_mismatch sin leerlos', async () => {
    const run = await observeHarness({ schema: new Uint8Array(SCHEMA_ENTRY_MAX_BYTES + 1) });
    expect(await run.observe()).toEqual(incompatible('source_schema_mismatch'));
  });

  it('un log cuyo contenido no pasa sus comprobaciones (LogIntegrityError) es log_not_derivable, en el segmento abierto o en uno cerrado', async () => {
    // Un objeto que el índice confirmó y ya no está, en el segmento abierto.
    const open = await observeHarness();
    const [row] = open.sourceLog.rows;
    if (row === undefined) {
      throw new TypeError('Falta la fila.');
    }
    open.objects.objects.delete(contentKey(row.object_sha256));
    expect(await open.observe()).toEqual(incompatible('log_not_derivable'));

    // Un segmento cerrado alterado.
    const closed = await observeHarness({ closedEvents: [3] });
    const [segment] = closed.sourceLog.closed;
    if (segment === undefined) {
      throw new TypeError('Falta el segmento.');
    }
    closed.objects.onRead = (key, bytes) =>
      key === contentKey(segment.object_bytes_sha256) ? bytes.subarray(1) : bytes;
    expect(await closed.observe()).toEqual(incompatible('log_not_derivable'));
  });
});

describe('observeDataHealth: almacenamiento que no responde (ADR-0015 §8, regla 3)', () => {
  const failures: readonly [string, (stores: HealthStores) => Partial<HealthStores>][] = [
    ['las migraciones', () => ({ pendingMigrations: () => Promise.reject(unavailable()) })],
    ['el escritor vivo en pg_locks', () => ({ lockHolder: () => Promise.reject(unavailable()) })],
    [
      'el último latido',
      (stores) => ({
        ingestionStatus: {
          ...stores.ingestionStatus,
          latestHeartbeat: () => Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'los cursores',
      (stores) => ({
        ingestionStatus: {
          ...stores.ingestionStatus,
          cursorSymbols: () => Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'el último cursor del símbolo',
      (stores) => ({
        ingestionStatus: {
          ...stores.ingestionStatus,
          latestCursor: () => Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'el índice del log',
      (stores) => ({
        sourceLog: { ...stores.sourceLog, readLogState: () => Promise.reject(unavailable()) },
      }),
    ],
    [
      'los puntos de control del estado vivo',
      (stores) => ({
        sourceLog: {
          ...stores.sourceLog,
          readLiveCheckpoint: () => Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'los segmentos cerrados',
      (stores) => ({
        sourceLog: {
          ...stores.sourceLog,
          listClosedSegments: () => Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'el evento del último cursor en el índice',
      (stores) => ({
        ingestionStatus: {
          ...stores.ingestionStatus,
          latestCursor: () =>
            Promise.resolve({
              cursor: cursorOf(DERIV_SOURCE, { last_durable_source_event_id: uuid(9104) }),
              version: 1,
            }),
        },
        sourceLog: { ...stores.sourceLog, hasSourceEvent: () => Promise.reject(unavailable()) },
      }),
    ],
    [
      'un objeto del log',
      (stores) => ({
        objects: {
          bucket: stores.objects.bucket,
          get: (key, maxBytes) =>
            key === SCHEMA_KEY ? stores.objects.get(key, maxBytes) : Promise.reject(unavailable()),
        },
      }),
    ],
    [
      'el esquema de fuente guardado',
      (stores) => ({
        objects: {
          bucket: stores.objects.bucket,
          get: (key, maxBytes) =>
            key === SCHEMA_KEY ? Promise.reject(unavailable()) : stores.objects.get(key, maxBytes),
        },
      }),
    ],
    [
      'el registro operativo',
      () => ({ operational: { load: () => Promise.reject(unavailable()) } }),
    ],
    [
      'el último dataset',
      () => ({ datasets: { lastActiveDatasetId: () => Promise.reject(unavailable()) } }),
    ],
  ];

  it.each(failures)(
    'si no responde al leer %s, da storage_unavailable con el código del error, nunca su mensaje',
    async (_label, failing) => {
      const run = await observeHarness({ closedEvents: [3] });
      const observation = await run.observe(failing(run.stores));
      expect(observation).toEqual({
        reason: 'ECONNREFUSED',
        source: DERIV_SOURCE,
        status: 'storage_unavailable',
      });
      expect(JSON.stringify(observation)).not.toMatch(/10\.0\.0\.9|rol_sintetico|base_sintetica/u);
    },
  );

  it('un error sin código da su nombre como motivo', async () => {
    const run = await observeHarness();
    const timeout = Object.assign(new Error('socket hang up 10.0.0.9'), { name: 'TimeoutError' });
    expect(await run.observe({ lockHolder: () => Promise.reject(timeout) })).toEqual({
      reason: 'TimeoutError',
      source: DERIV_SOURCE,
      status: 'storage_unavailable',
    });
  });
});
