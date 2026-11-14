import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_CONNECTION_LIMIT,
  API_READER_ROLE,
  API_ROLE,
  API_SCHEMA,
  ensureApiReaderRole,
  ensureApiRole,
  ensureRuntimeRoles,
  grantApiPrivileges,
  grantLogPrivileges,
  INGEST_DENIED_TABLES,
  INGEST_READ_TABLES,
  INGEST_WRITE_TABLES,
  MIGRATIONS_TABLE,
  POSTGRES_ROLES,
  scramSha256Verifier,
  setRolePassword,
  UnclassifiedTableError,
} from '../src/index.js';

// Los roles de PostgreSQL de ADR-0018 §8, sin servidor: el verificador SCRAM contra el vector del
// RFC 7677 y las órdenes que se envían. La prueba contra PostgreSQL, con sus privilegios y sus
// fallos 42501, está en integration/roles.test.ts.

/** Un cliente que anota cada consulta y responde con `answer`. */
function fakeClient(
  answer: (text: string) => { rows: Record<string, unknown>[] } = () => ({ rows: [] }),
) {
  const queries: string[] = [];
  return {
    client: {
      query: (text: string) => {
        queries.push(text);
        return Promise.resolve(answer(text));
      },
    } as unknown as Parameters<typeof setRolePassword>[0],
    queries,
  };
}

describe('scramSha256Verifier', () => {
  // RFC 7677 §3: usuario «user», contraseña «pencil», sal y 4096 iteraciones, y el intercambio que
  // publica. Del verificador salen StoredKey y ServerKey: la prueba del cliente (p) y la firma del
  // servidor (v) que da el RFC solo coinciden si son los del RFC.
  const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const NONCE = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const AUTH_MESSAGE = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${NONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${NONCE}`;
  const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
  const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';
  const hmac = (key: Buffer, message: string) => createHmac('sha256', key).update(message).digest();

  it('con el formato de PostgreSQL, su StoredKey y su ServerKey reproducen la prueba del cliente y la firma del servidor del RFC 7677', () => {
    const verifier = scramSha256Verifier('pencil', SALT, 4096);
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u,
    );
    const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/u.exec(verifier);
    expect(match?.[1]).toBe(SALT.toString('base64'));
    const storedKey = Buffer.from(match?.[2] ?? '', 'base64');
    const serverKey = Buffer.from(match?.[3] ?? '', 'base64');
    // ClientKey = ClientProof XOR ClientSignature, y StoredKey = H(ClientKey).
    const signature = hmac(storedKey, AUTH_MESSAGE);
    const proof = Buffer.from(CLIENT_PROOF, 'base64');
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (signature[index] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
    expect(hmac(serverKey, AUTH_MESSAGE).toString('base64')).toBe(SERVER_SIGNATURE);
  });

  it('rechaza una contraseña vacía, que no es ASCII imprimible o con espacios, una sal corta y menos de 4096 iteraciones', () => {
    expect(() => scramSha256Verifier('')).toThrow(TypeError);
    expect(() => scramSha256Verifier('contraseña-con-eñe-larga')).toThrow(TypeError);
    expect(() => scramSha256Verifier('con espacio en medio')).toThrow(TypeError);
    expect(() => scramSha256Verifier('a'.repeat(32), Buffer.alloc(8))).toThrow(TypeError);
    expect(() => scramSha256Verifier('a'.repeat(32), SALT, 1000)).toThrow(TypeError);
  });

  it('con sal aleatoria, dos verificadores de la misma contraseña son distintos', () => {
    expect(scramSha256Verifier('a'.repeat(32))).not.toBe(scramSha256Verifier('a'.repeat(32)));
  });
});

describe('setRolePassword', () => {
  it('como buoh_dueno, envía el verificador y nunca la contraseña', async () => {
    // Con la forma de las que genera Render (`generateValue`): 256 bits en base64.
    const password = 'B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk=';
    const { client, queries } = fakeClient();
    await setRolePassword(client, POSTGRES_ROLES.ingest, password);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toBe('SET LOCAL ROLE "buoh_dueno"');
    expect(queries[2]).toMatch(/^ALTER ROLE "buoh_ingesta" PASSWORD 'SCRAM-SHA-256\$4096:/u);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.join('\n')).not.toContain(password);
  });

  it('solo admite los roles de ejecución que inician sesión, con una contraseña de 16 caracteres o más', async () => {
    const { client, queries } = fakeClient();
    for (const role of [POSTGRES_ROLES.owner, POSTGRES_ROLES.reader, 'postgres']) {
      await expect(
        setRolePassword(client, role as typeof POSTGRES_ROLES.ingest, 'a'.repeat(32)),
      ).rejects.toThrow(TypeError);
    }
    await expect(setRolePassword(client, POSTGRES_ROLES.agent, 'a'.repeat(15))).rejects.toThrow(
      TypeError,
    );
    expect(queries).toEqual([]);
  });
});

describe('grantLogPrivileges', () => {
  const tables = [
    MIGRATIONS_TABLE,
    ...INGEST_WRITE_TABLES,
    ...INGEST_READ_TABLES,
    ...INGEST_DENIED_TABLES,
  ];

  it('como buoh_dueno, da a buoh_lectura todas las tablas y a buoh_ingesta solo las del log, sin las de datasets', async () => {
    const { client, queries } = fakeClient((text) =>
      text.includes('information_schema.tables')
        ? { rows: tables.map((table_name) => ({ table_name })) }
        : { rows: [] },
    );
    await grantLogPrivileges(client, 'buoh_log_000001');
    expect(queries.slice(0, 2)).toEqual(['BEGIN', 'SET LOCAL ROLE "buoh_dueno"']);
    const grants = queries.filter((text) => text.startsWith('GRANT'));
    expect(grants).toContain(
      'GRANT USAGE ON SCHEMA "buoh_log_000001" TO "buoh_ingesta", "buoh_lectura"',
    );
    expect(grants).toContain(
      'GRANT SELECT ON ALL TABLES IN SCHEMA "buoh_log_000001" TO "buoh_lectura"',
    );
    for (const table of INGEST_WRITE_TABLES) {
      expect(grants).toContain(
        `GRANT SELECT, INSERT ON "buoh_log_000001"."${table}" TO "buoh_ingesta"`,
      );
    }
    expect(grants).toContain(
      `GRANT SELECT ON "buoh_log_000001"."${MIGRATIONS_TABLE}" TO "buoh_ingesta"`,
    );
    // El perfil del log (ADR-0020 §4): buoh_ingesta solo lo lee; ningún rol de ejecución lo escribe.
    expect(INGEST_READ_TABLES).toEqual(['log_quality_profile']);
    expect(grants).toContain(
      'GRANT SELECT ON "buoh_log_000001"."log_quality_profile" TO "buoh_ingesta"',
    );
    expect(
      grants.filter((text) => text.includes('"log_quality_profile"') && text.includes('INSERT')),
    ).toEqual([]);
    for (const table of INGEST_DENIED_TABLES) {
      expect(grants.some((text) => text.includes(`"${table}"`))).toBe(false);
    }
    expect(grants.some((text) => /UPDATE|DELETE|TRUNCATE/u.test(text))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('una tabla sin privilegios decididos lanza UnclassifiedTableError y no da ninguno', async () => {
    const { client, queries } = fakeClient((text) =>
      text.includes('information_schema.tables')
        ? { rows: [...tables, 'tabla_nueva'].map((table_name) => ({ table_name })) }
        : { rows: [] },
    );
    await expect(grantLogPrivileges(client, 'buoh_log_000001')).rejects.toBeInstanceOf(
      UnclassifiedTableError,
    );
    expect(queries.some((text) => text.startsWith('GRANT'))).toBe(false);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('rechaza un esquema con un nombre que no es de minúsculas, cifras y _', async () => {
    const { client, queries } = fakeClient();
    await expect(grantLogPrivileges(client, 'Log; DROP')).rejects.toThrow(TypeError);
    expect(queries).toEqual([]);
  });
});

describe('el rol y los privilegios de la API (ADR-0019 §7)', () => {
  const normalized = (queries: readonly string[]) =>
    queries.map((text) => text.replace(/\s+/gu, ' ').trim());

  it('ensureApiRole crea buoh_api como buoh_dueno, con inicio de sesión y sin crear roles', async () => {
    const { client, queries } = fakeClient();
    await ensureApiRole(client);
    expect(API_ROLE).toBe('buoh_api');
    expect(normalized(queries)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "buoh_dueno"',
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      'CREATE ROLE "buoh_api" LOGIN NOCREATEROLE',
      'COMMIT',
    ]);
  });

  it('ensureApiRole vuelve a fijar sus atributos si el rol ya existe', async () => {
    const { client, queries } = fakeClient((text) =>
      text.startsWith('SELECT EXISTS') ? { rows: [{ exists: true }] } : { rows: [] },
    );
    await ensureApiRole(client);
    expect(queries).toContain('ALTER ROLE "buoh_api" LOGIN NOCREATEROLE');
  });

  it('grantApiPrivileges da a buoh_api SELECT e INSERT en sus tablas, solo SELECT en la de migraciones, y nada a buoh_lectura', async () => {
    const { client, queries } = fakeClient((text) =>
      text.includes('information_schema.tables')
        ? { rows: [{ table_name: 'audit_events' }, { table_name: MIGRATIONS_TABLE }] }
        : { rows: [] },
    );
    await grantApiPrivileges(client);
    expect(API_SCHEMA).toBe('buoh_api');
    expect(normalized(queries)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "buoh_dueno"',
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      'GRANT USAGE ON SCHEMA "buoh_api" TO "buoh_api"',
      'GRANT SELECT, INSERT ON "buoh_api"."audit_events" TO "buoh_api"',
      'GRANT SELECT ON "buoh_api"."buoh_schema_migrations" TO "buoh_api"',
      'GRANT USAGE ON ALL SEQUENCES IN SCHEMA "buoh_api" TO "buoh_api"',
      'COMMIT',
    ]);
    expect(queries.join('\n')).not.toMatch(/UPDATE|DELETE|TRUNCATE|buoh_lectura|ALL TABLES/u);
  });

  it('un fallo al dar los privilegios deshace la transacción entera', async () => {
    const { client, queries } = fakeClient((text) => {
      if (text.startsWith('GRANT SELECT, INSERT')) {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      }
      return text.includes('information_schema.tables')
        ? { rows: [{ table_name: 'audit_events' }] }
        : { rows: [] };
    });
    await expect(grantApiPrivileges(client)).rejects.toMatchObject({ code: '42501' });
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('setRolePassword admite buoh_api', async () => {
    const password = 'api-sintetica-0123456789';
    const { client, queries } = fakeClient();
    await setRolePassword(client, API_ROLE, password);
    expect(queries[1]).toBe('SET LOCAL ROLE "buoh_dueno"');
    expect(queries[2]).toMatch(/^ALTER ROLE "buoh_api" PASSWORD 'SCRAM-SHA-256\$4096:/u);
    expect(queries.join('\n')).not.toContain(password);
  });
});

describe('el rol de lectura de la API (ADR-0019 §7 y §8)', () => {
  const normalized = (queries: readonly string[]) =>
    queries.map((text) => text.replace(/\s+/gu, ' ').trim());

  it('ensureApiReaderRole crea buoh_api_lectura como buoh_dueno, con inicio de sesión, sin crear roles y miembro de buoh_lectura', async () => {
    const { client, queries } = fakeClient();
    await ensureApiReaderRole(client);
    expect(API_READER_ROLE).toBe('buoh_api_lectura');
    expect(normalized(queries)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "buoh_dueno"',
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      'CREATE ROLE "buoh_api_lectura" LOGIN NOCREATEROLE',
      'GRANT "buoh_lectura" TO "buoh_api_lectura"',
      'COMMIT',
    ]);
  });

  it('si ya existe, le vuelve a fijar sus atributos y su pertenencia, sin ningún privilegio propio', async () => {
    const { client, queries } = fakeClient((text) =>
      text.startsWith('SELECT EXISTS') ? { rows: [{ exists: true }] } : { rows: [] },
    );
    await ensureApiReaderRole(client);
    expect(queries).toContain('ALTER ROLE "buoh_api_lectura" LOGIN NOCREATEROLE');
    expect(queries).toContain('GRANT "buoh_lectura" TO "buoh_api_lectura"');
    expect(queries.join('\n')).not.toMatch(/ON SCHEMA|ON ALL|buoh_api"|INSERT|CREATEROLE /u);
  });

  it('un fallo deshace la transacción entera', async () => {
    const { client, queries } = fakeClient((text) => {
      if (text.startsWith('GRANT')) {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      }
      return { rows: [] };
    });
    await expect(ensureApiReaderRole(client)).rejects.toMatchObject({ code: '42501' });
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('setRolePassword admite buoh_api_lectura', async () => {
    const password = 'lectura-sintetica-0123456789';
    const { client, queries } = fakeClient();
    await setRolePassword(client, API_READER_ROLE, password);
    expect(queries[1]).toBe('SET LOCAL ROLE "buoh_dueno"');
    expect(queries[2]).toMatch(/^ALTER ROLE "buoh_api_lectura" PASSWORD 'SCRAM-SHA-256\$4096:/u);
    expect(queries.join('\n')).not.toContain(password);
  });
});

describe('ensureRuntimeRoles', () => {
  it('crea buoh_dueno y, como buoh_dueno, los roles de ejecución con sus atributos y los límites de buoh_agente', async () => {
    const { client, queries } = fakeClient((text) => {
      if (text.includes('pg_roles')) {
        return { rows: [{ exists: false }] };
      }
      if (text.includes('pg_has_role')) {
        return { rows: [{ can_set: false }] };
      }
      if (text.includes('has_database_privilege')) {
        return { rows: [{ allowed: false }] };
      }
      if (text.includes('current_database() AS name')) {
        return { rows: [{ name: 'buoh' }] };
      }
      return { rows: [] };
    });
    await ensureRuntimeRoles(client);
    const ddl = queries.filter((text) => !text.startsWith('SELECT'));
    expect(ddl).toEqual([
      'BEGIN',
      'CREATE ROLE "buoh_dueno" NOLOGIN CREATEROLE',
      'GRANT "buoh_dueno" TO CURRENT_USER WITH SET TRUE',
      'GRANT CREATE ON DATABASE "buoh" TO "buoh_dueno"',
      'SET LOCAL ROLE "buoh_dueno"',
      'CREATE ROLE "buoh_lectura" NOLOGIN NOCREATEROLE',
      'CREATE ROLE "buoh_ingesta" LOGIN NOCREATEROLE',
      'CREATE ROLE "buoh_salud" LOGIN NOCREATEROLE',
      'CREATE ROLE "buoh_agente" LOGIN NOCREATEROLE',
      'GRANT "buoh_lectura" TO "buoh_salud"',
      'GRANT "buoh_lectura" TO "buoh_agente"',
      `ALTER ROLE "buoh_agente" CONNECTION LIMIT ${String(AGENT_CONNECTION_LIMIT)}`,
      'ALTER ROLE "buoh_agente" SET statement_timeout = \'30s\'',
      'ALTER ROLE "buoh_agente" SET idle_in_transaction_session_timeout = \'60s\'',
      'COMMIT',
    ]);
  });

  it('con los roles ya creados, la pertenencia y el privilegio de la base, no los repite y vuelve a fijar los atributos de cada rol', async () => {
    const { client, queries } = fakeClient((text) => {
      if (text.includes('pg_roles')) {
        return { rows: [{ exists: true }] };
      }
      if (text.includes('pg_has_role')) {
        return { rows: [{ can_set: true }] };
      }
      if (text.includes('has_database_privilege')) {
        return { rows: [{ allowed: true }] };
      }
      return { rows: [] };
    });
    await ensureRuntimeRoles(client);
    const ddl = queries.filter((text) => !text.startsWith('SELECT'));
    expect(ddl).toEqual([
      'BEGIN',
      'ALTER ROLE "buoh_dueno" NOLOGIN CREATEROLE',
      'SET LOCAL ROLE "buoh_dueno"',
      'ALTER ROLE "buoh_lectura" NOLOGIN NOCREATEROLE',
      'ALTER ROLE "buoh_ingesta" LOGIN NOCREATEROLE',
      'ALTER ROLE "buoh_salud" LOGIN NOCREATEROLE',
      'ALTER ROLE "buoh_agente" LOGIN NOCREATEROLE',
      'GRANT "buoh_lectura" TO "buoh_salud"',
      'GRANT "buoh_lectura" TO "buoh_agente"',
      `ALTER ROLE "buoh_agente" CONNECTION LIMIT ${String(AGENT_CONNECTION_LIMIT)}`,
      'ALTER ROLE "buoh_agente" SET statement_timeout = \'30s\'',
      'ALTER ROLE "buoh_agente" SET idle_in_transaction_session_timeout = \'60s\'',
      'COMMIT',
    ]);
  });
});
