import { describe, expect, it } from 'vitest';

import {
  DATASETS_MIGRATIONS,
  DATASETS_OWNER_TABLES,
  DATASETS_PUBLICATION_TABLES,
  DATASETS_SCHEMA,
  ensurePublicationRole,
  grantDatasetsPrivileges,
  loadMigrations,
  migrate,
  migrateDatasets,
  MIGRATIONS_TABLE,
  PUBLICATION_ROLE,
  setRolePassword,
  UnclassifiedTableError,
} from '../src/index.js';

// El esquema `buoh_datasets` de ADR-0020 §5, sin servidor: su secuencia de migraciones, el rol
// `buoh_publicacion` y los privilegios que se envían. La prueba contra PostgreSQL, con sus fallos
// 42501, está en integration/datasets.test.ts.

const normalized = (queries: readonly string[]) =>
  queries.map((text) => text.replace(/\s+/gu, ' ').trim());

/** Un cliente que anota cada consulta y responde con `answer`. */
function fakeClient(
  answer: (text: string) => { rows: Record<string, unknown>[] } = () => ({ rows: [] }),
) {
  const queries: string[] = [];
  const client = {
    off: () => undefined,
    on: () => undefined,
    query: (text: string) => {
      queries.push(text);
      return Promise.resolve(answer(text));
    },
    release: () => undefined,
  };
  return {
    client: client as unknown as Parameters<typeof setRolePassword>[0],
    pool: { connect: () => Promise.resolve(client) } as unknown as Parameters<typeof migrate>[0],
    queries,
  };
}

const TABLES = [
  'buoh_schema_migrations',
  'dataset_log_ranges',
  'dataset_quality_incidents',
  'dataset_verifications',
  'datasets',
  'operational_conditions',
  'operational_incidents',
  'published_manifest_records',
];

describe('las migraciones de buoh_datasets (ADR-0020 §5)', () => {
  it('son su propia secuencia, en migrations-datasets/, aparte de las de los logs', async () => {
    expect(DATASETS_SCHEMA).toBe('buoh_datasets');
    expect((await loadMigrations(DATASETS_MIGRATIONS)).map((m) => m.name)).toEqual([
      '0001_datasets.sql',
    ]);
    expect((await loadMigrations()).map((m) => m.name)).not.toContain('0001_datasets.sql');
    expect(DATASETS_MIGRATIONS.directory.pathname).toMatch(/\/migrations-datasets\/$/u);
  });

  it('migrateDatasets las aplica como el dueño, en buoh_datasets, que crea si no existe, con su propio bloqueo', async () => {
    const { pool, queries } = fakeClient();
    const result = await migrateDatasets(pool, { ownerRole: 'buoh_dueno' });
    expect(result).toEqual({ applied: ['0001_datasets.sql'], current: ['0001_datasets.sql'] });
    const sent = normalized(queries);
    expect(sent.slice(0, 5)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'SET LOCAL ROLE "buoh_dueno"',
      'CREATE SCHEMA IF NOT EXISTS "buoh_datasets"',
      'SET LOCAL search_path TO "buoh_datasets"',
    ]);
    expect(sent[5]).toMatch(/^CREATE TABLE IF NOT EXISTS buoh_schema_migrations/u);
    expect(sent.at(-1)).toBe('COMMIT');
    expect(DATASETS_MIGRATIONS.lockKey).toBe(4_100_021);
  });

  it('el bloqueo de los datasets no es el de los logs ni los de la API', async () => {
    const locks: unknown[] = [];
    const client = {
      off: () => undefined,
      on: () => undefined,
      query: (text: string, values?: unknown[]) => {
        if (text.startsWith('SELECT pg_advisory_xact_lock')) locks.push(values?.[0]);
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Parameters<
      typeof migrate
    >[0];
    await migrateDatasets(pool);
    await migrate(pool);
    expect(locks).toEqual([4_100_021, 4_100_013]);
  });

  it('las migraciones de los logs no crean esquema ni cambian el search_path', async () => {
    const { pool, queries } = fakeClient();
    await migrate(pool, { ownerRole: 'buoh_dueno' });
    expect(queries.join('\n')).not.toMatch(/CREATE SCHEMA|search_path|0001_datasets/u);
  });
});

describe('el rol buoh_publicacion (ADR-0020 §5)', () => {
  it('ensurePublicationRole lo crea como buoh_dueno, con inicio de sesión, sin crear roles y miembro de buoh_lectura', async () => {
    const { client, queries } = fakeClient();
    await ensurePublicationRole(client);
    expect(PUBLICATION_ROLE).toBe('buoh_publicacion');
    expect(normalized(queries)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "buoh_dueno"',
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      'CREATE ROLE "buoh_publicacion" LOGIN NOCREATEROLE',
      'GRANT "buoh_lectura" TO "buoh_publicacion"',
      'COMMIT',
    ]);
  });

  it('si ya existe, le vuelve a fijar sus atributos y su pertenencia', async () => {
    const { client, queries } = fakeClient((text) =>
      text.startsWith('SELECT EXISTS') ? { rows: [{ exists: true }] } : { rows: [] },
    );
    await ensurePublicationRole(client);
    expect(queries).toContain('ALTER ROLE "buoh_publicacion" LOGIN NOCREATEROLE');
    expect(queries).toContain('GRANT "buoh_lectura" TO "buoh_publicacion"');
  });

  it('setRolePassword admite buoh_publicacion y nunca envía la contraseña', async () => {
    const password = 'publicacion-sintetica-0123456789';
    const { client, queries } = fakeClient();
    await setRolePassword(client, PUBLICATION_ROLE, password);
    expect(queries[1]).toBe('SET LOCAL ROLE "buoh_dueno"');
    expect(queries[2]).toMatch(/^ALTER ROLE "buoh_publicacion" PASSWORD 'SCRAM-SHA-256\$4096:/u);
    expect(queries.join('\n')).not.toContain(password);
  });
});

describe('grantDatasetsPrivileges (ADR-0020 §5)', () => {
  const answer = (tables: readonly string[]) => (text: string) =>
    text.includes('information_schema.tables')
      ? { rows: tables.map((table_name) => ({ table_name })) }
      : { rows: [] };

  it('clasifica cada tabla: la publicación escribe todas salvo las verificaciones, que son del dueño', () => {
    expect([...DATASETS_PUBLICATION_TABLES].sort()).toEqual([
      'dataset_log_ranges',
      'dataset_quality_incidents',
      'datasets',
      'operational_conditions',
      'operational_incidents',
      'published_manifest_records',
    ]);
    expect(DATASETS_OWNER_TABLES).toEqual(['dataset_verifications']);
    expect(
      [MIGRATIONS_TABLE, ...DATASETS_PUBLICATION_TABLES, ...DATASETS_OWNER_TABLES].sort(),
    ).toEqual(TABLES);
  });

  it('como buoh_dueno, da a buoh_lectura el esquema y SELECT, y a buoh_publicacion SELECT e INSERT en sus tablas', async () => {
    const { client, queries } = fakeClient(answer(TABLES));
    await grantDatasetsPrivileges(client);
    expect(normalized(queries)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "buoh_dueno"',
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      'GRANT USAGE ON SCHEMA "buoh_datasets" TO "buoh_lectura", "buoh_publicacion"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "buoh_datasets" TO "buoh_lectura"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."datasets" TO "buoh_publicacion"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."published_manifest_records" TO "buoh_publicacion"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."dataset_quality_incidents" TO "buoh_publicacion"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."dataset_log_ranges" TO "buoh_publicacion"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."operational_incidents" TO "buoh_publicacion"',
      'GRANT SELECT, INSERT ON "buoh_datasets"."operational_conditions" TO "buoh_publicacion"',
      'GRANT USAGE ON ALL SEQUENCES IN SCHEMA "buoh_datasets" TO "buoh_publicacion"',
      'COMMIT',
    ]);
    const all = queries.join('\n');
    expect(all).not.toMatch(/UPDATE|DELETE|TRUNCATE|buoh_ingesta|CREATE/u);
    expect(all).not.toMatch(
      /INSERT ON "buoh_datasets"\."(dataset_verifications|buoh_schema_migrations)"/u,
    );
  });

  it('una tabla sin privilegios decididos lanza UnclassifiedTableError y no da ninguno', async () => {
    const { client, queries } = fakeClient(answer([...TABLES, 'intrusa']));
    const failure = await grantDatasetsPrivileges(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnclassifiedTableError);
    expect((failure as UnclassifiedTableError).table).toBe('intrusa');
    expect(queries.join('\n')).not.toMatch(/GRANT/u);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('sin las tablas todavía, solo da el esquema y SELECT a buoh_lectura', async () => {
    const { client, queries } = fakeClient(answer([]));
    await grantDatasetsPrivileges(client);
    expect(queries.join('\n')).not.toMatch(/SELECT, INSERT/u);
  });
});
