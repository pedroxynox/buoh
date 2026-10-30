import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalJson,
  LIVE_STATE_VERSION,
  liveDerivationCheckpointSchema,
  sha256Hex,
  type DataQualityIncident,
  type OperationalConditionEvent,
  type SourceEvent,
} from '@buoh/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLiveDerivationCheckpoint,
  createPipelineProfile,
  deriveHealthReport,
  deriveLiveHealthReport,
  deriveMarketData,
  emptyLiveDerivationState,
  foldLiveDerivation,
  ingestSyntheticStimuli,
  liveCheckpointDigests,
  liveCheckpointVersions,
  liveDerivationView,
  ndjsonBytes,
  type LiveDerivationView,
  type PipelineProfile,
} from '../src/index.js';
import {
  CLOSED_TWICE,
  liveCorpus,
  OUT_OF_DOMAIN,
  RECONNECTION,
  RESOLVED_BEFORE_OPENING,
  sameInstantStimuli,
  VECTOR_SCENARIOS,
  vectorRoot,
  vectorSegments,
} from './support/live-corpus.js';

// Derivación en pliegue del estado vivo (ADR-0017 §2 a §4, §6 y §9). En cada límite entre eventos,
// que incluye cada límite de segmento, el pliegue desde el estado de ese límite más el resto del log
// da la misma vista que `deriveMarketData` sobre el log entero, fallos incluidos: en el vector v1, en
// un corpus escrito a mano y en logs aleatorios con semilla (`support/live-corpus.ts`, el mismo con
// el que el worker prueba sus lectores). Un vector fija el punto de control de cada límite de
// segmento.

/**
 * SHA-256 de las líneas de cada log del vector de puntos de control, por versión del formato del
 * estado vivo (ADR-0017 §6). Un cambio de lo que el pliegue produce sube `LIVE_STATE_VERSION` y
 * añade los digests de la versión nueva; los de una versión anterior no cambian. Un log nuevo del
 * corpus solo añade su digest. Para regenerar el vector:
 * `pnpm --filter @buoh/domain exec vitest run test/live-derivation.test.ts -u`.
 */
const VECTOR_SHA256_BY_VERSION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1.0.0': {
    v1: 'a0c86447e7b3c89102b05f113b700a5eeb22b75af4e50e1b39ff25213c693153',
    'v1/zero-valid-ticks': 'd197bea6b1a562ff908a1184e0d62ceb666dd5c0a51d1d3c05582a590a6fd21e',
    'reconexión con hueco pendiente':
      'ad4e08483709f483e12116d60bc24805c2ff814f55a3da6b1c4f662ea8dfb521',
    'la separación demuestra la continuidad':
      '5f5d39537a6337b3b4701029507ec21752fe2b5c0a80d8e523fd72ab838b227b',
    'historia completa que cubre el hueco':
      '22157ed7ed1b3d87b4a44b2fd88aa2002e9766582363a087703b486807046717',
    'historia parcial y después completa del mismo rango':
      'f42ac9753f8f9348289b4d81ba21a6bbbb1a9e24007613807effc5ff8bcab9f0',
    'historia no disponible con el hueco abierto':
      '539fdce8dba0cfd701a7b8ee0785a11ba386a307469692e030362517d7b40c86',
    'la separación supera el umbral y la historia no está disponible':
      'b4ca5f54983aa41cc295b36cb986cba9d1cd2c6de676220e0ac52ddd4796dc44',
    'cierre pedido con el hueco pendiente y su fin ya conocido':
      'c9b9640c30623e47f441b291ce6fec314b27a913860fe4b1f42ef09fdb8bbd61',
    'cierre reparado al arrancar (close_not_recorded) e historia completa':
      '1e798d72c35eee4661a5d4fba729640865f574aead957dbb8818e667b22304df',
    'dos cierres seguidos conservan el inicio del hueco':
      'fea9350d26ae232ba7b36768ee0f5bc6fa3d04fe1aa14ce9064313c3e01ba3a6',
    'duplicados, conflictos y ticks fuera de orden en los extremos del hueco':
      'b0145a7e62c36e4c13221fbe5e073b2202f44aa536024948d0229ca4058fcfdb',
    'cierre pedido, cierre sin ticks, ping y símbolo no permitido':
      '036e4b1351f20bdf21798f4797b027e2faa5188b97bc43e13f296d4018240488',
  },
};

/**
 * Guardas de determinismo, como en los vectores del pipeline: el pliegue no puede leer reloj real,
 * aleatoriedad ni red.
 */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-12-31T23:59:59.999Z'), toFake: ['Date'] });
  vi.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('Math.random no está permitido en el pliegue.');
  });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('crypto.randomUUID no está permitido en el pliegue.');
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('La red no está permitida en el pliegue.');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const { corpus, eventsOf, measurement, publication, randomStimuli, vectorProfile } = liveCorpus({
  createPipelineProfile,
  deriveMarketData,
  ingestSyntheticStimuli,
});

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * La vista viva calculada como hoy: con `deriveMarketData` sobre el log entero y recorriendo sus
 * eventos, como hacen `checkLog`, `gapState`, `previousConnection`, `lastConnectionEventTime` y
 * `deriveHealthReport`.
 */
function referenceView(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
): LiveDerivationView {
  const derived = deriveMarketData([events], profile);
  const quoteAt = (symbol: string, instant: string) =>
    derived.ticks.find((item) => item.symbol === symbol && item.event_time_utc === instant)
      ?.quote_decimal ?? null;
  const shift = (instant: string, ms: number) => new Date(Date.parse(instant) + ms).toISOString();

  const latest = new Map<string, OperationalConditionEvent>();
  for (const condition of derived.conditions) {
    latest.set(condition.condition_key, condition);
  }
  const incidents = new Map<string, DataQualityIncident>(
    derived.incidents.map((incident) => [incident.incident_id, incident]),
  );
  const openConditions = [...latest.values()]
    .filter((condition) => condition.action === 'opened')
    .sort((left, right) => compareStrings(left.condition_key, right.condition_key))
    .map((condition) => {
      const incident = condition.cause_refs
        .map((reference) => incidents.get(reference))
        .find((item) => item?.incident_type === condition.condition_type);
      if (incident === undefined) {
        throw new TypeError('Apertura sin incidencia causal.');
      }
      return { condition, incident };
    });

  // Como `previousConnection` del worker: la última apertura y su cierre, si lo hubo.
  let previousId: string | null = null;
  let previousClosedAt: string | null = null;
  let lastConnectionEvent: string | null = null;
  let connected = false;
  let lastRaw: { observation_id: string; received_at_utc: string } | null = null;
  for (const event of events) {
    if (event.kind === 'connection_opened') {
      previousId = event.connection_id;
      previousClosedAt = null;
      lastConnectionEvent = event.occurred_at_utc;
      connected = true;
    } else if (event.kind === 'connection_closed') {
      if (event.connection_id === previousId) {
        previousClosedAt = event.occurred_at_utc;
      }
      lastConnectionEvent = event.occurred_at_utc;
      connected = false;
    } else if (event.kind === 'raw_source_frame') {
      lastRaw = { observation_id: event.observation_id, received_at_utc: event.received_at_utc };
      connected = true;
    }
  }

  const symbols = [...new Set(derived.ticks.map((item) => item.symbol))].sort();
  return {
    connectedInLog: connected,
    gapQuotes: derived.pendingGaps.map((gap) => ({
      end_quote:
        gap.to_event_time_utc === null
          ? null
          : quoteAt(gap.symbol, shift(gap.to_event_time_utc, 1)),
      start_quote: quoteAt(gap.symbol, shift(gap.from_event_time_utc, -1)),
      symbol: gap.symbol,
    })),
    lastConnectionEventTimeUtc: lastConnectionEvent,
    lastEventConnectionId: events.at(-1)?.connection_id ?? null,
    lastEventTimeUtc: derived.ticks.at(-1)?.event_time_utc ?? null,
    lastRaw,
    openConditions,
    openConditionTypes: derived.openConditionTypes,
    pendingContinuitySymbols: derived.pendingContinuitySymbols,
    pendingGaps: derived.pendingGaps,
    previousConnection:
      previousId === null ? null : { closed_at_utc: previousClosedAt, connection_id: previousId },
    symbolNotAllowedSeen: derived.incidents.some(
      (incident) =>
        incident.incident_type === 'invalid_source_frame' &&
        incident.evidence.reason === 'symbol_not_allowed',
    ),
    // Los ticks van en orden canónico, por tiempo de evento primero.
    watermarks: symbols.map((symbol) => {
      const last = derived.ticks.filter((item) => item.symbol === symbol).at(-1);
      if (last === undefined) {
        throw new TypeError(`Símbolo sin ticks: ${symbol}.`);
      }
      return { event_time_utc: last.event_time_utc, symbol };
    }),
  };
}

/** El estado vivo pasa por su contrato y por JSON, como al guardarse y leerse. */
function roundTrip(state: ReturnType<typeof emptyLiveDerivationState>, profile: PipelineProfile) {
  const checkpoint = buildLiveDerivationCheckpoint({
    event_count: 1,
    profile,
    raw_frame_count: 0,
    segment_index: 0,
    segment_logical_content_sha256: 'a'.repeat(64),
    state,
    symbol: 'SYNTH_100',
  });
  return liveDerivationCheckpointSchema.parse(JSON.parse(JSON.stringify(checkpoint))).state;
}

/** En cada límite *i*: el pliegue de todo, y el del estado de *i* más el resto, dan la referencia. */
function expectEquivalentAtEveryBoundary(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
  label = 'log',
) {
  const expected = referenceView(events, profile);
  const whole = foldLiveDerivation(emptyLiveDerivationState(), events, profile);
  expect(liveDerivationView(whole), label).toEqual(expected);
  for (let boundary = 0; boundary <= events.length; boundary += 1) {
    const prefix = foldLiveDerivation(
      emptyLiveDerivationState(),
      events.slice(0, boundary),
      profile,
    );
    expect(liveDerivationView(prefix), `${label}, prefijo ${String(boundary)}`).toEqual(
      referenceView(events.slice(0, boundary), profile),
    );
    const resumed = foldLiveDerivation(roundTrip(prefix, profile), events.slice(boundary), profile);
    expect(resumed, `${label}, límite ${String(boundary)}`).toEqual(whole);
  }
}

/**
 * Un log sintético en segmentos que cierran después de cada evento de conexión o de historia, para
 * que el vector tenga un límite en cada transición del estado vivo.
 */
function segmentsAtTransitions(events: readonly SourceEvent[]): SourceEvent[][] {
  const segments: SourceEvent[][] = [];
  let current: SourceEvent[] = [];
  for (const event of events) {
    current.push(event);
    if (event.kind !== 'raw_source_frame') {
      segments.push(current);
      current = [];
    }
  }
  return current.length === 0 ? segments : [...segments, current];
}

/**
 * Las líneas del vector de un log: en cada límite de segmento, el punto de control que `ingest`
 * escribe desde el anterior y los eventos del segmento (ADR-0017 §5), en JCS con sus SHA-256.
 */
function vectorLines(
  log: string,
  segments: readonly (readonly SourceEvent[])[],
  profile: PipelineProfile,
): string[] {
  let state = emptyLiveDerivationState();
  let eventCount = 0;
  let rawFrameCount = 0;
  return segments.map((segment, index) => {
    eventCount += segment.length;
    rawFrameCount += segment.filter((event) => event.kind === 'raw_source_frame').length;
    const checkpoint = buildLiveDerivationCheckpoint({
      event_count: eventCount,
      profile,
      raw_frame_count: rawFrameCount,
      segment_index: index,
      segment_logical_content_sha256: sha256Hex(ndjsonBytes(segment)),
      state: foldLiveDerivation(state, segment, profile),
      symbol: 'SYNTH_100',
    });
    state = checkpoint.state;
    return canonicalJson({ checkpoint, log, ...liveCheckpointDigests(checkpoint) });
  });
}

describe('derivación en pliegue del estado vivo (ADR-0017)', () => {
  it.each(corpus)('%s: igual en cada límite', (_name, stimuli, profile) => {
    expectEquivalentAtEveryBoundary(eventsOf(stimuli, profile), profile);
  });

  it.each(VECTOR_SCENARIOS)('el vector %s: igual en cada límite', (_name, files) => {
    expectEquivalentAtEveryBoundary(vectorSegments(files).flat(), vectorProfile());
  });

  it(
    '300 logs aleatorios del dominio de §3, con los dos perfiles: igual en cada límite',
    {
      timeout: 60_000,
    },
    () => {
      // Semillas distintas por perfil, para que los 300 logs sean distintos.
      const profiles = [
        ['medición', measurement, 0],
        ['publicación', publication, 1000],
      ] as const;
      for (const [name, profile, first] of profiles) {
        for (let seed = first + 1; seed <= first + 150; seed += 1) {
          expectEquivalentAtEveryBoundary(
            eventsOf(randomStimuli(seed, profile), profile),
            profile,
            `semilla ${String(seed)} (${name})`,
          );
        }
      }
    },
  );

  it('el vector fija el punto de control de cada límite de segmento (§6)', async () => {
    const logs: (readonly [string, string[]])[] = VECTOR_SCENARIOS.map(([name, files]) => {
      const segments = vectorSegments(files);
      // El enlace usa el `logical_content_sha256` de cada segmento persistido.
      segments.forEach((segment, index) => {
        expect(sha256Hex(ndjsonBytes(segment))).toBe(
          sha256Hex(readFileSync(resolve(vectorRoot, files[index] ?? ''))),
        );
      });
      return [name, vectorLines(name, segments, vectorProfile())] as const;
    });
    for (const [name, stimuli, profile] of corpus) {
      logs.push([
        name,
        vectorLines(name, segmentsAtTransitions(eventsOf(stimuli, profile)), profile),
      ]);
    }
    const content = `${logs.flatMap(([, lines]) => lines).join('\n')}\n`;

    await expect(content).toMatchFileSnapshot('./fixtures/live-checkpoints.ndjson');
    expect(
      Object.fromEntries(logs.map(([name, lines]) => [name, sha256Hex(`${lines.join('\n')}\n`)])),
      `Un log del vector cambió sin subir LIVE_STATE_VERSION (${LIVE_STATE_VERSION}), o le falta su digest.`,
    ).toEqual(VECTOR_SHA256_BY_VERSION[LIVE_STATE_VERSION]);
  });

  it('con apertura y resolución en el mismo instante, falla donde falla la completa', () => {
    const throws = (run: () => unknown) => {
      try {
        run();
        return false;
      } catch {
        return true;
      }
    };
    const outcomes = {
      connection_lost: new Set<boolean>(),
      event_gap_unresolved: new Set<boolean>(),
    };
    for (const [type, variant, stimuli] of sameInstantStimuli()) {
      const events = eventsOf(stimuli, measurement);
      const full = throws(() => deriveMarketData([events], measurement));
      expect(
        throws(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)),
        `${type}, variante ${String(variant)}`,
      ).toBe(full);
      outcomes[type].add(full);
    }
    // Las variantes recorren los dos órdenes del empate.
    expect([...outcomes.connection_lost].sort()).toEqual([false, true]);
    expect([...outcomes.event_gap_unresolved].sort()).toEqual([false, true]);
  });

  it('falla donde falla la derivación completa', () => {
    for (const stimuli of [CLOSED_TWICE, RESOLVED_BEFORE_OPENING]) {
      const events = eventsOf(stimuli, measurement);
      expect(() => deriveMarketData([events], measurement)).toThrow();
      expect(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)).toThrow();
      const prefix = foldLiveDerivation(
        emptyLiveDerivationState(),
        events.slice(0, 2),
        measurement,
      );
      expect(() => foldLiveDerivation(prefix, events.slice(2), measurement)).toThrow();
    }
  });

  it('rechaza un resultado partial o unavailable sin fin de hueco o con otro rango (§3)', () => {
    for (const [, stimuli] of OUT_OF_DOMAIN) {
      const events = eventsOf(stimuli, measurement);
      expect(() => deriveMarketData([events], measurement)).not.toThrow();
      expect(() => foldLiveDerivation(emptyLiveDerivationState(), events, measurement)).toThrow(
        /hueco pendiente/u,
      );
    }
  });

  it('el informe de salud desde la vista viva es el de deriveHealthReport con el log entero, en cada límite', () => {
    const logs: (readonly [string, readonly SourceEvent[], PipelineProfile])[] = [
      ...corpus.map(
        ([name, stimuli, profile]) => [name, eventsOf(stimuli, profile), profile] as const,
      ),
      ...VECTOR_SCENARIOS.map(
        ([name, files]) => [name, vectorSegments(files).flat(), vectorProfile()] as const,
      ),
    ];
    // Lo que da quien observa la ingesta desde fuera (ADR-0015 §8, reglas 4 a 6).
    const observers = [
      {},
      { connection_state: 'disconnected', minimum_health: 'paused' },
      { backlog_bytes: 10, backlog_count: 2, connection_state: 'connected' },
      { operational_condition_types: ['persistence_unavailable'] },
    ] as const;
    for (const [name, events, profile] of logs) {
      for (let boundary = 0; boundary <= events.length; boundary += 1) {
        const prefix = events.slice(0, boundary);
        const view = liveDerivationView(
          foldLiveDerivation(emptyLiveDerivationState(), prefix, profile),
        );
        for (const observer of observers) {
          const shared = {
            backlog_bytes: 0,
            backlog_count: 0,
            last_published_dataset_id: null,
            source: profile.source,
            ...observer,
          };
          expect(
            deriveLiveHealthReport({ ...shared, view }),
            `${name}, ${String(boundary)}`,
          ).toEqual(
            deriveHealthReport({
              ...shared,
              derived: deriveMarketData([prefix], profile),
              sourceEvents: prefix,
            }),
          );
        }
      }
    }
  });

  it('el punto de control se identifica por su contenido y sus versiones', () => {
    const events = eventsOf(RECONNECTION, measurement);
    const state = foldLiveDerivation(emptyLiveDerivationState(), events, measurement);
    const input = {
      event_count: events.length,
      profile: measurement,
      raw_frame_count: 2,
      segment_index: 3,
      segment_logical_content_sha256: 'b'.repeat(64),
      state,
      symbol: 'SYNTH_100',
    };
    const checkpoint = buildLiveDerivationCheckpoint(input);
    expect(liveDerivationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(checkpoint.versions).toEqual(liveCheckpointVersions(measurement));
    expect(liveCheckpointDigests(buildLiveDerivationCheckpoint(input))).toEqual(
      liveCheckpointDigests(checkpoint),
    );

    const other = liveCheckpointDigests(
      buildLiveDerivationCheckpoint({ ...input, profile: publication }),
    );
    expect(other.versions_sha256).not.toBe(liveCheckpointDigests(checkpoint).versions_sha256);
    expect(other.checkpoint_sha256).not.toBe(liveCheckpointDigests(checkpoint).checkpoint_sha256);
  });
});
