import { healthReportSchema, type SourceEvent } from '@buoh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import {
  contentKey,
  HEALTH_CLOSE_DEADLINE_MS,
  HEALTH_DEADLINE_MS,
  HEALTH_USAGE,
  healthCommand,
  OperationalRegistry,
  SourceEventLog,
  type HealthCommandStores,
  type HealthDependencies,
  type WorkerConfig,
} from '../src/index.js';
import { uuid } from './support/connection-harness.js';
import { ManualClock, syntheticSchemaArchive } from './support/deriv-fixtures.js';
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
  for (const event of options.events ?? openConnection()) {
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
      closed: sourceLog.closed,
      conditions: operational.conditions,
      cursors: status.cursors,
      heartbeats: status.heartbeats,
      incidents: operational.incidents,
      objects: [...objects.objects.entries()],
      rows: sourceLog.rows,
    });
  return { clock, closed: () => closed, contents, deps, opened };
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
