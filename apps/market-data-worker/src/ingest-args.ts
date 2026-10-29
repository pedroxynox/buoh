import { parseArgs } from 'node:util';

import { DEFAULT_POSTGRES_SCHEMA, DEFAULT_S3_BUCKET, type WorkerConfig } from './config.js';
import { UsageError } from './replay-args.js';
import { symbolOption } from './smoke-args.js';

// Los argumentos y la configuración de `ingest`, la captura viva continua (ADR-0015 §7). Los dos se
// comprueban antes de abrir ningún almacén o conexión.

export const INGEST_USAGE =
  'Uso: pnpm --filter @buoh/market-data-worker run ingest -- --live [--symbol R_100]';

export interface IngestOptions {
  readonly symbol: string;
}

/**
 * Interpreta `--live [--symbol <código>]`; tolera el separador `--` que reenvía pnpm. Sin `--live`
 * no se lee la configuración ni se abre ninguna conexión: es un error de uso (salida 2), para que
 * ningún `verify` ni CI capture datos reales. Ingiere un solo símbolo, con la regla del smoke
 * (`R_100` por defecto). Cualquier otra opción o un argumento suelto también es un error de uso.
 */
export function parseIngestArgs(argv: readonly string[]): IngestOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { live?: boolean; symbol?: string };
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      args,
      options: {
        live: { type: 'boolean' },
        symbol: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : 'Argumentos inválidos.'} ${INGEST_USAGE}`,
    );
  }
  if (values.live !== true) {
    throw new UsageError(
      `ingest se conecta a Deriv y guarda lo que recibe: pasa --live para confirmarlo. ${INGEST_USAGE}`,
    );
  }
  return { symbol: symbolOption(values.symbol, INGEST_USAGE) };
}

/** Entornos donde `ingest` no corre: desplegar no está autorizado en Fase 1 (ADR-0006). */
const DEPLOYED_ENVIRONMENTS: ReadonlySet<WorkerConfig['environment']> = new Set([
  'production',
  'staging',
]);

/**
 * La configuración tiene valores que `ingest` no admite (ADR-0015 §7). `variables` son sus nombres,
 * en orden. El mensaje solo lleva esos nombres, nunca un valor.
 */
export class IngestConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(
      `Configuración no admitida por ingest: ${variables.join(', ')}. La captura viva necesita un esquema PostgreSQL y un bucket propios, distintos de los por defecto, y no corre en un entorno desplegado (ADR-0015 §7).`,
    );
    this.name = 'IngestConfigError';
    this.variables = variables;
  }
}

/**
 * Comprueba la configuración de `ingest`, sin efectos (ADR-0015 §7): rechaza los entornos `staging`
 * y `production`, el esquema PostgreSQL `public` y el bucket `buoh-local`, que son también los
 * valores sin la variable. La captura guarda datos reales y se borra entera, esquema y bucket, antes
 * de 24 horas, así que nunca comparte los de los datos sintéticos. Si algo no se admite, lanza
 * `IngestConfigError` con todas las variables rechazadas.
 */
export function checkIngestConfig(config: WorkerConfig): void {
  const rejected: string[] = [];
  if (DEPLOYED_ENVIRONMENTS.has(config.environment)) {
    rejected.push('BUOH_DEPLOYMENT_ENVIRONMENT');
  }
  if (config.postgres.schema === DEFAULT_POSTGRES_SCHEMA) {
    rejected.push('BUOH_POSTGRES_SCHEMA');
  }
  if (config.s3.bucket === DEFAULT_S3_BUCKET) {
    rejected.push('BUOH_S3_BUCKET');
  }
  if (rejected.length > 0) {
    throw new IngestConfigError(rejected);
  }
}
