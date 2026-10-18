import { cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256Hex, validateMarketDataVectors } from '../src/index.js';

const sourceVectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');

interface FixtureManifest {
  expected: Record<string, unknown>;
  files: { bytes: number; path: string; sha256: string }[];
  profile: Record<string, unknown>;
}

async function withVectorCopy(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'buoh-vectors-'));
  const root = join(temporary, 'v1');
  await cp(sourceVectorRoot, root, { recursive: true });
  try {
    await run(root);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function readManifest(root: string): Promise<FixtureManifest> {
  return JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as FixtureManifest;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function updateManifestEntry(
  manifestRoot: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const manifest = await readManifest(manifestRoot);
  const entry = manifest.files.find((file) => file.path === relativePath);
  if (entry === undefined) {
    throw new TypeError(`Manifest sin ${relativePath}.`);
  }
  entry.bytes = bytes.byteLength;
  entry.sha256 = sha256Hex(bytes);
  await writeJson(join(manifestRoot, 'manifest.json'), manifest);
}

describe('seguridad e integridad del vector', () => {
  it('rechaza expectativas normativas contradictorias', async () => {
    await withVectorCopy(async (root) => {
      const manifest = await readManifest(root);
      manifest.expected['source_event_count'] = 999;
      await writeJson(join(root, 'manifest.json'), manifest);

      await expect(validateMarketDataVectors(root)).rejects.toThrow(/source_event_count/u);
    });
  });

  it('rechaza un perfil que contradice la procedencia', async () => {
    await withVectorCopy(async (root) => {
      const manifest = await readManifest(root);
      manifest.profile['source'] = 'otra_fuente';
      await writeJson(join(root, 'manifest.json'), manifest);

      await expect(validateMarketDataVectors(root)).rejects.toThrow(/perfil principal/u);
    });
  });

  it('rechaza estímulos principales desconocidos aunque actualicen su checksum', async () => {
    await withVectorCopy(async (root) => {
      const inputPath = join(root, 'input-frames.ndjson');
      const lines = (await readFile(inputPath, 'utf8')).trimEnd().split('\n');
      const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      first['kind'] = 'unknown_stimulus';
      lines[0] = JSON.stringify(first);
      const bytes = Buffer.from(`${lines.join('\n')}\n`);
      await writeFile(inputPath, bytes);
      await updateManifestEntry(root, 'input-frames.ndjson', bytes);

      await expect(validateMarketDataVectors(root)).rejects.toThrow();
    });
  });

  it('rechaza NDJSON inválido en el subvector aunque se vuelvan a firmar manifiestos', async () => {
    await withVectorCopy(async (root) => {
      const zeroRoot = join(root, 'zero-valid-ticks');
      const invalid = Buffer.from('not-json\n');
      await writeFile(join(zeroRoot, 'input.ndjson'), invalid);
      await updateManifestEntry(zeroRoot, 'input.ndjson', invalid);

      const nestedManifest = await readFile(join(zeroRoot, 'manifest.json'));
      await updateManifestEntry(root, 'zero-valid-ticks/manifest.json', nestedManifest);

      await expect(validateMarketDataVectors(root)).rejects.toThrow();
    });
  });

  it('rechaza rutas absolutas o que escapan vectorRoot', async () => {
    await withVectorCopy(async (root) => {
      const manifest = await readManifest(root);
      const first = manifest.files[0];
      if (first === undefined) {
        throw new TypeError('Manifest sin archivos.');
      }
      first.path = '/etc/passwd';
      await writeJson(join(root, 'manifest.json'), manifest);

      await expect(validateMarketDataVectors(root)).rejects.toThrow(/Ruta de vector/u);
    });
  });

  it('rechaza symlinks aunque apunten a un archivo existente', async () => {
    await withVectorCopy(async (root) => {
      const healthPath = join(root, 'expected-health.json');
      await unlink(healthPath);
      await symlink('/etc/passwd', healthPath);

      await expect(validateMarketDataVectors(root)).rejects.toThrow(/symlinks/u);
    });
  });

  it('rechaza un HealthReport perteneciente a otra fuente aunque actualice su checksum', async () => {
    await withVectorCopy(async (root) => {
      const healthPath = join(root, 'expected-health.json');
      const health = JSON.parse(await readFile(healthPath, 'utf8')) as Record<string, unknown>;
      health['source'] = 'other-source';
      const bytes = Buffer.from(`${JSON.stringify(health, null, 2)}\n`);
      await writeFile(healthPath, bytes);
      await updateManifestEntry(root, 'expected-health.json', bytes);

      await expect(validateMarketDataVectors(root)).rejects.toThrow(/HealthReport/u);
    });
  });
});
