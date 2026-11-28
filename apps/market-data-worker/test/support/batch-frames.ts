import { createHash } from 'node:crypto';

import { rawSourceFrameSchema, type RawSourceFrame, type SourceEvent } from '@buoh/contracts';
import { BATCH_SEGMENT_POLICY } from '@buoh/domain';

import { DERIV_BATCH_CONNECTOR_VERSION } from '../../src/deriv/batch-profile.js';
import { DERIV_SOURCE } from '../../src/deriv/profile.js';
import { SourceEventLog } from '../../src/index.js';
import type { ObjectStore } from '../../src/ports.js';
import type { SourceLogStore } from '../../src/source-log/ports.js';
import { uuid } from './connection-harness.js';

// Respuestas de los lotes con las formas medidas en Deriv y precios sintéticos, y un log de los lotes
// escrito como lo escribe el comando de los lotes: cada ejecución, su conexión y su segmento,
// cerrado al terminar, con la política 2.0.0 (ADR-0021 §3).

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let ids = 50_000;
const nextId = () => uuid((ids += 1));

/** Un frame de los lotes con su texto, recibido a `receivedUtc`. */
export function batchFrame(text: string, receivedUtc: string): RawSourceFrame {
  return rawSourceFrameSchema.parse({
    connection_id: '019b76da-a800-7000-8000-00000000c000',
    connector_version: DERIV_BATCH_CONNECTOR_VERSION,
    kind: 'raw_source_frame',
    observation_id: nextId(),
    payload_utf8: text,
    raw_payload_sha256: sha256(text),
    received_at_utc: receivedUtc,
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
  });
}

/**
 * El `trading_times` del día `date` con el horario de 00:00 a 22:00 y de 23:00 a 23:59:59 de cada
 * símbolo de `symbols`; por defecto, el oro.
 */
export const sessionText = (date: string, symbols: readonly string[] = ['frxXAUUSD']) =>
  `{"echo_req":{"req_id":1,"trading_times":"${date}"},"msg_type":"trading_times","req_id":1,"trading_times":{"markets":[{"name":"x","submarkets":[{"name":"x","symbols":[${symbols
    .map(
      (symbol) =>
        `{"name":"x","times":{"close":["22:00:00","23:59:59"],"open":["00:00:00","23:00:00"]},"underlying_symbol":"${symbol}"}`,
    )
    .join(',')}]}]}]}}`;

/** Una cotización de `MULTUP` del oro con el multiplicador `multiplier`, a `epoch` segundos. */
export const quoteText = (multiplier: number, epoch: number) =>
  `{"echo_req":{"amount":10,"basis":"stake","contract_type":"MULTUP","currency":"USD","multiplier":${String(multiplier)},"proposal":1,"req_id":4,"underlying_symbol":"frxXAUUSD"},"msg_type":"proposal","proposal":{"ask_price":10.00,"commission":0.20,"date_start":${String(epoch)},"id":"x","longcode":"x","multiplier":${String(multiplier)},"payout":0,"spot":1,"spot_time":${String(epoch)}},"req_id":4}`;

/** Un `RateLimit` de Deriv a una cotización. */
export const rateLimitText =
  '{"echo_req":{"amount":10,"basis":"stake","contract_type":"MULTUP","currency":"USD","multiplier":100,"proposal":1,"req_id":5,"underlying_symbol":"frxXAUUSD"},"error":{"code":"RateLimit","message":"x"},"msg_type":"proposal","req_id":5}';

/** El catálogo de los lotes, que no da registro. */
export const catalogText =
  '{"active_symbols":[{"exchange_is_open":1,"is_trading_suspended":0,"market":"x","pip_size":0.01,"subgroup":"x","submarket":"x","underlying_symbol":"frxXAUUSD","underlying_symbol_name":"x"}],"echo_req":{"active_symbols":"brief"},"msg_type":"active_symbols"}';

/** Una página de velas de 1 minuto del oro, de `start` a `end`, con las de `epochs`. */
export const pageText = (start: number, end: number, epochs: readonly number[]) =>
  `{"candles":[${epochs
    .map((epoch) => `{"close":1,"epoch":${String(epoch)},"high":1,"low":1,"open":1}`)
    .join(
      ',',
    )}],"echo_req":{"end":"${String(end)}","granularity":60,"req_id":7,"start":${String(start)},"style":"candles","ticks_history":"frxXAUUSD"},"msg_type":"candles","pip_size":2,"req_id":7}`;

/** Una ejecución del comando de los lotes: a qué hora conecta y qué respuestas recibe. */
export interface BatchRun {
  readonly atUtc: string;
  readonly texts: readonly string[];
}

/**
 * Escribe un log de los lotes: por cada ejecución, su `ConnectionOpened`, una respuesta por segundo y
 * su `ConnectionClosed`, y cierra el segmento abierto, como el comando de los lotes. Devuelve sus
 * source events.
 */
export async function writeBatchLog(input: {
  /** Sin el cierre de la última ejecución ni el de su segmento, como un proceso que murió. */
  readonly leaveOpen?: boolean;
  readonly objects: ObjectStore;
  readonly runs: readonly BatchRun[];
  readonly store: SourceLogStore;
}): Promise<SourceEvent[]> {
  const log = await SourceEventLog.open({
    objects: input.objects,
    policy: BATCH_SEGMENT_POLICY,
    source: DERIV_SOURCE,
    store: input.store,
    zlibVersion: 'test-zlib',
  });
  const events: SourceEvent[] = [];
  for (const [runIndex, run] of input.runs.entries()) {
    const open = input.leaveOpen === true && runIndex === input.runs.length - 1;
    const at = Date.parse(run.atUtc);
    const iso = (offsetMs: number) => new Date(at + offsetMs).toISOString();
    const connection = nextId();
    const append = async (event: SourceEvent) => {
      await log.append(event);
      events.push(event);
    };
    await append({
      connection_id: connection,
      event_id: nextId(),
      kind: 'connection_opened',
      occurred_at_utc: iso(0),
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
      supersedes_connection_id: null,
    });
    for (const [index, text] of run.texts.entries()) {
      await append({ ...batchFrame(text, iso((index + 1) * 1000)), connection_id: connection });
    }
    if (open) {
      break;
    }
    await append({
      affected_symbols: [],
      closure_type: 'requested',
      connection_id: connection,
      event_id: nextId(),
      kind: 'connection_closed',
      occurred_at_utc: iso((run.texts.length + 1) * 1000),
      reason: 'requested',
      schema_version: '1.0.0',
      source: DERIV_SOURCE,
    });
    await log.close('requested');
  }
  return events;
}

/**
 * Una página de ticks de la historia de `symbol` (precisión del PR 6a de ADR-0021 §9), de `start` a
 * `end`, con un tick en cada segundo de `epochs`, como responde Deriv con `style: ticks`.
 */
export const historyPageText = (
  symbol: string,
  start: number,
  end: number,
  epochs: readonly number[] = [],
) =>
  `{"echo_req":{"count":1000,"end":"${String(end)}","req_id":2,"start":${String(start)},"style":"ticks","ticks_history":"${symbol}"},"history":{"prices":[${epochs.map(() => '1').join(',')}],"times":[${epochs.join(',')}]},"msg_type":"history","pip_size":2,"req_id":2}`;

/** Un `RateLimit` de Deriv a una página de ticks de la historia. */
export const historyRateLimitText = (symbol: string, start: number, end: number) =>
  `{"echo_req":{"count":1000,"end":"${String(end)}","req_id":3,"start":${String(start)},"style":"ticks","ticks_history":"${symbol}"},"error":{"code":"RateLimit","message":"x"},"msg_type":"ticks_history","req_id":3}`;

/** Un error de Deriv que no es `RateLimit` a una página de ticks de la historia: cuenta como respondida. */
export const historyErrorText = (symbol: string, start: number, end: number) =>
  `{"echo_req":{"count":1000,"end":"${String(end)}","req_id":3,"start":${String(start)},"style":"ticks","ticks_history":"${symbol}"},"error":{"code":"InputValidationFailed","message":"x"},"msg_type":"ticks_history","req_id":3}`;

/**
 * Una página de velas de 1 minuto de `symbol` (precisión del PR 6d de ADR-0021 §9), de `start` a
 * `end`, con las de `epochs`, como `pageText` con otro símbolo.
 */
export const candlePageText = (
  symbol: string,
  start: number,
  end: number,
  epochs: readonly number[] = [],
) =>
  pageText(start, end, epochs).replace(
    '"ticks_history":"frxXAUUSD"',
    `"ticks_history":"${symbol}"`,
  );

/** Un error de Deriv a una página de velas de `symbol`: `RateLimit` u otro, que cuenta como respondida. */
export const candleErrorText = (
  symbol: string,
  start: number,
  end: number,
  code = 'MarketIsClosed',
) =>
  `{"echo_req":{"count":1000,"end":"${String(end)}","granularity":60,"req_id":3,"start":${String(start)},"style":"candles","ticks_history":"${symbol}"},"error":{"code":"${code}","message":"x"},"msg_type":"ticks_history","req_id":3}`;
