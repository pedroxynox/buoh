import { parseArgs } from 'node:util';

import { datasetIdSchema } from '@buoh/contracts';

import { type ReplayMode } from './replay.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const REPLAY_USAGE =
  'Uso: pnpm run data:replay -- --dataset sha256:<64 hex> [--verify-only]';

/** Interpreta `--dataset <id> [--verify-only]`; tolera el separador `--` que reenvía pnpm. */
export function parseReplayArgs(argv: readonly string[]): { datasetId: string; mode: ReplayMode } {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { dataset?: string; 'verify-only'?: boolean };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        dataset: { type: 'string' },
        'verify-only': { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : 'Argumentos inválidos.'} ${REPLAY_USAGE}`,
    );
  }
  const datasetId = values.dataset;
  if (datasetId === undefined || !datasetIdSchema.safeParse(datasetId).success) {
    throw new UsageError(`--dataset requiere un dataset_id válido. ${REPLAY_USAGE}`);
  }
  return { datasetId, mode: values['verify-only'] === true ? 'verify-only' : 'recompute' };
}
