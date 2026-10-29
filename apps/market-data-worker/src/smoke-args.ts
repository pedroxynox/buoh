import { parseArgs } from 'node:util';

import { UsageError } from './replay-args.js';

/** Valores por defecto y máximo de `data:smoke` (ADR-0012 §10). */
export const SMOKE_DEFAULT_SYMBOL = 'R_100';
export const SMOKE_DEFAULT_DURATION_SECONDS = 120;
export const SMOKE_MAX_DURATION_SECONDS = 3600;

export const SMOKE_USAGE =
  'Uso: pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120] [--interrupt-after-seconds <n>] (duración de 1 a 3600; n desde 1 y menor que la duración)';

export interface SmokeOptions {
  readonly durationSeconds: number;
  /** El corte del smoke de reconexión, en segundos desde el primer tick, o `null` sin él. */
  readonly interruptAfterSeconds: number | null;
  readonly symbol: string;
}

/** Un entero de segundos escrito solo con cifras y sin ceros delante, o `NaN`. */
function seconds(text: string): number {
  return /^[1-9]\d{0,3}$/u.test(text) ? Number(text) : Number.NaN;
}

/**
 * El símbolo de `--symbol`, o `R_100` sin él. Solo descarta lo que nunca es un código; el esquema
 * de la petición `ticks` decide el resto. Si no lo es, lanza `UsageError` con el uso del comando
 * (`usage`). Lo usan `data:smoke` e `ingest`.
 */
export function symbolOption(value: string | undefined, usage: string): string {
  const symbol = value ?? SMOKE_DEFAULT_SYMBOL;
  if (!/^[A-Za-z0-9_]{1,64}$/u.test(symbol)) {
    throw new UsageError(`--symbol requiere un código como R_100. ${usage}`);
  }
  return symbol;
}

/**
 * Interpreta `--live [--symbol <código>] [--duration-seconds <n>] [--interrupt-after-seconds <n>]`;
 * tolera el separador `--` que reenvía pnpm. Sin `--live` no se abre ninguna conexión: es un error
 * de uso (salida 2), para que ningún `verify` ni CI toque la red. El corte (ADR-0015 §9) tiene que
 * ser un entero desde 1 y menor que la duración; si no, también es un error de uso, sin conectar.
 */
export function parseSmokeArgs(argv: readonly string[]): SmokeOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: {
    'duration-seconds'?: string;
    'interrupt-after-seconds'?: string;
    live?: boolean;
    symbol?: string;
  };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        'duration-seconds': { type: 'string' },
        'interrupt-after-seconds': { type: 'string' },
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
  const symbol = symbolOption(values.symbol, SMOKE_USAGE);
  const durationSeconds = seconds(
    values['duration-seconds'] ?? String(SMOKE_DEFAULT_DURATION_SECONDS),
  );
  if (!(durationSeconds >= 1 && durationSeconds <= SMOKE_MAX_DURATION_SECONDS)) {
    throw new UsageError(
      `--duration-seconds requiere un entero de 1 a ${String(SMOKE_MAX_DURATION_SECONDS)}. ${SMOKE_USAGE}`,
    );
  }
  const rawInterrupt = values['interrupt-after-seconds'];
  const interruptAfterSeconds = rawInterrupt === undefined ? null : seconds(rawInterrupt);
  if (
    interruptAfterSeconds !== null &&
    !(interruptAfterSeconds >= 1 && interruptAfterSeconds < durationSeconds)
  ) {
    throw new UsageError(
      `--interrupt-after-seconds requiere un entero desde 1 y menor que --duration-seconds (${String(durationSeconds)}). ${SMOKE_USAGE}`,
    );
  }
  return { durationSeconds, interruptAfterSeconds, symbol };
}
