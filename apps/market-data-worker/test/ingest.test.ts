import { connectionClosedSchema, connectionOpenedSchema, type SourceEvent } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  INGEST_RETENTION_MS,
  ingestCommand,
  lockedSourceLogStore,
  SourceEventLog,
  type IngestDependencies,
  type IngestStores,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { settle, START, START_EPOCH, uuid } from './support/connection-harness.js';
import {
  derivMessages,
  FakeDerivSocket,
  ManualClock,
  syntheticSchemaArchive,
} from './support/deriv-fixtures.js';
import {
  MemoryCatalogStore,
  MemoryIngestionStatusStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemoryRequestedResponseIncidentStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';
import { FakeLockProvider, type LockAnswer } from './support/session-harness.js';

// `ingest` (ADR-0015 §7) sin red ni servicios: almacenes en memoria, un bloqueo en memoria, sockets
// falsos, reloj y temporizador manuales, IDs secuenciales, `random` inyectado, esquemas sintéticos y
// señales falsas. Ninguna credencial ni ningún precio es real.

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
  vi.stubGlobal('WebSocket', function forbidden() {
    throw new Error('El WebSocket global no está permitido.');
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Las variables de una captura con su esquema y su bucket, con credenciales sintéticas. */
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
  BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
  BUOH_POSTGRES_SCHEMA: 'buoh_captura',
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
};
const SECRETS = ['contraseña-sintética', 'clave-sintética', 'secreto-sintético'];

/**
 * El log de una ejecución anterior cuyo primer evento es de `firstAt`: una conexión abierta entonces
 * y cerrada con un cierre pedido a las 09:59:30, sin suscribirse.
 */
function logSince(firstAt: string): SourceEvent[] {
  return [
    connectionOpenedSchema.parse({
      connection_id: uuid(9001),
      event_id: uuid(9002),
      kind: 'connection_opened',
      occurred_at_utc: firstAt,
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    }),
    connectionClosedSchema.parse({
      affected_symbols: [],
      closure_type: 'requested',
      connection_id: uuid(9001),
      event_id: uuid(9003),
      kind: 'connection_closed',
      occurred_at_utc: '2026-03-02T09:59:30.000Z',
      reason: 'requested',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    }),
  ];
}

interface IngestHarnessOptions {
  /** Source events que el log ya tiene, de ejecuciones anteriores. */
  readonly events?: readonly SourceEvent[];
  /** Respuestas de `acquire`, en orden (`LockAnswer`). */
  readonly locks?: readonly LockAnswer[];
  /** Las migraciones que le faltan al esquema; por defecto, ninguna. */
  readonly pending?: readonly string[];
  /** La lectura de las migraciones falla con este error. */
  readonly pendingError?: Error;
}

/**
 * Las dependencias de `ingestCommand` sobre almacenes en memoria. `timeline` anota en orden la
 * apertura y el cierre de los almacenes, cada `acquire`, cada `release` y cada `connect`.
 */
async function ingestHarness(options: IngestHarnessOptions = {}) {
  forbidAmbientEffects();
  const clock = new ManualClock(START);
  const fixture = syntheticSchemaArchive();
  const timeline: string[] = [];
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const sockets: FakeDerivSocket[] = [];
  const configs: WorkerConfig[] = [];
  let sequence = 0;
  const sourceLog = new MemorySourceLogStore();
  const objects = new MemoryObjectStore();
  const seed = await SourceEventLog.open({
    objects,
    source: DERIV_SOURCE,
    store: sourceLog,
    zlibVersion: 'test',
  });
  for (const event of options.events ?? []) {
    await seed.append(event);
  }
  const stores = {
    catalog: new MemoryCatalogStore(),
    close: () => {
      timeline.push('close');
      return Promise.resolve();
    },
    ingestionStatus: new MemoryIngestionStatusStore(),
    objects,
    operational: new MemoryOperationalStore(),
    pendingMigrations: () =>
      options.pendingError === undefined
        ? Promise.resolve(options.pending ?? [])
        : Promise.reject(options.pendingError),
    requestedResponses: new MemoryRequestedResponseIncidentStore(),
    sourceLog,
  } satisfies IngestStores;
  const provider = new FakeLockProvider(options.locks ?? [], timeline);
  const signal: { handler: (() => void) | null; listening: boolean } = {
    handler: null,
    listening: false,
  };
  const deps: IngestDependencies = {
    alert: (payload) => alerts.push(payload),
    connect: (input) => {
      const socket = new FakeDerivSocket(input);
      sockets.push(socket);
      timeline.push(`connect:${String(sockets.length)}`);
      return socket;
    },
    expected: fixture.expected,
    fetch: () => Promise.resolve(new Response(fixture.archive, { status: 200 })),
    lockProvider: (config) => {
      configs.push(config);
      return provider;
    },
    nextId: () => uuid((sequence += 1)),
    now: clock.now,
    openLog: (lock, input) =>
      SourceEventLog.open({
        ...input,
        store: lockedSourceLogStore(input.store, {
          get held() {
            return lock.held;
          },
          source: input.source,
        }),
      }),
    openStores: (config) => {
      configs.push(config);
      timeline.push('open');
      return stores;
    },
    random: () => 0,
    scheduler: clock.scheduler,
    schemaUrl: 'https://schemas.invalid/schemas.zip',
    signals: (handler) => {
      signal.handler = handler;
      signal.listening = true;
      return () => {
        signal.listening = false;
      };
    },
    zlibVersion: 'test',
  };
  /** El socket número `number`, desde 1; falla si no existe. */
  const socket = (number: number): FakeDerivSocket => {
    const found = sockets[number - 1];
    if (found === undefined) {
      throw new TypeError(`ingest no abrió el socket ${String(number)}.`);
    }
    return found;
  };
  /** Una señal de parada, como `SIGINT` o `SIGTERM`. */
  const raise = () => {
    if (signal.handler === null) {
      throw new TypeError('ingest no escucha las señales.');
    }
    signal.handler();
  };
  return {
    alerts,
    clock,
    configs,
    deps,
    fixture,
    raise,
    signal,
    socket,
    sockets,
    stores,
    timeline,
  };
}

/** Las peticiones `forget_all` que envió el socket. */
const forgetAll = (socket: FakeDerivSocket) =>
  socket.requests().filter((request) => 'forget_all' in request);

/**
 * Corre `ingestCommand` con `argv`, `env` y las dependencias del harness, y deja correr su arranque
 * sin esperar su fin: `command` es su promesa.
 */
async function start(
  run: Awaited<ReturnType<typeof ingestHarness>>,
  argv: readonly string[] = ['--live', '--symbol', 'SYNTH_100'],
  env: Readonly<Record<string, string | undefined>> = ENV,
) {
  const command = ingestCommand(argv, env, run.deps);
  // La descarga sintética lee su cuerpo en varios pasos, y antes se leen las migraciones.
  await settle();
  await settle();
  await settle();
  return { command };
}

describe('ingestCommand: argumentos y configuración', () => {
  it('sin --live da salida 2 y una línea UsageError, sin leer la configuración ni abrir nada', async () => {
    const run = await ingestHarness();
    const result = await ingestCommand([], {}, run.deps);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(run.timeline).toEqual([]);
    expect(run.configs).toEqual([]);
  });

  it('con variables inválidas o ausentes da salida 2 y una línea ConfigError que solo nombra las variables, sin abrir nada', async () => {
    const run = await ingestHarness();
    const result = await ingestCommand(
      ['--live'],
      { ...ENV, BUOH_S3_SECRET_ACCESS_KEY: undefined },
      run.deps,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.line)).toEqual({
      code: 'ConfigError',
      message: 'Configuración inválida o ausente: BUOH_S3_SECRET_ACCESS_KEY.',
      status: 'failed',
    });
    expect(run.timeline).toEqual([]);
  });

  it.each<[string, Readonly<Record<string, string | undefined>>, string[]]>([
    ['el esquema por defecto', { BUOH_POSTGRES_SCHEMA: undefined }, ['BUOH_POSTGRES_SCHEMA']],
    ['el bucket por defecto', { BUOH_S3_BUCKET: 'buoh-local' }, ['BUOH_S3_BUCKET']],
    [
      // Con el cifrado que exige loadConfig en un despliegue (ADR-0018 §9).
      'el entorno production',
      { BUOH_DEPLOYMENT_ENVIRONMENT: 'production', BUOH_POSTGRES_SSLMODE: 'require' },
      ['BUOH_DEPLOYMENT_ENVIRONMENT'],
    ],
  ])(
    'con %s da salida 2 y una línea IngestConfigError con las variables, sin abrir nada',
    async (_label, change, variables) => {
      const run = await ingestHarness();
      const result = await ingestCommand(['--live'], { ...ENV, ...change }, run.deps);

      expect(result.exitCode).toBe(2);
      const line = JSON.parse(result.line) as { code: string; message: string; status: string };
      expect(line).toMatchObject({ code: 'IngestConfigError', status: 'failed' });
      for (const variable of variables) {
        expect(line.message).toContain(variable);
      }
      for (const secret of SECRETS) {
        expect(result.line).not.toContain(secret);
      }
      expect(run.timeline).toEqual([]);
    },
  );
});

describe('ingestCommand: migraciones', () => {
  it('si al esquema le falta la migración 0004, no arranca: salida 2 y «aplica las migraciones con db:migrate», sin tomar el bloqueo ni aplicar nada, y cierra los almacenes', async () => {
    const run = await ingestHarness({ pending: ['0004_cursor_y_latido.sql'] });
    const result = await ingestCommand(['--live'], ENV, run.deps);

    expect(result.exitCode).toBe(2);
    const line = JSON.parse(result.line) as Record<string, unknown>;
    expect(line).toEqual({
      code: 'MIGRATIONS_PENDING',
      message: expect.stringContaining('aplica las migraciones con db:migrate') as unknown,
      pending: ['0004_cursor_y_latido.sql'],
      status: 'failed',
    });
    expect(run.timeline).toEqual(['open', 'close']);
    expect(run.sockets).toEqual([]);
  });

  it('si PostgreSQL no responde al leer las migraciones, da salida 1 con STORAGE_UNAVAILABLE y el motivo saneado, y cierra los almacenes', async () => {
    const run = await ingestHarness({
      pendingError: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
        code: 'ECONNREFUSED',
      }),
    });
    const result = await ingestCommand(['--live'], ENV, run.deps);

    expect(result).toEqual({
      exitCode: 1,
      line: JSON.stringify({
        code: 'STORAGE_UNAVAILABLE',
        message: 'PostgreSQL no respondió al leer las migraciones del esquema.',
        reason: 'ECONNREFUSED',
        status: 'failed',
      }),
    });
    expect(run.timeline).toEqual(['open', 'close']);
  });
});

describe('ingestCommand: la captura', () => {
  it('corre la sesión con sus almacenes, el bloqueo y el log protegido; guarda el esquema de fuente; para con la primera señal; y da una línea JSON sin precios, con salida 0', async () => {
    const run = await ingestHarness();
    const { command } = await start(run);
    expect(run.timeline).toEqual(['open', 'acquire:1', 'connect:1']);
    // El esquema y el bucket de la configuración.
    expect(run.configs.map((config) => [config.postgres.schema, config.s3.bucket])).toEqual([
      ['buoh_captura', 'buoh-captura'],
      ['buoh_captura', 'buoh-captura'],
    ]);
    const schemaKey = contentKey(run.fixture.expected.entries_sha256['ticks_response.schema.json']);
    expect(run.stores.objects.objects.get(schemaKey)).toEqual(
      run.fixture.entries['ticks_response.schema.json'],
    );
    run.socket(1).open();
    await settle();
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await settle();
    // Dos señales seguidas, como un Ctrl+C que llega también reenviado: una sola parada, y el
    // proceso sigue escuchando hasta el final.
    run.raise();
    run.raise();
    expect(forgetAll(run.socket(1))).toEqual([{ forget_all: 'ticks', req_id: 3 }]);
    expect(run.signal.listening).toBe(true);
    run.socket(1).text(derivMessages.forgetAll(3));

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('100.25');
    // IDs: 1 la ejecución, 2 y 3 los latidos de arranque y del intento, 4 la conexión.
    expect(JSON.parse(line)).toEqual({
      connections: [
        {
          closure: { closure_type: 'requested', persisted: true, reason: 'requested' },
          connection_id: uuid(4),
          end: { status: 'completed' },
        },
      ],
      connector_version: 'deriv-options-ws-1.1.0',
      end: { status: 'completed' },
      finished_at_utc: START,
      recoveries: [],
      schemas: {
        archive_sha256: run.fixture.expected.archive_sha256,
        release: 'synthetic-deriv-1',
      },
      source: DERIV_SOURCE,
      started_at_utc: START,
      status: 'completed',
      stopped_for_retention: false,
      symbol: 'SYNTH_100',
      waits_ms: [],
    });
    expect(run.signal.listening).toBe(false);
    expect(run.timeline).toEqual(['open', 'acquire:1', 'connect:1', 'release:1', 'close']);
    // El cursor del cierre pedido y el del final, y los latidos de la ejecución con el PID.
    expect(run.stores.ingestionStatus.cursors.map((item) => item.version)).toEqual([1, 2]);
    expect(
      run.stores.ingestionStatus.heartbeats.map((item) => [item.connection_state, item.run_id]),
    ).toEqual([
      ['connecting', uuid(1)],
      ['connecting', uuid(1)],
      ['connected', uuid(1)],
      ['disconnected', uuid(1)],
    ]);
    expect(run.stores.sourceLog.closed.map((segment) => segment.close_reason)).toEqual([
      'requested',
    ]);
    // El punto de control del segmento que cerró la parada, con el log protegido (ADR-0017 §5).
    expect(
      run.stores.sourceLog.checkpoints.map((row) => [row.segment_index, row.event_count]),
    ).toEqual([[0, 5]]);
    expect(run.alerts).toEqual([]);
  });

  it('pasa 23 horas de retención: con el evento más antiguo del log de hace 23 horas, no arranca, con retention_expired y salida 1', async () => {
    expect(INGEST_RETENTION_MS).toBe(82_800_000);
    const run = await ingestHarness({ events: logSince('2026-03-01T11:00:00.000Z') });
    const { exitCode, line } = await (await start(run)).command;

    expect(exitCode).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: null, reason: 'retention_expired', status: 'failed' },
      status: 'failed',
      stopped_for_retention: false,
    });
    expect(run.timeline).toEqual(['open', 'acquire:1', 'release:1', 'close']);
  });

  it('pasa 23 horas de retención: con el evento más antiguo de hace 23 horas menos 1 ms, conecta y para sola al cumplirlas', async () => {
    const run = await ingestHarness({ events: logSince('2026-03-01T11:00:00.001Z') });
    const { command } = await start(run);
    expect(run.timeline).toEqual(['open', 'acquire:1', 'connect:1']);
    await run.clock.advance(1);

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({
      end: { status: 'completed' },
      status: 'completed',
      stopped_for_retention: true,
    });
  });

  it('si otro proceso tiene el bloqueo, la sesión termina failed con source_lock_taken: salida 1', async () => {
    const run = await ingestHarness({ locks: ['taken'] });
    const { exitCode, line } = await (await start(run)).command;

    expect(exitCode).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: null, reason: 'source_lock_taken', status: 'failed' },
      status: 'failed',
    });
    expect(run.timeline).toEqual(['open', 'acquire:taken', 'close']);
  });

  it('un símbolo que el esquema de la petición ticks no admite es un error de uso: salida 2, sin tomar el bloqueo', async () => {
    const run = await ingestHarness();
    const { exitCode, line } = await (await start(run, ['--live', '--symbol', 'R'])).command;

    expect(exitCode).toBe(2);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: 'ticks', reason: 'request_invalid', status: 'failed' },
      symbol: 'R',
    });
    expect(run.timeline).toEqual(['open', 'close']);
  });

  it('una recuperación de historia sale con su estado, su motivo, sus intentos, sus páginas y lo recuperado, sin horas ni precios', async () => {
    const run = await ingestHarness();
    const { command } = await start(run);
    run.socket(1).open();
    await settle();
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await settle();
    // El servidor cierra: la sesión espera 500 ms y reconecta.
    run.socket(1).emit({ code: 1001, kind: 'closed' });
    await settle();
    await run.clock.advance(500);
    run.socket(2).open();
    await settle();
    run.socket(2).text(derivMessages.catalog(1));
    await settle();
    // El primer tick posterior al cierre: 2000 ms después pide la historia del hueco.
    run.socket(2).text(derivMessages.tick(2, START_EPOCH + 4, '100.75'));
    await settle();
    await run.clock.advance(2000);
    const page = run
      .socket(2)
      .requests()
      .find((request) => 'ticks_history' in request);
    expect(page).toMatchObject({ end: String(START_EPOCH + 4), start: START_EPOCH });
    run
      .socket(2)
      .text(
        derivMessages.history(
          3,
          [START_EPOCH, START_EPOCH + 2, START_EPOCH + 4],
          ['100.25', '100.5', '100.75'],
        ),
      );
    await settle();
    run.raise();
    run.socket(2).text(derivMessages.forgetAll(4));

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({
      recoveries: [
        {
          attempts: 1,
          durable: true,
          pages: 1,
          reason: null,
          recovered_event_count: 1,
          status: 'complete',
        },
      ],
      waits_ms: [500],
    });
    for (const quote of ['100.25', '100.5', '100.75']) {
      expect(line).not.toContain(quote);
    }
  });

  it('un error inesperado da code UNEXPECTED y salida 1, y cierra los almacenes', async () => {
    const run = await ingestHarness();
    const result = await ingestCommand(['--live'], ENV, {
      ...run.deps,
      now: () => {
        throw new RangeError('reloj roto');
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      line: '{"code":"UNEXPECTED","message":"RangeError","status":"failed"}',
    });
    expect(run.timeline.at(-1)).toBe('close');
  });
});
