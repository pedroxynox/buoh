// Comprobaciones previas de Cloudflare R2 (ADR-0018 §10; ADR-0016 §4), contra el bucket de prueba,
// `buoh-prueba`, antes de crear el de la captura. No es un comando del producto: usa la librería
// compilada del worker, el mismo `S3ObjectStore` y el mismo `writeVerified` que el log, como las
// evidencias de la Fase 1 y de F2.1. Nunca escribe en otro bucket.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`) y las variables del
// token `prueba`, que el agente recibe como Secrets de Kiro Web:
//
//   node scripts/evidencia-f2-2/comprobar-r2.mjs
//
// - `BUOH_PRUEBA_S3_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`;
// - `BUOH_PRUEBA_S3_ACCESS_KEY_ID` y `BUOH_PRUEBA_S3_SECRET_ACCESS_KEY`: las del token;
// - opcionales: `BUOH_PRUEBA_S3_BUCKET`, que solo admite `buoh-prueba`, y `BUOH_PRUEBA_S3_REGION`,
//   `auto` por defecto, la de R2.
//
// Cada ejecución escribe bajo un prefijo nuevo, `comprobaciones/<id>/`, y al terminar borra lo que
// escribió, de cualquier forma. Con el cliente del worker (`S3ObjectStore.fromConfig`: sumas de
// comprobación solo cuando hacen falta, `WHEN_REQUIRED`, y un solo intento), comprueba en orden:
//
// 1. `sin_sobrescribir`: con un objeto ya escrito, `writeVerified` con otros bytes en la misma clave
//    recibe 412 (`putIfAbsent` da `exists`), falla al releerlos, y el objeto sigue con los suyos;
// 2. `lectura_tras_escritura`: un objeto recién escrito se lee enseguida con los mismos bytes, y
//    `HeadObject` da su tamaño;
// 3. `sumas_de_comprobacion`: un objeto de 1 MiB de bytes aleatorios se escribe y se lee igual.
//
// stdout lleva una sola línea JSON saneada: el bucket, cada comprobación con `pass` o `fail` (y su
// motivo, un código, nunca un mensaje) y `status`. Nunca lleva el endpoint, que tiene el ID de la
// cuenta, ni las claves. Salida 0 si pasan las tres, 1 si alguna falla y 2 con variables inválidas,
// sin abrir ninguna conexión.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import {
  failureReason,
  S3ObjectStore,
  writeVerified,
} from '../../apps/market-data-worker/dist/index.js';

const requireFromWorker = createRequire(
  new URL('../../apps/market-data-worker/package.json', import.meta.url),
);
const { DeleteObjectCommand, HeadObjectCommand, S3Client } =
  requireFromWorker('@aws-sdk/client-s3');

/** El único bucket en el que escribe: el de prueba de ADR-0018 §10. */
const TEST_BUCKET = 'buoh-prueba';

/**
 * La configuración del token `prueba` en `env`, o la lista de variables inválidas, nunca sus
 * valores. Solo admite el bucket `buoh-prueba`.
 */
function testConfig(env) {
  const rejected = [];
  const endpoint = env.BUOH_PRUEBA_S3_ENDPOINT;
  const parsed = endpoint !== undefined && URL.canParse(endpoint) ? new URL(endpoint) : null;
  // Las claves no viajan sin cifrar: `http:` solo para un almacenamiento local, como el de compose.
  const local = parsed !== null && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (
    parsed === null ||
    !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))
  ) {
    rejected.push('BUOH_PRUEBA_S3_ENDPOINT');
  }
  for (const name of ['BUOH_PRUEBA_S3_ACCESS_KEY_ID', 'BUOH_PRUEBA_S3_SECRET_ACCESS_KEY']) {
    if (typeof env[name] !== 'string' || env[name].length === 0) {
      rejected.push(name);
    }
  }
  const bucket = env.BUOH_PRUEBA_S3_BUCKET ?? TEST_BUCKET;
  if (bucket !== TEST_BUCKET) {
    rejected.push('BUOH_PRUEBA_S3_BUCKET');
  }
  const region = env.BUOH_PRUEBA_S3_REGION ?? 'auto';
  if (region.length === 0) {
    rejected.push('BUOH_PRUEBA_S3_REGION');
  }
  if (rejected.length > 0) {
    return { rejected };
  }
  return {
    config: {
      accessKeyId: env.BUOH_PRUEBA_S3_ACCESS_KEY_ID,
      bucket,
      endpoint,
      region,
      secretAccessKey: env.BUOH_PRUEBA_S3_SECRET_ACCESS_KEY,
    },
  };
}

const sameBytes = (left, right) => Buffer.from(left).equals(Buffer.from(right));

/** Corre una comprobación: `pass`, o `fail` con el motivo saneado de lo que la hizo fallar. */
async function check(name, work) {
  try {
    const reason = await work();
    return reason === null ? { name, status: 'pass' } : { name, reason, status: 'fail' };
  } catch (error) {
    return { name, reason: failureReason(error), status: 'fail' };
  }
}

/** Las tres comprobaciones de ADR-0018 §10, con el almacén y el cliente bajo `prefix`. */
async function runChecks({ client, config, prefix, store }) {
  const written = [];
  const put = async (key, bytes) => {
    written.push(key);
    return store.putIfAbsent(key, bytes, 'application/octet-stream');
  };
  const results = [];
  try {
    results.push(
      await check('sin_sobrescribir', async () => {
        const original = randomBytes(64);
        if ((await put('sin-sobrescribir', original)) !== 'created') {
          return 'first_write_not_created';
        }
        const other = randomBytes(64);
        if (
          (await store.putIfAbsent('sin-sobrescribir', other, 'application/octet-stream')) !==
          'exists'
        ) {
          return 'second_write_not_rejected';
        }
        const verified = await writeVerified(
          store,
          'sin-sobrescribir',
          other,
          'application/octet-stream',
        ).then(
          () => 'accepted',
          (error) => failureReason(error),
        );
        if (verified !== 'object_verification_failed') {
          return `write_verified_${verified}`;
        }
        const kept = await store.get('sin-sobrescribir', original.byteLength);
        return sameBytes(kept, original) ? null : 'object_changed';
      }),
    );
    results.push(
      await check('lectura_tras_escritura', async () => {
        const bytes = randomBytes(4096);
        if ((await put('lectura-tras-escritura', bytes)) !== 'created') {
          return 'write_not_created';
        }
        const read = await store.get('lectura-tras-escritura', bytes.byteLength);
        if (!sameBytes(read, bytes)) {
          return 'read_mismatch';
        }
        const head = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: `${prefix}lectura-tras-escritura` }),
        );
        return head.ContentLength === bytes.byteLength ? null : 'head_size_mismatch';
      }),
    );
    results.push(
      await check('sumas_de_comprobacion', async () => {
        const bytes = randomBytes(1024 * 1024);
        if ((await put('sumas-de-comprobacion', bytes)) !== 'created') {
          return 'write_not_created';
        }
        const read = await store.get('sumas-de-comprobacion', bytes.byteLength);
        return sameBytes(read, bytes) ? null : 'read_mismatch';
      }),
    );
  } finally {
    for (const key of written) {
      await client
        .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${prefix}${key}` }))
        .catch(() => undefined);
    }
  }
  return results;
}

async function main() {
  const loaded = testConfig(process.env);
  if ('rejected' in loaded) {
    process.stdout.write(
      `${JSON.stringify({ code: 'ConfigError', rejected: loaded.rejected, status: 'failed' })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { config } = loaded;
  const prefix = `comprobaciones/${randomUUID()}/`;
  const store = S3ObjectStore.fromConfig({ ...config, keyPrefix: prefix });
  const client = new S3Client({
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    region: config.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    const startedAt = new Date().toISOString();
    const checks = await runChecks({ client, config, prefix, store });
    const status = checks.every((item) => item.status === 'pass') ? 'passed' : 'failed';
    process.stdout.write(
      `${JSON.stringify({ bucket: config.bucket, checks, started_at_utc: startedAt, status })}\n`,
    );
    process.exitCode = status === 'passed' ? 0 : 1;
  } finally {
    store.destroy();
    client.destroy();
  }
}

await main();
