import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import {
  COMMON_SECURITY_HEADERS,
  htmlContentSecurityPolicy,
  IMMUTABLE_CACHE,
  NO_CACHE,
  STRICT_CONTENT_SECURITY_POLICY,
} from './headers.js';

/** Un archivo de la web exportada, con su ruta relativa a la raíz y sus cabeceras ya fijadas. */
export interface WebAsset {
  /** La ruta del archivo relativa a la raíz, con `/`, para `reply.sendFile`. */
  readonly relPath: string;
  /** Sus cabeceras: las comunes, la política de contenido (la del HTML o la estricta) y la caché. */
  readonly headers: Readonly<Record<string, string>>;
}

/** La web exportada (`apps/web/out-api`) que sirve la API: su raíz, el mapa de rutas y el 404. */
export interface WebAssets {
  readonly root: string;
  /** De la ruta de la petición (`/`, `/acceso/`, `/_next/...`) al archivo que la atiende. */
  readonly byPath: ReadonlyMap<string, WebAsset>;
  /** El cuerpo de las rutas que no existen: `404.html`, si la exportación lo trae. */
  readonly notFound: WebAsset | null;
}

/** El prefijo de los recursos con huella de contenido, que pueden cachearse como inmutables. */
const STATIC_PREFIX = `_next${posix.sep}static${posix.sep}`;

/**
 * El hash SHA-256 en base64 de cada script en línea (sin `src`) de un HTML, único y en orden de
 * aparición, para `script-src` (ADR-0019 §9). El hash se calcula sobre el texto exacto entre las
 * etiquetas, como lo hace el navegador.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    const attributes = match[1] ?? '';
    const content = match[2] ?? '';
    if (!/\bsrc\s*=/iu.test(attributes)) {
      hashes.add(createHash('sha256').update(content, 'utf8').digest('base64'));
    }
    match = pattern.exec(html);
  }
  return [...hashes];
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function headersFor(relPosix: string, html: string | null): Record<string, string> {
  if (html !== null) {
    return {
      ...COMMON_SECURITY_HEADERS,
      'cache-control': NO_CACHE,
      'content-security-policy': htmlContentSecurityPolicy(inlineScriptHashes(html)),
    };
  }
  // Los demás archivos llevan la política estricta, que estrecha la de §9: en un script o una hoja de
  // estilo que carga una página no cambia nada, y un SVG que se abre solo no puede ejecutar nada.
  const immutable = relPosix.startsWith(STATIC_PREFIX);
  return {
    ...COMMON_SECURITY_HEADERS,
    'cache-control': immutable ? IMMUTABLE_CACHE : NO_CACHE,
    'content-security-policy': STRICT_CONTENT_SECURITY_POLICY,
  };
}

/** Las rutas de petición que atiende un archivo: el HTML de sección, con y sin barra final. */
function urlPathsFor(relPosix: string): readonly string[] {
  if (relPosix === 'index.html') {
    return ['/'];
  }
  if (relPosix.endsWith('/index.html')) {
    const withSlash = `/${relPosix.slice(0, -'index.html'.length)}`;
    return [withSlash, withSlash.slice(0, -1)];
  }
  return [`/${relPosix}`];
}

/**
 * Lee la web exportada de `root` (apps/web/out-api) y precalcula las cabeceras de cada archivo
 * (ADR-0019 §9): el HTML con su política de contenido y los hashes de sus scripts en línea, y los
 * demás archivos con la política estricta; los recursos de `_next/static/` con caché inmutable y
 * los demás sin caché. Devuelve `null` si la
 * carpeta no existe, para que la API sirva solo el JSON.
 */
export function loadWebAssets(root: string): WebAssets | null {
  let files: readonly string[];
  try {
    if (!statSync(root).isDirectory()) {
      return null;
    }
    files = listFiles(root);
  } catch {
    return null;
  }
  const byPath = new Map<string, WebAsset>();
  let notFound: WebAsset | null = null;
  for (const file of files) {
    const relPosix = relative(root, file).split(sep).join(posix.sep);
    const html = relPosix.endsWith('.html') ? readFileSync(file, 'utf8') : null;
    const asset: WebAsset = { relPath: relPosix, headers: headersFor(relPosix, html) };
    if (relPosix === '404.html') {
      notFound = asset;
    }
    for (const urlPath of urlPathsFor(relPosix)) {
      byPath.set(urlPath, asset);
    }
  }
  return { root, byPath, notFound };
}
