import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  backtestDecisionSchema,
  backtestPositionSchema,
  backtestResultSchema,
  backtestSpecSchema,
  dataViewEventSchema,
  deriveBacktestId,
  deriveBacktestResultLogicalSha256,
  type BacktestResult,
  type BacktestSpec,
} from '../src/index.js';

// Los contratos del backtest y de la vista (ADR-0024 §1, §2, §7 y §10; contratos de dominio,
// «DataViewEvent» y «Backtest»). Los ejemplos válidos están en un JSON aparte, y los hashes que
// esperan se calcularon fuera de packages/contracts, con Python (`hashlib` y `json.dumps` con
// `sort_keys` y sin espacios, que da el JCS de estos valores, sin decimales binarios).
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/backtest-contracts.json', import.meta.url), 'utf8'),
) as {
  decisions: Record<string, unknown>[];
  failed: BacktestResult;
  positions: Record<string, unknown>[];
  result: BacktestResult;
  spec: BacktestSpec;
  view: { health: Record<string, unknown>; tick: Record<string, unknown> };
};

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function exportedValidator(name: string) {
  const url = import.meta.resolve(`@buoh/contracts/json-schema/${name}`);
  return ajv.compile(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as object);
}

const validators = {
  decision: exportedValidator('backtest-decision'),
  position: exportedValidator('backtest-position'),
  result: exportedValidator('backtest-result'),
  spec: exportedValidator('backtest-spec'),
  view: exportedValidator('data-view-event'),
};

type Kind = keyof typeof validators;
const runtime: Record<Kind, z.ZodType> = {
  decision: backtestDecisionSchema,
  position: backtestPositionSchema,
  result: backtestResultSchema,
  spec: backtestSpecSchema,
  view: dataViewEventSchema,
};

const clone = <T>(value: T): T => structuredClone(value);
type Mutable = Record<string, unknown>;

/** Un cambio a un ejemplo válido, sobre una copia. */
function edit(value: unknown, change: (copy: Mutable) => void): unknown {
  const copy = clone(value) as Mutable;
  change(copy);
  return copy;
}

/** El tick de la vista sin `unrecorded_since_utc`. */
const withoutSince = (tick: Mutable): Mutable =>
  Object.fromEntries(Object.entries(tick).filter(([key]) => key !== 'unrecorded_since_utc'));

const at = (value: unknown, ...path: (number | string)[]): Mutable =>
  path.reduce<unknown>((item, key) => (item as Mutable)[key], value) as Mutable;

function expectValid(kind: Kind, value: unknown, label: string): void {
  const parsed = runtime[kind].safeParse(value);
  expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  expect(validators[kind](value), label).toBe(true);
}

/** Lo rechazan la forma de Zod y el JSON Schema. */
function expectStructural(kind: Kind, value: unknown, label: string): void {
  expect(runtime[kind].safeParse(value).success, label).toBe(false);
  expect(validators[kind](value), label).toBe(false);
}

/** Lo acepta el JSON Schema, que describe la forma; solo el runtime lo rechaza. */
function expectRuntimeOnly(kind: Kind, value: unknown, label: string): void {
  expect(validators[kind](value), label).toBe(true);
  expect(runtime[kind].safeParse(value).success, label).toBe(false);
}

const [tickPosition, callputPosition] = fixtures.positions;
const result = fixtures.result;

describe('BacktestSpec 1.0.0 (ADR-0024 §1 y §7)', () => {
  it('acepta un spec y su identidad es el SHA-256 de su JCS', () => {
    expectValid('spec', fixtures.spec, 'spec');
    expect(deriveBacktestId(fixtures.spec)).toBe(
      'sha256:19bf111b6df1e98eccd4746ee46e23d67a66af01b14edf38f221642e518c1b55',
    );
    const variant = clone(fixtures.spec);
    variant.execution.latency_ms = 2000;
    expect(deriveBacktestId(variant)).toBe(
      'sha256:c035e3c09b03c2778474337b47a260858b21d388c4fe98937dcc629bb280a454',
    );
    // El orden de las claves no cambia la identidad.
    const reordered = Object.fromEntries(Object.entries(fixtures.spec).reverse()) as BacktestSpec;
    expect(deriveBacktestId(reordered)).toBe(deriveBacktestId(fixtures.spec));
  });

  it('rechaza una versión que no conoce, sin adivinar', () => {
    for (const key of ['backtest', 'data_view', 'strategy_evaluator', 'strategy_host']) {
      expectStructural(
        'spec',
        edit(fixtures.spec, (copy) => {
          at(copy, 'versions')[key] = `${String(at(copy, 'versions')[key])}x`;
        }),
        key,
      );
    }
    expectStructural('spec', { ...fixtures.spec, schema_version: '1.1.0' }, 'schema_version');
  });

  it('acota los supuestos de ejecución', () => {
    const execution = (change: Mutable) => ({
      ...fixtures.spec,
      execution: { ...fixtures.spec.execution, ...change },
    });
    expectValid('spec', execution({ latency_ms: 0, cost_scale: '1.5' }), 'latencia 0');
    expectValid('spec', execution({ latency_ms: 5000, cost_scale: '2' }), 'latencia 5000');
    expectStructural('spec', execution({ latency_ms: 5001 }), 'latencia 5001');
    expectStructural('spec', execution({ latency_ms: -1 }), 'latencia negativa');
    expectStructural('spec', execution({ cost_scale: '3' }), 'cost_scale 3');
    expectStructural('spec', execution({ cost_scale: '1.50' }), 'cost_scale 1.50');
    expectStructural('spec', { ...fixtures.spec, extra: true }, 'campo de más');
  });

  it('rechaza en runtime una serie o una ventana inconsistentes', () => {
    const [first, second, third] = fixtures.spec.series;
    expectRuntimeOnly(
      'spec',
      { ...fixtures.spec, series: [second, first, third] },
      'secuencias sin orden',
    );
    expectRuntimeOnly(
      'spec',
      edit(fixtures.spec, (copy) => {
        (at(copy, 'series', 1)['dataset_ids'] as string[]).push(first?.dataset_ids[0] ?? '');
      }),
      'dataset repetido',
    );
    expectRuntimeOnly(
      'spec',
      { ...fixtures.spec, indicators_from_utc: '2026-11-02T00:00:00.001Z' },
      'indicadores después de la ventana',
    );
    expectValid(
      'spec',
      { ...fixtures.spec, indicators_from_utc: fixtures.spec.window_from_utc },
      'indicadores desde la ventana',
    );
    expectRuntimeOnly(
      'spec',
      { ...fixtures.spec, window_to_utc: fixtures.spec.window_from_utc },
      'ventana vacía',
    );
  });
});

describe('BacktestDecision 1.0.0 (ADR-0024 §10)', () => {
  it('acepta cada clase de decisión', () => {
    for (const decision of fixtures.decisions) {
      expectValid('decision', decision, String(decision['decision']));
    }
  });

  it('rechaza una causa de otra clase y una clase desconocida', () => {
    const [entrar, liquidar, omitir, salir, detener, reanudar] = fixtures.decisions;
    expectStructural('decision', { ...liquidar, cause: 'signal_pending' }, 'liquidar');
    expectStructural('decision', { ...detener, cause: 'market_closed' }, 'detener');
    expectStructural('decision', { ...omitir, cause: 'stop_out' }, 'omitir');
    expectStructural('decision', { ...salir, cause: 'max_duration' }, 'salir');
    expectStructural('decision', { ...reanudar, cause: 'owner_resume' }, 'reanudar');
    expectStructural('decision', { ...entrar, decision: 'vender' }, 'clase');
    expectStructural('decision', { ...omitir, count: 0 }, 'sin omisiones');
    expectStructural('decision', { ...entrar, stake: '20' }, 'apuesta');
  });

  it('rechaza en runtime los instantes inconsistentes', () => {
    const [entrar, , omitir] = fixtures.decisions;
    expectRuntimeOnly('decision', { ...omitir, count: 1 }, 'una omisión con otro último instante');
    expectValid(
      'decision',
      { ...omitir, count: 1, last_instant_utc: omitir?.['instant_utc'] },
      'una omisión',
    );
    expectRuntimeOnly(
      'decision',
      { ...omitir, last_instant_utc: '2026-11-02T00:00:59.000Z' },
      'último instante anterior',
    );
    expectRuntimeOnly(
      'decision',
      { ...entrar, purchase_utc: '2026-11-02T00:00:09.999Z' },
      'compra anterior al tick que decidió',
    );
    expectRuntimeOnly(
      'decision',
      { ...entrar, signal_expires_utc: entrar?.['purchase_utc'] },
      'señal que vence en la compra',
    );
    expectValid('decision', { ...entrar, signal_expires_utc: null }, 'velas de Deriv');
  });
});

describe('BacktestPosition 1.0.0 (ADR-0024 §10; ADR-0022 §5)', () => {
  it('acepta un multiplicador y un sube/baja', () => {
    expectValid('position', tickPosition, 'multiplicador');
    expectValid('position', callputPosition, 'sube/baja');
  });

  it('rechaza en runtime lo que no puede pasar en Deriv', () => {
    const exit = (value: unknown, change: Mutable) =>
      edit(value, (copy) => Object.assign(at(copy, 'exit'), change));
    const costs = (value: unknown, change: Mutable) =>
      edit(value, (copy) => Object.assign(at(copy, 'costs'), change));
    const cases: [string, unknown][] = [
      ['un multiplicador con pago', costs(tickPosition, { kind: 'payout' })],
      ['un sube/baja con comisión', costs(callputPosition, { kind: 'commission' })],
      ['una comisión que baja', costs(tickPosition, { applied: '0.35' })],
      ['un pago que sube', costs(callputPosition, { applied: '19.6' })],
      [
        'un pago por debajo de la apuesta',
        costs(callputPosition, { applied: '9.99', quoted: '9.99' }),
      ],
      ['un multiplicador con won', { ...tickPosition, won: true }],
      ['un multiplicador que vence', exit(tickPosition, { cause: 'expiry' })],
      ['un multiplicador que pierde más que la apuesta', { ...tickPosition, result_cents: -1001 }],
      [
        'un stop out sin la apuesta entera',
        exit({ ...tickPosition, result_cents: -900 }, { cause: 'stop_out' }),
      ],
      ['un take profit sin take profit', exit(tickPosition, { cause: 'take_profit' })],
      ['un sube/baja sin won', { ...callputPosition, won: null }],
      ['un sube/baja con stop loss', exit(callputPosition, { cause: 'stop_loss' })],
      [
        'un sube/baja que pierde menos que la apuesta',
        { ...callputPosition, won: false, result_cents: -900 },
      ],
      ['un sube/baja que gana y pierde', { ...callputPosition, result_cents: -1 }],
      ['una salida sin precio al vencer', exit(callputPosition, { price: null })],
      ['window_close sin la marca', exit(tickPosition, { cause: 'window_close' })],
      ['la marca con stop_loss', { ...tickPosition, liquidated_at_window_close: true }],
      [
        'una entrada antes de la compra',
        { ...tickPosition, purchase_utc: '2026-11-02T00:00:12.001Z' },
      ],
      [
        'una salida antes de la entrada',
        exit(tickPosition, {
          place: {
            ...at(tickPosition, 'exit', 'place'),
            source_time_utc: '2026-11-02T00:00:11.999Z',
          },
        }),
      ],
      ['una liquidación antes de la entrada', { ...tickPosition, close_decision_number: 0 }],
      ['un supuesto de costos viejo', { ...callputPosition, stale_quote: true }],
      ['una cotización de 5 minutos vieja', { ...tickPosition, stale_quote: true }],
    ];
    for (const [label, value] of cases) {
      expectRuntimeOnly('position', value, label);
    }
  });

  it('marca stale_quote con una cotización de más de 1 hora', () => {
    const old = (receivedAt: string, stale: boolean) =>
      edit({ ...tickPosition, stale_quote: stale }, (copy) => {
        at(copy, 'costs', 'quote')['received_at_utc'] = receivedAt;
      });
    expectValid('position', old('2026-11-01T23:00:12.000Z', false), 'justo 1 hora');
    expectRuntimeOnly('position', old('2026-11-01T23:00:12.000Z', true), 'justo 1 hora, vieja');
    expectValid('position', old('2026-11-01T23:00:11.999Z', true), 'más de 1 hora');
    expectRuntimeOnly('position', old('2026-11-01T23:00:11.999Z', false), 'más de 1 hora, nueva');
  });

  it('acepta un umbral exacto de una vela sin precio y una liquidación al cerrar la ventana', () => {
    expectValid(
      'position',
      edit(
        {
          ...tickPosition,
          contract: { ...at(tickPosition, 'contract'), take_profit: '20' },
          result_cents: 2000,
        },
        (copy) => {
          Object.assign(at(copy, 'exit'), { cause: 'take_profit', price: null });
        },
      ),
      'take profit exacto',
    );
    expectValid(
      'position',
      edit({ ...tickPosition, liquidated_at_window_close: true, result_cents: -120 }, (copy) => {
        at(copy, 'exit')['cause'] = 'window_close';
      }),
      'multiplicador liquidado',
    );
    expectValid(
      'position',
      { ...callputPosition, liquidated_at_window_close: true },
      'sube/baja vencido, liquidado al cerrar',
    );
  });
});

describe('BacktestResult 1.0.0 (ADR-0024 §7 y §10)', () => {
  it('acepta un resultado completo y uno fallido, con su hash lógico sin el entorno', () => {
    expectValid('result', result, 'completo');
    expectValid('result', fixtures.failed, 'fallido');
    expect(deriveBacktestResultLogicalSha256(result)).toBe(
      '2f56cd5e0dc74a118db4ef078442f8f8bc7a1610fc65e6fd393568cea291f426',
    );
    expect(deriveBacktestResultLogicalSha256(fixtures.failed)).toBe(
      '436acb5778004fd0c7023cc23f15eab9f902ec21379827071bb6cc542c68af65',
    );
    const elsewhere = edit(result, (copy) => {
      Object.assign(at(copy, 'environment'), { runner: 'api', cpu_model: 'Otro' });
    }) as BacktestResult;
    expect(deriveBacktestResultLogicalSha256(elsewhere)).toBe(
      deriveBacktestResultLogicalSha256(result),
    );
  });

  it('rechaza un código fuera de la lista cerrada', () => {
    expectStructural('result', { ...fixtures.failed, error_code: 'crashed' }, 'código');
    expectStructural('result', { ...result, extra: 1 }, 'campo de más');
    expectStructural(
      'result',
      edit(result, (copy) => {
        at(copy, 'parts', 0)['row_count'] = 50_001;
      }),
      'parte de más de 50 000 filas',
    );
    expectStructural(
      'result',
      edit(result, (copy) => {
        at(copy, 'metrics')['net_result_percent'] = '-0.000000';
      }),
      '-0',
    );
  });

  it('rechaza en runtime un manifiesto inconsistente', () => {
    const metrics = (change: Mutable) =>
      edit(result, (copy) => Object.assign(at(copy, 'metrics'), change));
    const parts = result.parts;
    const fullPart = { ...parts[0], row_count: 50_000 };
    const cases: [string, unknown][] = [
      ['fallido con métricas', { ...fixtures.failed, metrics: result.metrics }],
      ['fallido con partes', { ...fixtures.failed, parts }],
      ['fallido sin código', { ...fixtures.failed, error_code: null }],
      ['completo con código', { ...result, error_code: 'timeout' }],
      ['completo sin supuestos', { ...result, assumptions: null }],
      ['partes fuera de orden', { ...result, parts: [parts[1], parts[0]] }],
      ['índice con salto', { ...result, parts: [parts[0], { ...parts[1], part_index: 1 }] }],
      [
        'una parte corta antes de la última',
        { ...result, parts: [parts[0], { ...parts[0], part_index: 1 }, parts[1]] },
      ],
      ['trade_count distinto de las posiciones', metrics({ trade_count: 3 })],
      ['causas que no suman', metrics({ trades_by_close_cause: [{ cause: 'expiry', count: 1 }] })],
      [
        'causas fuera de orden',
        metrics({
          trades_by_close_cause: [
            { cause: 'stop_loss', count: 1 },
            { cause: 'expiry', count: 1 },
          ],
        }),
      ],
      ['neto que no suma', metrics({ net_result_cents: 451, net_result_percent: '0.451000' })],
      ['porcentaje distinto', metrics({ net_result_percent: '0.450001' })],
      ['ganancias sin cifras', metrics({ wins: { ...result.metrics?.wins, mean_cents: null } })],
      ['pérdidas positivas', metrics({ losses: { ...result.metrics?.losses, largest_cents: 1 } })],
      ['acierto sin operaciones', metrics({ hit_rate_percent: null })],
      ['frecuencia sin días', metrics({ trades_per_day: null })],
      ['exposición de más del 100 %', metrics({ exposure_percent: '100.000001' })],
      ['estimadas de más', metrics({ estimated_positions: 3 })],
      [
        'caída sin máximo',
        metrics({
          max_drawdown: {
            percent: '0.500000',
            peak_utc: null,
            trough_utc: null,
            recovery_ms: null,
          },
        }),
      ],
      [
        'sin caída con máximo',
        metrics({ max_drawdown: { ...result.metrics?.max_drawdown, percent: '0.000000' } }),
      ],
      [
        'supuestos repetidos',
        { ...result, assumptions: [result.assumptions?.[0], result.assumptions?.[0]] },
      ],
    ];
    for (const [label, value] of cases) {
      expectRuntimeOnly('result', value, label);
    }
    expectValid(
      'result',
      {
        ...result,
        parts: [fullPart, { ...parts[0], part_index: 1 }, parts[1]],
        metrics: result.metrics,
      },
      'una parte llena antes de la última',
    );
    expectValid('result', metrics({ exposure_percent: '100.000000' }), 'exposición del 100 %');
  });
});

describe('DataViewEvent 1.0.0 (ADR-0024 §2)', () => {
  it('acepta un tick y un cambio de salud', () => {
    expectValid('view', fixtures.view.tick, 'tick');
    expectValid('view', fixtures.view.health, 'salud');
    const plain = withoutSince(fixtures.view.tick);
    expectValid('view', { ...plain, quality_flags: [] }, 'sin marcas');
    expectValid('view', { ...fixtures.view.tick, unrecorded_since_utc: null }, 'primero del log');
  });

  it('rechaza una marca que deja un tick sin usar', () => {
    for (const flag of [
      'out_of_order',
      'duplicate_exact',
      'source_time_conflict',
      'event_gap_unresolved',
    ]) {
      expectStructural('view', { ...fixtures.view.tick, quality_flags: [flag] }, flag);
    }
    expectStructural('view', { ...fixtures.view.tick, kind: 'candle' }, 'clase');
  });

  it('rechaza en runtime las reglas entre campos', () => {
    const plain = withoutSince(fixtures.view.tick);
    const health = fixtures.view.health;
    const cases: [string, unknown][] = [
      [
        'marcas sin orden',
        { ...fixtures.view.tick, quality_flags: ['delivery_delayed', 'after_unrecorded'] },
      ],
      ['after_unrecorded sin hora', plain],
      ['hora sin after_unrecorded', { ...fixtures.view.tick, quality_flags: ['delivery_delayed'] }],
      [
        'hora no anterior',
        { ...fixtures.view.tick, unrecorded_since_utc: fixtures.view.tick['event_time_utc'] },
      ],
      [
        'tipos que no son los de las condiciones',
        edit(health, (copy) => {
          at(copy, 'report')['open_condition_types'] = ['event_gap_unresolved'];
        }),
      ],
      [
        'clave de otro tipo',
        edit(health, (copy) => {
          at(copy, 'open_conditions', 0)['condition_type'] = 'event_gap_unresolved';
          at(copy, 'report')['open_condition_types'] = ['event_gap_unresolved'];
        }),
      ],
      ['símbolos sin orden', { ...health, pending_continuity_symbols: ['R_100', 'R_100'] }],
      [
        'informe healthy con una condición',
        edit(health, (copy) => {
          Object.assign(at(copy, 'report'), {
            service_health: 'healthy',
            connection_state: 'connected',
          });
        }),
      ],
    ];
    for (const [label, value] of cases) {
      expectRuntimeOnly('view', value, label);
    }
  });
});
