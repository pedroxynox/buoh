import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_CONNECTION_LIMIT,
  ensureRuntimeRoles,
  grantLogPrivileges,
  INGEST_DENIED_TABLES,
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
  const tables = [MIGRATIONS_TABLE, ...INGEST_WRITE_TABLES, ...INGEST_DENIED_TABLES];

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

describe('ensureRuntimeRoles', () => {
  it('crea buoh_dueno y, como buoh_dueno, los roles de ejecución con los límites de buoh_agente', async () => {
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
      'CREATE ROLE "buoh_lectura" NOLOGIN',
      'CREATE ROLE "buoh_ingesta" LOGIN',
      'CREATE ROLE "buoh_salud" LOGIN',
      'CREATE ROLE "buoh_agente" LOGIN',
      'GRANT "buoh_lectura" TO "buoh_salud"',
      'GRANT "buoh_lectura" TO "buoh_agente"',
      `ALTER ROLE "buoh_agente" CONNECTION LIMIT ${String(AGENT_CONNECTION_LIMIT)}`,
      'ALTER ROLE "buoh_agente" SET statement_timeout = \'30s\'',
      'ALTER ROLE "buoh_agente" SET idle_in_transaction_session_timeout = \'60s\'',
      'COMMIT',
    ]);
  });

  it('con los roles ya creados, la pertenencia y el privilegio de la base, no los repite', async () => {
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
    expect(queries.some((text) => text.startsWith('CREATE ROLE'))).toBe(false);
    expect(queries).not.toContain('GRANT "buoh_dueno" TO CURRENT_USER WITH SET TRUE');
    expect(queries.some((text) => text.startsWith('GRANT CREATE ON DATABASE'))).toBe(false);
  });
});
