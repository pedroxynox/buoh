import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import pg, { type PoolClient } from 'pg';

import { POSTGRES_IDENTIFIER } from '../config.js';

/**
 * Los roles de PostgreSQL de producción (ADR-0018 §8):
 * - `buoh_dueno`, sin inicio de sesión y con `CREATEROLE`: dueño de los esquemas de los logs y de
 *   sus tablas, y creador y administrador de los roles de ejecución. El usuario por defecto de
 *   Render es su miembro y actúa con `SET ROLE`, así que rotar esa credencial, que crea un usuario
 *   con otro nombre, no cambia de dueño nada;
 * - `buoh_ingesta`, el de `ingest`: lee e inserta en las tablas del log y nada más;
 * - `buoh_lectura`, sin inicio de sesión: lee las tablas de los logs;
 * - `buoh_salud` y `buoh_agente`, miembros de `buoh_lectura`: `data:health` en producción y el
 *   agente, desde fuera de Render, con un límite de conexiones y de tiempo por consulta.
 */
export const POSTGRES_ROLES = {
  agent: 'buoh_agente',
  health: 'buoh_salud',
  ingest: 'buoh_ingesta',
  owner: 'buoh_dueno',
  reader: 'buoh_lectura',
} as const;

/** Los roles de ejecución que inician sesión, a los que se les pone contraseña. */
export const LOGIN_ROLES = [
  POSTGRES_ROLES.ingest,
  POSTGRES_ROLES.health,
  POSTGRES_ROLES.agent,
] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

/**
 * El rol de la API (ADR-0019 §7), que inicia sesión: en el esquema `buoh_api`, uso del esquema y de
 * sus secuencias, `SELECT` e `INSERT` en sus tablas y solo `SELECT` en la de migraciones; nada en
 * los logs. No es un rol de ejecución del worker: `buoh-operaciones` solo lo crea cuando tiene su
 * contraseña, que le llega con el PR 6 de ADR-0019 §14.
 */
export const API_ROLE = 'buoh_api';
/** El esquema de la API, aparte de los logs, del que es dueño `buoh_dueno` (ADR-0019 §7). */
export const API_SCHEMA = 'buoh_api';
/** Los roles a los que `buoh-operaciones` pone contraseña: los de ejecución y el de la API. */
export type PasswordRole = LoginRole | typeof API_ROLE;

/** Conexiones de `buoh_agente` a la vez, para que no ocupe las 100 de Basic-256mb. */
export const AGENT_CONNECTION_LIMIT = 4;
/**
 * Plazos de `buoh_agente`: una consulta suya no le quita a la captura los 0,1 CPU de Basic-256mb
 * más de 30 s, ni deja una transacción abierta más de un minuto. Son los valores por defecto de sus
 * sesiones (`ALTER ROLE … SET`), y una sesión suya podría cambiarlos con `SET`: el servidor solo
 * impone el límite de conexiones. El cliente del agente no los cambia.
 */
export const AGENT_STATEMENT_TIMEOUT = '30s';
export const AGENT_IDLE_IN_TRANSACTION_TIMEOUT = '60s';

/** La tabla de migraciones de cada esquema: `buoh_ingesta` solo la lee. */
export const MIGRATIONS_TABLE = 'buoh_schema_migrations';

/**
 * Las tablas del log en las que `ingest` lee e inserta: las de las migraciones `0002` en adelante,
 * salvo la de informes de `buoh-operaciones` (ADR-0018 §8).
 */
export const INGEST_WRITE_TABLES = [
  'source_event_index',
  'closed_source_segments',
  'operational_incidents',
  'operational_conditions',
  'source_catalog_versions',
  'requested_response_incidents',
  'ingestion_cursors',
  'ingestion_heartbeats',
  'live_derivation_checkpoints',
] as const;

/**
 * Las tablas de un log que `buoh_ingesta` no toca: las de datasets de `0001`, que no viven en un
 * log de producción (ADR-0018 §7), y la de informes de `buoh-operaciones` (`0006`, §11), que solo
 * escribe ese servicio como `buoh_dueno`.
 */
export const INGEST_DENIED_TABLES = [
  'datasets',
  'published_manifest_records',
  'dataset_quality_incidents',
  'operations_reports',
] as const;

/** Una tabla de un log que no está en ninguna de las listas: hay que decidir sus privilegios. */
export class UnclassifiedTableError extends TypeError {
  readonly table: string;

  constructor(table: string) {
    super(
      `La tabla ${table} no tiene privilegios decididos: añádela a INGEST_WRITE_TABLES o a INGEST_DENIED_TABLES.`,
    );
    this.name = 'UnclassifiedTableError';
    this.table = table;
  }
}

type Client = Pick<PoolClient, 'query'>;

const ident = (name: string): string => pg.escapeIdentifier(name);

function assertIdentifier(name: string, what: string): void {
  if (!POSTGRES_IDENTIFIER.test(name)) {
    throw new TypeError(`${what} debe ser un nombre de minúsculas, cifras y _.`);
  }
}

/** Ejecuta `work` en una transacción del cliente; la deshace entera si falla. */
async function inTransaction(client: Client, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function roleExists(client: Client, role: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
  );
  return rows[0]?.exists === true;
}

/** Los atributos de cada rol (ADR-0018 §8): si inicia sesión y si crea roles. */
const ROLE_ATTRIBUTES = {
  [POSTGRES_ROLES.agent]: 'LOGIN NOCREATEROLE',
  [POSTGRES_ROLES.health]: 'LOGIN NOCREATEROLE',
  [POSTGRES_ROLES.ingest]: 'LOGIN NOCREATEROLE',
  [POSTGRES_ROLES.owner]: 'NOLOGIN CREATEROLE',
  [POSTGRES_ROLES.reader]: 'NOLOGIN NOCREATEROLE',
  [API_ROLE]: 'LOGIN NOCREATEROLE',
} as const;

/** Crea `role` con sus atributos o, si ya existe, se los vuelve a fijar. */
async function ensureRole(client: Client, role: keyof typeof ROLE_ATTRIBUTES): Promise<void> {
  const verb = (await roleExists(client, role)) ? 'ALTER' : 'CREATE';
  await client.query(`${verb} ROLE ${ident(role)} ${ROLE_ATTRIBUTES[role]}`);
}

/**
 * Crea los roles que falten y fija los atributos de todos (ADR-0018 §8), en una transacción, con el
 * usuario del cliente, que necesita `CREATEROLE`: el usuario por defecto de Render, o el
 * superusuario de los servicios locales. Es idempotente.
 *
 * 1. `buoh_dueno`, sin inicio de sesión y con `CREATEROLE`, y la pertenencia del usuario a él con
 *    `SET`, para poder actuar como él. Un usuario de una rotación ya la recibió, con
 *    `ADMIN OPTION`, del anterior.
 * 2. El privilegio `CREATE` de la base para `buoh_dueno`, si no lo tiene, para que cree los esquemas
 *    de los logs. Solo puede darlo el dueño de la base.
 * 3. Como `buoh_dueno` (`SET LOCAL ROLE`), para que los administre él, los roles de ejecución:
 *    `buoh_lectura`, sin inicio de sesión, y `buoh_ingesta`, `buoh_salud` y `buoh_agente`, con él,
 *    ninguno con `CREATEROLE`; sus pertenencias, y los límites de `buoh_agente`. Sin contraseña: la
 *    pone `setRolePassword`.
 *
 * Un rol que ya existía vuelve a tener esos atributos (`ALTER ROLE`). Los que solo puede cambiar un
 * superusuario, como `SUPERUSER` o `BYPASSRLS`, no se tocan.
 */
export async function ensureRuntimeRoles(client: Client): Promise<void> {
  await inTransaction(client, async () => {
    const owner = ident(POSTGRES_ROLES.owner);
    await ensureRole(client, POSTGRES_ROLES.owner);
    const { rows: member } = await client.query<{ can_set: boolean }>(
      "SELECT pg_has_role(current_user, $1, 'SET') AS can_set",
      [POSTGRES_ROLES.owner],
    );
    if (member[0]?.can_set !== true) {
      await client.query(`GRANT ${owner} TO CURRENT_USER WITH SET TRUE`);
    }
    const { rows } = await client.query<{ allowed: boolean }>(
      "SELECT has_database_privilege($1, current_database(), 'CREATE') AS allowed",
      [POSTGRES_ROLES.owner],
    );
    if (rows[0]?.allowed !== true) {
      const { rows: names } = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      await client.query(`GRANT CREATE ON DATABASE ${ident(names[0]?.name ?? '')} TO ${owner}`);
    }
    await client.query(`SET LOCAL ROLE ${owner}`);
    const reader = ident(POSTGRES_ROLES.reader);
    for (const role of [POSTGRES_ROLES.reader, ...LOGIN_ROLES]) {
      await ensureRole(client, role);
    }
    for (const role of [POSTGRES_ROLES.health, POSTGRES_ROLES.agent]) {
      await client.query(`GRANT ${reader} TO ${ident(role)}`);
    }
    const agent = ident(POSTGRES_ROLES.agent);
    await client.query(`ALTER ROLE ${agent} CONNECTION LIMIT ${String(AGENT_CONNECTION_LIMIT)}`);
    await client.query(
      `ALTER ROLE ${agent} SET statement_timeout = ${pg.escapeLiteral(AGENT_STATEMENT_TIMEOUT)}`,
    );
    await client.query(
      `ALTER ROLE ${agent} SET idle_in_transaction_session_timeout = ${pg.escapeLiteral(AGENT_IDLE_IN_TRANSACTION_TIMEOUT)}`,
    );
  });
}

/**
 * Da a los roles de ejecución sus privilegios en el esquema de un log (ADR-0018 §8), en una
 * transacción y como `buoh_dueno`, el dueño de sus tablas. Es idempotente.
 * - `buoh_lectura`: uso del esquema y `SELECT` en todas sus tablas.
 * - `buoh_ingesta`: uso del esquema, `SELECT` e `INSERT` en `INGEST_WRITE_TABLES`, `SELECT` en la
 *   tabla de migraciones y uso de las secuencias; nada en `INGEST_DENIED_TABLES`.
 *
 * Antes comprueba que cada tabla del esquema esté en una de esas listas: una tabla nueva sin
 * privilegios decididos lanza `UnclassifiedTableError` sin dar ninguno.
 */
export async function grantLogPrivileges(client: Client, schema: string): Promise<void> {
  assertIdentifier(schema, 'El esquema');
  const known = new Set<string>([
    MIGRATIONS_TABLE,
    ...INGEST_WRITE_TABLES,
    ...INGEST_DENIED_TABLES,
  ]);
  await inTransaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${ident(POSTGRES_ROLES.owner)}`);
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema],
    );
    const unknown = rows.find((row) => !known.has(row.table_name));
    if (unknown !== undefined) {
      throw new UnclassifiedTableError(unknown.table_name);
    }
    const present = new Set(rows.map((row) => row.table_name));
    const s = ident(schema);
    const ingest = ident(POSTGRES_ROLES.ingest);
    const reader = ident(POSTGRES_ROLES.reader);
    await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${ingest}, ${reader}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${reader}`);
    for (const table of INGEST_WRITE_TABLES) {
      if (present.has(table)) {
        await client.query(`GRANT SELECT, INSERT ON ${s}.${ident(table)} TO ${ingest}`);
      }
    }
    if (present.has(MIGRATIONS_TABLE)) {
      await client.query(`GRANT SELECT ON ${s}.${ident(MIGRATIONS_TABLE)} TO ${ingest}`);
    }
    await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${ingest}`);
  });
}

/**
 * Crea el rol `buoh_api` o, si ya existe, le vuelve a fijar sus atributos (ADR-0019 §7): inicia
 * sesión y no crea roles. Lo crea `buoh_dueno` (`SET LOCAL ROLE`), que lo administra como a los
 * demás, en una transacción. Necesita `buoh_dueno` (`ensureRuntimeRoles`). Sin contraseña: la pone
 * `setRolePassword`. Es idempotente.
 */
export async function ensureApiRole(client: Client): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${ident(POSTGRES_ROLES.owner)}`);
    await ensureRole(client, API_ROLE);
  });
}

/**
 * Da a `buoh_api` sus privilegios en el esquema de la API (ADR-0019 §7), en una transacción y como
 * `buoh_dueno`, el dueño de sus tablas: uso del esquema, `SELECT` e `INSERT` en cada tabla, solo
 * `SELECT` en la de migraciones, para que no pueda anotar una migración, y uso de las secuencias.
 * Nada más: ni `UPDATE`, ni `DELETE`, ni `TRUNCATE`, ni crear objetos. `buoh_lectura` no recibe
 * nada. Es idempotente, y una tabla nueva de la API recibe sus privilegios en la ejecución que la
 * migra.
 */
export async function grantApiPrivileges(client: Client): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${ident(POSTGRES_ROLES.owner)}`);
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [API_SCHEMA],
    );
    const s = ident(API_SCHEMA);
    const api = ident(API_ROLE);
    await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${api}`);
    for (const { table_name: table } of rows) {
      const privileges = table === MIGRATIONS_TABLE ? 'SELECT' : 'SELECT, INSERT';
      await client.query(`GRANT ${privileges} ON ${s}.${ident(table)} TO ${api}`);
    }
    await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${api}`);
  });
}

/** Las iteraciones del verificador SCRAM, las de PostgreSQL por defecto. */
export const SCRAM_ITERATIONS = 4096;

/**
 * El verificador SCRAM-SHA-256 de una contraseña, con el formato que guarda PostgreSQL
 * (`SCRAM-SHA-256$<iteraciones>:<sal>$<StoredKey>:<ServerKey>`, RFC 5802 y RFC 7677). Así la
 * contraseña nunca viaja ni queda en claro en el servidor: `ALTER ROLE` recibe el verificador. Solo
 * admite ASCII imprimible sin espacios, como las contraseñas que genera Render, para no depender de
 * SASLprep, que no cambia esos caracteres.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  if (!/^[\x21-\x7e]+$/u.test(password)) {
    throw new TypeError('La contraseña debe ser de caracteres ASCII imprimibles, sin espacios.');
  }
  if (salt.length < 16 || !Number.isSafeInteger(iterations) || iterations < 4096) {
    throw new TypeError('La sal debe tener al menos 16 bytes y las iteraciones ser 4096 o más.');
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** La longitud mínima de la contraseña de un rol de ejecución. Las de Render tienen 44 caracteres. */
export const MIN_ROLE_PASSWORD_LENGTH = 16;

/**
 * Pone la contraseña de un rol de ejecución que inicia sesión, o la de `buoh_api` (ADR-0019 §7),
 * como `buoh_dueno`, que los administra (ADR-0018 §8). Envía el verificador SCRAM calculado aquí,
 * nunca la contraseña.
 */
export async function setRolePassword(
  client: Client,
  role: PasswordRole,
  password: string,
): Promise<void> {
  if (![...LOGIN_ROLES, API_ROLE].includes(role)) {
    throw new TypeError(`${role} no es un rol que inicia sesión.`);
  }
  if (password.length < MIN_ROLE_PASSWORD_LENGTH) {
    throw new TypeError(
      `La contraseña de un rol de ejecución debe tener al menos ${String(MIN_ROLE_PASSWORD_LENGTH)} caracteres.`,
    );
  }
  const verifier = scramSha256Verifier(password);
  await inTransaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${ident(POSTGRES_ROLES.owner)}`);
    await client.query(`ALTER ROLE ${ident(role)} PASSWORD ${pg.escapeLiteral(verifier)}`);
  });
}
