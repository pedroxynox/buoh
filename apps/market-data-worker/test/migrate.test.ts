import { type Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { pendingMigrations } from '../src/index.js';

// Las migraciones que le faltan a un esquema, sin PostgreSQL: un pool falso que responde la lectura
// de `buoh_schema_migrations`. La prueba contra PostgreSQL está en integration/ingest-session.test.ts.

const ALL = [
  '0001_publicaciones.sql',
  '0002_log_raw_first.sql',
  '0003_catalogo_y_respuestas_pedidas.sql',
  '0004_cursor_y_latido.sql',
  '0005_punto_de_control_en_vivo.sql',
];

/** Un pool que responde cada consulta con `answer` y anota su texto. */
function fakePool(answer: () => Promise<{ rows: { name: string }[] }>) {
  const queries: string[] = [];
  const pool = {
    query: (text: string) => {
      queries.push(text);
      return answer();
    },
  } as unknown as Pick<Pool, 'query'>;
  return { pool, queries };
}

const applied =
  (...names: string[]) =>
  () =>
    Promise.resolve({ rows: names.map((name) => ({ name })) });

describe('pendingMigrations', () => {
  it('sin la tabla buoh_schema_migrations (42P01), le faltan todas las migraciones del worker', async () => {
    const { pool } = fakePool(() =>
      Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
    );
    expect(await pendingMigrations(pool)).toEqual(ALL);
  });

  it('le faltan, en orden, las que la tabla no tiene', async () => {
    expect(await pendingMigrations(fakePool(applied(...ALL.slice(0, 4))).pool)).toEqual([
      '0005_punto_de_control_en_vivo.sql',
    ]);
    expect(await pendingMigrations(fakePool(applied(...ALL.slice(0, 3))).pool)).toEqual([
      '0004_cursor_y_latido.sql',
      '0005_punto_de_control_en_vivo.sql',
    ]);
    expect(await pendingMigrations(fakePool(applied(ALL[1] ?? '')).pool)).toEqual([
      '0001_publicaciones.sql',
      '0003_catalogo_y_respuestas_pedidas.sql',
      '0004_cursor_y_latido.sql',
      '0005_punto_de_control_en_vivo.sql',
    ]);
  });

  it('con todas aplicadas no le falta ninguna, y solo lee: una consulta SELECT, sin aplicar nada', async () => {
    const { pool, queries } = fakePool(applied(...ALL));
    expect(await pendingMigrations(pool)).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT name FROM buoh_schema_migrations/u);
  });

  it('cualquier otro error, como un PostgreSQL que no responde, se rechaza con él', async () => {
    const unavailable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(pendingMigrations(fakePool(() => Promise.reject(unavailable)).pool)).rejects.toBe(
      unavailable,
    );
  });
});
