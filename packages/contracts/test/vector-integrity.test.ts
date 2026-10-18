import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateMarketDataVectors } from '../src/vector-integrity.js';

const vectorRoot = resolve(import.meta.dirname, '../../../test-vectors/market-data/v1');

describe('vectores sintéticos de datos de mercado', () => {
  it('valida hashes, contratos, datasets y publicaciones sin red', async () => {
    const summary = await validateMarketDataVectors(vectorRoot);

    expect(summary).toEqual({
      mainDatasetId: 'sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd',
      mainIncidentCount: 8,
      mainTickCount: 7,
      zeroTickDatasetId: 'sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f',
    });
  });
});
