import { parseArgs } from 'node:util';

import { UsageError } from './replay-args.js';
import { symbolOption } from './smoke-args.js';

// Los argumentos de `data:health` (ADR-0015 §8). Se comprueban antes de leer la configuración o
// abrir ningún almacén.

export const HEALTH_USAGE = 'Uso: pnpm run data:health -- --json [--symbol R_100] [--log <n>]';

/** El número de un log de producción en `--log`: de 1 a 999 999, sin ceros delante (ADR-0018 §6). */
const LOG_NUMBER = /^[1-9][0-9]{0,5}$/u;

export interface HealthOptions {
  /**
   * El log de producción que observa (`--log`), o `null` para el log activo. Solo vale en
   * `production` (ADR-0018 §6 y §11).
   */
  readonly log: number | null;
  readonly symbol: string;
}

/**
 * Interpreta `--json [--symbol <código>] [--log <n>]`; tolera el separador `--` que reenvía pnpm.
 * `--json` es obligatorio porque es el único formato de salida (plan de Fase 1 §5): sin él es un
 * error de uso (salida 2). El símbolo sigue la regla del smoke (`R_100` por defecto). `--log` es el
 * número de un log de producción, de 1 a 999 999. Cualquier otra opción, un valor para `--json`,
 * un número de log inválido o un argumento suelto también es un error de uso.
 */
export function parseHealthArgs(argv: readonly string[]): HealthOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { json?: boolean; log?: string; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        json: { type: 'boolean' },
        log: { type: 'string' },
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
  if (values.log !== undefined && !LOG_NUMBER.test(values.log)) {
    throw new UsageError(`--log es el número de un log, de 1 a 999999. ${HEALTH_USAGE}`);
  }
  return {
    log: values.log === undefined ? null : Number(values.log),
    symbol: symbolOption(values.symbol, HEALTH_USAGE),
  };
}
