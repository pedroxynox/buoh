import { describe, expect, it } from 'vitest';

import { readLastActiveDatasetId } from '../src/postgres/data-events.js';

/** Un pool falso: cada consulta recibe la respuesta siguiente, y guarda el texto y los parámetros. */
function fakePool(answers: ((text: string) => Promise<{ rows: unknown[] }>)[]) {
  const queries: { params: unknown[] | undefined; text: string }[] = [];
  return {
    pool: {
      query: (text: string, params?: unknown[]) => {
        queries.push({ params, text });
        const answer = answers.shift();
        if (answer === undefined) {
          throw new TypeError('Consulta de más.');
        }
        return answer(text);
      },
    } as unknown as Parameters<typeof readLastActiveDatasetId>[0],
    queries,
  };
}

const INPUT = { environment: 'production', sequence: 'R_100', source: 'deriv_options' } as const;
const DATASET = `sha256:${'a'.repeat(64)}`;
const undefinedTable = () =>
  Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

describe('readLastActiveDatasetId (ADR-0015 §8; ADR-0020 §5)', () => {
  it('lee buoh_datasets con el esquema en cada tabla, la fuente, el entorno y la secuencia, y da el dataset_id', async () => {
    const { pool, queries } = fakePool([
      () => Promise.resolve({ rows: [{ dataset_id: DATASET }] }),
    ]);
    expect(await readLastActiveDatasetId(pool, INPUT)).toBe(DATASET);
    expect(queries[0]?.params).toEqual(['deriv_options', 'production', 'R_100']);
    expect(queries[0]?.text).toContain('"buoh_datasets".published_manifest_records');
    expect(queries[0]?.text).toContain('"buoh_datasets".dataset_log_ranges');
  });

  it('sin ningún dataset, null', async () => {
    const { pool } = fakePool([() => Promise.resolve({ rows: [] })]);
    expect(await readLastActiveDatasetId(pool, INPUT)).toBe(null);
  });

  it('sin el esquema buoh_datasets (42P01 y to_regnamespace nulo), null: todavía no hay ninguno', async () => {
    const { pool, queries } = fakePool([
      undefinedTable,
      () => Promise.resolve({ rows: [{ missing: true }] }),
    ]);
    expect(await readLastActiveDatasetId(pool, INPUT)).toBe(null);
    expect(queries[1]?.params).toEqual(['buoh_datasets']);
  });

  it('con el esquema y sin una de sus tablas, o con otro error, rechaza con el error de PostgreSQL', async () => {
    const withSchema = fakePool([
      undefinedTable,
      () => Promise.resolve({ rows: [{ missing: false }] }),
    ]);
    await expect(readLastActiveDatasetId(withSchema.pool, INPUT)).rejects.toMatchObject({
      code: '42P01',
    });
    const denied = fakePool([
      () => Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' })),
    ]);
    await expect(readLastActiveDatasetId(denied.pool, INPUT)).rejects.toMatchObject({
      code: '42501',
    });
    expect(denied.queries).toHaveLength(1);
  });
});
