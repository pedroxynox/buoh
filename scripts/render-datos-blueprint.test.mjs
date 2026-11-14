import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Blueprint del sistema de datos de producción (ADR-0018 §2 y §3): la base, `buoh-ingesta` y
// `buoh-operaciones`, sus planes, sus comandos y de dónde sale cada variable. El repositorio no tiene
// un lector de YAML, así que `parseBlueprint` lee el subconjunto que deja Prettier y rechaza el
// resto con su línea: la prueba nunca da por bueno un archivo que no entiende. Lo que el código
// espera (las variables de cada servicio y los tamaños de V8) se lee de las fuentes del worker.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/**
 * Lee el YAML de `render-datos.yaml`: mapas y listas por sangría, escalares simples o entre
 * comillas y bloques plegados (`>-`). Sin comentarios al final de una línea, anclas ni flujo.
 */
function parseBlueprint(text) {
  const lines = text
    .split('\n')
    .map((raw, index) => ({ number: index + 1, raw }))
    .filter(({ raw }) => raw.trim() !== '' && !/^\s*#/.test(raw));
  let at = 0;
  const indentOf = (line) => line.raw.length - line.raw.trimStart().length;
  const fail = (line, why) => {
    throw new Error(`render-datos.yaml:${String(line.number)}: ${why}`);
  };
  const KEY = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/;

  function scalar(value, line) {
    if (/^'(?:[^']|'')*'$/.test(value)) {
      return value.slice(1, -1).replaceAll("''", "'");
    }
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      return JSON.parse(value);
    }
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
    if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
      return Number(value);
    }
    if (/^[[\]{}&*!|>%@`'"]/.test(value) || / #|: /.test(value) || value.endsWith(':')) {
      fail(line, `valor que el lector no admite: ${value}`);
    }
    return value;
  }

  function folded(indent, line) {
    const parts = [];
    while (lines[at] !== undefined && indentOf(lines[at]) > indent) {
      parts.push(lines[at].raw.trim());
      at += 1;
    }
    if (parts.length === 0) {
      fail(line, 'bloque plegado vacío');
    }
    return parts.join(' ');
  }

  function nested(indent, line) {
    const next = lines[at];
    if (next === undefined || indentOf(next) <= indent) {
      fail(line, 'falta el bloque de la clave');
    }
    return next.raw.trimStart().startsWith('- ')
      ? sequence(indentOf(next))
      : mapping(indentOf(next), null);
  }

  function entry(result, indent, line, text) {
    const match = KEY.exec(text);
    if (match === null) {
      fail(line, `no es una clave: ${text}`);
    }
    const [, key, rest] = match;
    if (Object.hasOwn(result, key)) {
      fail(line, `clave repetida: ${key}`);
    }
    if (rest === undefined) {
      result[key] = nested(indent, line);
    } else if (rest === '>-') {
      result[key] = folded(indent, line);
    } else {
      result[key] = scalar(rest, line);
    }
  }

  function mapping(indent, first) {
    const result = {};
    if (first !== null) {
      entry(result, indent, first.line, first.text);
    }
    for (;;) {
      const line = lines[at];
      if (line === undefined || indentOf(line) < indent) {
        return result;
      }
      if (indentOf(line) > indent || line.raw.trimStart().startsWith('- ')) {
        fail(line, 'sangría o lista inesperada');
      }
      at += 1;
      entry(result, indent, line, line.raw.trimStart());
    }
  }

  function sequence(indent) {
    const result = [];
    for (;;) {
      const line = lines[at];
      if (line === undefined || indentOf(line) < indent) {
        return result;
      }
      const text = line.raw.trimStart();
      if (indentOf(line) > indent || !text.startsWith('- ')) {
        fail(line, 'se esperaba otro elemento de la lista');
      }
      at += 1;
      const content = text.slice(2);
      result.push(
        /^[A-Za-z][A-Za-z0-9_]*:(?: |$)/.test(content)
          ? mapping(indent + 2, { line, text: content })
          : scalar(content, line),
      );
    }
  }

  const document = mapping(0, null);
  if (at !== lines.length) {
    fail(lines[at], 'línea que el lector no entiende');
  }
  return document;
}

const blueprint = parseBlueprint(read('render-datos.yaml'));
const rootPackage = JSON.parse(read('package.json'));

/**
 * Las claves `BUOH_*` del primer `z.object({ … })` que sigue a `marker` en una fuente del worker, cada
 * una con el resto de su línea: su esquema, si cabe en ella.
 */
function schemaEntries(path, marker) {
  const source = read(path);
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${path} tiene ${marker}`);
  const body = source.slice(start, source.indexOf('\n});', start));
  return [...body.matchAll(/^ {2}(BUOH_[A-Z0-9_]+):(.*)$/gm)].map((match) => [
    match[1],
    match[2].trim(),
  ]);
}

const schemaKeys = (path, marker) => schemaEntries(path, marker).map(([key]) => key);

/** Los tamaños de V8 de una constante `<NAME>_NODE_FLAGS`, leídos de `src/node-flags.ts`. */
function nodeFlags(path, name) {
  const match = new RegExp(`${name} = \\[([^\\]]+)\\] as const;`).exec(read(path));
  assert.ok(match, `${path} define ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}
const workerNodeFlags = () =>
  nodeFlags('apps/market-data-worker/src/node-flags.ts', 'WORKER_NODE_FLAGS');
const apiNodeFlags = () => nodeFlags('apps/api/src/node-flags.ts', 'API_NODE_FLAGS');

/**
 * Los paquetes `packages/*` de los que depende un conjunto de apps, recursivo, ordenados: lo que un
 * servicio recompila además de sus apps. Como el escritorio (ADR-0010), sigue `dependencies` y
 * `devDependencies`, porque turbo compila también las de desarrollo del monorepo (`^build`).
 */
function packageDepsOf(appDirs) {
  const packages = new Set();
  const pending = appDirs.map((dir) => JSON.parse(read(`${dir}/package.json`)));
  while (pending.length > 0) {
    const manifest = pending.pop();
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]) {
      const match = /^@buoh\/(.+)$/.exec(name);
      if (
        match === null ||
        packages.has(match[1]) ||
        !existsSync(join(root, `packages/${match[1]}`))
      ) {
        continue;
      }
      packages.add(match[1]);
      pending.push(JSON.parse(read(`packages/${match[1]}/package.json`)));
    }
  }
  return [...packages].sort().map((name) => `packages/${name}`);
}

/** El `buildFilter` que espera un servicio que compila `appDirs`: sus apps, sus paquetes y la raíz. */
function expectedBuildFilter(appDirs) {
  const deps = packageDepsOf(appDirs);
  return {
    paths: [
      ...appDirs.map((dir) => `${dir}/**`),
      ...deps.map((dir) => `${dir}/**`),
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.node-version',
      'tsconfig.base.json',
      'render-datos.yaml',
    ],
    ignoredPaths: [
      ...appDirs.flatMap((dir) =>
        existsSync(join(root, `${dir}/integration`))
          ? [`${dir}/test/**`, `${dir}/integration/**`]
          : [`${dir}/test/**`],
      ),
      ...deps.map((dir) => `${dir}/test/**`),
      '**/*.md',
    ],
  };
}

/**
 * Las apps que compila cada servicio, en el orden de su `buildFilter`. Desde F2.4, `buoh-api` compila
 * también el worker, del que lee por la ruta `@buoh/market-data-worker/lectura` (ADR-0019 §8).
 */
const SERVICE_APPS = {
  'buoh-ingesta': ['apps/market-data-worker'],
  'buoh-operaciones': ['apps/market-data-worker', 'apps/api'],
  'buoh-api': ['apps/api', 'apps/web', 'apps/market-data-worker'],
};

/**
 * Las apps de `apps/*` de las que dependen las de un servicio, recursivo, ordenadas: como
 * `packageDepsOf`, pero para una app que importa otra, como la API al worker.
 */
function appDepsOf(appDirs) {
  const apps = new Set();
  const pending = [...appDirs];
  while (pending.length > 0) {
    const manifest = JSON.parse(read(`${pending.pop()}/package.json`));
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]) {
      const match = /^@buoh\/(.+)$/.exec(name);
      const dir = match === null ? null : `apps/${match[1]}`;
      if (dir === null || apps.has(dir) || !existsSync(join(root, dir))) {
        continue;
      }
      apps.add(dir);
      pending.push(dir);
    }
  }
  return [...apps].sort();
}

const service = (name) => {
  const found = blueprint.services.filter((item) => item.name === name);
  assert.equal(found.length, 1, `${name} definido una vez`);
  return found[0];
};
const variables = (name) => new Map(service(name).envVars.map((item) => [item.key, item]));

test('define la base, buoh-ingesta, buoh-operaciones y buoh-api, y nada más (ADR-0018 §2; ADR-0019 §10)', () => {
  assert.deepEqual(Object.keys(blueprint).sort(), ['databases', 'services']);
  assert.deepEqual(
    blueprint.databases.map((item) => item.name),
    ['buoh-postgres'],
  );
  assert.deepEqual(
    blueprint.services.map((item) => [item.type, item.name]),
    [
      ['worker', 'buoh-ingesta'],
      ['cron', 'buoh-operaciones'],
      ['web', 'buoh-api'],
    ],
  );
});

test('la base: Basic-256mb con 1 GB, PostgreSQL 18, sin autoescalado, en virginia y abierta a internet (§1, §2 y §9)', () => {
  const [database] = blueprint.databases;
  // Lista cerrada: réplicas, alta disponibilidad o un pool cambiarían el costo o el acceso.
  assert.deepEqual(Object.keys(database).sort(), [
    'databaseName',
    'diskSizeGB',
    'ipAllowList',
    'name',
    'plan',
    'postgresMajorVersion',
    'region',
    'storageAutoscalingEnabled',
    'user',
  ]);
  assert.equal(database.plan, '0.1c-256mb');
  assert.equal(database.diskSizeGB, 1);
  assert.equal(database.storageAutoscalingEnabled, false);
  assert.equal(database.region, 'virginia');
  assert.equal(database.postgresMajorVersion, '18');
  assert.equal(database.databaseName, 'buoh');
  assert.equal(database.user, 'buoh');
  assert.deepEqual(
    database.ipAllowList.map((item) => item.source),
    ['0.0.0.0/0'],
  );
});

test('los tres servicios: Node, Starter, en virginia, sin disco y desplegados tras CI (§1 y §2; ADR-0019 §10)', () => {
  const common = [
    'autoDeployTrigger',
    'buildCommand',
    'buildFilter',
    'envVars',
    'name',
    'plan',
    'region',
    'runtime',
    'startCommand',
    'type',
  ];
  // Listas cerradas: un disco quitaría el despliegue sin corte, y `preDeployCommand` daría al
  // servicio las credenciales del rol dueño (ADR-0018, «Alternativas descartadas»).
  assert.deepEqual(
    Object.keys(service('buoh-ingesta')).sort(),
    [...common, 'maxShutdownDelaySeconds', 'numInstances'].sort(),
  );
  assert.deepEqual(Object.keys(service('buoh-operaciones')).sort(), [...common, 'schedule'].sort());
  assert.deepEqual(
    Object.keys(service('buoh-api')).sort(),
    [...common, 'healthCheckPath', 'numInstances'].sort(),
  );
  for (const item of blueprint.services) {
    assert.equal(item.runtime, 'node', item.name);
    assert.equal(item.plan, '0.5c-512mb', item.name);
    assert.equal(item.region, 'virginia', item.name);
    assert.equal(item.autoDeployTrigger, 'checksPass', item.name);
  }
  // Una sola instancia, y el minuto de parada antes de SIGKILL.
  assert.equal(service('buoh-ingesta').numInstances, 1);
  assert.equal(service('buoh-ingesta').maxShutdownDelaySeconds, 60);
  assert.equal(service('buoh-operaciones').schedule, '*/5 * * * *');
  // La API: una instancia (sesiones y límites en memoria) y su ruta de salud (ADR-0019 §7 y §10).
  assert.equal(service('buoh-api').numInstances, 1);
  assert.equal(service('buoh-api').healthCheckPath, '/api/salud');
});

test('cada servicio compila sus apps y paquetes con el Node y el pnpm fijados', () => {
  const pnpm = rootPackage.packageManager;
  assert.match(pnpm, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(read('.node-version').trim(), rootPackage.engines.node);
  const build = (...filters) => {
    const spec = filters.map((name) => `--filter "${name}..."`).join(' ');
    return `npx --yes ${pnpm} install --frozen-lockfile ${spec} && npx --yes ${pnpm} ${spec} run build`;
  };
  assert.equal(service('buoh-ingesta').buildCommand, build('@buoh/market-data-worker'));
  // buoh-operaciones compila también la API, que migra en su paso 1 (ADR-0019 §7 y §14).
  assert.equal(
    service('buoh-operaciones').buildCommand,
    build('@buoh/market-data-worker', '@buoh/api'),
  );
  // buoh-api compila la API y la web que sirve (ADR-0019 §9 y §10).
  assert.equal(service('buoh-api').buildCommand, build('@buoh/api', '@buoh/web'));
});

test('arrancan con Node directamente y sus tamaños de V8 delante, sin pnpm (ADR-0018 §3; ADR-0019 §10)', () => {
  const workerFlags = workerNodeFlags();
  assert.deepEqual(workerFlags, ['--max-semi-space-size=1', '--max-old-space-size=256']);
  const worker = (cli, args = '') =>
    `node ${workerFlags.join(' ')} apps/market-data-worker/dist/cli/${cli}.js${args}`;
  assert.equal(service('buoh-ingesta').startCommand, worker('ingest', ' --live --symbol R_100'));
  assert.equal(service('buoh-operaciones').startCommand, worker('operations'));
  const apiFlags = apiNodeFlags();
  assert.deepEqual(apiFlags, ['--max-semi-space-size=1', '--max-old-space-size=256']);
  assert.equal(
    service('buoh-api').startCommand,
    `node ${apiFlags.join(' ')} apps/api/dist/cli/serve.js`,
  );
  for (const cli of ['ingest', 'operations']) {
    assert.ok(existsSync(join(root, `apps/market-data-worker/src/cli/${cli}.ts`)), cli);
  }
  assert.ok(existsSync(join(root, 'apps/api/src/cli/serve.ts')));
});

test('cada servicio recompila cuando cambian sus apps o un paquete del que dependen', () => {
  // La raíz de los paquetes del worker no cambia: contracts y domain (ancla del resto).
  assert.deepEqual(packageDepsOf(['apps/market-data-worker']), [
    'packages/contracts',
    'packages/domain',
  ]);
  for (const item of blueprint.services) {
    const expected = expectedBuildFilter(SERVICE_APPS[item.name]);
    assert.deepEqual(Object.keys(item.buildFilter).sort(), ['ignoredPaths', 'paths'], item.name);
    assert.deepEqual(item.buildFilter.paths, expected.paths, item.name);
    assert.deepEqual(item.buildFilter.ignoredPaths, expected.ignoredPaths, item.name);
  }
});

test('cada servicio incluye las apps de las que dependen las suyas: si no, un cambio en ellas no lo desplegaría', () => {
  assert.deepEqual(appDepsOf(['apps/api']), ['apps/market-data-worker']);
  assert.deepEqual(appDepsOf(['apps/market-data-worker']), []);
  for (const [name, apps] of Object.entries(SERVICE_APPS)) {
    for (const dep of appDepsOf(apps)) {
      assert.ok(apps.includes(dep), `${name}: falta ${dep}`);
    }
  }
});

/** De dónde sale una variable: `value`, `sync: false`, `generateValue`, `fromDatabase` o `fromService`. */
function sourceOf(variable) {
  const sources = Object.keys(variable).filter((key) => key !== 'key');
  assert.equal(sources.length, 1, `${variable.key}: una sola fuente`);
  const [source] = sources;
  if (source === 'sync') {
    assert.equal(variable.sync, false, variable.key);
  }
  if (source === 'generateValue') {
    assert.equal(variable.generateValue, true, variable.key);
  }
  return source;
}

/** Una credencial o la dirección de la cuenta de R2: nunca su valor en el archivo (§2 y §12). */
const SECRET = /(PASSWORD|SECRET|ACCESS_KEY|ENDPOINT)/;

test('buoh-ingesta: las variables de ingest en production, con buoh_ingesta y el token ingesta (§4, §8, §9 y §10)', () => {
  const expected = [
    ...schemaKeys('apps/market-data-worker/src/config.ts', 'const postgresEnvironmentSchema'),
    ...schemaKeys('apps/market-data-worker/src/config.ts', 'const environmentSchema'),
  ].filter((key) => key !== 'BUOH_POSTGRES_SCHEMA');
  const vars = variables('buoh-ingesta');
  assert.equal(vars.size, service('buoh-ingesta').envVars.length, 'sin claves repetidas');
  assert.deepEqual([...vars.keys()].sort(), expected.sort());
  // En production, el esquema sale del log activo (ADR-0018 §4).
  assert.ok(!vars.has('BUOH_POSTGRES_SCHEMA'));
  const values = Object.fromEntries(
    [...vars.values()].filter((item) => 'value' in item).map((item) => [item.key, item.value]),
  );
  assert.deepEqual(values, {
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_SSLMODE: 'require',
    BUOH_POSTGRES_USER: 'buoh_ingesta',
    BUOH_S3_BUCKET: 'buoh-captura',
    BUOH_S3_REGION: 'auto',
  });
  assert.equal(sourceOf(vars.get('BUOH_POSTGRES_PASSWORD')), 'generateValue');
  for (const [key, property] of [
    ['BUOH_POSTGRES_HOST', 'host'],
    ['BUOH_POSTGRES_PORT', 'port'],
    ['BUOH_POSTGRES_DB', 'database'],
  ]) {
    assert.deepEqual(vars.get(key).fromDatabase, { name: 'buoh-postgres', property }, key);
  }
  for (const key of ['BUOH_S3_ENDPOINT', 'BUOH_S3_ACCESS_KEY_ID', 'BUOH_S3_SECRET_ACCESS_KEY']) {
    assert.equal(sourceOf(vars.get(key)), 'sync', key);
  }
});

test('buoh-operaciones: las variables de loadOperationsConfig, con la credencial dueña y sin ninguna BUOH_POSTGRES_* ni BUOH_S3_* (§8, §10, §11 y §12)', () => {
  const expected = schemaKeys(
    'apps/market-data-worker/src/operations/config.ts',
    'const operationsEnvironmentSchema',
  );
  const vars = variables('buoh-operaciones');
  assert.equal(vars.size, service('buoh-operaciones').envVars.length, 'sin claves repetidas');
  assert.deepEqual([...vars.keys()].sort(), expected.sort());
  // El servicio no tiene ninguna variable con los nombres `BUOH_POSTGRES_*` ni `BUOH_S3_*` que lee
  // el worker; la contraseña de `buoh_api` (`BUOH_API_POSTGRES_PASSWORD`) no coincide con ese patrón.
  for (const key of vars.keys()) {
    assert.doesNotMatch(key, /^BUOH_(?:POSTGRES|S3)_/, key);
  }
  for (const [key, property] of [
    ['BUOH_DUENO_POSTGRES_HOST', 'host'],
    ['BUOH_DUENO_POSTGRES_PORT', 'port'],
    ['BUOH_DUENO_POSTGRES_DB', 'database'],
    ['BUOH_DUENO_POSTGRES_USER', 'user'],
    ['BUOH_DUENO_POSTGRES_PASSWORD', 'password'],
  ]) {
    assert.deepEqual(vars.get(key).fromDatabase, { name: 'buoh-postgres', property }, key);
  }
  // La contraseña de buoh_ingesta es la que Render genera para buoh-ingesta (§8).
  assert.deepEqual(vars.get('BUOH_INGESTA_POSTGRES_PASSWORD').fromService, {
    envVarKey: 'BUOH_POSTGRES_PASSWORD',
    name: 'buoh-ingesta',
    type: 'worker',
  });
  // La contraseña de buoh_api es la que Render genera para buoh-api (ADR-0019 §7 y §14, PR 6).
  assert.deepEqual(vars.get('BUOH_API_POSTGRES_PASSWORD').fromService, {
    envVarKey: 'BUOH_POSTGRES_PASSWORD',
    name: 'buoh-api',
    type: 'web',
  });
  // Y la de buoh_api_lectura, la que Render genera para buoh-api con su propio nombre (ADR-0019 §8).
  assert.deepEqual(vars.get('BUOH_API_LECTURA_POSTGRES_PASSWORD').fromService, {
    envVarKey: 'BUOH_API_LECTURA_POSTGRES_PASSWORD',
    name: 'buoh-api',
    type: 'web',
  });
  assert.equal(
    sourceOf(variables('buoh-api').get('BUOH_API_LECTURA_POSTGRES_PASSWORD')),
    'generateValue',
  );
  assert.equal(sourceOf(variables('buoh-ingesta').get('BUOH_POSTGRES_PASSWORD')), 'generateValue');
  for (const key of [
    'BUOH_SALUD_POSTGRES_PASSWORD',
    'BUOH_AGENTE_POSTGRES_PASSWORD',
    'BUOH_PUBLICACION_POSTGRES_PASSWORD',
  ]) {
    assert.equal(sourceOf(vars.get(key)), 'generateValue', key);
  }
  for (const token of ['SALUD', 'OPERACIONES']) {
    for (const part of ['ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
      assert.equal(sourceOf(vars.get(`BUOH_${token}_S3_${part}`)), 'sync', `${token} ${part}`);
    }
    assert.equal(vars.get(`BUOH_${token}_S3_BUCKET`).value, 'buoh-captura');
    assert.equal(vars.get(`BUOH_${token}_S3_REGION`).value, 'auto');
  }
  assert.equal(vars.get('BUOH_DEPLOYMENT_ENVIRONMENT').value, 'production');
  assert.equal(vars.get('BUOH_DUENO_POSTGRES_SSLMODE').value, 'require');
});

test('buoh-api: las variables de la API en production, con buoh_api, la contraseña de buoh_api_lectura, el token api y las tres claves (ADR-0019 §8 y §10)', () => {
  const vars = variables('buoh-api');
  assert.equal(vars.size, service('buoh-api').envVars.length, 'sin claves repetidas');
  assert.deepEqual([...vars.keys()].sort(), [
    'BUOH_API_LECTURA_POSTGRES_PASSWORD',
    'BUOH_API_ORIGIN',
    'BUOH_API_PASSWORD_PEPPER',
    'BUOH_API_S3_ACCESS_KEY_ID',
    'BUOH_API_S3_BUCKET',
    'BUOH_API_S3_ENDPOINT',
    'BUOH_API_S3_REGION',
    'BUOH_API_S3_SECRET_ACCESS_KEY',
    'BUOH_API_TOKEN_KEY',
    'BUOH_API_TOTP_KEY',
    'BUOH_DEPLOYMENT_ENVIRONMENT',
    'BUOH_POSTGRES_DB',
    'BUOH_POSTGRES_HOST',
    'BUOH_POSTGRES_PASSWORD',
    'BUOH_POSTGRES_PORT',
    'BUOH_POSTGRES_SSLMODE',
    'BUOH_POSTGRES_USER',
  ]);
  const values = Object.fromEntries(
    [...vars.values()].filter((item) => 'value' in item).map((item) => [item.key, item.value]),
  );
  assert.deepEqual(values, {
    BUOH_API_ORIGIN: 'https://buoh-api.onrender.com',
    BUOH_API_S3_BUCKET: 'buoh-captura',
    BUOH_API_S3_REGION: 'auto',
    BUOH_DEPLOYMENT_ENVIRONMENT: 'production',
    BUOH_POSTGRES_SSLMODE: 'require',
    BUOH_POSTGRES_USER: 'buoh_api',
  });
  // El endpoint y las claves del token api los pega el propietario (`sync: false`, ADR-0019 §8).
  for (const part of ['ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
    assert.equal(sourceOf(vars.get(`BUOH_API_S3_${part}`)), 'sync', part);
  }
  for (const [key, property] of [
    ['BUOH_POSTGRES_HOST', 'host'],
    ['BUOH_POSTGRES_PORT', 'port'],
    ['BUOH_POSTGRES_DB', 'database'],
  ]) {
    assert.deepEqual(vars.get(key).fromDatabase, { name: 'buoh-postgres', property }, key);
  }
  // Las contraseñas de los dos roles y las tres claves del servidor las genera Render, fuera de la
  // base (§1, §2 y §8). El usuario de lectura no es una variable: siempre es buoh_api_lectura.
  assert.ok(!vars.has('BUOH_API_LECTURA_POSTGRES_USER'));
  for (const key of [
    'BUOH_POSTGRES_PASSWORD',
    'BUOH_API_LECTURA_POSTGRES_PASSWORD',
    'BUOH_API_PASSWORD_PEPPER',
    'BUOH_API_TOTP_KEY',
    'BUOH_API_TOKEN_KEY',
  ]) {
    assert.equal(sourceOf(vars.get(key)), 'generateValue', key);
  }
});

test('ninguna contraseña, token ni endpoint de la cuenta lleva su valor en el archivo (§2 y §12)', () => {
  const allowed = new Set(['sync', 'generateValue', 'fromDatabase', 'fromService']);
  for (const item of blueprint.services) {
    for (const variable of item.envVars) {
      const source = sourceOf(variable);
      if (SECRET.test(variable.key)) {
        assert.ok(allowed.has(source), `${item.name} ${variable.key}: ${source}`);
      }
      if ('fromDatabase' in variable) {
        assert.equal(variable.fromDatabase.name, 'buoh-postgres', variable.key);
      }
    }
  }
  // Tampoco fuera de las variables, ni en los comentarios, que el lector salta: ninguna dirección de
  // R2, nada con forma de ID de cuenta o clave de R2 (32 o 64 cifras hexadecimales), de valor de
  // `generateValue` (base64 de 256 bits) ni de URL de PostgreSQL con usuario y contraseña.
  const text = read('render-datos.yaml');
  assert.doesNotMatch(text, /r2\.cloudflarestorage\.com/);
  assert.doesNotMatch(text, /[0-9a-f]{32}/i);
  assert.doesNotMatch(text, /[A-Za-z0-9+/]{43}=/);
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\/[^\s/@]+:[^\s/@]+@/i);
});

test('el lector rechaza lo que no entiende, con su línea', () => {
  assert.throws(() => parseBlueprint('services:\n  - name: a # comentario\n'), /:2: valor/);
  assert.throws(() => parseBlueprint('a: 1\na: 2\n'), /:2: clave repetida/);
  assert.throws(() => parseBlueprint('a:\nb: 1\n'), /:1: falta el bloque/);
  assert.throws(() => parseBlueprint('a: {b: 1}\n'), /:1: valor/);
  assert.deepEqual(parseBlueprint("a:\n  - b: '*/5'\n    c: >-\n      x &&\n      y\n"), {
    a: [{ b: '*/5', c: 'x && y' }],
  });
});
