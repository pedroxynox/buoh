import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rawSourceFrameSchema, sha256Hex } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildDatasetPublication,
  compileSourceSchema,
  createPipelineProfile,
  deriveMarketData,
  normalizeRawFrame,
  publicationThresholds,
  sourceSchemaDialect,
} from '../src/index.js';

// Validador por dialecto y perfil de medición (contratos de dominio, «Validador del esquema de
// fuente» y «Perfil de medición»; ADR-0012 §2 y §8). Los esquemas son sintéticos, escritos para
// estas pruebas: buoh no copia los de Deriv, cuyo repositorio no tiene licencia (ADR-0012).
const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');
const DRAFT_04 = 'http://json-schema.org/draft-04/schema#';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Esquema draft-04 de un tick, con `examples` como anotación (como en la release de Deriv) y una
 * regla propia de draft-04: `exclusiveMinimum` booleano, que en 2020-12 sería un error de esquema.
 */
function draft04TickSchema(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: DRAFT_04,
    type: 'object',
    required: ['msg_type', 'tick'],
    properties: {
      msg_type: { type: 'string', enum: ['tick'] },
      tick: {
        type: 'object',
        additionalProperties: false,
        required: ['epoch', 'pip_size', 'quote', 'symbol'],
        properties: {
          epoch: { type: 'integer', minimum: 0, exclusiveMinimum: true },
          id: { type: 'string', examples: ['abc'] },
          pip_size: { type: 'integer', minimum: 0, maximum: 18 },
          quote: { type: 'number' },
          symbol: { type: 'string', enum: ['SYNTH_100'] },
        },
      },
    },
    ...extra,
  };
}

function profileBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      allowed_symbols: ['SYNTH_100'],
      gap_detection: 'after_reconnection',
      maximum_delivery_delay_ms: 2000,
      maximum_event_gap_ms: 2000,
      non_tick_msg_types: ['ping'],
      profile_id: 'test-profile',
      quality_rule_version: '2.0.0',
      source: 'synthetic',
      ...overrides,
    }),
  );
}

/** Perfil de medición: reglas 2.0.0, sin umbrales. */
function measurementBytes(overrides: Record<string, unknown> = {}): Buffer {
  const profile = JSON.parse(profileBytes().toString('utf8')) as Record<string, unknown>;
  delete profile['maximum_delivery_delay_ms'];
  delete profile['maximum_event_gap_ms'];
  return Buffer.from(JSON.stringify({ ...profile, purpose: 'measurement', ...overrides }));
}

function profileWith(schema: Record<string, unknown>, quality: Buffer = profileBytes()) {
  return createPipelineProfile({
    connector_version: 'fixture-v1',
    quality_profile_bytes: quality,
    source_schema_bytes: Buffer.from(JSON.stringify(schema)),
    source_schema_release: 'test',
  });
}

function raw(payload: string) {
  return rawSourceFrameSchema.parse({
    connection_id: '019b76da-a800-7000-8000-00000000a000',
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: '019b76da-a800-7000-8000-000000000001',
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: '2026-01-01T00:00:00.100Z',
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

const tick = (epoch: number) =>
  `{"msg_type":"tick","tick":{"epoch":${String(epoch)},"pip_size":2,"quote":100.25,"symbol":"SYNTH_100"}}`;

describe('validador del esquema de fuente por dialecto', () => {
  it('reconoce solo los dos `$schema` admitidos, escritos exactamente', () => {
    expect(sourceSchemaDialect({ $schema: DRAFT_04 })).toBe('draft-04');
    expect(sourceSchemaDialect({ $schema: DRAFT_2020_12 })).toBe('2020-12');
    for (const declared of [
      undefined,
      'http://json-schema.org/draft-04/schema',
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema#',
    ]) {
      expect(() => sourceSchemaDialect({ $schema: declared }), String(declared)).toThrow(
        /\$schema/u,
      );
    }
    expect(() => sourceSchemaDialect([])).toThrow(/\$schema/u);
  });

  it('valida un esquema draft-04 con sus reglas, no con las de 2020-12', () => {
    const profile = profileWith(draft04TickSchema());

    expect(normalizeRawFrame(raw(tick(1767225600)), profile)).toMatchObject({ ok: true });
    // `exclusiveMinimum: true` de draft-04 excluye el 0.
    expect(normalizeRawFrame(raw(tick(0)), profile)).toEqual({
      ok: false,
      reason: 'schema_validation_failed',
      symbol: 'SYNTH_100',
    });
    // El mismo documento declarado como 2020-12 no compila: allí `exclusiveMinimum` es un número.
    expect(() => compileSourceSchema({ ...draft04TickSchema(), $schema: DRAFT_2020_12 })).toThrow(
      /exclusiveMinimum/u,
    );
  });

  it('en draft-04 admite solo `auth_required` y `examples` como anotación', () => {
    expect(() => profileWith(draft04TickSchema({ auth_required: 0 }))).not.toThrow();
    expect(() => profileWith(draft04TickSchema({ x_buoh: 1 }))).toThrow(/x_buoh/u);
  });

  it('en 2020-12 también es estricto y no admite las anotaciones de Deriv', () => {
    const base = { $schema: DRAFT_2020_12, type: 'object' };

    expect(() => compileSourceSchema(base)).not.toThrow();
    expect(() => compileSourceSchema({ ...base, x_buoh: 1 })).toThrow(/x_buoh/u);
    expect(() => compileSourceSchema({ ...base, auth_required: 0 })).toThrow(/auth_required/u);
  });

  it('el esquema de los vectores (2020-12) sigue igual, con su hash', () => {
    const profile = createPipelineProfile({
      connector_version: 'fixture-v1',
      quality_profile_bytes: readFileSync(resolve(vectorRoot, 'quality-profile.json')),
      source_schema_bytes: readFileSync(resolve(vectorRoot, 'source-schema.json')),
      source_schema_release: 'synthetic-v1',
    });
    // El manifiesto firmado de los vectores declara el SHA-256 del JCS de cada documento.
    const manifest = JSON.parse(readFileSync(resolve(vectorRoot, 'manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly jcs_sha256?: string; readonly path: string }[];
    };
    const jcsSha256 = (path: string) =>
      manifest.files.find((file) => file.path === path)?.jcs_sha256;

    expect(profile.purpose).toBe('publication');
    expect(profile.source_schema_sha256).toBe(jcsSha256('source-schema.json'));
    expect(profile.quality_profile_sha256).toBe(jcsSha256('quality-profile.json'));
    expect(publicationThresholds(profile)).toEqual({
      maximum_delivery_delay_ms: 2000,
      maximum_event_gap_ms: 2000,
    });
  });
});

describe('perfil de medición', () => {
  const schema = draft04TickSchema();

  it('normaliza ticks igual que un perfil de publicación', () => {
    const measurement = profileWith(schema, measurementBytes());

    expect(measurement.purpose).toBe('measurement');
    expect(normalizeRawFrame(raw(tick(1767225600)), measurement)).toEqual(
      normalizeRawFrame(raw(tick(1767225600)), profileWith(schema)),
    );
  });

  it('deriva el estado vivo, pero nunca publica un dataset (ADR-0015 §2)', () => {
    const measurement = profileWith(schema, measurementBytes());
    const segments = [[raw(tick(1767225600))]];

    expect(() => publicationThresholds(measurement)).toThrow(/de medición/u);
    expect(deriveMarketData(segments, measurement).ticks).toHaveLength(1);
    expect(() =>
      buildDatasetPublication({
        locateManifest: () => 'memory://manifest',
        locateObject: () => 'memory://object',
        profile: measurement,
        publication_id: '019b76da-a800-7000-8000-00000000b000',
        published_at_utc: '2026-01-01T00:01:00.000Z',
        segments,
      }),
    ).toThrow(/de medición/u);
    // Con un perfil de publicación, la misma derivación da lo mismo.
    expect(deriveMarketData(segments, profileWith(schema)).ticks).toEqual(
      deriveMarketData(segments, measurement).ticks,
    );
  });

  it('no lleva umbrales, usa reglas 2.0.0 y solo admite `purpose: "measurement"`', () => {
    expect(() =>
      profileWith(schema, measurementBytes({ maximum_delivery_delay_ms: 2000 })),
    ).toThrow();
    expect(() => profileWith(schema, measurementBytes({ maximum_event_gap_ms: 2000 }))).toThrow();
    expect(() =>
      profileWith(
        schema,
        measurementBytes({ non_tick_msg_types: undefined, quality_rule_version: '1.0.0' }),
      ),
    ).toThrow(/reglas 2\.0\.0/u);
    expect(() => profileWith(schema, measurementBytes({ purpose: 'publication' }))).toThrow();
    // Sin `purpose`, un perfil de publicación sigue exigiendo sus dos umbrales.
    const withoutThresholds = JSON.parse(measurementBytes().toString('utf8')) as Record<
      string,
      unknown
    >;
    delete withoutThresholds['purpose'];
    expect(() => profileWith(schema, Buffer.from(JSON.stringify(withoutThresholds)))).toThrow();
  });
});
