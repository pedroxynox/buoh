import { connectionClosedSchema, connectionOpenedSchema, type SourceEvent } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  INGEST_RETENTION_MS,
  ingestCommand,
  lockedSourceLogStore,
  LOG_CUT_CHECK_MS,
  LOG_CUT_FORCE_AFTER_MS,
  logLocation,
  SourceEventLog,
  STARTUP_RETRY_MS,
  WAIT_STOPPED,
  type IngestDependencies,
  type IngestStores,
  type LogLocation,
  type LogQualityProfileRow,
  type OperationalAlert,
  type WorkerConfig,
} from '../src/index.js';
import { derivLogProfileRow } from '../src/deriv/log-profile.js';
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

/**
 * Lo que ven las lecturas de la espera del arranque en `production` (ADR-0018 §4): el log activo,
 * las migraciones que le faltan y el cierre de sus conexiones. La prueba lo cambia mientras espera.
 */
interface StartupState {
  closing: Promise<void>;
  /** La primera escritura de cada log, por número; sin ella, ninguna (ADR-0018 §6). */
  firstWrites: Map<number, string>;
  locate: LogLocation | null | Error;
  pending: readonly string[];
  /** Los logs preparados para el corte, por número (ADR-0018 §6). */
  prepared: Set<number>;
  /** La fila de `log_quality_profile` de cada log, por número; sin ella, ninguna (ADR-0020 §4). */
  profiles: Map<number, LogQualityProfileRow>;
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
  /** Fuera de `production`, la fila de `log_quality_profile` del esquema, o el error al leerla. */
  readonly profile?: LogQualityProfileRow | Error;
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
  /** Los almacenes en memoria de un log: el log, sus objetos y lo demás. */
  const memoryStores = (logStore: MemorySourceLogStore, logObjects: MemoryObjectStore) =>
    ({
      catalog: new MemoryCatalogStore(),
      close: () => {
        timeline.push('close');
        return Promise.resolve();
      },
      ingestionStatus: new MemoryIngestionStatusStore(),
      objects: logObjects,
      operational: new MemoryOperationalStore(),
      pendingMigrations: () =>
        options.pendingError === undefined
          ? Promise.resolve(options.pending ?? [])
          : Promise.reject(options.pendingError),
      logProfile: () => {
        timeline.push('profile');
        return options.profile instanceof Error
          ? Promise.reject(options.profile)
          : Promise.resolve(options.profile ?? null);
      },
      requestedResponses: new MemoryRequestedResponseIncidentStore(),
      sourceLog: logStore,
    }) satisfies IngestStores;
  const stores = memoryStores(sourceLog, objects);
  /**
   * Los almacenes de cada esquema: los del primero que se abre son `stores`, y los de cada esquema
   * siguiente, como el del log siguiente tras un corte (ADR-0018 §6), otros vacíos.
   */
  const byLog = new Map<string, typeof stores>();
  const storesOf = (schema: string): typeof stores => {
    const found = byLog.get(schema);
    if (found === undefined) {
      throw new TypeError(`ingest no abrió los almacenes de ${schema}.`);
    }
    return found;
  };
  const provider = new FakeLockProvider(options.locks ?? [], timeline);
  const signal: { handler: (() => void) | null; listening: boolean } = {
    handler: null,
    listening: false,
  };
  // En production, el log 2 está preparado y tiene todas sus migraciones.
  const startup: StartupState = {
    closing: Promise.resolve(),
    firstWrites: new Map(),
    locate: logLocation(2),
    pending: [],
    prepared: new Set(),
    profiles: new Map(),
  };
  /** Los logs cuyo perfil leyó la espera del arranque, en orden. Aparte de `timeline`. */
  const profileReads: number[] = [];
  /** Las lecturas del corte, en orden: `first:<log>` y `prepared:<log>`. */
  const cutReads: string[] = [];
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
    openStartupReads: (config) => {
      configs.push(config);
      timeline.push('reads');
      return {
        close: () => {
          timeline.push('reads:close');
          return startup.closing;
        },
        firstWrite: (log) => {
          cutReads.push(`first:${String(log.number)}`);
          return Promise.resolve(startup.firstWrites.get(log.number) ?? null);
        },
        readiness: (log) => {
          cutReads.push(`prepared:${String(log.number)}`);
          return Promise.resolve(startup.prepared.has(log.number) ? 'ready' : 'not_prepared');
        },
        locateLog: () => {
          timeline.push('locate');
          return startup.locate instanceof Error
            ? Promise.reject(startup.locate)
            : Promise.resolve(startup.locate);
        },
        pendingMigrations: (log) => {
          timeline.push(`pending:${log.schema}`);
          return Promise.resolve(startup.pending);
        },
        logProfile: (log) => {
          profileReads.push(log.number);
          return Promise.resolve(startup.profiles.get(log.number) ?? null);
        },
      };
    },
    openStores: (config) => {
      configs.push(config);
      timeline.push('open');
      const { schema } = config.postgres;
      let chosen = byLog.get(schema);
      if (chosen === undefined) {
        chosen =
          byLog.size === 0
            ? stores
            : memoryStores(new MemorySourceLogStore(), new MemoryObjectStore());
        byLog.set(schema, chosen);
      }
      return chosen;
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
    cutReads,
    deps,
    fixture,
    profileReads,
    provider,
    raise,
    signal,
    socket,
    sockets,
    startup,
    stores,
    storesOf,
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
  deps: IngestDependencies = run.deps,
) {
  const command = ingestCommand(argv, env, deps);
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
      'el entorno staging',
      { BUOH_DEPLOYMENT_ENVIRONMENT: 'staging', BUOH_POSTGRES_SSLMODE: 'require' },
      ['BUOH_DEPLOYMENT_ENVIRONMENT'],
    ],
    [
      // En production, el esquema sale del log activo (ADR-0018 §4).
      'BUOH_POSTGRES_SCHEMA en production',
      { BUOH_DEPLOYMENT_ENVIRONMENT: 'production', BUOH_POSTGRES_SSLMODE: 'require' },
      ['BUOH_POSTGRES_SCHEMA'],
    ],
    [
      'el bucket por defecto en production',
      {
        BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
        BUOH_POSTGRES_SCHEMA: undefined,
        BUOH_POSTGRES_SSLMODE: 'require',
        BUOH_S3_BUCKET: undefined,
      },
      ['BUOH_S3_BUCKET'],
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

describe('ingestCommand: el perfil del log (ADR-0020 §4)', () => {
  // Un perfil de publicación que el código no arma para SYNTH_100, que no tiene umbrales medidos: la
  // sesión lo recibe y falla cerrado antes de conectar.
  const unknownForSymbol = derivLogProfileRow('R_100');

  it('fuera de production, lee el perfil del esquema después de las migraciones y la sesión lo usa', async () => {
    const run = await ingestHarness({ profile: unknownForSymbol });
    const { exitCode, line } = await (await start(run)).command;
    expect(exitCode).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: 'LogProfileUnknownError', reason: 'log_not_derivable', status: 'failed' },
      quality_profile_id: null,
    });
    expect(run.timeline).toEqual(['open', 'profile', 'close']);
    expect(run.sockets).toEqual([]);
  });

  it('fuera de production, si PostgreSQL no responde al leer el perfil, salida 1 con STORAGE_UNAVAILABLE y el motivo saneado', async () => {
    const run = await ingestHarness({
      profile: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
        code: 'ECONNREFUSED',
      }),
    });
    const result = await ingestCommand(['--live'], ENV, run.deps);
    expect(result).toEqual({
      exitCode: 1,
      line: JSON.stringify({
        code: 'STORAGE_UNAVAILABLE',
        message: 'PostgreSQL no respondió al leer el perfil del log.',
        reason: 'ECONNREFUSED',
        status: 'failed',
      }),
    });
    expect(run.timeline).toEqual(['open', 'profile', 'close']);
  });

  it('en production, la sesión usa el perfil que leyó la espera del arranque para ese log', async () => {
    const run = await ingestHarness();
    run.startup.profiles.set(2, unknownForSymbol);
    const { exitCode, line } = await (await startProduction(run)).command;
    expect(run.profileReads).toEqual([2]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: 'LogProfileUnknownError', reason: 'log_not_derivable', status: 'failed' },
    });
    expect(run.sockets).toEqual([]);
  });
});

describe('ingestCommand: la captura', () => {
  it('corre la sesión con sus almacenes, el bloqueo y el log protegido; guarda el esquema de fuente; para con la primera señal; y da una línea JSON sin precios, con salida 0', async () => {
    const run = await ingestHarness();
    const { command } = await start(run);
    expect(run.timeline).toEqual(['open', 'profile', 'acquire:1', 'connect:1']);
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
      quality_profile_id: 'deriv_options-measurement-v2-SYNTH_100',
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
    expect(run.timeline).toEqual([
      'open',
      'profile',
      'acquire:1',
      'connect:1',
      'release:1',
      'close',
    ]);
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
    expect(run.timeline).toEqual(['open', 'profile', 'acquire:1', 'release:1', 'close']);
  });

  it('pasa 23 horas de retención: con el evento más antiguo de hace 23 horas menos 1 ms, conecta y para sola al cumplirlas', async () => {
    const run = await ingestHarness({ events: logSince('2026-03-01T11:00:00.001Z') });
    const { command } = await start(run);
    expect(run.timeline).toEqual(['open', 'profile', 'acquire:1', 'connect:1']);
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
    expect(run.timeline).toEqual(['open', 'profile', 'acquire:taken', 'close']);
  });

  it('un símbolo que el esquema de la petición ticks no admite es un error de uso: salida 2, sin tomar el bloqueo', async () => {
    const run = await ingestHarness();
    const { exitCode, line } = await (await start(run, ['--live', '--symbol', 'R'])).command;

    expect(exitCode).toBe(2);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: 'ticks', reason: 'request_invalid', status: 'failed' },
      symbol: 'R',
    });
    expect(run.timeline).toEqual(['open', 'profile', 'close']);
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

/**
 * Las variables de `production` (ADR-0018 §4): con el cifrado que exige loadConfig (§9), el bucket
 * de la captura y sin `BUOH_POSTGRES_SCHEMA`.
 */
const PRODUCTION_ENV = {
  ...ENV,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
};

/** Corre `ingestCommand` en production y deja correr la espera y el arranque de la sesión. */
async function startProduction(run: Awaited<ReturnType<typeof ingestHarness>>) {
  const started = await start(run, undefined, PRODUCTION_ENV);
  await settle();
  await settle();
  return started;
}

/** Una conexión que se suscribe y recibe un tick, y después la parada pedida. */
async function captureAndStop(run: Awaited<ReturnType<typeof ingestHarness>>) {
  run.socket(1).open();
  await settle();
  run.socket(1).text(derivMessages.catalog(1));
  await settle();
  run.socket(1).text(derivMessages.tick(2, START_EPOCH, '100.25'));
  await settle();
  run.raise();
  run.socket(1).text(derivMessages.forgetAll(3));
}

describe('ingestCommand en production (ADR-0018 §4)', () => {
  it('con el log activo preparado y el bloqueo libre, captura en el esquema y el prefijo de ese log con el bloqueo que tomó la espera, sin pedir otro', async () => {
    const run = await ingestHarness();
    const { command } = await startProduction(run);
    // Las lecturas siguen abiertas durante la captura: el corte las usa (ADR-0018 §6).
    expect(run.timeline).toEqual([
      'reads',
      'locate',
      'pending:buoh_log_000002',
      'acquire:1',
      'locate',
      'open',
      'connect:1',
    ]);
    // El bloqueo y la espera, con la configuración; los almacenes, con la del log 2.
    expect(
      run.configs.map((config) => [config.postgres.schema, config.s3.keyPrefix, config.s3.bucket]),
    ).toEqual([
      ['public', '', 'buoh-captura'],
      ['public', '', 'buoh-captura'],
      ['buoh_log_000002', 'logs/000002/', 'buoh-captura'],
    ]);
    await captureAndStop(run);

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({
      end: { status: 'completed' },
      status: 'completed',
      stopped_for_retention: false,
    });
    expect(run.timeline.slice(-4)).toEqual(['connect:1', 'release:1', 'close', 'reads:close']);
    // Los latidos de la sesión llevan el PID del bloqueo de la espera.
    expect(
      new Set(run.stores.ingestionStatus.heartbeats.map((item) => item.pg_backend_pid)),
    ).toEqual(new Set([run.provider.lock(1).backendPid]));
    expect(run.alerts).toEqual([]);
  });

  it('no comprueba retention_expired: con el evento más antiguo del log de hace 23 horas, conecta', async () => {
    const run = await ingestHarness({ events: logSince('2026-03-01T11:00:00.000Z') });
    const { command } = await startProduction(run);
    expect(run.timeline.at(-1)).toBe('connect:1');
    await captureAndStop(run);

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ status: 'completed', stopped_for_retention: false });
  });

  it('no para a las 23 horas: con el evento más antiguo de hace 23 horas menos 1 ms, sigue capturando al cumplirlas', async () => {
    const run = await ingestHarness({ events: logSince('2026-03-01T11:00:00.001Z') });
    const { command } = await startProduction(run);
    expect(run.timeline.at(-1)).toBe('connect:1');
    await run.clock.advance(1);
    await settle();
    expect(forgetAll(run.socket(1))).toEqual([]);
    await captureAndStop(run);

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ status: 'completed', stopped_for_retention: false });
  });

  it('sin log preparado, espera sin abrir los almacenes ni escribir nada, con la alerta ingest_waiting; a los 30 s vuelve a mirar y, con el log, captura en él', async () => {
    const run = await ingestHarness();
    run.startup.locate = null;
    const { command } = await startProduction(run);
    expect(run.timeline).toEqual(['reads', 'locate']);
    expect(run.alerts).toEqual([
      { detail: null, event: 'ingest_waiting', reason: 'log_not_prepared' },
    ]);
    expect(run.clock.pendingDelays()).toEqual([STARTUP_RETRY_MS]);
    expect(run.stores.objects.objects.size).toBe(0);
    expect(run.stores.ingestionStatus.heartbeats).toEqual([]);

    run.startup.locate = logLocation(1);
    await run.clock.advance(STARTUP_RETRY_MS - 1);
    expect(run.timeline).toEqual(['reads', 'locate']);
    await run.clock.advance(1);
    await settle();
    await settle();
    expect(run.timeline).toEqual([
      'reads',
      'locate',
      'locate',
      'pending:buoh_log_000001',
      'acquire:1',
      'locate',
      'open',
      'connect:1',
    ]);
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000001');
    await captureAndStop(run);
    expect((await command).exitCode).toBe(0);
  });

  it('una señal durante la espera la para: salida 0, status stopped con WAIT_STOPPED y el motivo, sin abrir los almacenes ni tomar el bloqueo', async () => {
    const run = await ingestHarness();
    run.startup.locate = null;
    const { command } = await startProduction(run);
    run.raise();

    expect(await command).toEqual({
      exitCode: 0,
      line: JSON.stringify({ code: WAIT_STOPPED, status: 'stopped', waiting: 'log_not_prepared' }),
    });
    expect(run.timeline).toEqual(['reads', 'locate', 'reads:close']);
    expect(run.clock.pendingDelays()).toEqual([]);
    expect(run.signal.listening).toBe(false);
  });

  it('una señal entre la espera y la sesión no se pierde: la sesión para sin conectar y el bloqueo de la espera se suelta', async () => {
    const run = await ingestHarness();
    // La señal llega al abrir los almacenes, después de la espera y antes de la sesión.
    const open = run.deps.openStores;
    const { command } = await start(run, undefined, PRODUCTION_ENV, {
      ...run.deps,
      openStores: (config) => {
        run.raise();
        return open(config);
      },
    });

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    expect(JSON.parse(line)).toMatchObject({ connections: [], status: 'completed' });
    expect(run.timeline).toEqual([
      'reads',
      'locate',
      'pending:buoh_log_000002',
      'acquire:1',
      'locate',
      'open',
      'close',
      'release:1',
      'reads:close',
    ]);
    expect(run.sockets).toEqual([]);
  });

  it('si pierde el bloqueo mientras captura y lo tiene otro proceso, termina failed con source_lock_taken: salida 1', async () => {
    const run = await ingestHarness({ locks: ['lock', 'taken'] });
    const { command } = await startProduction(run);
    run.socket(1).open();
    await settle();
    run.socket(1).text(derivMessages.catalog(1));
    await settle();
    run.provider.lock(1).lose();
    run.socket(1).text(derivMessages.tick(2, START_EPOCH, '100.25'));
    await settle();
    await run.clock.advance(500);

    const { exitCode, line } = await command;
    expect(exitCode).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      end: { detail: null, reason: 'source_lock_taken', status: 'failed' },
      status: 'failed',
    });
    expect(run.timeline.slice(-5)).toEqual([
      'connect:1',
      'release:1',
      'acquire:taken',
      'close',
      'reads:close',
    ]);
  });

  it('sin BUOH_POSTGRES_SSLMODE, ConfigError con salida 2 que la nombra, sin abrir nada', async () => {
    const run = await ingestHarness();
    const result = await ingestCommand(
      ['--live'],
      { ...PRODUCTION_ENV, BUOH_POSTGRES_SSLMODE: undefined },
      run.deps,
    );

    expect(result).toEqual({
      exitCode: 2,
      line: JSON.stringify({
        code: 'ConfigError',
        message: 'Configuración inválida o ausente: BUOH_POSTGRES_SSLMODE.',
        status: 'failed',
      }),
    });
    expect(run.timeline).toEqual([]);
  });
});

/** Los source events de los almacenes de un log, en orden, leídos de sus objetos. */
function eventsOf(stores: {
  readonly objects: MemoryObjectStore;
  readonly sourceLog: MemorySourceLogStore;
}): SourceEvent[] {
  return stores.sourceLog.rows.map((row) => {
    const bytes = stores.objects.objects.get(contentKey(row.object_sha256));
    if (bytes === undefined) {
      throw new TypeError('Falta el objeto de un evento.');
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as SourceEvent;
  });
}

/** Responde a la petición `forget_all` que envió el socket. */
function answerForgetAll(socket: FakeDerivSocket): void {
  const request = forgetAll(socket).at(-1) as { req_id?: number } | undefined;
  if (request?.req_id === undefined) {
    throw new TypeError('El socket no envió forget_all.');
  }
  socket.text(derivMessages.forgetAll(request.req_id));
}

/** El epoch de Deriv de la hora del reloj de pared del harness, en segundos enteros. */
const epochNow = (run: Awaited<ReturnType<typeof ingestHarness>>): number =>
  Math.floor(Date.parse(run.clock.now()) / 1000);

/**
 * Deja correr lo asíncrono entre dos sesiones: el fin de la sesión del log cortado, la espera del log
 * siguiente, la descarga sintética de los esquemas y el arranque de la sesión nueva.
 */
async function settleHandover(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await settle();
  }
}

/** Abre la conexión `number`, recibe el catálogo y un tick con la hora del reloj. */
async function subscribe(run: Awaited<ReturnType<typeof ingestHarness>>, number: number) {
  run.socket(number).open();
  await settle();
  run.socket(number).text(derivMessages.catalog(1));
  await settle();
  run.socket(number).text(derivMessages.tick(2, epochNow(run), '100.25'));
  await settle();
}

/** La hora de corte de un log escrito por primera vez en `START`, un lunes: el lunes siguiente. */
const CUT_TIME = '2026-03-09T00:00:00.000Z';

describe('ingestCommand en production: el corte semanal (ADR-0018 §6)', () => {
  it('a su hora de corte, con el log limpio y el siguiente preparado, corta como una parada y sigue en el siguiente con el mismo bloqueo, sin soltarlo', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    const { command } = await startProduction(run);
    await subscribe(run, 1);
    // El primer paso del corte lee la primera escritura del log 2; el siguiente, 30 s después, cae
    // justo en la hora de corte.
    await run.clock.advance(0);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(run.clock.now()) - LOG_CUT_CHECK_MS);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.alerts).toEqual([{ event: 'log_cut', forced: 'false', log: '2', next: '3' }]);
    // Dos lecturas de la primera escritura en la espera, antes y después de tomar el bloqueo, y una
    // de la vigilancia del corte, que después ya no la vuelve a leer.
    expect(run.cutReads).toEqual(['first:2', 'first:2', 'first:2', 'prepared:3']);
    // La parada pedida de la sesión del log 2.
    answerForgetAll(run.socket(1));
    await settleHandover();
    expect(run.sockets).toHaveLength(2);

    // El log 2 terminó con un cierre pedido y su segmento cerrado.
    const log2 = run.storesOf('buoh_log_000002');
    expect(eventsOf(log2).at(-1)).toMatchObject({
      closure_type: 'requested',
      kind: 'connection_closed',
    });
    expect(log2.sourceLog.closed.at(-1)?.close_reason).toBe('requested');
    // El log 3: el esquema de fuente guardado y una primera conexión sin anterior.
    const log3 = run.storesOf('buoh_log_000003');
    const schemaKey = contentKey(run.fixture.expected.entries_sha256['ticks_response.schema.json']);
    expect(log3.objects.objects.get(schemaKey)).toEqual(
      run.fixture.entries['ticks_response.schema.json'],
    );
    await subscribe(run, 2);
    expect(eventsOf(log3)[0]).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: null,
    });
    expect(log3.catalog).not.toBe(log2.catalog);
    run.raise();
    answerForgetAll(run.socket(2));

    const { exitCode, line } = await command;
    expect(exitCode).toBe(0);
    // La línea es la de la última sesión: la del log 3.
    expect(JSON.parse(line)).toMatchObject({
      connections: [{ closure: { closure_type: 'requested' } }],
      status: 'completed',
    });
    // Un solo bloqueo, que pasó de una sesión a la otra sin soltarse, y los almacenes de cada log.
    expect(run.timeline).toEqual([
      'reads',
      'locate',
      'pending:buoh_log_000002',
      'acquire:1',
      'locate',
      'open',
      'connect:1',
      'close',
      'locate',
      'pending:buoh_log_000003',
      'locate',
      'open',
      'connect:2',
      'release:1',
      'close',
      'reads:close',
    ]);
    expect(run.configs.at(-1)).toMatchObject({
      postgres: { schema: 'buoh_log_000003' },
      s3: { keyPrefix: 'logs/000003/' },
    });
    const pid = run.provider.lock(1).backendPid;
    expect(new Set(log3.ingestionStatus.heartbeats.map((item) => item.pg_backend_pid))).toEqual(
      new Set([pid]),
    );
    // La sesión nueva del corte arma el perfil del log 3, que lee la espera (ADR-0020 §4).
    expect(run.profileReads).toEqual([2, 3]);
  });

  it('al arrancar con la hora de corte pasada hace menos de 24 horas, retoma el log activo y lo corta en cuanto está limpio', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    // Un reinicio una hora después de la hora de corte: la hora sale de la primera escritura del log.
    run.clock.jumpWallClock(Date.parse(CUT_TIME) + 3_600_000 - Date.parse(START));
    const { command } = await startProduction(run);
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000002');
    await subscribe(run, 1);
    await run.clock.advance(0);
    expect(run.alerts).toEqual([{ event: 'log_cut', forced: 'false', log: '2', next: '3' }]);
    answerForgetAll(run.socket(1));
    await settleHandover();
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000003');
    await subscribe(run, 2);
    run.raise();
    answerForgetAll(run.socket(2));
    expect((await command).exitCode).toBe(0);
    expect(eventsOf(run.storesOf('buoh_log_000002'))[0]).toMatchObject({
      kind: 'connection_opened',
    });
  });

  it('al arrancar 24 horas o más después de la hora de corte, empieza en el log siguiente sin escribir en el activo, con log_cut_forced', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) + LOG_CUT_FORCE_AFTER_MS - Date.parse(START));
    const { command } = await startProduction(run);

    expect(run.alerts).toEqual([
      {
        event: 'log_cut_forced',
        log: '2',
        next: '3',
        open_condition_types: null,
        pending_continuity: null,
        reason: 'cut_deadline_passed_at_start',
      },
    ]);
    // Los almacenes que abre son solo los del log 3: el log 2 ya no recibe nada.
    expect(run.configs.slice(2).map((config) => config.postgres.schema)).toEqual([
      'buoh_log_000003',
    ]);
    expect(run.timeline).toEqual([
      'reads',
      'locate',
      'pending:buoh_log_000003',
      'acquire:1',
      'locate',
      'open',
      'connect:1',
    ]);
    await subscribe(run, 1);
    run.raise();
    answerForgetAll(run.socket(1));
    expect((await command).exitCode).toBe(0);
    expect(eventsOf(run.storesOf('buoh_log_000003'))[0]).toMatchObject({
      kind: 'connection_opened',
      supersedes_connection_id: null,
    });
  });

  it('al arrancar 24 horas o más después de la hora de corte, sin el log siguiente preparado, espera con log_not_prepared sin escribir nada', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) + LOG_CUT_FORCE_AFTER_MS - Date.parse(START));
    const { command } = await startProduction(run);

    expect(run.alerts).toEqual([
      { detail: null, event: 'ingest_waiting', reason: 'log_not_prepared' },
    ]);
    expect(run.timeline).toEqual(['reads', 'locate']);
    run.startup.prepared.add(3);
    await run.clock.advance(STARTUP_RETRY_MS);
    await settleHandover();
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000003');
    expect(run.alerts.map((alert) => alert['event'])).toEqual(['ingest_waiting', 'log_cut_forced']);
    await subscribe(run, 1);
    run.raise();
    answerForgetAll(run.socket(1));
    expect((await command).exitCode).toBe(0);
  });

  it('si algo falla después de decidir el corte, suelta el bloqueo retenido: salida 1 con UNEXPECTED y ningún bloqueo tomado', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    const { command } = await startProduction(run);
    await subscribe(run, 1);
    await run.clock.advance(0);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(run.clock.now()) - LOG_CUT_CHECK_MS);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.alerts.map((alert) => alert['event'])).toEqual(['log_cut']);
    // Cerrar los almacenes del log 2 falla, después de que la sesión retuvo el bloqueo.
    run.storesOf('buoh_log_000002').close = () => Promise.reject(new RangeError('cierre roto'));
    answerForgetAll(run.socket(1));

    expect(await command).toEqual({
      exitCode: 1,
      line: '{"code":"UNEXPECTED","message":"RangeError","status":"failed"}',
    });
    expect(run.timeline.slice(-2)).toEqual(['release:1', 'reads:close']);
    expect(run.sockets).toHaveLength(1);
  });

  it('si el proceso termina entre el corte y la primera escritura del log siguiente, el arranque siguiente retoma el log cortado y lo vuelve a cortar (ADR-0018 §6, «Cortar»)', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    // La segunda descarga de los esquemas, la de la sesión del log 3, falla.
    let downloads = 0;
    const download = run.deps.fetch;
    const failing: IngestDependencies = {
      ...run.deps,
      fetch: (...args) => {
        downloads += 1;
        return downloads === 2
          ? Promise.resolve(new Response('no disponible', { status: 503 }))
          : download(...args);
      },
    };
    const first = await start(run, undefined, PRODUCTION_ENV, failing);
    await settle();
    await settle();
    await subscribe(run, 1);
    await run.clock.advance(0);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(run.clock.now()) - LOG_CUT_CHECK_MS);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    answerForgetAll(run.socket(1));
    // La sesión del log 3 termina failed antes de escribir nada, sin llegar a pedir el bloqueo, que
    // se suelta después de cerrar sus almacenes.
    const ended = await first.command;
    expect(ended.exitCode).toBe(1);
    expect(JSON.parse(ended.line)).toMatchObject({ connections: [], status: 'failed' });
    expect(run.timeline.slice(-3)).toEqual(['close', 'release:1', 'reads:close']);
    const log3 = run.storesOf('buoh_log_000003');
    expect(log3.sourceLog.rows).toEqual([]);
    expect(log3.ingestionStatus.heartbeats).toEqual([]);

    // El reinicio: el log 2 sigue siendo el activo, y su hora de corte pasó hace menos de 24 horas.
    const second = await start(run, undefined, PRODUCTION_ENV);
    await settleHandover();
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000002');
    // La conexión nueva espera a pasar la hora del cierre anterior, 1 ms del reloj. La primera
    // mirada del corte la ve todavía sin conectar.
    await run.clock.advance(1);
    await settleHandover();
    await subscribe(run, 2);
    const log2 = run.storesOf('buoh_log_000002');
    expect(eventsOf(log2).filter((event) => event.kind === 'connection_opened')).toHaveLength(2);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    expect(run.alerts.filter((alert) => alert['event'] === 'log_cut')).toHaveLength(2);
    answerForgetAll(run.socket(2));
    await settleHandover();
    expect(run.configs.at(-1)?.postgres.schema).toBe('buoh_log_000003');
    await subscribe(run, 3);
    run.raise();
    answerForgetAll(run.socket(3));
    expect((await second.command).exitCode).toBe(0);
  });

  it('una señal entre el corte y la sesión del log siguiente la para: salida 0 con WAIT_STOPPED, sin abrir el log siguiente, y suelta el bloqueo retenido', async () => {
    const run = await ingestHarness();
    run.startup.firstWrites.set(2, START);
    run.startup.prepared.add(3);
    const open = run.deps.openStartupReads;
    const { command } = await start(run, undefined, PRODUCTION_ENV, {
      ...run.deps,
      openStartupReads: (config) => {
        const reads = open(config);
        return {
          ...reads,
          pendingMigrations: (log) => {
            // La señal llega mientras la espera mira el log 3.
            if (log.number === 3) {
              run.raise();
            }
            return reads.pendingMigrations(log);
          },
        };
      },
    });
    await settle();
    await settle();
    await subscribe(run, 1);
    await run.clock.advance(0);
    run.clock.jumpWallClock(Date.parse(CUT_TIME) - Date.parse(run.clock.now()) - LOG_CUT_CHECK_MS);
    await run.clock.advance(LOG_CUT_CHECK_MS);
    answerForgetAll(run.socket(1));

    expect(await command).toEqual({
      exitCode: 0,
      line: JSON.stringify({ code: WAIT_STOPPED, status: 'stopped', waiting: null }),
    });
    expect(run.timeline.slice(-5)).toEqual([
      'close',
      'locate',
      'pending:buoh_log_000003',
      'release:1',
      'reads:close',
    ]);
    expect(run.sockets).toHaveLength(1);
  });
});
