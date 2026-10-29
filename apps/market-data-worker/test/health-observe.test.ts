import { sha256Hex, type SourceEvent } from '@buoh/contracts';
import { deriveMarketData } from '@buoh/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDerivMeasurementProfile,
  createDerivMeasurementProfileFromSourceSchema,
  DERIV_SOURCE,
} from '../src/deriv/profile.js';
import { observeDataHealth, type HealthStores } from '../src/health/observe.js';
import { contentKey } from '../src/object-keys.js';
import { OperationalRegistry } from '../src/operational/registry.js';
import { SourceEventLog } from '../src/source-log/source-event-log.js';
import { syntheticSchemas, uuid } from './support/connection-harness.js';
import { syntheticSchemaArchive } from './support/deriv-fixtures.js';
import {
  MemoryIngestionStatusStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';
import { stoppedBeforeRecoveryEvents } from './support/recovery-harness.js';
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
  /** Cuántos eventos del log quedan en segmentos cerrados; el resto, en el abierto. */
  readonly closedEvents?: number;
  /** El log durable; por defecto, el de una ejecución que paró antes de recuperar el hueco. */
  readonly events?: readonly SourceEvent[];
  /** Las migraciones que le faltan al esquema; por defecto, ninguna. */
  readonly pending?: readonly string[];
  /** Los bytes guardados bajo la clave del esquema de fuente; `null`, ninguno. */
  readonly schema?: Uint8Array | null;
}

/**
 * Lo que observa `data:health` sobre almacenes en memoria: el log (`events`, con los primeros
 * `closedEvents` en un segmento cerrado), el esquema de fuente guardado, un cursor del símbolo, un
 * latido del escritor vivo, una condición abierta del registro operativo, el escritor vivo y el
 * último dataset. `timeline` anota cada lectura, en orden, y la hora de la observación.
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
    if (index === options.closedEvents) {
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
      listClosedSegments: (source, from, to) => {
        timeline.push(`listClosedSegments:${source}`);
        return sourceLog.listClosedSegments(source, from, to);
      },
      readLogState: (source) => {
        timeline.push(`readLogState:${source}`);
        return sourceLog.readLogState(source);
      },
    },
  };
  const nextId = () => uuid(7001);
  const observe = (overrides: Partial<HealthStores> = {}) =>
    observeDataHealth({
      environment: 'test',
      expected: FIXTURE.expected,
      nextId,
      now: () => {
        timeline.push('now');
        return NOW;
      },
      stores: { ...stores, ...overrides },
      symbol: SYMBOL,
    });
  /** Lo que guardan los almacenes, para comprobar que la observación no escribe nada. */
  const contents = () =>
    structuredClone({
      closed: sourceLog.closed,
      conditions: operational.conditions,
      cursors: status.cursors,
      heartbeats: status.heartbeats,
      incidents: operational.incidents,
      objects: [...objects.objects.entries()],
      rows: sourceLog.rows,
    });
  return { contents, events, heartbeat, nextId, objects, observe, sourceLog, stores, timeline };
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
  it('lee el log durable por segmentos, el registro operativo, el último latido, los cursores, el escritor vivo y el último dataset de la fuente en el entorno', async () => {
    const run = await observeHarness({ closedEvents: 3 });
    const observation = await run.observe();

    expect(observation).toEqual({
      cursorSymbols: [SYMBOL],
      lastPublishedDatasetId: DATASET,
      latestHeartbeat: run.heartbeat,
      nextId: run.nextId,
      now: NOW,
      operationalConditionTypes: ['persistence_unavailable'],
      profile: expect.anything() as unknown,
      segments: [run.events.slice(0, 3), run.events.slice(3)],
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

  it('sin escritor vivo, sin latido ni cursores y con el log vacío, lo observado lo dice: null, null y listas vacías', async () => {
    const run = await observeHarness({ events: [] });
    const observation = await run.observe({
      datasets: { lastActiveDatasetId: () => Promise.resolve(null) },
      ingestionStatus: {
        cursorSymbols: () => Promise.resolve([]),
        latestHeartbeat: () => Promise.resolve(null),
      },
      lockHolder: () => Promise.resolve(null),
      operational: { load: () => Promise.resolve({ conditions: [], incidents: [] }) },
    });
    expect(observation).toMatchObject({
      cursorSymbols: [],
      lastPublishedDatasetId: null,
      latestHeartbeat: null,
      operationalConditionTypes: [],
      segments: [],
      status: 'observed',
      writerPid: null,
    });
  });

  it('sin esquema de fuente guardado, el perfil es null y la evaluación decide, con el log vacío o no', async () => {
    for (const events of [[], stoppedBeforeRecoveryEvents()]) {
      const run = await observeHarness({ events, schema: null });
      expect(await run.observe()).toMatchObject({ profile: null, status: 'observed' });
    }
  });

  it('no escribe nada en ningún almacén, aunque los que recibe sepan escribir', async () => {
    const run = await observeHarness({ closedEvents: 3 });
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
        ingestionStatus: { cursorSymbols: missing, latestHeartbeat: missing },
      }),
    ).toEqual(incompatible('migrations_pending'));
    expect(
      await run.observe({
        sourceLog: { listClosedSegments: missing, readLogState: missing },
      }),
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
    const closed = await observeHarness({ closedEvents: 3 });
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
      'el índice del log',
      (stores) => ({
        sourceLog: { ...stores.sourceLog, readLogState: () => Promise.reject(unavailable()) },
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
      const run = await observeHarness({ closedEvents: 3 });
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
