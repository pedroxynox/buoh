import { parseArgs } from 'node:util';

import { UsageError } from './replay-args.js';

/** Valores por defecto y máximo de `data:smoke` (ADR-0012 §10). */
export const SMOKE_DEFAULT_SYMBOL = 'R_100';
export const SMOKE_DEFAULT_DURATION_SECONDS = 120;
export const SMOKE_MAX_DURATION_SECONDS = 3600;

export const SMOKE_USAGE =
  'Uso: pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120] (máximo 3600)';

export interface SmokeOptions {
  readonly durationSeconds: number;
  readonly symbol: string;
}

/**
 * Interpreta `--live [--symbol <código>] [--duration-seconds <n>]`; tolera el separador `--` que
 * reenvía pnpm. Sin `--live` no se abre ninguna conexión: es un error de uso (salida 2), para que
 * ningún `verify` ni CI toque la red.
 */
export function parseSmokeArgs(argv: readonly string[]): SmokeOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { 'duration-seconds'?: string; live?: boolean; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        'duration-seconds': { type: 'string' },
        live: { type: 'boolean' },
        symbol: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : 'Argumentos inválidos.'} ${SMOKE_USAGE}`,
    );
  }
  if (values.live !== true) {
    throw new UsageError(
      `data:smoke se conecta a Deriv: pasa --live para confirmarlo. ${SMOKE_USAGE}`,
    );
  }
  const symbol = values.symbol ?? SMOKE_DEFAULT_SYMBOL;
  // Solo descarta lo que nunca es un código; el esquema de la petición `ticks` decide el resto.
  if (!/^[A-Za-z0-9_]{1,64}$/u.test(symbol)) {
    throw new UsageError(`--symbol requiere un código como R_100. ${SMOKE_USAGE}`);
  }
  const rawDuration = values['duration-seconds'] ?? String(SMOKE_DEFAULT_DURATION_SECONDS);
  const durationSeconds = /^[1-9]\d{0,3}$/u.test(rawDuration) ? Number(rawDuration) : Number.NaN;
  if (!(durationSeconds >= 1 && durationSeconds <= SMOKE_MAX_DURATION_SECONDS)) {
    throw new UsageError(
      `--duration-seconds requiere un entero de 1 a ${String(SMOKE_MAX_DURATION_SECONDS)}. ${SMOKE_USAGE}`,
    );
  }
  return { durationSeconds, symbol };
}
