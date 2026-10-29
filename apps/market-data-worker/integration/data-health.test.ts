import { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DERIV_SOURCE } from '../src/deriv/profile.js';
import { createPool, loadConfig, migrate, openStores, type WorkerConfig } from '../src/index.js';

/**
 * `data:health` (ADR-0015 §8) contra PostgreSQL y S3-compatible locales. Nunca sale a la red ni a
 * Deriv (ADR-0015 §11). Esquema PostgreSQL propio, recreado en cada ejecución.
 */
const SCHEMA = 'buoh_integration_health';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  await migrate(stores.pool);
});

afterAll(async () => {
  await stores.close();
  await admin.end();
});

function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

/**
 * Un dataset visible de `source`, con un core sintético (`label`) y su record en `environment`. La
 * base comprueba que `dataset_id` es el SHA-256 de su core (migración `0001`).
 */
async function published(input: {
  readonly environment: 'development' | 'test';
  readonly label: string;
  readonly publication: number;
  readonly publishedAt: string;
  readonly source: string;
  readonly state?: 'active' | 'superseded';
}): Promise<string> {
  const { rows } = await stores.pool.query<{ dataset_id: string }>(
    `INSERT INTO datasets (dataset_id, state, source, manifest_core_jcs)
     VALUES ('sha256:' || encode(sha256(convert_to($2, 'UTF8')), 'hex'), 'published', $1, $2)
     RETURNING dataset_id`,
    [input.source, JSON.stringify({ prueba: input.label })],
  );
  const datasetId = rows[0]?.dataset_id;
  if (datasetId === undefined) {
    throw new TypeError('El dataset no devolvió su ID.');
  }
  await stores.pool.query(
    `INSERT INTO published_manifest_records
       (publication_id, deployment_environment, dataset_id, schema_version,
        manifest_document_sha256, manifest_object_uri, manifest_object_bytes_sha256,
        published_at_utc, state)
     VALUES ($1, $2, $3, '1.0.0', $4, 's3://buoh-sintetico/manifests/prueba.json', $4, $5, $6)`,
    [
      uuid(input.publication),
      input.environment,
      datasetId,
      '0'.repeat(64),
      input.publishedAt,
      input.state ?? 'active',
    ],
  );
  return datasetId;
}

describe('PostgresMetadataStore.lastActiveDatasetId (ADR-0015 §8, «Entradas»)', () => {
  it('da el dataset_id del último record activo de la fuente en el entorno, por hora de publicación y después por publication_id, o null', async () => {
    const last = () => stores.metadata.lastActiveDatasetId(DERIV_SOURCE, 'test');
    expect(await last()).toBeNull();

    const first = await published({
      environment: 'test',
      label: 'primero',
      publication: 1,
      publishedAt: '2026-03-02T10:00:00.000Z',
      source: DERIV_SOURCE,
    });
    expect(await last()).toBe(first);

    // Más tardíos, pero de otra fuente, de otro entorno o ya no activos: no cuentan.
    await published({
      environment: 'test',
      label: 'otra fuente',
      publication: 2,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: 'synthetic',
    });
    await published({
      environment: 'development',
      label: 'otro entorno',
      publication: 3,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: DERIV_SOURCE,
    });
    await published({
      environment: 'test',
      label: 'reemplazado',
      publication: 4,
      publishedAt: '2026-03-02T11:00:00.000Z',
      source: DERIV_SOURCE,
      state: 'superseded',
    });
    expect(await last()).toBe(first);

    // Uno publicado después, y otro a la misma hora con un publication_id mayor.
    await published({
      environment: 'test',
      label: 'segundo',
      publication: 6,
      publishedAt: '2026-03-02T10:30:00.000Z',
      source: DERIV_SOURCE,
    });
    const tied = await published({
      environment: 'test',
      label: 'empatado',
      publication: 7,
      publishedAt: '2026-03-02T10:30:00.000Z',
      source: DERIV_SOURCE,
    });
    expect(await last()).toBe(tied);
  });
});
