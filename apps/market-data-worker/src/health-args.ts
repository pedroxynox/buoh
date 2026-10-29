import { parseArgs } from 'node:util';

import { UsageError } from './replay-args.js';
import { symbolOption } from './smoke-args.js';

// Los argumentos de `data:health` (ADR-0015 §8). Se comprueban antes de leer la configuración o
// abrir ningún almacén.

export const HEALTH_USAGE = 'Uso: pnpm run data:health -- --json [--symbol R_100]';

export interface HealthOptions {
  readonly symbol: string;
}

/**
 * Interpreta `--json [--symbol <código>]`; tolera el separador `--` que reenvía pnpm. `--json` es
 * obligatorio porque es el único formato de salida (plan de Fase 1 §5): sin él es un error de uso
 * (salida 2). El símbolo sigue la regla del smoke (`R_100` por defecto). Cualquier otra opción, un
 * valor para `--json` o un argumento suelto también es un error de uso.
 */
export function parseHealthArgs(argv: readonly string[]): HealthOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { json?: boolean; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        json: { type: 'boolean' },
        symbol: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : 'Argumentos inválidos.'} ${HEALTH_USAGE}`,
    );
  }
  if (values.json !== true) {
    throw new UsageError(
      `data:health solo escribe JSON: pasa --json para pedir el informe. ${HEALTH_USAGE}`,
    );
  }
  return { symbol: symbolOption(values.symbol, HEALTH_USAGE) };
}
