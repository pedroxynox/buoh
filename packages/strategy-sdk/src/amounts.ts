/**
 * Los importes de ADR-0022 §5, con la precisión del PR 3b en §13: aritmética de punto fijo entera,
 * sin binario64. Un importe es un `bigint` con 18 decimales (el valor por 10^18). Las sumas, las
 * restas y los productos son exactos; los cocientes se redondean a 18 decimales, y el resultado de
 * una posición, al centavo, los dos al par (el empate va a la cifra par).
 */
import { decimalStringSchema } from '@buoh/contracts';

/** Los decimales de un importe de punto fijo. */
export const FIXED_DECIMALS = 18;

const SCALE = 10n ** BigInt(FIXED_DECIMALS);
const CENTS_DIVISOR = 10n ** BigInt(FIXED_DECIMALS - 2);

/**
 * Un `DecimalString` en punto fijo, exacto. Rechaza lo que no es un decimal de los contratos y lo
 * que tiene más de 18 decimales, que no cabría sin redondear.
 */
export function parseFixed(value: string): bigint {
  if (!decimalStringSchema.safeParse(value).success) {
    throw new RangeError('El importe no es un decimal canónico.');
  }
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (fraction.length > FIXED_DECIMALS) {
    throw new RangeError(`El importe tiene más de ${String(FIXED_DECIMALS)} decimales.`);
  }
  const units = BigInt(whole + fraction.padEnd(FIXED_DECIMALS, '0'));
  return negative ? -units : units;
}

/** Un importe de punto fijo como decimal canónico: sin ceros finales en los decimales ni `-0`. */
export function formatFixed(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(FIXED_DECIMALS + 1, '0');
  const whole = digits.slice(0, -FIXED_DECIMALS);
  const fraction = digits.slice(-FIXED_DECIMALS).replace(/0+$/u, '');
  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** `numerator / denominator`, redondeado al entero más cercano, con los empates al par. */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('División por cero.');
  }
  const sign = numerator < 0n !== denominator < 0n ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const twice = (n % d) * 2n;
  if (twice > d || (twice === d && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return sign * quotient;
}

/** El producto exacto de dos importes. Rechaza uno que necesitaría más de 18 decimales. */
export function fixedProduct(left: bigint, right: bigint): bigint {
  const product = left * right;
  if (product % SCALE !== 0n) {
    throw new RangeError(`El producto necesita más de ${String(FIXED_DECIMALS)} decimales.`);
  }
  return product / SCALE;
}

/** El cociente de dos importes, redondeado a 18 decimales, con los empates al par. */
export function fixedQuotient(dividend: bigint, divisor: bigint): bigint {
  return divideHalfEven(dividend * SCALE, divisor);
}

/** Un importe en centavos enteros, redondeado al par, como se liquida una posición (§5). */
export function fixedToCents(value: bigint): number {
  const cents = divideHalfEven(value, CENTS_DIVISOR);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('El importe no cabe en centavos enteros seguros.');
  }
  return Number(cents);
}

/** Unos centavos enteros en punto fijo. */
export function centsToFixed(cents: number): bigint {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError('Los centavos son un entero seguro.');
  }
  return BigInt(cents) * CENTS_DIVISOR;
}
