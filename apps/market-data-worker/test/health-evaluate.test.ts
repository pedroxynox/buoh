import {
  connectionClosedSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  rawSourceFrameSchema,
  sha256Hex,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDerivMeasurementProfile, DERIV_SOURCE } from '../src/deriv/profile.js';
import { evaluateDataHealth, type ObservedSource } from '../src/health/evaluate.js';
import { buildRawSourceFrame } from '../src/ingestion/raw-first-ingestor.js';
import { type IngestionHeartbeat } from '../src/ingestion/status.js';
import { syntheticSchemas, uuid } from './support/connection-harness.js';
import { derivMessages } from './support/deriv-fixtures.js';
import {
  E,
  PREVIOUS,
  previousConnectionEvents,
  REQUEST,
  S,
  stoppedBeforeRecoveryEvents,
} from './support/recovery-harness.js';
import { cursorOf, heartbeatOf } from './support/status-store-rules.js';

// La evaluación de `data:health` (ADR-0015 §8): una función pura que recibe lo observado (el log
// durable, el registro operativo, el último latido, el escritor vivo y el último dataset) y devuelve
// el `HealthReport`, el código de salida y la alerta de stderr. La hora y los IDs se inyectan;
// esquemas sintéticos y eventos en memoria. Ningún precio es de mercado.

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
/** El perfil de medición del símbolo, con el esquema de fuente sintético que guardó la ingesta. */
const PROFILE = createDerivMeasurementProfile({ schemas: syntheticSchemas(), symbol: SYMBOL });
/** El PID de PostgreSQL del escritor vivo de este esquema. */
const WRITER_PID = 4242;

/** Un latido del escritor vivo de este esquema, conectado y sin backlog, de las 09:59:05. */
const heartbeat = (overrides: Partial<IngestionHeartbeat> = {}): IngestionHeartbeat =>
  heartbeatOf(DERIV_SOURCE, 1, {
    connection_state: 'connected',
    observed_at_utc: '2026-03-02T09:59:05.000Z',
    pg_backend_pid: WRITER_PID,
    ...overrides,
  });

/**
 * La conexión anterior del log (`previousConnectionEvents`): su apertura (09:58:00), su tick en S
 * (09:59:00, `uuid(9003)`) y su cierre remoto (09:59:30).
 */
function previousParts() {
  const [opened, tick, closed] = previousConnectionEvents();
  if (opened === undefined || tick === undefined || closed === undefined) {
    throw new TypeError('Faltan eventos de la conexión anterior.');
  }
  return { closed, opened, tick };
}

/**
 * Lo observado a las 09:59:10: el log de la conexión anterior todavía abierta, con su tick durable,
 * el escritor vivo de este esquema y su latido conectado de hace 5 s.
 */
function observed(overrides: Partial<ObservedSource> = {}): ObservedSource {
  const { opened, tick } = previousParts();
  let sequence = 0;
  return {
    cursorSymbols: [SYMBOL],
    lastPublishedDatasetId: null,
    latestCursor: null,
    latestHeartbeat: heartbeat(),
    nextId: () => uuid(7000 + (sequence += 1)),
    now: '2026-03-02T09:59:10.000Z',
    operationalConditionTypes: [],
    profile: PROFILE,
    segments: [[opened, tick]],
    source: DERIV_SOURCE,
    status: 'observed',
    symbol: SYMBOL,
    writerPid: WRITER_PID,
    ...overrides,
  };
}

/** La conexión que supera a la anterior. */
const NEXT = uuid(9201);

/**
 * La reconexión: la apertura de `NEXT` a las 09:59:40, que supera a la anterior, y su primer tick
 * posterior al cierre, en E (10:00:00, `uuid(9203)`). Sin `HistoryRecoveryResult`, la continuidad
 * sigue pendiente.
 */
function reconnectionEvents(): SourceEvent[] {
  return [
    connectionOpenedSchema.parse({
      connection_id: NEXT,
      event_id: uuid(9202),
      kind: 'connection_opened',
      occurred_at_utc: '2026-03-02T09:59:40.000Z',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: PREVIOUS,
    }),
    buildRawSourceFrame(
      {
        connection_id: NEXT,
        observation_id: uuid(9203),
        payload_utf8: derivMessages.tick(2, E, '100.75'),
        received_at_utc: '2026-03-02T10:00:00.000Z',
      },
      PROFILE,
    ),
  ];
}

/** El `HistoryRecoveryResult` `complete` del hueco de la reconexión (`REQUEST`), a las 10:00:05. */
const recovered = (): SourceEvent =>
  historyRecoveryResultSchema.parse({
    connection_id: NEXT,
    event_id: uuid(9204),
    from_event_time_utc: REQUEST.from_event_time_utc,
    kind: 'history_recovery_result',
    occurred_at_utc: '2026-03-02T10:00:05.000Z',
    recovered_event_count: 29,
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    status: 'complete',
    symbol: SYMBOL,
    to_event_time_utc: REQUEST.to_event_time_utc,
  });

/** Un `dataset_id` sintético del último dataset activo de la fuente. */
const DATASET = `sha256:${'a'.repeat(64)}`;

/** El informe derivado esperado: `overrides` sobre uno `healthy`, conectado, con el tick de S. */
const derivedReport = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

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

/** La evaluación de la regla 2: `failed`, con el motivo en la alerta `data_health_failed`. */
const failedWith = (reason: string) => ({
  alert: { event: 'data_health_failed', reason },
  exitCode: 1,
  report: unobserved('failed'),
});

describe('evaluateDataHealth: lo que la lectura no pudo observar (ADR-0015 §8, reglas 2 y 3)', () => {
  it('si PostgreSQL o el almacenamiento de objetos no responden, da paused, desconectado, backlog 0 y lo demás null, con la alerta data_health_storage_unavailable y salida 1', () => {
    expect(
      evaluateDataHealth({
        reason: 'ECONNREFUSED',
        source: DERIV_SOURCE,
        status: 'storage_unavailable',
      }),
    ).toEqual({
      alert: { event: 'data_health_storage_unavailable', reason: 'ECONNREFUSED' },
      exitCode: 1,
      report: unobserved('paused'),
    });
  });

  it.each(['source_schema_missing', 'source_schema_mismatch'])(
    'si la lectura ya encontró %s, da failed con ese motivo en la alerta data_health_failed y salida 1',
    (reason) => {
      expect(evaluateDataHealth({ reason, source: DERIV_SOURCE, status: 'incompatible' })).toEqual(
        failedWith(reason),
      );
    },
  );
});

describe('evaluateDataHealth: lo observado incompatible (ADR-0015 §8, regla 2)', () => {
  it('con un frame de otro conector en el log, da failed con connector_version_mismatch, aunque el escritor vivo de este esquema informe', () => {
    const { opened, tick } = previousParts();
    const old = rawSourceFrameSchema.parse({
      ...tick,
      connector_version: 'deriv-options-ws-1.0.0',
    });

    expect(
      evaluateDataHealth(
        observed({
          lastPublishedDatasetId: DATASET,
          latestHeartbeat: heartbeat({ backlog_bytes: 120, backlog_count: 1 }),
          segments: [[opened, old]],
        }),
      ),
    ).toEqual(failedWith('connector_version_mismatch'));
  });

  it('con un log que no se puede derivar, como uno que cierra dos veces la misma conexión, da failed con log_not_derivable', () => {
    const events = previousConnectionEvents();
    const again = connectionClosedSchema.parse({
      ...events[2],
      event_id: uuid(9005),
      occurred_at_utc: '2026-03-02T09:59:40.000Z',
    });

    expect(
      evaluateDataHealth(
        observed({ now: '2026-03-02T09:59:45.000Z', segments: [[...events, again]] }),
      ),
    ).toEqual(failedWith('log_not_derivable'));
  });

  it('con un cursor de la fuente de otro símbolo, da failed con symbol_mismatch, aunque otro cursor sea del símbolo pedido', () => {
    expect(evaluateDataHealth(observed({ cursorSymbols: [SYMBOL, 'SYNTH_50'] }))).toEqual(
      failedWith('symbol_mismatch'),
    );
  });

  it('con un tick de otro símbolo en el log, da failed con symbol_mismatch', () => {
    const { opened, tick } = previousParts();
    const payload = derivMessages.tick(2, S, '100.25', 'SYNTH_50');
    const other = rawSourceFrameSchema.parse({
      ...tick,
      payload_utf8: payload,
      raw_payload_sha256: sha256Hex(payload),
    });

    expect(evaluateDataHealth(observed({ segments: [[opened, other]] }))).toEqual(
      failedWith('symbol_mismatch'),
    );
  });

  it('sin esquema de fuente guardado y con el log no vacío, da failed con source_schema_missing', () => {
    expect(evaluateDataHealth(observed({ profile: null }))).toEqual(
      failedWith('source_schema_missing'),
    );
  });

  it('sin esquema de fuente guardado y con el log vacío, un cursor de otro símbolo da failed con symbol_mismatch', () => {
    expect(
      evaluateDataHealth(observed({ cursorSymbols: ['SYNTH_50'], profile: null, segments: [] })),
    ).toEqual(failedWith('symbol_mismatch'));
  });
});

describe('evaluateDataHealth: el último cursor contra el log (ADR-0015 §6 y §8, regla 2)', () => {
  /** El último cursor del símbolo pedido, con su último evento durable. */
  const cursorAt = (eventId: string) =>
    cursorOf(DERIV_SOURCE, { last_durable_source_event_id: eventId, symbol: SYMBOL });

  it('si el último cursor del símbolo apunta a un evento que no está en el log, da failed con cursor_ahead_of_log, aunque el escritor vivo de este esquema informe', () => {
    expect(evaluateDataHealth(observed({ latestCursor: cursorAt(uuid(9999)) }))).toEqual(
      failedWith('cursor_ahead_of_log'),
    );
  });

  it('un cursor que va por detrás del log, porque el proceso cayó después de escribirlo, no es un fallo', () => {
    // La apertura de la conexión (`uuid(9002)`), anterior a su tick.
    const behind = evaluateDataHealth(observed({ latestCursor: cursorAt(uuid(9002)) }));
    expect(behind.exitCode).toBe(0);
    expect(behind.report.service_health).toBe('healthy');
    expect(evaluateDataHealth(observed({ latestCursor: cursorAt(uuid(9003)) }))).toEqual(behind);
  });

  it('con el log vacío y un cursor del símbolo, da failed con cursor_ahead_of_log, también sin esquema de fuente guardado', () => {
    for (const profile of [PROFILE, null]) {
      expect(
        evaluateDataHealth(observed({ latestCursor: cursorAt(uuid(9003)), profile, segments: [] })),
      ).toEqual(failedWith('cursor_ahead_of_log'));
    }
  });

  it('compara con el log durable: el cierre que la regla 4 añade en memoria no cuenta', () => {
    // Sin escritor vivo, el cierre en memoria toma el primer ID, uuid(7001).
    expect(
      evaluateDataHealth(observed({ latestCursor: cursorAt(uuid(7001)), writerPid: null })),
    ).toEqual(failedWith('cursor_ahead_of_log'));
  });

  it('las comprobaciones del contenido del log van antes, como en el arranque: otro símbolo con el cursor por delante es symbol_mismatch', () => {
    expect(
      evaluateDataHealth(
        observed({ cursorSymbols: [SYMBOL, 'R_50'], latestCursor: cursorAt(uuid(9999)) }),
      ),
    ).toEqual(failedWith('symbol_mismatch'));
  });
});

describe('evaluateDataHealth: sin escritor vivo (ADR-0015 §8, regla 4)', () => {
  it('con la última conexión cerrada, da como mínimo paused, desconectado y backlog 0 aunque quede un latido con backlog, sin añadir ningún cierre', () => {
    // La última conexión cerró con un cierre pedido; la anterior, sin pedirlo, y su hueco sigue
    // pendiente (`recovering`), pero nada procesa la entrada.
    const evaluation = evaluateDataHealth(
      observed({
        lastPublishedDatasetId: DATASET,
        latestHeartbeat: heartbeat({
          backlog_bytes: 120,
          backlog_count: 1,
          observed_at_utc: '2026-03-02T09:59:54.000Z',
        }),
        now: '2026-03-02T10:00:00.000Z',
        segments: [stoppedBeforeRecoveryEvents()],
        writerPid: null,
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        connection_state: 'disconnected',
        last_event_time_utc: '2026-03-02T09:59:50.000Z',
        last_observation_id: uuid(9103),
        last_published_dataset_id: DATASET,
        last_received_at_utc: '2026-03-02T09:59:50.000Z',
        service_health: 'paused',
      }),
    });
  });

  it('con la última conexión sin cierre durable, deriva como si tuviera el cierre close_not_recorded que registrará el próximo arranque: muestra connection_lost, sin tocar el log observado', () => {
    // El proceso murió después de reconectar: la conexión nueva no tiene cierre.
    const segments = [[...previousConnectionEvents(), ...reconnectionEvents()]];

    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({
          backlog_bytes: 120,
          backlog_count: 1,
          observed_at_utc: '2026-03-02T10:00:01.000Z',
        }),
        now: '2026-03-02T10:00:30.000Z',
        segments,
        writerPid: null,
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        connection_state: 'disconnected',
        last_event_time_utc: '2026-03-02T10:00:00.000Z',
        last_observation_id: uuid(9203),
        last_received_at_utc: '2026-03-02T10:00:00.000Z',
        open_condition_types: ['connection_lost'],
        service_health: 'paused',
      }),
    });
    // El cierre es solo para la derivación: nunca se persiste.
    expect(segments[0]).toHaveLength(5);
  });

  it('con el log vacío y sin esquema de fuente guardado, da paused y desconectado: starting, con el mínimo de la regla', () => {
    expect(
      evaluateDataHealth(
        observed({ latestHeartbeat: null, profile: null, segments: [], writerPid: null }),
      ),
    ).toEqual({ alert: null, exitCode: 1, report: unobserved('paused') });
  });
});

describe('evaluateDataHealth: con el escritor vivo de este esquema y un latido reciente (ADR-0015 §8, regla 5)', () => {
  it('con raw durable, continuidad y sin condiciones, da healthy con el backlog del latido y el último dataset, y salida 0', () => {
    expect(
      evaluateDataHealth(
        observed({
          lastPublishedDatasetId: DATASET,
          latestHeartbeat: heartbeat({ backlog_bytes: 120, backlog_count: 1 }),
        }),
      ),
    ).toEqual({
      alert: null,
      exitCode: 0,
      report: derivedReport({
        backlog_bytes: 120,
        backlog_count: 1,
        last_published_dataset_id: DATASET,
      }),
    });
  });

  it.each<[string, readonly SourceEvent[], 'healthy' | 'recovering', 0 | 1]>([
    ['con la historia del hueco recuperada, da healthy', [recovered()], 'healthy', 0],
    ['sin la historia del hueco, la continuidad sigue pendiente: recovering', [], 'recovering', 1],
  ])('tras una reconexión, %s', (_label, recovery, serviceHealth, exitCode) => {
    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({ observed_at_utc: '2026-03-02T10:00:06.000Z' }),
        now: '2026-03-02T10:00:10.000Z',
        segments: [[...previousConnectionEvents(), ...reconnectionEvents(), ...recovery]],
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode,
      report: derivedReport({
        last_event_time_utc: '2026-03-02T10:00:00.000Z',
        last_observation_id: uuid(9203),
        last_received_at_utc: '2026-03-02T10:00:00.000Z',
        service_health: serviceHealth,
      }),
    });
  });

  it('sin raw durable, con la conexión abierta y el latido conectado, sigue en starting: nunca healthy sin raw durable', () => {
    const { opened } = previousParts();

    expect(evaluateDataHealth(observed({ segments: [[opened]] }))).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        last_event_time_utc: null,
        last_observation_id: null,
        last_received_at_utc: null,
        service_health: 'starting',
      }),
    });
  });

  it('con el log vacío, sin esquema de fuente guardado todavía, y el latido de arranque (connecting), sigue en starting', () => {
    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({
          connection_state: 'connecting',
          observed_at_utc: '2026-03-02T10:00:00.000Z',
        }),
        now: '2026-03-02T10:00:01.000Z',
        profile: null,
        segments: [],
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        connection_state: 'connecting',
        last_event_time_utc: null,
        last_observation_id: null,
        last_received_at_utc: null,
        service_health: 'starting',
      }),
    });
  });

  it('con un latido posterior al último evento de conexión del log, la conexión sale del latido: connecting mientras reconecta da recovering, nunca healthy, aunque el log siga conectado', () => {
    const evaluation = evaluateDataHealth(
      observed({ latestHeartbeat: heartbeat({ connection_state: 'connecting' }) }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({ connection_state: 'connecting', service_health: 'recovering' }),
    });
  });

  it('con un latido anterior al último evento de conexión del log, un cierre, la conexión sale del log, y el backlog del latido', () => {
    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({
          backlog_bytes: 120,
          backlog_count: 1,
          observed_at_utc: '2026-03-02T09:59:20.000Z',
        }),
        now: '2026-03-02T09:59:35.000Z',
        segments: [previousConnectionEvents()],
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        backlog_bytes: 120,
        backlog_count: 1,
        connection_state: 'disconnected',
        open_condition_types: ['connection_lost'],
        service_health: 'recovering',
      }),
    });
  });

  it.each([
    ['anterior a él (09:59:35)', '2026-03-02T09:59:35.000Z'],
    ['de su misma hora, que no es posterior (09:59:40)', '2026-03-02T09:59:40.000Z'],
  ])(
    'la ventana entre una reconexión y su latido (ADR-0015 §11): con un ConnectionOpened nuevo en el log y el último latido, connecting, %s, la conexión sale del log',
    (_label, observedAt) => {
      // Solo la apertura de la reconexión: su primer tick todavía no llegó.
      const reopened = reconnectionEvents().slice(0, 1);
      const evaluation = evaluateDataHealth(
        observed({
          latestHeartbeat: heartbeat({
            connection_state: 'connecting',
            observed_at_utc: observedAt,
          }),
          now: '2026-03-02T09:59:45.000Z',
          segments: [[...previousConnectionEvents(), ...reopened]],
        }),
      );

      // La apertura resolvió connection_lost; la continuidad sigue pendiente hasta la historia.
      expect(evaluation).toEqual({
        alert: null,
        exitCode: 1,
        report: derivedReport({ connection_state: 'connected', service_health: 'recovering' }),
      });
    },
  );
});

describe('evaluateDataHealth: con un escritor vivo que no informa (ADR-0015 §8, regla 6)', () => {
  it.each<[string, IngestionHeartbeat | null]>([
    [
      'el último latido es de otro PID',
      heartbeat({ backlog_bytes: 120, backlog_count: 1, connection_state: 'connecting' }),
    ],
    ['no hay ningún latido', null],
  ])(
    'si el escritor vivo no es el de este esquema, un proceso nuevo antes de su primer latido, y %s, la conexión sale del log, el backlog es 0 y la salud como mínimo paused',
    (_label, latest) => {
      const evaluation = evaluateDataHealth(
        observed({ latestHeartbeat: latest, writerPid: WRITER_PID + 1 }),
      );

      expect(evaluation).toEqual({
        alert: null,
        exitCode: 1,
        report: derivedReport({ service_health: 'paused' }),
      });
    },
  );

  it('con un latido del escritor vivo de hace más de 45 000 ms, la conexión sale del log, el backlog es el de ese latido y la salud como mínimo paused', () => {
    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({
          backlog_bytes: 120,
          backlog_count: 1,
          connection_state: 'connecting',
        }),
        // 45 001 ms después del latido de las 09:59:05.
        now: '2026-03-02T09:59:50.001Z',
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({ backlog_bytes: 120, backlog_count: 1, service_health: 'paused' }),
    });
  });

  it('un latido de hace exactamente 45 000 ms sigue siendo reciente: la conexión y el backlog salen de él (regla 5)', () => {
    const evaluation = evaluateDataHealth(
      observed({
        latestHeartbeat: heartbeat({
          backlog_bytes: 120,
          backlog_count: 1,
          connection_state: 'connecting',
        }),
        now: '2026-03-02T09:59:50.000Z',
      }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        backlog_bytes: 120,
        backlog_count: 1,
        connection_state: 'connecting',
        service_health: 'recovering',
      }),
    });
  });
});

describe('evaluateDataHealth: la salud del informe (ADR-0015 §8, regla 7)', () => {
  it('suma las condiciones abiertas del registro operativo: persistence_unavailable da paused, y salida 1, aunque la derivación diera healthy', () => {
    const evaluation = evaluateDataHealth(
      observed({ operationalConditionTypes: ['persistence_unavailable'] }),
    );

    expect(evaluation).toEqual({
      alert: null,
      exitCode: 1,
      report: derivedReport({
        open_condition_types: ['persistence_unavailable'],
        service_health: 'paused',
      }),
    });
  });
});
