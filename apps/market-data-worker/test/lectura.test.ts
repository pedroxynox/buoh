import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

// La ruta de exportación `@buoh/market-data-worker/lectura` (ADR-0019 §8): lo que leen del sistema
// de datos la API y el motor, sin cargar `ws`, `fflate` ni `node:child_process`. Se prueba sobre el
// JavaScript compilado, el que carga quien la importa: un proceso de Node aparte, con un entorno
// vacío, la importa por el nombre del paquete con un gancho de resolución (`module.registerHooks`)
// que anota la URL de cada módulo que se resuelve, por `import` o por `require`. La misma sonda, en
// otro proceso, con el punto de entrada principal, que sí los carga, demuestra que el gancho los ve.

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const LECTURA_JS = resolve(PACKAGE_ROOT, 'dist/lectura.js');
const LECTURA_DTS = resolve(PACKAGE_ROOT, 'dist/lectura.d.ts');

/** Importa el especificador de `argv[1]` y escribe en stdout lo que exporta y las URL resueltas. */
const PROBE = `
import { registerHooks } from 'node:module';
const urls = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    urls.add(resolved.url);
    return resolved;
  },
});
const loaded = await import(process.argv[1]);
process.stdout.write(JSON.stringify({ exports: Object.keys(loaded).sort(), urls: [...urls] }));
`;

interface Probe {
  readonly exports: readonly string[];
  readonly urls: readonly string[];
}

/** Importa `specifier` desde el paquete, en un proceso aparte y sin variables de entorno. */
function probe(specifier: string): Probe {
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', PROBE, specifier], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 60_000,
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Probe;
}

/** Los módulos que la ruta no puede cargar, por la URL que les da Node: únicos y ordenados. */
function forbidden(urls: readonly string[]): string[] {
  const names = urls.map((url) =>
    url === 'node:child_process' ? url : /\/node_modules\/(ws|fflate)\//u.exec(url)?.[1],
  );
  return [...new Set(names.filter((name) => name !== undefined))].sort();
}

describe('@buoh/market-data-worker/lectura (ADR-0019 §8)', () => {
  let lectura: Probe;
  let main: Probe;

  beforeAll(() => {
    expect(existsSync(LECTURA_JS), 'ejecuta antes pnpm run build').toBe(true);
    lectura = probe('@buoh/market-data-worker/lectura');
    main = probe('@buoh/market-data-worker');
  }, 120_000);

  it('importarla no carga ws, fflate ni node:child_process', () => {
    expect(lectura.urls).toContain(pathToFileURL(LECTURA_JS).href);
    expect(forbidden(lectura.urls)).toEqual([]);
  });

  it('el punto de entrada principal sí los carga, así que el gancho los ve', () => {
    expect(forbidden(main.urls)).toEqual(['fflate', 'node:child_process', 'ws']);
  });

  it('exporta lo que se lee: configuración, log activo, log, perfil, salud guardada, catálogo, registro, publicaciones y almacenes en memoria', () => {
    expect(lectura.exports).toEqual(
      expect.arrayContaining([
        // La configuración y los pools.
        'loadConfig',
        'createPool',
        'openStores',
        'S3ObjectStore',
        // La búsqueda del log activo.
        'findActiveLog',
        'locateActiveLog',
        'withLog',
        // El log y sus puntos de control.
        'SourceEventLog',
        'PostgresSourceLogStore',
        'LiveCheckpointLookup',
        'readLiveState',
        'foldSinceCheckpoint',
        // El perfil de medición.
        'createDerivMeasurementProfileFromSourceSchema',
        'DERIV_SCHEMA_RELEASE',
        'SOURCE_SCHEMA_ENTRY',
        // La salud que guardó buoh-operaciones.
        'parseStoredHealthObservation',
        'readLatestStoredHealth',
        'StoredHealthError',
        // El catálogo.
        'PostgresCatalogStore',
        // El registro operativo.
        'OperationalRegistry',
        'PostgresOperationalStore',
        // Las publicaciones y el replay.
        'PostgresMetadataStore',
        'replayDataset',
        // Los almacenes en memoria para las pruebas.
        'InMemoryCatalogStore',
        'InMemoryObjectStore',
        'InMemoryOperationalStore',
        'InMemorySourceLogStore',
      ]),
    );
  });

  it('no exporta lo que solo escribe: ni los roles, ni sus contraseñas, ni las migraciones, ni las operaciones', () => {
    for (const name of [
      'ensureApiReaderRole',
      'ensureApiRole',
      'ensureRuntimeRoles',
      'grantLogPrivileges',
      'setRolePassword',
      'migrate',
      'runOperations',
    ]) {
      expect(main.exports, name).toContain(name);
      expect(lectura.exports, name).not.toContain(name);
    }
  });

  it('el paquete la declara con su JavaScript y sus tipos compilados', () => {
    const { exports } = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(exports['./lectura']).toEqual({
      import: './dist/lectura.js',
      types: './dist/lectura.d.ts',
    });
    expect(existsSync(LECTURA_DTS)).toBe(true);
  });
});
