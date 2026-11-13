import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  connectionClosedSchema,
  connectionOpenedSchema,
  historyRecoveryResultSchema,
  rawSourceFrameSchema,
  sha256Hex,
  type SourceEvent,
} from '@buoh/contracts';
import { createPipelineProfile } from '@buoh/domain';
import { describe, expect, it } from 'vitest';

import {
  DATASET_ELEMENT_CEILING,
  DATASET_END_STEP_SEGMENTS,
  planDataset,
  type DatasetPlan,
} from '../src/datasets/plan.js';

// Dónde termina cada dataset vivo (ADR-0020 §7): la marca de 6 horas, el objetivo, los finales
// posibles cada 6 segmentos, el final limpio, el techo de elementos, un segmento que lo pasa solo y
// el último dataset de un log terminado. Las expectativas salen de las reglas de §7. Log sintético:
// un segmento cada 5 minutos desde las 00:01 UTC, con un tick cada uno, fuente `synthetic`.
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const SYMBOL = 'SYNTH_100';
const profile = createPipelineProfile({
  connector_version: 'fixture-v1',
  quality_profile_bytes: Buffer.from(
    JSON.stringify({
      allowed_symbols: [SYMBOL],
      gap_detection: 'after_reconnection',
      maximum_delivery_delay_ms: 3000,
      maximum_event_gap_ms: 2000,
      non_tick_msg_types: ['history', 'ping'],
      profile_id: 'synthetic-publication-3.0.0',
      quality_rule_version: '3.0.0',
      source: 'synthetic',
    }),
  ),
  source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
  source_schema_release: 'synthetic-v1',
});

const BASE = Date.parse('2026-01-01T00:01:00.000Z');
const SEGMENT_MS = 300_000;
const A = '019b76da-a800-7000-8000-00000000a000';
const B = '019b76da-a800-7000-8000-00000000b000';
const iso = (ms: number) => new Date(ms).toISOString();
const segmentStart = (index: number) => BASE + index * SEGMENT_MS;
/** La hora de fuente del tick del segmento `index`, en milisegundos. */
const tickTime = (index: number) => segmentStart(index) + 1000;

class Log {
  #sequence = 0;
  readonly segments: SourceEvent[][] = [];

  #id(): string {
    this.#sequence += 1;
    return `019b76da-a800-7000-8000-${this.#sequence.toString().padStart(12, '0')}`;
  }

  raw(connection: string, payload: string, receivedAt: number): SourceEvent {
    return rawSourceFrameSchema.parse({
      connection_id: connection,
      connector_version: 'fixture-v1',
      kind: 'raw_source_frame',
      observation_id: this.#id(),
      payload_utf8: payload,
      raw_payload_sha256: sha256Hex(payload),
      received_at_utc: iso(receivedAt),
      schema_version: '1.0.0',
      source: 'synthetic',
    });
  }

  tick(connection: string, index: number): SourceEvent {
    const epoch = tickTime(index) / 1000;
    return this.raw(
      connection,
      `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":3,"quote":100.125,"symbol":"${SYMBOL}"}}`,
      tickTime(index) + 100,
    );
  }

  opened(connection: string, supersedes: string | null, at: number): SourceEvent {
    return connectionOpenedSchema.parse({
      connection_id: connection,
      event_id: this.#id(),
      kind: 'connection_opened',
      occurred_at_utc: iso(at),
      schema_version: '1.0.0',
      source: 'synthetic',
      supersedes_connection_id: supersedes,
    });
  }

  closed(connection: string, at: number, symbols: readonly string[] = [SYMBOL]): SourceEvent {
    return connectionClosedSchema.parse({
      affected_symbols: symbols,
      closure_type: 'transport_error',
      connection_id: connection,
      event_id: this.#id(),
      kind: 'connection_closed',
      occurred_at_utc: iso(at),
      reason: 'close_code_1006',
      schema_version: '1.0.0',
      source: 'synthetic',
    });
  }

  /**
   * La historia del hueco entre los ticks de los segmentos `from` y `to`, en una página, con
   * `interior` ticks recuperados entre ellos, cada 2 s, o un resultado `unavailable` sin página.
   */
  recovery(
    connection: string,
    from: number,
    to: number,
    at: number,
    result: 'complete' | 'partial' | 'unavailable' = 'complete',
    interior = 0,
  ): SourceEvent[] {
    const start = tickTime(from) / 1000;
    const end = tickTime(to) / 1000;
    const times = [start, ...Array.from({ length: interior }, (_, k) => start + 2 * (k + 1)), end];
    const page = this.raw(
      connection,
      `{"echo_req":{"count":1000,"end":"${String(end)}","req_id":3,"start":${String(start)},"style":"ticks","ticks_history":"${SYMBOL}"},"history":{"prices":[${times.map(() => '100.125').join(',')}],"times":[${times.map(String).join(',')}]},"msg_type":"history","pip_size":3,"req_id":3}`,
      at,
    );
    const common = {
      connection_id: connection,
      event_id: this.#id(),
      from_event_time_utc: iso(tickTime(from) + 1),
      kind: 'history_recovery_result',
      occurred_at_utc: iso(at + 100),
      schema_version: '1.0.0',
      source: 'synthetic',
      symbol: SYMBOL,
      to_event_time_utc: iso(tickTime(to) - 1),
    };
    if (result === 'partial') {
      // Un `partial` cuenta en `recovered_event_count` los ticks de sus páginas válidas, pero no
      // entran en el dataset (ADR-0020 §3), así que no cuentan para el techo.
      return [
        page,
        historyRecoveryResultSchema.parse({
          ...common,
          reason: 'history_boundary_mismatch',
          recovered_event_count: interior,
          status: 'partial',
        }),
      ];
    }
    return result === 'complete'
      ? [
          page,
          historyRecoveryResultSchema.parse({
            ...common,
            recovered_event_count: interior,
            status: 'complete',
          }),
        ]
      : [
          historyRecoveryResultSchema.parse({
            ...common,
            reason: 'history_timeout',
            status: 'unavailable',
          }),
        ];
  }
}

/**
 * Un log de `count` segmentos con un tick cada uno. Con `gap`, se cierra la conexión en el segmento
 * `gap.close`, la siguiente abre en el siguiente, y la historia llega en `gap.history`.
 */
function buildLog(
  count: number,
  gap?: {
    readonly close: number;
    /** La conexión se cae antes de suscribirse: el cierre no afecta a ningún símbolo. */
    readonly beforeSubscribing?: boolean;
    readonly history: number;
    readonly interior?: number;
    readonly result?: 'complete' | 'partial' | 'unavailable';
  },
): SourceEvent[][] {
  const log = new Log();
  let connection = A;
  for (let index = 0; index < count; index += 1) {
    const segment: SourceEvent[] = [];
    if (index === 0) {
      segment.push(log.opened(A, null, segmentStart(0)));
    }
    if (gap !== undefined && index === gap.close + 1) {
      segment.push(log.opened(B, A, segmentStart(index)));
      connection = B;
    }
    segment.push(log.tick(connection, index));
    if (index === gap?.close) {
      segment.push(
        log.closed(A, tickTime(index) + 1000, gap.beforeSubscribing === true ? [] : [SYMBOL]),
      );
    }
    if (index === gap?.history) {
      segment.push(
        ...log.recovery(
          B,
          gap.close,
          gap.close + 1,
          tickTime(index) + 2000,
          gap.result,
          gap.interior,
        ),
      );
    }
    log.segments.push(segment);
  }
  return log.segments;
}

const rowsOf = (segments: readonly SourceEvent[][]) =>
  segments.map((events, segment_index) => {
    const first = events[0];
    if (first === undefined) {
      throw new TypeError('Segmento vacío.');
    }
    return {
      event_count: events.length,
      first_event_time_utc:
        first.kind === 'raw_source_frame' ? first.received_at_utc : first.occurred_at_utc,
      segment_index,
    };
  });

function plan(
  segments: SourceEvent[][],
  options: { from?: number; logTerminated?: boolean; ceiling?: number } = {},
): Promise<DatasetPlan> {
  const from = options.from ?? 0;
  return planDataset({
    ceiling: options.ceiling,
    closedSegments: rowsOf(segments).slice(from),
    from,
    logTerminated: options.logTerminated ?? false,
    profile,
    readSegment: (index) => {
      const events = segments[index];
      if (events === undefined) {
        throw new TypeError(`Segmento ${String(index)} sin leer.`);
      }
      return Promise.resolve(events);
    },
  });
}

/** Lo que importa de un plan para estas pruebas. */
function summary(result: DatasetPlan) {
  if (result.status !== 'due') {
    return result;
  }
  return {
    clean: result.clean,
    elements: result.elements,
    from: result.from,
    open: result.open,
    segments: result.segments.length,
    status: result.status,
    to: result.to,
  };
}

// Las 00:01 UTC: la marca es las 06:00, y el objetivo, el segmento 71, el último que empieza antes
// (05:56); el 72 empieza a las 06:01.
const TARGET = 71;

describe('el final de un dataset (ADR-0020 §7)', () => {
  it('fija el techo de 16 000 elementos y un final posible cada 6 segmentos', () => {
    expect(DATASET_ELEMENT_CEILING).toBe(16_000);
    expect(DATASET_END_STEP_SEGMENTS).toBe(6);
  });

  it('termina en el objetivo, el último segmento que empieza antes de la marca, si es limpio', async () => {
    expect(summary(await plan(buildLog(80)))).toEqual({
      clean: true,
      elements: 73,
      from: 0,
      open: { open_condition_types: [], pending_continuity_symbols: [] },
      segments: 72,
      status: 'due',
      to: TARGET,
    });
  });

  it('la marca es la primera posterior al primer evento, y un segmento que empieza en ella no es anterior', async () => {
    // El primer evento a las 06:00:00.000 en punto: su marca es la de las 12:00, no la de las 06:00,
    // así que el objetivo es el 71, que empieza a las 11:55.
    const shifted = buildLog(80).map((events) => events);
    const rows = rowsOf(shifted).map((row, index) => ({
      ...row,
      first_event_time_utc: new Date(
        Date.parse('2026-01-01T06:00:00.000Z') + index * SEGMENT_MS,
      ).toISOString(),
    }));
    const read = (index: number) => Promise.resolve(shifted[index] ?? []);
    expect(
      summary(
        await planDataset({
          closedSegments: rows,
          from: 0,
          logTerminated: false,
          profile,
          readSegment: read,
        }),
      ),
    ).toMatchObject({ status: 'due', to: TARGET });
    // Con el segmento 72 empezando a las 06:00 en punto, el objetivo es el 71.
    const exact = rowsOf(shifted).map((row, index) =>
      index === TARGET + 1 ? { ...row, first_event_time_utc: '2026-01-01T06:00:00.000Z' } : row,
    );
    expect(
      summary(
        await planDataset({
          closedSegments: exact,
          from: 0,
          logTerminated: false,
          profile,
          readSegment: read,
        }),
      ),
    ).toMatchObject({ status: 'due', to: TARGET });
  });

  it('una conexión caída antes de suscribirse tampoco es un final limpio', async () => {
    // El cierre del objetivo no afecta a ningún símbolo: no hay continuidad pendiente, pero sí
    // `connection_lost` hasta que la conexión siguiente la resuelve, en el 72.
    const segments = buildLog(80, { beforeSubscribing: true, close: TARGET, history: 200 });
    expect(summary(await plan(segments))).toMatchObject({
      clean: true,
      status: 'due',
      to: TARGET + DATASET_END_STEP_SEGMENTS,
    });
  });

  it('espera mientras el log no tenga un segmento cerrado que empiece en la marca o después', async () => {
    expect(await plan(buildLog(TARGET + 1))).toEqual({
      reason: 'mark_not_reached',
      status: 'not_due',
    });
  });

  it('si el objetivo no es limpio, prueba cada 6 segmentos hasta uno limpio', async () => {
    // La conexión se cae en el objetivo, y la historia llega en el segmento 78: 71 deja la conexión
    // caída, 77 la continuidad pendiente, y 83 ya es limpio.
    const segments = buildLog(90, { close: TARGET, history: 78 });
    expect(summary(await plan(segments))).toMatchObject({
      clean: true,
      status: 'due',
      to: TARGET + 2 * DATASET_END_STEP_SEGMENTS,
    });
  });

  it('espera los segmentos del final posible siguiente si todavía no están cerrados', async () => {
    const segments = buildLog(80, { close: TARGET, history: 78 });
    expect(await plan(segments)).toEqual({ reason: 'awaiting_segments', status: 'not_due' });
  });

  it('si ningún final posible cabe limpio en el techo, termina en el último segmento que cabe', async () => {
    // Hasta el segmento 77 hay 81 elementos; el 78 suma su tick, la página, el resultado y los 149
    // ticks recuperados: 152.
    const segments = buildLog(90, { close: TARGET, history: 78, interior: 149 });
    expect(summary(await plan(segments, { ceiling: 232 }))).toEqual({
      clean: false,
      elements: 81,
      from: 0,
      open: { open_condition_types: [], pending_continuity_symbols: [SYMBOL] },
      segments: 78,
      status: 'due',
      to: 77,
    });
    // Con un elemento más cabe el 78, que trae la historia.
    expect(summary(await plan(segments, { ceiling: 233 }))).toMatchObject({
      clean: true,
      elements: 233,
      to: 78,
    });
  });

  it('para el techo, los ticks de un partial no cuentan', async () => {
    // Hasta el 77 hay 81 elementos, y el 78 suma su tick, la página y el resultado: 84. Si contaran
    // los 149 ticks del partial, el 78 no cabría.
    const segments = buildLog(90, { close: TARGET, history: 78, interior: 149, result: 'partial' });
    expect(summary(await plan(segments, { ceiling: 84 }))).toMatchObject({
      clean: true,
      elements: 84,
      open: { open_condition_types: ['event_gap_unresolved'], pending_continuity_symbols: [] },
      to: 78,
    });
  });

  it('sin la marca, si los source events ya pasan el techo, termina en el último que cabe sin esperar', async () => {
    // 60 segmentos con 61 source events, todos antes de las 06:00: el techo de 40 llega en el 38.
    expect(summary(await plan(buildLog(60), { ceiling: 40 }))).toMatchObject({
      clean: true,
      elements: 40,
      status: 'due',
      to: 38,
    });
    // Con un techo que no pasan, espera la marca.
    expect(await plan(buildLog(60), { ceiling: 61 })).toEqual({
      reason: 'mark_not_reached',
      status: 'not_due',
    });
  });

  it('sin la marca, un primer segmento que pasa el techo se avisa enseguida', async () => {
    expect(await plan(buildLog(10), { ceiling: 1 })).toEqual({
      elements: 2,
      segment_index: 0,
      status: 'segment_too_large',
    });
  });

  it('con un techo menor que el objetivo, termina en el último segmento que cabe', async () => {
    expect(summary(await plan(buildLog(80), { ceiling: 40 }))).toMatchObject({
      clean: true,
      elements: 40,
      status: 'due',
      to: 38,
    });
  });

  it('un segmento que pasa el techo por sí solo no se carga entero en un dataset', async () => {
    expect(await plan(buildLog(80), { ceiling: 1 })).toEqual({
      elements: 2,
      segment_index: 0,
      status: 'segment_too_large',
    });
  });

  it('un log terminado publica lo que le queda sin esperar la marca', async () => {
    expect(summary(await plan(buildLog(60), { logTerminated: true }))).toMatchObject({
      clean: true,
      status: 'due',
      to: 59,
    });
  });

  it('en un log terminado, su último segmento es el último final posible', async () => {
    // 71 y 77 no son limpios, 83 no existe, y el último segmento, el 80, ya tiene la historia.
    const segments = buildLog(81, { close: TARGET, history: 78 });
    expect(summary(await plan(segments, { logTerminated: true }))).toMatchObject({
      clean: true,
      to: 80,
    });
    // Si ni el último es limpio, termina igual en él, con lo que quedó abierto.
    const unresolved = buildLog(76, { close: TARGET, history: 200 });
    expect(summary(await plan(unresolved, { logTerminated: true }))).toMatchObject({
      clean: false,
      open: { open_condition_types: [], pending_continuity_symbols: [SYMBOL] },
      to: 75,
    });
  });

  it.each(['complete', 'partial', 'unavailable'] as const)(
    'el dataset que sigue a un final que no fue limpio se deriva sin fallar con un %s',
    async (result) => {
      // El anterior terminó en el 77 con la continuidad pendiente; este empieza en el 78, con la
      // historia de ese hueco. Su marca es las 12:00, y su objetivo, el 143.
      const segments = buildLog(150, { close: TARGET, history: 78, result });
      const next = await plan(segments, { from: 78 });
      expect(summary(next)).toMatchObject({ clean: true, from: 78, status: 'due', to: 143 });
      if (next.status === 'due' && result !== 'complete') {
        expect(next.open.open_condition_types).toEqual(['event_gap_unresolved']);
      }
    },
  );

  it('rechaza segmentos que no empiezan en from o no son contiguos', async () => {
    const segments = buildLog(80);
    const rows = rowsOf(segments);
    const read = (index: number) => Promise.resolve(segments[index] ?? []);
    await expect(
      planDataset({
        closedSegments: rows.slice(1),
        from: 0,
        logTerminated: false,
        profile,
        readSegment: read,
      }),
    ).rejects.toThrow(/contiguos desde 0/u);
    await expect(
      planDataset({
        closedSegments: [...rows.slice(0, 3), ...rows.slice(4)],
        from: 0,
        logTerminated: false,
        profile,
        readSegment: read,
      }),
    ).rejects.toThrow(/contiguos desde 0/u);
  });

  it('rechaza un segmento sin una hora válida', async () => {
    const segments = buildLog(80);
    const rows = rowsOf(segments).map((row, index) =>
      index === 3 ? { ...row, first_event_time_utc: 'no-es-una-hora' } : row,
    );
    await expect(
      planDataset({
        closedSegments: rows,
        from: 0,
        logTerminated: false,
        profile,
        readSegment: (index) => Promise.resolve(segments[index] ?? []),
      }),
    ).rejects.toThrow(/no tiene una hora válida/u);
  });

  it('sin segmentos cerrados desde from no hay nada que publicar', async () => {
    expect(await plan([], { logTerminated: false })).toEqual({
      reason: 'awaiting_segments',
      status: 'not_due',
    });
    expect(await plan([], { logTerminated: true })).toEqual({ status: 'nothing_due' });
  });
});
