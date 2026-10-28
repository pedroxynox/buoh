import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDatasetPublication,
  createPipelineProfile,
  derivationThresholds,
  deriveHealthReport,
  deriveMarketData,
  ingestSyntheticStimuli,
  unobservedHealthReport,
  type HealthInput,
  type PipelineProfile,
} from '../src/index.js';

// Estado vivo con el perfil de medición y entradas nuevas de la salud (ADR-0015 §2 y §8; contratos
// de dominio, «Perfil de medición» y `HealthReport`). Usan el esquema de fuente sintético de los
// vectores y dos perfiles con reglas 2.0.0: uno de publicación, con los umbrales de siempre, y uno
// de medición, sin ellos.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const sourceSchema = readFileSync(resolve(vectorRoot, 'source-schema.json'));

const baseProfile = {
  allowed_symbols: ['SYNTH_100'],
  gap_detection: 'after_reconnection',
  non_tick_msg_types: ['ping'],
  quality_rule_version: '2.0.0',
  source: 'synthetic',
};

function profileFrom(quality: Record<string, unknown>): PipelineProfile {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(JSON.stringify(quality)),
    source_schema_bytes: sourceSchema,
    source_schema_release: 'synthetic-v1',
  });
}

const publication = profileFrom({
  ...baseProfile,
  maximum_delivery_delay_ms: 2000,
  maximum_event_gap_ms: 2000,
  profile_id: 'synthetic-v2-publication',
});
const measurement = profileFrom({
  ...baseProfile,
  profile_id: 'synthetic-v2-measurement',
  purpose: 'measurement',
});

const CONNECTION_A = '019b76da-a800-7000-8000-00000000a000';
const CONNECTION_B = '019b76da-a800-7000-8000-00000000b000';
const CONNECTION_C = '019b76da-a800-7000-8000-00000000c000';
/** 2026-01-01T00:00:00.000Z en segundos, como las horas de la fuente. */
const T0 = 1767225600;

function id(suffix: number): string {
  return `019b76da-a800-7000-8000-${suffix.toString().padStart(12, '0')}`;
}

function at(seconds: number, milliseconds = 0): string {
  return new Date(seconds * 1000 + milliseconds).toISOString();
}

/** Tick recibido `delayMs` después de su hora de fuente. */
function tick(sequence: number, connection: string, epoch: number, delayMs = 100) {
  return {
    connection_id: connection,
    fixture_sequence: sequence,
    kind: 'source_frame',
    observation_id: id(sequence),
    payload_utf8: `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":100.125,"symbol":"SYNTH_100"}}`,
    received_at_utc: at(epoch, delayMs),
  };
}

function close(sequence: number, connection: string, occurredAt: string) {
  return {
    affected_symbols: ['SYNTH_100'],
    closure_type: 'timeout',
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_closed',
    occurred_at_utc: occurredAt,
    reason: 'ping_timeout',
  };
}

function open(sequence: number, connection: string, supersedes: string, occurredAt: string) {
  return {
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_opened',
    occurred_at_utc: occurredAt,
    supersedes_connection_id: supersedes,
  };
}

function recovery(
  sequence: number,
  range: { readonly from: string; readonly to: string },
  result:
    | { readonly recovered_event_count: number; readonly status: 'complete' }
    | {
        readonly reason: string;
        readonly recovered_event_count: number;
        readonly status: 'partial';
      },
) {
  return {
    connection_id: CONNECTION_B,
    event_id: id(sequence),
    fixture_sequence: sequence,
    from_event_time_utc: range.from,
    kind: 'history_recovery_result',
    occurred_at_utc: at(T0 + 60),
    symbol: 'SYNTH_100',
    to_event_time_utc: range.to,
    ...result,
  };
}

function persisted(stimuli: readonly unknown[], profile: PipelineProfile) {
  const result = ingestSyntheticStimuli([...stimuli], profile);
  if (result.status !== 'persisted') {
    throw new TypeError('Se esperaba persistencia completa.');
  }
  return result.segments;
}

/** Cierre no pedido de A, apertura de B que lo supera y primer tick de B un segundo después. */
const RECONNECTION = [
  tick(1, CONNECTION_A, T0),
  close(2, CONNECTION_A, at(T0, 500)),
  open(3, CONNECTION_B, CONNECTION_A, at(T0, 600)),
  tick(4, CONNECTION_B, T0 + 1),
];

function health(
  segments: ReturnType<typeof persisted>,
  profile: PipelineProfile,
  extra: Partial<HealthInput> = {},
) {
  return deriveHealthReport({
    backlog_bytes: 0,
    backlog_count: 0,
    derived: deriveMarketData(segments, profile),
    last_published_dataset_id: null,
    source: 'synthetic',
    sourceEvents: segments.flat(),
    ...extra,
  });
}

describe('derivación con el perfil de medición (ADR-0015 §2)', () => {
  it('deriva sin umbrales y el de publicación conserva los suyos', () => {
    expect(derivationThresholds(measurement)).toEqual({
      maximum_delivery_delay_ms: null,
      maximum_event_gap_ms: null,
    });
    expect(derivationThresholds(publication)).toEqual({
      maximum_delivery_delay_ms: 2000,
      maximum_event_gap_ms: 2000,
    });
  });

  it('sin umbral de retraso no evalúa delivery_delayed', () => {
    const late = [tick(1, CONNECTION_A, T0, 10_000)];
    const types = (profile: PipelineProfile) =>
      deriveMarketData(persisted(late, profile), profile).incidents.map(
        (incident) => incident.incident_type,
      );

    expect(types(publication)).toEqual(['delivery_delayed']);
    expect(types(measurement)).toEqual([]);
  });

  it('sin umbral de hueco, la separación tras una reconexión no demuestra continuidad', () => {
    const withThreshold = deriveMarketData(persisted(RECONNECTION, publication), publication);
    expect(withThreshold.pendingContinuitySymbols).toEqual([]);
    expect(withThreshold.pendingGaps).toEqual([]);

    const segments = persisted(RECONNECTION, measurement);
    const derived = deriveMarketData(segments, measurement);
    expect(derived.pendingContinuitySymbols).toEqual(['SYNTH_100']);
    expect(derived.pendingGaps).toEqual([
      {
        from_event_time_utc: '2026-01-01T00:00:00.001Z',
        symbol: 'SYNTH_100',
        to_event_time_utc: '2026-01-01T00:00:00.999Z',
      },
    ]);
    // La reconexión resolvió `connection_lost`; lo que queda es la continuidad pendiente.
    const report = health(segments, measurement);
    expect(report.service_health).toBe('recovering');
    expect(report.open_condition_types).toEqual([]);
  });

  it('el fin del hueco espera al primer tick posterior al high-watermark del cierre', () => {
    const closed = [
      tick(1, CONNECTION_A, T0),
      close(2, CONNECTION_A, at(T0, 500)),
      open(3, CONNECTION_B, CONNECTION_A, at(T0, 600)),
    ];
    const gapOf = (stimuli: readonly unknown[]) =>
      deriveMarketData(persisted(stimuli, measurement), measurement).pendingGaps;

    expect(gapOf(closed)).toEqual([
      { from_event_time_utc: at(T0, 1), symbol: 'SYNTH_100', to_event_time_utc: null },
    ]);

    // La suscripción suele repetir el último tick: no fija el fin y queda como duplicado.
    const repeated = [...closed, tick(4, CONNECTION_B, T0, 900)];
    expect(gapOf(repeated)).toEqual([
      { from_event_time_utc: at(T0, 1), symbol: 'SYNTH_100', to_event_time_utc: null },
    ]);
    expect(
      deriveMarketData(persisted(repeated, measurement), measurement).incidents.map(
        (incident) => incident.incident_type,
      ),
    ).toEqual(['connection_lost', 'duplicate_exact']);

    expect(gapOf([...repeated, tick(5, CONNECTION_B, T0 + 2)])).toEqual([
      { from_event_time_utc: at(T0, 1), symbol: 'SYNTH_100', to_event_time_utc: at(T0 + 1, 999) },
    ]);
  });

  it('dos cierres seguidos conservan el inicio del hueco y el último fin', () => {
    const stimuli = [
      tick(1, CONNECTION_A, T0),
      close(2, CONNECTION_A, at(T0, 500)),
      open(3, CONNECTION_B, CONNECTION_A, at(T0, 600)),
      tick(4, CONNECTION_B, T0 + 1),
      close(5, CONNECTION_B, at(T0 + 1, 500)),
      open(6, CONNECTION_C, CONNECTION_B, at(T0 + 1, 600)),
      tick(7, CONNECTION_C, T0 + 5),
    ];

    expect(deriveMarketData(persisted(stimuli, measurement), measurement).pendingGaps).toEqual([
      { from_event_time_utc: at(T0, 1), symbol: 'SYNTH_100', to_event_time_utc: at(T0 + 4, 999) },
    ]);
  });

  it('solo un HistoryRecoveryResult que cubre el rango expuesto decide el hueco', () => {
    const [gap] = deriveMarketData(persisted(RECONNECTION, measurement), measurement).pendingGaps;
    if (gap?.to_event_time_utc == null) {
      throw new TypeError('Se esperaba un hueco con fin.');
    }
    const range = { from: gap.from_event_time_utc, to: gap.to_event_time_utc };

    const short = persisted(
      [
        ...RECONNECTION,
        recovery(
          5,
          { from: range.from, to: at(T0, 500) },
          { recovered_event_count: 0, status: 'complete' },
        ),
      ],
      measurement,
    );
    expect(deriveMarketData(short, measurement).pendingContinuitySymbols).toEqual(['SYNTH_100']);

    const complete = persisted(
      [...RECONNECTION, recovery(5, range, { recovered_event_count: 0, status: 'complete' })],
      measurement,
    );
    expect(deriveMarketData(complete, measurement).pendingGaps).toEqual([]);
    expect(health(complete, measurement).service_health).toBe('healthy');

    const partial = persisted(
      [
        ...RECONNECTION,
        recovery(5, range, {
          reason: 'history_page_limit',
          recovered_event_count: 0,
          status: 'partial',
        }),
      ],
      measurement,
    );
    const report = health(partial, measurement);
    expect(report.service_health).toBe('degraded');
    expect(report.open_condition_types).toEqual(['event_gap_unresolved']);
  });

  it('la publicación sigue rechazando el perfil de medición', () => {
    const segments = persisted([tick(1, CONNECTION_A, T0)], measurement);
    const publish = (profile: PipelineProfile) =>
      buildDatasetPublication({
        locateManifest: () => 'memory://manifest',
        locateObject: () => 'memory://object',
        profile,
        publication_id: '019b76da-a800-7000-8000-00000000f000',
        published_at_utc: at(T0 + 60),
        segments,
      });

    expect(deriveMarketData(segments, measurement).ticks).toHaveLength(1);
    expect(() => publish(measurement)).toThrow(/de medición/u);
  });
});

describe('entradas nuevas de la salud (ADR-0015 §8)', () => {
  const live = persisted([tick(1, CONNECTION_A, T0)], measurement);
  // Ninguna ejecución escribió todavía: no hay segmentos.
  const empty: ReturnType<typeof persisted> = [];

  it('sin entradas nuevas, un log conectado y con datos es healthy', () => {
    const report = health(live, measurement);
    expect(report.service_health).toBe('healthy');
    expect(report.connection_state).toBe('connected');
  });

  it('suma las condiciones del registro operativo, únicas y ordenadas', () => {
    const report = health(live, measurement, {
      operational_condition_types: [
        'source_limit_exceeded',
        'persistence_unavailable',
        'source_limit_exceeded',
      ],
    });
    expect(report.open_condition_types).toEqual([
      'persistence_unavailable',
      'source_limit_exceeded',
    ]);
    expect(report.service_health).toBe('paused');
  });

  it('una conexión observada que no es connected nunca deja healthy', () => {
    const connecting = health(live, measurement, { connection_state: 'connecting' });
    expect(connecting.connection_state).toBe('connecting');
    expect(connecting.service_health).toBe('recovering');
    expect(health(live, measurement, { connection_state: 'connected' }).service_health).toBe(
      'healthy',
    );
  });

  it('la salud mínima se impone solo si es más severa que healthy', () => {
    expect(health(live, measurement, { minimum_health: 'paused' }).service_health).toBe('paused');
    expect(health(live, measurement, { minimum_health: 'healthy' }).service_health).toBe('healthy');
    expect(health(empty, measurement, { minimum_health: 'starting' }).service_health).toBe(
      'starting',
    );
  });

  it('un log vacío sigue en starting mientras la ingesta conecta', () => {
    const report = health(empty, measurement, { connection_state: 'connecting' });
    expect(report.service_health).toBe('starting');
    expect(report.connection_state).toBe('connecting');
    expect(health(empty, measurement, { minimum_health: 'paused' }).service_health).toBe('paused');
  });

  it('un informe sin observación no inventa datos', () => {
    for (const serviceHealth of ['failed', 'paused'] as const) {
      expect(
        unobservedHealthReport({ service_health: serviceHealth, source: 'synthetic' }),
      ).toEqual({
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
        source: 'synthetic',
      });
    }
  });
});
