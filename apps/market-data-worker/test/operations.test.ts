import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type HealthReport } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  healthEnvironment,
  loadOperationsConfig,
  logLocation,
  migrateEnvironment,
  nextLogToPrepare,
  OPERATIONS_STEPS,
  operationsCommand,
  runNodeScript,
  runOperations,
  type CaptureLog,
  type ChildResult,
  type LogLocation,
  type OperationalAlert,
  type OperationsReportRow,
  type OwnerDatabase,
  type RunChild,
} from '../src/index.js';
import { uuid } from './support/connection-harness.js';

// `buoh-operaciones` (ADR-0018 §11) sin servicios: una base falsa, procesos falsos, IDs y reloj
// inyectados. Los vectores salen de §6, §8 y §11: el orden de los pasos, el entorno explícito de
// cada proceso, el log siguiente, las contraseñas y un paso que falla sin impedir los siguientes.
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
};
const CONFIG = loadOperationsConfig(ENV);
const NOW = '2026-03-02T10:00:00.000Z';

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

describe('loadOperationsConfig (ADR-0018 §11)', () => {
  it('lee la credencial dueña, las contraseñas de los roles y el token salud con sus propios nombres', () => {
    expect(CONFIG).toEqual({
      healthObjects: {
        accessKeyId: 'clave-salud-sintetica',
        bucket: 'buoh-captura',
        endpoint: 'https://cuenta-sintetica.r2.invalid',
        region: 'auto',
        secretAccessKey: 'secreto-salud-sintetico',
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
    ]) {
      expect(Object.values(env)).not.toContain(secret);
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

/** Una base falsa: anota cada llamada y responde con `state`. */
function fakeDatabase(state: {
  logs: CaptureLog[];
  /** Los roles que inician sesión con su contraseña. */
  loggedIn: Set<string>;
  fail?: Partial<Record<keyof OwnerDatabase, unknown>>;
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
    canLogin: (role) => {
      calls.push(`login:${role}`);
      return answer('canLogin', () => state.loggedIn.has(role));
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
    listLogs: () => {
      calls.push('list');
      return answer('listLogs', () => [...state.logs]);
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

/** Una ejecución con la base y los procesos falsos, con IDs y hora fijos. */
async function run(db: ReturnType<typeof fakeDatabase>, children: ReturnType<typeof fakeChildren>) {
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const forwarded: string[] = [];
  let sequence = 0;
  const result = await runOperations({
    alert: (payload) => alerts.push(payload),
    config: CONFIG,
    database: db.database,
    forwardChildStderr: (text) => forwarded.push(text),
    nextId: () => uuid((sequence += 1)),
    now: () => NOW,
    runChild: children.runChild,
  });
  return {
    alerts,
    forwarded,
    lines: result.lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    result,
  };
}

describe('runOperations: el orden de los pasos (ADR-0018 §11)', () => {
  it('en una base vacía: los roles, el log 1 con sus migraciones y sus privilegios, las contraseñas y después la salud del log 1, con su informe en ese log', async () => {
    expect(OPERATIONS_STEPS).toEqual(['roles_and_logs', 'health']);
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

    expect(db.calls).toEqual([
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
      report: { failures: [], migrated: [], passwords_set: [], prepared: null },
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
    // El informe del paso que falló queda en el log activo.
    expect(db.reports.map(({ row }) => [row.step, row.status])).toEqual([
      ['roles_and_logs', 'failed'],
      ['health', 'completed'],
    ]);
  });

  it('sin los roles, el paso 1 no sigue; la salud se intenta igual, y sin PostgreSQL no hay dónde guardar los informes', async () => {
    const unavailable = coded('ECONNREFUSED');
    const db = fakeDatabase({
      fail: { ensureRuntimeRoles: unavailable, listLogs: unavailable },
      loggedIn: new Set(),
      logs: [],
    });
    const children = fakeChildren();
    const { alerts, lines, result } = await run(db, children);

    expect(db.calls).toEqual(['roles', 'list', 'list', 'list']);
    expect(children.runs).toEqual([]);
    expect(lines.slice(0, 2)).toEqual([
      expect.objectContaining({
        report: {
          failures: [{ action: 'ensure_roles', reason: 'ECONNREFUSED' }],
          migrated: [],
          passwords_set: [],
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
    ]);
    expect(JSON.stringify([lines, alerts])).not.toMatch(/pg-sintetico|rol_sintetico|connect/u);
  });

  it('una contraseña que no se puede comprobar es un fallo de ese rol: las de los demás se ponen igual', async () => {
    const db = fakeDatabase({ loggedIn: new Set(), logs: [log(1)] });
    const failing = db.database.canLogin.bind(db.database);
    db.database.canLogin = (role, password) =>
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
    expect(db.reports.map(({ log: number, row }) => [number, row.step])).toEqual([[1, 'health']]);
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
    expect(alerts.at(-1)).toMatchObject({ event: 'operations_step_failed', step: 'health' });
    expect(db.reports.map(({ row }) => [row.step, row.status])).toEqual([['health', 'failed']]);
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
    ]);
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
        runChild: fakeChildren().runChild,
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
        runChild: fakeChildren().runChild,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(db.calls.at(-1)).toBe('close');
    }
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
});

// `LogLocation` se usa en los tipos de las bases falsas.
export type { LogLocation };
