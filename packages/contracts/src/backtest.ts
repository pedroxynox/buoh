/**
 * Los contratos del backtest (ADR-0024 §1, §6, §7 y §10; contratos de dominio, «Backtest»): lo que
 * lo describe (`BacktestSpec`), su manifiesto (`BacktestResult`) y las filas de sus partes
 * (`BacktestDecision` y `BacktestPosition`). Los importes van en centavos enteros y las fracciones
 * en texto con 6 decimales: ningún campo usa binario64, para que el resultado sea el mismo en
 * TypeScript y en Python.
 */
import { z } from 'zod';

import { dataQualityIncidentTypeSchema } from './data-quality.js';
import { canonicalJson, sha256Hex, type JsonValue } from './identity.js';
import {
  datasetIdSchema,
  decimalStringSchema,
  isSortedUnique,
  nonNegativeIntegerSchema,
  sha256HexSchema,
  utcTimestampMsSchema,
  uuidV7Schema,
} from './scalars.js';
import { qualityProfileIdSchema, strategyContractSchema } from './strategy-definition.js';

export const BACKTEST_SCHEMA_VERSION = '1.0.0';

/** Las versiones que nombra un `BacktestSpec` 1.0.0 (ADR-0024 §1); otra se rechaza (§7). */
export const BACKTEST_VERSIONS = {
  backtest: 'backtest-1.0.0',
  data_view: 'data-view-1.0.0',
  strategy_evaluator: 'strategy-evaluator-1.0.0',
  strategy_host: 'strategy-host-1.0.0',
} as const;

/** Los códigos de un backtest fallido: los de ADR-0024 §7 y `interrupted`, de §9. */
export const BACKTEST_ERROR_CODES = [
  'dataset_not_verified',
  'interrupted',
  'log_not_derivable',
  'out_of_memory',
  'part_integrity_failed',
  'part_too_large',
  'profile_not_supported',
  'result_too_large',
  'schedule_missing',
  'series_not_contiguous',
  'timeout',
  'version_unsupported',
  'warmup_too_short',
  'window_outside_series',
] as const;

/** Por qué se detiene una estrategia en un backtest (ADR-0022 §5 y §7; ADR-0024 §5). */
export const BACKTEST_STOP_CAUSES = [
  'connection_lost',
  'data_stale',
  'event_gap_unresolved',
  'health_not_healthy',
  'max_drawdown',
  'pending_continuity',
] as const;

/** Por qué queda omitida una señal o una salida (ADR-0022 §6 a §8; ADR-0024 §3 a §6). */
export const BACKTEST_OMIT_CAUSES = [
  ...BACKTEST_STOP_CAUSES,
  'candle_incomplete',
  'contract_not_offered',
  'market_closed',
  'max_entries_per_day',
  'min_seconds_between_entries',
  'schedule_unknown',
  'signal_expired',
  'signal_pending',
  'stop_loss_below_minimum',
  'take_profit_below_minimum',
  'window_closing',
] as const;

/** Por qué se cierra una posición (ADR-0022 §5; ADR-0024 §3). */
export const BACKTEST_CLOSE_CAUSES = [
  'exit_rule',
  'expiry',
  'max_duration',
  'stop_loss',
  'stop_out',
  'take_profit',
  'window_close',
] as const;

/** Los supuestos que declara un resultado (ADR-0024 §4 y §6). */
export const BACKTEST_ASSUMPTIONS = [
  'deriv_candles_decision_price',
  'first_offer_backwards',
  'first_quote_backwards',
  'history_profile',
  'schedule_from_midnight',
] as const;

/** Las filas de una parte, salvo la última de su clase, que tiene de 1 a esas (ADR-0024 §10). */
export const BACKTEST_PART_ROWS = 50_000;
export const BACKTEST_MAX_ROWS = 1_000_000;
const MIB = 1024 * 1024;

const STAKE = '10';
const STAKE_CENTS = 1000;
const HOUR_MS = 3_600_000;

const prefixedSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const centsSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** Una fracción no negativa con 6 decimales exactos, como `12.500000`. */
const fixed6Schema = z.string().regex(/^(?:0|[1-9][0-9]{0,14})\.[0-9]{6}$/u);
/** Con signo, sin `-0.000000`. */
const signedFixed6Schema = z
  .string()
  .regex(
    /^(?:(?:0|[1-9][0-9]{0,14})\.[0-9]{6}|-[1-9][0-9]{0,14}\.[0-9]{6}|-0\.(?:[1-9][0-9]{5}|0[1-9][0-9]{4}|00[1-9][0-9]{3}|000[1-9][0-9]{2}|0000[1-9][0-9]|00000[1-9]))$/u,
  );
/** Un importe en USD no negativo, en decimal canónico, con como mucho 18 decimales. */
const usdSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{0,17}[1-9])?$/u);

const executionSchema = z.strictObject({
  /** De la hora de la fuente del tick que decide a la orden en Deriv (§6). */
  latency_ms: z.number().int().min(0).max(5000),
  /** Multiplica lo que cobra Deriv (§6): 1, o las variantes de 1,5 y de 2. */
  cost_scale: z.enum(['1', '1.5', '2']),
});

/**
 * `BacktestSpec` 1.0.0 (ADR-0024 §1): una versión de estrategia sobre una serie de datasets, con una
 * ventana. Su identidad es el SHA-256 de su JCS (`deriveBacktestId`, §7).
 */
export const backtestSpecStructuralSchema = z
  .strictObject({
    schema_version: z.literal(BACKTEST_SCHEMA_VERSION),
    /** `deriveStrategyVersionId`, que incluye sus parámetros (ADR-0022 §9). */
    strategy_version_id: prefixedSha256Schema,
    /** Cada secuencia de `dataset_log_ranges` que usa, con sus datasets en su orden (§4). */
    series: z
      .array(
        z.strictObject({
          sequence: z.string().regex(/^[A-Za-z0-9_]{1,64}$/u),
          dataset_ids: z.array(datasetIdSchema).min(1).max(10_000),
        }),
      )
      .min(1)
      .max(8),
    indicators_from_utc: utcTimestampMsSchema,
    window_from_utc: utcTimestampMsSchema,
    window_to_utc: utcTimestampMsSchema,
    execution: executionSchema,
    versions: z.strictObject({
      backtest: z.literal(BACKTEST_VERSIONS.backtest),
      data_view: z.literal(BACKTEST_VERSIONS.data_view),
      strategy_evaluator: z.literal(BACKTEST_VERSIONS.strategy_evaluator),
      strategy_host: z.literal(BACKTEST_VERSIONS.strategy_host),
    }),
  })
  .meta({ id: 'BacktestSpec', title: 'BacktestSpec' });

export const backtestSpecSchema = backtestSpecStructuralSchema.superRefine((value, context) => {
  if (!isSortedUnique(value.series.map((item) => item.sequence))) {
    context.addIssue({
      code: 'custom',
      message: 'series va en orden de sequence, sin repetirla.',
      path: ['series'],
    });
  }
  const ids = value.series.flatMap((item) => item.dataset_ids);
  if (ids.length > 10_000) {
    context.addIssue({
      code: 'custom',
      message: 'La serie tiene como mucho 10 000 datasets.',
      path: ['series'],
    });
  }
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: 'custom',
      message: 'Un dataset aparece una sola vez en la serie.',
      path: ['series'],
    });
  }
  if (value.indicators_from_utc > value.window_from_utc) {
    context.addIssue({
      code: 'custom',
      message: 'indicators_from_utc no puede ser posterior a window_from_utc.',
      path: ['indicators_from_utc'],
    });
  }
  if (!(value.window_from_utc < value.window_to_utc)) {
    context.addIssue({
      code: 'custom',
      message: 'La ventana [window_from_utc, window_to_utc) no puede estar vacía.',
      path: ['window_to_utc'],
    });
  }
});

export type BacktestSpec = z.infer<typeof backtestSpecStructuralSchema>;

/** La identidad de un backtest: `sha256:` y el SHA-256 del JCS de su `BacktestSpec` (§7). */
export function deriveBacktestId(spec: BacktestSpec): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(spec))}`;
}

/**
 * El dato de la serie que decidió o con el que entra o sale una posición: su dataset, el
 * `observation_id` de su frame y su hora de la fuente (la de un tick; de una vela, su apertura).
 */
const placeSchema = z.strictObject({
  dataset_id: datasetIdSchema,
  observation_id: uuidV7Schema,
  source_time_utc: utcTimestampMsSchema,
});

const decisionCommon = {
  schema_version: z.literal(BACKTEST_SCHEMA_VERSION),
  /** Su número en el resultado, desde 0, sin saltos. */
  decision_number: nonNegativeIntegerSchema,
  instant_utc: utcTimestampMsSchema,
  /** `null` si la decidió el paso del tiempo, la apertura o el cierre de la ventana. */
  place: placeSchema.nullable(),
  quality_profile_id: qualityProfileIdSchema,
  quality_profile_sha256: sha256HexSchema,
};

/**
 * `BacktestDecision` 1.0.0 (ADR-0024 §10): una fila por decisión. Las omisiones seguidas con la misma
 * causa, de la misma decisión y sin otra decisión entre ellas van en una sola fila, con su número y
 * su último instante.
 */
export const backtestDecisionStructuralSchema = z
  .discriminatedUnion('decision', [
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('entrar'),
      cause: z.literal('entry_rule'),
      contract: strategyContractSchema,
      stake: z.literal(STAKE),
      /** La hora de la fuente del tick que decidió más la latencia (§6). */
      purchase_utc: utcTimestampMsSchema,
      /** La compra más `signal_expiry_ms`; `null` con velas de Deriv, que entran sin latencia. */
      signal_expires_utc: utcTimestampMsSchema.nullable(),
    }),
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('salir'),
      cause: z.literal('exit_rule'),
      position_number: nonNegativeIntegerSchema,
    }),
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('liquidar'),
      cause: z.enum(BACKTEST_CLOSE_CAUSES),
      position_number: nonNegativeIntegerSchema,
      result_cents: centsSchema,
    }),
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('omitir'),
      cause: z.enum(BACKTEST_OMIT_CAUSES),
      omitted: z.enum(['entrar', 'salir']),
      count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      last_instant_utc: utcTimestampMsSchema,
    }),
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('detener'),
      cause: z.enum(BACKTEST_STOP_CAUSES),
    }),
    z.strictObject({
      ...decisionCommon,
      decision: z.literal('reanudar'),
      cause: z.literal('data_policy_met'),
    }),
  ])
  .meta({ id: 'BacktestDecision', title: 'BacktestDecision' });

export const backtestDecisionSchema = backtestDecisionStructuralSchema.superRefine(
  (value, context) => {
    if (value.decision === 'omitir') {
      const last = value.last_instant_utc;
      if (value.count === 1 ? last !== value.instant_utc : !(last >= value.instant_utc)) {
        context.addIssue({
          code: 'custom',
          message: 'last_instant_utc es instant_utc con una omisión, y no anterior con varias.',
          path: ['last_instant_utc'],
        });
      }
    }
    if (value.decision === 'entrar') {
      if (value.place !== null && value.purchase_utc < value.place.source_time_utc) {
        context.addIssue({
          code: 'custom',
          message: 'La compra no es anterior al tick que decidió.',
          path: ['purchase_utc'],
        });
      }
      const expires = value.signal_expires_utc;
      if (expires !== null && !(expires > value.purchase_utc)) {
        context.addIssue({
          code: 'custom',
          message: 'La señal vence después de la compra.',
          path: ['signal_expires_utc'],
        });
      }
    }
  },
);

export type BacktestDecision = z.infer<typeof backtestDecisionStructuralSchema>;

/**
 * `BacktestPosition` 1.0.0 (ADR-0024 §10): cada posición hipotética, nunca una orden (ADR-0002),
 * con su entrada, su salida, su resultado, la cotización que usó y sus marcas.
 */
export const backtestPositionStructuralSchema = z
  .strictObject({
    schema_version: z.literal(BACKTEST_SCHEMA_VERSION),
    position_number: nonNegativeIntegerSchema,
    entry_decision_number: nonNegativeIntegerSchema,
    close_decision_number: nonNegativeIntegerSchema,
    contract: strategyContractSchema,
    stake: z.literal(STAKE),
    purchase_utc: utcTimestampMsSchema,
    entry: z.strictObject({ place: placeSchema, price: decimalStringSchema }),
    exit: z.strictObject({
      cause: z.enum(BACKTEST_CLOSE_CAUSES),
      place: placeSchema,
      /** `null` si una vela de Deriv tocó un umbral y vale el umbral exacto. */
      price: decimalStringSchema.nullable(),
    }),
    /** Redondeado al centavo, al par (ADR-0022 §5). */
    result_cents: centsSchema,
    /** En un sube/baja, si ganó; `null` en un multiplicador. */
    won: z.boolean().nullable(),
    costs: z.strictObject({
      kind: z.enum(['commission', 'payout']),
      /** El de la cotización, con la apuesta de 10 USD. */
      quoted: usdSchema,
      /** El que usó, con `cost_scale` (§6). */
      applied: usdSchema,
      /** La cotización más reciente anterior a la entrada, o la primera, aplicada hacia atrás. */
      basis: z.enum(['quote', 'first_quote_backwards']),
      quote: z.strictObject({
        dataset_id: datasetIdSchema,
        observation_id: uuidV7Schema,
        received_at_utc: utcTimestampMsSchema,
      }),
    }),
    offer_basis: z.enum(['offer', 'first_offer_backwards']),
    /** Cruzó un intervalo sin datos registrados dentro del horario (§5). */
    estimated: z.boolean(),
    liquidated_at_window_close: z.boolean(),
    /** Con `basis` `quote`, una cotización de más de 1 hora antes de la entrada. */
    stale_quote: z.boolean(),
  })
  .meta({ id: 'BacktestPosition', title: 'BacktestPosition' });

/** Compara dos decimales no negativos, sin pasar por binario64. */
function compareDecimal(left: string, right: string): number {
  const [leftInteger = '', leftFraction = ''] = left.split('.');
  const [rightInteger = '', rightFraction = ''] = right.split('.');
  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length - rightInteger.length;
  }
  const width = Math.max(leftFraction.length, rightFraction.length);
  const a = leftInteger + leftFraction.padEnd(width, '0');
  const b = rightInteger + rightFraction.padEnd(width, '0');
  return a < b ? -1 : a > b ? 1 : 0;
}

export const backtestPositionSchema = backtestPositionStructuralSchema.superRefine(
  (value, context) => {
    const issue = (message: string, path: (number | string)[]) => {
      context.addIssue({ code: 'custom', message, path });
    };
    const multiplier = 'multiplier' in value.contract;
    const cause = value.exit.cause;

    if (value.costs.kind !== (multiplier ? 'commission' : 'payout')) {
      issue('Un multiplicador paga comisión, y un sube/baja cobra un pago.', ['costs', 'kind']);
    }
    if (
      value.costs.kind === 'commission' &&
      compareDecimal(value.costs.applied, value.costs.quoted) < 0
    ) {
      issue('cost_scale no baja la comisión.', ['costs', 'applied']);
    }
    if (
      value.costs.kind === 'payout' &&
      (compareDecimal(value.costs.applied, value.costs.quoted) > 0 ||
        compareDecimal(value.costs.applied, STAKE) < 0)
    ) {
      issue('El pago usado no sube con cost_scale ni baja de la apuesta.', ['costs', 'applied']);
    }
    if (value.costs.basis === 'first_quote_backwards' && value.stale_quote) {
      issue('Un supuesto de costos no es una cotización vieja.', ['stale_quote']);
    }
    if (
      value.costs.basis === 'quote' &&
      value.stale_quote !==
        Date.parse(value.entry.place.source_time_utc) -
          Date.parse(value.costs.quote.received_at_utc) >
          HOUR_MS
    ) {
      issue('stale_quote es una cotización de más de 1 hora antes de la entrada.', ['stale_quote']);
    }

    if (multiplier) {
      if (value.won !== null) {
        issue('won solo va en un sube/baja.', ['won']);
      }
      if (cause === 'expiry') {
        issue('Un multiplicador no vence.', ['exit', 'cause']);
      }
      if (value.result_cents < -STAKE_CENTS) {
        issue('Un multiplicador no pierde más que la apuesta.', ['result_cents']);
      }
      if (cause === 'stop_out' && value.result_cents !== -STAKE_CENTS) {
        issue('stop_out pierde la apuesta entera.', ['result_cents']);
      }
      const contract = value.contract as { stop_loss: string | null; take_profit: string | null };
      if (cause === 'stop_loss' && contract.stop_loss === null) {
        issue('stop_loss necesita un stop loss en el contrato.', ['exit', 'cause']);
      }
      if (cause === 'take_profit' && contract.take_profit === null) {
        issue('take_profit necesita un take profit en el contrato.', ['exit', 'cause']);
      }
    } else {
      if (value.won === null) {
        issue('Un sube/baja gana o pierde.', ['won']);
      }
      if (cause !== 'expiry' && cause !== 'window_close') {
        issue('Un sube/baja sale al vencer o al cerrar la ventana.', ['exit', 'cause']);
      }
      if (value.won === false && value.result_cents !== -STAKE_CENTS) {
        issue('Un sube/baja que pierde pierde la apuesta.', ['result_cents']);
      }
      if (value.won === true && value.result_cents < 0) {
        issue('Un sube/baja que gana no pierde.', ['result_cents']);
      }
    }

    if (value.exit.price === null && !['stop_loss', 'stop_out', 'take_profit'].includes(cause)) {
      issue('Solo un umbral exacto sale sin precio.', ['exit', 'price']);
    }
    if (cause === 'window_close' && !value.liquidated_at_window_close) {
      issue('window_close es una liquidación al cerrar la ventana.', [
        'liquidated_at_window_close',
      ]);
    }
    if (value.liquidated_at_window_close && cause !== 'window_close' && cause !== 'expiry') {
      issue('Al cerrar la ventana se liquida con window_close o con expiry.', ['exit', 'cause']);
    }
    if (value.entry.place.source_time_utc < value.purchase_utc) {
      issue('La posición empieza en la compra o después.', ['entry', 'place']);
    }
    if (value.exit.place.source_time_utc < value.entry.place.source_time_utc) {
      issue('La salida no es anterior a la entrada.', ['exit', 'place']);
    }
    if (!(value.close_decision_number > value.entry_decision_number)) {
      issue('La liquidación va después de la entrada.', ['close_decision_number']);
    }
  },
);

export type BacktestPosition = z.infer<typeof backtestPositionStructuralSchema>;

const positiveSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const outcomeSchema = z.strictObject({
  count: nonNegativeIntegerSchema,
  sum_cents: centsSchema,
  mean_cents: centsSchema.nullable(),
  median_cents: centsSchema.nullable(),
  /** La mayor: en las pérdidas, la más negativa. */
  largest_cents: centsSchema.nullable(),
});

/** Las métricas que calcula el backtest (ADR-0024 §10). */
const metricsSchema = z.strictObject({
  sample: z.strictObject({
    event_count: nonNegativeIntegerSchema,
    used_ticks: nonNegativeIntegerSchema,
    used_candles: nonNegativeIntegerSchema,
    days_with_data: nonNegativeIntegerSchema,
  }),
  trade_count: nonNegativeIntegerSchema,
  /** En orden de `cause`, solo las que se dieron, como las demás listas. */
  trades_by_close_cause: z.array(
    z.strictObject({ cause: z.enum(BACKTEST_CLOSE_CAUSES), count: positiveSchema }),
  ),
  net_result_cents: centsSchema,
  /** En % del capital inicial. */
  net_result_percent: signedFixed6Schema,
  commissions_paid_cents: nonNegativeIntegerSchema,
  /** En un sube/baja con operaciones; si no, `null`. */
  mean_quoted_payout_cents: nonNegativeIntegerSchema.nullable(),
  max_drawdown: z.strictObject({
    /** En % del capital inicial. */
    percent: fixed6Schema,
    peak_utc: utcTimestampMsSchema.nullable(),
    trough_utc: utcTimestampMsSchema.nullable(),
    /** Del valle a la recuperación; `null` sin caída o «sin recuperar». */
    recovery_ms: nonNegativeIntegerSchema.nullable(),
  }),
  /** % del tiempo de la ventana con una posición abierta. */
  exposure_percent: fixed6Schema,
  /** Por día UTC con datos; `null` sin días con datos. */
  trades_per_day: fixed6Schema.nullable(),
  wins: outcomeSchema,
  losses: outcomeSchema,
  /** `null` sin operaciones. */
  hit_rate_percent: fixed6Schema.nullable(),
  /** Las decisiones omitidas, contando cada una de una fila agrupada. */
  omitted_by_cause: z.array(
    z.strictObject({ cause: z.enum(BACKTEST_OMIT_CAUSES), count: positiveSchema }),
  ),
  stopped_ms_by_cause: z.array(
    z.strictObject({ cause: z.enum(BACKTEST_STOP_CAUSES), ms: positiveSchema }),
  ),
  estimated_positions: nonNegativeIntegerSchema,
  window_close_positions: nonNegativeIntegerSchema,
  stale_quote_positions: nonNegativeIntegerSchema,
  cost_assumption_positions: nonNegativeIntegerSchema,
  offer_assumption_positions: nonNegativeIntegerSchema,
  /** Las incidencias de los datasets de la serie, por tipo. */
  dataset_incidents: z.array(
    z.strictObject({ incident_type: dataQualityIncidentTypeSchema, count: positiveSchema }),
  ),
});

const partSchema = z.strictObject({
  part_class: z.enum(['decisions', 'positions']),
  part_index: z.number().int().min(0).max(19),
  row_count: z.number().int().min(1).max(BACKTEST_PART_ROWS),
  /** El SHA-256 del objeto en gzip, que es su nombre (ADR-0023 §7). */
  object_sha256: sha256HexSchema,
  object_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * MIB),
  /** El SHA-256 de su NDJSON, una fila en JCS por línea (`canonicalSequence`). */
  logical_sha256: sha256HexSchema,
  logical_bytes: z
    .number()
    .int()
    .min(1)
    .max(64 * MIB),
});

const printableSchema = (maximum: number) =>
  z.string().regex(new RegExp(`^[\\x20-\\x7E]{1,${String(maximum)}}$`, 'u'));

/** Dónde y con qué corrió: se guarda con el resultado, fuera de la comparación (§7). */
const environmentSchema = z.strictObject({
  runner: z.enum(['vps', 'api']),
  node_version: z.string().regex(/^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/u),
  cpu_model: printableSchema(256),
  /** En orden de `name`. */
  packages: z
    .array(
      z.strictObject({
        name: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u),
        version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/u),
      }),
    )
    .min(1)
    .max(32),
});

/**
 * `BacktestResult` 1.0.0 (ADR-0024 §10): el manifiesto, en JCS y de 1 MiB como mucho, con sus
 * métricas, sus supuestos y sus partes. Su hash lógico es el de su JCS sin `environment`
 * (`deriveBacktestResultLogicalSha256`).
 */
export const backtestResultStructuralSchema = z
  .strictObject({
    schema_version: z.literal(BACKTEST_SCHEMA_VERSION),
    /** `deriveBacktestId` de su `BacktestSpec`. */
    backtest_id: prefixedSha256Schema,
    status: z.enum(['completed', 'failed']),
    error_code: z.enum(BACKTEST_ERROR_CODES).nullable(),
    metrics: metricsSchema.nullable(),
    /** Los que usó la ventana, con las decisiones que se tomaron con cada uno. */
    assumptions: z
      .array(
        z.strictObject({
          assumption: z.enum(BACKTEST_ASSUMPTIONS),
          decisions: nonNegativeIntegerSchema,
        }),
      )
      .nullable(),
    /** Las de decisiones y después las de posiciones, cada clase desde 0. */
    parts: z.array(partSchema).max(40),
    environment: environmentSchema,
  })
  .meta({ id: 'BacktestResult', title: 'BacktestResult' });

/** `cents / 1000` con 6 decimales: el % de un capital de 1000 USD, exacto. */
function percentOfCapital(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const micro = Math.abs(cents) * 1000;
  const integer = Math.floor(micro / 1_000_000);
  return `${sign}${String(integer)}.${String(micro % 1_000_000).padStart(6, '0')}`;
}

export const backtestResultSchema = backtestResultStructuralSchema.superRefine((value, context) => {
  const issue = (message: string, path: (number | string)[]) => {
    context.addIssue({ code: 'custom', message, path });
  };

  if (value.status === 'failed') {
    if (
      value.error_code === null ||
      value.metrics !== null ||
      value.assumptions !== null ||
      value.parts.length > 0
    ) {
      issue('Un resultado fallido lleva su código y no tiene métricas, supuestos ni partes.', [
        'status',
      ]);
    }
    return;
  }
  if (value.error_code !== null || value.metrics === null || value.assumptions === null) {
    issue('Un resultado completo no tiene código y tiene métricas y supuestos.', ['status']);
    return;
  }

  if (!isSortedUnique(value.assumptions.map((item) => item.assumption))) {
    issue('assumptions va en orden, sin repetir.', ['assumptions']);
  }

  // Las partes: primero las de decisiones; cada clase, desde 0 y sin saltos, todas llenas salvo la
  // última, para que el reparto sea el mismo en cualquier máquina.
  const rows = { decisions: 0, positions: 0 };
  let previous: (typeof value.parts)[number] | undefined;
  value.parts.forEach((part, index) => {
    const sameClass = previous?.part_class === part.part_class;
    const expectedIndex = sameClass && previous !== undefined ? previous.part_index + 1 : 0;
    if (
      (previous?.part_class === 'positions' && part.part_class === 'decisions') ||
      part.part_index !== expectedIndex
    ) {
      issue('Las partes van por clase y por índice, desde 0.', ['parts', index]);
    }
    if (sameClass && previous !== undefined && previous.row_count !== BACKTEST_PART_ROWS) {
      issue('Solo la última parte de su clase tiene menos de 50 000 filas.', ['parts', index - 1]);
    }
    rows[part.part_class] += part.row_count;
    previous = part;
  });
  if (rows.decisions + rows.positions > BACKTEST_MAX_ROWS) {
    issue('Un resultado tiene como mucho 1 000 000 de filas.', ['parts']);
  }

  const metrics = value.metrics;
  if (metrics.trade_count !== rows.positions) {
    issue('trade_count es el número de posiciones.', ['metrics', 'trade_count']);
  }
  const keys = {
    trades_by_close_cause: metrics.trades_by_close_cause.map((item) => item.cause),
    omitted_by_cause: metrics.omitted_by_cause.map((item) => item.cause),
    stopped_ms_by_cause: metrics.stopped_ms_by_cause.map((item) => item.cause),
    dataset_incidents: metrics.dataset_incidents.map((item) => item.incident_type),
  };
  for (const [name, values] of Object.entries(keys)) {
    if (!isSortedUnique(values)) {
      issue(`${name} va en orden, sin repetir.`, ['metrics', name]);
    }
  }
  const byCause = metrics.trades_by_close_cause.reduce((sum, item) => sum + item.count, 0);
  if (byCause !== metrics.trade_count) {
    issue('trades_by_close_cause suma trade_count.', ['metrics', 'trades_by_close_cause']);
  }
  if (metrics.net_result_cents !== metrics.wins.sum_cents + metrics.losses.sum_cents) {
    issue('El resultado neto es la suma de ganancias y pérdidas.', ['metrics', 'net_result_cents']);
  }
  if (metrics.net_result_percent !== percentOfCapital(metrics.net_result_cents)) {
    issue('net_result_percent es net_result_cents en % de 1000 USD.', [
      'metrics',
      'net_result_percent',
    ]);
  }
  if (metrics.wins.count + metrics.losses.count > metrics.trade_count) {
    issue('Las ganancias y las pérdidas no pasan de trade_count.', ['metrics', 'wins']);
  }
  for (const [name, sign] of [
    ['wins', 1],
    ['losses', -1],
  ] as const) {
    const outcome = metrics[name];
    const values = [outcome.mean_cents, outcome.median_cents, outcome.largest_cents];
    const ok =
      outcome.count === 0
        ? outcome.sum_cents === 0 && values.every((item) => item === null)
        : outcome.sum_cents * sign > 0 && values.every((item) => item !== null && item * sign > 0);
    if (!ok) {
      issue(`${name}: sin operaciones, sin cifras; con ellas, del signo que les toca.`, [
        'metrics',
        name,
      ]);
    }
  }
  if ((metrics.hit_rate_percent === null) !== (metrics.trade_count === 0)) {
    issue('hit_rate_percent es null solo sin operaciones.', ['metrics', 'hit_rate_percent']);
  }
  if ((metrics.trades_per_day === null) !== (metrics.sample.days_with_data === 0)) {
    issue('trades_per_day es null solo sin días con datos.', ['metrics', 'trades_per_day']);
  }
  for (const name of ['exposure_percent', 'hit_rate_percent'] as const) {
    const percent = metrics[name];
    if (percent !== null && compareDecimal(percent, '100') > 0) {
      issue(`${name} no pasa de 100.`, ['metrics', name]);
    }
  }
  for (const name of [
    'estimated_positions',
    'window_close_positions',
    'stale_quote_positions',
    'cost_assumption_positions',
    'offer_assumption_positions',
  ] as const) {
    if (metrics[name] > metrics.trade_count) {
      issue(`${name} no pasa de trade_count.`, ['metrics', name]);
    }
  }
  const drawdown = metrics.max_drawdown;
  const none = drawdown.percent === '0.000000';
  if (
    none
      ? drawdown.peak_utc !== null || drawdown.trough_utc !== null || drawdown.recovery_ms !== null
      : drawdown.peak_utc === null ||
        drawdown.trough_utc === null ||
        drawdown.peak_utc > drawdown.trough_utc
  ) {
    issue('Una caída tiene su máximo antes de su valle; sin caída, ninguno.', [
      'metrics',
      'max_drawdown',
    ]);
  }
});

export type BacktestResult = z.infer<typeof backtestResultStructuralSchema>;

/** El hash lógico de un manifiesto: el SHA-256 de su JCS sin `environment` (§7). */
export function deriveBacktestResultLogicalSha256(result: BacktestResult): string {
  const logical = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'environment'),
  ) as JsonValue;
  return sha256Hex(canonicalJson(logical));
}

/** El techo del manifiesto en JCS (§10). */
export const BACKTEST_RESULT_MAX_BYTES = MIB;
