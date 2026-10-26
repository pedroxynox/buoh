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
// El fixture es sintético: códigos y nombres inventados, no datos de Deriv. `source_schema_sha256`
// y `raw_payload_sha256` son marcadores, porque el contrato solo comprueba su formato. Los hashes
// de abajo se calcularon fuera del código, con Python (`json.dumps` con claves ordenadas y sin
// espacios, que coincide con JCS para textos ASCII y enteros pequeños, y `hashlib.sha256`), para
// no comprobar la implementación consigo misma.
const CONTENT_SHA256 = '61998c161db0da302eb8cc7ecc7b758b1893307fbff3a113cb0d2886901f9a00';
const SNAPSHOT_ID = 'sha256:798f2b62fe4b048789a9d3f51ee3099b49300dfb87e9d448bedb7b4bc81ab51e';
// El mismo catálogo recibido en otra observación (otro `observation_id` y otra hora).
const OTHER_OBSERVATION = {
  observation_id: '019b76da-a800-7000-8000-000000000002',
  received_at_utc: '2026-01-01T00:05:00.100Z',
} as const;
const SNAPSHOT_ID_OTHER_OBSERVATION =
  'sha256:875fdae5670e84e2cfb9da88cc3df2cfeb0c6d263e43077b10b5a1eb2d8d55ee';

function fixture(): SourceCatalogSnapshot {
  return JSON.parse(
    readFileSync(new URL('./fixtures/source-catalog-snapshot.json', import.meta.url), 'utf8'),
  ) as SourceCatalogSnapshot;
}

type Draft = Record<string, unknown> & { entries: Record<string, unknown>[] };

/**
 * Copia del fixture con un cambio y sus hashes recalculados, para que el caso falle solo por la
 * regla que prueba. Con `keepContentHash`, `content_sha256` queda como lo dejó el cambio.
 */
function variant(change: (draft: Draft) => void, { keepContentHash = false } = {}): unknown {
  const draft = structuredClone(fixture()) as unknown as Draft;
  change(draft);
  const snapshot = draft as unknown as SourceCatalogSnapshot;
  if (!keepContentHash) {
    draft['content_sha256'] = deriveCatalogContentSha256(snapshot.entries);
  }
  draft['snapshot_id'] = deriveCatalogSnapshotId(snapshot);
  return draft;
}

const rejects = (value: unknown) => !sourceCatalogSnapshotSchema.safeParse(value).success;

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
    expect(
      sourceCatalogSnapshotSchema.safeParse({
        ...other,
        snapshot_id: SNAPSHOT_ID_OTHER_OBSERVATION,
      }).success,
    ).toBe(true);
    // Con el `snapshot_id` de la primera observación, la otra no se acepta.
    expect(rejects(other)).toBe(true);
  });

  it('rechaza hashes que no corresponden', () => {
    expect(rejects({ ...fixture(), snapshot_id: `sha256:${'0'.repeat(64)}` })).toBe(true);
    expect(
      rejects(
        variant(
          (draft) => {
            draft['content_sha256'] = '0'.repeat(64);
          },
          { keepContentHash: true },
        ),
      ),
    ).toBe(true);
    // Cambiar una entrada sin recalcular nada invalida el contenido y la identidad.
    const altered = structuredClone(fixture());
    const first = altered.entries[0];
    if (first === undefined) {
      throw new TypeError('Fixture sin entradas.');
    }
    first.underlying_symbol_name = 'Otro nombre';
    expect(rejects(altered)).toBe(true);
  });

  it('exige entradas ordenadas por código en unidades UTF-16, sin repetir', () => {
    // SYNTH_10 va antes que SYNTH_100 (prefijo) y SYNTH_100 antes que SYNTH_FX ('1' < 'F').
    expect(
      rejects(
        variant((draft) => {
          const [a, b, ...rest] = draft.entries;
          draft.entries = [b, a, ...rest].filter((entry) => entry !== undefined);
        }),
      ),
    ).toBe(true);
    expect(
      rejects(
        variant((draft) => {
          draft.entries = [...draft.entries].reverse();
        }),
      ),
    ).toBe(true);
    expect(
      rejects(
        variant((draft) => {
          const [first] = draft.entries;
          if (first !== undefined) {
            draft.entries = [first, ...draft.entries];
            draft['entry_count'] = draft.entries.length;
          }
        }),
      ),
    ).toBe(true);
  });

  it('cuenta las entradas y no admite un catálogo vacío', () => {
    expect(
      rejects(
        variant((draft) => {
          draft['entry_count'] = 2;
        }),
      ),
    ).toBe(true);
    expect(
      rejects(
        variant((draft) => {
          draft.entries = [];
          draft['entry_count'] = 0;
        }),
      ),
    ).toBe(true);
  });

  it('conserva los valores oficiales como texto y rechaza lo que el contrato no admite', () => {
    const inFirstEntry = (field: string, value: unknown) =>
      variant((draft) => {
        const [first] = draft.entries;
        if (first !== undefined) {
          first[field] = value;
        }
      });

    // `pip_size` es el lexema decimal recibido: ni exponente ni número.
    expect(rejects(inFirstEntry('pip_size', '1e-3'))).toBe(true);
    expect(rejects(inFirstEntry('pip_size', 0.001))).toBe(true);
    // El código no puede estar vacío; los indicadores de mercado solo valen 0 o 1.
    expect(rejects(inFirstEntry('underlying_symbol', ''))).toBe(true);
    expect(rejects(inFirstEntry('exchange_is_open', 2))).toBe(true);
    expect(rejects(inFirstEntry('is_trading_suspended', true))).toBe(true);
    // `trade_count` no forma parte del snapshot, y tampoco un campo desconocido.
    expect(rejects(inFirstEntry('trade_count', 1000))).toBe(true);
    expect(
      rejects(
        variant((draft) => {
          draft['extra'] = true;
        }),
      ),
    ).toBe(true);
  });

  it('solo admite las versiones y el formato que tienen lector', () => {
    for (const [field, value] of [
      ['schema_version', '1.1.0'],
      ['schema_version', '2.0.0'],
      ['catalog_normalizer_version', '2.0.0'],
      ['catalog_format', 'mt5_symbols'],
    ] as const) {
      expect(
        rejects(
          variant((draft) => {
            draft[field] = value;
          }),
        ),
        `${field}=${value}`,
      ).toBe(true);
    }
  });
});
