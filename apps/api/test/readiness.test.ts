import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { ApiLogLine } from '../src/log.js';
import { migrationState } from '../src/postgres/readiness.js';
import { createReadiness, type MigrationState } from '../src/readiness.js';
import { useDeterminismGuards } from './support.js';

// La espera de la API (ADR-0019 §7): al arrancar comprueba sus migraciones y, mientras faltan, no
// está lista. Una vez lista deja de comprobar.
useDeterminismGuards();

/** Un planificador falso: guarda las tareas y las corre cuando la prueba lo pide. */
function fakeScheduler() {
  const tasks: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    tasks,
    schedule: (run: () => void, ms: number) => {
      const task = { run, ms, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    async runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (task === undefined) {
        throw new Error('No hay ninguna tarea pendiente.');
      }
      tasks.splice(tasks.indexOf(task), 1);
      task.run();
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => tasks.filter((task) => !task.cancelled).length,
  };
}

function sequence(results: readonly (MigrationState | Error)[]) {
  let call = 0;
  return () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result ?? 'ready');
  };
}

describe('createReadiness', () => {
  it('no está lista hasta que la comprobación dice ready, y entonces deja de comprobar', async () => {
    const lines: ApiLogLine[] = [];
    const scheduler = fakeScheduler();
    const pgDown = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const readiness = createReadiness({
      check: sequence(['migrations_pending', 'migrations_pending', pgDown, 'ready']),
      intervalMs: 5000,
      schedule: scheduler.schedule,
      log: (line) => lines.push(line),
    });
    expect(readiness.isReady()).toBe(false);
    readiness.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(readiness.isReady()).toBe(false);
    expect(scheduler.tasks.map((task) => task.ms)).toEqual([5000]);
    await scheduler.runNext();
    await scheduler.runNext();
    expect(readiness.isReady()).toBe(false);
    await scheduler.runNext();
    expect(readiness.isReady()).toBe(true);
    expect(scheduler.pending()).toBe(0);
    // Una línea por cada cambio de motivo, sin el mensaje del error.
    expect(lines).toEqual([
      { event: 'api_waiting', reason: 'migrations_pending' },
      { event: 'api_waiting', reason: 'postgres_error', error: 'ECONNREFUSED' },
      { event: 'api_ready' },
    ]);
  });

  it('una migración aplicada que cambió la deja sin estar lista, con su motivo', async () => {
    const lines: ApiLogLine[] = [];
    const scheduler = fakeScheduler();
    const readiness = createReadiness({
      check: sequence(['migration_changed']),
      intervalMs: 5000,
      schedule: scheduler.schedule,
      log: (line) => lines.push(line),
    });
    readiness.start();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.runNext();
    expect(readiness.isReady()).toBe(false);
    expect(lines).toEqual([{ event: 'api_waiting', reason: 'migration_changed' }]);
  });

  it('stop cancela la comprobación pendiente', async () => {
    const scheduler = fakeScheduler();
    const readiness = createReadiness({
      check: sequence(['migrations_pending']),
      intervalMs: 5000,
      schedule: scheduler.schedule,
      log: () => undefined,
    });
    readiness.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler.pending()).toBe(1);
    readiness.stop();
    expect(scheduler.pending()).toBe(0);
  });
});

describe('migrationState', () => {
  const migrations = [
    { name: '0001_auditoria.sql', sha256: 'a'.repeat(64), sql: '' },
    { name: '0002_cuentas.sql', sha256: 'b'.repeat(64), sql: '' },
  ];
  /** Un pool falso que solo responde la consulta de las migraciones con esas filas, o falla. */
  const pool = (rows: { name: string; sha256: string }[] | Error) =>
    ({
      query: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows })),
    }) as unknown as Pick<Pool, 'query'>;
  const sqlError = (code: string) => Object.assign(new Error(`error ${code}`), { code });

  it('está lista con todas sus migraciones aplicadas, también si la base tiene alguna más nueva', async () => {
    const applied = migrations.map(({ name, sha256 }) => ({ name, sha256 }));
    expect(await migrationState(pool(applied), migrations)).toBe('ready');
    expect(
      await migrationState(
        pool([...applied, { name: '0003_x.sql', sha256: 'c'.repeat(64) }]),
        migrations,
      ),
    ).toBe('ready');
  });

  it('le faltan migraciones si falta una, la tabla o el esquema', async () => {
    expect(
      await migrationState(
        pool([{ name: '0001_auditoria.sql', sha256: 'a'.repeat(64) }]),
        migrations,
      ),
    ).toBe('migrations_pending');
    expect(await migrationState(pool(sqlError('42P01')), migrations)).toBe('migrations_pending');
    expect(await migrationState(pool(sqlError('3F000')), migrations)).toBe('migrations_pending');
  });

  it('una migración aplicada con otro contenido es migration_changed', async () => {
    expect(
      await migrationState(
        pool([
          { name: '0001_auditoria.sql', sha256: 'a'.repeat(64) },
          { name: '0002_cuentas.sql', sha256: 'f'.repeat(64) },
        ]),
        migrations,
      ),
    ).toBe('migration_changed');
  });

  it('cualquier otro error de PostgreSQL sale tal cual', async () => {
    const denied = sqlError('42501');
    await expect(migrationState(pool(denied), migrations)).rejects.toBe(denied);
  });
});
