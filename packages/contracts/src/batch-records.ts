/**
 * Piezas comunes de los registros de los lotes (contratos de dominio, «Registros de los lotes»;
 * ADR-0021 §4): la procedencia del frame, que es la de `MarketTick`, los tipos de contrato que usa
 * buoh, la duración de un contrato y las comprobaciones de los importes en decimal.
 */
import { z } from 'zod';

import {
  nonEmptyStringSchema,
  sha256HexSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';

/**
 * Procedencia del `RawSourceFrame` de la respuesta, como en `MarketTick`. Los registros de un mismo
 * frame comparten su `observation_id`.
 */
export const frameProvenanceFields = {
  observation_id: uuidV7Schema,
  source: nonEmptyStringSchema,
  connector_version: nonEmptyStringSchema,
  received_at_utc: utcTimestampMsSchema,
  raw_payload_sha256: sha256HexSchema,
};

/** Los cuatro tipos de contrato de ADR-0022 §5, con los nombres de Deriv y su categoría. */
export const callputContractTypeSchema = z.enum(['CALL', 'PUT']);
export const multiplierContractTypeSchema = z.enum(['MULTUP', 'MULTDOWN']);

/**
 * Duración de un contrato con los nombres de `proposal` (`duration` y `duration_unit`) y sus
 * límites en el esquema de la release fijada: ticks (`t`) o tiempo (`s`, `m`, `h` y `d`).
 */
export const contractDurationSchema = z.strictObject({
  duration: z.number().int().min(1).max(99_999_999),
  duration_unit: z.enum(['t', 's', 'm', 'h', 'd']),
});

export type ContractDuration = z.infer<typeof contractDurationSchema>;

const UNIT_SECONDS = { d: 86_400, h: 3_600, m: 60, s: 1 } as const;

/**
 * La duración en su escala: ticks si la unidad es `t`, segundos si es de tiempo. Solo compara
 * duraciones de la misma escala; quien la llama comprueba antes que lo sean.
 */
export function durationMagnitude(value: ContractDuration): number {
  return value.duration_unit === 't'
    ? value.duration
    : value.duration * UNIT_SECONDS[value.duration_unit];
}

/** Decimales del lexema de un `DecimalString`. */
export function decimalPlaces(value: string): number {
  const point = value.indexOf('.');
  return point === -1 ? 0 : value.length - point - 1;
}

/** Un `DecimalString` sin signo: los importes de Deriv nunca son negativos. */
export function isNonNegativeDecimal(value: string): boolean {
  return !value.startsWith('-');
}

/** Un `DecimalString` mayor que cero: sin signo y con alguna cifra distinta de cero. */
export function isPositiveDecimal(value: string): boolean {
  return isNonNegativeDecimal(value) && /[1-9]/u.test(value);
}

/**
 * Compara dos `DecimalString` con los mismos decimales, como enteros escalados: exacto, sin pasar
 * por coma flotante. Negativo si `left < right`, cero si son iguales y positivo si `left > right`.
 */
export function compareDecimalsOfSameScale(left: string, right: string): number {
  const difference = BigInt(left.replace('.', '')) - BigInt(right.replace('.', ''));
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}
