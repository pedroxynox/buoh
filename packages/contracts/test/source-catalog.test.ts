import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  deriveCatalogContentSha256,
  deriveCatalogSnapshotId,
  sourceCatalogSnapshotSchema,
  type SourceCatalogSnapshot,
} from '../src/index.js';

// Casos derivados de los contratos de dominio («SourceCatalogSnapshot») y ADR-0012 §7.
//
// Los fixtures son sintéticos: códigos y nombres inventados, no datos de Deriv. El de la versión
// 2.0.0, la que deriva buoh desde la precisión del 2026-11-25 de ADR-0012 §7, tiene las mismas entradas que el de la 1.0.0 sin
// `underlying_symbol_type`. `source_schema_sha256` y `raw_payload_sha256` son marcadores, porque el
// contrato solo comprueba su formato. Los hashes de abajo se calcularon fuera del código, con
// Python, para no comprobar la implementación consigo misma. Para estos fixtures (solo textos ASCII
// y los enteros 0, 1 y 3), JCS coincide con
//   jcs = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
// y los hashes son:
//   content_sha256 = sha256(''.join(jcs(e) + '\n' for e in entries))
//   snapshot_id    = 'sha256:' + sha256(jcs(snapshot sin snapshot_id))
const CONTENT_SHA256 = 'fb3de35f51ee2ebb1e2a20687289902a00f8f1124ec033e113a2b1a21c7a5406';
const SNAPSHOT_ID = 'sha256:daafa559cbc7ef82197d58bd3596445690eae25408cd1764e6325c2b7f76e63d';
// El mismo catálogo recibido en otra observación (otro `observation_id` y otra hora).
const OTHER_OBSERVATION = {
  observation_id: '019b76da-a800-7000-8000-000000000002',
  received_at_utc: '2026-01-01T00:05:00.100Z',
} as const;
const SNAPSHOT_ID_OTHER_OBSERVATION =
  'sha256:83baee003ece8d7d8dc462594fa22f8279699f9a844741c812d7f9919cbe55a3';
// El fixture 1.0.0, con `underlying_symbol_type`, como los snapshots que guardó producción hasta
// el 2026-11-24.
const CONTENT_SHA256_V1 = '61998c161db0da302eb8cc7ecc7b758b1893307fbff3a113cb0d2886901f9a00';
const SNAPSHOT_ID_V1 = 'sha256:798f2b62fe4b048789a9d3f51ee3099b49300dfb87e9d448bedb7b4bc81ab51e';

const FIXTURES = {
  '1.0.0': './fixtures/source-catalog-snapshot.json',
  '2.0.0': './fixtures/source-catalog-snapshot-v2.json',
} as const;

function fixture(version: keyof typeof FIXTURES = '2.0.0'): SourceCatalogSnapshot {
  return JSON.parse(
    readFileSync(new URL(FIXTURES[version], import.meta.url), 'utf8'),
  ) as SourceCatalogSnapshot;
}

type Draft = Record<string, unknown> & { entries: Record<string, unknown>[] };

/**
 * Copia del fixture con un cambio de valor y sus hashes recalculados. Sirve para cambios de valor
 * que el contrato admite en su forma, como el orden o el conteo: el fallo solo puede venir de la
 * regla probada, y cada caso lo comprueba con la ruta del problema. Un campo ajeno se prueba sin
 * esta función, porque recalcular los hashes lo metería en ellos. Con `keepContentHash`,
 * `content_sha256` queda como lo dejó el cambio.
 */
function variant(
  change: (draft: Draft) => void,
  {
    keepContentHash = false,
    version = '2.0.0',
  }: { keepContentHash?: boolean; version?: keyof typeof FIXTURES } = {},
): unknown {
  const draft = structuredClone(fixture(version)) as unknown as Draft;
  change(draft);
  const snapshot = draft as unknown as SourceCatalogSnapshot;
  if (!keepContentHash) {
    draft['content_sha256'] = deriveCatalogContentSha256(snapshot.entries);
  }
  draft['snapshot_id'] = deriveCatalogSnapshotId(snapshot);
  return draft;
}

/**
 * Rutas distintas de los problemas que encuentra el esquema runtime; vacío si acepta el valor. Un
 * mismo campo puede dar varios problemas (por ejemplo, formato y refinado de un instante UTC).
 */
function issuePaths(value: unknown): string[] {
  const result = sourceCatalogSnapshotSchema.safeParse(value);
  return result.success
    ? []
    : [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
}

/** Entrada sintética adicional con otro código. */
function entryWithCode(code: string): Record<string, unknown> {
  const [first] = fixture().entries;
  if (first === undefined) {
    throw new TypeError('Fixture sin entradas.');
  }
  return { ...first, underlying_symbol: code };
}

describe('SourceCatalogSnapshot', () => {
  it('acepta el snapshot sintético sin cambiar sus valores', () => {
    const snapshot = fixture();

    expect(sourceCatalogSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.content_sha256).toBe(CONTENT_SHA256);
    expect(snapshot.snapshot_id).toBe(SNAPSHOT_ID);
    expect(snapshot.entries.map((entry) => entry.pip_size)).toEqual(['0.001', '0.01', '0.00001']);
  });

  it('calcula los dos hashes igual que el cálculo independiente', () => {
    const snapshot = fixture();

    expect(deriveCatalogContentSha256(snapshot.entries)).toBe(CONTENT_SHA256);
    expect(deriveCatalogSnapshotId(snapshot)).toBe(SNAPSHOT_ID);
  });

  it('el hash de contenido solo depende de las entradas; la identidad, de todo el snapshot', () => {
    const other = { ...fixture(), ...OTHER_OBSERVATION };

    expect(deriveCatalogContentSha256(other.entries)).toBe(CONTENT_SHA256);
    expect(deriveCatalogSnapshotId(other)).toBe(SNAPSHOT_ID_OTHER_OBSERVATION);
    expect(issuePaths({ ...other, snapshot_id: SNAPSHOT_ID_OTHER_OBSERVATION })).toEqual([]);
    // Con el `snapshot_id` de la primera observación, la otra no se acepta.
    expect(issuePaths(other)).toEqual(['snapshot_id']);
  });

  it('rechaza hashes que no corresponden', () => {
    expect(issuePaths({ ...fixture(), snapshot_id: `sha256:${'0'.repeat(64)}` })).toEqual([
      'snapshot_id',
    ]);
    expect(
      issuePaths(
        variant(
          (draft) => {
            draft['content_sha256'] = '0'.repeat(64);
          },
          { keepContentHash: true },
        ),
      ),
    ).toEqual(['content_sha256']);
    // Cambiar una entrada sin recalcular nada invalida el contenido y la identidad.
    const altered = structuredClone(fixture());
    const first = altered.entries[0];
    if (first === undefined) {
      throw new TypeError('Fixture sin entradas.');
    }
    first.underlying_symbol_name = 'Otro nombre';
    expect(issuePaths(altered)).toEqual(['content_sha256', 'snapshot_id']);
  });

  it('exige entradas ordenadas por código en unidades UTF-16, sin repetir', () => {
    // SYNTH_10 va antes que SYNTH_100 (prefijo) y SYNTH_100 antes que SYNTH_FX ('1' < 'F').
    expect(
      issuePaths(
        variant((draft) => {
          const [a, b, ...rest] = draft.entries;
          draft.entries = [b, a, ...rest].filter((entry) => entry !== undefined);
        }),
      ),
    ).toEqual(['entries']);
    expect(
      issuePaths(
        variant((draft) => {
          draft.entries = [...draft.entries].reverse();
        }),
      ),
    ).toEqual(['entries']);
    // Unidades UTF-16, no el orden del idioma: 'X' (0x58) va antes que '_' (0x5F), así que SYNTHX
    // es el primero, aunque `localeCompare` y una comparación sin mayúsculas lo pondrían el último.
    expect('SYNTHX'.localeCompare('SYNTH_10')).toBeGreaterThan(0);
    expect(
      issuePaths(
        variant((draft) => {
          draft.entries = [entryWithCode('SYNTHX'), ...draft.entries];
          draft['entry_count'] = draft.entries.length;
        }),
      ),
    ).toEqual([]);
    expect(
      issuePaths(
        variant((draft) => {
          draft.entries = [...draft.entries, entryWithCode('SYNTHX')];
          draft['entry_count'] = draft.entries.length;
        }),
      ),
    ).toEqual(['entries']);
    // Un código repetido no es un orden estricto.
    expect(
      issuePaths(
        variant((draft) => {
          const [first] = draft.entries;
          if (first !== undefined) {
            draft.entries = [first, ...draft.entries];
            draft['entry_count'] = draft.entries.length;
          }
        }),
      ),
    ).toEqual(['entries']);
  });

  it('cuenta las entradas y no admite un catálogo vacío', () => {
    expect(
      issuePaths(
        variant((draft) => {
          draft['entry_count'] = 2;
        }),
      ),
    ).toEqual(['entry_count']);
    expect(
      issuePaths(
        variant((draft) => {
          draft.entries = [];
          draft['entry_count'] = 0;
        }),
      ),
    ).toEqual(['entry_count', 'entries']);
  });

  it('conserva los valores oficiales como texto y rechaza lo que el contrato no admite', () => {
    const inFirstEntry = (field: string, value: unknown) =>
      issuePaths(
        variant((draft) => {
          const [first] = draft.entries;
          if (first !== undefined) {
            first[field] = value;
          }
        }),
      );

    // `pip_size` es el lexema decimal recibido: ni exponente ni número.
    expect(inFirstEntry('pip_size', '1e-3')).toEqual(['entries.0.pip_size']);
    expect(inFirstEntry('pip_size', 0.001)).toEqual(['entries.0.pip_size']);
    // El código no puede estar vacío; los indicadores de mercado solo valen 0 o 1.
    expect(inFirstEntry('underlying_symbol', '')).toEqual(['entries.0.underlying_symbol']);
    expect(inFirstEntry('exchange_is_open', 2)).toEqual(['entries.0.exchange_is_open']);
    expect(inFirstEntry('is_trading_suspended', true)).toEqual(['entries.0.is_trading_suspended']);
  });

  it('no admite `trade_count` ni campos ajenos', () => {
    // Los hashes del fixture cubren las entradas sin el campo ajeno, así que solo falla la forma.
    const snapshot = fixture();
    const [first, ...rest] = snapshot.entries;
    if (first === undefined) {
      throw new TypeError('Fixture sin entradas.');
    }
    expect(
      issuePaths({ ...snapshot, entries: [{ ...first, trade_count: 1000 }, ...rest] }),
    ).toEqual(['entries.0']);
    expect(issuePaths({ ...snapshot, extra: true })).toEqual(['']);
  });

  it('valida la procedencia con los escalares del contrato', () => {
    for (const [field, value] of [
      ['source', ''],
      ['connector_version', ''],
      ['source_schema_release', ''],
      ['source_schema_sha256', 'A'.repeat(64)],
      ['raw_payload_sha256', '2'.repeat(63)],
      ['observation_id', '019b76da-a800-4000-8000-000000000001'],
      ['received_at_utc', '2026-01-01T00:00:00Z'],
    ] as const) {
      expect(
        issuePaths(
          variant((draft) => {
            draft[field] = value;
          }),
        ),
        `${field}=${value}`,
      ).toEqual([field]);
    }
    // `snapshot_id` lleva el prefijo `sha256:`.
    expect(issuePaths({ ...fixture(), snapshot_id: SNAPSHOT_ID.slice('sha256:'.length) })).toEqual([
      'snapshot_id',
    ]);
  });

  it('solo admite las versiones y el formato que tienen lector', () => {
    for (const [field, value, version] of [
      ['schema_version', '1.1.0', '2.0.0'],
      ['schema_version', '3.0.0', '2.0.0'],
      ['catalog_normalizer_version', '1.0.0', '2.0.0'],
      ['catalog_normalizer_version', '3.0.0', '2.0.0'],
      ['catalog_normalizer_version', '2.0.0', '1.0.0'],
      ['catalog_format', 'mt5_symbols', '2.0.0'],
      ['catalog_format', 'mt5_symbols', '1.0.0'],
    ] as const) {
      expect(
        issuePaths(
          variant(
            (draft) => {
              draft[field] = value;
            },
            { version },
          ),
        ),
        `${version}: ${field}=${value}`,
      ).toEqual([field]);
    }
  });
});

describe('SourceCatalogSnapshot 1.0.0, el de los logs guardados', () => {
  it('se sigue leyendo, con `underlying_symbol_type` y sus hashes', () => {
    const snapshot = fixture('1.0.0');

    expect(sourceCatalogSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.content_sha256).toBe(CONTENT_SHA256_V1);
    expect(snapshot.snapshot_id).toBe(SNAPSHOT_ID_V1);
    expect(deriveCatalogContentSha256(snapshot.entries)).toBe(CONTENT_SHA256_V1);
    expect(deriveCatalogSnapshotId(snapshot)).toBe(SNAPSHOT_ID_V1);
  });

  it('cada versión con sus entradas: la 1.0.0 exige el tipo, y la 2.0.0 no lo admite', () => {
    // Sin el campo, la 1.0.0 no se acepta; los hashes se recalculan, así que solo falla la forma.
    expect(
      issuePaths(
        variant(
          (draft) => {
            const [first] = draft.entries;
            if (first !== undefined) {
              delete first['underlying_symbol_type'];
            }
          },
          { version: '1.0.0' },
        ),
      ),
    ).toEqual(['entries.0.underlying_symbol_type']);
    // Con el campo, la 2.0.0 tampoco: es un campo ajeno, que se prueba sin recalcular los hashes,
    // como `trade_count`, para que solo falle la forma.
    const current = fixture();
    const [first, ...rest] = current.entries;
    if (first === undefined) {
      throw new TypeError('Fixture sin entradas.');
    }
    expect(
      issuePaths({
        ...current,
        entries: [{ ...first, underlying_symbol_type: 'stockindex' }, ...rest],
      }),
    ).toEqual(['entries.0']);
    // Un 1.0.0 relabelado como 2.0.0 no pasa: su normalizador y sus entradas son los de la 1.0.0.
    const relabeled = issuePaths(
      variant(
        (draft) => {
          draft['schema_version'] = '2.0.0';
        },
        { version: '1.0.0' },
      ),
    );
    expect(relabeled).toContain('catalog_normalizer_version');
    expect(relabeled).toContain('entries.0');
  });

  it('el contenido de las dos versiones de un mismo catálogo es distinto', () => {
    expect(CONTENT_SHA256).not.toBe(CONTENT_SHA256_V1);
    expect(fixture('2.0.0').entries).toEqual(
      fixture('1.0.0').entries.map((entry) => {
        const copy: Record<string, unknown> = { ...entry };
        delete copy['underlying_symbol_type'];
        return copy;
      }),
    );
  });
});
