/**
 * Evidencia de V1-DESKTOP-001 que se comprueba sin Windows: la configuración de Tauri, las
 * versiones fijadas, el flujo de CI y que el prototipo web exportado funciona con la política de
 * contenido (CSP) de la ventana. El instalador y las pruebas de Rust se compilan en CI con Windows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(APP, 'src-tauri');
const ROOT = join(APP, '..', '..');
const WEB_OUT = join(ROOT, 'apps', 'web', 'out');
const read = (path: string) => readFileSync(path, 'utf8');

interface WindowConfig {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly url?: string;
}

interface TauriConfig {
  readonly productName: string;
  readonly version: string;
  readonly identifier: string;
  readonly build: Readonly<Record<string, unknown>> & { readonly frontendDist: string };
  readonly app: Readonly<Record<string, unknown>> & {
    readonly withGlobalTauri: boolean;
    readonly windows: readonly WindowConfig[];
    readonly security: Readonly<Record<string, unknown>> & {
      readonly csp: Readonly<Record<string, string>>;
      readonly freezePrototype: boolean;
      readonly capabilities: readonly unknown[];
      readonly assetProtocol: { readonly enable: boolean };
    };
  };
  readonly bundle: Readonly<Record<string, unknown>> & {
    readonly targets: readonly string[];
    readonly icon: readonly string[];
    readonly createUpdaterArtifacts: boolean;
    readonly windows: {
      readonly nsis: { readonly installMode: string; readonly languages: readonly string[] };
    };
  };
  readonly plugins: Readonly<Record<string, unknown>>;
}

const config = JSON.parse(read(join(TAURI, 'tauri.conf.json'))) as TauriConfig;
const cargoToml = read(join(TAURI, 'Cargo.toml'));
const cargoLock = read(join(TAURI, 'Cargo.lock'));
const rustSources = ['main.rs', 'navigation.rs'].map((file) => read(join(TAURI, 'src', file)));
const workflow = read(join(ROOT, '.github', 'workflows', 'desktop.yml'));

function filesUnder(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

/** Versión exacta (`=x.y.z`) de una dependencia en Cargo.toml. */
function pinnedCrate(name: string): string | undefined {
  return new RegExp(`^${name} = \\{ version = "=(\\d+\\.\\d+\\.\\d+)"`, 'm').exec(cargoToml)?.[1];
}

/** Versión resuelta de un paquete en Cargo.lock. */
function lockedCrate(name: string): string | undefined {
  return new RegExp(`^name = "${name}"\\nversion = "([^"]+)"`, 'm').exec(cargoLock)?.[1];
}

const minor = (version: string | undefined) => version?.split('.').slice(0, 2).join('.');

describe('prototipo de escritorio (V1-DESKTOP-001)', () => {
  it('la ventana muestra el prototipo web exportado, con su marca de datos ficticios', () => {
    expect(resolve(TAURI, config.build.frontendDist)).toBe(WEB_OUT);
    expect(config.build['devUrl']).toBeUndefined();
    expect(config.app.windows).toHaveLength(1);
    const [window] = config.app.windows;
    expect(window?.url).toBeUndefined();
    expect(window?.title).toMatch(/datos ficticios/);
    expect(config.productName).toBe('buoh');
    expect(config.identifier).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('la ventana nunca baja del ancho en que la web cambia a la barra inferior', () => {
    const concept = read(join(ROOT, 'docs', 'diseno', 'concepto-de-interfaz.md'));
    const breakpoint = /Por debajo de (\d+) px, la navegación pasa a una barra inferior/.exec(
      concept,
    )?.[1];
    expect(breakpoint).toMatch(/^\d+$/);
    for (const window of config.app.windows) {
      expect(window.minWidth).toBeGreaterThanOrEqual(Number(breakpoint));
      expect(window.width).toBeGreaterThanOrEqual(window.minWidth);
      expect(window.height).toBeGreaterThanOrEqual(window.minHeight);
    }
  });

  it('el frontend no tiene permisos, comandos ni complementos de Tauri', () => {
    const { security } = config.app;
    expect(config.app.withGlobalTauri).toBe(false);
    expect(security.capabilities).toEqual([]);
    expect(existsSync(join(TAURI, 'capabilities'))).toBe(false);
    expect(security.assetProtocol.enable).toBe(false);
    expect(security.freezePrototype).toBe(true);
    expect(security['dangerousDisableAssetCspModification']).toBeUndefined();
    expect(config.plugins).toEqual({});
    expect(cargoToml).not.toMatch(/tauri-plugin-/);
    // Sin `dynamic-acl`: nadie puede añadir permisos con la app en marcha.
    const tauriCrate = /^tauri = \{([^}]*)\}/m.exec(cargoToml)?.[1] ?? '';
    expect(tauriCrate).toContain('default-features = false');
    const features = [
      ...(/features = \[([^\]]*)\]/.exec(tauriCrate)?.[1] ?? '').matchAll(/"([^"]+)"/g),
    ];
    expect(features.map((match) => match[1]).sort()).toEqual([
      'common-controls-v6',
      'compression',
      'wry',
    ]);
    for (const source of rustSources) {
      expect(source).not.toMatch(/#\[tauri::command\]|invoke_handler/);
    }
    expect(rustSources[0]).toContain('.plugin(navigation::only_bundled_pages())');
  });

  it('la política de contenido solo deja cargar lo empaquetado', () => {
    const { csp } = config.app.security;
    const allowed: Readonly<Record<string, readonly string[]>> = {
      'img-src': ["'self'", 'data:'],
      // React escribe atributos `style`; los elementos <style> siguen limitados a lo empaquetado.
      'style-src-attr': ["'unsafe-inline'"],
    };
    for (const directive of ['default-src', 'script-src', 'style-src', 'connect-src']) {
      expect(csp[directive], directive).toBe("'self'");
    }
    for (const directive of ['object-src', 'frame-src', 'base-uri', 'form-action']) {
      expect(csp[directive], directive).toBe("'none'");
    }
    for (const [directive, value] of Object.entries(csp)) {
      for (const source of value.split(/\s+/)) {
        expect(allowed[directive] ?? ["'self'", "'none'"], `${directive}: ${source}`).toContain(
          source,
        );
      }
    }
  });

  it('el prototipo web exportado funciona con esa política', () => {
    expect(
      existsSync(WEB_OUT),
      'falta apps/web/out: ejecuta antes `pnpm --filter @buoh/web run build`',
    ).toBe(true);
    const pages = filesUnder(WEB_OUT, '.html');
    expect(pages.length).toBeGreaterThan(0);
    expect(read(join(WEB_OUT, 'index.html'))).toContain('Datos ficticios');
    for (const page of pages) {
      const html = read(page);
      // Tauri añade el hash de cada <script> en línea, pero no permite manejadores en atributos.
      expect(html, page).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(html, page).not.toMatch(/javascript:/i);
      expect(html, page).not.toMatch(/<(iframe|object|embed|form)\b/i);
      expect(html, page).not.toMatch(/\s(src|href|action)="(https?:)?\/\//i);
    }
    for (const sheet of filesUnder(WEB_OUT, '.css')) {
      expect(read(sheet), sheet).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
      expect(read(sheet), sheet).not.toMatch(/@import/i);
    }
  });

  it('el instalador es NSIS por usuario, en español y sin actualizaciones automáticas', () => {
    expect(config.bundle.targets).toEqual(['nsis']);
    expect(config.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(config.bundle.windows.nsis.languages).toEqual(['Spanish']);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.bundle['externalBin']).toBeUndefined();
    expect(config.bundle['resources']).toBeUndefined();
    for (const icon of config.bundle.icon) {
      expect(existsSync(join(TAURI, icon)), icon).toBe(true);
    }
    const ico = readFileSync(join(TAURI, 'icons', 'icon.ico'));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });

  it('las versiones de Rust, Tauri y su CLI están fijadas y concuerdan', () => {
    const toolchain = /^channel = "(\d+\.\d+\.\d+)"$/m.exec(
      read(join(TAURI, 'rust-toolchain.toml')),
    )?.[1];
    const msrv = /^rust-version = "(\d+\.\d+)"$/m.exec(cargoToml)?.[1];
    expect(toolchain).toBeDefined();
    expect(msrv).toBeDefined();
    const [major, minorVersion] = (toolchain ?? '').split('.').map(Number);
    const [msrvMajor, msrvMinor] = (msrv ?? '').split('.').map(Number);
    expect((major ?? 0) * 1000 + (minorVersion ?? 0)).toBeGreaterThanOrEqual(
      (msrvMajor ?? 0) * 1000 + (msrvMinor ?? 0),
    );
    for (const crate of ['tauri', 'tauri-build']) {
      expect(pinnedCrate(crate), crate).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lockedCrate(crate), crate).toBe(pinnedCrate(crate));
    }
    const pkg = JSON.parse(read(join(APP, 'package.json'))) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const cli = pkg.devDependencies['@tauri-apps/cli'];
    expect(cli).toMatch(/^\d+\.\d+\.\d+$/);
    expect(minor(cli)).toBe(minor(pinnedCrate('tauri')));
    expect(lockedCrate('buoh-desktop')).toBe(config.version);
  });

  it('CI compila el instalador en Windows con versiones bloqueadas y acciones fijadas', () => {
    expect(workflow).toMatch(/runs-on: windows-\d+/);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(workflow).toContain('--frozen-lockfile');
    expect(workflow).toContain('cargo fmt --check');
    expect(workflow).toContain('cargo clippy --locked --all-targets -- -D warnings');
    expect(workflow).toContain('cargo test --locked');
    expect(workflow).toContain('tauri build --ci -- --locked');
    expect(workflow).toContain('bundle/nsis/*-setup.exe');
    expect(workflow).toMatch(/retention-days: \d+/);
    for (const path of ["'apps/desktop/**'", "'apps/web/**'", "'packages/**'"]) {
      expect(workflow).toContain(path);
    }
  });
});
