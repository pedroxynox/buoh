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
const workerPackage = JSON.parse(read('apps/market-data-worker/package.json'));

/** Las claves `BUOH_*` del primer `z.object({ … })` que sigue a `marker` en una fuente del worker. */
function schemaKeys(path, marker) {
  const source = read(path);
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${path} tiene ${marker}`);
  const body = source.slice(start, source.indexOf('\n});', start));
  return [...body.matchAll(/^ {2}(BUOH_[A-Z0-9_]+):/gm)].map((match) => match[1]);
}

/** Los tamaños de V8 de `WORKER_NODE_FLAGS`, leídos de `src/node-flags.ts`. */
function workerNodeFlags() {
  const match = /WORKER_NODE_FLAGS = \[([^\]]+)\] as const;/.exec(
    read('apps/market-data-worker/src/node-flags.ts'),
  );
  assert.ok(match, 'node-flags.ts define WORKER_NODE_FLAGS');
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

const service = (name) => {
  const found = blueprint.services.filter((item) => item.name === name);
  assert.equal(found.length, 1, `${name} definido una vez`);
  return found[0];
};
const variables = (name) => new Map(service(name).envVars.map((item) => [item.key, item]));

test('define la base, buoh-ingesta y buoh-operaciones, y nada más (ADR-0018 §2)', () => {
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

test('los dos servicios: Node, Starter, en virginia, sin disco y desplegados tras CI (§1 y §2)', () => {
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
  // worker las credenciales del rol dueño (ADR-0018, «Alternativas descartadas»).
  assert.deepEqual(
    Object.keys(service('buoh-ingesta')).sort(),
    [...common, 'maxShutdownDelaySeconds', 'numInstances'].sort(),
  );
  assert.deepEqual(Object.keys(service('buoh-operaciones')).sort(), [...common, 'schedule'].sort());
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
});

test('compilan el worker y sus paquetes con el Node y el pnpm fijados', () => {
  const pnpm = rootPackage.packageManager;
  assert.match(pnpm, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(read('.node-version').trim(), rootPackage.engines.node);
  const expected =
    `npx --yes ${pnpm} install --frozen-lockfile --filter "@buoh/market-data-worker..." && ` +
    `npx --yes ${pnpm} --filter "@buoh/market-data-worker..." run build`;
  for (const item of blueprint.services) {
    assert.equal(item.buildCommand, expected, item.name);
  }
});

test('arrancan con Node directamente y WORKER_NODE_FLAGS delante, sin pnpm (§3)', () => {
  const flags = workerNodeFlags();
  assert.deepEqual(flags, ['--max-semi-space-size=1', '--max-old-space-size=256']);
  const command = (cli, args = '') =>
    `node ${flags.join(' ')} apps/market-data-worker/dist/cli/${cli}.js${args}`;
  assert.equal(service('buoh-ingesta').startCommand, command('ingest', ' --live --symbol R_100'));
  assert.equal(service('buoh-operaciones').startCommand, command('operations'));
  for (const cli of ['ingest', 'operations']) {
    assert.ok(existsSync(join(root, `apps/market-data-worker/src/cli/${cli}.ts`)), cli);
  }
});

test('recompilan cuando cambia el worker o un paquete del que depende', () => {
  const workspaceDependencies = Object.keys(workerPackage.dependencies)
    .filter((name) => name.startsWith('@buoh/'))
    .map((name) => `packages/${name.slice('@buoh/'.length)}`);
  assert.deepEqual(workspaceDependencies.sort(), ['packages/contracts', 'packages/domain']);
  for (const item of blueprint.services) {
    assert.deepEqual(Object.keys(item.buildFilter).sort(), ['ignoredPaths', 'paths'], item.name);
    assert.deepEqual(item.buildFilter.paths, [
      'apps/market-data-worker/**',
      ...workspaceDependencies.map((path) => `${path}/**`),
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.node-version',
      'tsconfig.base.json',
      'render-datos.yaml',
    ]);
    assert.deepEqual(item.buildFilter.ignoredPaths, [
      'apps/market-data-worker/test/**',
      'apps/market-data-worker/integration/**',
      ...workspaceDependencies.map((path) => `${path}/test/**`),
      '**/*.md',
    ]);
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
  assert.equal(sourceOf(variables('buoh-ingesta').get('BUOH_POSTGRES_PASSWORD')), 'generateValue');
  for (const key of ['BUOH_SALUD_POSTGRES_PASSWORD', 'BUOH_AGENTE_POSTGRES_PASSWORD']) {
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
  // Tampoco fuera de las variables: el archivo no menciona ninguna dirección de R2.
  assert.doesNotMatch(read('render-datos.yaml'), /r2\.cloudflarestorage\.com/);
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
