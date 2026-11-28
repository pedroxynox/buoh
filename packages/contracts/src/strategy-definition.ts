/**
 * `StrategyDefinition` 1.0.0 (ADR-0022 §1 a §7 y §9; contratos de dominio, «StrategyDefinition»):
 * una estrategia como documento declarativo, sin código, con la gramática de reglas y la biblioteca
 * de indicadores 1.0.0. La forma la fija el esquema estructural, que es el JSON Schema que usa el
 * motor de investigación (ADR-0023 §13); lo que depende de varios campos, como el multiplicador que
 * acepta el mercado o la unidad de los dos lados de una condición, lo comprueba
 * `validateStrategyDefinition`, que devuelve la lista de errores estructurados (§9).
 */
import { z } from 'zod';

import { callputContractTypeSchema, multiplierContractTypeSchema } from './batch-records.js';
import { canonicalJson, sha256Hex, type JsonValue } from './identity.js';
import { sha256HexSchema, uuidV7Schema } from './scalars.js';

export const STRATEGY_SCHEMA_VERSION = '1.0.0';
export const INDICATOR_LIBRARY_VERSION = '1.0.0';

/** La fuente de Deriv, la de `source` en los registros de la captura y de los lotes. */
const DERIV_SOURCE = 'deriv_options';

/**
 * Los mercados de una estrategia (ADR-0021 §3; plan de Fase 2, `F2-MARKET-001`), por símbolo en
 * unidades UTF-16: con `ticks`, los dos que se capturan en vivo; con `deriv_candles`, los siete de
 * las velas de los lotes. Los multiplicadores y las duraciones de sube/baja son los de las
 * cotizaciones de los lotes, en el orden de su lista: los que aceptó `proposal` con 10 USD y los de la
 * lista fija de §3 que ofrece el mercado (`quoteMarkets` en el worker, PR 4b y 5a de ADR-0021).
 * Bitcoin y Ethereum no ofrecen sube/baja.
 */
interface StrategyMarket {
  readonly candles: boolean;
  readonly durations: readonly (readonly [number, 'm' | 's' | 't'])[];
  readonly multipliers: readonly number[];
  readonly ticks: boolean;
}

const FOREX_DURATIONS = [
  [15, 'm'],
  [60, 'm'],
  [240, 'm'],
] as const;
const METAL_DURATIONS = [[5, 'm'], ...FOREX_DURATIONS] as const;
const FOREX_MULTIPLIERS = [50, 100, 150, 250, 500] as const;

const STRATEGY_SYMBOLS = [
  'R_100',
  'cryBTCUSD',
  'cryETHUSD',
  'frxEURUSD',
  'frxGBPUSD',
  'frxUSDJPY',
  'frxXAGUSD',
  'frxXAUUSD',
] as const;

export const STRATEGY_MARKETS: Readonly<Record<(typeof STRATEGY_SYMBOLS)[number], StrategyMarket>> =
  {
    R_100: {
      candles: false,
      durations: [[5, 't'], [15, 's'], [1, 'm'], [5, 'm'], ...FOREX_DURATIONS],
      multipliers: [40, 100, 200, 300, 400],
      ticks: true,
    },
    cryBTCUSD: {
      candles: true,
      durations: [],
      multipliers: [50, 100, 150, 200, 300],
      ticks: false,
    },
    cryETHUSD: { candles: true, durations: [], multipliers: [50, 100, 150, 200], ticks: false },
    frxEURUSD: {
      candles: true,
      durations: FOREX_DURATIONS,
      multipliers: FOREX_MULTIPLIERS,
      ticks: false,
    },
    frxGBPUSD: {
      candles: true,
      durations: FOREX_DURATIONS,
      multipliers: FOREX_MULTIPLIERS,
      ticks: false,
    },
    frxUSDJPY: {
      candles: true,
      durations: FOREX_DURATIONS,
      multipliers: FOREX_MULTIPLIERS,
      ticks: false,
    },
    frxXAGUSD: {
      candles: true,
      durations: METAL_DURATIONS,
      multipliers: FOREX_MULTIPLIERS,
      ticks: false,
    },
    frxXAUUSD: {
      candles: true,
      durations: METAL_DURATIONS,
      multipliers: FOREX_MULTIPLIERS,
      ticks: true,
    },
  };

/** Temporalidades de §2: con `ticks`, todas; con `deriv_candles`, desde 1 minuto. */
const TICK_TIMEFRAMES = ['tick', '5s', '15s', '1m', '5m', '15m', '60m'] as const;
const CANDLE_TIMEFRAMES: readonly string[] = ['1m', '5m', '15m', '60m'];

/**
 * Un decimal en su única escritura: el `DecimalString` de los contratos sin ceros finales en los
 * decimales ni `-0`, para que un mismo valor dé siempre la misma identidad (§9).
 */
const CANONICAL_DECIMAL_PATTERN = /^(?:-?(?:[1-9][0-9]*(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9])|0)$/u;
/**
 * Un decimal de 0,01 a 999 999,99, con como mucho dos decimales y en su única escritura: un importe en
 * USD o, en la caída máxima, un porcentaje. Los patrones usan `[0-9]` y no `\d`, que en otros
 * motores de expresiones regulares acepta cifras de otros alfabetos.
 */
const AMOUNT_PATTERN = /^(?:[1-9][0-9]{0,5}(?:\.[0-9]?[1-9])?|0\.(?:0[1-9]|[1-9][1-9]?))$/u;

const constantSchema = z.string().max(40).regex(CANONICAL_DECIMAL_PATTERN);
const amountSchema = z.string().regex(AMOUNT_PATTERN);

const windowLength = (maximum: number) => z.number().int().min(2).max(maximum);

/** La biblioteca de indicadores 1.0.0 (§3), con los rangos de sus parámetros. */
const indicatorSchema = z.discriminatedUnion('indicator', [
  z.strictObject({ indicator: z.literal('price') }),
  z.strictObject({ indicator: z.literal('return'), n: z.number().int().min(1).max(500) }),
  z.strictObject({ indicator: z.literal('sma'), n: windowLength(500) }),
  z.strictObject({ indicator: z.literal('ema'), n: windowLength(500) }),
  z.strictObject({ indicator: z.literal('rsi'), n: windowLength(100) }),
  z.strictObject({ indicator: z.literal('atr'), n: windowLength(100) }),
  z.strictObject({ indicator: z.literal('volatility'), n: windowLength(500) }),
  z.strictObject({ indicator: z.literal('highest'), n: windowLength(500) }),
  z.strictObject({ indicator: z.literal('lowest'), n: windowLength(500) }),
  z.strictObject({ indicator: z.literal('zscore'), n: windowLength(500) }),
  z.strictObject({
    indicator: z.literal('bollinger_pct'),
    k: z.enum(['1', '1.5', '2', '2.5', '3']),
    n: windowLength(500),
  }),
  z.strictObject({ indicator: z.literal('hour_utc') }),
  z.strictObject({ indicator: z.literal('weekday_utc') }),
]);

export type StrategyIndicator = z.infer<typeof indicatorSchema>;
export type StrategyIndicatorName = StrategyIndicator['indicator'];

/** La unidad de cada indicador (§3): una condición solo compara indicadores de la misma. */
const INDICATOR_UNITS: Readonly<Record<StrategyIndicatorName, string>> = {
  atr: 'price_move',
  bollinger_pct: 'unitless',
  ema: 'price',
  highest: 'price',
  hour_utc: 'hour',
  lowest: 'price',
  price: 'price',
  return: 'fraction',
  rsi: 'rsi',
  sma: 'price',
  volatility: 'fraction',
  weekday_utc: 'weekday',
  zscore: 'unitless',
};

/** El rango de los valores de los indicadores acotados, para sus constantes. */
const CONSTANT_RANGES: Partial<Record<StrategyIndicatorName, readonly [number, number]>> = {
  hour_utc: [0, 23],
  rsi: [0, 100],
  weekday_utc: [0, 6],
};

/** El índice de una instancia de `indicators`. */
const indicatorIndexSchema = z.number().int().min(0).max(5);

const conditionSchema = z.strictObject({
  left: indicatorIndexSchema,
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'crosses_above', 'crosses_below']),
  right: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('indicator'), index: indicatorIndexSchema }),
    z.strictObject({ kind: z.literal('constant'), value: constantSchema }),
  ]),
});

export type StrategyCondition = z.infer<typeof conditionSchema>;

const conditionGroupSchema = z.array(conditionSchema).min(1).max(3);

const multiplierContractSchema = z.strictObject({
  contract_type: multiplierContractTypeSchema,
  max_duration_ms: z.number().int().min(1000).max(86_400_000),
  multiplier: z.number().int().min(1).max(10_000),
  stop_loss: amountSchema.nullable(),
  take_profit: amountSchema.nullable(),
});

const callputContractSchema = z.strictObject({
  contract_type: callputContractTypeSchema,
  duration: z.strictObject({
    duration: z.number().int().min(1).max(240),
    duration_unit: z.enum(['t', 's', 'm']),
  }),
});

/**
 * Texto libre con tope (ADR-0023 §5): sin caracteres de control salvo el salto de línea, sin los de
 * dirección del texto, que cambian cómo se ve en la web (U+200E, U+200F, U+202A a U+202E y U+2066
 * a U+2069), y sin sustitutos UTF-16 sueltos, que el JCS de la identidad no admite (RFC 8785, I-JSON).
 */
const DESCRIPTION_PATTERN =
  // eslint-disable-next-line no-control-regex -- el patrón existe para rechazar esos caracteres.
  /^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]*$/u;

export const strategyDefinitionStructuralSchema = z
  .strictObject({
    strategy_schema_version: z.literal(STRATEGY_SCHEMA_VERSION),
    indicator_library_version: z.literal(INDICATOR_LIBRARY_VERSION),
    strategy_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/u),
    semantic_version: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/u),
    responsible: uuidV7Schema,
    origin: z.strictObject({
      kind: z.literal('research_engine'),
      search_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      candidate_number: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
    description: z.string().min(1).max(1000).regex(DESCRIPTION_PATTERN),
    market: z.strictObject({
      source: z.literal(DERIV_SOURCE),
      symbol: z.enum(STRATEGY_SYMBOLS),
      data: z.enum(['ticks', 'deriv_candles']),
      quality_profile_id: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u),
      quality_profile_sha256: sha256HexSchema,
      timeframe: z.enum(TICK_TIMEFRAMES),
    }),
    indicators: z.array(indicatorSchema).min(1).max(6),
    side: z.enum(['up', 'down']),
    entry: z.strictObject({
      groups: z.array(conditionGroupSchema).min(1).max(2),
      hours_utc: z.array(z.number().int().min(0).max(23)).min(1).max(23).nullable(),
      weekdays_utc: z.array(z.number().int().min(0).max(6)).min(1).max(6).nullable(),
    }),
    exit: z.strictObject({ conditions: conditionGroupSchema }).nullable(),
    contract: z.discriminatedUnion('contract_type', [
      multiplierContractSchema,
      callputContractSchema,
    ]),
    position: z.strictObject({
      currency: z.literal('USD'),
      initial_capital: z.literal('1000'),
      stake: z.literal('10'),
      max_drawdown_percent: amountSchema,
    }),
    signals: z.strictObject({
      signal_expiry_ms: z.number().int().min(1000).max(60_000),
      min_seconds_between_entries: z.number().int().min(0).max(86_400),
      max_entries_per_day: z.number().int().min(1).max(500),
    }),
    data_policy: z.strictObject({
      max_data_age_ms: z.number().int().min(1000).max(60_000),
    }),
    execution_mode: z.enum(['disabled', 'shadow']),
    promoted_from: z
      .strictObject({
        version_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        evaluation_id: uuidV7Schema,
      })
      .nullable(),
  })
  .meta({ id: 'StrategyDefinition', title: 'StrategyDefinition' });

export type StrategyDefinition = z.infer<typeof strategyDefinitionStructuralSchema>;

/** Los códigos cerrados de los errores de una definición (§9). */
export const STRATEGY_DEFINITION_ERROR_CODES = [
  'constant_not_allowed',
  'constant_out_of_range',
  'contract_not_allowed',
  'duplicate_indicator',
  'duration_not_quoted',
  'execution_mode_not_allowed',
  'exit_not_allowed',
  'indicator_reference_invalid',
  'invalid_format',
  'invalid_type',
  'invalid_value',
  'limit_out_of_range',
  'missing_field',
  'multiplier_not_accepted',
  'no_conditions',
  'not_canonical',
  'parameter_out_of_range',
  'promotion_reference_invalid',
  'shadow_requires_ticks',
  'side_contract_mismatch',
  'signal_expiry_too_long',
  'symbol_not_supported',
  'timeframe_not_supported',
  'too_many_conditions',
  'too_many_groups',
  'too_many_indicators',
  'unit_mismatch',
  'unknown_field',
  'unknown_indicator',
  'unused_indicator',
  'version_unsupported',
  'window_invalid',
] as const;

export type StrategyDefinitionErrorCode = (typeof STRATEGY_DEFINITION_ERROR_CODES)[number];

export interface StrategyDefinitionError {
  readonly code: StrategyDefinitionErrorCode;
  readonly message: string;
  readonly path: readonly (number | string)[];
}

export type StrategyDefinitionValidation =
  | { readonly definition: StrategyDefinition; readonly ok: true; readonly version_id: string }
  | { readonly errors: readonly StrategyDefinitionError[]; readonly ok: false };

type Path = readonly (number | string)[];

function error(code: StrategyDefinitionErrorCode, path: Path, message: string) {
  return { code, message, path: [...path] };
}

const last = (path: Path): number | string | undefined => path[path.length - 1];
const within = (path: Path, key: string): boolean => path.includes(key);

/**
 * El código de un error de forma. Los de un campo con su propio código, como un indicador o un
 * símbolo desconocidos, salen por el nombre del campo; los demás, por la clase del error de Zod.
 */
function structuralCode(issue: z.core.$ZodIssue, input: unknown): StrategyDefinitionErrorCode {
  const path = issue.path as Path;
  const field = last(path);
  const window = within(path, 'hours_utc') || within(path, 'weekdays_utc');
  switch (issue.code) {
    case 'invalid_type':
      return path.length > 0 && !hasPath(input, path) ? 'missing_field' : 'invalid_type';
    case 'invalid_union':
    case 'invalid_value':
      if (!hasPath(input, path)) return 'missing_field';
      if (field === 'indicator') return 'unknown_indicator';
      if (field === 'contract_type') return 'contract_not_allowed';
      if (field === 'symbol') return 'symbol_not_supported';
      if (field === 'timeframe') return 'timeframe_not_supported';
      if (field === 'execution_mode') return 'execution_mode_not_allowed';
      if (field === 'k') return 'parameter_out_of_range';
      if (within(path, 'duration')) return 'duration_not_quoted';
      return 'invalid_value';
    case 'too_big':
    case 'too_small':
      if (window) return 'window_invalid';
      if (within(path, 'indicators') && path.length === 3) return 'parameter_out_of_range';
      if (path.length === 1 && field === 'indicators') {
        return issue.code === 'too_big' ? 'too_many_indicators' : 'invalid_value';
      }
      if (field === 'left' || field === 'index') return 'indicator_reference_invalid';
      if (field === 'value') return 'invalid_format';
      if (field === 'groups') return issue.code === 'too_big' ? 'too_many_groups' : 'no_conditions';
      if (within(path, 'groups') || within(path, 'exit')) {
        return issue.code === 'too_big' ? 'too_many_conditions' : 'no_conditions';
      }
      if (field === 'multiplier') return 'multiplier_not_accepted';
      if (within(path, 'duration')) return 'duration_not_quoted';
      if (['contract', 'position', 'signals', 'data_policy'].some((key) => within(path, key))) {
        return 'limit_out_of_range';
      }
      return 'invalid_value';
    case 'invalid_format':
      return 'invalid_format';
    case 'unrecognized_keys':
      return 'unknown_field';
    case 'custom':
    case 'invalid_element':
    case 'invalid_key':
    case 'not_multiple_of':
      return 'invalid_value';
  }
}

/** Si la entrada tiene un valor en esa ruta: un campo que falta no es uno con otro tipo. */
function hasPath(input: unknown, path: Path): boolean {
  let current: unknown = input;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      return false;
    }
    current = (current as Record<number | string, unknown>)[key];
  }
  return true;
}

function structuralErrors(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): StrategyDefinitionError[] {
  const errors: StrategyDefinitionError[] = [];
  for (const issue of issues) {
    const path = issue.path as Path;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push(error('unknown_field', [...path, key], `El campo ${key} no existe.`));
      }
      continue;
    }
    errors.push(error(structuralCode(issue, input), path, issue.message));
  }
  return errors;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Una versión de la gramática o de la biblioteca que el código no conoce no se adivina (§9). */
function versionErrors(input: unknown): StrategyDefinitionError[] {
  if (!isRecord(input)) {
    return [];
  }
  const errors: StrategyDefinitionError[] = [];
  for (const [field, known] of [
    ['strategy_schema_version', STRATEGY_SCHEMA_VERSION],
    ['indicator_library_version', INDICATOR_LIBRARY_VERSION],
  ] as const) {
    if (field in input && input[field] !== known) {
      errors.push(
        error('version_unsupported', [field], `Este código solo conoce la versión ${known}.`),
      );
    }
  }
  return errors;
}

/**
 * Compara un `DecimalString` con un entero, exacto, sin pasar por binario64: negativo si es menor,
 * cero si es igual y positivo si es mayor.
 */
function compareDecimalToInteger(value: string, integer: number): number {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole + fraction) * (negative ? -1n : 1n);
  const bound = BigInt(integer) * 10n ** BigInt(fraction.length);
  return scaled === bound ? 0 : scaled < bound ? -1 : 1;
}

function conditionErrors(
  definition: StrategyDefinition,
  condition: StrategyCondition,
  path: Path,
  used: Set<number>,
): StrategyDefinitionError[] {
  const errors: StrategyDefinitionError[] = [];
  const count = definition.indicators.length;
  const left = definition.indicators[condition.left];
  if (left === undefined) {
    errors.push(
      error(
        'indicator_reference_invalid',
        [...path, 'left'],
        `Solo hay ${String(count)} indicadores.`,
      ),
    );
  } else {
    used.add(condition.left);
  }
  const { right } = condition;
  if (right.kind === 'indicator') {
    const other = definition.indicators[right.index];
    if (other === undefined) {
      errors.push(
        error(
          'indicator_reference_invalid',
          [...path, 'right', 'index'],
          `Solo hay ${String(count)} indicadores.`,
        ),
      );
    } else {
      used.add(right.index);
      if (condition.left >= right.index) {
        errors.push(
          error(
            'not_canonical',
            path,
            'Con dos indicadores, el de la izquierda va antes en la lista: se escribe con el operador contrario.',
          ),
        );
      }
      if (
        left !== undefined &&
        INDICATOR_UNITS[left.indicator] !== INDICATOR_UNITS[other.indicator]
      ) {
        errors.push(
          error(
            'unit_mismatch',
            [...path, 'right'],
            `${left.indicator} y ${other.indicator} no tienen la misma unidad.`,
          ),
        );
      }
    }
    return errors;
  }
  if (left === undefined) {
    return errors;
  }
  if (INDICATOR_UNITS[left.indicator] === 'price') {
    errors.push(
      error(
        'constant_not_allowed',
        [...path, 'right'],
        `Un nivel de precio (${left.indicator}) no se compara con una constante.`,
      ),
    );
    return errors;
  }
  const range = CONSTANT_RANGES[left.indicator];
  if (
    range !== undefined &&
    (compareDecimalToInteger(right.value, range[0]) < 0 ||
      compareDecimalToInteger(right.value, range[1]) > 0)
  ) {
    errors.push(
      error(
        'constant_out_of_range',
        [...path, 'right', 'value'],
        `${left.indicator} va de ${String(range[0])} a ${String(range[1])}.`,
      ),
    );
  }
  return errors;
}

/** El orden de dos valores por su JCS, en unidades UTF-16 (el `<` de JavaScript). */
function compareCanonical(left: JsonValue, right: JsonValue): number {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Cada elemento, después del anterior por su JCS y distinto de él. */
function orderErrors(values: readonly JsonValue[], path: Path): StrategyDefinitionError[] {
  return values.flatMap((value, index) =>
    index > 0 && compareCanonical(values[index - 1] ?? null, value) >= 0
      ? [error('not_canonical', [...path, index], 'Van en orden de su JCS y sin repetirse.')]
      : [],
  );
}

const isStrictlyAscending = (values: readonly number[]): boolean =>
  values.slice(1).every((value, index) => (values[index] ?? value) < value);

/** Los milisegundos de una duración de tiempo, o `null` si es de ticks. */
function durationMs(duration: { duration: number; duration_unit: 'm' | 's' | 't' }): number | null {
  switch (duration.duration_unit) {
    case 't':
      return null;
    case 's':
      return duration.duration * 1000;
    case 'm':
      return duration.duration * 60_000;
  }
}

/** Las reglas que relacionan varios campos (§1 a §7), sobre una definición con la forma correcta. */
function semanticErrors(definition: StrategyDefinition): StrategyDefinitionError[] {
  const errors: StrategyDefinitionError[] = [];
  const { contract, market } = definition;
  const known = STRATEGY_MARKETS[market.symbol];
  const ticks = market.data === 'ticks';

  if (ticks ? !known.ticks : !known.candles) {
    errors.push(
      error(
        'symbol_not_supported',
        ['market', 'symbol'],
        ticks
          ? 'Con ticks solo hay R_100 y frxXAUUSD.'
          : `${market.symbol} no tiene velas de Deriv en los lotes.`,
      ),
    );
  }
  if (!ticks && !CANDLE_TIMEFRAMES.includes(market.timeframe)) {
    errors.push(
      error(
        'timeframe_not_supported',
        ['market', 'timeframe'],
        'Con velas de Deriv la temporalidad va de 1 a 60 minutos.',
      ),
    );
  }

  // Una sola escritura de cada regla (§9): los indicadores, las condiciones de cada grupo y los
  // grupos van en orden de su JCS, sin repetirse.
  definition.indicators.forEach((indicator, index) => {
    const previous = definition.indicators[index - 1];
    if (previous === undefined) {
      return;
    }
    const order = compareCanonical(previous, indicator);
    if (order >= 0) {
      errors.push(
        order === 0
          ? error('duplicate_indicator', ['indicators', index], 'Repite el indicador anterior.')
          : error(
              'not_canonical',
              ['indicators', index],
              'Los indicadores van en orden de su JCS.',
            ),
      );
    }
  });
  errors.push(...orderErrors(definition.entry.groups, ['entry', 'groups']));
  definition.entry.groups.forEach((group, index) => {
    errors.push(...orderErrors(group, ['entry', 'groups', index]));
  });
  if (definition.exit !== null) {
    errors.push(...orderErrors(definition.exit.conditions, ['exit', 'conditions']));
  }

  const used = new Set<number>();
  definition.entry.groups.forEach((group, groupIndex) => {
    group.forEach((condition, conditionIndex) => {
      errors.push(
        ...conditionErrors(
          definition,
          condition,
          ['entry', 'groups', groupIndex, conditionIndex],
          used,
        ),
      );
    });
  });
  definition.exit?.conditions.forEach((condition, conditionIndex) => {
    errors.push(
      ...conditionErrors(definition, condition, ['exit', 'conditions', conditionIndex], used),
    );
  });
  definition.indicators.forEach((_indicator, index) => {
    if (!used.has(index)) {
      errors.push(
        error('unused_indicator', ['indicators', index], 'Ninguna condición usa este indicador.'),
      );
    }
  });

  for (const field of ['hours_utc', 'weekdays_utc'] as const) {
    const values = definition.entry[field];
    if (values !== null && !isStrictlyAscending(values)) {
      errors.push(
        error('window_invalid', ['entry', field], 'Los valores van en orden y sin repetirse.'),
      );
    }
  }

  const up = contract.contract_type === 'MULTUP' || contract.contract_type === 'CALL';
  if (up !== (definition.side === 'up')) {
    errors.push(
      error(
        'side_contract_mismatch',
        ['contract', 'contract_type'],
        `${contract.contract_type} no opera en la dirección ${definition.side}.`,
      ),
    );
  }

  if ('multiplier' in contract) {
    if (!known.multipliers.includes(contract.multiplier)) {
      errors.push(
        error(
          'multiplier_not_accepted',
          ['contract', 'multiplier'],
          `${market.symbol} acepta ${known.multipliers.join(', ')}.`,
        ),
      );
    }
    if (contract.stop_loss !== null && compareDecimalToInteger(contract.stop_loss, 10) >= 0) {
      errors.push(
        error(
          'limit_out_of_range',
          ['contract', 'stop_loss'],
          'El stop loss es menor que la apuesta, que se pierde entera antes.',
        ),
      );
    }
  } else {
    if (definition.exit !== null) {
      errors.push(error('exit_not_allowed', ['exit'], 'Un sube/baja termina a su vencimiento.'));
    }
    if (known.durations.length === 0) {
      errors.push(
        error(
          'contract_not_allowed',
          ['contract', 'contract_type'],
          `${market.symbol} no ofrece sube/baja.`,
        ),
      );
    } else if (
      !known.durations.some(
        ([duration, unit]) =>
          duration === contract.duration.duration && unit === contract.duration.duration_unit,
      )
    ) {
      errors.push(
        error(
          'duration_not_quoted',
          ['contract', 'duration'],
          `buoh no cotiza esa duración en ${market.symbol}.`,
        ),
      );
    }
    const milliseconds = durationMs(contract.duration);
    const expiry = definition.signals.signal_expiry_ms;
    if (
      milliseconds === null ? expiry > contract.duration.duration * 1000 : expiry >= milliseconds
    ) {
      errors.push(
        error(
          'signal_expiry_too_long',
          ['signals', 'signal_expiry_ms'],
          'La señal vence antes que el contrato.',
        ),
      );
    }
  }

  if (compareDecimalToInteger(definition.position.max_drawdown_percent, 50) > 0) {
    errors.push(
      error(
        'limit_out_of_range',
        ['position', 'max_drawdown_percent'],
        'La caída máxima es como mucho el 50 %.',
      ),
    );
  }

  if (definition.execution_mode === 'shadow' && !ticks) {
    errors.push(
      error(
        'shadow_requires_ticks',
        ['execution_mode'],
        'Solo una estrategia de ticks va a shadow.',
      ),
    );
  }
  if ((definition.execution_mode === 'shadow') !== (definition.promoted_from !== null)) {
    errors.push(
      error(
        'promotion_reference_invalid',
        ['promoted_from'],
        'Solo una versión en shadow viene de una congelada, y siempre la nombra.',
      ),
    );
  }
  return errors;
}

/**
 * Orden fijo de los errores: por su ruta, componente a componente (los índices por su número, antes
 * que los nombres, y los nombres en unidades UTF-16; una ruta antes que las que la continúan), y
 * después por su código.
 */
function compareErrors(left: StrategyDefinitionError, right: StrategyDefinitionError): number {
  const length = Math.min(left.path.length, right.path.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.path[index];
    const b = right.path[index];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return String(a) < String(b) ? -1 : 1;
  }
  if (left.path.length !== right.path.length) return left.path.length - right.path.length;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

/** El identificador de una versión: `sha256:` y el SHA-256 de su JCS entera (§9). */
export function deriveStrategyVersionId(definition: StrategyDefinition): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(definition))}`;
}

/**
 * Valida una definición y devuelve, si es válida, su identificador; si no, todos sus errores, en
 * orden. Una versión desconocida de la gramática o de la biblioteca da solo `version_unsupported`.
 * Las reglas entre campos se comprueban solo cuando la forma es correcta.
 */
export function validateStrategyDefinition(input: unknown): StrategyDefinitionValidation {
  const versions = versionErrors(input);
  if (versions.length > 0) {
    return { errors: versions, ok: false };
  }
  const parsed = strategyDefinitionStructuralSchema.safeParse(input);
  const errors = parsed.success
    ? semanticErrors(parsed.data)
    : structuralErrors(parsed.error.issues, input);
  if (errors.length > 0 || !parsed.success) {
    return { errors: [...errors].sort(compareErrors), ok: false };
  }
  return { definition: parsed.data, ok: true, version_id: deriveStrategyVersionId(parsed.data) };
}

/** El esquema runtime: la forma y las reglas entre campos, con el código de cada error en su mensaje. */
export const strategyDefinitionSchema = strategyDefinitionStructuralSchema.superRefine(
  (value, context) => {
    for (const item of semanticErrors(value)) {
      context.addIssue({
        code: 'custom',
        message: `${item.code}: ${item.message}`,
        path: [...item.path],
      });
    }
  },
);
