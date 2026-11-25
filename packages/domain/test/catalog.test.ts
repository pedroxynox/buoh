import { readFileSync } from 'node:fs';

import { rawSourceFrameSchema, sha256Hex, sourceCatalogSnapshotSchema } from '@buoh/contracts';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_FIELDS_NO_LONGER_SENT,
  checkRequestedResponse,
  compileSourceSchema,
  createCatalogResponseSchema,
  deriveCatalogSnapshot,
  deriveRequestedResponseIncident,
  parseJsonPreservingNumbers,
  relaxCatalogResponseSchema,
  type RequestedResponseInvalidReason,
} from '../src/index.js';

// Conversión de la respuesta de `active_symbols` en `SourceCatalogSnapshot` y respuestas pedidas
// (contratos de dominio, «SourceCatalogSnapshot» e «Incidencias de respuestas pedidas»; ADR-0012
// §6 y §7).
//
// El esquema de respuesta y los catálogos son sintéticos: el esquema lo escribió buoh con los campos
// que lee (el repositorio de esquemas de Deriv no tiene licencia), y los códigos son inventados.
// Como la release fijada, el esquema exige `underlying_symbol_type`, que Deriv dejó de mandar el
// 2026-11-24. Los hashes esperados se calcularon fuera del código, con Python, igual que en
// packages/contracts/test/source-catalog.test.ts:
//   jcs = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
// El del esquema es el del documento sin ese campo en `required` de las entradas, el que valida;
// el del documento tal cual es otro.
const SCHEMA_SHA256 = '5d7278479ae2554d8122a14739bc013c83089b4acb6f4b6b9ec703a207c34057';
const FIXTURE_DOCUMENT_SHA256 = '12ab45b713b3df7563e4f075477716a951239983fffc472c17a4137a62c7ab1b';
// Las mismas tres entradas que el fixture 2.0.0 de contratos, así que su hash de contenido es el
// mismo.
const CONTENT_SHA256 = 'fb3de35f51ee2ebb1e2a20687289902a00f8f1124ec033e113a2b1a21c7a5406';
const CATALOG_PAYLOAD =
  '{"active_symbols":[{"exchange_is_open":0,"is_trading_suspended":1,"market":"forex","pip_size":0.00001,"subgroup":"none","submarket":"major_pairs","trade_count":250,"underlying_symbol":"SYNTH_FX","underlying_symbol_name":"Synthetic FX Pair","underlying_symbol_type":"forex"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.01,"subgroup":"synthetics","submarket":"random_index","trade_count":1200,"underlying_symbol":"SYNTH_100","underlying_symbol_name":"Synthetic 100 Index","underlying_symbol_type":"stockindex"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.001,"subgroup":"synthetics","submarket":"random_index","trade_count":900,"underlying_symbol":"SYNTH_10","underlying_symbol_name":"Synthetic 10 Index","underlying_symbol_type":"stockindex"}],"echo_req":{"active_symbols":"brief","req_id":1},"msg_type":"active_symbols","req_id":1}';
const CATALOG_RAW_SHA256 = '76e3d4e7d035cc58030b4be4d3561969305ed4a0500b28ad58576bc9c8e4985e';
const SNAPSHOT_ID = 'sha256:294601b56d9d74506d4ce4e8ca77d0798eb798386b86bd04e9e6dae3fc925ee1';
// El mismo catálogo sin `underlying_symbol_type`, como lo manda Deriv desde el 2026-11-24, recibido
// en la observación 2.
const CATALOG_PAYLOAD_WITHOUT_TYPE =
  '{"active_symbols":[{"exchange_is_open":0,"is_trading_suspended":1,"market":"forex","pip_size":0.00001,"subgroup":"none","submarket":"major_pairs","trade_count":250,"underlying_symbol":"SYNTH_FX","underlying_symbol_name":"Synthetic FX Pair"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.01,"subgroup":"synthetics","submarket":"random_index","trade_count":1200,"underlying_symbol":"SYNTH_100","underlying_symbol_name":"Synthetic 100 Index"},{"exchange_is_open":1,"is_trading_suspended":0,"market":"synthetic_index","pip_size":0.001,"subgroup":"synthetics","submarket":"random_index","trade_count":900,"underlying_symbol":"SYNTH_10","underlying_symbol_name":"Synthetic 10 Index"}],"echo_req":{"active_symbols":"brief","req_id":1},"msg_type":"active_symbols","req_id":1}';
const WITHOUT_TYPE_RAW_SHA256 = '57d6f78b771fd2ceb26945884b0caca94b0e9422129cecd26efd20c0563df951';
const WITHOUT_TYPE_SNAPSHOT_ID =
  'sha256:ffda02ee67ac2820a39cc5bfba50fb0276617376ef6c4042299dcb830d5a646c';
const EMPTY_PAYLOAD =
  '{"active_symbols":[],"echo_req":{"active_symbols":"brief","req_id":2},"msg_type":"active_symbols","req_id":2}';
const EMPTY_RAW_SHA256 = 'ebd74416b301543a17c3f1cb287d20a32db5304371687afe01a56280a2c8acc9';
const EMPTY_INCIDENT_ID = 'sha256:d8302c0178dfddfaf03ae340fa5625d1d932b419332db487c688a477da3c5c69';
// Página de historia con dos tiempos y un solo precio: incoherente (ADR-0015 §4).
const HISTORY_PAYLOAD =
  '{"echo_req":{"count":1000,"end":"1700000060","req_id":4,"start":1700000000,"style":"ticks","ticks_history":"SYNTH_100"},"history":{"prices":[100.25],"times":[1700000000,1700000060]},"msg_type":"history","pip_size":2,"req_id":4}';
const HISTORY_RAW_SHA256 = 'fd3cac80f18fdd2b58d8cf24c426609586c6e53360df8e6f853dc80271e0ba0e';
const HISTORY_INCIDENT_ID =
  'sha256:be2e333c19f4c5278112e0d313ce5be89a30a02d6ced42f5fef15e26211e967c';

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

/**
 * Entrada sintética como texto JSON, con los diez campos de la release fijada. Un campo con `null`
 * en `overrides` no va, como `underlying_symbol_type` desde el 2026-11-24.
 */
function entry(code: string, overrides: Record<string, string | null> = {}): string {
  const fields: Record<string, string | null> = {
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
    .flatMap(([key, value]) => (value === null ? [] : [`"${key}":${value}`]))
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
  it('identifica el esquema con el SHA-256 del JCS del documento con que valida', () => {
    expect(schema.sha256).toBe(SCHEMA_SHA256);
    expect(schema.sha256).not.toBe(FIXTURE_DOCUMENT_SHA256);
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
        catalog_normalizer_version: '2.0.0',
        connector_version: 'fixture-v1',
        content_sha256: CONTENT_SHA256,
        // Ordenadas por código, sin `trade_count` ni `underlying_symbol_type`, con los lexemas de
        // `pip_size` recibidos.
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
          },
        ],
        entry_count: 3,
        observation_id: '019b76da-a800-7000-8000-000000000001',
        raw_payload_sha256: CATALOG_RAW_SHA256,
        received_at_utc: '2026-01-01T00:00:00.100Z',
        schema_version: '2.0.0',
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

  it('sin `underlying_symbol_type`, como desde el 2026-11-24, da las mismas entradas', () => {
    const before = deriveCatalogSnapshot(frame(CATALOG_PAYLOAD), schema);
    const result = deriveCatalogSnapshot(
      frame(CATALOG_PAYLOAD_WITHOUT_TYPE, 2, '2026-01-01T00:00:01.100Z'),
      schema,
    );

    expect(result.ok).toBe(true);
    if (result.ok && before.ok) {
      expect(result.snapshot.raw_payload_sha256).toBe(WITHOUT_TYPE_RAW_SHA256);
      expect(result.snapshot.snapshot_id).toBe(WITHOUT_TYPE_SNAPSHOT_ID);
      expect(result.snapshot.content_sha256).toBe(CONTENT_SHA256);
      expect(result.snapshot.entries).toEqual(before.snapshot.entries);
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
      // Sin `underlying_symbol_type` vale, pero si llega sigue siendo texto, y una entrada sigue
      // sin admitir campos ajenos ni que falte otro campo que exige la release.
      ['sin tipo', 'ok', response([entry('SYNTH_A', { underlying_symbol_type: null })])],
      [
        'tipo que no es texto',
        'schema_validation_failed',
        response([entry('SYNTH_A', { underlying_symbol_type: '7' })]),
      ],
      ['campo ajeno', 'schema_validation_failed', response([entry('SYNTH_A', { spot: '"1.0"' })])],
      [
        'sin otro campo exigido',
        'schema_validation_failed',
        response([entry('SYNTH_A', { underlying_symbol_name: null })]),
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

describe('relaxCatalogResponseSchema', () => {
  const fixtureDocument = () => JSON.parse(schemaBytes.toString('utf8')) as Record<string, unknown>;
  const requiredOf = (document: unknown) =>
    (document as { properties: { active_symbols: { items: { required: unknown } } } }).properties
      .active_symbols.items.required;

  it('solo saca de `required` de las entradas los campos que Deriv ya no manda', () => {
    expect(CATALOG_FIELDS_NO_LONGER_SENT).toEqual(['underlying_symbol_type']);
    const document = fixtureDocument();
    const original = structuredClone(document);
    const relaxed = relaxCatalogResponseSchema(document as never);

    expect(requiredOf(relaxed)).toEqual([
      'exchange_is_open',
      'is_trading_suspended',
      'market',
      'pip_size',
      'subgroup',
      'submarket',
      'trade_count',
      'underlying_symbol',
      'underlying_symbol_name',
    ]);
    // Lo demás queda igual, también la descripción del campo, y el documento recibido no cambia.
    const expected = structuredClone(original);
    (requiredOf(expected) as string[]).pop();
    expect(relaxed).toEqual(expected);
    expect(document).toEqual(original);
  });

  it('sin esa ruta, o sin esos campos en ella, devuelve el mismo documento', () => {
    const lax = { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' };
    expect(relaxCatalogResponseSchema(lax)).toBe(lax);
    const document = fixtureDocument();
    const once = relaxCatalogResponseSchema(document as never);
    expect(relaxCatalogResponseSchema(once)).toBe(once);
    const noList = structuredClone(document) as never as {
      properties: { active_symbols: { items: Record<string, unknown> } };
    };
    delete noList.properties.active_symbols.items['required'];
    expect(relaxCatalogResponseSchema(noList as never)).toBe(noList);
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

  it('deriva igual la incidencia de una página de historia incoherente (history_inconsistent)', () => {
    const incident = deriveRequestedResponseIncident(
      frame(HISTORY_PAYLOAD, 4),
      'history_inconsistent',
    );

    expect(incident).toEqual({
      evidence: { raw_payload_sha256: HISTORY_RAW_SHA256, reason: 'history_inconsistent' },
      incident_id: HISTORY_INCIDENT_ID,
      incident_type: 'invalid_source_frame',
      observed_at_utc: '2026-01-01T00:00:03.100Z',
      observed_ref: '019b76da-a800-7000-8000-000000000004',
      quality_rule_version: '2.0.0',
      related_refs: [],
      schema_version: '2.0.0',
      severity: 'error',
      source: 'synthetic',
      symbol: null,
    });
  });
});
