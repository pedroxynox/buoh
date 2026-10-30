import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sourceEventSchema, type SourceEvent } from '@buoh/contracts';
import {
  createPipelineProfile,
  deriveMarketData,
  ingestSyntheticStimuli,
  type PipelineProfile,
} from '@buoh/domain';

// El corpus de la equivalencia del pliegue en el dominio (`packages/domain/test/live-derivation
// .test.ts`, ADR-0017 §9), copiado para la equivalencia de los lectores del worker: el vector v1,
// los logs escritos a mano, los 300 logs aleatorios con semilla y los logs que no se pueden derivar.
// Las mismas semillas dan los mismos logs. Fuente `synthetic`, conector `fixture-v1` y símbolo
// `SYNTH_100`; ningún precio es de mercado.

const vectorRoot = resolve(import.meta.dirname, '../../../../test-vectors/market-data/v1');
const sourceSchema = readFileSync(resolve(vectorRoot, 'source-schema.json'));

export const SYMBOL = 'SYNTH_100';

function profileFrom(quality: Record<string, unknown>): PipelineProfile {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: Buffer.from(JSON.stringify(quality)),
    source_schema_bytes: sourceSchema,
    source_schema_release: 'synthetic-v1',
  });
}

const baseProfile = {
  allowed_symbols: [SYMBOL],
  gap_detection: 'after_reconnection',
  non_tick_msg_types: ['ping'],
  quality_rule_version: '2.0.0',
  source: 'synthetic',
};
/** Perfil con umbrales: la separación demuestra la continuidad o el hueco. */
export const publication = profileFrom({
  ...baseProfile,
  maximum_delivery_delay_ms: 2000,
  maximum_event_gap_ms: 2000,
  profile_id: 'synthetic-v2-publication',
});
/** Perfil de medición, como el de la sesión: solo la historia decide un hueco. */
export const measurement = profileFrom({
  ...baseProfile,
  profile_id: 'synthetic-v2-measurement',
  purpose: 'measurement',
});

const A = '019b76da-a800-7000-8000-00000000a000';
const B = '019b76da-a800-7000-8000-00000000b000';
const C = '019b76da-a800-7000-8000-00000000c000';
/** 2026-01-01T00:00:00.000Z en segundos, como las horas de la fuente. */
const T0 = 1767225600;

export function id(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

function at(seconds: number, milliseconds = 0): string {
  return new Date(seconds * 1000 + milliseconds).toISOString();
}

function frame(sequence: number, connection: string, payload: string, receivedAt: string) {
  return {
    connection_id: connection,
    fixture_sequence: sequence,
    kind: 'source_frame',
    observation_id: id(sequence),
    payload_utf8: payload,
    received_at_utc: receivedAt,
  };
}

/** Tick recibido `delayMs` después de su hora de fuente, con la cotización y el símbolo dados. */
function tick(
  sequence: number,
  connection: string,
  epoch: number,
  options: { delayMs?: number; quote?: string; symbol?: string } = {},
) {
  const { delayMs = 100, quote = '100.125', symbol = SYMBOL } = options;
  return frame(
    sequence,
    connection,
    `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":${quote},"symbol":"${symbol}"}}`,
    at(epoch, delayMs),
  );
}

function ping(sequence: number, connection: string, receivedAt: string) {
  return frame(sequence, connection, '{"msg_type":"ping","ping":"pong"}', receivedAt);
}

/** Tipo y motivo de cada cierre: pedido, por timeout o reparado al arrancar (ADR-0015 §3). */
const CLOSURES = {
  repaired: ['transport_error', 'close_not_recorded'],
  requested: ['requested', 'operator_shutdown'],
  timeout: ['timeout', 'ping_timeout'],
} as const;

function close(
  sequence: number,
  connection: string,
  occurredAt: string,
  closure: keyof typeof CLOSURES = 'timeout',
) {
  const [closureType, reason] = CLOSURES[closure];
  return {
    affected_symbols: [SYMBOL],
    closure_type: closureType,
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    kind: 'connection_closed',
    occurred_at_utc: occurredAt,
    reason,
  };
}

function open(sequence: number, connection: string, supersedes: string | null, occurredAt: string) {
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
      }
    | { readonly reason: string; readonly status: 'unavailable' },
  occurredAt = at(T0 + 60),
  connection = B,
) {
  return {
    connection_id: connection,
    event_id: id(sequence),
    fixture_sequence: sequence,
    from_event_time_utc: range.from,
    kind: 'history_recovery_result',
    occurred_at_utc: occurredAt,
    symbol: SYMBOL,
    to_event_time_utc: range.to,
    ...result,
  };
}

/** Los source events de unos estímulos sintéticos, persistidos con el perfil. */
export function eventsOf(stimuli: readonly unknown[], profile: PipelineProfile): SourceEvent[] {
  const result = ingestSyntheticStimuli([...stimuli], profile);
  if (result.status !== 'persisted') {
    throw new TypeError('Se esperaba persistencia completa.');
  }
  return result.segments.flat().map((event) => sourceEventSchema.parse(event));
}

/** Generador con semilla (mulberry32), sin `Math.random`: los logs aleatorios son siempre los mismos. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function connectionId(index: number): string {
  return `019b76da-a800-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`;
}

/**
 * Un log aleatorio del dominio de ADR-0017 §3, escrito como lo haría la sesión: cada conexión se
 * cierra una vez y la siguiente la supera, y cada historia cubre exactamente el hueco pendiente, ya
 * con su fin, o resuelve un hueco abierto. Mezcla ticks en orden, repetidos, en conflicto, fuera de
 * orden y en los instantes de los extremos del hueco, pings, símbolos no permitidos, cierres pedidos,
 * por timeout y reparados, e historias `complete`, `partial` y `unavailable`.
 */
export function randomStimuli(seed: number, profile: PipelineProfile): unknown[] {
  const random = seededRandom(seed);
  const choose = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new TypeError('Nada que elegir.');
    }
    return item;
  };
  const length = 6 + Math.floor(random() * 24);
  let connectionIndex = 0;
  let connection = connectionId(connectionIndex);
  let connected = true;
  let clock = T0 * 1000 + 100;
  let watermark = T0;
  /** Ticks del símbolo en la conexión actual: sin ellos, la sesión puede cerrar sin símbolos. */
  let ticksOnConnection = 1;
  const stimuli: unknown[] = [tick(1, connection, T0)];
  /** Huecos abiertos por un `partial` o `unavailable`, que solo puede resolver un `complete`. */
  const openGaps: { from: string; to: string }[] = [];
  const tickAt = (epoch: number, options: { quote?: string; symbol?: string }) =>
    tick(stimuli.length + 1, connection, epoch, { ...options, delayMs: clock - epoch * 1000 });

  while (stimuli.length < length) {
    clock += 50 + Math.floor(random() * 1500);
    const sequence = stimuli.length + 1;
    const now = new Date(clock).toISOString();
    if (!connected) {
      connectionIndex += 1;
      const next = connectionId(connectionIndex);
      stimuli.push(open(sequence, next, connection, now));
      connection = next;
      connected = true;
      ticksOnConnection = 0;
      continue;
    }
    const [gap] = deriveMarketData([eventsOf(stimuli, profile)], profile).pendingGaps;
    const roll = random();
    if (roll < 0.5) {
      const instants = [watermark + 1 + Math.floor(random() * 3), watermark, watermark - 1];
      if (gap !== undefined) {
        instants.push((Date.parse(gap.from_event_time_utc) - 1) / 1000);
        if (gap.to_event_time_utc !== null) {
          instants.push((Date.parse(gap.to_event_time_utc) + 1) / 1000);
        }
      }
      const epoch = choose(instants);
      clock = Math.max(clock, epoch * 1000 + 50);
      watermark = Math.max(watermark, epoch);
      ticksOnConnection += 1;
      stimuli.push(tickAt(epoch, { quote: choose(['100.124', '100.125', '100.126']) }));
    } else if (roll < 0.56) {
      stimuli.push(ping(sequence, connection, now));
    } else if (roll < 0.6) {
      stimuli.push(tickAt(watermark + 1, { symbol: 'SYNTH_050' }));
    } else if (roll < 0.78) {
      const closed = close(sequence, connection, now, choose(['repaired', 'requested', 'timeout']));
      // Una conexión que no llegó a suscribirse se cierra sin símbolos afectados.
      stimuli.push(
        ticksOnConnection === 0 && random() < 0.5 ? { ...closed, affected_symbols: [] } : closed,
      );
      connected = false;
    } else if (gap !== undefined && gap.to_event_time_utc !== null) {
      const range = { from: gap.from_event_time_utc, to: gap.to_event_time_utc };
      const status = choose(['complete', 'partial', 'unavailable'] as const);
      if (status !== 'complete') {
        openGaps.push(range);
      }
      const result =
        status === 'complete'
          ? { recovered_event_count: 0, status }
          : status === 'partial'
            ? { reason: 'history_page_limit', recovered_event_count: 0, status }
            : { reason: 'history_timeout', status };
      stimuli.push(recovery(sequence, range, result, now, connection));
    } else if (openGaps.length > 0) {
      const range = choose(openGaps);
      openGaps.splice(openGaps.indexOf(range), 1);
      stimuli.push(
        recovery(
          sequence,
          range,
          { recovered_event_count: 0, status: 'complete' },
          now,
          connection,
        ),
      );
    }
  }
  return stimuli;
}

/** Los segmentos persistidos de cada escenario del vector v1, en orden. */
export const VECTOR_SCENARIOS = [
  ['v1', ['expected-source-events-000000.ndjson', 'expected-source-events-000001.ndjson']],
  ['v1/zero-valid-ticks', ['zero-valid-ticks/expected-source-events.ndjson']],
] as const;

export function vectorEvents(files: readonly string[]): SourceEvent[] {
  return files.flatMap((name) =>
    readFileSync(resolve(vectorRoot, name), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => sourceEventSchema.parse(JSON.parse(line))),
  );
}

export function vectorProfile(): PipelineProfile {
  const manifest = JSON.parse(readFileSync(resolve(vectorRoot, 'manifest.json'), 'utf8')) as {
    profile: { connector_version: string; source_schema_release: string };
  };
  return createPipelineProfile({
    connector_version: manifest.profile.connector_version,
    quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
    source_schema_bytes: sourceSchema,
    source_schema_release: manifest.profile.source_schema_release,
  });
}

/** Cierre no pedido de A, apertura de B que lo supera y primer tick de B un segundo después. */
const RECONNECTION = [
  tick(1, A, T0),
  close(2, A, at(T0, 500)),
  open(3, B, A, at(T0, 600)),
  tick(4, B, T0 + 1),
];
const GAP = { from: at(T0, 1), to: at(T0, 999) };

/** Los logs escritos a mano del corpus del dominio, con su perfil. */
export const CORPUS: readonly (readonly [string, readonly unknown[], PipelineProfile])[] = [
  ['reconexión con hueco pendiente', RECONNECTION, measurement],
  ['la separación demuestra la continuidad', RECONNECTION, publication],
  [
    'historia completa que cubre el hueco',
    [...RECONNECTION, recovery(5, GAP, { recovered_event_count: 0, status: 'complete' })],
    measurement,
  ],
  [
    'historia parcial y después completa del mismo rango',
    [
      ...RECONNECTION,
      recovery(5, GAP, {
        reason: 'history_page_limit',
        recovered_event_count: 0,
        status: 'partial',
      }),
      tick(6, B, T0 + 3),
      recovery(7, GAP, { recovered_event_count: 0, status: 'complete' }, at(T0 + 61)),
    ],
    measurement,
  ],
  [
    'historia no disponible con el hueco abierto',
    [
      ...RECONNECTION,
      tick(5, B, T0 + 2),
      recovery(6, GAP, { reason: 'history_timeout', status: 'unavailable' }),
    ],
    measurement,
  ],
  [
    'la separación supera el umbral y la historia no está disponible',
    [
      tick(1, A, T0),
      close(2, A, at(T0, 500)),
      open(3, B, A, at(T0, 600)),
      tick(4, B, T0 + 5),
      recovery(
        5,
        { from: at(T0, 1), to: at(T0 + 4, 999) },
        { reason: 'history_timeout', status: 'unavailable' },
      ),
    ],
    publication,
  ],
  [
    'cierre pedido con el hueco pendiente y su fin ya conocido',
    [
      ...RECONNECTION,
      close(5, B, at(T0 + 1, 500), 'requested'),
      open(6, C, B, at(T0 + 2)),
      tick(7, C, T0 + 3),
      recovery(8, GAP, { reason: 'history_timeout', status: 'unavailable' }),
    ],
    measurement,
  ],
  [
    'cierre reparado al arrancar (close_not_recorded) e historia completa',
    [
      tick(1, A, T0),
      tick(2, A, T0 + 1),
      close(3, A, at(T0 + 30), 'repaired'),
      open(4, B, A, at(T0 + 30, 100)),
      tick(5, B, T0 + 31),
      recovery(
        6,
        { from: at(T0 + 1, 1), to: at(T0 + 30, 999) },
        { recovered_event_count: 0, status: 'complete' },
      ),
    ],
    measurement,
  ],
  [
    'dos cierres seguidos conservan el inicio del hueco',
    [
      ...RECONNECTION,
      close(5, B, at(T0 + 1, 500)),
      open(6, C, B, at(T0 + 1, 600)),
      tick(7, C, T0 + 5),
      recovery(
        8,
        { from: at(T0, 1), to: at(T0 + 4, 999) },
        {
          reason: 'history_page_limit',
          recovered_event_count: 0,
          status: 'partial',
        },
      ),
    ],
    measurement,
  ],
  [
    'duplicados, conflictos y ticks fuera de orden en los extremos del hueco',
    [
      tick(1, A, T0),
      tick(2, A, T0, { quote: '100.124' }),
      close(3, A, at(T0, 500)),
      open(4, B, A, at(T0, 600)),
      tick(5, B, T0, { delayMs: 900 }),
      tick(6, B, T0, { delayMs: 950, quote: '100.126' }),
      tick(7, B, T0 + 2),
      tick(8, B, T0 + 2, { delayMs: 300, quote: '100.127' }),
      tick(9, B, T0 - 1, { delayMs: 3000 }),
      tick(10, B, T0 + 3),
      recovery(
        11,
        { from: at(T0, 1), to: at(T0 + 1, 999) },
        {
          reason: 'history_boundary_mismatch',
          recovered_event_count: 0,
          status: 'partial',
        },
      ),
    ],
    measurement,
  ],
  [
    'cierre pedido, cierre sin ticks, ping y símbolo no permitido',
    [
      close(1, A, at(T0, 100)),
      open(2, B, A, at(T0, 200)),
      ping(3, B, at(T0, 300)),
      tick(4, B, T0 + 1, { symbol: 'SYNTH_050' }),
      tick(5, B, T0 + 2),
      close(6, B, at(T0 + 2, 500), 'requested'),
      open(7, C, B, at(T0 + 3)),
      tick(8, C, T0 + 4),
    ],
    measurement,
  ],
];

/**
 * Los logs del dominio que no se pueden derivar, con el perfil de medición: una conexión cerrada
 * dos veces, una resolución anterior a su apertura y, en 16 variantes cada uno, una apertura y su
 * resolución en el mismo instante, que fallan o no según el ID que decide el empate (ADR-0017 §3).
 * Tanto `deriveMarketData` como el pliegue fallan en los mismos.
 */
export function failureLogs(): (readonly [string, SourceEvent[]])[] {
  const logs: (readonly [string, SourceEvent[]])[] = [
    [
      'una conexión cerrada dos veces',
      eventsOf([tick(1, A, T0), close(2, A, at(T0, 500)), close(3, A, at(T0, 600))], measurement),
    ],
    [
      'una resolución anterior a su apertura',
      eventsOf([tick(1, A, T0), close(2, A, at(T0, 500)), open(3, B, A, at(T0, 400))], measurement),
    ],
  ];
  for (let variant = 0; variant < 16; variant += 1) {
    logs.push([
      `connection_lost en el mismo instante, variante ${String(variant)}`,
      eventsOf(
        [
          tick(1, A, T0),
          close(2, A, at(T0, 500)),
          { ...open(3, B, A, at(T0, 500)), event_id: id(100 + variant) },
          tick(4, B, T0 + 1),
        ],
        measurement,
      ),
    ]);
    logs.push([
      `event_gap_unresolved en el mismo instante, variante ${String(variant)}`,
      eventsOf(
        [
          ...RECONNECTION,
          recovery(5, GAP, {
            reason: 'history_page_limit',
            recovered_event_count: 0,
            status: 'partial',
          }),
          {
            ...recovery(6, GAP, { recovered_event_count: 0, status: 'complete' }),
            event_id: id(200 + variant),
          },
        ],
        measurement,
      ),
    ]);
  }
  return logs;
}

/**
 * Los logs fuera del dominio de ADR-0017 §3, con el perfil de medición: un resultado `unavailable`
 * sin fin de hueco y resultados `partial` con otro rango. `deriveMarketData` los acepta; el pliegue
 * falla cerrado.
 */
export function outOfDomainLogs(): (readonly [string, SourceEvent[]])[] {
  const partial = (range: { readonly from: string; readonly to: string }) =>
    eventsOf(
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
  return [
    [
      'unavailable sin fin de hueco',
      eventsOf(
        [
          tick(1, A, T0),
          close(2, A, at(T0, 500)),
          open(3, B, A, at(T0, 600)),
          recovery(4, GAP, { reason: 'history_timeout', status: 'unavailable' }),
        ],
        measurement,
      ),
    ],
    ['partial con otro fin', partial({ from: GAP.from, to: at(T0, 500) })],
    ['partial con otro inicio', partial({ from: at(T0, 2), to: GAP.to })],
  ];
}

/** Un frame del log con otro conector, como el de una versión anterior del worker. */
export function foreignFrame(sequence: number): SourceEvent {
  const [event] = eventsOf([tick(1, C, T0 + 10)], measurement);
  if (event?.kind !== 'raw_source_frame') {
    throw new TypeError('Se esperaba un frame.');
  }
  return { ...event, connector_version: 'fixture-v0', observation_id: id(sequence) };
}
