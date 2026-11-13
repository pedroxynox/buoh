import {
  deriveTickFingerprint,
  type HistoryRecoveryResult,
  type RawSourceFrame,
} from '@buoh/contracts';

import { getMember, parseJsonPreservingNumbers, type JsonNode } from './json-lexeme.js';
import {
  canonicalQuoteDecimal,
  epochSecondsToUtc,
  isEpochSecondsLexeme,
  pipSizeFromNumberLexeme,
  type UnflaggedTick,
} from './normalizer.js';
import { CONTRACT_SCHEMA_VERSION } from './profile.js';

/** Un tick de una página de historia: su segundo y su cotización canónica. */
export interface HistoryTick {
  readonly quote: string;
  readonly time: number;
}

/** Los segundos que pide una página, los dos incluidos. */
export interface HistoryPageRange {
  readonly end: number;
  readonly start: number;
}

/**
 * Las comprobaciones de una página `history` que no necesitan el esquema de respuesta (ADR-0015 §4;
 * ADR-0020 §3): el objeto `history`, sus arrays `times` y `prices` y `pip_size`; `pip_size` de valor
 * entero de 0 a 18, también escrito con una fracción de ceros (`2.0`, como lo manda el canal real);
 * `times` y `prices` de la misma longitud; tiempos enteros estrictamente crecientes dentro de
 * `range`; y precios que la regla de `quote_decimal` acepta con ese `pip_size`. Devuelve sus ticks y
 * su `pip_size`, o `null` si la página no es coherente. Pura.
 */
export function readHistoryTicks(
  root: JsonNode,
  range: HistoryPageRange,
): { readonly pip_size: number; readonly ticks: readonly HistoryTick[] } | null {
  const history = getMember(root, 'history');
  const times = getMember(history, 'times');
  const prices = getMember(history, 'prices');
  const pipSize = getMember(root, 'pip_size');
  if (
    history?.type !== 'object' ||
    times?.type !== 'array' ||
    prices?.type !== 'array' ||
    pipSize?.type !== 'number'
  ) {
    return null;
  }
  const decimals = pipSizeFromNumberLexeme(pipSize.lexeme);
  if (decimals === null || times.items.length !== prices.items.length) {
    return null;
  }
  const ticks: HistoryTick[] = [];
  for (const [index, timeNode] of times.items.entries()) {
    const priceNode = prices.items[index];
    if (timeNode.type !== 'number' || !isEpochSecondsLexeme(timeNode.lexeme)) {
      return null;
    }
    const time = Number(timeNode.lexeme);
    const previous = ticks.at(-1);
    if (
      time < range.start ||
      time > range.end ||
      (previous !== undefined && time <= previous.time) ||
      priceNode?.type !== 'number'
    ) {
      return null;
    }
    const quote = canonicalQuoteDecimal(priceNode.lexeme, decimals);
    if (!quote.ok) {
      return null;
    }
    ticks.push({ quote: quote.value, time });
  }
  return { pip_size: decimals, ticks };
}

/** Una respuesta `history` del log, con lo que la identifica entre las páginas de una recuperación. */
export interface HistoryFrame {
  readonly end: number | null;
  readonly frame: RawSourceFrame;
  readonly reqId: number | null;
  readonly root: JsonNode;
  readonly start: number | null;
  readonly symbol: string | null;
}

/** Un entero no negativo escrito como número o como texto, como los de `echo_req`; si no, `null`. */
function integerOf(node: JsonNode | undefined): number | null {
  const text =
    node?.type === 'number' ? node.lexeme : node?.type === 'string' ? node.value : undefined;
  if (text === undefined || !/^(?:0|[1-9]\d*)$/u.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Lee de un frame `history` su `req_id` y su petición (`echo_req`). Su payload ya es JSON válido. */
export function historyFrameOf(frame: RawSourceFrame): HistoryFrame {
  const root = parseJsonPreservingNumbers(frame.payload_utf8);
  const request = getMember(root, 'echo_req');
  const symbol = getMember(request, 'ticks_history');
  return {
    end: integerOf(getMember(request, 'end')),
    frame,
    reqId: integerOf(getMember(root, 'req_id')),
    root,
    start: integerOf(getMember(request, 'start')),
    symbol: symbol?.type === 'string' ? symbol.value : null,
  };
}

/**
 * Los ticks que trae la historia de un resultado `complete` que resolvió exactamente el hueco
 * pendiente de su derivación (ADR-0020 §3), en orden de tiempo. `frames` son las respuestas `history`
 * de su conexión desde el resultado anterior de esa conexión. Toma las del último intento: las de su
 * símbolo con un `req_id` igual o mayor que el de la de mayor `req_id` cuya petición termina en E, el
 * segundo del primer tick posterior al cierre. Así no cuenta la respuesta tardía de un intento
 * anterior, que la sesión ignoró. Da los ticks con un tiempo estrictamente entre S y E, con la
 * procedencia de su frame. Lanza si una de esas páginas no pasa `readHistoryTicks` o si sus tiempos
 * distintos no suman `recovered_event_count`: la sesión ya las comprobó, así que es un error de
 * programación.
 */
export function historyTicksOf(
  result: Extract<HistoryRecoveryResult, { status: 'complete' }>,
  frames: readonly HistoryFrame[],
): UnflaggedTick[] {
  const start = (Date.parse(result.from_event_time_utc) - 1) / 1000;
  const end = (Date.parse(result.to_event_time_utc) + 1) / 1000;
  const candidates = frames.filter((item) => item.symbol === result.symbol && item.reqId !== null);
  const firsts = candidates.filter((item) => item.end === end).map((item) => item.reqId ?? 0);
  const pages =
    firsts.length === 0
      ? []
      : candidates.filter((item) => (item.reqId ?? 0) >= Math.max(...firsts));

  const ticks: UnflaggedTick[] = [];
  const times = new Set<number>();
  for (const page of pages) {
    const read =
      page.start === null || page.end === null
        ? null
        : readHistoryTicks(page.root, { end: page.end, start: page.start });
    if (read === null) {
      throw new TypeError(
        `La página ${page.frame.observation_id} del último intento de ${result.event_id} no pasa las comprobaciones de ADR-0015 §4.`,
      );
    }
    for (const item of read.ticks) {
      if (item.time <= start || item.time >= end) {
        continue;
      }
      const eventTime = epochSecondsToUtc(item.time);
      if (eventTime === null) {
        throw new TypeError(
          `La página ${page.frame.observation_id} trae un tiempo fuera de rango.`,
        );
      }
      times.add(item.time);
      const identity = {
        event_time_utc: eventTime,
        pip_size: read.pip_size,
        quote_decimal: item.quote,
        source: page.frame.source,
        symbol: result.symbol,
      };
      ticks.push({
        ...identity,
        connector_version: page.frame.connector_version,
        observation_id: page.frame.observation_id,
        origin: 'history_recovery',
        raw_payload_sha256: page.frame.raw_payload_sha256,
        received_at_utc: page.frame.received_at_utc,
        schema_version: CONTRACT_SCHEMA_VERSION,
        tick_fingerprint_sha256: deriveTickFingerprint(identity),
      });
    }
  }
  if (times.size !== result.recovered_event_count) {
    throw new TypeError(
      `El último intento de ${result.event_id} trae ${String(times.size)} tiempos distintos y su recovered_event_count es ${String(result.recovered_event_count)}.`,
    );
  }
  return ticks.toSorted((left, right) =>
    left.event_time_utc < right.event_time_utc
      ? -1
      : left.event_time_utc > right.event_time_utc
        ? 1
        : 0,
  );
}
