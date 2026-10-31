import { healthReportSchema, type SourceEvent } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  HEALTH_CLOSE_DEADLINE_MS,
  HEALTH_DEADLINE_MS,
  HEALTH_USAGE,
  healthCommand,
  LOG_NOT_PREPARED,
  logLocation,
  OperationalRegistry,
  SourceEventLog,
  type HealthCommandStores,
  type HealthDependencies,
  type WorkerConfig,
} from '../src/index.js';
import { syntheticSchemas, uuid } from './support/connection-harness.js';
import { ManualClock, syntheticSchemaArchive } from './support/deriv-fixtures.js';
import { checkpointRowsOf } from './support/live-checkpoint-rows.js';
import {
  MemoryIngestionStatusStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemorySourceLogStore,
} from './support/memory-stores.js';
import { previousConnectionEvents } from './support/recovery-harness.js';
import { cursorOf, heartbeatOf } from './support/status-store-rules.js';

// `data:health` (ADR-0015 §8) sin red ni servicios: almacenes en memoria, un lector falso del
// bloqueo, reloj e IDs inyectados y esquemas sintéticos. Ninguna credencial ni ningún precio es
// real.

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

/** Las variables de una captura, con credenciales sintéticas. */
const ENV = {
  BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
  BUOH_POSTGRES_PASSWORD: 'contraseña-sintética',
  BUOH_POSTGRES_SCHEMA: 'buoh_captura',
  BUOH_S3_ACCESS_KEY_ID: 'clave-sintética',
  BUOH_S3_BUCKET: 'buoh-captura',
  BUOH_S3_SECRET_ACCESS_KEY: 'secreto-sintético',
};
const SECRETS = ['contraseña-sintética', 'clave-sintética', 'secreto-sintético'];
const SYMBOL = 'SYNTH_100';
const ARGS = ['--', '--json', '--symbol', SYMBOL];
const FIXTURE = syntheticSchemaArchive();
const SCHEMA_KEY = contentKey(FIXTURE.expected.entries_sha256['ticks_response.schema.json']);
/** El PID de PostgreSQL del escritor vivo de este esquema. */
const WRITER_PID = 4242;
/** La hora de la observación: 5 s después del latido. */
const NOW = '2026-03-02T09:59:10.000Z';

/** La conexión anterior todavía abierta: su apertura (09:58:00) y su tick durable (09:59:00). */
function openConnection(): SourceEvent[] {
  return previousConnectionEvents().slice(0, 2);
}

/** El informe sin observación fiable: desconectado, backlog 0 y los demás campos `null`. */
const unobserved = (serviceHealth: 'failed' | 'paused') => ({
  backlog_bytes: 0,
  backlog_count: 0,
  connection_state: 'disconnected',
  execution_mode: 'disabled',
  last_event_time_utc: null,
  last_observation_id: null,
  last_published_dataset_id: null,
  last_received_at_utc: null,
  open_condition_types: [],
  schema_version: '1.0.0',
  service_health: serviceHealth,
  source: DERIV_SOURCE,
});

interface CommandOptions {
  /** Dónde se cierran segmentos: antes de cada uno de estos eventos, por su índice. */
  readonly closedEvents?: readonly number[];
  /** El log durable; por defecto, la conexión anterior todavía abierta, con su tick. */
  readonly events?: readonly SourceEvent[];
  /** Los bytes bajo la clave del esquema de fuente; por defecto, los del esquema guardado. */
  readonly schema?: Uint8Array;
  /** El PID del escritor vivo; por defecto, el del latido. */
  readonly writerPid?: number | null;
}

/**
 * Las dependencias de `healthCommand` sobre almacenes en memoria, con un escritor vivo, su latido
 * conectado de hace 5 s, un cursor del símbolo y el esquema de fuente guardado. `opened` anota la
 * configuración de cada apertura, y `closed`, cada cierre.
 */
async function commandHarness(options: CommandOptions = {}) {
  forbidAmbientEffects();
  const sourceLog = new MemorySourceLogStore();
  const objects = new MemoryObjectStore();
  const status = new MemoryIngestionStatusStore();
  const operational = new MemoryOperationalStore();
  const seed = await SourceEventLog.open({
    objects,
    source: DERIV_SOURCE,
    store: sourceLog,
    zlibVersion: 'test',
  });
  for (const [index, event] of (options.events ?? openConnection()).entries()) {
    if (options.closedEvents?.includes(index) === true) {
      await seed.close('requested');
    }
    await seed.append(event);
  }
  await objects.putIfAbsent(
    SCHEMA_KEY,
    options.schema ?? FIXTURE.entries['ticks_response.schema.json'],
  );
  // El último cursor del símbolo apunta al tick durable del log (`uuid(9003)`).
  await status.appendCursor(cursorOf(DERIV_SOURCE, { last_durable_source_event_id: uuid(9003) }));
  await status.appendHeartbeat(
    heartbeatOf(DERIV_SOURCE, 1, {
      connection_state: 'connected',
      observed_at_utc: '2026-03-02T09:59:05.000Z',
      pg_backend_pid: WRITER_PID,
    }),
  );
  await OperationalRegistry.open({ source: DERIV_SOURCE, store: operational });
  const opened: WorkerConfig[] = [];
  /** La configuración de cada búsqueda del log activo, que solo se hace en `production`. */
  const located: WorkerConfig[] = [];
  /** El log pedido con `--log` en cada búsqueda, o `null`. */
  const requests: (number | null)[] = [];
  let closed = 0;
  /** El temporizador del plazo total y del cierre: el tiempo solo avanza con `advance`. */
  const clock = new ManualClock(NOW);
  const stores: HealthCommandStores = {
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
    datasets: { lastActiveDatasetId: () => Promise.resolve(null) },
    ingestionStatus: status,
    lockHolder: () =>
      Promise.resolve(options.writerPid === undefined ? WRITER_PID : options.writerPid),
    objects,
    operational,
    pendingMigrations: () => Promise.resolve([]),
    sourceLog,
  };
  let sequence = 0;
  const deps = (overrides: Partial<HealthCommandStores> = {}): HealthDependencies => ({
    expected: FIXTURE.expected,
    // El log activo de `production`: el 2, como si el 1 ya hubiera terminado. Con `--log`, el pedido.
    locateLog: (config, requested) => {
      located.push(config);
      requests.push(requested);
      return Promise.resolve(logLocation(requested ?? 2));
    },
    nextId: () => uuid(7000 + (sequence += 1)),
    now: () => NOW,
    openStores: (config) => {
      opened.push(config);
      return { ...stores, ...overrides };
    },
    scheduler: clock.scheduler,
  });
  /** Lo que guardan los almacenes, para comprobar que el comando no escribe nada. */
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
  /** Las filas de los puntos de control de los segmentos cerrados, como las escribe `ingest`. */
  const checkpointRows = () =>
    checkpointRowsOf({
      log: seed,
      profile: createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL }),
      symbol: SYMBOL,
      writtenAt: NOW,
    });
  return {
    checkpointRows,
    clock,
    closed: () => closed,
    contents,
    deps,
    located,
    objects,
    opened,
    requests,
    sourceLog,
    status,
    stores,
  };
}

/** Una lectura que nunca termina: un almacén que acepta la conexión y no contesta. */
const silent = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** La línea de stdout como `HealthReport`: una sola línea JSON que cumple su contrato. */
function reportOf(stdout: string | null) {
  if (stdout === null) {
    throw new TypeError('Falta la línea de stdout.');
  }
  expect(stdout).not.toContain('\n');
  return healthReportSchema.parse(JSON.parse(stdout));
}

describe('healthCommand: el informe (ADR-0015 §8, «Salida»)', () => {
  it('con el escritor vivo de este esquema, su latido reciente y raw durable, escribe en stdout una sola línea con el HealthReport healthy, nada en stderr y sale con 0', async () => {
    const run = await commandHarness();
    const result = await healthCommand(ARGS, ENV, run.deps());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBeNull();
    expect(reportOf(result.stdout)).toEqual({
      backlog_bytes: 0,
      backlog_count: 0,
      connection_state: 'connected',
      execution_mode: 'disabled',
      last_event_time_utc: '2026-03-02T09:59:00.000Z',
      last_observation_id: uuid(9003),
      last_published_dataset_id: null,
      last_received_at_utc: '2026-03-02T09:59:00.000Z',
      open_condition_types: [],
      schema_version: '1.0.0',
      service_health: 'healthy',
      source: DERIV_SOURCE,
    });
  });

  it('con otra salud, sin escritor vivo, escribe el informe y sale con 1, sin alerta', async () => {
    const run = await commandHarness({ writerPid: null });
    const result = await healthCommand(ARGS, ENV, run.deps());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeNull();
    // Regla 4: la conexión sin cierre durable se deriva con el cierre que registrará el arranque.
    expect(reportOf(result.stdout)).toMatchObject({
      connection_state: 'disconnected',
      open_condition_types: ['connection_lost'],
      service_health: 'paused',
    });
  });

  it('con lo observado incompatible, escribe el informe failed y en stderr una sola línea con la alerta data_health_failed y su motivo, y sale con 1', async () => {
    const run = await commandHarness({ schema: new TextEncoder().encode('{"otros":"bytes"}') });
    const result = await healthCommand(ARGS, ENV, run.deps());

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('failed'));
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"source_schema_mismatch"}');
  });

  it('con el símbolo que pide --symbol: otro que el de los cursores del log es symbol_mismatch', async () => {
    const run = await commandHarness();
    const result = await healthCommand(['--json', '--symbol', 'R_50'], ENV, run.deps());

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('failed'));
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"symbol_mismatch"}');
  });

  it('si PostgreSQL no responde, escribe el informe paused y en stderr la alerta data_health_storage_unavailable con el código del error, nunca su mensaje', async () => {
    const run = await commandHarness();
    const unavailable = Object.assign(
      new Error('connect ECONNREFUSED db.interno.invalid:5432 rol_sintetico base_sintetica'),
      { code: 'ECONNREFUSED' },
    );
    const result = await healthCommand(
      ARGS,
      ENV,
      run.deps({ pendingMigrations: () => Promise.reject(unavailable) }),
    );

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"ECONNREFUSED"}',
    );
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(
      /db\.interno|rol_sintetico|base_sintetica/u,
    );
  });

  it('abre los almacenes con la configuración del entorno, nunca escribe en ellos y los cierra una vez, con cualquier resultado', async () => {
    for (const options of [{}, { writerPid: null }, { schema: new Uint8Array([1]) }]) {
      const run = await commandHarness(options);
      const before = run.contents();
      await healthCommand(ARGS, ENV, run.deps());
      expect(run.contents()).toEqual(before);
      expect(run.closed()).toBe(1);
      expect(run.opened.map((config) => [config.postgres.schema, config.s3.bucket])).toEqual([
        ['buoh_captura', 'buoh-captura'],
      ]);
    }
  });
});

describe('healthCommand: un almacén que no contesta (ADR-0015 §8, regla 3)', () => {
  it(`si la observación y la evaluación no terminan en HEALTH_DEADLINE_MS (${String(HEALTH_DEADLINE_MS)} ms), escribe el informe paused con la alerta deadline_exceeded, sale con 1 y cierra los almacenes`, async () => {
    const run = await commandHarness();
    let settled = false;
    const pending = healthCommand(
      ARGS,
      ENV,
      run.deps({ pendingMigrations: () => silent<readonly string[]>() }),
    ).finally(() => {
      settled = true;
    });

    expect(HEALTH_DEADLINE_MS).toBe(30_000);
    await run.clock.advance(HEALTH_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    expect(run.closed()).toBe(0);
    await run.clock.advance(1);
    const result = await pending;

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"deadline_exceeded"}',
    );
    expect(run.closed()).toBe(1);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('el plazo es total: una lectura que no contesta después de otras que sí también lo agota', async () => {
    const run = await commandHarness();
    const pending = healthCommand(
      ARGS,
      ENV,
      run.deps({ datasets: { lastActiveDatasetId: () => silent<string | null>() } }),
    );
    await run.clock.advance(HEALTH_DEADLINE_MS);
    const result = await pending;

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"deadline_exceeded"}',
    );
    expect(run.closed()).toBe(1);
  });

  it(`si cerrar los almacenes tampoco termina, no espera más de HEALTH_CLOSE_DEADLINE_MS (${String(HEALTH_CLOSE_DEADLINE_MS)} ms)`, async () => {
    const run = await commandHarness();
    let settled = false;
    const pending = healthCommand(
      ARGS,
      ENV,
      run.deps({
        close: () => silent<undefined>(),
        pendingMigrations: () => silent<readonly string[]>(),
      }),
    ).finally(() => {
      settled = true;
    });

    expect(HEALTH_CLOSE_DEADLINE_MS).toBe(5_000);
    await run.clock.advance(HEALTH_DEADLINE_MS + HEALTH_CLOSE_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await run.clock.advance(1);
    const result = await pending;

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"deadline_exceeded"}',
    );
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('con una lectura que termina a tiempo, no deja ningún temporizador pendiente', async () => {
    const run = await commandHarness();
    const result = await healthCommand(ARGS, ENV, run.deps());

    expect(result.exitCode).toBe(0);
    expect(run.clock.pendingDelays()).toEqual([]);
    expect(run.closed()).toBe(1);
  });

  it('el plazo vencido de una petición (TimeoutError con ETIMEDOUT) es la regla 3 con su código, nunca su mensaje', async () => {
    const run = await commandHarness();
    const timedOut = Object.assign(
      new Error('a request has exceeded the configured 10000 ms requestTimeout s3.interno.invalid'),
      { code: 'ETIMEDOUT', name: 'TimeoutError' },
    );
    const result = await healthCommand(
      ARGS,
      ENV,
      run.deps({ datasets: { lastActiveDatasetId: () => Promise.reject(timedOut) } }),
    );

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe('{"event":"data_health_storage_unavailable","reason":"ETIMEDOUT"}');
    expect(result.stderr).not.toContain('s3.interno');
    expect(run.clock.pendingDelays()).toEqual([]);
  });
});

describe('healthCommand: los puntos de control del estado vivo (ADR-0017 §6)', () => {
  /** La conexión abierta con su apertura en el segmento cerrado 0 y su tick en el abierto. */
  const splitLog = { closedEvents: [1] } as const;

  /** Guarda el punto de control del segmento 0 con otro SHA-256: uno que se rechaza y avisa. */
  async function rejectedCheckpoint(run: Awaited<ReturnType<typeof commandHarness>>) {
    const [row] = await run.checkpointRows();
    if (row === undefined) {
      throw new TypeError('Falta la fila del segmento 0.');
    }
    run.sourceLog.checkpoints.push({ ...row, checkpoint_sha256: 'f'.repeat(64) });
  }

  const REJECTED =
    '{"event":"checkpoint_rejected","reason":"checkpoint_digest_mismatch","segment_index":"0"}';

  /**
   * El objeto del segmento cerrado 0 nunca contesta, como un almacén lento. `reached` se cumple
   * cuando la lectura llega a él.
   */
  const silentSegment = (run: Awaited<ReturnType<typeof commandHarness>>) => {
    const key = contentKey(run.sourceLog.closed[0]?.object_bytes_sha256 ?? '');
    const reached = Promise.withResolvers<undefined>();
    const overrides: Partial<HealthCommandStores> = {
      objects: {
        bucket: run.objects.bucket,
        get: (wanted, maxBytes) => {
          if (wanted !== key) {
            return run.objects.get(wanted, maxBytes);
          }
          reached.resolve(undefined);
          return silent<Uint8Array>();
        },
      },
    };
    return { overrides, reached: reached.promise };
  };

  it('escribe en stderr una línea por cada punto de control que rechaza, antes de la alerta de la regla 2, y el informe sale del log reconstruido', async () => {
    const healthy = await commandHarness(splitLog);
    await rejectedCheckpoint(healthy);
    const result = await healthCommand(ARGS, ENV, healthy.deps());

    expect(result.exitCode).toBe(0);
    expect(reportOf(result.stdout)).toMatchObject({
      last_observation_id: uuid(9003),
      service_health: 'healthy',
    });
    expect(result.stderr).toBe(REJECTED);

    // Con el último cursor por delante del log: la alerta de la regla 2 va después.
    const ahead = await commandHarness(splitLog);
    await rejectedCheckpoint(ahead);
    await ahead.status.appendCursor(
      cursorOf(DERIV_SOURCE, { last_durable_source_event_id: uuid(9999) }),
    );
    const failed = await healthCommand(ARGS, ENV, ahead.deps());
    expect(failed.exitCode).toBe(1);
    expect(reportOf(failed.stdout)).toEqual(unobserved('failed'));
    expect(failed.stderr).toBe(
      `${REJECTED}\n{"event":"data_health_failed","reason":"cursor_ahead_of_log"}`,
    );
  });

  it(`si el plazo total se cumple mientras reconstruye el estado vivo, da paused con la alerta data_health_checkpoint_rebuild_incomplete, no la de un almacén que no responde, y sale con 1`, async () => {
    const run = await commandHarness(splitLog);
    await rejectedCheckpoint(run);
    const segment = silentSegment(run);
    const pending = healthCommand(ARGS, ENV, run.deps(segment.overrides));
    await segment.reached;
    await run.clock.advance(HEALTH_DEADLINE_MS);
    const result = await pending;

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    // La alerta del punto de control rechazado ya estaba: también sale.
    expect(result.stderr).toBe(
      `${REJECTED}\n{"event":"data_health_checkpoint_rebuild_incomplete","reason":"deadline_exceeded"}`,
    );
    expect(run.closed()).toBe(1);
    expect(run.clock.pendingDelays()).toEqual([]);
  });

  it('si ya terminó de reconstruir, o el punto de control válido es el del último segmento cerrado, un almacén que no contesta es deadline_exceeded', async () => {
    // Reconstruyó el segmento 0 y después no contesta el último dataset.
    const rebuilt = await commandHarness(splitLog);
    const reached = Promise.withResolvers<undefined>();
    const late = healthCommand(
      ARGS,
      ENV,
      rebuilt.deps({
        datasets: {
          lastActiveDatasetId: () => {
            reached.resolve(undefined);
            return silent<string | null>();
          },
        },
      }),
    );
    await reached.promise;
    await rebuilt.clock.advance(HEALTH_DEADLINE_MS);
    expect(await late).toMatchObject({
      exitCode: 1,
      stderr: '{"event":"data_health_storage_unavailable","reason":"deadline_exceeded"}',
    });

    // Con el punto de control del segmento 0 no lee ningún segmento cerrado.
    const checkpointed = await commandHarness(splitLog);
    for (const row of await checkpointed.checkpointRows()) {
      await checkpointed.sourceLog.insertLiveCheckpoint(row);
    }
    const quick = await healthCommand(
      ARGS,
      ENV,
      checkpointed.deps(silentSegment(checkpointed).overrides),
    );
    expect(quick.exitCode).toBe(0);
    expect(quick.stderr).toBeNull();
    expect(checkpointed.clock.pendingDelays()).toEqual([]);
  });
});

describe('healthCommand: argumentos y entorno inválidos (ADR-0015 §8, regla 1)', () => {
  it('sin --json sale con 2, nada en stdout y en stderr una línea con UsageError y el uso, sin abrir ningún almacén', async () => {
    const run = await commandHarness();
    const result = await healthCommand(['--symbol', SYMBOL], ENV, run.deps());

    expect(result).toMatchObject({ exitCode: 2, stdout: null });
    const line = JSON.parse(result.stderr ?? '') as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['code', 'message', 'status']);
    expect(line).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(line['message']).toContain('--json');
    expect(line['message']).toContain(HEALTH_USAGE);
    expect(run.opened).toEqual([]);
  });

  it('con variables de entorno inválidas sale con 2 y nombra solo las variables, nunca sus valores, sin abrir ningún almacén', async () => {
    const run = await commandHarness();
    const env = {
      ...ENV,
      BUOH_DEPLOYMENT_ENVIRONMENT: 'otro',
      BUOH_POSTGRES_HOST: 'db.interno.invalid',
      BUOH_POSTGRES_PASSWORD: undefined,
    };
    const result = await healthCommand(ARGS, env, run.deps());

    expect(result).toMatchObject({ exitCode: 2, stdout: null });
    const line = JSON.parse(result.stderr ?? '') as Record<string, unknown>;
    expect(line).toMatchObject({ code: 'ConfigError', status: 'failed' });
    expect(line['message']).toContain('BUOH_DEPLOYMENT_ENVIRONMENT');
    expect(line['message']).toContain('BUOH_POSTGRES_PASSWORD');
    for (const value of [...SECRETS, 'otro', 'db.interno.invalid']) {
      expect(result.stderr).not.toContain(value);
    }
    expect(run.opened).toEqual([]);
  });
});

describe('healthCommand: un error inesperado', () => {
  it('si abrir los almacenes falla, escribe el informe failed con la alerta unexpected_error y sale con 1', async () => {
    const run = await commandHarness();
    const deps: HealthDependencies = {
      ...run.deps(),
      openStores: () => {
        throw new TypeError('fallo de programación sintético');
      },
    };
    const result = await healthCommand(ARGS, ENV, deps);

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('failed'));
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"unexpected_error"}');
  });

  it('si la evaluación falla después de abrirlos, los cierra igual, una vez, y nunca escribe el mensaje del error', async () => {
    const run = await commandHarness({ writerPid: null });
    // Una hora que no es UTC hace fallar el cierre de la regla 4: un error de programación.
    const result = await healthCommand(ARGS, ENV, { ...run.deps(), now: () => 'no es una hora' });

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('failed'));
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"unexpected_error"}');
    expect(run.closed()).toBe(1);
  });
});

/** Las variables de `production`: con el cifrado obligatorio y sin `BUOH_POSTGRES_SCHEMA`. */
const PRODUCTION_ENV = {
  ...ENV,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_POSTGRES_SCHEMA: undefined,
  BUOH_POSTGRES_SSLMODE: 'require',
};

describe('healthCommand en production: el log activo (ADR-0018 §6)', () => {
  it('busca el log activo con la configuración y abre los almacenes con su esquema y el prefijo de sus objetos, y nada más cambia', async () => {
    const run = await commandHarness();
    const result = await healthCommand(ARGS, PRODUCTION_ENV, run.deps());

    expect(result.exitCode).toBe(0);
    expect(reportOf(result.stdout)).toMatchObject({ service_health: 'healthy' });
    expect(run.located).toHaveLength(1);
    const [located] = run.located;
    expect(located?.environment).toBe('production');
    expect(run.opened).toHaveLength(1);
    const [config] = run.opened;
    expect(config?.postgres.schema).toBe('buoh_log_000002');
    expect(config?.s3.keyPrefix).toBe('logs/000002/');
    expect({
      ...config,
      postgres: { ...config?.postgres, schema: located?.postgres.schema },
      s3: { ...config?.s3, keyPrefix: located?.s3.keyPrefix },
    }).toEqual(located);
    expect(run.closed()).toBe(1);
  });

  it('sin log activo, la regla 2: el informe failed con la alerta log_not_prepared y salida 1, sin abrir ningún almacén', async () => {
    const run = await commandHarness();
    const result = await healthCommand(ARGS, PRODUCTION_ENV, {
      ...run.deps(),
      locateLog: () => Promise.resolve(null),
    });

    expect(LOG_NOT_PREPARED).toBe('log_not_prepared');
    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('failed'));
    expect(result.stderr).toBe('{"event":"data_health_failed","reason":"log_not_prepared"}');
    expect(run.opened).toEqual([]);
  });

  it('si PostgreSQL no responde a la búsqueda, la regla 3 con el código del error y nunca su mensaje, sin abrir ningún almacén', async () => {
    const run = await commandHarness();
    const unavailable = Object.assign(
      new Error('connect ECONNREFUSED db.interno.invalid:5432 rol_sintetico base_sintetica'),
      { code: 'ECONNREFUSED' },
    );
    const result = await healthCommand(ARGS, PRODUCTION_ENV, {
      ...run.deps(),
      locateLog: () => Promise.reject(unavailable),
    });

    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"ECONNREFUSED"}',
    );
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(
      /db\.interno|rol_sintetico|base_sintetica/u,
    );
    expect(run.opened).toEqual([]);
  });

  it('una búsqueda que no termina en el plazo total da deadline_exceeded, y si termina después no abre ningún almacén', async () => {
    const run = await commandHarness();
    let finish: (log: ReturnType<typeof logLocation>) => void = () => undefined;
    const pending = healthCommand(ARGS, PRODUCTION_ENV, {
      ...run.deps(),
      locateLog: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });

    await run.clock.advance(HEALTH_DEADLINE_MS);
    const result = await pending;
    expect(result.exitCode).toBe(1);
    expect(reportOf(result.stdout)).toEqual(unobserved('paused'));
    expect(result.stderr).toBe(
      '{"event":"data_health_storage_unavailable","reason":"deadline_exceeded"}',
    );
    finish(logLocation(2));
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(run.opened).toEqual([]);
    expect(run.closed()).toBe(0);
  });

  it('BUOH_POSTGRES_SCHEMA no se admite: salida 2 con un ConfigError que la nombra junto con las demás variables rechazadas, sin buscar ni abrir nada', async () => {
    const run = await commandHarness();
    const result = await healthCommand(
      ARGS,
      {
        ...PRODUCTION_ENV,
        BUOH_POSTGRES_SCHEMA: 'buoh_log_000001',
        BUOH_POSTGRES_SSLMODE: undefined,
      },
      run.deps(),
    );

    expect(result).toMatchObject({ exitCode: 2, stdout: null });
    expect(JSON.parse(result.stderr ?? '')).toEqual({
      code: 'ConfigError',
      message: 'Configuración inválida o ausente: BUOH_POSTGRES_SCHEMA, BUOH_POSTGRES_SSLMODE.',
      status: 'failed',
    });
    expect(run.located).toEqual([]);
    expect(run.opened).toEqual([]);
  });

  it('con --log, busca ese log en lugar del activo y lo observa con su esquema y su prefijo (ADR-0018 §11)', async () => {
    const run = await commandHarness();
    const result = await healthCommand([...ARGS, '--log', '1'], PRODUCTION_ENV, run.deps());

    expect(result.exitCode).toBe(0);
    expect(run.requests).toEqual([1]);
    expect(run.opened.map((config) => [config.postgres.schema, config.s3.keyPrefix])).toEqual([
      ['buoh_log_000001', 'logs/000001/'],
    ]);
  });

  it('fuera de production, --log es un error de uso: salida 2, sin buscar ni abrir nada', async () => {
    const run = await commandHarness();
    const result = await healthCommand([...ARGS, '--log', '1'], ENV, run.deps());

    expect(result).toMatchObject({ exitCode: 2, stdout: null });
    const line = JSON.parse(result.stderr ?? '') as Record<string, unknown>;
    expect(line).toMatchObject({ code: 'UsageError', status: 'failed' });
    expect(line['message']).toContain('--log');
    expect(line['message']).toContain(HEALTH_USAGE);
    expect(run.located).toEqual([]);
    expect(run.opened).toEqual([]);
  });

  it('fuera de production no busca el log: el esquema de BUOH_POSTGRES_SCHEMA, sin prefijo', async () => {
    for (const env of [
      ENV,
      { ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: 'test' },
      { ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: 'staging', BUOH_POSTGRES_SSLMODE: 'require' },
    ]) {
      const run = await commandHarness();
      await healthCommand(ARGS, env, run.deps());
      expect(run.located).toEqual([]);
      expect(run.opened.map((config) => [config.postgres.schema, config.s3.keyPrefix])).toEqual([
        ['buoh_captura', ''],
      ]);
    }
  });
});
