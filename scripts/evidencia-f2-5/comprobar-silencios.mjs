// Comprueba si Deriv generó ticks de R_100 dentro de los silencios que encontró la medición de los
// umbrales (ADR-0020, «Medición»): intervalos de más de 2 s entre ticks seguidos de una conexión
// abierta. No es un comando del producto. Pide la historia de cada silencio por el WebSocket público
// de Deriv, sin autenticación, como la recuperación de `ingest` (ADR-0015 §4), y solo escribe
// conteos y horas, nunca una cotización.
//
// Uso, desde la raíz del repositorio, con las dependencias instaladas y la salida de
// `medir-umbrales.mjs` guardada en un archivo:
//
//   node scripts/evidencia-f2-5/comprobar-silencios.mjs --medicion <medicion.json>
//
// Para cada silencio, de S a E, pide `ticks_history` con `style: ticks`, `start` = S y `end` = E, y
// cuenta los tiempos que devuelve y los que caen estrictamente entre los dos. Ninguno dentro quiere
// decir que la fuente no generó ticks en ese silencio.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { DERIV_PUBLIC_ENDPOINT } from '../../apps/market-data-worker/dist/deriv/profile.js';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const WebSocket = requireFromWorker('ws');

const SYMBOL = 'R_100';
const TIMEOUT_MS = 15_000;

const { values } = parseArgs({ options: { medicion: { type: 'string' } } });
if (values.medicion === undefined) {
  console.error('Uso: node scripts/evidencia-f2-5/comprobar-silencios.mjs --medicion <archivo>');
  process.exit(2);
}
const silences = JSON.parse(readFileSync(values.medicion, 'utf8')).silences;
if (
  !Array.isArray(silences) ||
  silences.some(
    (item) => Number.isNaN(Date.parse(item?.from_utc)) || Number.isNaN(Date.parse(item?.to_utc)),
  )
) {
  console.error('El archivo no tiene la lista `silences` de medir-umbrales.mjs.');
  process.exit(2);
}

const socket = new WebSocket(DERIV_PUBLIC_ENDPOINT, { handshakeTimeout: 10_000 });
const pending = new Map();
socket.on('message', (data) => {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  const resolve = pending.get(message?.req_id);
  if (resolve !== undefined) {
    pending.delete(message.req_id);
    resolve(message);
  }
});

let reqId = 0;
const ask = (request) =>
  new Promise((resolve, reject) => {
    reqId += 1;
    const timer = setTimeout(() => reject(new Error('request_timeout')), TIMEOUT_MS);
    pending.set(reqId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    socket.send(JSON.stringify({ ...request, req_id: reqId }));
  });

try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const results = [];
  for (const silence of silences) {
    const start = Date.parse(silence.from_utc) / 1000;
    const end = Date.parse(silence.to_utc) / 1000;
    const reply = await ask({ count: 5000, end, start, style: 'ticks', ticks_history: SYMBOL });
    const times = Array.isArray(reply.history?.times) ? reply.history.times : [];
    results.push({
      from_utc: silence.from_utc,
      to_utc: silence.to_utc,
      error: reply.error?.code ?? null,
      returned: times.length,
      inside: times.filter((time) => time > start && time < end).length,
    });
  }
  console.log(JSON.stringify({ symbol: SYMBOL, silences: results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error?.code ?? error?.message ?? 'error' }));
  process.exitCode = 1;
} finally {
  socket.close();
}
