import { resolve } from 'node:path';

import { canonicalJson } from '@buoh/contracts';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  CommitOutcomeUnknownError,
  loadSyntheticFixture,
  PostgresDatasetStore,
  PostgresMetadataStore,
  preparePublication,
  PublicationConflictError,
} from '../src/index.js';
import { MemoryObjectStore } from './support/memory-stores.js';

// El `COMMIT` ambiguo (ADR-0020 §9; pendiente 1 de F1.3), sin servidor: un pool falso cuya consulta
// `COMMIT`, u otra, falla con un código. La prueba con la conexión cortada de verdad está en
// integration/datasets.test.ts.

const VECTORS = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const RANGE = {
  clean: true,
  first_segment: 0,
  last_segment: 1,
  log_number: 1,
  open: { open_condition_types: [], pending_continuity_symbols: [] },
};

async function commitInput() {
  const fixture = await loadSyntheticFixture(VECTORS);
  const principal = fixture.scenarios.find((item) => item.name === 'principal');
  if (principal === undefined) throw new TypeError('Falta principal.');
  const publication = preparePublication({
    environment: 'test',
    objects: new MemoryObjectStore(),
    profile: fixture.profile,
    publication_id: '019a8000-0000-7000-8000-000000000001',
    published_at_utc: '2026-11-14T06:05:00.000Z',
    segments: principal.segments,
    zlibVersion: 'test-zlib',
  });
  return {
    core: publication.core,
    environment: 'test' as const,
    incidents: publication.derived.incidents,
    record: publication.record,
  };
}

/** Un pool cuyo cliente falla en la consulta que empieza por `failing` con `code`. */
function fakePool(failing: string, code: string | undefined, coreJcs: () => string) {
  const queries: string[] = [];
  const released: unknown[] = [];
  const client = {
    off: () => undefined,
    on: () => undefined,
    query: (text: string) => {
      queries.push(text.trim().split(/\s+/u).slice(0, 3).join(' '));
      if (text.trim().startsWith(failing)) {
        return Promise.reject(Object.assign(new Error('fallo inyectado'), { code }));
      }
      if (text.includes('SELECT manifest_core_jcs')) {
        return Promise.resolve({ rows: [{ manifest_core_jcs: coreJcs() }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: (destroy?: unknown) => released.push(destroy),
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return { pool, queries, released };
}

describe('el COMMIT ambiguo (ADR-0020 §9)', () => {
  const coreOf = async () => canonicalJson((await commitInput()).core);

  it.each([
    ['la conexión cae, sin SQLSTATE', undefined],
    ['ECONNRESET', 'ECONNRESET'],
    ['el servidor termina la sesión (57P01)', '57P01'],
    ['una excepción de conexión (08006)', '08006'],
    ['un error interno (XX000)', 'XX000'],
  ])('si el COMMIT falla por %s, no se sabe si se confirmó', async (_name, code) => {
    const input = await commitInput();
    const core = await coreOf();
    for (const store of ['log', 'datasets'] as const) {
      const { pool, released } = fakePool('COMMIT', code, () => core);
      const target =
        store === 'log' ? new PostgresMetadataStore(pool) : new PostgresDatasetStore(pool);
      const failure = await target
        .commitPublication(store === 'log' ? input : { ...input, logRange: RANGE })
        .catch((error: unknown) => error);
      expect(failure, store).toBeInstanceOf(CommitOutcomeUnknownError);
      expect(failure).toMatchObject({
        datasetId: input.record.dataset_id,
        reason: 'commit_outcome_unknown',
        step: 'manifest_commit',
      });
      // La conexión puede estar rota: no vuelve al pool.
      expect(released).toEqual([true]);
    }
  });

  it.each([
    ['una violación de integridad (23505)', '23505'],
    ['un fallo de serialización (40001)', '40001'],
  ])('si el servidor rechaza el COMMIT con %s, se deshizo: no es ambiguo', async (_name, code) => {
    const input = await commitInput();
    const core = await coreOf();
    const { pool } = fakePool('COMMIT', code, () => core);
    const failure = await new PostgresMetadataStore(pool)
      .commitPublication(input)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(failure).toMatchObject({ code });
  });

  it('un fallo antes del COMMIT, también de la conexión, se deshizo: no es ambiguo', async () => {
    const input = await commitInput();
    const core = await coreOf();
    const { pool, queries } = fakePool(
      'INSERT INTO published_manifest_records',
      'ECONNRESET',
      () => core,
    );
    const failure = await new PostgresMetadataStore(pool)
      .commitPublication(input)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(failure).toMatchObject({ code: 'ECONNRESET' });
    expect(queries).not.toContain('COMMIT');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('con todo bien, el cliente vuelve al pool', async () => {
    const input = await commitInput();
    const core = await coreOf();
    const { pool, queries, released } = fakePool('NADA', undefined, () => core);
    await new PostgresDatasetStore(pool).commitPublication({ ...input, logRange: RANGE });
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries).toContain('INSERT INTO dataset_log_ranges');
    expect(released).toEqual([false]);
  });

  it('un dataset con otro core, o un rango que choca, es publication_conflict', async () => {
    const input = await commitInput();
    const other = fakePool('NADA', undefined, () => '{"otro":true}');
    await expect(
      new PostgresMetadataStore(other.pool).commitPublication(input),
    ).rejects.toBeInstanceOf(PublicationConflictError);
    const core = await coreOf();
    for (const code of ['23505', '23514']) {
      const { pool } = fakePool('INSERT INTO dataset_log_ranges', code, () => core);
      const failure = await new PostgresDatasetStore(pool)
        .commitPublication({ ...input, logRange: RANGE })
        .catch((error: unknown) => error);
      expect(failure, code).toBeInstanceOf(PublicationConflictError);
      expect(failure).toMatchObject({ reason: 'publication_conflict' });
    }
    // Otro fallo de esa inserción no es un conflicto.
    const { pool } = fakePool('INSERT INTO dataset_log_ranges', '23503', () => core);
    const failure = await new PostgresDatasetStore(pool)
      .commitPublication({ ...input, logRange: RANGE })
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(PublicationConflictError);
  });

  it('las tablas de un log no tienen fila de rango, y buoh_datasets la necesita', async () => {
    const input = await commitInput();
    const { pool } = fakePool('NADA', undefined, () => '');
    await expect(
      new PostgresMetadataStore(pool).commitPublication({ ...input, logRange: RANGE }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(new PostgresDatasetStore(pool).commitPublication(input)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
