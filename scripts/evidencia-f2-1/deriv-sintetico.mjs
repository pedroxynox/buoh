// Evidencia de memoria de F2.1 (ADR-0017 §9). No es un comando del producto: lo usan
// `medir-memoria.mjs` y `sesion.mjs`, con la librería compilada del worker.
//
// Lo sintético de la medición, sin red ni datos de mercado: los mensajes con la forma de los de Deriv
// que leen la sesión y el perfil de medición (los de `derivMessages` de las pruebas del worker), con
// precios inventados; el log de una captura de R_100 de varios días, escrito con el `SourceEventLog`
// del worker; y un canal falso de Deriv en el proceso (`fakeDerivSocketFactory`) que contesta como el
// público: catálogo, suscripción con un tick cada 2 s, `ping`, `forget_all` y `ticks_history`.
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

export const SYMBOL = 'R_100';
/** R_100 da un tick cada 2 s. */
export const TICK_INTERVAL_S = 2;
/** Lo que tarda un tick en llegar después de su hora de fuente, en el log sintético. */
const DELIVERY_DELAY_MS = 250;
/** El `subscription.id` sintético de los ticks. */
const SUBSCRIPTION_ID = 'a3c5e7f9-0b1d-4e2f-8a4c-6e8a0c2e4f60';
/** Los `req_id` de la conexión: el catálogo es el 1, la suscripción el 2 y los `ping`, los siguientes. */
const CATALOG_REQ_ID = 1;
const SUBSCRIPTION_REQ_ID = 2;

/** La entrada de R_100 en el catálogo, con los diez campos de la respuesta. */
const CATALOG_ENTRY = {
  exchange_is_open: 1,
  is_trading_suspended: 0,
  market: 'synthetic_index',
  pip_size: 0.01,
  subgroup: 'synthetics',
  submarket: 'random_index',
  trade_count: 7,
  underlying_symbol: SYMBOL,
  underlying_symbol_name: 'Volatility 100 Index',
  underlying_symbol_type: 'stockindex',
};

/**
 * La cotización inventada de la hora `epoch`, en segundos, con dos decimales: la misma en el log, en
 * los ticks del canal falso y en su historia, así que los extremos de un hueco coinciden.
 */
export function quoteAt(epoch) {
  const cents = 123_400 + ((epoch * 7_919) % 2_001) - 1_000;
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** Los mensajes de Deriv que usa la medición, con la forma de las respuestas reales. */
export const messages = {
  catalog: (reqId) =>
    JSON.stringify({
      active_symbols: [CATALOG_ENTRY],
      echo_req: { active_symbols: 'brief', req_id: reqId },
      msg_type: 'active_symbols',
      req_id: reqId,
    }),
  forgetAll: (reqId) =>
    JSON.stringify({
      echo_req: { forget_all: 'ticks', req_id: reqId },
      forget_all: [SUBSCRIPTION_ID],
      msg_type: 'forget_all',
      req_id: reqId,
    }),
  /** Una página de `ticks_history` con esas horas, en orden, y su cotización. */
  history: (request, times) =>
    `{"echo_req":${JSON.stringify(request)},"history":{"prices":[${times.map(quoteAt).join(',')}],"times":[${times.map(String).join(',')}]},"msg_type":"history","pip_size":2,"req_id":${String(request.req_id)}}`,
  pong: (reqId) =>
    JSON.stringify({
      echo_req: { ping: 1, req_id: reqId },
      msg_type: 'ping',
      ping: 'pong',
      req_id: reqId,
    }),
  /** Un tick de la suscripción: lleva su `req_id` y el lexema de la cotización, como el real. */
  tick: (epoch) =>
    `{"echo_req":{"req_id":${String(SUBSCRIPTION_REQ_ID)},"subscribe":1,"ticks":"${SYMBOL}"},"msg_type":"tick","req_id":${String(SUBSCRIPTION_REQ_ID)},"subscription":{"id":"${SUBSCRIPTION_ID}"},"tick":{"epoch":${String(epoch)},"id":"${SUBSCRIPTION_ID}","pip_size":2,"quote":${quoteAt(epoch)},"symbol":"${SYMBOL}"}}`,
};

const iso = (ms) => new Date(ms).toISOString();

/**
 * Bytes pseudoaleatorios y reproducibles: los de SHA-256 de la semilla y un contador. Con la misma
 * semilla, los mismos IDs, así que una escritura interrumpida se puede continuar.
 */
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
 * Los source events de una sola conexión de R_100 entre `startMs` y `endMs`, en orden, como los deja
 * `ingest`: la apertura, la respuesta del catálogo, un tick cada 2 s, un `pong` cada 45 s, la
 * respuesta de `forget_all` y el cierre pedido. Unos 45 000 eventos por día. Los IDs son UUIDv7 con
 * la hora de cada evento y bytes reproducibles de `seed`: la misma entrada da los mismos eventos.
 */
export function* captureEvents(input) {
  const { endMs, profile, startMs } = input;
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
    epoch += TICK_INTERVAL_S
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
    affected_symbols: [SYMBOL],
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
 * Escribe en el log de la fuente, con el `SourceEventLog` del worker y sin bloqueo, la captura de
 * `captureEvents`. El log rota sus segmentos como en `ingest`, por la ventana de 300 000 ms de la
 * política de segmentos, y al final cierra el abierto con `requested`, como `ingest` al parar. No
 * escribe puntos de control: los escribe la primera sesión que arranca sobre el log.
 *
 * Continúa una escritura anterior: salta los eventos que el log ya tiene, que con la misma entrada
 * son los mismos, y vuelve a escribir uno que quedó a medias, con los mismos bytes. Con `deadlineMs`,
 * deja de escribir al pasar esa hora del reloj, sin cerrar el segmento abierto. Da si terminó, los
 * eventos del log y sus segmentos cerrados.
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
    if (input.onProgress !== undefined && position % 10_000 === 0) {
      input.onProgress(position);
    }
  }
  if (log.totalEventCount > 0 && log.openSegmentStats.event_count > 0) {
    await log.close('requested');
  }
  return { complete: true, events: log.totalEventCount, segments: log.openSegmentIndex };
}

/**
 * Un canal falso de Deriv, en el proceso, con la interfaz de `openWsSocket`. Cada llamada es una
 * conexión: avisa `open`, contesta el catálogo, la suscripción con un tick cada 2 s con la hora real
 * (en segundos, como Deriv), cada `ping`, `forget_all`, después del cual deja de mandar ticks, y
 * `ticks_history` con una página de un tick cada 2 s entre los dos extremos pedidos, incluidos. Con
 * `dropAfterTicks`, la primera conexión se cierra sola (código 1001, como un cierre remoto) después de
 * esa cantidad de ticks, y las siguientes mandan su primer tick `RECONNECTED_FIRST_TICK_DELAY_MS`
 * después de la suscripción, así que al hueco le faltan unos ticks que trae la historia. `control`
 * recibe cada conexión, cada tick y cada historia contestada.
 */
const RECONNECTED_FIRST_TICK_DELAY_MS = 6_000;

export function fakeDerivSocketFactory(control) {
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
      if (index === 0 && control.dropAfterTicks !== undefined && ticks >= control.dropAfterTicks) {
        control.onDrop?.();
        finish(1001);
        return;
      }
      timer = setTimeout(sendTick, TICK_INTERVAL_S * 1_000);
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
            if (index > 0 && control.dropAfterTicks !== undefined) {
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
            for (let time = request.start; time < end; time += TICK_INTERVAL_S) {
              times.push(time);
            }
            times.push(end);
            emit(messages.history(request, times));
            control.onHistory?.();
          }
        });
      },
      terminate: () => {
        finish(1006);
      },
    };
  };
}
