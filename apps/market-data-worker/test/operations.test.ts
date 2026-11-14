import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gzipSync } from 'node:zlib';

import { canonicalJson, sha256Hex, type HealthReport, type JsonValue } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  apiMigrateEnvironment,
  CHILD_OUTPUT_LIMIT_BYTES,
  ConfigError,
  derivLogProfileRow,
  healthEnvironment,
  loadOperationsConfig,
  logLocation,
  migrateEnvironment,
  nextLogToPrepare,
  publishEnvironment,
  replayEnvironment,
  ObjectReadError,
  OPERATIONS_STEPS,
  operationsCommand,
  parseStoredHealthObservation,
  RETENTION_DEADLINE_MS,
  RETENTION_PAGE_KEYS,
  runNodeScript,
  runOperations,
  VERIFICATION_DEADLINE_MS,
  verificationSlot,
  verifySegment,
  WORKER_NODE_FLAGS,
  workerChildScript,
  type CaptureLog,
  type ChildResult,
  type DatasetVerificationRow,
  type DueSegment,
  type LogDeletion,
  type LogLocation,
  type LoginCheck,
  type LogProfileAssignment,
  type LogObjects,
  type LogSchemaDrop,
  type OperationalAlert,
  type OperationsConfig,
  type OperationsReportRow,
  type OwnerDatabase,
  type RunChild,
  type SpaceMeasure,
} from '../src/index.js';
import type { Scheduler } from '../src/deriv/ports.js';
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
/** La contraseña de `buoh_api`, que el Blueprint le da a `buoh-operaciones` desde el PR 6 de ADR-0019 §14. */
const API_PASSWORD = 'api-sintetica-0123456789';
const API_CONFIG = loadOperationsConfig({ ...ENV, BUOH_API_POSTGRES_PASSWORD: API_PASSWORD });
/**
 * La contraseña de `buoh_api_lectura`, que el Blueprint le da a `buoh-operaciones` desde el primer PR
 * de las lecturas de F2.4 (ADR-0019 §8).
 */
const READER_PASSWORD = 'lectura-sintetica-0123456789';
const READER_CONFIG = loadOperationsConfig({
  ...ENV,
  BUOH_API_LECTURA_POSTGRES_PASSWORD: READER_PASSWORD,
});
/** Con las dos contraseñas de la API, como en producción desde ese PR. */
const API_AND_READER_CONFIG = loadOperationsConfig({
  ...ENV,
  BUOH_API_LECTURA_POSTGRES_PASSWORD: READER_PASSWORD,
  BUOH_API_POSTGRES_PASSWORD: API_PASSWORD,
});
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
      apiPassword: null,
      apiReaderPassword: null,
      codeVersion: null,
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
      publicationPassword: null,
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

  it('la contraseña de buoh_api es opcional hasta el PR 6 de ADR-0019 §14, con las reglas de las demás', () => {
    expect(API_CONFIG).toEqual({ ...CONFIG, apiPassword: API_PASSWORD });
    expect(rejected({ ...ENV, BUOH_API_POSTGRES_PASSWORD: 'corta' })).toEqual([
      'BUOH_API_POSTGRES_PASSWORD',
    ]);
    expect(rejected({ ...ENV, BUOH_API_POSTGRES_PASSWORD: 'con espacios dentro 123' })).toEqual([
      'BUOH_API_POSTGRES_PASSWORD',
    ]);
    expect(rejected({ BUOH_API_POSTGRES_PASSWORD: 'corta' })).toEqual(
      [...Object.keys(ENV), 'BUOH_API_POSTGRES_PASSWORD'].sort(),
    );
  });

  it('la contraseña de buoh_api_lectura es opcional, con las reglas de las demás (ADR-0019 §8)', () => {
    expect(READER_CONFIG).toEqual({ ...CONFIG, apiReaderPassword: READER_PASSWORD });
    expect(API_AND_READER_CONFIG).toEqual({
      ...CONFIG,
      apiPassword: API_PASSWORD,
      apiReaderPassword: READER_PASSWORD,
    });
    expect(rejected({ ...ENV, BUOH_API_LECTURA_POSTGRES_PASSWORD: 'corta' })).toEqual([
      'BUOH_API_LECTURA_POSTGRES_PASSWORD',
    ]);
    expect(
      rejected({ ...ENV, BUOH_API_LECTURA_POSTGRES_PASSWORD: 'con espacios dentro 123' }),
    ).toEqual(['BUOH_API_LECTURA_POSTGRES_PASSWORD']);
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

  it('el db:migrate de la API recibe solo la credencial dueña y el rol dueño: ni la contraseña de buoh_api, ni un esquema, ni un token', () => {
    const env = apiMigrateEnvironment(API_CONFIG);
    expect(env).toEqual({
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
      BUOH_POSTGRES_OWNER_ROLE: 'buoh_dueno',
      BUOH_POSTGRES_PASSWORD: 'dueno-sintetico',
      BUOH_POSTGRES_PORT: '5432',
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: 'buoh',
    });
    for (const secret of [
      API_PASSWORD,
      'agente-sintetico-0123456789',
      'ingesta-sintetica-0123456789',
      'salud-sintetica-0123456789',
      'clave-salud-sintetica',
      'secreto-operaciones-sintetico',
    ]) {
      expect(Object.values(env)).not.toContain(secret);
    }
  });

  it('ningún proceso recibe las contraseñas de buoh_api ni de buoh_api_lectura', () => {
    for (const env of [
      migrateEnvironment(API_AND_READER_CONFIG, 'buoh_log_000001'),
      apiMigrateEnvironment(API_AND_READER_CONFIG),
      healthEnvironment(API_AND_READER_CONFIG),
    ]) {
      expect(Object.values(env)).not.toContain(API_PASSWORD);
      expect(Object.values(env)).not.toContain(READER_PASSWORD);
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
  /**
   * Lo que responde el borrado del esquema de un log vencido. Sin él, lo borra: el log deja de
   * existir, como tras `DROP SCHEMA`.
   */
  dropResult?: LogSchemaDrop;
  /** Los segmentos cerrados de cada log, por su número. */
  segments?: Readonly<Record<number, readonly DueSegment[]>>;
  space?: SpaceMeasure;
  /** Las publicaciones activas de `production`, en orden de publicación (ADR-0020 §8, paso 7). */
  publications?: readonly { dataset_id: string; publication_id: string }[];
  /**
   * Los logs en los que `buoh_ingesta` todavía no tiene el uso del esquema, por su número. Sin él,
   * ninguno: los de `logs` ya están preparados. Un log que crea `createLogSchema` entra, y sale con
   * `grantLogPrivileges`.
   */
  ungranted?: Set<number>;
}) {
  const calls: string[] = [];
  const ungranted = state.ungranted ?? new Set<number>();
  /** La fila de `log_quality_profile` de cada log, por su número (ADR-0020 §4). */
  const profiles = new Map<number, LogProfileAssignment>();
  /** La hora con la que se pidió borrar cada esquema. */
  const drops: { log: number; now: string }[] = [];
  const reports: { log: number; row: OperationsReportRow }[] = [];
  const verifications: DatasetVerificationRow[] = [];
  const answer = <T>(name: keyof OwnerDatabase, value: () => T): Promise<T> => {
    const error = state.fail?.[name];
    if (error !== undefined) {
      return Promise.reject(error instanceof Error ? error : new Error('fallo sintético'));
    }
    return Promise.resolve(value());
  };
  const database: OwnerDatabase = {
    appendDatasetVerification: (row) => {
      calls.push(`verification:${row.mode}`);
      return answer('appendDatasetVerification', () => {
        verifications.push(row);
      });
    },
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
        ungranted.add(target.number);
      });
    },
    dropExpiredLog: (target, now) => {
      calls.push(`drop:${String(target.number)}`);
      drops.push({ log: target.number, now });
      return answer('dropExpiredLog', () => {
        if (state.dropResult !== undefined) {
          return state.dropResult;
        }
        const index = state.logs.findIndex((item) => item.location.number === target.number);
        if (index < 0) {
          return 'absent';
        }
        state.logs.splice(index, 1);
        return 'dropped';
      });
    },
    ensureApiReaderRole: () => {
      calls.push('api_reader_role');
      return answer('ensureApiReaderRole', () => undefined);
    },
    ensureApiRole: () => {
      calls.push('api_role');
      return answer('ensureApiRole', () => undefined);
    },
    ensurePublicationRole: () => {
      calls.push('publication_role');
      return answer('ensurePublicationRole', () => undefined);
    },
    ensureRuntimeRoles: () => {
      calls.push('roles');
      return answer('ensureRuntimeRoles', () => undefined);
    },
    grantApiPrivileges: () => {
      calls.push('api_grant');
      return answer('grantApiPrivileges', () => undefined);
    },
    grantDatasetsPrivileges: () => {
      calls.push('datasets_grant');
      return answer('grantDatasetsPrivileges', () => undefined);
    },
    grantLogPrivileges: (target) => {
      calls.push(`grant:${String(target.number)}`);
      return answer('grantLogPrivileges', () => {
        ungranted.delete(target.number);
      });
    },
    assignLogProfile: (target, row) => {
      calls.push(`profile:${String(target.number)}`);
      return answer('assignLogProfile', () => {
        const current = state.logs.find((item) => item.location.number === target.number);
        if (
          profiles.has(target.number) ||
          !ungranted.has(target.number) ||
          (current?.lastWriteUtc ?? null) !== null
        ) {
          return false;
        }
        profiles.set(target.number, row);
        return true;
      });
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
    latestReportWithState: (target, step) => {
      calls.push(`latest:${String(target.number)}:${step}`);
      return answer('latestReportWithState', () => {
        const found = reports
          .filter(
            (item) =>
              item.log === target.number && item.row.step === step && 'state' in item.row.report,
          )
          .map((item) => item.row)
          .sort((left, right) => left.report_id.localeCompare(right.report_id))
          .at(-1);
        return found === undefined
          ? null
          : {
              report: JSON.parse(JSON.stringify(found.report)) as JsonValue,
              report_id: found.report_id,
              status: found.status,
            };
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
    nextPublicationToVerify: () => {
      calls.push('to_verify');
      return answer('nextPublicationToVerify', () => {
        for (const publication of state.publications ?? []) {
          const modes = [
            ...new Set(
              verifications
                .filter((row) => row.publication_id === publication.publication_id)
                .map((row) => row.mode),
            ),
          ].sort();
          if (modes.length < 2) {
            return { ...publication, modes_done: modes };
          }
        }
        return null;
      });
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
  return { calls, database, drops, profiles, reports, verifications };
}

const coded = (code: string) =>
  Object.assign(new Error(`connect ${code} pg-sintetico.invalid rol_sintetico`), { code });

/** Procesos falsos: anota cada uno con sus argumentos y su entorno, y responde con `answer`. */
function fakeChildren(
  answer: (child: string, args: readonly string[]) => Partial<ChildResult> = () => ({}),
) {
  const runs: {
    args: readonly string[];
    child: string;
    env: Readonly<Record<string, string>>;
    timeoutMs?: number;
  }[] = [];
  const runChild: RunChild = (child, args, env, options) => {
    runs.push({
      args,
      child,
      env,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const defaults: ChildResult =
      child === 'migrate' || child === 'api_migrate' || child === 'datasets_migrate'
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

/**
 * Los objetos falsos de la retención: las claves completas guardadas (prefijo del log y clave), que
 * se listan en orden, como en S3. Una clave de `locked` responde como la regla de bloqueo del bucket
 * mientras siga ahí. Anota cada listado, cada borrado y cada cierre.
 */
function fakeDeletion(
  options: {
    /** El error de un listado (`list`) o del borrado de una clave completa (`delete:<clave>`). */
    readonly fail?: (call: string) => unknown;
    readonly keys?: readonly string[];
    readonly locked?: Set<string>;
    /** Se llama en cada borrado, antes de responder: por ejemplo, para que el reloj avance. */
    readonly onDelete?: () => void;
    /** Cada borrado queda pendiente hasta que se cierran los objetos: entonces rechaza. */
    readonly stall?: boolean;
    /**
     * Cada borrado queda pendiente hasta `release`, que lo termina bien, también después de cerrar
     * los objetos: como un borrado que acaba después del plazo.
     */
    readonly hold?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const stored = new Set(options.keys ?? []);
  const held: (() => void)[] = [];
  /** Termina bien los borrados que esperan, y da tiempo a que sus trabajadores sigan. */
  const release = async () => {
    for (const finish of held.splice(0)) {
      finish();
    }
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  };
  const reject = (error: unknown) =>
    Promise.reject(error instanceof Error ? error : new Error('fallo sintético'));
  const open = (location: LogLocation): LogDeletion => {
    const stalled: ((error: Error) => void)[] = [];
    return {
      close: () => {
        calls.push(`close:${location.prefix}`);
        for (const fail of stalled.splice(0)) {
          fail(new Error('socket destruido'));
        }
      },
      delete: (key) => {
        const full = `${location.prefix}${key}`;
        calls.push(`delete:${full}`);
        if (options.stall === true) {
          return new Promise((_resolve, fail) => {
            stalled.push(fail);
          });
        }
        if (options.hold === true) {
          return new Promise((resolve) => {
            held.push(() => {
              stored.delete(full);
              resolve('deleted');
            });
          });
        }
        options.onDelete?.();
        const error = options.fail?.(`delete:${full}`);
        if (error !== undefined) {
          return reject(error);
        }
        if (options.locked?.has(full) === true) {
          return Promise.resolve('locked');
        }
        stored.delete(full);
        return Promise.resolve('deleted');
      },
      list: (startAfter, max) => {
        calls.push(`list:${location.prefix}:${String(startAfter)}:${String(max)}`);
        const error = options.fail?.('list');
        if (error !== undefined) {
          return reject(error);
        }
        return Promise.resolve(
          [...stored]
            .filter((full) => full.startsWith(location.prefix))
            .map((full) => full.slice(location.prefix.length))
            .sort()
            .filter((key) => startAfter === null || key > startAfter)
            .slice(0, max),
        );
      },
    };
  };
  return { calls, open, release, stored };
}

/** Una ejecución con la base, los procesos y los objetos falsos, con IDs y hora fijos. */
async function run(
  db: ReturnType<typeof fakeDatabase>,
  children: ReturnType<typeof fakeChildren>,
  options: {
    readonly config?: OperationsConfig;
    readonly deletion?: ReturnType<typeof fakeDeletion>;
    /** Los IDs; por defecto, `uuid(1)`, `uuid(2)`… desde el principio en cada ejecución. */
    readonly nextId?: () => string;
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
    config: options.config ?? CONFIG,
    database: db.database,
    deletion: (options.deletion ?? fakeDeletion()).open,
    forwardChildStderr: (text) => forwarded.push(text),
    nextId: options.nextId ?? (() => uuid((sequence += 1))),
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
  it('en una base vacía: los roles, el log 1 con sus migraciones y sus privilegios, las contraseñas, la salud del log 1, la retención, la verificación y el espacio, con sus informes en ese log', async () => {
    expect(OPERATIONS_STEPS).toEqual([
      'roles_and_logs',
      'health',
      'final_health',
      'retention',
      'verification',
      'space',
      'publication',
      'dataset_verification',
    ]);
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
      'profile:1',
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
      // El informe final: ningún log terminó, así que no lee nada más ni guarda ningún informe.
      'list',
      // La retención: ningún log venció, así que no abre los objetos ni guarda su informe.
      'list',
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
          profiles_assigned: [1],
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
        report: { log: null },
        run_id: uuid(1),
        status: 'completed',
        step: 'final_health',
      },
      {
        event: 'operations_step',
        log: null,
        report: { log: null },
        run_id: uuid(1),
        status: 'completed',
        step: 'retention',
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
    expect(db.calls.slice(0, 12)).toEqual([
      'roles',
      'list',
      'profile:1',
      'grant:1',
      'profile:2',
      'grant:2',
      'list',
      'login:buoh_ingesta',
      'login:buoh_salud',
      'login:buoh_agente',
      'list',
      'report:1:health',
    ]);
    expect(db.profiles.size).toBe(0);
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
        profiles_assigned: [],
      },
      status: 'completed',
    });
  });

  it('el perfil del log (ADR-0020 §4): el log nuevo recibe el de publicación después de sus migraciones y antes de sus privilegios', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW)],
    });
    const { lines } = await run(db, fakeChildren());
    expect(db.calls.slice(0, 7)).toEqual([
      'roles',
      'list',
      'profile:1',
      'grant:1',
      'list',
      'create:2',
      'profile:2',
    ]);
    expect(db.calls[7]).toBe('grant:2');
    expect([...db.profiles]).toEqual([
      [2, { ...derivLogProfileRow('R_100'), assigned_at_utc: NOW, run_id: uuid(1) }],
    ]);
    expect(lines[0]).toMatchObject({
      report: { failures: [], prepared: 2, profiles_assigned: [2] },
      status: 'completed',
    });
  });

  it('un log preparado al que una ejecución cortada no le dio los privilegios recibe el perfil en la siguiente; uno con escrituras o con privilegios, no', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2, NOW), log(3)],
      ungranted: new Set([2, 3]),
    });
    const { lines } = await run(db, fakeChildren());
    expect([...db.profiles.keys()]).toEqual([3]);
    expect(lines[0]).toMatchObject({ report: { profiles_assigned: [3] } });
    // Dar un perfil es un cambio: el informe del paso 1 se guarda, aunque no haya otro.
    expect(db.reports.filter(({ row }) => row.step === 'roles_and_logs')).toHaveLength(1);
    const again = await run(db, fakeChildren());
    expect(db.profiles.size).toBe(1);
    expect(again.lines[0]).toMatchObject({ report: { profiles_assigned: [] } });
  });

  it('si no puede dar el perfil, no da los privilegios de ese log: falla con su motivo y sigue con los demás', async () => {
    const db = fakeDatabase({
      fail: { assignLogProfile: coded('57014') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW)],
    });
    const { lines } = await run(db, fakeChildren());
    expect(db.calls.filter((call) => call.startsWith('grant:'))).toEqual([]);
    expect(lines[0]).toMatchObject({
      report: {
        failures: [
          { action: 'profile', log: 1, reason: '57014' },
          { action: 'profile', log: 2, reason: '57014' },
        ],
        prepared: null,
        profiles_assigned: [],
      },
      status: 'failed',
    });
  });

  it('en cuanto el log de mayor número tiene una escritura, prepara el siguiente; la salud sigue en el escrito', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW)],
    });
    const children = fakeChildren();
    const { lines } = await run(db, children);

    expect(db.calls.slice(0, 8)).toEqual([
      'roles',
      'list',
      'profile:1',
      'grant:1',
      'list',
      'create:2',
      'profile:2',
      'grant:2',
    ]);
    expect(lines[0]).toMatchObject({ report: { prepared: 2 } });
    expect(children.runs.at(-1)?.args).toEqual(['--json', '--log', '1']);
  });
});

describe('runOperations: el esquema y el rol de la API en el paso 1 (ADR-0019 §7)', () => {
  /** Los logs 1, escrito, y 2, vacío: el paso 1 no prepara ninguno. */
  const ready = (loggedIn: readonly string[] = ['buoh_ingesta', 'buoh_salud', 'buoh_agente']) =>
    fakeDatabase({ loggedIn: new Set(loggedIn), logs: [log(1, NOW), log(2)] });

  it('sin la contraseña de buoh_api, como en producción hasta el PR 6, no toca la API', async () => {
    const db = ready();
    const children = fakeChildren();
    const { lines } = await run(db, children);
    expect(db.calls.filter((call) => call.startsWith('api_') || call.endsWith('buoh_api'))).toEqual(
      [],
    );
    expect(children.runs.map((item) => item.child)).not.toContain('api_migrate');
    expect(Object.keys(lines[0]?.['report'] as object)).not.toContain('api_migrated');
  });

  it('con ella, después de los logs crea el rol, migra buoh_api en un proceso aparte, le da sus privilegios y le pone la contraseña', async () => {
    const db = ready();
    const children = fakeChildren((child) =>
      child === 'api_migrate'
        ? {
            stdout: JSON.stringify({
              applied: ['0001_auditoria.sql'],
              current: ['0001_auditoria.sql'],
              status: 'migrated',
            }),
          }
        : {},
    );
    const { lines, result } = await run(db, children, { config: API_CONFIG });
    expect(db.calls.slice(0, 17)).toEqual([
      'roles',
      'list',
      'profile:1',
      'grant:1',
      'profile:2',
      'grant:2',
      'list',
      'api_role',
      'api_grant',
      'login:buoh_ingesta',
      'login:buoh_salud',
      'login:buoh_agente',
      'login:buoh_api',
      'password:buoh_api',
      'list',
      'report:1:roles_and_logs',
      'list',
    ]);
    expect(children.runs.map((item) => [item.child, item.args, item.env]).slice(0, 3)).toEqual([
      ['migrate', [], migrateEnvironment(API_CONFIG, 'buoh_log_000001')],
      ['migrate', [], migrateEnvironment(API_CONFIG, 'buoh_log_000002')],
      ['api_migrate', [], apiMigrateEnvironment(API_CONFIG)],
    ]);
    expect(result.status).toBe('completed');
    const report = {
      api_migrated: ['0001_auditoria.sql'],
      failures: [],
      migrated: [],
      passwords_set: ['buoh_api'],
      passwords_unchecked: [],
      prepared: null,
      profiles_assigned: [],
    };
    expect(lines[0]).toMatchObject({ report, status: 'completed', step: 'roles_and_logs' });
    expect(db.reports[0]?.row.report).toEqual(report);
  });

  it('una migración nueva de la API basta para guardar el informe del paso 1', async () => {
    const db = ready(['buoh_ingesta', 'buoh_salud', 'buoh_agente', 'buoh_api']);
    const children = fakeChildren((child) =>
      child === 'api_migrate'
        ? {
            stdout: JSON.stringify({
              applied: ['0002_cuentas.sql'],
              current: ['0001_auditoria.sql', '0002_cuentas.sql'],
              status: 'migrated',
            }),
          }
        : {},
    );
    await run(db, children, { config: API_CONFIG });
    expect(db.reports[0]?.row).toMatchObject({
      report: { api_migrated: ['0002_cuentas.sql'], passwords_set: [] },
      status: 'completed',
      step: 'roles_and_logs',
    });
  });

  it('con todo hecho, solo comprueba la contraseña de buoh_api, y no guarda el informe del paso 1', async () => {
    const db = ready(['buoh_ingesta', 'buoh_salud', 'buoh_agente', 'buoh_api']);
    const children = fakeChildren();
    const { lines } = await run(db, children, { config: API_CONFIG });
    expect(db.calls).toContain('login:buoh_api');
    expect(db.calls).not.toContain('password:buoh_api');
    expect(db.reports.map(({ row }) => row.step)).not.toContain('roles_and_logs');
    expect(lines[0]).toMatchObject({
      report: { api_migrated: [], failures: [], passwords_set: [] },
      status: 'completed',
    });
  });

  it('sin el rol no migra la API ni le pone la contraseña; el paso termina failed y lo demás sigue', async () => {
    const db = fakeDatabase({
      fail: { ensureApiRole: coded('42501') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });
    const children = fakeChildren();
    const { lines, result } = await run(db, children, { config: API_CONFIG });
    expect(children.runs.map((item) => item.child)).not.toContain('api_migrate');
    expect(db.calls).not.toContain('api_grant');
    expect(db.calls).not.toContain('login:buoh_api');
    expect(db.calls).toContain('login:buoh_agente');
    expect(lines[0]).toMatchObject({
      report: { api_migrated: [], failures: [{ action: 'api_role', reason: '42501' }] },
      status: 'failed',
    });
    expect(lines.map((line) => line['step'])).toContain('space');
    expect(result.status).toBe('failed');
  });

  it('si el db:migrate de la API falla, deja su motivo saneado, no da privilegios y le pone igual la contraseña', async () => {
    const db = ready();
    const children = fakeChildren((child) =>
      child === 'api_migrate'
        ? {
            exitCode: 1,
            stdout: JSON.stringify({
              code: 'MIGRATION_FAILED',
              migration: '0001_auditoria.sql',
              reason: '42501',
              status: 'failed',
            }),
          }
        : {},
    );
    const { lines } = await run(db, children, { config: API_CONFIG });
    expect(db.calls).not.toContain('api_grant');
    expect(db.calls).toContain('password:buoh_api');
    expect(lines[0]).toMatchObject({
      report: {
        api_migrated: [],
        failures: [{ action: 'api_migrate', reason: '42501' }],
        passwords_set: ['buoh_api'],
      },
      status: 'failed',
    });
  });

  it('si no le puede dar los privilegios, lo anota con su motivo saneado', async () => {
    const db = fakeDatabase({
      fail: { grantApiPrivileges: coded('42501') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente', 'buoh_api']),
      logs: [log(1, NOW), log(2)],
    });
    const { lines } = await run(db, fakeChildren(), { config: API_CONFIG });
    expect(lines[0]).toMatchObject({
      report: { failures: [{ action: 'api_grant', reason: '42501' }] },
      status: 'failed',
    });
  });
});

describe('runOperations: el rol de lectura de la API en el paso 1 (ADR-0019 §7 y §8)', () => {
  /** Los logs 1, escrito, y 2, vacío: el paso 1 no prepara ninguno. */
  const ready = (loggedIn: readonly string[] = ['buoh_ingesta', 'buoh_salud', 'buoh_agente']) =>
    fakeDatabase({ loggedIn: new Set(loggedIn), logs: [log(1, NOW), log(2)] });

  it('sin la contraseña de buoh_api_lectura no crea el rol ni le pone ninguna', async () => {
    const db = ready();
    await run(db, fakeChildren(), { config: API_CONFIG });
    expect(db.calls).not.toContain('api_reader_role');
    expect(db.calls.filter((call) => call.endsWith('buoh_api_lectura'))).toEqual([]);
  });

  it('con ella, después de los logs crea o ajusta el rol y le pone la contraseña, sin tocar la API', async () => {
    const db = ready();
    const children = fakeChildren();
    const { lines, result } = await run(db, children, { config: READER_CONFIG });
    expect(db.calls.slice(0, 15)).toEqual([
      'roles',
      'list',
      'profile:1',
      'grant:1',
      'profile:2',
      'grant:2',
      'list',
      'api_reader_role',
      'login:buoh_ingesta',
      'login:buoh_salud',
      'login:buoh_agente',
      'login:buoh_api_lectura',
      'password:buoh_api_lectura',
      'list',
      'report:1:roles_and_logs',
    ]);
    expect(children.runs.map((item) => item.child)).not.toContain('api_migrate');
    expect(result.status).toBe('completed');
    const report = {
      failures: [],
      migrated: [],
      passwords_set: ['buoh_api_lectura'],
      passwords_unchecked: [],
      prepared: null,
      profiles_assigned: [],
    };
    expect(lines[0]).toMatchObject({ report, status: 'completed', step: 'roles_and_logs' });
    expect(db.reports[0]?.row.report).toEqual(report);
  });

  it('con las dos contraseñas de la API, el rol de lectura va después de preparar buoh_api, y su contraseña, después de la de buoh_api', async () => {
    const db = ready();
    const { result } = await run(db, fakeChildren(), { config: API_AND_READER_CONFIG });
    expect(db.calls.slice(7, 16)).toEqual([
      'api_role',
      'api_grant',
      'api_reader_role',
      'login:buoh_ingesta',
      'login:buoh_salud',
      'login:buoh_agente',
      'login:buoh_api',
      'password:buoh_api',
      'login:buoh_api_lectura',
    ]);
    expect(db.calls[16]).toBe('password:buoh_api_lectura');
    expect(result.status).toBe('completed');
  });

  it('con todo hecho, solo comprueba su contraseña, y no guarda el informe del paso 1', async () => {
    const db = ready(['buoh_ingesta', 'buoh_salud', 'buoh_agente', 'buoh_api_lectura']);
    const { lines } = await run(db, fakeChildren(), { config: READER_CONFIG });
    expect(db.calls).toContain('api_reader_role');
    expect(db.calls).toContain('login:buoh_api_lectura');
    expect(db.calls).not.toContain('password:buoh_api_lectura');
    expect(db.reports.map(({ row }) => row.step)).not.toContain('roles_and_logs');
    expect(lines[0]).toMatchObject({
      report: { failures: [], passwords_set: [] },
      status: 'completed',
    });
  });

  it('sin el rol no le pone la contraseña; el paso termina failed con api_reader_role y lo demás sigue', async () => {
    const db = fakeDatabase({
      fail: { ensureApiReaderRole: coded('42501') },
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, NOW), log(2)],
    });
    const { lines, result } = await run(db, fakeChildren(), { config: API_AND_READER_CONFIG });
    expect(db.calls).not.toContain('login:buoh_api_lectura');
    // La API y los demás roles siguen.
    expect(db.calls).toContain('password:buoh_api');
    expect(db.calls).toContain('login:buoh_agente');
    expect(lines[0]).toMatchObject({
      report: {
        failures: [{ action: 'api_reader_role', reason: '42501' }],
        passwords_set: ['buoh_api'],
      },
      status: 'failed',
    });
    expect(lines.map((line) => line['step'])).toContain('space');
    expect(result.status).toBe('failed');
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

    expect(db.calls).toEqual([
      'roles',
      'list',
      'list',
      'list',
      'list',
      'list',
      // La retención: la búsqueda del log vencido y el intento de guardar su informe.
      'list',
      'list',
      'list',
      'list',
      'list',
      'list',
    ]);
    expect(children.runs).toEqual([]);
    expect(lines.slice(0, 2)).toEqual([
      expect.objectContaining({
        report: {
          failures: [{ action: 'ensure_roles', reason: 'ECONNREFUSED' }],
          migrated: [],
          passwords_set: [],
          passwords_unchecked: [],
          prepared: null,
          profiles_assigned: [],
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
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'final_health' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'final_health' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'retention' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'retention' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'verification' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'verification' },
      { event: 'operations_step_failed', reason: 'ECONNREFUSED', step: 'space' },
      { event: 'operations_report_unavailable', reason: 'ECONNREFUSED', step: 'space' },
    ]);
    expect(lines.slice(2, 6)).toEqual([
      expect.objectContaining({
        report: { log: null, reason: 'ECONNREFUSED' },
        status: 'failed',
        step: 'final_health',
      }),
      expect.objectContaining({
        report: { log: null, reason: 'ECONNREFUSED' },
        status: 'failed',
        step: 'retention',
      }),
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

  it('lo que guarda se lee como la salud del log (ADR-0019 §8): el HealthReport si terminó, y el motivo si falló', async () => {
    /** La observación de la fila de la salud del log 1, con el informe en JCS, como en PostgreSQL. */
    const stored = async (answer: Partial<ChildResult>) => {
      const db = ready();
      await run(
        db,
        fakeChildren((child) => (child === 'health' ? answer : {})),
      );
      const health = db.reports.filter(({ row }) => row.step === 'health');
      const [entry] = health;
      expect(health).toHaveLength(1);
      if (entry === undefined) {
        throw new TypeError('Sin informe de la salud.');
      }
      return parseStoredHealthObservation({
        observed_at_utc: entry.row.observed_at_utc,
        report_jcs: canonicalJson(entry.row.report),
        status: entry.row.status,
      });
    };
    expect(
      await stored({
        stderr:
          '{"event":"data_health_storage_unavailable","reason":"connect ECONNREFUSED 10.0.0.5"}\n',
      }),
    ).toEqual({
      alerts: [{ event: 'data_health_storage_unavailable', reason: null }],
      observedAtUtc: NOW,
      report: REPORT,
      status: 'completed',
    });
    expect(
      await stored({
        exitCode: 2,
        stderr:
          '{"code":"ConfigError","message":"Configuración inválida o ausente: X.","status":"failed"}\n',
        stdout: '',
      }),
    ).toEqual({
      code: 'ConfigError',
      observedAtUtc: NOW,
      reason: 'health_command_failed',
      status: 'failed',
    });
    expect(await stored({ exitCode: null, stdout: '', timedOut: true })).toEqual({
      code: null,
      observedAtUtc: NOW,
      reason: 'child_timeout',
      status: 'failed',
    });
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

describe('runOperations: el informe final de un log que terminó (ADR-0018 §6, «Traspaso», y §11, paso 2)', () => {
  /** Una escritura anterior a `NOW`, sin que el log venza. */
  const EARLIER = '2026-03-01T00:00:00.000Z';
  /** Una escritura de hace más de 30 días: el log venció. */
  const EXPIRED = '2026-01-15T00:00:00.000Z';
  /** Los procesos de `data:health` de la ejecución, con su log. */
  const healthRuns = (children: ReturnType<typeof fakeChildren>) =>
    children.runs.filter((item) => item.child === 'health').map((item) => item.args.join(' '));

  it('con el log 2 activo, el log 1 terminó: data:health --log 1 después de la salud del activo, y su informe va al log 1 como final_health; la ejecución siguiente no lo repite', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, EARLIER), log(2, NOW), log(3)],
    });
    const children = fakeChildren();
    const first = await run(db, children);

    expect(healthRuns(children)).toEqual(['--json --log 2', '--json --log 1']);
    expect(first.lines[2]).toEqual({
      event: 'operations_step',
      log: 1,
      report: { alerts: [], exit_code: 1, log: 1, report: REPORT },
      run_id: uuid(1),
      status: 'completed',
      step: 'final_health',
    });
    expect(
      db.reports
        .filter(({ row }) => row.step.endsWith('health'))
        .map(({ log: number, row }) => [number, row.step, row.status]),
    ).toEqual([
      [2, 'health', 'completed'],
      [1, 'final_health', 'completed'],
    ]);
    expect(first.result.status).toBe('completed');

    const again = fakeChildren();
    const second = await run(db, again);
    expect(healthRuns(again)).toEqual(['--json --log 2']);
    expect(second.lines[2]).toMatchObject({
      log: null,
      report: { log: null },
      status: 'completed',
      step: 'final_health',
    });
    expect(db.reports.filter(({ row }) => row.step === 'final_health')).toHaveLength(1);
  });

  it('con dos logs terminados sin informe final, uno por ejecución, empezando por el de menor número', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, EARLIER), log(2, EARLIER), log(3, NOW), log(4)],
    });
    const first = fakeChildren();
    await run(db, first);
    const second = fakeChildren();
    await run(db, second);

    expect(healthRuns(first)).toEqual(['--json --log 3', '--json --log 1']);
    expect(healthRuns(second)).toEqual(['--json --log 3', '--json --log 2']);
    expect(
      db.reports.filter(({ row }) => row.step === 'final_health').map(({ log: number }) => number),
    ).toEqual([1, 2]);
  });

  it('un informe final que falla se guarda failed en ese log, con la alerta del paso, y la ejecución siguiente lo vuelve a intentar', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, EARLIER), log(2, NOW), log(3)],
    });
    const failing = fakeChildren((child, args) =>
      child === 'health' && args.includes('1') ? { exitCode: 2, stdout: '' } : {},
    );
    const first = await run(db, failing);
    expect(first.lines[2]).toMatchObject({
      log: 1,
      report: { exit_code: 2, log: 1, reason: 'health_command_failed' },
      status: 'failed',
      step: 'final_health',
    });
    expect(first.alerts).toEqual([
      { event: 'operations_step_failed', reason: 'health_command_failed', step: 'final_health' },
    ]);
    expect(first.result.status).toBe('failed');

    const retry = fakeChildren();
    await run(db, retry);
    expect(healthRuns(retry)).toEqual(['--json --log 2', '--json --log 1']);
    expect(
      db.reports
        .filter(({ row }) => row.step === 'final_health')
        .map(({ log: number, row }) => [number, row.status]),
    ).toEqual([
      [1, 'failed'],
      [1, 'completed'],
    ]);
  });

  it.each([
    ['un almacén no respondió (regla 3)', 'data_health_storage_unavailable', 'ECONNREFUSED'],
    [
      'la reconstrucción del estado vivo no terminó',
      'data_health_checkpoint_rebuild_incomplete',
      'deadline_exceeded',
    ],
  ])(
    'un informe final sin observación, porque %s, se guarda failed con health_not_observed y se vuelve a intentar; la salud del activo, igual, no falla',
    async (_label, event, reason) => {
      const db = fakeDatabase({
        loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
        logs: [log(1, EARLIER), log(2, NOW), log(3)],
      });
      const stderr = `${JSON.stringify({ event, reason })}\n`;
      const unobserved = fakeChildren((child) => (child === 'health' ? { stderr } : {}));
      const first = await run(db, unobserved);

      expect(first.lines[1]).toMatchObject({ log: 2, status: 'completed', step: 'health' });
      expect(first.lines[2]).toMatchObject({
        log: 1,
        report: {
          alerts: [{ event, reason }],
          exit_code: 1,
          log: 1,
          reason: 'health_not_observed',
        },
        status: 'failed',
        step: 'final_health',
      });
      expect(first.alerts).toEqual([
        { event: 'operations_step_failed', reason: 'health_not_observed', step: 'final_health' },
      ]);

      const retry = fakeChildren();
      await run(db, retry);
      expect(healthRuns(retry)).toEqual(['--json --log 2', '--json --log 1']);
      expect(
        db.reports.filter(({ row }) => row.step === 'final_health').map(({ row }) => row.status),
      ).toEqual(['failed', 'completed']);
    },
  );

  it('un log terminado que venció, uno que no se puede leer y uno sin escrituras no reciben informe final', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [
        log(1, EXPIRED),
        { lastWriteUtc: null, location: logLocation(2), readable: false },
        log(3),
        log(4, NOW),
        log(5),
      ],
    });
    const children = fakeChildren();
    const { lines } = await run(db, children);

    expect(healthRuns(children)).toEqual(['--json --log 4']);
    expect(lines[2]).toMatchObject({ log: null, report: { log: null }, step: 'final_health' });
    expect(db.calls.filter((call) => call.endsWith(':final_health'))).toEqual([]);
  });
});

describe('runOperations: la retención (ADR-0018 §7 y §11, paso 3)', () => {
  /** Una escritura de hace más de 30 días: el log venció. */
  const EXPIRED = '2026-01-15T00:00:00.000Z';
  /** Una escritura de hace 30 días justos: también venció. */
  const JUST_EXPIRED = '2026-01-31T10:00:00.000Z';
  /** Una escritura de hace 30 días menos 1 ms: todavía no venció. */
  const NOT_YET = '2026-01-31T10:00:00.001Z';
  const loggedIn = () => new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']);
  const retentionLine = (lines: Record<string, unknown>[]) =>
    lines.find((line) => line['step'] === 'retention');
  /** Las claves completas de `count` objetos del log, en orden. */
  const keysOf = (number: number, count: number, from = 0) =>
    Array.from(
      { length: count },
      (_, index) => `${logLocation(number).prefix}sha256/${String(from + index).padStart(4, '0')}`,
    );
  /** Los prefijos de log de los listados, borrados y cierres, en orden y sin repetir. */
  const prefixesOf = (calls: readonly string[]) => [
    ...new Set(calls.flatMap((call) => /logs\/[0-9]{6}\//u.exec(call)?.[0] ?? [])),
  ];

  it('sin ningún log vencido, no abre los objetos ni guarda informe', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, NOT_YET), log(2, NOW), log(3)] });
    const deletion = fakeDeletion({ keys: keysOf(1, 2) });
    const { lines } = await run(db, fakeChildren(), { deletion });

    expect(retentionLine(lines)).toMatchObject({
      log: null,
      report: { log: null },
      status: 'completed',
    });
    expect(deletion.calls).toEqual([]);
    expect(db.drops).toEqual([]);
    expect(db.reports.map(({ row }) => row.step)).not.toContain('retention');
  });

  it('del log vencido, borra los objetos de su prefijo y, con el listado vacío desde el principio, su esquema; los de los demás logs no los toca', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const deletion = fakeDeletion({ keys: [...keysOf(1, 3), ...keysOf(2, 2)] });
    const { alerts, lines, result } = await run(db, fakeChildren(), { deletion });

    expect(deletion.calls).toEqual([
      `list:logs/000001/:null:${String(RETENTION_PAGE_KEYS)}`,
      'delete:logs/000001/sha256/0000',
      'delete:logs/000001/sha256/0001',
      'delete:logs/000001/sha256/0002',
      `list:logs/000001/:sha256/0002:${String(RETENTION_PAGE_KEYS)}`,
      'list:logs/000001/:null:1',
      'close:logs/000001/',
    ]);
    expect([...deletion.stored]).toEqual(keysOf(2, 2));
    expect(db.drops).toEqual([{ log: 1, now: NOW }]);
    expect(retentionLine(lines)).toEqual({
      event: 'operations_step',
      log: null,
      report: { deleted: 3, locked: 0, log: 1, schema_dropped: true },
      run_id: uuid(1),
      status: 'completed',
      step: 'retention',
    });
    expect(alerts).toEqual([]);
    expect(result.status).toBe('completed');
    // Su informe va al log activo, el 2.
    expect(
      db.reports
        .filter(({ row }) => row.step === 'retention')
        .map(({ log: number, row }) => [number, row.status]),
    ).toEqual([[2, 'completed']]);
  });

  it('nunca borra el log preparado ni uno que no venció; con dos vencidos, uno por ejecución, empezando por el de menor número', async () => {
    const db = fakeDatabase({
      loggedIn: loggedIn(),
      logs: [log(1, EXPIRED), log(2, JUST_EXPIRED), log(3, NOT_YET), log(4, NOW), log(5)],
    });
    const deletion = fakeDeletion({ keys: [1, 2, 3, 4, 5].flatMap((number) => keysOf(number, 1)) });

    const first = await run(db, fakeChildren(), { deletion });
    expect(prefixesOf(deletion.calls)).toEqual(['logs/000001/']);
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 1, log: 1, schema_dropped: true },
    });

    deletion.calls.length = 0;
    const second = await run(db, fakeChildren(), { deletion });
    expect(prefixesOf(deletion.calls)).toEqual(['logs/000002/']);
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 1, log: 2, schema_dropped: true },
    });

    deletion.calls.length = 0;
    const third = await run(db, fakeChildren(), { deletion });
    expect(deletion.calls).toEqual([]);
    expect(retentionLine(third.lines)).toMatchObject({ report: { log: null } });
    expect(db.drops.map((drop) => drop.log)).toEqual([1, 2]);
    expect([...deletion.stored]).toEqual([3, 4, 5].flatMap((number) => keysOf(number, 1)));
  });

  it('también vence el log activo de una captura detenida, el de mayor número con escrituras; el preparado queda', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2)] });
    const deletion = fakeDeletion({ keys: [...keysOf(1, 2), ...keysOf(2, 1)] });
    const { lines } = await run(db, fakeChildren(), { deletion });

    expect(retentionLine(lines)).toMatchObject({
      report: { deleted: 2, log: 1, schema_dropped: true },
      status: 'completed',
    });
    expect([...deletion.stored]).toEqual(keysOf(2, 1));
    expect(db.drops.map((drop) => drop.log)).toEqual([1]);
  });

  it('un objeto que la regla de bloqueo todavía protege queda para una ejecución siguiente, y el esquema no se borra hasta que se borra él', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const locked = new Set([keysOf(1, 1, 1)[0] ?? '']);
    const deletion = fakeDeletion({ keys: keysOf(1, 3), locked });

    const first = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 2, locked: 1, log: 1, schema_dropped: false },
      status: 'completed',
    });
    expect(first.alerts).toEqual([]);
    // Con un objeto bloqueado no vuelve a listar desde el principio ni borra el esquema.
    expect(deletion.calls.filter((call) => call.startsWith('list:'))).toEqual([
      `list:logs/000001/:null:${String(RETENTION_PAGE_KEYS)}`,
      `list:logs/000001/:sha256/0002:${String(RETENTION_PAGE_KEYS)}`,
    ]);
    expect(db.drops).toEqual([]);
    expect([...deletion.stored]).toEqual(keysOf(1, 1, 1));

    locked.clear();
    const second = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 1, locked: 0, log: 1, schema_dropped: true },
      status: 'completed',
    });
    expect(deletion.stored.size).toBe(0);
    expect(db.drops.map((drop) => drop.log)).toEqual([1]);
  });

  it('pasa de página con la última clave de la anterior, también con claves bloqueadas al principio', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const keys = keysOf(1, RETENTION_PAGE_KEYS + 1);
    const deletion = fakeDeletion({ keys, locked: new Set([keys[0] ?? '']) });
    const { lines } = await run(db, fakeChildren(), { deletion });

    expect(deletion.calls.filter((call) => call.startsWith('list:'))).toEqual([
      `list:logs/000001/:null:${String(RETENTION_PAGE_KEYS)}`,
      `list:logs/000001/:sha256/0999:${String(RETENTION_PAGE_KEYS)}`,
      `list:logs/000001/:sha256/1000:${String(RETENTION_PAGE_KEYS)}`,
    ]);
    expect(retentionLine(lines)).toMatchObject({
      report: { deleted: RETENTION_PAGE_KEYS, locked: 1, log: 1, schema_dropped: false },
    });
  });

  it('el esquema solo se borra con el listado del prefijo vacío desde el principio: si aparece un objeto, espera a la ejecución siguiente', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const late = `${logLocation(1).prefix}sha256/0000`;
    let added = false;
    const deletion = fakeDeletion({
      keys: keysOf(1, 2, 1),
      onDelete: () => {
        // Un objeto que se escribe mientras tanto, delante de la última clave listada.
        if (!added) {
          added = true;
          deletion.stored.add(late);
        }
      },
    });
    const remainingAtDrop: number[] = [];
    const drop = db.database.dropExpiredLog.bind(db.database);
    db.database.dropExpiredLog = (target, now) => {
      remainingAtDrop.push(deletion.stored.size);
      return drop(target, now);
    };

    const first = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 2, locked: 0, log: 1, schema_dropped: false },
      status: 'completed',
    });
    expect(deletion.calls.at(-2)).toBe('list:logs/000001/:null:1');
    expect(db.drops).toEqual([]);

    const second = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 1, log: 1, schema_dropped: true },
    });
    expect(remainingAtDrop).toEqual([0]);
  });

  it('si el almacenamiento no responde, el paso falla con el motivo saneado, no borra el esquema y la ejecución sigue; la siguiente continúa donde quedó', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const timeout = Object.assign(new Error('connect ETIMEDOUT 10.0.0.9:443'), {
      code: 'ETIMEDOUT',
    });
    let failing = true;
    const deletion = fakeDeletion({
      fail: (call) => (failing && call.endsWith('sha256/0001') ? timeout : undefined),
      keys: keysOf(1, 3),
    });

    const first = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 2, locked: 0, log: 1, reason: 'ETIMEDOUT', schema_dropped: false },
      status: 'failed',
    });
    expect(first.alerts).toEqual([
      { event: 'operations_step_failed', reason: 'ETIMEDOUT', step: 'retention' },
    ]);
    expect(deletion.calls.at(-1)).toBe('close:logs/000001/');
    expect(db.drops).toEqual([]);
    expect(first.lines.find((line) => line['step'] === 'verification')).toMatchObject({
      status: 'completed',
    });
    expect(first.lines.find((line) => line['step'] === 'space')).toMatchObject({
      status: 'completed',
    });
    expect(first.result.status).toBe('failed');
    expect(JSON.stringify([first.lines, first.alerts])).not.toMatch(
      /10\.0\.0\.9|connect ETIMEDOUT/u,
    );

    failing = false;
    const second = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 1, log: 1, schema_dropped: true },
      status: 'completed',
    });

    const listing = fakeDeletion({ fail: (call) => (call === 'list' ? timeout : undefined) });
    const other = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW)] });
    const third = await run(other, fakeChildren(), { deletion: listing });
    expect(retentionLine(third.lines)).toMatchObject({
      report: { deleted: 0, log: 1, reason: 'ETIMEDOUT', schema_dropped: false },
      status: 'failed',
    });
    expect(listing.calls).toEqual([
      `list:logs/000001/:null:${String(RETENTION_PAGE_KEYS)}`,
      'close:logs/000001/',
    ]);
  });

  it(`para a los ${String(RETENTION_DEADLINE_MS / 1000)} s sin fallar: lo que queda sigue en la ejecución siguiente`, async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    let time = Date.parse(NOW);
    const deletion = fakeDeletion({
      keys: keysOf(1, RETENTION_PAGE_KEYS + 1),
      onDelete: () => {
        time += 70;
      },
    });
    const delays: number[] = [];
    const scheduler: Scheduler = {
      schedule: (ms) => {
        delays.push(ms);
        return () => undefined;
      },
    };
    const first = await run(db, fakeChildren(), {
      deletion,
      now: () => new Date(time).toISOString(),
      scheduler,
    });

    // El listado y la primera página tienen los 60 s enteros; después de 70 s ya no queda plazo.
    expect(delays.slice(0, 2)).toEqual([RETENTION_DEADLINE_MS, RETENTION_DEADLINE_MS]);
    expect(retentionLine(first.lines)).toMatchObject({
      report: {
        deadline_reached: true,
        deleted: RETENTION_PAGE_KEYS,
        locked: 0,
        log: 1,
        schema_dropped: false,
      },
      status: 'completed',
    });
    expect(first.alerts).toEqual([]);
    expect(db.drops).toEqual([]);

    const second = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 1, log: 1, schema_dropped: true },
    });
  });

  it('al vencer el plazo, un borrado que todavía termina bien no empieza otro', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const clock = new ManualClock(NOW);
    const deletion = fakeDeletion({ hold: true, keys: keysOf(1, 20) });
    const running = run(db, fakeChildren(), {
      deletion,
      now: clock.now,
      scheduler: clock.scheduler,
    });
    for (let i = 0; i < 100 && !deletion.calls.some((call) => call.startsWith('delete:')); i += 1) {
      await flush();
    }
    const started = () => deletion.calls.filter((call) => call.startsWith('delete:')).length;
    expect(started()).toBe(8);
    await clock.advance(RETENTION_DEADLINE_MS);
    const { lines } = await running;
    expect(retentionLine(lines)).toMatchObject({
      report: { deadline_reached: true, deleted: 0, log: 1, schema_dropped: false },
      status: 'completed',
    });

    // Los 8 terminan después del plazo y del cierre: ninguno sigue con la clave siguiente.
    await deletion.release();
    expect(started()).toBe(8);
    expect(deletion.stored.size).toBe(12);
    expect(db.drops).toEqual([]);
  });

  it('un borrado que no termina se corta al vencer el plazo: cierra los objetos del log y para sin fallar', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW), log(3)] });
    const clock = new ManualClock(NOW);
    const deletion = fakeDeletion({ keys: keysOf(1, 3), stall: true });
    const running = run(db, fakeChildren(), {
      deletion,
      now: clock.now,
      scheduler: clock.scheduler,
    });
    for (let i = 0; i < 100 && !deletion.calls.some((call) => call.startsWith('delete:')); i += 1) {
      await flush();
    }
    expect(clock.pendingDelays()).toEqual([RETENTION_DEADLINE_MS]);
    await clock.advance(RETENTION_DEADLINE_MS);
    const { alerts, lines, result } = await running;

    expect(deletion.calls.filter((call) => call.startsWith('close:'))).toEqual([
      'close:logs/000001/',
    ]);
    expect(retentionLine(lines)).toMatchObject({
      report: { deadline_reached: true, deleted: 0, locked: 0, log: 1, schema_dropped: false },
      status: 'completed',
    });
    expect(alerts).toEqual([]);
    expect(result.status).toBe('completed');
    expect(db.drops).toEqual([]);
    expect(clock.pendingDelays()).toEqual([]);
  });

  it('si al borrar el esquema el log ya no venció, el paso falla con log_not_expired; si el esquema ya no existe, termina sin borrarlo', async () => {
    const changed = fakeDatabase({
      dropResult: 'not_expired',
      loggedIn: loggedIn(),
      logs: [log(1, EXPIRED), log(2, NOW), log(3)],
    });
    const first = await run(changed, fakeChildren(), {
      deletion: fakeDeletion({ keys: keysOf(1, 1) }),
    });
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 1, log: 1, reason: 'log_not_expired', schema_dropped: false },
      status: 'failed',
    });
    expect(first.alerts).toEqual([
      { event: 'operations_step_failed', reason: 'log_not_expired', step: 'retention' },
    ]);

    const absent = fakeDatabase({
      dropResult: 'absent',
      loggedIn: loggedIn(),
      logs: [log(1, EXPIRED), log(2, NOW), log(3)],
    });
    const second = await run(absent, fakeChildren());
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 0, log: 1, schema_dropped: false },
      status: 'completed',
    });
  });

  it('si PostgreSQL no responde al borrar el esquema, falla con su motivo, y la ejecución siguiente vuelve a listar el prefijo y lo borra', async () => {
    const state: Parameters<typeof fakeDatabase>[0] = {
      fail: { dropExpiredLog: coded('55P03') },
      loggedIn: loggedIn(),
      logs: [log(1, EXPIRED), log(2, NOW), log(3)],
    };
    const db = fakeDatabase(state);
    const deletion = fakeDeletion({ keys: keysOf(1, 3) });
    const first = await run(db, fakeChildren(), { deletion });
    expect(retentionLine(first.lines)).toMatchObject({
      report: { deleted: 3, log: 1, reason: '55P03', schema_dropped: false },
      status: 'failed',
    });

    state.fail = {};
    deletion.calls.length = 0;
    const second = await run(db, fakeChildren(), { deletion });
    expect(deletion.calls).toEqual([
      `list:logs/000001/:null:${String(RETENTION_PAGE_KEYS)}`,
      'list:logs/000001/:null:1',
      'close:logs/000001/',
    ]);
    expect(retentionLine(second.lines)).toMatchObject({
      report: { deleted: 0, log: 1, schema_dropped: true },
      status: 'completed',
    });
    // Los dos informes se guardan en el log activo, también el de la ejecución que no borró ningún
    // objeto y solo el esquema.
    expect(
      db.reports
        .filter(({ row }) => row.step === 'retention')
        .map(({ log: number, row }) => [number, row.status, row.report]),
    ).toEqual([
      [2, 'failed', { deleted: 3, locked: 0, log: 1, reason: '55P03', schema_dropped: false }],
      [2, 'completed', { deleted: 0, locked: 0, log: 1, schema_dropped: true }],
    ]);
  });

  it('si PostgreSQL no responde al buscar los logs, falla sin abrir ningún objeto', async () => {
    const db = fakeDatabase({ loggedIn: loggedIn(), logs: [log(1, EXPIRED), log(2, NOW)] });
    const list = db.database.listLogs.bind(db.database);
    let afterHealth = 0;
    // Después de guardar la salud, el informe final lee los logs una vez, y la retención, la
    // siguiente.
    db.database.listLogs = () => {
      if (db.calls.includes('report:2:health')) {
        afterHealth += 1;
        if (afterHealth === 2) {
          return Promise.reject(coded('57P01'));
        }
      }
      return list();
    };
    const deletion = fakeDeletion({ keys: keysOf(1, 1) });
    const { lines } = await run(db, fakeChildren(), { deletion });

    expect(retentionLine(lines)).toMatchObject({
      report: { log: null, reason: '57P01' },
      status: 'failed',
    });
    expect(deletion.calls).toEqual([]);
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

  it('no vuelve a leer los segmentos de un log vencido a medio borrar, que la retención dejó con un objeto que la regla de bloqueo todavía protege', async () => {
    // Desde que vence un log hasta que la retención borra su esquema, lleva varias ejecuciones: sus
    // objetos van desapareciendo, y leerlos daría alertas operations_segment_mismatch falsas.
    const locked = `${logLocation(1).prefix}sha256/0000`;
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, EXPIRED), log(2, ON_TIME), log(3)],
      segments: { 1: [segmentRow(120)], 2: [] },
    });
    const deletion = fakeDeletion({ keys: [locked], locked: new Set([locked]) });
    const objects = fakeObjects();
    const { alerts, lines } = await run(db, fakeChildren(), { deletion, objects });

    expect(lines.find((line) => line['step'] === 'retention')).toMatchObject({
      report: { locked: 1, log: 1, schema_dropped: false },
    });
    expect(db.calls.filter((call) => call.startsWith('segments:'))).toEqual([
      'segments:2:120',
      'segments:3:120',
    ]);
    expect(objects.calls).toEqual([]);
    expect(verificationLine(lines)).toMatchObject({
      report: { due: 0, mismatched: [], read: 0, slot: 120 },
      status: 'completed',
    });
    expect(alerts).toEqual([]);
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
    const clock = new ManualClock(NOW);
    const { alerts, lines, result } = await run(db, fakeChildren(), {
      now: clock.now,
      objects,
      scheduler: clock.scheduler,
    });
    // El plazo de la lectura que falló se cancela: un temporizador vivo retendría el proceso.
    expect(clock.pendingDelays()).toEqual([]);

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
    const delays: number[] = [];
    const { lines } = await run(db, fakeChildren(), {
      now: () => new Date(time).toISOString(),
      objects,
      scheduler: {
        schedule: (ms) => {
          delays.push(ms);
          return () => undefined;
        },
      },
    });

    // Cada lectura tiene lo que queda de los 60 s: 60 s la primera, 20 s la segunda. Antes, los dos
    // listados de la retención del log 1, que venció, con su propio plazo.
    expect(delays).toEqual([
      RETENTION_DEADLINE_MS,
      RETENTION_DEADLINE_MS,
      VERIFICATION_DEADLINE_MS,
      VERIFICATION_DEADLINE_MS - 40_000,
    ]);
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
        openDeletion: (_config, location) => {
          opened = true;
          return fakeDeletion().open(location);
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
        openDeletion: (_config, location) => fakeDeletion().open(location),
        openObjects: (_config, location) => fakeObjects().objects(location),
        runChild: fakeChildren().runChild,
        scheduler: IDLE_SCHEDULER,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(db.calls.at(-1)).toBe('close');
    }
  });

  it('abre los objetos de cada log, para leerlos y para borrarlos, con el token operaciones de la configuración', async () => {
    const db = fakeDatabase({
      loggedIn: new Set(['buoh_ingesta', 'buoh_salud', 'buoh_agente']),
      logs: [log(1, '2026-01-15T00:00:00.000Z'), log(2, NOW)],
      segments: { 2: [segmentRow(120)] },
    });
    const opened: { log: string; objects: unknown; use: string }[] = [];
    let sequence = 0;
    await operationsCommand(ENV, {
      alert: () => undefined,
      forwardChildStderr: () => undefined,
      nextId: () => uuid((sequence += 1)),
      now: () => NOW,
      openDatabase: () => db.database,
      openDeletion: (config, location) => {
        opened.push({ log: location.prefix, objects: config.operationsObjects, use: 'retention' });
        return fakeDeletion().open(location);
      },
      openObjects: (config, location) => {
        opened.push({
          log: location.prefix,
          objects: config.operationsObjects,
          use: 'verification',
        });
        return fakeObjects().objects(location);
      },
      runChild: fakeChildren().runChild,
      scheduler: IDLE_SCHEDULER,
    });
    expect(opened).toEqual([
      { log: 'logs/000001/', objects: CONFIG.operationsObjects, use: 'retention' },
      { log: 'logs/000002/', objects: CONFIG.operationsObjects, use: 'verification' },
    ]);
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

  it('el db:migrate de la API corre el CLI compilado de apps/api con WORKER_NODE_FLAGS y 120 s de plazo', () => {
    expect(workerChildScript('api_migrate', [], env)).toEqual({
      args: [],
      env,
      nodeFlags: WORKER_NODE_FLAGS,
      script: fileURLToPath(new URL('../../api/dist/cli/migrate.js', import.meta.url)),
      timeoutMs: 120_000,
    });
  });
});

// `LogLocation` se usa en los tipos de las bases falsas.
export type { LogLocation };

// Los datasets vivos en `buoh-operaciones` (ADR-0020 §5, §8 y §9; PR 4 de su §13): el paso 1 con
// `buoh_datasets` y `buoh_publicacion`, el paso 6 (`publication`) y el paso 7
// (`dataset_verification`). Las expectativas salen de §8: los entornos explícitos, como mucho una
// publicación por ejecución, los logs detenidos hasta un cambio del código, las tres ejecuciones sin
// un resultado concluyente, el límite de 150 s y los tres estados de la verificación.

const PUBLICATION_PASSWORD = 'publicacion-sintetica-0123456789';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const DATASETS_CONFIG = loadOperationsConfig({
  ...ENV,
  BUOH_PUBLICACION_POSTGRES_PASSWORD: PUBLICATION_PASSWORD,
  RENDER_GIT_COMMIT: COMMIT_A,
});
const DATASET = `sha256:${'d'.repeat(64)}`;
const PUBLICATION = '019b76da-a800-7000-8000-00000000d001';
const PUBLICATION_2 = '019b76da-a800-7000-8000-00000000d002';
const DATASET_2 = `sha256:${'e'.repeat(64)}`;

const publishedLine = (log: number, first: number, last: number) =>
  JSON.stringify({
    behind: null,
    clean: true,
    dataset_id: DATASET,
    duration_ms: 4000,
    elements: 1000,
    first_segment: first,
    incident_count: 0,
    last_segment: last,
    log,
    max_rss_bytes: 150 * 1048576,
    normalized_tick_count: 900,
    open_condition_types: [],
    pending_continuity_symbols: [],
    publication_id: PUBLICATION,
    source_event_count: 1000,
    status: 'published',
  });
const nothingDueLine = (behind: unknown = null) =>
  JSON.stringify({ behind, duration_ms: 100, max_rss_bytes: 90 * 1048576, status: 'nothing_due' });
const failedLine = (reason: string, log: number | null, first?: number, behind: unknown = null) =>
  JSON.stringify({
    behind,
    detail: 'x',
    duration_ms: 100,
    ...(first === undefined ? {} : { first_segment: first }),
    log,
    max_rss_bytes: 90 * 1048576,
    reason,
    stage: 'plan',
    status: 'failed',
  });
const attempt = (log: number, first: number) =>
  `${JSON.stringify({ event: 'publication_attempt', first_segment: first, log })}\n`;
const replayLine = (
  mode: 'recompute' | 'verify-only',
  publication = PUBLICATION,
  dataset = DATASET,
) =>
  JSON.stringify({
    condition_event_count: 0,
    dataset_id: dataset,
    deployment_environment: 'production',
    incident_count: 0,
    logical_artifact_count: 6,
    max_rss_bytes: 170 * 1048576,
    mode,
    normalized_tick_count: 900,
    publication_id: publication,
    raw_frame_count: 1000,
    source_event_count: 1000,
    status: mode === 'recompute' ? 'reproduced' : 'verified',
    storage_object_count: 8,
  });
const replayFailedLine = (code: string) =>
  JSON.stringify({
    code,
    dataset_id: DATASET,
    details: { artifact_id: 'normalized_ticks:000000' },
    max_rss_bytes: 100 * 1048576,
    message: 'texto del replay',
    mode: 'recompute',
    status: 'failed',
  });

/** Una base con el log 1 terminado y el 2 activo, con sus contraseñas. */
function datasetsDatabase(
  extra: Partial<Parameters<typeof fakeDatabase>[0]> = {},
): ReturnType<typeof fakeDatabase> {
  return fakeDatabase({
    loggedIn: new Set(['buoh_agente', 'buoh_ingesta', 'buoh_salud', 'buoh_publicacion']),
    logs: [log(1, '2026-03-01T00:00:00.000Z'), log(2, '2026-03-02T09:59:00.000Z'), log(3)],
    ...extra,
  });
}

/** Procesos con una respuesta para `publish` y otra para `replay`; los demás, los de siempre. */
function datasetsChildren(answers: {
  publish?: (args: readonly string[]) => Partial<ChildResult>;
  replay?: (args: readonly string[]) => Partial<ChildResult>;
}) {
  return fakeChildren((child, args) => {
    if (child === 'publish') {
      return answers.publish?.(args) ?? { exitCode: 0, stdout: nothingDueLine() };
    }
    if (child === 'replay') {
      return answers.replay?.(args) ?? { exitCode: 1, stdout: replayFailedLine('UNEXPECTED') };
    }
    return {};
  });
}

/** IDs que crecen de una ejecución a otra, como los UUIDv7 del servicio. */
let datasetsSequence = 10_000;
const growing = () => uuid((datasetsSequence += 1));

const stepLine = (lines: readonly Record<string, unknown>[], step: string) =>
  lines.find((line) => line['step'] === step);

describe('la configuración de los datasets vivos (ADR-0020 §5 y §8)', () => {
  it('lee la contraseña de buoh_publicacion y el commit de Render, que es opcional', () => {
    expect(DATASETS_CONFIG.publicationPassword).toBe(PUBLICATION_PASSWORD);
    expect(DATASETS_CONFIG.codeVersion).toBe(COMMIT_A);
    expect(CONFIG.publicationPassword).toBeNull();
    for (const value of ['', 'xyz', 'A'.repeat(40), '123456']) {
      expect(loadOperationsConfig({ ...ENV, RENDER_GIT_COMMIT: value }).codeVersion, value).toBe(
        null,
      );
    }
    expect(() =>
      loadOperationsConfig({ ...ENV, BUOH_PUBLICACION_POSTGRES_PASSWORD: 'corta' }),
    ).toThrow(ConfigError);
  });

  it('la publicación recibe solo buoh_publicacion y el token operaciones, sin esquema', () => {
    expect(publishEnvironment(DATASETS_CONFIG)).toEqual({
      BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
      BUOH_POSTGRES_DB: 'buoh',
      BUOH_POSTGRES_HOST: 'pg-sintetico.invalid',
      BUOH_POSTGRES_PASSWORD: PUBLICATION_PASSWORD,
      BUOH_POSTGRES_PORT: '5432',
      BUOH_POSTGRES_SSLMODE: 'require',
      BUOH_POSTGRES_USER: 'buoh_publicacion',
      BUOH_S3_ACCESS_KEY_ID: 'clave-operaciones-sintetica',
      BUOH_S3_BUCKET: 'buoh-captura',
      BUOH_S3_ENDPOINT: 'https://cuenta-sintetica.r2.invalid',
      BUOH_S3_REGION: 'auto',
      BUOH_S3_SECRET_ACCESS_KEY: 'secreto-operaciones-sintetico',
    });
    expect(() => publishEnvironment(CONFIG)).toThrow(TypeError);
  });

  it('la verificación recibe solo buoh_salud y el token salud, sin esquema', () => {
    expect(replayEnvironment(DATASETS_CONFIG)).toEqual(healthEnvironment(DATASETS_CONFIG));
    expect(replayEnvironment(DATASETS_CONFIG)).toMatchObject({
      BUOH_POSTGRES_USER: 'buoh_salud',
      BUOH_S3_ACCESS_KEY_ID: 'clave-salud-sintetica',
    });
    expect(replayEnvironment(DATASETS_CONFIG)).not.toHaveProperty('BUOH_POSTGRES_SCHEMA');
  });

  it('los procesos de los datasets son los del worker, con sus tamaños de V8 y sus plazos', () => {
    for (const [child, script] of [
      ['datasets_migrate', 'migrate-datasets.js'],
      ['publish', 'publish-dataset.js'],
      ['replay', 'replay.js'],
    ] as const) {
      const spec = workerChildScript(child, [], {});
      expect(
        spec.script.endsWith(`/dist/cli/${script}`) || spec.script.endsWith(`/src/cli/${script}`),
      ).toBe(true);
      expect(spec.nodeFlags).toEqual(WORKER_NODE_FLAGS);
    }
    expect(workerChildScript('publish', [], {}).timeoutMs).toBe(60_000);
    expect(workerChildScript('replay', [], {}, { timeoutMs: 12_000 }).timeoutMs).toBe(12_000);
    expect(workerChildScript('replay', [], {}, { timeoutMs: 90_000 }).timeoutMs).toBe(60_000);
    expect(workerChildScript('datasets_migrate', [], {}).timeoutMs).toBe(120_000);
  });
});

describe('el paso 1 con los datasets vivos (ADR-0020 §5)', () => {
  it('sin la contraseña de buoh_publicacion no toca los datasets, y los pasos 6 y 7 no corren', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({});
    const { lines } = await run(db, children);
    expect(db.calls).not.toContain('publication_role');
    expect(children.runs.map((item) => item.child)).not.toContain('datasets_migrate');
    expect(children.runs.map((item) => item.child)).not.toContain('publish');
    expect(lines.map((line) => line['step']).filter(Boolean)).not.toContain('publication');
    expect(lines.map((line) => line['step']).filter(Boolean)).not.toContain('dataset_verification');
    expect(stepLine(lines, 'roles_and_logs')?.['report']).not.toHaveProperty('datasets_migrated');
  });

  it('con ella: el rol, las migraciones de buoh_datasets con la credencial dueña, los privilegios y su contraseña', async () => {
    const db = datasetsDatabase({
      loggedIn: new Set(['buoh_agente', 'buoh_ingesta', 'buoh_salud']),
    });
    const children = fakeChildren((child) =>
      child === 'datasets_migrate'
        ? {
            stdout: JSON.stringify({
              applied: ['0001_datasets.sql'],
              current: ['0001_datasets.sql'],
              status: 'migrated',
            }),
          }
        : child === 'publish'
          ? { exitCode: 0, stdout: nothingDueLine() }
          : {},
    );
    const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const step1 = db.calls.slice(0, db.calls.indexOf('login:buoh_publicacion') + 2);
    expect(step1.filter((call) => /publication|datasets|buoh_publicacion/u.test(call))).toEqual([
      'publication_role',
      'datasets_grant',
      'login:buoh_publicacion',
      'password:buoh_publicacion',
    ]);
    const migrateRun = children.runs.find((item) => item.child === 'datasets_migrate');
    expect(migrateRun?.env).toEqual(apiMigrateEnvironment(DATASETS_CONFIG));
    expect(stepLine(lines, 'roles_and_logs')).toMatchObject({
      report: {
        datasets_migrated: ['0001_datasets.sql'],
        failures: [],
        passwords_set: ['buoh_publicacion'],
      },
      status: 'completed',
    });
  });

  it('sin el rol no pone su contraseña; con las migraciones fallidas sí, y no da privilegios', async () => {
    const noRole = datasetsDatabase({ fail: { ensurePublicationRole: coded('42501') } });
    const one = await run(noRole, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(noRole.calls).not.toContain('login:buoh_publicacion');
    expect(stepLine(one.lines, 'roles_and_logs')).toMatchObject({
      report: { failures: [{ action: 'publication_role', reason: '42501' }] },
      status: 'failed',
    });
    const noMigrate = datasetsDatabase();
    const children = fakeChildren((child) =>
      child === 'datasets_migrate'
        ? { exitCode: 1, stdout: JSON.stringify({ code: 'MIGRATION_FAILED', reason: '42501' }) }
        : child === 'publish'
          ? { exitCode: 0, stdout: nothingDueLine() }
          : {},
    );
    const two = await run(noMigrate, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(noMigrate.calls).toContain('login:buoh_publicacion');
    expect(noMigrate.calls).not.toContain('datasets_grant');
    expect(stepLine(two.lines, 'roles_and_logs')?.['report']).toMatchObject({
      failures: [{ action: 'datasets_migrate', reason: '42501' }],
    });
    const noGrant = datasetsDatabase({ fail: { grantDatasetsPrivileges: coded('XX000') } });
    const three = await run(noGrant, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(stepLine(three.lines, 'roles_and_logs')?.['report']).toMatchObject({
      failures: [{ action: 'datasets_grant', reason: 'XX000' }],
    });
  });
});

describe('el paso 6, publication (ADR-0020 §8)', () => {
  it('corre datasets:publish con su entorno y 60 s, y guarda en el log activo lo que publicó', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: () => ({ exitCode: 0, stdout: publishedLine(1, 0, 71) }),
    });
    const { alerts, lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const publish = children.runs.filter((item) => item.child === 'publish');
    expect(publish).toEqual([
      { args: [], child: 'publish', env: publishEnvironment(DATASETS_CONFIG), timeoutMs: 60_000 },
    ]);
    expect(alerts).toEqual([]);
    const line = stepLine(lines, 'publication');
    expect(line).toMatchObject({ log: null, status: 'completed' });
    expect(line?.['report']).toEqual({
      behind: null,
      code_version: COMMIT_A,
      result: {
        clean: true,
        dataset_id: DATASET,
        duration_ms: 4000,
        elements: 1000,
        first_segment: 0,
        incident_count: 0,
        last_segment: 71,
        log: 1,
        max_rss_bytes: 150 * 1048576,
        normalized_tick_count: 900,
        open_condition_types: [],
        pending_continuity_symbols: [],
        publication_id: PUBLICATION,
        source_event_count: 1000,
        status: 'published',
      },
      skipped: [],
      state: { attempts: null, stopped: [] },
    });
    // El informe va al log activo, el 2.
    expect(
      db.reports.filter((item) => item.row.step === 'publication').map((item) => item.log),
    ).toEqual([2]);
  });

  it('sin nada pendiente y sin estado no guarda nada; con atraso deja publication_behind', async () => {
    const db = datasetsDatabase();
    const quiet = await run(db, datasetsChildren({}), { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(quiet.lines, 'publication')).toMatchObject({ status: 'completed' });
    expect(db.reports.some((item) => item.row.step === 'publication')).toBe(false);
    expect(quiet.alerts).toEqual([]);
    const behind = { expires_at_utc: '2026-03-04T00:00:00.000Z', log: 1 };
    const late = await run(
      datasetsDatabase(),
      datasetsChildren({ publish: () => ({ exitCode: 0, stdout: nothingDueLine(behind) }) }),
      { config: DATASETS_CONFIG, nextId: growing },
    );
    expect(late.alerts).toEqual([
      { event: 'publication_behind', expires_at_utc: '2026-03-04T00:00:00.000Z', log: '1' },
    ]);
    expect(stepLine(late.lines, 'publication')?.['report']).toMatchObject({ behind });
  });

  it.each([
    'publication_segment_too_large',
    'publication_limit_exceeded',
    'publication_conflict',
    'publication_not_derivable',
  ])(
    '%s detiene el log: la ejecución siguiente lo salta, con su alerta, hasta otro commit',
    async (reason) => {
      const db = datasetsDatabase();
      let publishes = 0;
      const children = datasetsChildren({
        publish: () => {
          publishes += 1;
          return publishes === 1
            ? { exitCode: 1, stdout: failedLine(reason, 1, 72) }
            : { exitCode: 0, stdout: nothingDueLine() };
        },
      });
      const first = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(stepLine(first.lines, 'publication')).toMatchObject({
        report: {
          reason,
          state: {
            attempts: null,
            stopped: [{ code_version: COMMIT_A, first_segment: 72, log: 1, reason }],
          },
        },
        status: 'failed',
      });
      expect(first.alerts).toContainEqual({ event: reason, first_segment: '72', log: '1' });
      const second = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(children.runs.filter((item) => item.child === 'publish').at(-1)?.args).toEqual([
        '--skip',
        '1',
      ]);
      expect(second.alerts).toContainEqual({ event: reason, first_segment: '72', log: '1' });
      expect(stepLine(second.lines, 'publication')).toMatchObject({ status: 'failed' });
      // Con otro commit, el log vuelve a intentarse.
      const other = loadOperationsConfig({
        ...ENV,
        BUOH_PUBLICACION_POSTGRES_PASSWORD: PUBLICATION_PASSWORD,
        RENDER_GIT_COMMIT: COMMIT_B,
      });
      const third = await run(db, children, { config: other, nextId: growing });
      expect(children.runs.filter((item) => item.child === 'publish').at(-1)?.args).toEqual([]);
      expect(stepLine(third.lines, 'publication')).toMatchObject({
        report: { state: { stopped: [] } },
        status: 'completed',
      });
      expect(third.alerts.some((item) => item['event'] === reason)).toBe(false);
    },
  );

  it('un log detenido que venció deja de contar', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: () => ({ exitCode: 1, stdout: failedLine('publication_conflict', 1, 0) }),
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    // 30 días después de la última escritura del log 1.
    const later = '2026-03-31T00:00:00.000Z';
    const after = datasetsChildren({});
    await run(db, after, { config: DATASETS_CONFIG, nextId: growing, now: () => later });
    expect(after.runs.find((item) => item.child === 'publish')?.args).toEqual([]);
  });

  it.each([
    ['un plazo vencido', { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true }],
    ['un proceso que muere sin memoria', { exitCode: null, stderr: attempt(1, 144), stdout: '' }],
    ['una salida sin su línea', { exitCode: 0, stderr: attempt(1, 144), stdout: 'no es JSON' }],
    ['un error inesperado', { exitCode: 1, stdout: failedLine('unexpected', 1, 144) }],
  ] as const)(
    '%s, tres veces seguidas con el mismo dataset, detiene el log con publication_incomplete',
    async (_name, answer) => {
      const db = datasetsDatabase();
      const children = datasetsChildren({ publish: () => answer });
      const one = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(stepLine(one.lines, 'publication')).toMatchObject({
        report: { state: { attempts: { count: 1, first_segment: 144, log: 1 }, stopped: [] } },
        status: 'failed',
      });
      const two = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(stepLine(two.lines, 'publication')?.['report']).toMatchObject({
        state: { attempts: { count: 2, first_segment: 144, log: 1 } },
      });
      const three = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(stepLine(three.lines, 'publication')?.['report']).toMatchObject({
        reason: expect.any(String) as unknown,
        state: {
          attempts: null,
          stopped: [
            {
              code_version: COMMIT_A,
              first_segment: 144,
              log: 1,
              reason: 'publication_incomplete',
            },
          ],
        },
      });
      expect(three.alerts).toContainEqual({
        event: 'publication_incomplete',
        first_segment: '144',
        log: '1',
      });
      await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(children.runs.filter((item) => item.child === 'publish').at(-1)?.args).toEqual([
        '--skip',
        '1',
      ]);
    },
  );

  it('la cuenta es por dataset: otro dataset empieza en 1, y una publicación la pone a cero', async () => {
    const db = datasetsDatabase();
    const answers: Partial<ChildResult>[] = [
      { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true },
      { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true },
      { exitCode: null, stderr: attempt(1, 216), stdout: '', timedOut: true },
      { exitCode: 0, stdout: publishedLine(1, 216, 287) },
      { exitCode: null, stderr: attempt(1, 288), stdout: '', timedOut: true },
    ];
    const children = datasetsChildren({ publish: () => answers.shift() ?? {} });
    const counts: unknown[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      const report = stepLine(lines, 'publication')?.['report'] as { state: { attempts: unknown } };
      counts.push(report.state.attempts);
    }
    expect(counts).toEqual([
      { count: 1, first_segment: 144, log: 1 },
      { count: 2, first_segment: 144, log: 1 },
      { count: 1, first_segment: 216, log: 1 },
      null,
      { count: 1, first_segment: 288, log: 1 },
    ]);
  });

  it('un almacén que no responde o un COMMIT ambiguo se repiten sin contar', async () => {
    const db = datasetsDatabase();
    const answers: Partial<ChildResult>[] = [
      { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true },
      { exitCode: 1, stdout: failedLine('storage_unavailable', 1, 144) },
      { exitCode: 1, stdout: failedLine('commit_outcome_unknown', 1, 144) },
      { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true },
    ];
    const children = datasetsChildren({ publish: () => answers.shift() ?? {} });
    const counts: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      const line = stepLine(lines, 'publication');
      expect(line?.['status']).toBe('failed');
      counts.push((line?.['report'] as { state: { attempts: unknown } }).state.attempts);
    }
    expect(counts).toEqual([
      { count: 1, first_segment: 144, log: 1 },
      { count: 1, first_segment: 144, log: 1 },
      { count: 1, first_segment: 144, log: 1 },
      { count: 2, first_segment: 144, log: 1 },
    ]);
  });

  it('un proceso que muere sin decir qué intentaba no cuenta; un error de configuración tampoco', async () => {
    const db = datasetsDatabase();
    const answers: Partial<ChildResult>[] = [
      { exitCode: null, stdout: '', timedOut: true },
      { exitCode: 2, stdout: JSON.stringify({ code: 'ConfigError', status: 'failed' }) },
    ];
    const children = datasetsChildren({ publish: () => answers.shift() ?? {} });
    const one = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(one.lines, 'publication')).toMatchObject({
      report: { reason: 'child_timeout', state: { attempts: null, stopped: [] } },
      status: 'failed',
    });
    const two = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(two.lines, 'publication')).toMatchObject({
      report: { reason: 'publish_config_invalid', state: { attempts: null, stopped: [] } },
      status: 'failed',
    });
  });

  it('el estado sigue al log activo nuevo: lee el informe más reciente de cualquier log', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: () => ({ exitCode: 1, stdout: failedLine('publication_conflict', 1, 0) }),
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(db.reports.find((item) => item.row.step === 'publication')?.log).toBe(2);
    // Corte: el log 3 recibe escrituras y pasa a ser el activo, con los informes de antes.
    const after = datasetsChildren({
      publish: () => ({ exitCode: 1, stdout: failedLine('publication_limit_exceeded', 3, 0) }),
    });
    const moved = fakeDatabase({
      loggedIn: new Set(['buoh_agente', 'buoh_ingesta', 'buoh_salud', 'buoh_publicacion']),
      logs: [
        log(1, '2026-03-01T00:00:00.000Z'),
        log(2, '2026-03-02T09:00:00.000Z'),
        log(3, '2026-03-02T09:59:00.000Z'),
        log(4),
      ],
    });
    for (const item of db.reports) {
      moved.reports.push(item);
    }
    await run(moved, after, { config: DATASETS_CONFIG, nextId: growing });
    expect(after.runs.find((item) => item.child === 'publish')?.args).toEqual(['--skip', '1']);
    const stored = moved.reports.filter((item) => item.row.step === 'publication').at(-1);
    expect(stored?.log).toBe(3);
    expect(stored?.row.report['state']).toMatchObject({
      stopped: [
        { log: 1, reason: 'publication_conflict' },
        { log: 3, reason: 'publication_limit_exceeded' },
      ],
    });
  });

  it('con logs detenidos y nada nuevo, el paso falla con su alerta y guarda su informe, como siempre que falla', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: (args) =>
        args.length === 0
          ? { exitCode: 1, stdout: failedLine('publication_conflict', 1, 0) }
          : { exitCode: 0, stdout: nothingDueLine() },
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const before = db.reports.filter((item) => item.row.step === 'publication').length;
    const again = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(again.lines, 'publication')).toMatchObject({
      report: { reason: 'publication_conflict' },
      status: 'failed',
    });
    expect(again.alerts).toContainEqual({
      event: 'operations_step_failed',
      reason: 'publication_conflict',
      step: 'publication',
    });
    expect(db.reports.filter((item) => item.row.step === 'publication')).toHaveLength(before + 1);
  });

  it('una línea failed con behind también deja publication_behind', async () => {
    const behind = { expires_at_utc: '2026-03-04T00:00:00.000Z', log: 1 };
    const { alerts, lines } = await run(
      datasetsDatabase(),
      datasetsChildren({
        publish: () => ({ exitCode: 1, stdout: failedLine('storage_unavailable', 1, 0, behind) }),
      }),
      { config: DATASETS_CONFIG, nextId: growing },
    );
    expect(alerts).toContainEqual({
      event: 'publication_behind',
      expires_at_utc: '2026-03-04T00:00:00.000Z',
      log: '1',
    });
    expect(stepLine(lines, 'publication')?.['report']).toMatchObject({ behind });
  });

  it('un fallo de antes de leer el estado no lo borra: la ejecución siguiente sigue con el anterior', async () => {
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: (args) =>
        args.length === 0
          ? { exitCode: 1, stdout: failedLine('publication_conflict', 1, 0) }
          : { exitCode: 0, stdout: nothingDueLine() },
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const latest = db.database.latestReportWithState.bind(db.database);
    db.database.latestReportWithState = (target, step) =>
      step === 'publication' ? Promise.reject(coded('57014')) : latest(target, step);
    const broken = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(broken.lines, 'publication')).toMatchObject({
      report: { reason: '57014' },
      status: 'failed',
    });
    db.database.latestReportWithState = latest;
    const healed = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(children.runs.filter((item) => item.child === 'publish').at(-1)?.args).toEqual([
      '--skip',
      '1',
    ]);
    expect(stepLine(healed.lines, 'publication')?.['report']).toMatchObject({
      reason: 'publication_conflict',
      state: { stopped: [{ first_segment: 0, log: 1, reason: 'publication_conflict' }] },
    });
  });

  it('con un informe del paso que no tiene la forma esperada falla sin publicar', async () => {
    const db = datasetsDatabase();
    db.reports.push({
      log: 2,
      row: {
        observed_at_utc: NOW,
        report: { state: { stopped: 'roto' } },
        report_id: uuid(999),
        run_id: uuid(998),
        status: 'failed',
        step: 'publication',
      },
    });
    const children = datasetsChildren({});
    const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(lines, 'publication')).toMatchObject({
      report: { reason: 'publication_state_invalid' },
      status: 'failed',
    });
    expect(children.runs.some((item) => item.child === 'publish')).toBe(false);
  });

  it('solo empieza si la ejecución lleva menos de 150 s', async () => {
    let calls = 0;
    const start = Date.parse(NOW);
    // La primera hora es la del inicio de la ejecución; después, 150 s más tarde.
    const now = () => new Date(calls++ === 0 ? start : start + 150_000).toISOString();
    const children = datasetsChildren({});
    const { lines } = await run(datasetsDatabase(), children, {
      config: DATASETS_CONFIG,
      nextId: growing,
      now,
    });
    expect(stepLine(lines, 'publication')).toMatchObject({
      report: { deferred: true },
      status: 'completed',
    });
    expect(stepLine(lines, 'dataset_verification')).toMatchObject({ report: { deferred: true } });
    expect(children.runs.some((item) => item.child === 'publish' || item.child === 'replay')).toBe(
      false,
    );
    let early = 0;
    const justInTime = () => new Date(early++ === 0 ? start : start + 149_999).toISOString();
    const second = datasetsChildren({});
    await run(datasetsDatabase(), second, {
      config: DATASETS_CONFIG,
      nextId: growing,
      now: justInTime,
    });
    expect(second.runs.some((item) => item.child === 'publish')).toBe(true);
  });

  it('la línea del proceso pasa al informe solo con sus campos conocidos', async () => {
    const line = JSON.parse(publishedLine(1, 0, 71)) as Record<string, unknown>;
    const db = datasetsDatabase();
    const children = datasetsChildren({
      publish: () => ({ exitCode: 0, stdout: JSON.stringify({ ...line, quote: '1234.56' }) }),
    });
    const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(JSON.stringify(stepLine(lines, 'publication'))).not.toContain('1234.56');
  });
});

describe('el paso 7, dataset_verification (ADR-0020 §8)', () => {
  const pending = [
    { dataset_id: DATASET, publication_id: PUBLICATION },
    { dataset_id: DATASET_2, publication_id: PUBLICATION_2 },
  ];

  it('verifica la publicación más antigua en los dos modos, con buoh_salud y el plazo del paso, y guarda cada resultado como passed', async () => {
    const db = datasetsDatabase({ publications: pending });
    const children = datasetsChildren({
      replay: (args) => ({
        exitCode: 0,
        stdout: replayLine(args.includes('--verify-only') ? 'verify-only' : 'recompute'),
      }),
    });
    const { alerts, lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const replays = children.runs.filter((item) => item.child === 'replay');
    expect(replays.map((item) => item.args)).toEqual([
      ['--dataset', DATASET, '--verify-only'],
      ['--dataset', DATASET],
    ]);
    expect(
      replays.every(
        (item) => canonicalJson(item.env) === canonicalJson(replayEnvironment(DATASETS_CONFIG)),
      ),
    ).toBe(true);
    expect(
      replays.every((item) => (item.timeoutMs ?? 0) > 0 && (item.timeoutMs ?? 0) <= 60_000),
    ).toBe(true);
    expect(
      db.verifications.map((row) => [row.mode, row.status, row.exit_code, row.error_code]),
    ).toEqual([
      ['verify-only', 'passed', 0, null],
      ['recompute', 'passed', 0, null],
    ]);
    const [first] = db.verifications;
    expect(first).toMatchObject({
      dataset_id: DATASET,
      publication_id: PUBLICATION,
      verified_at_utc: NOW,
    });
    expect(first?.report).toMatchObject({ max_rss_bytes: 170 * 1048576, status: 'verified' });
    // La ejecución de la verificación es la de buoh-operaciones.
    const runLine = lines.at(-1);
    expect(first?.run_id).toBe(runLine?.['run_id']);
    expect(alerts).toEqual([]);
    expect(stepLine(lines, 'dataset_verification')).toMatchObject({
      report: { dataset_id: DATASET, publication_id: PUBLICATION, state: { attempts: null } },
      status: 'completed',
    });
    // La siguiente pasa a la publicación siguiente.
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(
      children.runs
        .filter((item) => item.child === 'replay')
        .at(-1)
        ?.args.slice(0, 2),
    ).toEqual(['--dataset', DATASET_2]);
  });

  it('un fallo de integridad o de recomputación queda como failed, con su código, sin el mensaje, y su alerta', async () => {
    const db = datasetsDatabase({ publications: pending.slice(0, 1) });
    const children = datasetsChildren({
      replay: (args) =>
        args.includes('--verify-only')
          ? { exitCode: 1, stdout: replayFailedLine('OBJECT_INTEGRITY') }
          : { exitCode: 1, stdout: replayFailedLine('RECOMPUTATION_MISMATCH') },
    });
    const { alerts, lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(
      db.verifications.map((row) => [row.mode, row.status, row.exit_code, row.error_code]),
    ).toEqual([
      ['verify-only', 'failed', 1, 'OBJECT_INTEGRITY'],
      ['recompute', 'failed', 1, 'RECOMPUTATION_MISMATCH'],
    ]);
    expect(JSON.stringify(db.verifications)).not.toMatch(/texto del replay|normalized_ticks/u);
    expect(alerts).toContainEqual({
      dataset_id: DATASET,
      error_code: 'OBJECT_INTEGRITY',
      event: 'dataset_verification_failed',
      mode: 'verify-only',
    });
    // Es un resultado: el paso no falla.
    expect(stepLine(lines, 'dataset_verification')?.['status']).toBe('completed');
  });

  it.each([
    [
      'un almacén que no responde',
      'storage_unavailable',
      replayFailedLine('STORAGE_UNAVAILABLE'),
      1,
    ],
    ['una salida 2, de uso o de configuración', 'replay_config_invalid', '{}', 2],
  ] as const)(
    '%s no guarda nada ni cuenta, y el paso falla',
    async (_name, reason, stdout, exitCode) => {
      const db = datasetsDatabase({ publications: pending.slice(0, 1) });
      const answers: Partial<ChildResult>[] = [
        { exitCode: null, stdout: '', timedOut: true },
        { exitCode, stdout },
      ];
      const children = datasetsChildren({ replay: () => answers.shift() ?? {} });
      await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(db.verifications).toEqual([]);
      expect(children.runs.filter((item) => item.child === 'replay')).toHaveLength(2);
      expect(stepLine(lines, 'dataset_verification')).toMatchObject({
        report: {
          reason,
          state: { attempts: { count: 1, mode: 'verify-only', publication_id: PUBLICATION } },
        },
        status: 'failed',
      });
    },
  );

  it('un fallo de antes de leer el estado no lo borra: la ejecución siguiente sigue con la cuenta', async () => {
    const db = datasetsDatabase({ publications: pending.slice(0, 1) });
    const children = datasetsChildren({
      replay: () => ({ exitCode: null, stdout: '', timedOut: true }),
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const next = db.database.nextPublicationToVerify.bind(db.database);
    db.database.nextPublicationToVerify = () => Promise.reject(coded('42P01'));
    const broken = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(broken.lines, 'dataset_verification')).toMatchObject({
      report: { reason: '42P01' },
      status: 'failed',
    });
    db.database.nextPublicationToVerify = next;
    const healed = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(healed.lines, 'dataset_verification')?.['report']).toMatchObject({
      state: { attempts: { count: 2, mode: 'verify-only', publication_id: PUBLICATION } },
    });
  });

  it.each([
    ['UNEXPECTED', { exitCode: 1, stdout: replayFailedLine('UNEXPECTED') }, 1],
    ['CHILD_TIMEOUT', { exitCode: null, stdout: '', timedOut: true }, null],
    ['CHILD_KILLED', { exitCode: null, stdout: '' }, null],
    ['REPLAY_OUTPUT_INVALID', { exitCode: 0, stdout: 'no es JSON' }, null],
  ] as const)(
    'tres ejecuciones seguidas sin un resultado concluyente (%s) guardan incomplete, y sigue con el modo siguiente',
    async (code, answer, exit) => {
      const db = datasetsDatabase({ publications: pending.slice(0, 1) });
      const children = datasetsChildren({
        replay: (args) =>
          args.includes('--verify-only')
            ? answer
            : { exitCode: 0, stdout: replayLine('recompute') },
      });
      for (const expected of [1, 2]) {
        const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
        expect(stepLine(lines, 'dataset_verification')).toMatchObject({
          report: {
            state: {
              attempts: { count: expected, mode: 'verify-only', publication_id: PUBLICATION },
            },
          },
          status: 'failed',
        });
        expect(db.verifications).toEqual([]);
      }
      const { alerts, lines } = await run(db, children, {
        config: DATASETS_CONFIG,
        nextId: growing,
      });
      expect(
        db.verifications.map((row) => [row.mode, row.status, row.exit_code, row.error_code]),
      ).toEqual([
        ['verify-only', 'incomplete', exit, code],
        ['recompute', 'passed', 0, null],
      ]);
      expect(alerts).toContainEqual({
        dataset_id: DATASET,
        error_code: code,
        event: 'dataset_verification_failed',
        mode: 'verify-only',
      });
      expect(stepLine(lines, 'dataset_verification')?.['report']).toMatchObject({
        state: { attempts: null },
      });
    },
  );

  it('una línea de otro dataset, de otra publicación o de otro modo no cuenta como passed', async () => {
    for (const line of [
      replayLine('verify-only', PUBLICATION, DATASET_2),
      replayLine('verify-only', PUBLICATION_2),
      replayLine('recompute'),
    ]) {
      const db = datasetsDatabase({ publications: pending.slice(0, 1) });
      const children = datasetsChildren({ replay: () => ({ exitCode: 0, stdout: line }) });
      const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(db.verifications).toEqual([]);
      expect(stepLine(lines, 'dataset_verification')?.['report']).toMatchObject({
        state: { attempts: { count: 1, mode: 'verify-only' } },
      });
    }
  });

  it('solo corre los modos que faltan, y los dos dentro de los 60 s del paso', async () => {
    const db = datasetsDatabase({ publications: pending.slice(0, 1) });
    db.verifications.push({
      dataset_id: DATASET,
      error_code: null,
      exit_code: 0,
      mode: 'verify-only',
      publication_id: PUBLICATION,
      report: {},
      run_id: uuid(990),
      status: 'passed',
      verification_id: uuid(991),
      verified_at_utc: NOW,
    });
    const children = datasetsChildren({
      replay: () => ({ exitCode: 0, stdout: replayLine('recompute') }),
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(
      children.runs.filter((item) => item.child === 'replay').map((item) => item.args),
    ).toEqual([['--dataset', DATASET]]);

    // Con la primera verificación tardando 59 s, a la segunda le queda 1 s; con 60 s, no corre.
    for (const [spent, expected] of [
      [59_000, 1_000],
      [60_000, null],
    ] as const) {
      let clock = Date.parse(NOW);
      const db2 = datasetsDatabase({ publications: pending.slice(0, 1) });
      const timed = datasetsChildren({
        replay: (args) => {
          if (args.includes('--verify-only')) {
            clock += spent;
            return { exitCode: 0, stdout: replayLine('verify-only') };
          }
          return { exitCode: 0, stdout: replayLine('recompute') };
        },
      });
      const { lines } = await run(db2, timed, {
        config: DATASETS_CONFIG,
        nextId: growing,
        now: () => new Date(clock).toISOString(),
      });
      const second = timed.runs.filter((item) => item.child === 'replay')[1];
      expect(second?.timeoutMs ?? null).toBe(expected);
      if (expected === null) {
        expect(stepLine(lines, 'dataset_verification')).toMatchObject({
          report: { reason: 'deadline_exceeded' },
          status: 'failed',
        });
      }
    }
  });

  it('sin nada que verificar no guarda nada, y un PostgreSQL que no responde es un fallo', async () => {
    const db = datasetsDatabase();
    const { lines } = await run(db, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(stepLine(lines, 'dataset_verification')).toMatchObject({ status: 'completed' });
    expect(db.reports.some((item) => item.row.step === 'dataset_verification')).toBe(false);
    const down = datasetsDatabase({ fail: { nextPublicationToVerify: coded('ECONNREFUSED') } });
    const failed = await run(down, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(stepLine(failed.lines, 'dataset_verification')).toMatchObject({
      report: { reason: 'ECONNREFUSED' },
      status: 'failed',
    });
  });

  it('si no puede guardar un resultado, el paso falla con su motivo', async () => {
    const db = datasetsDatabase({
      fail: { appendDatasetVerification: coded('23514') },
      publications: pending.slice(0, 1),
    });
    const children = datasetsChildren({
      replay: () => ({ exitCode: 0, stdout: replayLine('verify-only') }),
    });
    const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(lines, 'dataset_verification')).toMatchObject({
      report: { reason: '23514' },
      status: 'failed',
    });
    expect(children.runs.filter((item) => item.child === 'replay')).toHaveLength(1);
  });
});

describe('los pasos 6 y 7: casos que deciden (ADR-0020 §8)', () => {
  const stateReport = (logNumber: number, id: number, step: string, state: unknown) => ({
    log: logNumber,
    row: {
      observed_at_utc: NOW,
      report: { state } as Record<string, JsonValue>,
      report_id: uuid(id),
      run_id: uuid(id + 1),
      status: 'failed' as const,
      step,
    },
  });
  const stop = (logNumber: number) => ({
    code_version: COMMIT_A,
    first_segment: 0,
    log: logNumber,
    reason: 'publication_conflict',
  });

  it('el estado es el del informe más reciente de cualquier log, no el del primero que lo tiene', async () => {
    const db = datasetsDatabase();
    db.reports.push(stateReport(2, 500, 'publication', { attempts: null, stopped: [stop(1)] }));
    db.reports.push(stateReport(3, 501, 'publication', { attempts: null, stopped: [] }));
    const children = datasetsChildren({});
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(children.runs.find((item) => item.child === 'publish')?.args).toEqual([]);
  });

  it('no lee los informes de un log que no se puede leer', async () => {
    const db = datasetsDatabase();
    db.database.listLogs = () =>
      Promise.resolve([
        log(1, '2026-03-01T00:00:00.000Z'),
        log(2, '2026-03-02T09:59:00.000Z'),
        { ...log(3), readable: false },
      ]);
    const latest = db.database.latestReportWithState.bind(db.database);
    db.database.latestReportWithState = (target, step) =>
      target.number === 3 ? Promise.reject(coded('42501')) : latest(target, step);
    const { lines } = await run(db, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(stepLine(lines, 'publication')?.['status']).toBe('completed');
  });

  it('cada fallo sin resultado lleva su motivo', async () => {
    for (const [answer, reason] of [
      [{ exitCode: null, stderr: attempt(1, 1), stdout: '', timedOut: true }, 'child_timeout'],
      [{ exitCode: null, stderr: attempt(1, 1), stdout: '' }, 'child_killed'],
      [{ exitCode: 3, stderr: attempt(1, 1), stdout: '' }, 'publish_output_invalid'],
      // Una línea de publicación con otra salida, o una de fallo con salida 0, no valen.
      [
        { exitCode: 1, stderr: attempt(1, 1), stdout: publishedLine(1, 1, 2) },
        'publish_output_invalid',
      ],
      [
        { exitCode: 0, stderr: attempt(1, 1), stdout: failedLine('publication_conflict', 1, 1) },
        'publish_output_invalid',
      ],
    ] as const) {
      const db = datasetsDatabase();
      const { lines } = await run(db, datasetsChildren({ publish: () => answer }), {
        config: DATASETS_CONFIG,
        nextId: growing,
      });
      expect(stepLine(lines, 'publication')?.['report'], reason).toMatchObject({
        reason,
        state: { attempts: { count: 1, first_segment: 1, log: 1 }, stopped: [] },
      });
    }
  });

  it('un fallo sin primer segmento toma el dataset del aviso; un motivo que detiene sin dataset no detiene nada', async () => {
    const db = datasetsDatabase();
    const one = await run(
      db,
      datasetsChildren({
        publish: () => ({
          exitCode: 1,
          stderr: attempt(1, 144),
          stdout: failedLine('unexpected', 1),
        }),
      }),
      { config: DATASETS_CONFIG, nextId: growing },
    );
    expect(stepLine(one.lines, 'publication')?.['report']).toMatchObject({
      state: { attempts: { count: 1, first_segment: 144, log: 1 } },
    });
    const other = datasetsDatabase();
    const two = await run(
      other,
      datasetsChildren({
        publish: () => ({ exitCode: 1, stdout: failedLine('publication_conflict', null) }),
      }),
      { config: DATASETS_CONFIG, nextId: growing },
    );
    expect(stepLine(two.lines, 'publication')).toMatchObject({
      report: { reason: 'publication_conflict', state: { attempts: null, stopped: [] } },
      status: 'failed',
    });
  });

  it('la cuenta de un log que venció se olvida, y nada pendiente la pone a cero', async () => {
    const db = datasetsDatabase();
    const timeout = { exitCode: null, stderr: attempt(1, 144), stdout: '', timedOut: true };
    await run(db, datasetsChildren({ publish: () => timeout }), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    // 30 días después de la última escritura del log 1: otro intento del mismo dataset empieza en 1.
    const later = await run(db, datasetsChildren({ publish: () => timeout }), {
      config: DATASETS_CONFIG,
      nextId: growing,
      now: () => '2026-03-31T00:00:00.000Z',
    });
    expect(stepLine(later.lines, 'publication')?.['report']).toMatchObject({
      state: { attempts: { count: 1, first_segment: 144, log: 1 } },
    });
    const fresh = datasetsDatabase();
    await run(fresh, datasetsChildren({ publish: () => timeout }), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    const quiet = await run(fresh, datasetsChildren({}), {
      config: DATASETS_CONFIG,
      nextId: growing,
    });
    expect(stepLine(quiet.lines, 'publication')?.['report']).toMatchObject({
      result: { status: 'nothing_due' },
      state: { attempts: null },
    });
    // El estado cambió: se guarda aunque no publicó ni falló.
    expect(fresh.reports.filter((item) => item.row.step === 'publication')).toHaveLength(2);
  });

  it('la cuenta es por log y primer segmento: el mismo segmento de otro log empieza en 1', async () => {
    const db = datasetsDatabase();
    const answers = [attempt(1, 0), attempt(2, 0)];
    const children = datasetsChildren({
      publish: () => ({
        exitCode: null,
        stderr: answers.shift() ?? '',
        stdout: '',
        timedOut: true,
      }),
    });
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(stepLine(lines, 'publication')?.['report']).toMatchObject({
      state: { attempts: { count: 1, first_segment: 0, log: 2 } },
    });
  });

  it('la cuenta de la verificación es por publicación y por modo', async () => {
    for (const previous of [
      { count: 2, mode: 'verify-only', publication_id: PUBLICATION },
      { count: 2, mode: 'recompute', publication_id: PUBLICATION_2 },
    ]) {
      const db = datasetsDatabase({
        publications: [{ dataset_id: DATASET_2, publication_id: PUBLICATION_2 }],
      });
      db.reports.push(stateReport(2, 600, 'dataset_verification', { attempts: previous }));
      const children = datasetsChildren({
        replay: () => ({ exitCode: null, stdout: '', timedOut: true }),
      });
      const { lines } = await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
      expect(db.verifications).toEqual([]);
      expect(stepLine(lines, 'dataset_verification')?.['report']).toMatchObject({
        state: { attempts: { count: 1, mode: 'verify-only', publication_id: PUBLICATION_2 } },
      });
    }
  });

  it('el paso 1 guarda su informe cuando solo migró buoh_datasets', async () => {
    const db = datasetsDatabase();
    const children = fakeChildren((child) =>
      child === 'datasets_migrate'
        ? {
            stdout: JSON.stringify({
              applied: ['0001_datasets.sql'],
              current: ['0001_datasets.sql'],
              status: 'migrated',
            }),
          }
        : child === 'publish'
          ? { exitCode: 0, stdout: nothingDueLine() }
          : {},
    );
    await run(db, children, { config: DATASETS_CONFIG, nextId: growing });
    expect(db.reports.filter((item) => item.row.step === 'roles_and_logs')).toHaveLength(1);
  });
});
