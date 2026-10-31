// Comprobaciones previas de Cloudflare R2 (ADR-0018 §10; ADR-0016 §4), contra el bucket de prueba,
// `buoh-prueba`, antes de crear el de la captura. No es un comando del producto: usa la librería
// compilada del worker, el mismo `S3ObjectStore` y el mismo `writeVerified` que el log, como las
// evidencias de la Fase 1 y de F2.1. Solo escribe en `buoh-prueba`.
//
// Uso, desde la raíz del repositorio, con el worker compilado (`pnpm run build`) y las variables del
// token `prueba`, que el agente recibe como Secrets de Kiro Web:
//
//   node scripts/evidencia-f2-2/comprobar-r2.mjs
//
// - `BUOH_PRUEBA_S3_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, sin nada detrás;
// - `BUOH_PRUEBA_S3_ACCESS_KEY_ID` y `BUOH_PRUEBA_S3_SECRET_ACCESS_KEY`: las del token;
// - opcionales: `BUOH_PRUEBA_S3_BUCKET`, que solo admite `buoh-prueba`, y `BUOH_PRUEBA_S3_REGION`,
//   `auto` por defecto, la de R2.
//
// El endpoint es el de una cuenta de R2 sin jurisdicción, o `http://127.0.0.1` o `http://localhost`
// para un ensayo local, y nunca lleva ruta, consulta, fragmento ni usuario: así el bucket de las
// peticiones es siempre `buoh-prueba`, y las claves no viajan sin cifrar.
//
// Cada ejecución escribe bajo un prefijo nuevo, `comprobaciones/<id>/`, y al terminar borra lo que
// escribió. La cuarta comprobación escribe bajo `bloqueo/<id>/`, que protege una regla de bloqueo de
// un día que el propietario pone en `buoh-prueba` sobre `bloqueo/` (desde el PR 6c de ADR-0018 §16).
// Con el cliente del worker (`S3ObjectStore.fromConfig`: sumas de comprobación solo cuando hacen
// falta, `WHEN_REQUIRED`, un solo intento y los plazos de `data:health`, 5 s por conexión y 10 s
// hasta las cabeceras), comprueba en orden:
//
// 1. `sin_sobrescribir`: con un objeto ya escrito, `writeVerified` con otros bytes en la misma clave
//    recibe 412 (`putIfAbsent` da `exists`), falla al releerlos, y el objeto sigue con los suyos;
// 2. `lectura_tras_escritura`: un objeto recién escrito se lee enseguida con los mismos bytes, y
//    `HeadObject` da su tamaño;
// 3. `sumas_de_comprobacion`: un objeto de 1 MiB de bytes aleatorios se escribe y se lee igual;
// 4. `con_bloqueo`: con un objeto ya escrito bajo la regla, R2 responde a otra escritura condicional
//    en esa clave con 409 `ObjectLockedByBucketPolicy` (con 412, la regla no está:
//    `lock_rule_missing`); `writeVerified` acepta los mismos bytes, como al guardar otra vez el
//    esquema de fuente, y rechaza otros; R2 también rechaza borrarlo con 409, y el objeto sigue con
//    sus bytes.
//
// Si las cuatro no terminan en 60 s, cierra los clientes del worker, lo que corta una lectura
// detenida, y las que faltan fallan con `deadline_exceeded`; borra igual lo escrito, con su propio
// cliente. El objeto de la cuarta no se puede borrar mientras la regla lo proteja.
//
// stdout lleva una sola línea JSON saneada: `endpoint` (`r2` o `local`, nunca la dirección, que tiene
// el ID de la cuenta), `bucket`, `started_at_utc`, cada comprobación con `pass` o `fail` (y su motivo,
// un código, nunca un mensaje), `cleanup` (`complete`, o `incomplete` si algún borrado de
// `comprobaciones/<id>/` falló), `locked_left` (los objetos de `bloqueo/<id>/` que no se pudieron
// borrar: 1 con la regla puesta) y `status`. Nunca lleva las claves. Salida 0 si pasan las cuatro, 1
// si alguna falla y 2 con variables inválidas, sin abrir ninguna conexión.
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
const { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } =
  requireFromWorker('@aws-sdk/client-s3');

/** El único bucket en el que escribe: el de prueba de ADR-0018 §10. */
const TEST_BUCKET = 'buoh-prueba';
/** El prefijo de la regla de bloqueo de prueba, que pone el propietario (runbook). */
const LOCK_PREFIX = 'bloqueo/';
/** El código con el que R2 rechaza, con 409, cambiar o borrar una clave protegida por la regla. */
const LOCK_CODE = 'ObjectLockedByBucketPolicy';
/** El endpoint de una cuenta de R2 sin jurisdicción: el ID de la cuenta son 32 cifras hex. */
const R2_HOST = /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/u;
/** Los plazos de cada conexión y de la espera de las cabeceras, los de `data:health`. */
const TIMEOUTS = { connectionTimeout: 5_000, requestTimeout: 10_000 };
/** El plazo de las tres comprobaciones juntas. */
const DEADLINE_MS = 60_000;

/** `r2` o `local` si el endpoint es uno de los admitidos, o `null`. */
function endpointKind(endpoint) {
  if (endpoint === undefined || !URL.canParse(endpoint)) {
    return null;
  }
  const url = new URL(endpoint);
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  if (url.protocol === 'https:' && url.port === '' && R2_HOST.test(url.hostname)) {
    return 'r2';
  }
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
    return 'local';
  }
  return null;
}

/**
 * La configuración del token `prueba` en `env`, o la lista de variables inválidas, nunca sus
 * valores. Solo admite el bucket `buoh-prueba` y los endpoints de `endpointKind`.
 */
function testConfig(env) {
  const rejected = [];
  const kind = endpointKind(env.BUOH_PRUEBA_S3_ENDPOINT);
  if (kind === null) {
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
      endpoint: env.BUOH_PRUEBA_S3_ENDPOINT,
      region,
      secretAccessKey: env.BUOH_PRUEBA_S3_SECRET_ACCESS_KEY,
    },
    kind,
  };
}

const sameBytes = (left, right) => Buffer.from(left).equals(Buffer.from(right));

/** Si un error del SDK es el rechazo de la regla de bloqueo: 409 con `ObjectLockedByBucketPolicy`. */
const isLocked = (error) => error?.$metadata?.httpStatusCode === 409 && error?.name === LOCK_CODE;

/** Lo que dio una petición que debía fallar: `null` si no falló, o su error. */
const rejectionOf = (promise) =>
  promise.then(
    () => null,
    (error) => error,
  );

/**
 * Las cuatro comprobaciones de ADR-0018 §10, con los almacenes y el cliente bajo `prefix` y, la
 * cuarta, bajo `lockPrefix`. Al terminar, de cualquier forma, borra lo escrito con `client`, y dice
 * si lo borró todo y cuántos objetos de la regla quedan.
 */
async function runChecks({ client, config, lockPrefix, lockStore, prefix, store }) {
  const written = [];
  const lockedWritten = [];
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    store.destroy();
    lockStore.destroy();
  }, DEADLINE_MS);
  /** Corre una comprobación: `pass`, o `fail` con el motivo saneado de lo que la hizo fallar. */
  const check = async (name, work) => {
    if (expired) {
      return { name, reason: 'deadline_exceeded', status: 'fail' };
    }
    try {
      const reason = await work();
      return reason === null ? { name, status: 'pass' } : { name, reason, status: 'fail' };
    } catch (error) {
      return { name, reason: expired ? 'deadline_exceeded' : failureReason(error), status: 'fail' };
    }
  };
  const put = async (key, bytes) => {
    written.push(key);
    return store.putIfAbsent(key, bytes, 'application/octet-stream');
  };
  const checks = [];
  let cleanup = 'complete';
  let lockedLeft = 0;
  try {
    checks.push(
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
    checks.push(
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
    checks.push(
      await check('sumas_de_comprobacion', async () => {
        const bytes = randomBytes(1024 * 1024);
        if ((await put('sumas-de-comprobacion', bytes)) !== 'created') {
          return 'write_not_created';
        }
        const read = await store.get('sumas-de-comprobacion', bytes.byteLength);
        return sameBytes(read, bytes) ? null : 'read_mismatch';
      }),
    );
    checks.push(
      await check('con_bloqueo', async () => {
        const original = randomBytes(64);
        lockedWritten.push('objeto');
        if (
          (await lockStore.putIfAbsent('objeto', original, 'application/octet-stream')) !==
          'created'
        ) {
          return 'first_write_not_created';
        }
        // La respuesta de R2 tal cual, sin el worker de por medio.
        const rewrite = await rejectionOf(
          client.send(
            new PutObjectCommand({
              Body: randomBytes(64),
              Bucket: config.bucket,
              IfNoneMatch: '*',
              Key: `${lockPrefix}objeto`,
            }),
          ),
        );
        if (rewrite === null) {
          return 'second_write_not_rejected';
        }
        if (!isLocked(rewrite)) {
          return rewrite.$metadata?.httpStatusCode === 412
            ? 'lock_rule_missing'
            : failureReason(rewrite);
        }
        // Los mismos bytes cuentan como escritos, como al guardar otra vez el esquema de fuente.
        const same = await writeVerified(
          lockStore,
          'objeto',
          original,
          'application/octet-stream',
        ).then(
          () => 'accepted',
          (error) => failureReason(error),
        );
        if (same !== 'accepted') {
          return `same_bytes_${same}`;
        }
        const other = await writeVerified(
          lockStore,
          'objeto',
          randomBytes(64),
          'application/octet-stream',
        ).then(
          () => 'accepted',
          (error) => failureReason(error),
        );
        if (other !== 'object_verification_failed') {
          return `other_bytes_${other}`;
        }
        // Con un token de escritura, como uno filtrado, borrarlo también se rechaza.
        const deletion = await rejectionOf(
          client.send(
            new DeleteObjectCommand({ Bucket: config.bucket, Key: `${lockPrefix}objeto` }),
          ),
        );
        if (deletion === null) {
          return 'delete_not_blocked';
        }
        if (!isLocked(deletion)) {
          return failureReason(deletion);
        }
        const kept = await lockStore.get('objeto', original.byteLength);
        return sameBytes(kept, original) ? null : 'object_changed';
      }),
    );
  } finally {
    clearTimeout(timer);
    const remove = (key) =>
      client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).then(
        () => true,
        () => false,
      );
    for (const key of written) {
      if (!(await remove(`${prefix}${key}`))) {
        cleanup = 'incomplete';
      }
    }
    // Con la regla puesta, R2 no deja borrarlo: lo vacía el propietario al quitar la regla.
    for (const key of lockedWritten) {
      if (!(await remove(`${lockPrefix}${key}`))) {
        lockedLeft += 1;
      }
    }
  }
  return { checks, cleanup, lockedLeft };
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
  const { config, kind } = loaded;
  const id = randomUUID();
  const prefix = `comprobaciones/${id}/`;
  const lockPrefix = `${LOCK_PREFIX}${id}/`;
  const store = S3ObjectStore.fromConfig({ ...config, keyPrefix: prefix }, TIMEOUTS);
  const lockStore = S3ObjectStore.fromConfig({ ...config, keyPrefix: lockPrefix }, TIMEOUTS);
  const client = new S3Client({
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    region: config.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: { ...TIMEOUTS, throwOnRequestTimeout: true },
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    const startedAt = new Date().toISOString();
    const { checks, cleanup, lockedLeft } = await runChecks({
      client,
      config,
      lockPrefix,
      lockStore,
      prefix,
      store,
    });
    const status = checks.every((item) => item.status === 'pass') ? 'passed' : 'failed';
    process.stdout.write(
      `${JSON.stringify({
        bucket: config.bucket,
        checks,
        cleanup,
        endpoint: kind,
        locked_left: lockedLeft,
        started_at_utc: startedAt,
        status,
      })}\n`,
    );
    process.exitCode = status === 'passed' ? 0 : 1;
  } finally {
    store.destroy();
    lockStore.destroy();
    client.destroy();
  }
}

await main();
