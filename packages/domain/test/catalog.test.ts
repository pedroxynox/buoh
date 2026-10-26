import { readFileSync } from 'node:fs';

import { rawSourceFrameSchema, sha256Hex, sourceCatalogSnapshotSchema } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  checkRequestedResponse,
  compileSourceSchema,
  createCatalogResponseSchema,
  deriveCatalogSnapshot,
  deriveRequestedResponseIncident,
  parseJsonPreservingNumbers,
  type RequestedResponseInvalidReason,
} from '../src/index.js';

// Conversión de la respuesta de `active_symbols` en `SourceCatalogSnapshot` y respuestas pedidas
// (contratos de dominio, «SourceCatalogSnapshot» e «Incidencias de respuestas pedidas»; ADR-0012
// §6 y §7).
//
// El esquema de respuesta y los catálogos son sintéticos: el esquema lo escribió buoh con los campos
// que lee (el repositorio de esquemas de Deriv no tiene licencia), y los códigos son inventados.
// Los hashes esperados se calcularon fuera del código, con Python, igual que en
// packages/contracts/test/source-catalog.test.ts:
//   jcs = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
const SCHEMA_SHA256 = '12ab45b713b3df7563e4f075477716a951239983fffc472c17a4137a62c7ab1b';
// Las mismas tres entradas que el fixture de contratos, así que su hash de contenido es el mismo.
const CONTENT_SHA256 = '61998c161db0da302eb8cc7ecc7b758b1893307fbff3a113cb0d2886901f9a00';
const CATALOG_PAYLOAD =
  '{"active_symbols":[{"exchange_is_open":0,"is_trading_suspended":1,"market":"forex","pip_size":0.00001,"subgroup":"none","submarket":"major_pairs","trade_count":250,"underlying_symbol":"SYNTH_FX","underlying_symbol_name":"Synthetic FX Pair","underlying_symbol_type":"forex"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.01,"subgroup":"synthetics","submarket":"random_index","trade_count":1200,"underlying_symbol":"SYNTH_100","underlying_symbol_name":"Synthetic 100 Index","underlying_symbol_type":"stockindex"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.001,"subgroup":"synthetics","submarket":"random_index","trade_count":900,"underlying_symbol":"SYNTH_10","underlying_symbol_name":"Synthetic 10 Index","underlying_symbol_type":"stockindex"}],"echo_req":{"active_symbols":"brief","req_id":1},"msg_type":"active_symbols","req_id":1}';
const CATALOG_RAW_SHA256 = '76e3d4e7d035cc58030b4be4d3561969305ed4a0500b28ad58576bc9c8e4985e';
const SNAPSHOT_ID = 'sha256:0b6051bf50265c3c4e7fb21f233b02055ff64684ea2a8261b64f2b3d5d9217a6';
const EMPTY_PAYLOAD =
  '{"active_symbols":[],"echo_req":{"active_symbols":"brief","req_id":2},"msg_type":"active_symbols","req_id":2}';
const EMPTY_RAW_SHA256 = 'ebd74416b301543a17c3f1cb287d20a32db5304371687afe01a56280a2c8acc9';
const EMPTY_INCIDENT_ID = 'sha256:d8302c0178dfddfaf03ae340fa5625d1d932b419332db487c688a477da3c5c69';

const schemaBytes = readFileSync(
  new URL('./fixtures/catalog-response.schema.json', import.meta.url),
);
const schema = createCatalogResponseSchema({
  source_schema_bytes: schemaBytes,
  source_schema_release: 'synthetic-catalog-v1',
});

function frame(
  payload: string,
  sequence = 1,
  receivedAt = `2026-01-01T00:00:0${String(sequence - 1)}.100Z`,
) {
  return rawSourceFrameSchema.parse({
    connection_id: '019b76da-a800-7000-8000-00000000a000',
    connector_version: 'fixture-v1',
    kind: 'raw_source_frame',
    observation_id: `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`,
    payload_utf8: payload,
    raw_payload_sha256: sha256Hex(payload),
    received_at_utc: receivedAt,
    schema_version: '1.0.0',
    source: 'synthetic',
  });
}

/** Entrada sintética como texto JSON, con los diez campos que manda la fuente. */
function entry(code: string, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    exchange_is_open: '1',
    is_trading_suspended: '0',
    market: '"synthetic_index"',
    pip_size: '0.01',
    subgroup: '"synthetics"',
    submarket: '"random_index"',
    trade_count: '100',
    underlying_symbol: JSON.stringify(code),
    underlying_symbol_name: JSON.stringify(`${code} Index`),
    underlying_symbol_type: '"stockindex"',
    ...overrides,
  };
  return `{${Object.entries(fields)
    .map(([key, value]) => `"${key}":${value}`)
    .join(',')}}`;
}

/** Respuesta de catálogo como texto JSON; `extra` se añade al final del objeto raíz. */
function response(entries: readonly string[] | null, extra = ''): string {
  const list = entries === null ? '' : `"active_symbols":[${entries.join(',')}],`;
  return `{${list}"echo_req":{"active_symbols":"brief","req_id":1},"msg_type":"active_symbols","req_id":1${extra}}`;
}

const reasonOf = (payload: string) => {
  const result = deriveCatalogSnapshot(frame(payload), schema);
  return result.ok ? 'ok' : result.reason;
};

describe('createCatalogResponseSchema', () => {
  it('identifica el esquema con el SHA-256 de su JCS', () => {
    expect(schema.sha256).toBe(SCHEMA_SHA256);
    expect(schema.release).toBe('synthetic-catalog-v1');
  });

  it('exige release y un `$schema` admitido', () => {
    expect(() =>
      createCatalogResponseSchema({ source_schema_bytes: schemaBytes, source_schema_release: '' }),
    ).toThrow(/source_schema_release/u);
    expect(() =>
      createCatalogResponseSchema({
        source_schema_bytes: Buffer.from('{"type":"object"}'),
        source_schema_release: 'x',
      }),
    ).toThrow(/\$schema/u);
  });
});

describe('deriveCatalogSnapshot', () => {
  it('convierte una respuesta válida en el snapshot esperado', () => {
    const result = deriveCatalogSnapshot(frame(CATALOG_PAYLOAD), schema);

    expect(result).toEqual({
      ok: true,
      snapshot: {
        catalog_format: 'deriv_active_symbols',
        catalog_normalizer_version: '1.0.0',
        connector_version: 'fixture-v1',
        content_sha256: CONTENT_SHA256,
        // Ordenadas por código, sin `trade_count`, con los lexemas de `pip_size` recibidos.
        entries: [
          {
            exchange_is_open: 1,
            is_trading_suspended: 0,
            market: 'synthetic_index',
            pip_size: '0.001',
            subgroup: 'synthetics',
            submarket: 'random_index',
            underlying_symbol: 'SYNTH_10',
            underlying_symbol_name: 'Synthetic 10 Index',
            underlying_symbol_type: 'stockindex',
          },
          {
            exchange_is_open: 1,
            is_trading_suspended: 0,
            market: 'synthetic_index',
            pip_size: '0.01',
            subgroup: 'synthetics',
            submarket: 'random_index',
            underlying_symbol: 'SYNTH_100',
            underlying_symbol_name: 'Synthetic 100 Index',
            underlying_symbol_type: 'stockindex',
          },
          {
            exchange_is_open: 0,
            is_trading_suspended: 1,
            market: 'forex',
            pip_size: '0.00001',
            subgroup: 'none',
            submarket: 'major_pairs',
            underlying_symbol: 'SYNTH_FX',
            underlying_symbol_name: 'Synthetic FX Pair',
            underlying_symbol_type: 'forex',
          },
        ],
        entry_count: 3,
        observation_id: '019b76da-a800-7000-8000-000000000001',
        raw_payload_sha256: CATALOG_RAW_SHA256,
        received_at_utc: '2026-01-01T00:00:00.100Z',
        schema_version: '1.0.0',
        snapshot_id: SNAPSHOT_ID,
        source: 'synthetic',
        source_schema_release: 'synthetic-catalog-v1',
        source_schema_sha256: SCHEMA_SHA256,
      },
    });
    if (result.ok) {
      expect(sourceCatalogSnapshotSchema.safeParse(result.snapshot).success).toBe(true);
    }
  });

  it('es pura: el mismo frame da siempre el mismo snapshot', () => {
    expect(deriveCatalogSnapshot(frame(CATALOG_PAYLOAD), schema)).toEqual(
      deriveCatalogSnapshot(frame(CATALOG_PAYLOAD), schema),
    );
  });

  it('`trade_count` no cambia la versión; un indicador de mercado, sí', () => {
    const content = (payload: string, sequence: number) => {
      const result = deriveCatalogSnapshot(frame(payload, sequence), schema);
      return result.ok ? result.snapshot.content_sha256 : result.reason;
    };
    const base = [entry('SYNTH_A'), entry('SYNTH_B')];

    expect(content(response(base), 1)).toBe(
      content(response([entry('SYNTH_A', { trade_count: '999' }), entry('SYNTH_B')]), 2),
    );
    expect(content(response(base), 1)).not.toBe(
      content(response([entry('SYNTH_A', { exchange_is_open: '0' }), entry('SYNTH_B')]), 3),
    );
  });

  it('ordena por unidades UTF-16, no por el orden del idioma', () => {
    // 'X' (0x58) va antes que '_' (0x5F): SYNTHX es el primero, aunque `localeCompare` lo pondría
    // después de SYNTH_10.
    expect('SYNTHX'.localeCompare('SYNTH_10')).toBeGreaterThan(0);
    const result = deriveCatalogSnapshot(
      frame(response([entry('SYNTH_10'), entry('SYNTHX'), entry('SYNTH_FX')])),
      schema,
    );

    expect(result.ok && result.snapshot.entries.map((item) => item.underlying_symbol)).toEqual([
      'SYNTHX',
      'SYNTH_10',
      'SYNTH_FX',
    ]);
  });

  it('conserva el lexema de `pip_size`, incluido un cero final', () => {
    const result = deriveCatalogSnapshot(
      frame(response([entry('SYNTH_A', { pip_size: '0.010' })])),
      schema,
    );

    expect(result.ok && result.snapshot.entries[0]?.pip_size).toBe('0.010');
    expect(reasonOf(response([entry('SYNTH_A', { pip_size: '0.010' })]))).toBe('ok');
  });

  it('da el motivo de la primera comprobación que falla, en el orden del contrato', () => {
    const error = ',"error":{"code":"SyntheticError","message":"x"}';
    const cases: readonly (readonly [string, RequestedResponseInvalidReason | 'ok', string])[] = [
      // 1. Un objeto `error`, aunque el resto también falle.
      ['error', 'source_error_response', response([entry('SYNTH_A')], error)],
      // Solo cuenta un objeto `error`, como en las reglas 2.0.0: un texto no es un error de la
      // fuente, y el esquema admite campos extra en la raíz.
      ['error que no es objeto', 'ok', response([entry('SYNTH_A')], ',"error":"boom"')],
      [
        'error y otro msg_type',
        'source_error_response',
        response([entry('SYNTH_A')], error).replace(
          '"msg_type":"active_symbols"',
          '"msg_type":"ping"',
        ),
      ],
      ['error y lista vacía', 'source_error_response', response([], error)],
      // 2. El esquema de respuesta fijado.
      [
        'otro msg_type',
        'schema_validation_failed',
        CATALOG_PAYLOAD.replace('"msg_type":"active_symbols"', '"msg_type":"ping"'),
      ],
      [
        'esquema y exponente',
        'schema_validation_failed',
        response([entry('SYNTH_A', { pip_size: '1e-3', trade_count: '"x"' })]),
      ],
      // 3. La lista falta, no es una lista o está vacía.
      ['sin lista', 'catalog_empty', response(null)],
      ['lista vacía', 'catalog_empty', response([])],
      // 4. Un `pip_size` con exponente, aunque también se repita un código.
      [
        'exponente y repetido',
        'catalog_exponent_not_supported',
        response([entry('SYNTH_A', { pip_size: '1e-3' }), entry('SYNTH_A')]),
      ],
      [
        'exponente en mayúscula',
        'catalog_exponent_not_supported',
        response([entry('SYNTH_A', { pip_size: '1E-3' })]),
      ],
      // 5. Una entrada que no cumple el contrato: un código vacío.
      [
        'código vacío y repetido',
        'catalog_entry_invalid',
        response([entry(''), entry(''), entry('SYNTH_A')]),
      ],
      // 6. Un código repetido.
      ['repetido', 'catalog_duplicate_symbol', response([entry('SYNTH_A'), entry('SYNTH_A')])],
    ];

    for (const [label, reason, payload] of cases) {
      expect(reasonOf(payload), label).toBe(reason);
    }
  });

  it('una lista que no es lista cuenta como catálogo vacío, aunque el esquema no la tipe', () => {
    // El esquema fijado tipa la lista; este esquema laxo permite probar la comprobación 3 sola.
    const lax = createCatalogResponseSchema({
      source_schema_bytes: Buffer.from(
        JSON.stringify({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }),
      ),
      source_schema_release: 'lax',
    });
    const result = deriveCatalogSnapshot(
      frame(
        '{"active_symbols":{},"echo_req":{"active_symbols":"brief","req_id":1},"msg_type":"active_symbols","req_id":1}',
      ),
      lax,
    );

    expect(result).toEqual({ ok: false, reason: 'catalog_empty' });
  });

  it('lanza si el frame no es JSON: solo convierte respuestas ya correlacionadas', () => {
    expect(() => deriveCatalogSnapshot(frame('no es json'), schema)).toThrow(TypeError);
    // El lector estricto también rechaza claves duplicadas, que `JSON.parse` aceptaría.
    expect(() => deriveCatalogSnapshot(frame(response([], ',"req_id":3')), schema)).toThrow(
      TypeError,
    );
  });
});

describe('respuestas pedidas', () => {
  const ping = compileSourceSchema({
    $schema: 'http://json-schema.org/draft-04/schema#',
    type: 'object',
    required: ['echo_req', 'msg_type'],
    properties: {
      echo_req: { type: 'object' },
      msg_type: { type: 'string', enum: ['ping'] },
      ping: { type: 'string' },
    },
  });
  const check = (payload: string) =>
    checkRequestedResponse(parseJsonPreservingNumbers(payload), ping);

  it('comprueba primero un objeto `error` y después el esquema de la operación', () => {
    expect(check('{"echo_req":{"ping":1},"msg_type":"ping","ping":"pong"}')).toBeNull();
    expect(
      check('{"echo_req":{"ping":1},"error":{"code":"X","message":"y"},"msg_type":"ping"}'),
    ).toBe('source_error_response');
    expect(check('{"echo_req":{"ping":1},"msg_type":"time","time":1}')).toBe(
      'schema_validation_failed',
    );
  });

  it('deriva la incidencia del frame durable y el motivo', () => {
    const incident = deriveRequestedResponseIncident(
      frame(EMPTY_PAYLOAD, 2, '2026-01-01T00:00:01.100Z'),
      'catalog_empty',
    );

    expect(incident).toEqual({
      evidence: { raw_payload_sha256: EMPTY_RAW_SHA256, reason: 'catalog_empty' },
      incident_id: EMPTY_INCIDENT_ID,
      incident_type: 'invalid_source_frame',
      observed_at_utc: '2026-01-01T00:00:01.100Z',
      observed_ref: '019b76da-a800-7000-8000-000000000002',
      quality_rule_version: '2.0.0',
      related_refs: [],
      schema_version: '2.0.0',
      severity: 'error',
      source: 'synthetic',
      symbol: null,
    });
  });
});
