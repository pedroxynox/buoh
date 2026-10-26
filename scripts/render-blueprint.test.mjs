import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Blueprint de Render (ADR-0013): un solo sitio estático gratuito, sin indexar y con sus cabeceras.
// El repositorio no tiene un lector de YAML, así que se comprueba el texto de `render.yaml` con el
// formato fijo que deja Prettier.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blueprint = readFileSync(join(root, 'render.yaml'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sitePackage = JSON.parse(readFileSync(join(root, 'apps', 'site', 'package.json'), 'utf8'));

/** Valor de una clave del servicio, escrita como `    clave: valor`. */
function serviceValue(key) {
  return new RegExp(`^    ${key}: (.+)$`, 'm').exec(blueprint)?.[1];
}

/** Elementos de una lista del servicio, por ejemplo los de `buildFilter.paths`. */
function listUnder(parent, key) {
  const block = new RegExp(`^    ${parent}:\\n((?:      .*\\n?)+)`, 'm').exec(blueprint)?.[1] ?? '';
  const list = new RegExp(`^      ${key}:\\n((?:        - .*\\n?)+)`, 'm').exec(block)?.[1] ?? '';
  return [...list.matchAll(/^ {8}- (.+)$/gm)].map((match) => match[1].replace(/^'(.*)'$/, '$1'));
}

/** Cabeceras declaradas, con las comillas del valor quitadas. */
function headers() {
  const pattern = /^ {6}- path: (.+)\n {8}name: (.+)\n {8}value: (.+)$/gm;
  return [...blueprint.matchAll(pattern)].map(([, path, name, value]) => ({
    name,
    path,
    value: value.replace(/^"(.*)"$/, '$1'),
  }));
}

function header(name) {
  const found = headers().filter((item) => item.name === name);
  assert.equal(found.length, 1, `${name} declarada una vez`);
  assert.equal(found[0].path, '/*', `${name} en todas las rutas`);
  return found[0].value;
}

test('solo define el sitio oficial, como sitio estático gratuito (ADR-0013 §1 y §8)', () => {
  assert.deepEqual(
    [...blueprint.matchAll(/^(\S[^:]*):/gm)].map((match) => match[1]),
    ['services'],
  );
  assert.equal([...blueprint.matchAll(/^ {2}- type: /gm)].length, 1);
  assert.match(blueprint, /^ {2}- type: web$/m);
  assert.equal(serviceValue('runtime'), 'static');
  assert.equal(serviceValue('name'), 'buoh-sitio');
  // Un sitio estático no tiene plan de cómputo: cualquier `plan` sería un servicio de pago.
  assert.doesNotMatch(blueprint, /^\s+plan:/m);
});

test('compila con el Node y el pnpm fijados, instalando solo el sitio', () => {
  const pnpm = rootPackage.packageManager;
  assert.match(pnpm, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(readFileSync(join(root, '.node-version'), 'utf8').trim(), rootPackage.engines.node);

  const command = /^ {4}buildCommand: >-\n((?: {6}.*\n)+)/m
    .exec(blueprint)?.[1]
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    command,
    `npx --yes ${pnpm} install --frozen-lockfile --filter "@buoh/site..." && ` +
      `npx --yes ${pnpm} --filter "@buoh/site..." run build`,
  );
  assert.equal(serviceValue('staticPublishPath'), 'apps/site/out');
});

test('despliega solo commits con CI en verde y sin vistas previas públicas', () => {
  assert.equal(serviceValue('autoDeployTrigger'), 'checksPass');
  assert.match(blueprint, /^ {4}previews:\n {6}generation: off$/m);
});

test('recompila cuando cambia el sitio o un paquete del que depende', () => {
  const paths = listUnder('buildFilter', 'paths');
  const dependencies = Object.keys(sitePackage.dependencies).filter((name) =>
    name.startsWith('@buoh/'),
  );
  assert.ok(dependencies.length > 0);
  for (const expected of [
    'apps/site/**',
    ...dependencies.map((name) => `packages/${name.slice('@buoh/'.length)}/**`),
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.node-version',
    'render.yaml',
  ]) {
    assert.ok(paths.includes(expected), `buildFilter.paths incluye ${expected}`);
  }
  assert.ok(listUnder('buildFilter', 'ignoredPaths').includes('apps/site/test/**'));
});

test('no se indexa y solo carga recursos del propio sitio (ADR-0013 §3 y §6)', () => {
  assert.equal(header('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(header('Referrer-Policy'), 'no-referrer');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.match(header('Permissions-Policy'), /camera=\(\).*geolocation=\(\).*microphone=\(\)/);

  const directives = new Map(
    header('Content-Security-Policy')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...sources]) => [name, sources]),
  );
  for (const [name, expected] of [
    ['default-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ]) {
    assert.deepEqual(directives.get(name), expected, name);
  }
  for (const [name, sources] of directives) {
    for (const source of sources) {
      const allowed =
        ["'self'", "'none'"].includes(source) ||
        (source === "'unsafe-inline'" && name === 'script-src') ||
        (source === 'data:' && name === 'img-src');
      assert.ok(allowed, `${name} no admite ${source}`);
    }
  }
});
