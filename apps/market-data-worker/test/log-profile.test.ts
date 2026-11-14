import type { PipelineProfile } from '@buoh/domain';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createDerivMeasurementProfile,
  createDerivPublicationProfile,
} from '../src/deriv/profile.js';
import {
  createDerivLogProfile,
  derivLogProfileRow,
  LogIntegrityError,
  LOG_PROFILE_SYMBOL,
  LogProfileUnknownError,
  readLogQualityProfile,
} from '../src/index.js';
import { syntheticSchemas } from './support/connection-harness.js';

// El perfil de cada log (ADR-0020 §4): la fila de `log_quality_profile` que da `buoh-operaciones`,
// y cómo la arma cada lector con el esquema de fuente que guardó la ingesta. Sin PostgreSQL: la
// lectura, con un pool falso. La de PostgreSQL está en integration/operations.test.ts.

const schemas = syntheticSchemas();
/** Lo que identifica un perfil: su perfil de calidad, sus versiones y su esquema de fuente. */
const identity = (profile: PipelineProfile) => ({
  connector_version: profile.connector_version,
  purpose: profile.purpose,
  quality_profile: profile.quality_profile,
  quality_profile_sha256: profile.quality_profile_sha256,
  source_schema_release: profile.source_schema_release,
  source_schema_sha256: profile.source_schema_sha256,
});
const source = {
  source_schema_bytes: schemas.schema('ticks', 'response').bytes,
  source_schema_release: schemas.release,
};

describe('derivLogProfileRow (ADR-0020 §4)', () => {
  it('es el perfil de publicación de R_100, con el SHA-256 del JCS de su perfil de calidad', () => {
    expect(LOG_PROFILE_SYMBOL).toBe('R_100');
    const publication = createDerivPublicationProfile({ schemas, symbol: 'R_100' });
    expect(derivLogProfileRow('R_100')).toEqual({
      profile_id: 'deriv_options-publication-v1-R_100',
      quality_profile_sha256: publication.quality_profile_sha256,
    });
  });

  it('rechaza un símbolo sin umbrales medidos', () => {
    expect(() => derivLogProfileRow('R_50')).toThrow(/R_50 no tiene umbrales medidos/u);
  });
});

describe('createDerivLogProfile (ADR-0020 §4)', () => {
  it('sin fila, el perfil de medición, como un log de antes del PR 5', () => {
    const profile = createDerivLogProfile({ ...source, row: null, symbol: 'R_100' });
    expect(identity(profile)).toEqual(
      identity(createDerivMeasurementProfile({ schemas, symbol: 'R_100' })),
    );
  });

  it('con la fila del perfil de publicación, ese perfil, con el esquema de fuente guardado', () => {
    const profile = createDerivLogProfile({
      ...source,
      row: derivLogProfileRow('R_100'),
      symbol: 'R_100',
    });
    expect(identity(profile)).toEqual(
      identity(createDerivPublicationProfile({ schemas, symbol: 'R_100' })),
    );
    expect(profile.rules.quality_rule_version).toBe('3.0.0');
  });

  it.each([
    [
      'un perfil que el código no conoce',
      { ...derivLogProfileRow('R_100'), profile_id: 'deriv_options-publication-v2-R_100' },
      'R_100',
    ],
    [
      'el perfil de medición, que nunca va en la fila',
      {
        profile_id: 'deriv_options-measurement-v2-R_100',
        quality_profile_sha256: createDerivMeasurementProfile({ schemas, symbol: 'R_100' })
          .quality_profile_sha256,
      },
      'R_100',
    ],
    [
      'el del perfil con otro SHA-256',
      { ...derivLogProfileRow('R_100'), quality_profile_sha256: 'a'.repeat(64) },
      'R_100',
    ],
    ['el perfil de otro símbolo', derivLogProfileRow('R_100'), 'R_50'],
  ] as const)(
    '%s falla cerrado: LogProfileUnknownError, un LogIntegrityError',
    (_name, row, symbol) => {
      let thrown: unknown;
      try {
        createDerivLogProfile({ ...source, row, symbol });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LogProfileUnknownError);
      expect(thrown).toBeInstanceOf(LogIntegrityError);
      expect((thrown as Error).name).toBe('LogProfileUnknownError');
    },
  );
});

describe('readLogQualityProfile', () => {
  const pool = (answer: () => Promise<{ rows: unknown[] }>) => {
    const queries: string[] = [];
    return {
      pool: {
        query: (text: string) => {
          queries.push(text);
          return answer();
        },
      } as unknown as Pick<Pool, 'query'>,
      queries,
    };
  };

  it('lee la fila del esquema pedido, o la del search_path sin él, y solo lee', async () => {
    const row = derivLogProfileRow('R_100');
    const withSchema = pool(() => Promise.resolve({ rows: [row] }));
    expect(await readLogQualityProfile(withSchema.pool, 'buoh_log_000005')).toEqual(row);
    expect(withSchema.queries).toEqual([
      'SELECT profile_id, quality_profile_sha256 FROM "buoh_log_000005".log_quality_profile',
    ]);
    const plain = pool(() => Promise.resolve({ rows: [row] }));
    expect(await readLogQualityProfile(plain.pool)).toEqual(row);
    expect(plain.queries).toEqual([
      'SELECT profile_id, quality_profile_sha256 FROM log_quality_profile',
    ]);
  });

  it('sin fila, null', async () => {
    expect(await readLogQualityProfile(pool(() => Promise.resolve({ rows: [] })).pool)).toBeNull();
  });

  it('sin la tabla (42P01), como un log al que todavía no se le aplicó la 0007, null: no puede tener fila', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect(await readLogQualityProfile(pool(() => Promise.reject(missing)).pool)).toBeNull();
  });

  it('cualquier otro error rechaza con él', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(readLogQualityProfile(pool(() => Promise.reject(denied)).pool)).rejects.toBe(
      denied,
    );
  });

  it('una fila con otra forma falla cerrado con LogProfileUnknownError', async () => {
    for (const rows of [
      [{ profile_id: 'x', quality_profile_sha256: 'no-hex' }],
      [{ profile_id: '', quality_profile_sha256: 'a'.repeat(64) }],
      [derivLogProfileRow('R_100'), derivLogProfileRow('R_100')],
    ]) {
      await expect(
        readLogQualityProfile(pool(() => Promise.resolve({ rows })).pool),
      ).rejects.toBeInstanceOf(LogProfileUnknownError);
    }
  });

  it('rechaza un esquema con un nombre que no es de minúsculas, cifras y _', async () => {
    const { pool: fake, queries } = pool(() => Promise.resolve({ rows: [] }));
    await expect(readLogQualityProfile(fake, 'Log; DROP')).rejects.toThrow(TypeError);
    expect(queries).toEqual([]);
  });
});
