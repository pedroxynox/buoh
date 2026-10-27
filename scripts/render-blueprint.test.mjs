import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Blueprint de Render (ADR-0013): un solo sitio estático gratuito, sin indexar y con sus cabeceras.
// El repositorio no tiene un lector de YAML, así que se comprueba el texto de `render.yaml` con el
// formato fijo que deja Prettier. Prettier no ordena las claves: por eso las pruebas cuentan los
// elementos de cada lista y comparan las claves con listas cerradas, en lugar de fiarse del orden.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blueprint = readFileSync(join(root, 'render.yaml'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sitePackage = JSON.parse(readFileSync(join(root, 'apps', 'site', 'package.json'), 'utf8'));

/** Valor de una clave del servicio, escrita como `    clave: valor`. */
function serviceValue(key) {
  return new RegExp(`^ {4}${key}: (.+)$`, 'm').exec(blueprint)?.[1];
}

/** Líneas que cuelgan de una clave del servicio (`    clave:`), con su sangría. */
function serviceBlock(key) {
  return new RegExp(`^ {4}${key}:\\n((?: {6}.*\\n?)+)`, 'm').exec(blueprint)?.[1] ?? '';
}

/** Claves con una sangría exacta dentro de un texto, en orden alfabético y con sus repeticiones. */
function keysAt(text, indent) {
  const pattern = new RegExp(`^ {${String(indent)}}([^\\s#-][^:\\n]*):`, 'gm');
  return [...text.matchAll(pattern)].map((match) => match[1]).sort();
}

/** Elementos de una lista de un bloque del servicio, por ejemplo los de `buildFilter.paths`. */
function listUnder(parent, key) {
  const pattern = new RegExp(`^ {6}${key}:\\n((?: {8}- .*\\n?)+)`, 'm');
  const list = pattern.exec(serviceBlock(parent))?.[1] ?? '';
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
  assert.deepEqual(keysAt(blueprint, 0), ['services']);
  // Cualquier otro servicio sería un elemento más de `services`, escriba primero la clave que sea.
  assert.equal([...blueprint.matchAll(/^ {2}- /gm)].length, 1, 'un solo servicio');
  assert.match(blueprint, /^ {2}- type: web$/m);
  assert.equal(serviceValue('runtime'), 'static');
  assert.equal(serviceValue('name'), 'buoh-sitio');
  // Lista cerrada: un `plan` haría el servicio de pago, y `domains` o `branch` cambiarían la
  // dirección o lo que se publica (ADR-0013 §2).
  assert.deepEqual(keysAt(blueprint, 4), [
    'autoDeployTrigger',
    'buildCommand',
    'buildFilter',
    'envVars',
    'headers',
    'name',
    'previews',
    'runtime',
    'staticPublishPath',
  ]);
  assert.doesNotMatch(blueprint, /^\s+plan:/m);
});

test('compila con el Node y el pnpm fijados, sin la instalación automática de Render', () => {
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
  // La única variable es la que impide que Render instale antes por su cuenta con npm o yarn.
  assert.equal(serviceBlock('envVars'), "      - key: SKIP_INSTALL_DEPS\n        value: 'true'\n");
});

test('despliega solo commits con CI en verde y sin vistas previas públicas', () => {
  assert.equal(serviceValue('autoDeployTrigger'), 'checksPass');
  assert.equal(serviceBlock('previews'), '      generation: off\n');
});

test('recompila cuando cambia el sitio o un paquete del que depende', () => {
  assert.deepEqual(keysAt(serviceBlock('buildFilter'), 6), ['ignoredPaths', 'paths']);
  const paths = listUnder('buildFilter', 'paths');
  assert.deepEqual(paths, [
    'apps/site/**',
    'packages/design-system/**',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.node-version',
    'tsconfig.base.json',
    'render.yaml',
  ]);
  // Un paquete nuevo de buoh en las dependencias del sitio también tiene que recompilarlo.
  const dependencies = Object.keys(sitePackage.dependencies).filter((name) =>
    name.startsWith('@buoh/'),
  );
  assert.ok(dependencies.length > 0);
  for (const name of dependencies) {
    const path = `packages/${name.slice('@buoh/'.length)}/**`;
    assert.ok(paths.includes(path), `buildFilter.paths incluye ${path}`);
  }
  assert.deepEqual(listUnder('buildFilter', 'ignoredPaths'), [
    'apps/site/test/**',
    'packages/design-system/test/**',
    '**/*.md',
  ]);
});

test('no se indexa y solo carga recursos del propio sitio (ADR-0013 §3 y §6)', () => {
  // Una regla escrita en otro orden no la vería headers(): se cuentan todas las de la lista.
  const items = [...serviceBlock('headers').matchAll(/^ {6}- /gm)].length;
  assert.equal(items, headers().length, 'cada cabecera escrita como path, name y value');
  const names = headers().map((item) => item.name);
  assert.deepEqual(names.sort(), [
    'Content-Security-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'X-Content-Type-Options',
    'X-Robots-Tag',
  ]);

  assert.equal(header('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(header('Referrer-Policy'), 'no-referrer');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(
    header('Permissions-Policy'),
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  );

  const directives = new Map(
    header('Content-Security-Policy')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...sources]) => [name, sources]),
  );
  for (const [name, expected] of [
    ['default-src', ["'self'"]],
    ['img-src', ["'self'"]],
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
        (source === "'unsafe-inline'" && name === 'script-src');
      assert.ok(allowed, `${name} no admite ${source}`);
    }
  }
});
