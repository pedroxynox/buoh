import { canonicalJson, type HealthReport, type JsonValue } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  logLocation,
  parseStoredHealthObservation,
  readLatestStoredHealth,
  StoredHealthError,
  type StoredHealthRow,
} from '../src/lectura.js';

// La salud de los datos que leen la API y el motor (ADR-0019 §8): la última observación que guardó
// `buoh-operaciones` en `operations_reports` (ADR-0018 §11, paso 2). Los vectores salen de la forma
// de sus informes en el runbook de ingesta («Operaciones (`buoh-operaciones`)», «Informes»): el que
// terminó lleva `log`, `exit_code`, `report` y `alerts`; el que falló, `reason` y `log`, y con
// `health_command_failed` también `exit_code` y `code`. Que lo que escribe `runOperations` se lee así
// lo prueba test/operations.test.ts, y la consulta contra PostgreSQL, integration/operations.test.ts.

const OBSERVED = '2026-11-04T12:55:31.204Z';

/** Un `HealthReport` sano, con conexión y raw durable, como el de producción. */
const HEALTHY: HealthReport = {
  backlog_bytes: 0,
  backlog_count: 0,
  connection_state: 'connected',
  execution_mode: 'disabled',
  last_event_time_utc: '2026-11-04T12:55:29.000Z',
  last_observation_id: '01900000-0000-7000-8000-000000000001',
  last_published_dataset_id: null,
  last_received_at_utc: '2026-11-04T12:55:29.412Z',
  open_condition_types: [],
  schema_version: '1.0.0',
  service_health: 'healthy',
  source: 'deriv_options',
};

/** Una fila de la salud, con el informe en JCS, como la guarda `buoh-operaciones`. */
const row = (status: string, report: unknown, observed = OBSERVED): StoredHealthRow => ({
  observed_at_utc: observed,
  report_jcs: canonicalJson(report as JsonValue),
  status,
});

/** El error con que se rechaza la fila, o `null` si se acepta. */
function rejection(stored: StoredHealthRow): unknown {
  try {
    parseStoredHealthObservation(stored);
    return null;
  } catch (error) {
    return error;
  }
}

describe('parseStoredHealthObservation (ADR-0019 §8)', () => {
  it('un informe que terminó da su HealthReport, sus alertas y su hora, sin la salida ni el log', () => {
    expect(
      parseStoredHealthObservation(
        row('completed', {
          alerts: [{ event: 'checkpoint_rejected', reason: 'checkpoint_link_mismatch' }],
          exit_code: 0,
          log: 2,
          report: HEALTHY,
        }),
      ),
    ).toEqual({
      alerts: [{ event: 'checkpoint_rejected', reason: 'checkpoint_link_mismatch' }],
      observedAtUtc: OBSERVED,
      report: HEALTHY,
      status: 'completed',
    });
  });

  it('una salud que no es healthy también es una observación que terminó, con su causa en las alertas', () => {
    const paused: HealthReport = {
      ...HEALTHY,
      connection_state: 'disconnected',
      last_event_time_utc: null,
      last_observation_id: null,
      last_received_at_utc: null,
      service_health: 'paused',
    };
    expect(
      parseStoredHealthObservation(
        row('completed', {
          alerts: [{ event: 'data_health_storage_unavailable', reason: null }],
          exit_code: 1,
          log: 2,
          report: paused,
        }),
      ),
    ).toEqual({
      alerts: [{ event: 'data_health_storage_unavailable', reason: null }],
      observedAtUtc: OBSERVED,
      report: paused,
      status: 'completed',
    });
  });

  it.each<[string, Record<string, unknown>, string, string | null]>([
    ['un plazo vencido', { log: 2, reason: 'child_timeout' }, 'child_timeout', null],
    [
      'un data:health que no dio un HealthReport, con el código de su línea de error',
      { code: 'ConfigError', exit_code: 2, log: 2, reason: 'health_command_failed' },
      'health_command_failed',
      'ConfigError',
    ],
    [
      'un data:health que no dio un HealthReport ni una línea de error',
      { code: null, exit_code: 1, log: 2, reason: 'health_command_failed' },
      'health_command_failed',
      null,
    ],
    ['un fallo sin log', { log: null, reason: '57P01' }, '57P01', null],
    ['un paso que lanzó', { reason: 'unknown_error' }, 'unknown_error', null],
  ])(
    'un informe que falló da su motivo, su código y su hora: %s',
    (_label, report, reason, code) => {
      expect(parseStoredHealthObservation(row('failed', report))).toEqual({
        code,
        observedAtUtc: OBSERVED,
        reason,
        status: 'failed',
      });
    },
  );

  it.each<[string, StoredHealthRow]>([
    ['un JSON roto', { observed_at_utc: OBSERVED, report_jcs: '{"report":', status: 'completed' }],
    ['uno que terminó sin HealthReport', row('completed', { alerts: [], exit_code: 0, log: 2 })],
    ['uno que terminó sin alertas', row('completed', { report: HEALTHY })],
    [
      'uno que terminó con una alerta sin sanear',
      row('completed', {
        alerts: [{ event: 'connect ECONNREFUSED', reason: null }],
        report: HEALTHY,
      }),
    ],
    [
      'uno que terminó con una alerta sin motivo',
      row('completed', { alerts: [{ event: 'data_health_failed' }], report: HEALTHY }),
    ],
    [
      'uno que falló con un código sin sanear',
      row('failed', { code: 'Configuración inválida', reason: 'health_command_failed' }),
    ],
    [
      'uno que terminó con un HealthReport que no cumple su contrato',
      row('completed', {
        alerts: [],
        report: { ...HEALTHY, open_condition_types: ['connection_lost'] },
      }),
    ],
    [
      'uno que terminó con un campo de más en el HealthReport',
      row('completed', { alerts: [], report: { ...HEALTHY, extra: 1 } }),
    ],
    ['uno que falló sin motivo', row('failed', { log: 2 })],
    ['uno que falló con un motivo sin sanear', row('failed', { reason: 'connect ECONNREFUSED' })],
    ['uno que falló con el HealthReport y sin motivo', row('failed', { report: HEALTHY })],
    ['un estado desconocido', row('pending', { alerts: [], report: HEALTHY })],
    [
      'una hora sin milisegundos',
      row('completed', { alerts: [], report: HEALTHY }, '2026-11-04T12:55:31Z'),
    ],
    ['una hora que no existe', row('failed', { reason: 'x' }, '2026-02-30T00:00:00.000Z')],
  ])('rechaza con StoredHealthError, sin repetir la fila: %s', (_label, stored) => {
    const error = rejection(stored);
    expect(error).toBeInstanceOf(StoredHealthError);
    const message = (error as Error).message;
    expect(message).not.toContain(stored.report_jcs);
    expect(message).not.toContain('ECONNREFUSED');
    expect((error as Error).name).toBe('StoredHealthError');
  });
});

describe('readLatestStoredHealth (ADR-0019 §8)', () => {
  /** Un pool falso que responde `rows` y anota cada consulta. */
  function fakePool(rows: readonly StoredHealthRow[]) {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const pool = {
      query: (text: string, values: readonly unknown[]) => {
        queries.push({ text, values });
        return Promise.resolve({ rows });
      },
    };
    return { pool: pool as unknown as Parameters<typeof readLatestStoredHealth>[0], queries };
  }

  it('lee el último informe del paso health de la tabla del log, uno solo', async () => {
    const { pool, queries } = fakePool([row('completed', { alerts: [], report: HEALTHY })]);
    expect(await readLatestStoredHealth(pool, logLocation(2))).toEqual({
      alerts: [],
      observedAtUtc: OBSERVED,
      report: HEALTHY,
      status: 'completed',
    });
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query?.values).toEqual(['health']);
    expect(query?.text).toContain('FROM "buoh_log_000002".operations_reports');
    expect(query?.text).toMatch(/ORDER BY report_id DESC\s+LIMIT 1/u);
  });

  it('un log sin informes de la salud da null', async () => {
    const { pool } = fakePool([]);
    expect(await readLatestStoredHealth(pool, logLocation(3))).toBeNull();
  });
});
