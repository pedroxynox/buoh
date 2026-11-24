// Evidencia de memoria de dos sesiones de `ingest` (ADR-0021 §1, PR 2d). No es un comando del
// producto: lo usan `medir-memoria.mjs` y `dos-sesiones.mjs`, con la librería compilada del worker.
//
// Lo sintético de la medición, sin red ni datos de mercado, como `scripts/evidencia-f2-1/
// deriv-sintetico.mjs`, pero para cualquier símbolo y su ritmo: los mensajes con la forma de los de
// Deriv que leen la sesión y el perfil (catálogo, tick, `ping`, `forget_all` e historia), con precios
// inventados; el log de una captura de varios días, escrito con el `SourceEventLog` del worker; y un
// canal falso de Deriv en el proceso que contesta como el público. R_100 da un tick cada 2 s, y el oro
// (`frxXAUUSD`), uno cada segundo: 120 ticks en 120 s, medidos el 2026-11-16 (ADR-0021, «Medición»).
import { createHash } from 'node:crypto';

import {
  buildRawSourceFrame,
  createUuidV7Generator,
  SourceEventLog,
} from '../../apps/market-data-worker/dist/index.js';
import { KEEPALIVE_INTERVAL_MS } from '../../apps/market-data-worker/dist/deriv/connection.js';
import { DERIV_SOURCE } from '../../apps/market-data-worker/dist/deriv/profile.js';
import {
  connectionClosedSchema,
  connectionOpenedSchema,
} from '../../packages/contracts/dist/index.js';

/** Los dos mercados de la medición, con su ritmo y su entrada del catálogo. */
export const MARKETS = Object.freeze({
  R_100: {
    catalog: {
      market: 'synthetic_index',
      name: 'Volatility 100 Index',
      subgroup: 'synthetics',
      submarket: 'random_index',
      type: 'stockindex',
    },
    subscriptionId: 'a3c5e7f9-0b1d-4e2f-8a4c-6e8a0c2e4f60',
    symbol: 'R_100',
    tickIntervalS: 2,
  },
  frxXAUUSD: {
    catalog: {
      market: 'commodities',
      name: 'Gold/USD',
      subgroup: 'none',
      submarket: 'metals',
      type: 'commodities',
    },
    subscriptionId: 'b4d6f8a0-1c2e-4f30-9b5d-7f9b1d3f5a71',
    symbol: 'frxXAUUSD',
    tickIntervalS: 1,
  },
});

/** Lo que tarda un tick en llegar después de su hora de fuente, en el log sintético. */
const DELIVERY_DELAY_MS = 250;
const CATALOG_REQ_ID = 1;
const SUBSCRIPTION_REQ_ID = 2;
const RECONNECTED_FIRST_TICK_DELAY_MS = 6_000;

/**
 * La cotización inventada de la hora `epoch`, en segundos, con dos decimales: la misma en el log y en
 * el canal falso.
 */
export function quoteAt(epoch) {
  const cents = 123_400 + ((epoch * 7_919) % 2_001) - 1_000;
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** Los mensajes de Deriv de un mercado, con la forma de las respuestas reales. */
export function marketMessages(market) {
  const { catalog, subscriptionId: id, symbol } = market;
  const entry = {
    exchange_is_open: 1,
    is_trading_suspended: 0,
    market: catalog.market,
    pip_size: 0.01,
    subgroup: catalog.subgroup,
    submarket: catalog.submarket,
    trade_count: 7,
    underlying_symbol: symbol,
    underlying_symbol_name: catalog.name,
    underlying_symbol_type: catalog.type,
  };
  return {
    catalog: (reqId) =>
      JSON.stringify({
        active_symbols: [entry],
        echo_req: { active_symbols: 'brief', req_id: reqId },
        msg_type: 'active_symbols',
        req_id: reqId,
      }),
    forgetAll: (reqId) =>
      JSON.stringify({
        echo_req: { forget_all: 'ticks', req_id: reqId },
        forget_all: [id],
        msg_type: 'forget_all',
        req_id: reqId,
      }),
    history: (request, times) =>
      `{"echo_req":${JSON.stringify(request)},"history":{"prices":[${times.map(quoteAt).join(',')}],"times":[${times.map(String).join(',')}]},"msg_type":"history","pip_size":2,"req_id":${String(request.req_id)}}`,
    pong: (reqId) =>
      JSON.stringify({
        echo_req: { ping: 1, req_id: reqId },
        msg_type: 'ping',
        ping: 'pong',
        req_id: reqId,
      }),
    tick: (epoch) =>
      `{"echo_req":{"req_id":${String(SUBSCRIPTION_REQ_ID)},"subscribe":1,"ticks":"${symbol}"},"msg_type":"tick","req_id":${String(SUBSCRIPTION_REQ_ID)},"subscription":{"id":"${id}"},"tick":{"epoch":${String(epoch)},"id":"${id}","pip_size":2,"quote":${quoteAt(epoch)},"symbol":"${symbol}"}}`,
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** Bytes reproducibles: los de SHA-256 de la semilla y un contador. */
function seededBytes(seed) {
  let counter = 0;
  return (size) => {
    counter += 1;
    return createHash('sha256')
      .update(`${seed}:${String(counter)}`)
      .digest()
      .subarray(0, size);
  };
}

/**
 * Los source events de una sola conexión del mercado entre `startMs` y `endMs`, en orden, como los
 * deja `ingest`: la apertura, el catálogo, un tick por intervalo, un `pong` cada 45 s, `forget_all` y
 * el cierre pedido. La misma entrada da los mismos eventos.
 */
export function* captureEvents(input) {
  const { endMs, market, profile, startMs } = input;
  const messages = marketMessages(market);
  let clock = startMs;
  const nextId = createUuidV7Generator({ now: () => clock, randomBytes: seededBytes(input.seed) });
  const frame = (receivedMs, payload) => {
    clock = receivedMs;
    return buildRawSourceFrame(
      {
        connection_id: connectionId,
        observation_id: nextId(),
        payload_utf8: payload,
        received_at_utc: iso(receivedMs),
      },
      profile,
    );
  };
  const connectionId = nextId();
  yield connectionOpenedSchema.parse({
    connection_id: connectionId,
    event_id: nextId(),
    kind: 'connection_opened',
    occurred_at_utc: iso(startMs),
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
    supersedes_connection_id: null,
  });
  yield frame(startMs + 200, messages.catalog(CATALOG_REQ_ID));
  let reqId = SUBSCRIPTION_REQ_ID;
  let nextPingMs = startMs + KEEPALIVE_INTERVAL_MS;
  const lastTickMs = endMs - 2_000;
  for (
    let epoch = Math.ceil((startMs + 1_000) / 1_000);
    epoch * 1_000 + DELIVERY_DELAY_MS <= lastTickMs;
    epoch += market.tickIntervalS
  ) {
    const tickMs = epoch * 1_000 + DELIVERY_DELAY_MS;
    while (nextPingMs + 100 < tickMs) {
      reqId += 1;
      yield frame(nextPingMs + 100, messages.pong(reqId));
      nextPingMs += KEEPALIVE_INTERVAL_MS;
    }
    yield frame(tickMs, messages.tick(epoch));
  }
  reqId += 1;
  yield frame(endMs - 1_000, messages.forgetAll(reqId));
  clock = endMs;
  yield connectionClosedSchema.parse({
    affected_symbols: [market.symbol],
    closure_type: 'requested',
    connection_id: connectionId,
    event_id: nextId(),
    kind: 'connection_closed',
    occurred_at_utc: iso(endMs),
    reason: 'requested',
    schema_version: '1.0.0',
    source: DERIV_SOURCE,
  });
}

/**
 * Escribe la captura de `captureEvents` en el log, con el `SourceEventLog` del worker, como
 * `writeCaptureLog` de la evidencia de F2.1: continúa una escritura anterior y, con `deadlineMs`, deja
 * de escribir al pasar esa hora sin cerrar el segmento abierto.
 */
export async function writeCaptureLog(input) {
  const log = await SourceEventLog.open({
    objects: input.objects,
    source: DERIV_SOURCE,
    store: input.store,
    zlibVersion: process.versions.zlib,
  });
  const skip = log.totalEventCount;
  let position = 0;
  for (const event of captureEvents(input)) {
    position += 1;
    if (position <= skip) {
      continue;
    }
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      return { complete: false, events: log.totalEventCount, segments: log.openSegmentIndex };
    }
    await log.append(event);
    if (input.onProgress !== undefined && position % 50_000 === 0) {
      input.onProgress(position);
    }
  }
  if (log.totalEventCount > 0 && log.openSegmentStats.event_count > 0) {
    await log.close('requested');
  }
  return { complete: true, events: log.totalEventCount, segments: log.openSegmentIndex };
}

/**
 * Un canal falso de Deriv del mercado, con la interfaz de `openWsSocket`: contesta el catálogo, la
 * suscripción con un tick por intervalo con la hora real, cada `ping`, `forget_all` y `ticks_history`.
 * `control.onConnect` y `control.onTick` reciben cada conexión y cada tick.
 */
export function fakeDerivSocketFactory(market, control) {
  const messages = marketMessages(market);
  let connections = 0;
  return ({ onSignal }) => {
    const index = connections;
    connections += 1;
    control.onConnect?.(index);
    let closed = false;
    let ticks = 0;
    let timer = null;
    let lastEpoch = 0;
    const emit = (text) => {
      if (!closed) {
        onSignal({ byte_length: Buffer.byteLength(text, 'utf8'), kind: 'text', text });
      }
    };
    const finish = (code) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timer);
      setImmediate(() => {
        onSignal({ code, kind: 'closed' });
      });
    };
    const sendTick = () => {
      const epoch = Math.max(lastEpoch + 1, Math.floor(Date.now() / 1_000));
      lastEpoch = epoch;
      emit(messages.tick(epoch));
      ticks += 1;
      control.onTick?.(index, ticks);
      timer = setTimeout(sendTick, market.tickIntervalS * 1_000);
    };
    setImmediate(() => {
      onSignal({ kind: 'open' });
    });
    return {
      close: () => {
        finish(1000);
      },
      send: (text) => {
        const request = JSON.parse(text);
        setImmediate(() => {
          if ('active_symbols' in request) {
            emit(messages.catalog(request.req_id));
          } else if ('ticks' in request) {
            if (index > 0) {
              timer = setTimeout(sendTick, RECONNECTED_FIRST_TICK_DELAY_MS);
            } else {
              sendTick();
            }
          } else if ('ping' in request) {
            emit(messages.pong(request.req_id));
          } else if ('forget_all' in request) {
            clearTimeout(timer);
            emit(messages.forgetAll(request.req_id));
          } else if ('ticks_history' in request) {
            const end = Number(request.end);
            const times = [];
            for (let time = request.start; time < end; time += market.tickIntervalS) {
              times.push(time);
            }
            times.push(end);
            emit(messages.history(request, times));
          }
        });
      },
      terminate: () => {
        finish(1006);
      },
    };
  };
}
