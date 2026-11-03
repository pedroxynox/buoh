// Evidencia de memoria de la API de F2.3 (ADR-0019 §10 y §12; plan de Fase 2). No es un comando del
// producto: arranca la API compilada y la mide, como la evidencia de memoria de F2.1.
//
// Uso, desde la raíz del repositorio, con la API compilada (`pnpm --filter @buoh/api run build`),
// Node 24.22.0 y el PostgreSQL local con sus variables `BUOH_POSTGRES_*` (el arnés de integración):
//
//   .buoh-local/integration.sh node scripts/evidencia-f2-3/medir-memoria.mjs [--rondas 3] [--series 3]
//
// Migra el esquema `buoh_api` en la base local, arranca `apps/api/dist/cli/serve.js` con los tamaños
// de V8 de producción (`API_NODE_FLAGS`), espera a que su `/api/salud` responda 200 y lo somete a
// `--series` series de `--rondas` rondas cada una; cada ronda da de alta una cuenta nueva con la orden
// `cuenta`, usa su enlace (contraseña y código: Argon2id real, el pico de memoria), inicia sesión
// (Argon2id de nuevo), lee la sesión y la auditoría y pide dos páginas estáticas. Mide el máximo de
// memoria residente del proceso de la API (`VmHWM` de `/proc/<pid>/status`) en cada serie y cuenta el
// mayor. Al terminar para la API; no borra el esquema, porque el arnés levanta una base nueva y
// cada ejecución usa usuarios con un sufijo propio. Cifras en MiB de 1 048 576 bytes.
//
// No usa datos de mercado ni red externa. Las claves del servidor se generan al vuelo y viajan solo
// por el entorno del proceso hijo; este script nunca las escribe. La salida es una línea JSON con los
// máximos, los tiempos y el resultado de cada ronda, sin claves ni contraseñas. Salida 0 si todas las
// rondas fueron bien y el máximo queda por debajo del techo, 1 si no, 2 ante un uso o entorno inválidos.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { API_NODE_FLAGS } from '../../apps/api/dist/node-flags.js';
import { hotp, totpStep } from '../../apps/api/dist/auth/totp.js';

const SERVE = fileURLToPath(new URL('../../apps/api/dist/cli/serve.js', import.meta.url));
const MIGRATE = fileURLToPath(new URL('../../apps/api/dist/cli/migrate.js', import.meta.url));
const CUENTA = fileURLToPath(new URL('../../apps/api/dist/cli/cuenta.js', import.meta.url));
const PASSWORD = 'una contraseña larga de prueba f2-3';
/** Sufijo único por ejecución: evita chocar con cuentas de una medición anterior si la base persiste. */
const RUN = Date.now().toString(36);
/** Techo orientativo del proceso de la API en F2.3, muy por debajo del Starter de 512 MB (§12). */
const CEILING_MIB = 300;

const log = (message) => {
  console.error(`${new Date().toISOString()} ${message}`);
};
const mib = (kib) => Math.round((kib / 1024) * 10) / 10;

let options;
try {
  ({ values: options } = parseArgs({
    allowPositionals: false,
    options: {
      rondas: { default: '3', type: 'string' },
      series: { default: '3', type: 'string' },
      // Para el contraste: arranca la API sin los tamaños de V8, como vería los 31 GiB del sandbox.
      'sin-opciones': { default: false, type: 'boolean' },
    },
  }));
  for (const name of ['rondas', 'series']) {
    if (!(Number(options[name]) > 0)) {
      throw new TypeError(`--${name} tiene que ser un número positivo.`);
    }
  }
} catch (error) {
  console.log(JSON.stringify({ code: 'UsageError', message: error.message, status: 'failed' }));
  process.exit(2);
}

const host = process.env.BUOH_POSTGRES_HOST;
if (host === undefined) {
  console.log(
    JSON.stringify({
      code: 'ConfigError',
      message: 'Faltan las variables BUOH_POSTGRES_* del PostgreSQL local (usa integration.sh).',
      status: 'failed',
    }),
  );
  process.exit(2);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of text) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Un puerto libre que el sistema asigna y suelta en el acto. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Tres claves de 32 bytes en base64, distintas entre sí (ADR-0019 §10). */
function serverKeys() {
  const keys = new Set();
  while (keys.size < 3) {
    keys.add(randomBytes(32).toString('base64'));
  }
  return [...keys];
}

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function peakRssKib(pid) {
  const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
  return Number(/VmHWM:\s+(\d+)\s+kB/u.exec(status)?.[1] ?? '0');
}

async function waitForReady(origin) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/salud`);
      if (response.status === 200) {
        return true;
      }
    } catch {
      // Todavía no escucha.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Una ronda: alta, uso del enlace (Argon2id), inicio de sesión (Argon2id), sesión, auditoría y web. */
async function round(origin, env, user) {
  const alta = await runNode(CUENTA, ['alta', user], env);
  const url = alta.stdout.split('\n').find((line) => line.includes('/enlace/#'));
  if (url === undefined) {
    throw new Error(`cuenta alta no dio enlace (salida ${String(alta.code)})`);
  }
  const token = url.slice(url.indexOf('/enlace/#') + '/enlace/#'.length).trim();
  const headers = { origin, 'content-type': 'application/json' };
  const post = (path, body, extra = {}) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });

  const secretResponse = await post('/api/v1/enlace/secreto', { token });
  const secret = await secretResponse.json();
  const decoded = base32Decode(secret.totp.secret);
  const enroll = await post('/api/v1/enlace', {
    token,
    password: PASSWORD,
    code: hotp(decoded, totpStep(Date.now())),
  });
  // El inicio usa el paso siguiente: el del enlace ya se gastó para esa credencial (ADR-0019 §1).
  const login = await post('/api/v1/sesion', {
    username: user,
    password: PASSWORD,
    code: hotp(decoded, totpStep(Date.now()) + 1),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const sesion = await fetch(`${origin}/api/v1/sesion`, { headers: { cookie } });
  const auditoria = await fetch(`${origin}/api/v1/auditoria`, { headers: { cookie } });
  const home = await fetch(`${origin}/`);
  const acceso = await fetch(`${origin}/acceso/`);
  return {
    user,
    secret: secretResponse.status,
    enroll: enroll.status,
    login: login.status,
    sesion: sesion.status,
    auditoria: auditoria.status,
    home: home.status,
    acceso: acceso.status,
  };
}

async function measureSeries(series, env, origin, flags) {
  const child = spawn(process.execPath, [...flags, SERVE], {
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForReady(origin))) {
      throw new Error('la API no respondió /api/salud a tiempo');
    }
    const rounds = [];
    for (let index = 0; index < Number(options.rondas); index += 1) {
      rounds.push(await round(origin, env, `m${RUN}_${String(series)}_${String(index)}`));
    }
    const peak = peakRssKib(child.pid);
    return { peak_mib: mib(peak), rounds };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('close', resolve);
      setTimeout(resolve, 5000);
    });
  }
}

let output;
let exitCode;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const [passwordPepper, totpKey, tokenKey] = serverKeys();
  const env = {
    ...process.env,
    BUOH_DEPLOYMENT_ENVIRONMENT: 'development',
    BUOH_API_ORIGIN: origin,
    BUOH_API_PASSWORD_PEPPER: passwordPepper,
    BUOH_API_TOTP_KEY: totpKey,
    BUOH_API_TOKEN_KEY: tokenKey,
    PORT: String(port),
  };

  log('migrando el esquema buoh_api');
  const migrated = await runNode(MIGRATE, [], env);
  if (migrated.code !== 0) {
    throw new Error(`db:migrate salió con ${String(migrated.code)}`);
  }

  const flags = options['sin-opciones'] ? [] : [...API_NODE_FLAGS];
  const series = [];
  for (let index = 0; index < Number(options.series); index += 1) {
    log(`serie ${String(index + 1)} de ${String(options.series)}`);
    series.push(await measureSeries(index, env, origin, flags));
  }

  const peakMib = Math.max(...series.map((item) => item.peak_mib));
  const roundsOk = series.every((item) =>
    item.rounds.every(
      (r) =>
        r.secret === 200 &&
        r.enroll === 200 &&
        r.login === 201 &&
        r.sesion === 200 &&
        r.auditoria === 200 &&
        r.home === 200 &&
        r.acceso === 200,
    ),
  );
  output = {
    node: process.version,
    node_flags: flags,
    ceiling_mib: CEILING_MIB,
    peak_mib: peakMib,
    rounds_ok: roundsOk,
    passed: roundsOk && peakMib < CEILING_MIB,
    series,
    finished_at_utc: new Date().toISOString(),
  };
  exitCode = output.passed ? 0 : 1;
} catch (error) {
  output = {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    status: 'failed',
  };
  exitCode = 1;
}
console.log(JSON.stringify(output));
process.exitCode = exitCode;
