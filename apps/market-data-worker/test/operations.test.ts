import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gzipSync } from 'node:zlib';

import { sha256Hex, type HealthReport } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  CHILD_OUTPUT_LIMIT_BYTES,
  ConfigError,
  healthEnvironment,
  loadOperationsConfig,
  logLocation,
  migrateEnvironment,
  nextLogToPrepare,
  ObjectReadError,
  OPERATIONS_STEPS,
  operationsCommand,
  runNodeScript,
  runOperations,
  VERIFICATION_DEADLINE_MS,
  verificationSlot,
  verifySegment,
  WORKER_NODE_FLAGS,
  workerChildScript,
  type CaptureLog,
  type ChildResult,
  type DueSegment,
  type LogLocation,
  type LoginCheck,
  type LogObjects,
  type OperationalAlert,
  type OperationsReportRow,
  type OwnerDatabase,
  type RunChild,
  type SpaceMeasure,
} from '../src/index.js';
import { type Scheduler } from '../src/deriv/ports.js';
import { uuid } from './support/connection-harness.js';
import { flush, ManualClock } from './support/deriv-fixtures.js';

// `buoh-operaciones` (ADR-0018 §11) sin servicios: una base falsa, procesos y objetos falsos, IDs y
// reloj inyectados. Los vectores salen de §6, §7, §8 y §11: el orden de los pasos, el entorno
// explícito de cada proceso, el log siguiente, las contraseñas, la ejecución de cada segmento en la
// verificación por partes y sus hashes, el espacio una vez al día y un paso que falla sin impedir los
// siguientes.
// La prueba contra PostgreSQL está en integration/operations.test.ts. Las credenciales son
// sintéticas.

/** Las variables de `buoh-operaciones`, con valores sintéticos. */
const ENV = {
  BUOH_AGENTE_POSTGRES_PASSWORD: 'agente-sintetico-0123456789',
  BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
  BUOH_DUENO_POSTGRES_DB: 'buoh',
  BUOH_DUENO_POSTGRES_HOST: 'pg-sintetico.invalid',
  BUOH_DUENO_POSTGRES_PASSWORD: 'dueno-sintetico',
  BUOH_DUENO_POSTGRES_PORT: '5432',
  BUOH_DUENO_POSTGRES_SSLMODE: 'require',
  BUOH_DUENO_POSTGRES_USER: 'buoh',
  BUOH_INGESTA_POSTGRES_PASSWORD: 'ingesta-sintetica-0123456789',
  BUOH_SALUD_POSTGRES_PASSWORD: 'salud-sintetica-0123456789',
  BUOH_SALUD_S3_ACCESS_KEY_ID: 'clave-salud-sintetica',
  BUOH_SALUD_S3_BUCKET: 'buoh-captura',
  BUOH_SALUD_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
  BUOH_SALUD_S3_REGION: 'auto',
  BUOH_SALUD_S3_SECRET_ACCESS_KEY: 'secreto-salud-sintetico',
  BUOH_OPERACIONES_S3_ACCESS_KEY_ID: 'clave-operaciones-sintetica',
  BUOH_OPERACIONES_S3_BUCKET: 'buoh-captura',
  BUOH_OPERACIONES_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
  BUOH_OPERACIONES_S3_REGION: 'auto',
  BUOH_OPERACIONES_S3_SECRET_ACCESS_KEY: 'secreto-operaciones-sintetico',
};
const CONFIG = loadOperationsConfig(ENV);
const NOW = '2026-03-02T10:00:00.000Z';

/** Un temporizador que nunca vence: los plazos de la verificación no cuentan en esas pruebas. */
const IDLE_SCHEDULER: Scheduler = { schedule: () => () => undefined };

/** El informe sin observación de `data:health`: sin log ni escritor vivo. */
const REPORT: HealthReport = {
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
  service_health: 'paused',
  source: 'deriv_options',
};

/** El log `number`, legible, con su última escritura o sin ninguna. */
const log = (number: number, lastWriteUtc: string | null = null): CaptureLog => ({
  lastWriteUtc,
  location: logLocation(number),
  readable: true,
});

/** Un segmento cerrado: su contenido, su objeto gzip y su fila, con los hashes de los dos. */
function segment(index: number, text = `{"segmento":${String(index)}}\n`) {
  const logical = new TextEncoder().encode(text);
  const physical = new Uint8Array(gzipSync(logical));
  const row: DueSegment = {
    compression: 'gzip',
    logical_content_sha256: sha256Hex(logical),
    object_bytes_sha256: sha256Hex(physical),
    object_size_bytes: physical.byteLength,
    segment_index: index,
  };
  return { physical, row };
}

const segmentRow = (index: number): DueSegment => segment(index).row;

/** La clave completa del objeto de un segmento en el bucket: el prefijo del log y `sha256/`. */
const segmentKey = (number: number, row: DueSegment): string =>
  `${logLocation(number).prefix}sha256/${row.object_bytes_sha256}`;

describe('loadOperationsConfig (ADR-0018 §11)', () => {
  it('lee la credencial dueña, las contraseñas de los roles y los tokens salud y operaciones con sus propios nombres', () => {
    expect(CONFIG).toEqual({
      healthObjects: {
        accessKeyId: 'clave-salud-sintetica',
        bucket: 'buoh-captura',
        endpoint: 'https://cuenta-sintetica.r2.invalid',
        region: 'auto',
        secretAccessKey: 'secreto-salud-sintetico',
      },
      operationsObjects: {
        accessKeyId: 'clave-operaciones-sintetica',
        bucket: 'buoh-captura',
        endpoint: 'https://cuenta-sintetica.r2.invalid',
        region: 'auto',
        secretAccessKey: 'secreto-operaciones-sintetico',
      },
      owner: {
        database: 'buoh',
        host: 'pg-sintetico.invalid',
        password: 'dueno-sintetico',
        port: 5432,
        schema: 'public',
        sslMode: 'require',
        user: 'buoh',
      },
      passwords: {
        buoh_agente: 'agente-sintetico-0123456789',
        buoh_ingesta: 'ingesta-sintetica-0123456789',
        buoh_salud: 'salud-sintetica-0123456789',
      },
    });
  });

  /** Las variables que rechaza con `env`, en orden, o `[]` si la admite. */
  const rejected = (env: Readonly<Record<string, string | undefined>>): readonly string[] => {
    try {
      loadOperationsConfig(env);
      return [];
    } catch (error) {
      if (error instanceof ConfigError) {
        expect(error.message).not.toMatch(/sintetic|invalid/u);
        return error.variables;
      }
      throw error;
    }
  };

  it('todas son obligatorias: sin ninguna, nombra cada una, nunca su valor', () => {
    expect(rejected({})).toEqual(Object.keys(ENV).sort());
  });

  it('solo corre en production, y nunca sin cifrar', () => {
    for (const environment of ['development', 'test', 'staging']) {
      expect(rejected({ ...ENV, BUOH_DEPLOYMENT_ENVIRONMENT: environment })).toEqual([
        'BUOH_DEPLOYMENT_ENVIRONMENT',
      ]);
    }
    expect(rejected({ ...ENV, BUOH_DUENO_POSTGRES_SSLMODE: 'disable' })).toEqual([
      'BUOH_DUENO_POSTGRES_SSLMODE',
    ]);
    expect(rejected({ ...ENV, BUOH_DUENO_POSTGRES_SSLMODE: 'verify-full' })).toEqual([]);
  });

  it('una contraseña de un rol de ejecución tiene 16 caracteres o más, ASCII imprimible sin espacios', () => {
    expect(rejected({ ...ENV, BUOH_INGESTA_POSTGRES_PASSWORD: 'corta' })).toEqual([
      'BUOH_INGESTA_POSTGRES_PASSWORD',
    ]);
    expect(rejected({ ...ENV, BUOH_SALUD_POSTGRES_PASSWORD: 'con espacios dentro 123' })).toEqual([
      'BUOH_SALUD_POSTGRES_PASSWORD',
    ]);
  });

  it('una variable BUOH_POSTGRES_* o BUOH_S3_* presente se rechaza: el servicio no tiene ninguna', () => {
    expect(
      rejected({
        ...ENV,
        BUOH_POSTGRES_PASSWORD: 'otra-sintetica',
        BUOH_S3_BUCKET: 'buoh-captura',
      }),
    ).toEqual(['BUOH_POSTGRES_PASSWORD', 'BUOH_S3_BUCKET']);
  });
});

describe('el entorno explícito de cada proceso (ADR-0018 §11)', () => {
  it('db:migrate recibe solo la credencial dueña, el esquema del log y el rol dueño', () => {
    expect(migrateEnvironment(CONFIG, 'buoh_log_000003')).toEqual({
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
      BUOH_POSTGRES_OWNER_ROLE: 'buoh_dueno',
      BUOH_POSTGRES_PASSWORD: 'dueno-sintetico',
      BUOH_POSTGRES_PORT: '5432',
      BUOH_POSTGRES_SCHEMA: 'buoh_log_000003',
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: 'buoh',
    });
  });

  it('data:health recibe solo buoh_salud y el token salud: ni la credencial dueña ni las demás contraseñas', () => {
    const env = healthEnvironment(CONFIG);
    expect(env).toEqual({
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
      BUOH_POSTGRES_PASSWORD: 'salud-sintetica-0123456789',
      BUOH_POSTGRES_PORT: '5432',
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: 'buoh_salud',
      BUOH_S3_ACCESS_KEY_ID: 'clave-salud-sintetica',
      BUOH_S3_BUCKET: 'buoh-captura',
      BUOH_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
      BUOH_S3_REGION: 'auto',
      BUOH_S3_SECRET_ACCESS_KEY: 'secreto-salud-sintetico',
    });
    for (const secret of [
      'dueno-sintetico',
      'agente-sintetico-0123456789',
      'ingesta-sintetica-0123456789',
      'clave-operaciones-sintetica',
      'secreto-operaciones-sintetico',
    ]) {
      expect(Object.values(env)).not.toContain(secret);
    }
  });

  it('db:migrate tampoco recibe ningún token de R2', () => {
    const values = Object.values(migrateEnvironment(CONFIG, 'buoh_log_000001'));
    for (const secret of [
      'clave-salud-sintetica',
      'secreto-salud-sintetico',
      'clave-operaciones-sintetica',
      'secreto-operaciones-sintetico',
    ]) {
      expect(values).not.toContain(secret);
    }
  });
});

describe('nextLogToPrepare (ADR-0018 §6, «Preparación»)', () => {
  it('el log 1 si no hay ninguno, el n+1 si el de mayor número tiene una escritura, y ninguno si ya hay uno vacío por delante', () => {
    expect(nextLogToPrepare([])).toEqual(logLocation(1));
    expect(nextLogToPrepare([log(1, NOW)])).toEqual(logLocation(2));
    expect(nextLogToPrepare([log(1, NOW), log(2)])).toBeNull();
    expect(nextLogToPrepare([log(3, NOW), log(1, NOW), log(2, NOW)])).toEqual(logLocation(4));
    // Uno que todavía se prepara, sin tablas, no tiene escrituras: no se crea otro detrás.
    expect(
      nextLogToPrepare([
        log(1, NOW),
        { lastWriteUtc: null, location: logLocation(2), readable: false },
      ]),
    ).toBeNull();
  });
});

/**
 * Una base falsa: anota cada llamada y responde con `state`. Los segmentos que tocan en una
 * ejecución son los de índice *i* con *i* mod 288 = la ejecución, como en la consulta real.
 */
function fakeDatabase(state: {
  logs: CaptureLog[];
  /** Los roles que inician sesión con su contraseña. */
  loggedIn: Set<string>;
  fail?: Partial<Record<keyof OwnerDatabase, unknown>>;
  /** Los segmentos cerrados de cada log, por su número. */
  segments?: Readonly<Record<number, readonly DueSegment[]>>;
  space?: SpaceMeasure;
}) {
  const calls: string[] = [];
  const reports: { log: number; row: OperationsReportRow }[] = [];
  const answer = <T>(name: keyof OwnerDatabase, value: () => T): Promise<T> => {
    const error = state.fail?.[name];
    if (error !== undefined) {
      return Promise.reject(error instanceof Error ? error : new Error('fallo sintético'));
    }
    return Promise.resolve(value());
  };
  const database: OwnerDatabase = {
    appendReport: (target, row) => {
      calls.push(`report:${String(target.number)}:${row.step}`);
      return answer('appendReport', () => {
        reports.push({ log: target.number, row });
      });
    },
    checkLogin: (role) => {
      calls.push(`login:${role}`);
      return answer('checkLogin', () => (state.loggedIn.has(role) ? 'accepted' : 'rejected'));
    },
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
    createLogSchema: (target) => {
      calls.push(`create:${String(target.number)}`);
      return answer('createLogSchema', () => {
        state.logs.push(log(target.number));
      });
    },
    ensureRuntimeRoles: () => {
      calls.push('roles');
      return answer('ensureRuntimeRoles', () => undefined);
    },
    grantLogPrivileges: (target) => {
      calls.push(`grant:${String(target.number)}`);
      return answer('grantLogPrivileges', () => undefined);
    },
    lastCompletedReport: (target, step) => {
      calls.push(`last:${String(target.number)}:${step}`);
      return answer('lastCompletedReport', () => {
        const times = reports
          .filter(
            (item) =>
              item.log === target.number &&
              item.row.step === step &&
              item.row.status === 'completed',
          )
          .map((item) => item.row.observed_at_utc)
          .sort();
        return times.at(-1) ?? null;
      });
    },
    listLogs: () => {
      calls.push('list');
      return answer('listLogs', () => [...state.logs]);
    },
    listSegmentsDue: (target, slot) => {
      calls.push(`segments:${String(target.number)}:${String(slot)}`);
      return answer('listSegmentsDue', () =>
        (state.segments?.[target.number] ?? []).filter(
          (segment) => segment.segment_index % 288 === slot,
        ),
      );
    },
    measureSpace: () => {
      calls.push('space');
      return answer(
        'measureSpace',
        () =>
          state.space ?? {
            database_bytes: 1000,
            logs: state.logs.map((item) => ({ bytes: 100, log: item.location.number })),
          },
      );
    },
    setRolePassword: (role) => {
      calls.push(`password:${role}`);
      return answer('setRolePassword', () => {
        state.loggedIn.add(role);
      });
    },
  };
  return { calls, database, reports };
}

const coded = (code: string) =>
  Object.assign(new Error(`connect ${code} pg-sintetico.invalid rol_sintetico`), { code });

/** Procesos falsos: anota cada uno con sus argumentos y su entorno, y responde con `answer`. */
function fakeChildren(
  answer: (child: string, args: readonly string[]) => Partial<ChildResult> = () => ({}),
) {
  const runs: { args: readonly string[]; child: string; env: Readonly<Record<string, string>> }[] =
    [];
  const runChild: RunChild = (child, args, env) => {
    runs.push({ args, child, env });
    const defaults: ChildResult =
      child === 'migrate'
        ? {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({ applied: [], current: [], status: 'migrated' }),
            timedOut: false,
          }
        : { exitCode: 1, stderr: '', stdout: JSON.stringify(REPORT), timedOut: false };
    return Promise.resolve({ ...defaults, ...answer(child, args) });
  };
  return { runChild, runs };
}

/**
 * Los objetos falsos de los logs: los bytes de cada clave completa (prefijo del log y clave), con
 * los errores de `ObjectStore`. Anota cada lectura y cada cierre.
 */
function fakeObjects(
  options: {
    readonly fail?: (key: string) => unknown;
    /** Se llama en cada lectura, antes de responder: por ejemplo, para que el reloj avance. */
    readonly onGet?: () => void;
    /**
     * Cada lectura queda pendiente, como un cuerpo que se detiene, hasta que se cierran los objetos:
     * entonces rechaza, como el cliente S3 al destruir sus conexiones.
     */
    readonly stall?: boolean;
    readonly stored?: Readonly<Record<string, Uint8Array>>;
  } = {},
) {
  const calls: string[] = [];
  const stored = options.stored ?? {};
  const objects = (location: LogLocation): LogObjects => {
    const stalled: ((error: Error) => void)[] = [];
    return {
      close: () => {
        calls.push(`close:${location.prefix}`);
        for (const reject of stalled.splice(0)) {
          reject(new Error('socket destruido'));
        }
      },
      get: (key, maxBytes) => {
        const full = `${location.prefix}${key}`;
        calls.push(`get:${full}:${String(maxBytes)}`);
        if (options.stall === true) {
          return new Promise<Uint8Array>((_resolve, reject) => {
            stalled.push(reject);
          });
        }
        return storedObject(full, maxBytes);
      },
    };
  };
  /** La respuesta de una lectura con los objetos guardados. */
  const storedObject = (full: string, maxBytes: number): Promise<Uint8Array> => {
    options.onGet?.();
    const error = options.fail?.(full);
    if (error !== undefined) {
      return Promise.reject(error instanceof Error ? error : new Error('fallo sintético'));
    }
    const bytes = stored[full];
    if (bytes === undefined) {
      return Promise.reject(new ObjectReadError('not_found', full));
    }
    if (bytes.byteLength > maxBytes) {
      return Promise.reject(new ObjectReadError('too_large', full));
    }
    return Promise.resolve(bytes);
  };
  return { calls, objects };
}

/** Una ejecución con la base, los procesos y los objetos falsos, con IDs y hora fijos. */
async function run(
  db: ReturnType<typeof fakeDatabase>,
  children: ReturnType<typeof fakeChildren>,
  options: {
    readonly now?: () => string;
    readonly objects?: ReturnType<typeof fakeObjects>;
    readonly scheduler?: Scheduler;
  } = {},
) {
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const forwarded: string[] = [];
  let sequence = 0;
  const result = await runOperations({
    alert: (payload) => alerts.push(payload),
    config: CONFIG,
    database: db.database,
    forwardChildStderr: (text) => forwarded.push(text),
    nextId: () => uuid((sequence += 1)),
    now: options.now ?? (() => NOW),
    objects: (options.objects ?? fakeObjects()).objects,
    runChild: children.runChild,
    scheduler: options.scheduler ?? IDLE_SCHEDULER,
  });
  return {
    alerts,
    forwarded,
    lines: result.lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    result,
  };
}

describe('runOperations: el orden de los pasos (ADR-0018 §11)', () => {
  it('en una base vacía: los roles, el log 1 con sus migraciones y sus privilegios, las contraseñas, la salud del log 1, la verificación y el espacio, con sus informes en ese log', async () => {
    expect(OPERATIONS_STEPS).toEqual(['roles_and_logs', 'health', 'verification', 'space']);
    const db = fakeDatabase({ loggedIn: new Set(), logs: [] });
    const children = fakeChildren((child) =>
      child === 'migrate'
        ? {
            stdout: JSON.stringify({
              applied: ['0001_x.sql', '0006_y.sql'],
              current: [],
              status: 'migrated',
            }),
          }
        : {},
    );
    const { alerts, lines, result } = await run(db, children);

    expect(db.calls).toEqual([
      'roles',
      'list',
      'list',
      'create:1',
      'grant:1',
      'login:buoh_ingesta',
      'password:buoh_ingesta',
      'login:buoh_salud',
      'password:buoh_salud',
      'login:buoh_agente',
      'password:buoh_agente',
      'list',
      'report:1:roles_and_logs',
      'list',
      'report:1:health',
      'list',
      'segments:1:120',
      'list',
      'report:1:verification',
      'list',
      'last:1:space',
      'space',
      'report:1:space',
    ]);
    expect(children.runs.map((item) => [item.child, item.args, item.env])).toEqual([
      ['migrate', [], migrateEnvironment(CONFIG, 'buoh_log_000001')],
      ['health', ['--json', '--log', '1'], healthEnvironment(CONFIG)],
    ]);
    expect(result.status).toBe('completed');
    expect(alerts).toEqual([]);
    expect(lines).toEqual([
      {
        event: 'operations_step',
        log: null,
        report: {
          failures: [],
          migrated: [{ applied: ['0001_x.sql', '0006_y.sql'], log: 1 }],
          passwords_set: ['buoh_ingesta', 'buoh_salud', 'buoh_agente'],
          passwords_unchecked: [],
          prepared: 1,
        },
        run_id: uuid(1),
        status: 'completed',
        step: 'roles_and_logs',
      },
      {
        event: 'operations_step',
        log: 1,
        report: { alerts: [], exit_code: 1, log: 1, report: REPORT },
        run_id: uuid(1),
        status: 'completed',
        step: 'health',
      },
      {
        event: 'operations_step',
        log: null,
        report: { due: 0, mismatched: [], read: 0, slot: 120 },
        run_id: uuid(1),
        status: 'completed',
        step: 'verification',
      },
      {
        event: 'operations_step',
        log: 1,
        report: { database_bytes: 1000, logs: [{ bytes: 100, log: 1 }], measured: true },
        run_id: uuid(1),
        status: 'completed',
        step: 'space',
      },
      {
        event: 'operations_run',
        finished_at_utc: NOW,
        run_id: uuid(1),
        started_at_utc: NOW,
        status: 'completed',
      },
    ]);
    expect(
      db.reports.map(({ log: number, row }) => [number, row.step, row.status, row.run_id]),
    ).toEqual([
      [1, 'roles_and_logs', 'completed', uuid(1)],
      [1, 'health', 'completed', uuid(1)],
      [1, 'verification', 'completed', uuid(1)],
      [1, 'space', 'completed', uuid(1)],
    ]);
    expect(db.reports[1]?.row.report).toEqual({ alerts: [], exit_code: 1, log: 1, report: REPORT });
  });

  it('sin nada que cambiar, migra y da privilegios a cada log, no crea otro ni toca las contraseñas, y no guarda el informe del paso 1', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });
    const children = fakeChildren();
    const { lines, result } = await run(db, children);

    // Los pasos 1 y 2; los siguientes tienen sus propias pruebas.
    expect(db.calls.slice(0, 10)).toEqual([
      'roles',
      'list',
      'grant:1',
      'grant:2',
      'list',
      'login:buoh_ingesta',
      'login:buoh_salud',
      'login:buoh_agente',
      'list',
      'report:1:health',
    ]);
    expect(db.reports.map(({ row }) => row.step)).not.toContain('roles_and_logs');
    expect(children.runs.map((item) => [item.child, item.args])).toEqual([
      ['migrate', []],
      ['migrate', []],
      ['health', ['--json', '--log', '1']],
    ]);
    expect(children.runs.map((item) => item.env['BUOH_POSTGRES_SCHEMA'])).toEqual([
      'buoh_log_000001',
      'buoh_log_000002',
      undefined,
    ]);
    expect(result.status).toBe('completed');
    expect(lines[0]).toMatchObject({
      report: {
        failures: [],
        migrated: [],
        passwords_set: [],
        passwords_unchecked: [],
        prepared: null,
      },
      status: 'completed',
    });
  });

  it('en cuanto el log de mayor número tiene una escritura, prepara el siguiente; la salud sigue en el escrito', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW)],
    });
    const children = fakeChildren();
    const { lines } = await run(db, children);

    expect(db.calls.slice(0, 6)).toEqual([
      'roles',
      'list',
      'grant:1',
      'list',
      'create:2',
      'grant:2',
    ]);
    expect(lines[0]).toMatchObject({ report: { prepared: 2 } });
    expect(children.runs.at(-1)?.args).toEqual(['--json', '--log', '1']);
  });
});

describe('runOperations: un paso que falla no impide los siguientes (ADR-0018 §11)', () => {
  it('una migración rechazada deja el paso failed con el motivo saneado de db:migrate, sin privilegios para ese log, y sigue con los demás, las contraseñas y la salud', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });
    const children = fakeChildren((child) => {
      return child === 'migrate' && children.runs.length === 1
        ? {
            exitCode: 1,
            stderr: '',
            stdout: JSON.stringify({
              code: 'MIGRATION_FAILED',
              migration: '0006_y.sql',
              reason: '42501',
              status: 'failed',
            }),
          }
        : {};
    });
    const { alerts, lines, result } = await run(db, children);

    expect(db.calls).not.toContain('grant:1');
    expect(db.calls).toContain('grant:2');
    expect(db.calls).toContain('report:1:health');
    expect(lines[0]).toMatchObject({
      report: { failures: [{ action: 'migrate', log: 1, reason: '42501' }] },
      status: 'failed',
    });
    expect(lines[1]).toMatchObject({ status: 'completed', step: 'health' });
    expect(result.status).toBe('failed');
    expect(alerts).toEqual([
      { event: 'operations_step_failed', reason: '42501', step: 'roles_and_logs' },
    ]);
    // El informe del paso que falló queda en el log activo; los pasos siguientes siguen.
    expect(db.reports.map(({ row }) => [row.step, row.status])).toEqual([
      ['roles_and_logs', 'failed'],
      ['health', 'completed'],
      ['verification', 'completed'],
      ['space', 'completed'],
    ]);
  });

  it('sin los roles, el paso 1 no sigue; los demás se intentan igual, y sin PostgreSQL no hay dónde guardar los informes', async () => {
    const unavailable = coded('ECONNREFUSED');
    const db = fakeDatabase({
      fail: { ensureRuntimeRoles: unavailable, listLogs: unavailable },
      loggedIn: new Set(),
      logs: [],
    });
    const children = fakeChildren();
    const { alerts, lines, result } = await run(db, children);

    expect(db.calls).toEqual(['roles', 'list', 'list', 'list', 'list', 'list', 'list', 'list']);
    expect(children.runs).toEqual([]);
    expect(lines.slice(0, 2)).toEqual([
      expect.objectContaining({
        report: {
          failures: [{ action: 'ensure_roles', reason: 'ECONNREFUSED' }],
          migrated: [],
          passwords_set: [],
          passwords_unchecked: [],
          prepared: null,
        },
        status: 'failed',
        step: 'roles_and_logs',
      }),
      expect.objectContaining({
        report: { log: null, reason: 'ECONNREFUSED' },
        status: 'failed',
        step: 'health',
      }),
    ]);
    expect(result.status).toBe('failed');
    expect(alerts).toEqual([
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'roles_and_logs' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'roles_and_logs' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'health' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'health' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'verification' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'verification' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'space' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'space' },
    ]);
    expect(lines.slice(2, 4)).toEqual([
      expect.objectContaining({
        report: { due: null, mismatched: [], read: 0, reason: 'ECONNREFUSED', slot: 120 },
        status: 'failed',
        step: 'verification',
      }),
      expect.objectContaining({
        report: { reason: 'ECONNREFUSED' },
        status: 'failed',
        step: 'space',
      }),
    ]);
    expect(JSON.stringify([lines, alerts])).not.toMatch(/pg-sintetico|rol_sintetico|connect/u);
  });

  it('una contraseña que no se puede comprobar es un fallo de ese rol: las de los demás se ponen igual', async () => {
    const db = fakeDatabase({ loggedIn: new Set(), logs: [log(1)] });
    const failing = db.database.checkLogin.bind(db.database);
    db.database.checkLogin = (role, password) =>
      role === 'buoh_salud' ? Promise.reject(coded('57P03')) : failing(role, password);
    const { lines } = await run(db, fakeChildren());

    expect(db.calls.filter((call) => call.startsWith('password:'))).toEqual([
      'password:buoh_ingesta',
      'password:buoh_agente',
    ]);
    expect(lines[0]).toMatchObject({
      report: {
        failures: [{ action: 'password', reason: '57P03', role: 'buoh_salud' }],
        passwords_set: ['buoh_ingesta', 'buoh_agente'],
      },
      status: 'failed',
    });
  });

  it('sin conexiones libres para comprobarla, como con las 4 de buoh_agente abiertas, la contraseña no se pone ni es un fallo: queda en passwords_unchecked', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud']),
      logs: [log(1)],
    });
    const checking = db.database.checkLogin.bind(db.database);
    db.database.checkLogin = (role, password) =>
      role === 'buoh_agente' ? Promise.resolve<LoginCheck>('unchecked') : checking(role, password);
    const { alerts, lines, result } = await run(db, fakeChildren());

    expect(db.calls.filter((call) => call.startsWith('password:'))).toEqual([]);
    expect(lines[0]).toMatchObject({
      report: {
        failures: [],
        passwords_set: [],
        passwords_unchecked: ['buoh_agente'],
      },
      status: 'completed',
    });
    expect(alerts).toEqual([]);
    expect(result.status).toBe('completed');
    // No cambió nada: el informe del paso 1 no se guarda.
    expect(db.reports.map((item) => item.row.step)).toEqual(['health', 'verification', 'space']);
  });
});

describe('runOperations: la salud (ADR-0018 §11, paso 2)', () => {
  const ready = () =>
    fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });

  it('de las alertas de data:health, el informe guarda solo su evento y su motivo saneados', async () => {
    const db = ready();
    const stderr = [
      '{"event":"checkpoint_rejected","reason":"checkpoint_link_mismatch","segment_index":3}',
      '{"event":"data_health_storage_unavailable","reason":"connect ECONNREFUSED 10.0.0.5:5432"}',
      'texto suelto',
      '{"sin":"evento"}',
    ].join('\n');
    const { lines } = await run(
      db,
      fakeChildren((child) => (child === 'health' ? { stderr } : {})),
    );
    expect(lines[1]).toMatchObject({
      report: {
        alerts: [
          { event: 'checkpoint_rejected', reason: 'checkpoint_link_mismatch' },
          { event: 'data_health_storage_unavailable', reason: null },
        ],
      },
    });
  });

  it('una salud que no es healthy no es un fallo; su stderr se reenvía, y el informe se guarda en el log que observó', async () => {
    const db = ready();
    const children = fakeChildren((child) =>
      child === 'health'
        ? { stderr: '{"event":"data_health_failed","reason":"log_not_derivable"}\n' }
        : {},
    );
    const { forwarded, lines } = await run(db, children);
    expect(lines[1]).toMatchObject({
      log: 1,
      report: { alerts: [{ event: 'data_health_failed', reason: 'log_not_derivable' }] },
      status: 'completed',
    });
    expect(forwarded).toEqual(['{"event":"data_health_failed","reason":"log_not_derivable"}\n']);
    expect(
      db.reports
        .filter(({ row }) => row.step === 'health')
        .map(({ log: number, row }) => [number, row.status]),
    ).toEqual([[1, 'completed']]);
  });

  it.each<[string, Partial<ChildResult>, Record<string, unknown>]>([
    [
      'la salida 2, con el código de su línea de error',
      {
        exitCode: 2,
        stderr:
          '{"code":"ConfigError","message":"Configuración inválida o ausente: BUOH_S3_BUCKET.","status":"failed"}\n',
        stdout: '',
      },
      { code: 'ConfigError', exit_code: 2, log: 1, reason: 'health_command_failed' },
    ],
    [
      'una línea que no es un HealthReport',
      { stdout: '{"otro":"informe"}\n' },
      { code: null, exit_code: 1, log: 1, reason: 'health_command_failed' },
    ],
    [
      'dos líneas en stdout',
      { stdout: `${JSON.stringify(REPORT)}\n${JSON.stringify(REPORT)}\n` },
      { code: null, exit_code: 1, log: 1, reason: 'health_command_failed' },
    ],
    [
      'un proceso que no termina en su plazo',
      { exitCode: null, stdout: '', timedOut: true },
      { log: 1, reason: 'child_timeout' },
    ],
  ])('falla con %s, y su informe failed se guarda en el log', async (_label, answer, report) => {
    const db = ready();
    const { alerts, lines, result } = await run(
      db,
      fakeChildren((child) => (child === 'health' ? answer : {})),
    );
    expect(lines[1]).toMatchObject({ report, status: 'failed', step: 'health' });
    expect(result.status).toBe('failed');
    expect(alerts).toEqual([
      expect.objectContaining({ event: 'operations_step_failed', step: 'health' }),
    ]);
    expect(
      db.reports
        .filter(({ row }) => row.step === 'health')
        .map(({ log: number, row }) => [number, row.status]),
    ).toEqual([[1, 'failed']]);
  });

  it('sin log activo, falla con log_not_prepared sin correr data:health', async () => {
    const db = fakeDatabase({
      fail: { createLogSchema: coded('42501') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [],
    });
    const children = fakeChildren();
    const { lines } = await run(db, children);
    expect(children.runs.map((item) => item.child)).toEqual([]);
    expect(lines[1]).toMatchObject({
      log: null,
      report: { log: null, reason: 'log_not_prepared' },
      status: 'failed',
    });
  });

  it('si no se puede guardar un informe, deja la alerta operations_report_unavailable y la ejecución termina failed', async () => {
    const db = fakeDatabase({
      fail: { appendReport: coded('42P01') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });
    const { alerts, lines, result } = await run(db, fakeChildren());
    expect(lines[1]).toMatchObject({ status: 'completed', step: 'health' });
    expect(result.status).toBe('failed');
    expect(alerts).toEqual([
      { event: 'operations_report_unavailable', reason: '42P01', step: 'health' },
      { event: 'operations_report_unavailable', reason: '42P01', step: 'verification' },
      { event: 'operations_report_unavailable', reason: '42P01', step: 'space' },
    ]);
  });
});

describe('verificationSlot: la ejecución del día (ADR-0018 §11, paso 4)', () => {
  it('es 12 h + ⌊m / 5⌋ de la hora UTC, de 0 a 287', () => {
    expect(verificationSlot('2026-03-02T00:00:00.000Z')).toBe(0);
    expect(verificationSlot('2026-03-02T00:04:59.999Z')).toBe(0);
    expect(verificationSlot('2026-03-02T00:05:00.000Z')).toBe(1);
    expect(verificationSlot('2026-03-02T10:00:00.000Z')).toBe(120);
    expect(verificationSlot('2026-03-02T12:30:00.000Z')).toBe(150);
    expect(verificationSlot('2026-03-02T23:59:59.999Z')).toBe(287);
    expect(() => verificationSlot('no es una hora')).toThrow(TypeError);
  });
});

describe('verifySegment: los hashes de un segmento contra su fila (ADR-0018 §11, paso 4)', () => {
  const { physical, row } = segment(7);
  /** Los objetos del log 1 con `bytes` bajo la clave de la fila `target`. */
  const only = (bytes: Uint8Array, target: DueSegment = row) =>
    fakeObjects({ stored: { [segmentKey(1, target)]: bytes } });
  const verify = (bytes: Uint8Array | null, target: DueSegment = row) =>
    verifySegment(
      (bytes === null ? fakeObjects() : only(bytes, target)).objects(logLocation(1)),
      target,
    );

  it('coincide con el mismo objeto, leído como mucho hasta el tamaño de su fila', async () => {
    const objects = only(physical);
    expect(await verifySegment(objects.objects(logLocation(1)), row)).toBeNull();
    expect(objects.calls).toEqual([`get:${segmentKey(1, row)}:${String(row.object_size_bytes)}`]);
  });

  it('un objeto que falta, mayor que su fila o con otros bytes no coincide', async () => {
    expect(await verify(null)).toBe('object_missing');
    expect(await verify(new Uint8Array([...physical, 0]))).toBe('object_too_large');
    const altered = physical.slice();
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 0xff;
    expect(await verify(altered)).toBe('object_sha256_mismatch');
  });

  it('con el objeto de su fila, un contenido que no se descomprime, o de más de 64 MiB, o con otro hash lógico no coincide', async () => {
    const notGzip = new TextEncoder().encode('no es gzip');
    expect(
      await verify(notGzip, {
        ...row,
        object_bytes_sha256: sha256Hex(notGzip),
        object_size_bytes: notGzip.byteLength,
      }),
    ).toBe('segment_not_decompressible');
    const bomb = new Uint8Array(gzipSync(new Uint8Array(64 * 1024 * 1024 + 1)));
    expect(
      await verify(bomb, {
        ...row,
        object_bytes_sha256: sha256Hex(bomb),
        object_size_bytes: bomb.byteLength,
      }),
    ).toBe('segment_not_decompressible');
    expect(await verify(physical, { ...row, logical_content_sha256: '0'.repeat(64) })).toBe(
      'logical_sha256_mismatch',
    );
  });

  it('sin comprimir, el contenido es el objeto', async () => {
    const text = new TextEncoder().encode('{"segmento":8}\n');
    const plain: DueSegment = {
      compression: 'none',
      logical_content_sha256: sha256Hex(text),
      object_bytes_sha256: sha256Hex(text),
      object_size_bytes: text.byteLength,
      segment_index: 8,
    };
    expect(await verify(text, plain)).toBeNull();
  });

  it('si el almacenamiento no responde, rechaza con su error', async () => {
    const timeout = Object.assign(new Error('socket hang up 10.0.0.9'), { code: 'ETIMEDOUT' });
    await expect(
      verifySegment(fakeObjects({ fail: () => timeout }).objects(logLocation(1)), row),
    ).rejects.toBe(timeout);
  });
});

describe('runOperations: la verificación por partes (ADR-0018 §11, paso 4)', () => {
  const ON_TIME = '2026-03-02T09:00:00.000Z';
  const EXPIRED = '2026-01-20T00:00:00.000Z';
  const ready = (segments: Readonly<Record<number, readonly DueSegment[]>>) =>
    fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [
        log(1, EXPIRED),
        log(2, ON_TIME),
        { lastWriteUtc: null, location: logLocation(3), readable: false },
        log(4),
      ],
      segments,
    });
  const verificationLine = (lines: Record<string, unknown>[]) =>
    lines.find((line) => line['step'] === 'verification');

  it('de cada log que se puede leer y no ha vencido, vuelve a leer los segmentos i con i mod 288 = la ejecución, y guarda cuántos leyó en el log activo', async () => {
    const first = segment(120);
    const next = segment(408);
    const db = ready({
      1: [segmentRow(120)],
      2: [first.row, next.row, segmentRow(121)],
      4: [],
    });
    const objects = fakeObjects({
      stored: {
        [segmentKey(2, first.row)]: first.physical,
        [segmentKey(2, next.row)]: next.physical,
      },
    });
    const { alerts, lines, result } = await run(db, fakeChildren(), { objects });

    expect(db.calls.filter((call) => call.startsWith('segments:'))).toEqual([
      'segments:2:120',
      'segments:4:120',
    ]);
    expect(objects.calls).toEqual([
      `get:${segmentKey(2, first.row)}:${String(first.row.object_size_bytes)}`,
      `get:${segmentKey(2, next.row)}:${String(next.row.object_size_bytes)}`,
      'close:logs/000002/',
    ]);
    expect(verificationLine(lines)).toMatchObject({
      log: null,
      report: { due: 2, mismatched: [], read: 2, slot: 120 },
      status: 'completed',
    });
    expect(alerts).toEqual([]);
    expect(result.status).toBe('completed');
    expect(
      db.reports
        .filter(({ row }) => row.step === 'verification')
        .map(({ log: number, row }) => [number, row.status]),
    ).toEqual([[2, 'completed']]);
  });

  it('un segmento que no coincide va al informe y deja la alerta operations_segment_mismatch; es un resultado, no un fallo', async () => {
    const missing = segment(120);
    const altered = segment(408);
    const changed = altered.physical.slice();
    changed[0] = (changed[0] ?? 0) ^ 0xff;
    const db = ready({ 2: [missing.row, altered.row] });
    const objects = fakeObjects({ stored: { [segmentKey(2, altered.row)]: changed } });
    const { alerts, lines, result } = await run(db, fakeChildren(), { objects });

    expect(verificationLine(lines)).toMatchObject({
      report: {
        due: 2,
        mismatched: [
          { log: 2, reason: 'object_missing', segment_index: 120 },
          { log: 2, reason: 'object_sha256_mismatch', segment_index: 408 },
        ],
        read: 2,
        slot: 120,
      },
      status: 'completed',
    });
    expect(alerts).toEqual([
      {
        event: 'operations_segment_mismatch',
        log: '2',
        reason: 'object_missing',
        segment_index: '120',
      },
      {
        event: 'operations_segment_mismatch',
        log: '2',
        reason: 'object_sha256_mismatch',
        segment_index: '408',
      },
    ]);
    expect(result.status).toBe('completed');
  });

  it('si el almacenamiento no responde, el paso falla con el motivo saneado y no lee los demás; el espacio se mide igual', async () => {
    const first = segment(120);
    const db = ready({ 2: [first.row, segmentRow(408)] });
    const timeout = Object.assign(new Error('connect ETIMEDOUT 10.0.0.9:443'), {
      code: 'ETIMEDOUT',
    });
    const objects = fakeObjects({ fail: () => timeout });
    const { alerts, lines, result } = await run(db, fakeChildren(), { objects });

    expect(objects.calls).toEqual([
      `get:${segmentKey(2, first.row)}:${String(first.row.object_size_bytes)}`,
      'close:logs/000002/',
    ]);
    expect(verificationLine(lines)).toMatchObject({
      report: {
        due: 2,
        log: 2,
        mismatched: [],
        read: 0,
        reason: 'ETIMEDOUT',
        segment_index: 120,
        slot: 120,
      },
      status: 'failed',
    });
    expect(alerts).toEqual([
      { event: 'operations_step_failed', reason: 'ETIMEDOUT', step: 'verification' },
    ]);
    expect(lines.find((line) => line['step'] === 'space')).toMatchObject({ status: 'completed' });
    expect(result.status).toBe('failed');
    // Ni el mensaje del error ni la dirección: solo su código.
    expect(JSON.stringify([lines, alerts])).not.toMatch(/10\.0\.0\.9|connect ETIMEDOUT/u);
  });

  it('si PostgreSQL no responde al buscar los segmentos, falla sin abrir ningún objeto', async () => {
    const db = ready({ 2: [segmentRow(120)] });
    db.database.listSegmentsDue = () => Promise.reject(coded('57P01'));
    const objects = fakeObjects();
    const { lines } = await run(db, fakeChildren(), { objects });

    expect(objects.calls).toEqual([]);
    expect(verificationLine(lines)).toMatchObject({
      report: { due: null, mismatched: [], read: 0, reason: '57P01', slot: 120 },
      status: 'failed',
    });
  });

  it(`para a los ${String(VERIFICATION_DEADLINE_MS / 1000)} s con deadline_exceeded: lo que queda espera a su ejecución del día siguiente`, async () => {
    const segments = [segment(120), segment(408), segment(696)];
    const db = ready({ 2: segments.map((item) => item.row) });
    let time = Date.parse(NOW);
    const objects = fakeObjects({
      onGet: () => {
        time += 40_000;
      },
      stored: Object.fromEntries(segments.map((item) => [segmentKey(2, item.row), item.physical])),
    });
    const { lines } = await run(db, fakeChildren(), {
      now: () => new Date(time).toISOString(),
      objects,
    });

    expect(objects.calls.filter((call) => call.startsWith('get:'))).toHaveLength(2);
    expect(objects.calls.at(-1)).toBe('close:logs/000002/');
    expect(verificationLine(lines)).toMatchObject({
      report: { due: 3, mismatched: [], read: 2, reason: 'deadline_exceeded', slot: 120 },
      status: 'failed',
    });
  });

  it('una lectura que no termina, como un cuerpo que se detiene, se corta al vencer el plazo: cierra los objetos del log, falla con deadline_exceeded y la ejecución sigue', async () => {
    const stalled = segment(120);
    const db = ready({ 2: [stalled.row, segmentRow(408)] });
    const clock = new ManualClock(NOW);
    const objects = fakeObjects({ stall: true });
    const running = run(db, fakeChildren(), {
      now: clock.now,
      objects,
      scheduler: clock.scheduler,
    });
    for (let i = 0; i < 100 && !objects.calls.some((call) => call.startsWith('get:')); i += 1) {
      await flush();
    }
    expect(clock.pendingDelays()).toEqual([VERIFICATION_DEADLINE_MS]);
    await clock.advance(VERIFICATION_DEADLINE_MS);
    const { alerts, lines, result } = await running;

    // Se cierra una sola vez, y la lectura que rechaza después de cerrar no deja nada sin capturar.
    expect(objects.calls).toEqual([
      `get:${segmentKey(2, stalled.row)}:${String(stalled.row.object_size_bytes)}`,
      'close:logs/000002/',
    ]);
    expect(verificationLine(lines)).toMatchObject({
      report: {
        due: 2,
        log: 2,
        mismatched: [],
        read: 0,
        reason: 'deadline_exceeded',
        segment_index: 120,
        slot: 120,
      },
      status: 'failed',
    });
    expect(alerts).toEqual([
      { event: 'operations_step_failed', reason: 'deadline_exceeded', step: 'verification' },
    ]);
    expect(lines.find((line) => line['step'] === 'space')).toMatchObject({ status: 'completed' });
    expect(result.status).toBe('failed');
  });

  it('una lectura que termina a tiempo cancela su plazo', async () => {
    const first = segment(120);
    const db = ready({ 2: [first.row] });
    const clock = new ManualClock(NOW);
    const objects = fakeObjects({ stored: { [segmentKey(2, first.row)]: first.physical } });
    const { lines } = await run(db, fakeChildren(), {
      now: clock.now,
      objects,
      scheduler: clock.scheduler,
    });
    expect(verificationLine(lines)).toMatchObject({ report: { read: 1 }, status: 'completed' });
    expect(clock.pendingDelays()).toEqual([]);
  });
});

describe('runOperations: el espacio, una vez al día (ADR-0018 §11, paso 5, y §7)', () => {
  const state = () => ({
    loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
    logs: [log(1, NOW), log(2)],
    space: {
      database_bytes: 52_428_800,
      logs: [
        { bytes: 41_943_040, log: 1 },
        { bytes: 98_304, log: 2 },
      ],
    },
  });
  const spaceLine = (lines: Record<string, unknown>[]) =>
    lines.find((line) => line['step'] === 'space');

  it('mide la base y cada log y guarda el informe en el log activo; el mismo día UTC no vuelve a medir ni guarda nada', async () => {
    const db = fakeDatabase(state());
    const first = await run(db, fakeChildren());
    expect(spaceLine(first.lines)).toMatchObject({
      log: 1,
      report: {
        database_bytes: 52_428_800,
        logs: [
          { bytes: 41_943_040, log: 1 },
          { bytes: 98_304, log: 2 },
        ],
        measured: true,
      },
      status: 'completed',
    });

    const later = '2026-03-02T23:59:00.000Z';
    const second = await run(db, fakeChildren(), { now: () => later });
    expect(spaceLine(second.lines)).toMatchObject({
      log: 1,
      report: { last_measured_at_utc: NOW, measured: false },
      status: 'completed',
    });
    expect(db.calls.filter((call) => call === 'space')).toHaveLength(1);
    expect(db.reports.filter(({ row }) => row.step === 'space')).toHaveLength(1);
  });

  it('al día UTC siguiente vuelve a medir', async () => {
    const db = fakeDatabase(state());
    await run(db, fakeChildren());
    const third = await run(db, fakeChildren(), { now: () => '2026-03-03T00:00:00.000Z' });
    expect(spaceLine(third.lines)).toMatchObject({ report: { measured: true } });
    expect(db.calls.filter((call) => call === 'space')).toHaveLength(2);
  });

  it('una medida que falla deja su informe failed y se vuelve a intentar en la ejecución siguiente', async () => {
    const current: Parameters<typeof fakeDatabase>[0] = {
      ...state(),
      fail: { measureSpace: coded('57P01') },
    };
    const db = fakeDatabase(current);
    const first = await run(db, fakeChildren());
    expect(spaceLine(first.lines)).toMatchObject({
      report: { reason: '57P01' },
      status: 'failed',
    });
    expect(first.alerts).toEqual([
      { event: 'operations_step_failed', reason: '57P01', step: 'space' },
    ]);
    current.fail = {};
    const second = await run(db, fakeChildren());
    expect(spaceLine(second.lines)).toMatchObject({ report: { measured: true } });
    expect(
      db.reports.filter(({ row }) => row.step === 'space').map(({ row }) => row.status),
    ).toEqual(['failed', 'completed']);
  });
});

describe('operationsCommand', () => {
  it('con una configuración inválida sale con 2 y una línea ConfigError, sin abrir la base', async () => {
    let opened = false;
    const result = await operationsCommand(
      { ...ENV, BUOH_DUENO_POSTGRES_PASSWORD: undefined },
      {
        alert: () => undefined,
        forwardChildStderr: () => undefined,
        nextId: () => uuid(1),
        now: () => NOW,
        openDatabase: () => {
          opened = true;
          return fakeDatabase({ loggedIn: new Set(), logs: [] }).database;
        },
        openObjects: (_config, location) => {
          opened = true;
          return fakeObjects().objects(location);
        },
        runChild: fakeChildren().runChild,
        scheduler: IDLE_SCHEDULER,
      },
    );
    expect(result).toEqual({
      exitCode: 2,
      lines: [
        JSON.stringify({
          code: 'ConfigError',
          message: 'Configuración inválida o ausente: BUOH_DUENO_POSTGRES_PASSWORD.',
          status: 'failed',
        }),
      ],
    });
    expect(opened).toBe(false);
  });

  it('sale con 0 si todo terminó y con 1 si un paso falló, y cierra la base siempre', async () => {
    for (const [logs, exitCode] of [
      [[log(1, NOW), log(2)], 0],
      [[], 1],
    ] as const) {
      const db = fakeDatabase({
        fail: logs.length === 0 ? { createLogSchema: coded('42501') } : {},
        loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
        logs: [...logs],
      });
      let sequence = 0;
      const result = await operationsCommand(ENV, {
        alert: () => undefined,
        forwardChildStderr: () => undefined,
        nextId: () => uuid((sequence += 1)),
        now: () => NOW,
        openDatabase: () => db.database,
        openObjects: (_config, location) => fakeObjects().objects(location),
        runChild: fakeChildren().runChild,
        scheduler: IDLE_SCHEDULER,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(db.calls.at(-1)).toBe('close');
    }
  });

  it('abre los objetos de cada log con el token operaciones de la configuración', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW)],
      segments: { 1: [segmentRow(120)] },
    });
    const opened: { log: string; objects: unknown }[] = [];
    let sequence = 0;
    await operationsCommand(ENV, {
      alert: () => undefined,
      forwardChildStderr: () => undefined,
      nextId: () => uuid((sequence += 1)),
      now: () => NOW,
      openDatabase: () => db.database,
      openObjects: (config, location) => {
        opened.push({ log: location.prefix, objects: config.operationsObjects });
        return fakeObjects().objects(location);
      },
      runChild: fakeChildren().runChild,
      scheduler: IDLE_SCHEDULER,
    });
    expect(opened).toEqual([{ log: 'logs/000001/', objects: CONFIG.operationsObjects }]);
  });
});

describe('runNodeScript: un proceso aparte con su entorno y su plazo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'buoh-operaciones-'));
  const script = (name: string, source: string): string => {
    const path = join(directory, name);
    writeFileSync(path, source);
    return path;
  };

  it('el proceso recibe exactamente el entorno dado, los tamaños de V8 y sus argumentos, y nada del entorno de quien lo lanza', async () => {
    const path = script(
      'entorno.mjs',
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env, flags: process.execArgv })); process.stderr.write("aviso"); process.exitCode = 3;',
    );
    const result = await runNodeScript({
      args: ['--json', '--log', '2'],
      env: { BUOH_POSTGRES_USER: 'buoh_salud' },
      nodeFlags: ['--max-semi-space-size=1', '--max-old-space-size=256'],
      script: path,
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({ exitCode: 3, stderr: 'aviso', timedOut: false });
    const seen = JSON.parse(result.stdout) as {
      argv: string[];
      env: Record<string, string>;
      flags: string[];
    };
    expect(seen.argv).toEqual(['--json', '--log', '2']);
    expect(seen.flags).toEqual(['--max-semi-space-size=1', '--max-old-space-size=256']);
    expect(seen.env).toEqual({ BUOH_POSTGRES_USER: 'buoh_salud' });
  });

  it('un proceso que no termina en su plazo se corta con SIGKILL', async () => {
    const path = script('lento.mjs', 'setTimeout(() => undefined, 60_000);');
    const result = await runNodeScript({
      args: [],
      env: {},
      nodeFlags: [],
      script: path,
      timeoutMs: 200,
    });
    expect(result).toEqual({ exitCode: null, stderr: '', stdout: '', timedOut: true });
  });

  it('de stdout y de stderr guarda como mucho 1 MiB de cada uno', async () => {
    const path = script(
      'grande.mjs',
      'const text = "x".repeat(1536 * 1024); process.stdout.write(text); process.stderr.write(text);',
    );
    const result = await runNodeScript({
      args: [],
      env: {},
      nodeFlags: [],
      script: path,
      timeoutMs: 30_000,
    });
    expect(CHILD_OUTPUT_LIMIT_BYTES).toBe(1024 * 1024);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(CHILD_OUTPUT_LIMIT_BYTES);
    expect(result.stderr).toHaveLength(CHILD_OUTPUT_LIMIT_BYTES);
  });
});

describe('workerChildScript: el proceso de cada comando del worker (ADR-0018 §11)', () => {
  const env = { BUOH_POSTGRES_USER: 'buoh_salud' };

  it('data:health corre su CLI con WORKER_NODE_FLAGS, 60 s de plazo, sus argumentos y el entorno dado', () => {
    expect(workerChildScript('health', ['--json', '--log', '1'], env)).toEqual({
      args: ['--json', '--log', '1'],
      env,
      nodeFlags: WORKER_NODE_FLAGS,
      script: fileURLToPath(new URL('../src/cli/health.js', import.meta.url)),
      timeoutMs: 60_000,
    });
  });

  it('db:migrate corre su CLI con WORKER_NODE_FLAGS y 120 s de plazo', () => {
    expect(workerChildScript('migrate', [], env)).toEqual({
      args: [],
      env,
      nodeFlags: WORKER_NODE_FLAGS,
      script: fileURLToPath(new URL('../src/cli/migrate.js', import.meta.url)),
      timeoutMs: 120_000,
    });
  });
});

// `LogLocation` se usa en los tipos de las bases falsas.
export type { LogLocation };
