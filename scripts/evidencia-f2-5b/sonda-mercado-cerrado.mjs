// Evidencia del oro con el mercado cerrado (ADR-0021 §2, PR 2d). No es un comando del producto, y,
// a diferencia de las demás herramientas de esta carpeta, sí se conecta a Deriv: al canal público,
// sin cuenta ni autenticación, como las consultas de ADR-0021, «Medición».
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`) y Node 24.22.0,
// mientras el oro está cerrado (entre semana, de 22:00 a 23:00 UTC; o el fin de semana):
//
//   node scripts/evidencia-f2-5b/sonda-mercado-cerrado.mjs [--simbolo frxXAUUSD] [--segundos 20]
//
// Pide, en una conexión: `active_symbols` (`brief`), del que toma solo `exchange_is_open` e
// `is_trading_suspended` del símbolo; `trading_times` del día UTC, del que toma solo su horario y sus
// días; y la suscripción `ticks` del símbolo, que escucha `--segundos`. Después pide `forget_all`.
// De la suscripción toma lo que lee `DerivConnection` (`apps/market-data-worker/src/deriv/
// connection.ts`): el `msg_type`, el `error.code`, el texto del mensaje y la hora de apertura que saca
// de él `marketOpensAt`, el código del worker. Cuenta los ticks, sin guardar ninguna cotización.
//
// Escribe en stdout una línea JSON sin precios. Salida 0 si la suscripción respondió como espera el
// worker para un mercado cerrado: `msg_type` `ticks`, `error.code` `MarketIsClosed`, una hora de
// apertura que `marketOpensAt` lee, posterior a la de la respuesta, y ningún tick. Salida 1 si no,
// como con el mercado abierto, y 2 con argumentos que no valen o sin conexión.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import {
  MARKET_IS_CLOSED,
  marketOpensAt,
} from '../../apps/market-data-worker/dist/deriv/connection.js';
import { DERIV_PUBLIC_ENDPOINT } from '../../apps/market-data-worker/dist/deriv/profile.js';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const WebSocket = requireFromWorker('ws');

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      segundos: { default: '20', type: 'string' },
      simbolo: { default: 'frxXAUUSD', type: 'string' },
    },
  }));
  if (!(Number(options.segundos) > 0) || !/^[A-Za-z0-9_]{1,64}$/u.test(options.simbolo)) {
    throw new TypeError('Uso: [--simbolo frxXAUUSD] [--segundos 20].');
  }
} catch (error) {
  console.log(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

const symbol = options.simbolo;
const listenMs = Number(options.segundos) * 1000;
const startedAt = new Date().toISOString();
const result = {
  catalog: null,
  started_at_utc: startedAt,
  subscription: null,
  symbol,
  ticks: 0,
  trading_times: null,
};

const ws = new WebSocket(DERIV_PUBLIC_ENDPOINT);
const pending = new Map();
let nextReqId = 1;
const ask = (request) =>
  new Promise((resolve) => {
    const reqId = nextReqId;
    nextReqId += 1;
    pending.set(reqId, resolve);
    ws.send(JSON.stringify({ ...request, req_id: reqId }));
  });

const timeout = setTimeout(() => {
  console.log(JSON.stringify({ ...result, code: 'Timeout', status: 'failed' }));
  process.exit(2);
}, listenMs + 30_000);

ws.on('error', (error) => {
  console.log(JSON.stringify({ code: error.code ?? error.name, status: 'failed' }));
  process.exit(2);
});

ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.msg_type === 'tick') {
    // Solo se cuenta: la cotización no se guarda. Con el mercado abierto, el primer tick es la
    // respuesta a la suscripción.
    result.ticks += 1;
  }
  const resolve = pending.get(message.req_id);
  if (resolve !== undefined) {
    pending.delete(message.req_id);
    resolve(message);
  }
});

ws.on('open', async () => {
  const catalog = await ask({ active_symbols: 'brief' });
  const entry = (catalog.active_symbols ?? []).find((item) => item.underlying_symbol === symbol);
  result.catalog =
    entry === undefined
      ? { found: false }
      : {
          exchange_is_open: entry.exchange_is_open,
          found: true,
          is_trading_suspended: entry.is_trading_suspended,
        };

  const day = startedAt.slice(0, 10);
  const times = await ask({ trading_times: day });
  let found = null;
  for (const market of times.trading_times?.markets ?? []) {
    for (const submarket of market.submarkets ?? []) {
      for (const item of submarket.symbols ?? []) {
        if ((item.underlying_symbol ?? item.symbol) === symbol) {
          found = item;
        }
      }
    }
  }
  result.trading_times =
    found === null
      ? { day, found: false }
      : { day, found: true, times: found.times, trading_days: found.trading_days };

  const subscribedAt = new Date().toISOString();
  const answer = await ask({ subscribe: 1, ticks: symbol });
  const error = answer.error ?? null;
  const opensAt = marketOpensAt(typeof error?.message === 'string' ? error.message : null);
  result.subscription = {
    answered_at_utc: new Date().toISOString(),
    error_code: error?.code ?? null,
    error_message: typeof error?.message === 'string' ? error.message : null,
    msg_type: answer.msg_type ?? null,
    opens_at_utc: opensAt,
    subscribed_at_utc: subscribedAt,
  };
  await new Promise((resolve) => {
    setTimeout(resolve, listenMs);
  });
  await ask({ forget_all: 'ticks' });
  clearTimeout(timeout);
  ws.close();
  const closedAsExpected =
    result.subscription.msg_type === 'ticks' &&
    result.subscription.error_code === MARKET_IS_CLOSED &&
    opensAt !== null &&
    Date.parse(opensAt) > Date.parse(result.subscription.answered_at_utc) &&
    result.ticks === 0;
  console.log(
    JSON.stringify({
      ...result,
      listened_ms: listenMs,
      status: closedAsExpected ? 'market_closed_as_expected' : 'not_as_expected',
    }),
  );
  process.exitCode = closedAsExpected ? 0 : 1;
});
