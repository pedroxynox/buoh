import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob) {
  const doubleStarToken = '\u0000';
  const expression = escapeRegex(glob)
    .replaceAll('**', doubleStarToken)
    .replaceAll('*', '[^/]*')
    .replaceAll(doubleStarToken, '.*');

  return new RegExp(`^${expression}$`, 'u');
}

export function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

export function validateImpactMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('El mapa de impacto debe ser un objeto JSON.');
  }

  if (value.schema_version !== '1.0.0' || !Array.isArray(value.rules)) {
    throw new TypeError('El mapa requiere schema_version 1.0.0 y rules[].');
  }

  const identifiers = new Set();

  for (const rule of value.rules) {
    if (
      typeof rule !== 'object' ||
      rule === null ||
      typeof rule.id !== 'string' ||
      rule.id.length === 0 ||
      typeof rule.description !== 'string' ||
      !Array.isArray(rule.includes) ||
      rule.includes.length === 0 ||
      !rule.includes.every((pattern) => typeof pattern === 'string' && pattern.length > 0) ||
      !Array.isArray(rule.requires_any) ||
      rule.requires_any.length === 0 ||
      !rule.requires_any.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
    ) {
      throw new TypeError('Cada regla necesita id, description, includes[] y requires_any[].');
    }

    if (identifiers.has(rule.id)) {
      throw new TypeError(`ID de regla duplicado: ${rule.id}`);
    }

    identifiers.add(rule.id);
  }

  return value;
}

export function evaluateDocumentationImpact(changedFiles, map, acknowledgements = new Map()) {
  const files = [...new Set(changedFiles.map((file) => file.replaceAll('\\', '/')))].sort();
  const triggered = [];
  const violations = [];
  const acknowledged = [];

  for (const rule of map.rules) {
    const affectedFiles = files.filter((file) => matchesAny(file, rule.includes));
    if (affectedFiles.length === 0) {
      continue;
    }

    const reviewedFiles = files.filter((file) => matchesAny(file, rule.requires_any));
    const acknowledgement = acknowledgements.get(rule.id);
    const result = { affectedFiles, acknowledgement, reviewedFiles, rule };
    triggered.push(result);

    if (reviewedFiles.length === 0 && acknowledgement === undefined) {
      violations.push(result);
    } else if (reviewedFiles.length === 0) {
      acknowledged.push(result);
    }
  }

  return { acknowledged, files, triggered, violations };
}

function runGit(arguments_) {
  const output = execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function collectChangedFiles(baseReference) {
  if (baseReference !== undefined) {
    return runGit(['diff', '--name-only', '--diff-filter=ACMRDT', `${baseReference}...HEAD`]);
  }

  return [
    ...runGit(['diff', '--name-only', '--diff-filter=ACMRDT', '--cached']),
    ...runGit(['diff', '--name-only', '--diff-filter=ACMRDT']),
    ...runGit(['ls-files', '--others', '--exclude-standard']),
  ];
}

function parseBaseReference(arguments_) {
  const equalsArgument = arguments_.find((argument) => argument.startsWith('--base='));
  if (equalsArgument !== undefined) {
    return equalsArgument.slice('--base='.length);
  }

  const index = arguments_.indexOf('--base');
  if (index === -1) {
    return undefined;
  }

  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new TypeError('--base requiere una referencia Git.');
  }

  return value;
}

export function parseAcknowledgements(arguments_) {
  const acknowledgements = new Map();
  for (const argument of arguments_.filter((item) => item.startsWith('--acknowledge='))) {
    const value = argument.slice('--acknowledge='.length);
    const separator = value.indexOf(':');
    const id = value.slice(0, separator);
    const reason = value.slice(separator + 1).trim();
    if (separator < 1 || reason.length < 20) {
      throw new TypeError(
        '--acknowledge requiere rule-id:razón explícita de al menos 20 caracteres.',
      );
    }
    if (acknowledgements.has(id)) {
      throw new TypeError(`Acknowledgement duplicado: ${id}`);
    }
    acknowledgements.set(id, reason);
  }
  return acknowledgements;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const mapPath = resolve(repositoryRoot, 'docs/impact-map.json');
  const map = validateImpactMap(JSON.parse(await readFile(mapPath, 'utf8')));
  const acknowledgements = parseAcknowledgements(arguments_);
  for (const id of acknowledgements.keys()) {
    if (!map.rules.some((rule) => rule.id === id)) {
      throw new TypeError(`Acknowledgement para regla desconocida: ${id}`);
    }
  }

  let baseReference = parseBaseReference(arguments_);
  if (arguments_.includes('--require-base') && baseReference === undefined) {
    baseReference = process.env['DOCS_BASE_REF'];
    if (baseReference === undefined || baseReference.length === 0) {
      throw new TypeError('--require-base exige --base o DOCS_BASE_REF.');
    }
  }

  const result = evaluateDocumentationImpact(
    collectChangedFiles(baseReference),
    map,
    acknowledgements,
  );

  if (result.files.length === 0) {
    console.log('docs impact: sin cambios para evaluar');
    return;
  }

  for (const item of result.triggered) {
    const status =
      item.reviewedFiles.length > 0
        ? 'ok'
        : item.acknowledgement === undefined
          ? 'falta revisión'
          : 'justificado';
    console.log(`docs impact [${item.rule.id}]: ${status}`);
    console.log(`  cambios: ${item.affectedFiles.join(', ')}`);
    console.log(`  revisar uno de: ${item.rule.requires_any.join(', ')}`);
    if (item.acknowledgement !== undefined) {
      console.log(`  justificación para copiar al PR: ${item.acknowledgement}`);
    }
  }

  if (result.violations.length > 0) {
    console.error(
      'La documentación requerida no cambió. Actualiza la fuente canónica o justifica la excepción en un PR y ajusta el cambio antes de fusionar.',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
