/**
 * La salud de los datos en la web servida por la API (`F2-UI-001`; concepto de interfaz §10): la forma
 * de la respuesta de `GET /api/v1/datos/salud`, la causa que se lee de cada `HealthReport`, también en
 * `recovering` con `open_condition_types` vacío (pendiente 2 de F1.2), la frescura, el refresco y la
 * marca de datos ficticios por sección. La lectura de la causa se contrasta con la derivación real del
 * dominio (`deriveLiveHealthReport`), no con informes escritos a mano.
 */
import {
  dataHealthSchema,
  type ConditionType,
  type DataHealth,
  type HealthReport,
  type ServiceHealth,
} from '@buoh/contracts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { api, ApiCallError } from '../src/components/auth/api';
import { showsFictitiousDataInApi } from '../src/navigation';
import { readDataHealth } from '../src/components/salud/respuesta';
import {
  ageText,
  healthView,
  QUEUE_LIMITS,
  STALE_AFTER_MS,
  type DataHealthState,
} from '../src/components/salud/salud';
import {
  createDataHealthStore,
  REFRESH_MS,
  type DataHealthStoreDeps,
} from '../src/components/salud/store';

const OBSERVED = '2026-11-04T21:26:06.925Z';
const OBSERVED_MS = Date.parse(OBSERVED);
const RAW = {
  observation_id: '01937e3a-5b6c-7d8e-9f01-23456789abcd',
  received_at_utc: '2026-11-04T21:26:05.000Z',
};

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    schema_version: '1.0.0',
    source: 'deriv_options',
    execution_mode: 'disabled',
    service_health: 'healthy',
    connection_state: 'connected',
    backlog_count: 0,
    backlog_bytes: 0,
    last_observation_id: RAW.observation_id,
    last_received_at_utc: RAW.received_at_utc,
    last_event_time_utc: '2026-11-04T21:26:04.000Z',
    last_published_dataset_id: null,
    open_condition_types: [],
    ...overrides,
  };
}

function completed(
  value: HealthReport,
  alerts: { event: string; reason: string | null }[] = [],
): DataHealth {
  return {
    log: 2,
    observation: { status: 'completed', observed_at_utc: OBSERVED, report: value, alerts },
  };
}

function ready(health: DataHealth, checkedAtMs = OBSERVED_MS + 60_000): DataHealthState {
  return { kind: 'ready', health, receivedAtMs: checkedAtMs, checkedAtMs, refreshFailure: null };
}

const titlesOf = (state: DataHealthState) => healthView(state).causes.map((cause) => cause.title);

describe('readDataHealth: la forma de la respuesta', () => {
  const valid: Record<string, DataHealth> = {
    'sin log activo': { log: null, observation: null },
    'un log sin observaciones': { log: 3, observation: null },
    'una observación sana': completed(report()),
    'recuperando sin condiciones': completed(report({ service_health: 'recovering' })),
    'en pausa con su alerta': completed(
      report({
        service_health: 'paused',
        connection_state: 'disconnected',
        last_observation_id: null,
        last_received_at_utc: null,
        last_event_time_utc: null,
      }),
      [{ event: 'data_health_storage_unavailable', reason: 'ECONNREFUSED' }],
    ),
    'con condiciones y un dataset': completed(
      report({
        service_health: 'recovering',
        open_condition_types: ['connection_lost', 'event_gap_unresolved'],
        last_published_dataset_id: `sha256:${'a'.repeat(64)}`,
      }),
    ),
    'una observación fallida con código': {
      log: 2,
      observation: {
        status: 'failed',
        observed_at_utc: OBSERVED,
        reason: 'health_command_failed',
        code: 'ConfigError',
      },
    },
    'una observación fallida sin código': {
      log: 2,
      observation: {
        status: 'failed',
        observed_at_utc: OBSERVED,
        reason: 'child_timeout',
        code: null,
      },
    },
  };

  it.each(Object.entries(valid))('acepta lo que acepta el contrato: %s', (_, sample) => {
    expect(dataHealthSchema.safeParse(sample).success).toBe(true);
    expect(readDataHealth(structuredClone(sample))).toEqual(sample);
  });

  const healthy = completed(report());
  const withReport = (overrides: Record<string, unknown>) => ({
    ...healthy,
    observation: { ...healthy.observation, report: { ...report(), ...overrides } },
  });
  const invalid: Record<string, unknown> = {
    null: null,
    'una lista': [],
    'un objeto vacío': {},
    'un log 0': { log: 0, observation: null },
    'un log que no es entero': { log: 1.5, observation: null },
    'una observación sin log': { log: null, observation: healthy.observation },
    'otro estado de la observación': {
      log: 2,
      observation: { status: 'running', observed_at_utc: OBSERVED },
    },
    'una hora que no es UTC con milisegundos': {
      ...healthy,
      observation: { ...healthy.observation, observed_at_utc: '2026-11-04 21:26' },
    },
    'una salud fuera del contrato': withReport({ service_health: 'ok' }),
    'una conexión fuera del contrato': withReport({ connection_state: 'online' }),
    'un modo distinto de disabled': withReport({ execution_mode: 'shadow' }),
    'una condición fuera del contrato': withReport({ open_condition_types: ['delivery_delayed'] }),
    'una cola negativa': withReport({ backlog_count: -1 }),
    'una fuente vacía': withReport({ source: '' }),
    'alertas que no son una lista': {
      ...healthy,
      observation: { ...healthy.observation, alerts: {} },
    },
    'una alerta con un mensaje en lugar de un código': {
      ...healthy,
      observation: { ...healthy.observation, alerts: [{ event: 'falló la red', reason: null }] },
    },
    'un motivo de fallo con espacios': {
      log: 2,
      observation: { status: 'failed', observed_at_utc: OBSERVED, reason: 'no va', code: null },
    },
  };

  it.each(Object.entries(invalid))('rechaza lo que el contrato rechaza: %s', (_, sample) => {
    expect(dataHealthSchema.safeParse(sample).success).toBe(false);
    expect(readDataHealth(sample)).toBeNull();
  });
});

describe('la causa de la salud (concepto de interfaz §10)', () => {
  it('en recovering, conectada y sin condiciones, la causa es la continuidad pendiente (pendiente 2 de F1.2)', () => {
    const view = healthView(ready(completed(report({ service_health: 'recovering' }))));
    expect(view.badge).toEqual({ kind: 'state', health: 'recovering' });
    expect(view.causes.map((cause) => cause.title)).toEqual(['Continuidad pendiente']);
    expect(view.causes[0]?.detail).toContain('historia de Deriv');
  });

  it('en recovering sin conexión, la causa es la reconexión, con el estado de la conexión', () => {
    const view = healthView(
      ready(completed(report({ service_health: 'recovering', connection_state: 'connecting' }))),
    );
    expect(view.causes.map((cause) => cause.title)).toEqual(['Reconectando']);
    expect(view.causes[0]?.detail).toContain('conectando');
  });

  it('con connection_lost abierta, la causa es la conexión perdida, sin sumar la reconexión', () => {
    expect(
      titlesOf(
        ready(
          completed(
            report({
              service_health: 'recovering',
              connection_state: 'disconnected',
              open_condition_types: ['connection_lost'],
            }),
          ),
        ),
      ),
    ).toEqual(['Conexión perdida']);
  });

  it('en recovering con un hueco antiguo, nombra el hueco y la continuidad pendiente', () => {
    expect(
      titlesOf(
        ready(
          completed(
            report({
              service_health: 'recovering',
              open_condition_types: ['event_gap_unresolved'],
            }),
          ),
        ),
      ),
    ).toEqual(['Hueco sin resolver', 'Continuidad pendiente']);
  });

  it('degraded: el hueco sin resolver', () => {
    expect(
      titlesOf(
        ready(
          completed(
            report({ service_health: 'degraded', open_condition_types: ['event_gap_unresolved'] }),
          ),
        ),
      ),
    ).toEqual(['Hueco sin resolver']);
  });

  it('paused con la cola sobre su límite: la cola, con sus cifras', () => {
    const view = healthView(
      ready(
        completed(report({ service_health: 'paused', backlog_count: 1001, backlog_bytes: 512 })),
      ),
    );
    expect(view.causes.map((cause) => cause.title)).toEqual(['Cola sobre su límite']);
    expect(view.causes[0]?.detail).toContain('1001 eventos');
  });

  it('paused sin condición, alerta ni cola llena: la entrada detenida', () => {
    expect(
      titlesOf(
        ready(completed(report({ service_health: 'paused', connection_state: 'disconnected' }))),
      ),
    ).toEqual(['Entrada detenida']);
  });

  it('paused porque los almacenes no responden: la alerta de data:health, con su motivo', () => {
    const view = healthView(
      ready(
        completed(
          report({
            service_health: 'paused',
            connection_state: 'disconnected',
            last_observation_id: null,
            last_received_at_utc: null,
            last_event_time_utc: null,
          }),
          [{ event: 'data_health_storage_unavailable', reason: 'ECONNREFUSED' }],
        ),
      ),
    );
    expect(view.causes.map((cause) => cause.title)).toEqual(['Almacenes sin respuesta']);
    expect(view.causes[0]?.detail).toContain('ECONNREFUSED');
  });

  it('failed: lo incompatible que encontró data:health, en palabras', () => {
    const view = healthView(
      ready(
        completed(report({ service_health: 'failed', connection_state: 'disconnected' }), [
          { event: 'data_health_failed', reason: 'symbol_mismatch' },
        ]),
      ),
    );
    expect(view.causes.map((cause) => cause.title)).toEqual(['Log incompatible']);
    expect(view.causes[0]?.detail).toContain('otro símbolo');
  });

  it('una alerta o un motivo desconocidos se muestran con su código, nunca se ocultan', () => {
    const view = healthView(
      ready(
        completed(report({ service_health: 'failed', connection_state: 'disconnected' }), [
          { event: 'data_health_failed', reason: 'motivo_nuevo' },
          { event: 'alerta_nueva', reason: null },
        ]),
      ),
    );
    expect(view.causes.map((cause) => cause.detail).join(' ')).toContain('motivo_nuevo');
    expect(view.causes.map((cause) => cause.title)).toContain('Alerta alerta_nueva');
  });

  it('healthy no tiene causas, y starting dice que todavía no hay datos', () => {
    expect(titlesOf(ready(completed(report())))).toEqual([]);
    expect(
      titlesOf(
        ready(
          completed(
            report({
              service_health: 'starting',
              connection_state: 'connecting',
              last_observation_id: null,
              last_received_at_utc: null,
              last_event_time_utc: null,
            }),
          ),
        ),
      ),
    ).toEqual(['Sin datos todavía']);
  });
});

describe('la vista sin un informe', () => {
  it('mientras lee, la insignia dice que está leyendo', () => {
    const view = healthView({ kind: 'loading' });
    expect(view.loading).toBe(true);
    expect(view.badge).toMatchObject({ kind: 'unknown', label: 'Leyendo…' });
  });

  it('sin sesión, la insignia lo dice y la vista invita a iniciarla', () => {
    const view = healthView({ kind: 'failed', failure: { code: 'unauthenticated' } });
    expect(view.badge).toMatchObject({ kind: 'unknown', label: 'Sin sesión' });
    expect(view.unauthenticated).toBe(true);
    expect(view.report).toBeNull();
  });

  it('con un fallo de la API, la insignia dice que no está disponible, con el mensaje del fallo', () => {
    const view = healthView({ kind: 'failed', failure: { code: 'postgres_unavailable' } });
    expect(view.badge).toMatchObject({ kind: 'unknown', label: 'No disponible' });
    expect(view.error).toContain('no está disponible');
  });

  it('sin log activo, o con un log sin observaciones, la salud está sin observar y dice por qué', () => {
    const none = healthView(ready({ log: null, observation: null }));
    expect(none.badge).toMatchObject({ kind: 'unknown', label: 'Sin observar' });
    expect(none.causes.map((cause) => cause.title)).toEqual(['Sin log activo']);
    const empty = healthView(ready({ log: 3, observation: null }));
    expect(empty.badge).toMatchObject({ kind: 'unknown', label: 'Sin observar' });
    expect(empty.causes[0]?.detail).toContain('log 3');
  });

  it.each([
    ['child_timeout', null, 'plazo'],
    ['health_command_failed', 'ConfigError', 'ConfigError'],
    ['log_not_prepared', null, 'preparado'],
    ['57P01', null, 'PostgreSQL respondió con el código 57P01'],
    ['ENOTFOUND', null, 'ENOTFOUND'],
  ] as const)('una observación fallida (%s) dice su motivo', (reason, code, expected) => {
    const view = healthView(
      ready({ log: 2, observation: { status: 'failed', observed_at_utc: OBSERVED, reason, code } }),
    );
    expect(view.badge).toMatchObject({ kind: 'unknown', label: 'Sin observar' });
    expect(view.causes[0]?.title).toBe('Observación fallida');
    expect(view.causes[0]?.detail).toContain(expected);
    expect(view.observation).toMatchObject({ log: 2, observedAtUtc: OBSERVED });
  });
});

describe('la frescura', () => {
  it('una observación de hace 15 minutos todavía vale; con 1 ms más es antigua, y lo dice', () => {
    const fresh = healthView(ready(completed(report()), OBSERVED_MS + STALE_AFTER_MS));
    expect(STALE_AFTER_MS).toBe(15 * 60_000);
    expect(fresh.observation?.stale).toBe(false);
    expect(fresh.causes).toEqual([]);
    const stale = healthView(ready(completed(report()), OBSERVED_MS + STALE_AFTER_MS + 1));
    expect(stale.observation?.stale).toBe(true);
    expect(stale.causes.map((cause) => cause.title)).toEqual(['Observación antigua']);
    expect(stale.badge).toEqual({ kind: 'state', health: 'healthy' });
  });

  it('una observación fallida también envejece', () => {
    const view = healthView(
      ready(
        {
          log: 2,
          observation: {
            status: 'failed',
            observed_at_utc: OBSERVED,
            reason: 'child_timeout',
            code: null,
          },
        },
        OBSERVED_MS + STALE_AFTER_MS + 1,
      ),
    );
    expect(view.causes.map((cause) => cause.title)).toEqual([
      'Observación fallida',
      'Observación antigua',
    ]);
  });

  it('la edad se escribe en minutos y horas, y una hora del futuro cuenta como ahora', () => {
    expect(ageText(-5_000)).toBe('menos de 1 min');
    expect(ageText(59_999)).toBe('menos de 1 min');
    expect(ageText(2 * 60_000 + 59_000)).toBe('2 min');
    expect(ageText(60 * 60_000)).toBe('1 h');
    expect(ageText(65 * 60_000)).toBe('1 h 5 min');
  });

  it('una lectura que falla después de una buena conserva los datos, lo dice y la edad sigue contando', () => {
    const view = healthView({
      kind: 'ready',
      health: completed(report()),
      receivedAtMs: OBSERVED_MS + 60_000,
      checkedAtMs: OBSERVED_MS + STALE_AFTER_MS + 60_000,
      refreshFailure: { code: 'network' },
    });
    expect(view.badge).toEqual({ kind: 'state', health: 'healthy' });
    expect(view.refreshError).toContain('No se pudo conectar');
    expect(view.observation?.stale).toBe(true);
  });
});

/** Lo que la prueba usa del dominio compilado, con sus nombres y la forma de sus entradas. */
interface DomainHealth {
  readonly deriveLiveHealthReport: (input: {
    readonly backlog_bytes: number;
    readonly backlog_count: number;
    readonly connection_state?: HealthReport['connection_state'];
    readonly last_published_dataset_id: string | null;
    readonly minimum_health?: ServiceHealth;
    readonly operational_condition_types?: readonly ConditionType[];
    readonly source: string;
    readonly view: {
      readonly connectedInLog: boolean;
      readonly lastEventTimeUtc: string | null;
      readonly lastRaw: {
        readonly observation_id: string;
        readonly received_at_utc: string;
      } | null;
      readonly openConditionTypes: readonly string[];
      readonly pendingContinuitySymbols: readonly string[];
    };
  }) => HealthReport;
  readonly evaluateSourceLimit: (
    resource: 'in_memory_queue_bytes' | 'in_memory_queue_events',
    observedValue: number,
  ) => unknown;
  readonly SOURCE_LIMITS: {
    readonly in_memory_queue_bytes: { readonly maximum: number };
    readonly in_memory_queue_events: { readonly maximum: number };
  };
}

// La derivación real de la salud, del dominio compilado, por ruta relativa, como los scripts de
// evidencia. `@buoh/domain` no es una dependencia de la web: añadirla cambiaría `pnpm-lock.yaml`, que
// vuelve a desplegar la captura en Render (`buildFilter`), y su código no compila con la resolución
// de módulos de Next. `pnpm run verify` lo compila antes de probar.
const DOMAIN_DIST = fileURLToPath(
  new URL('../../../packages/domain/dist/index.js', import.meta.url),
);

// Todas las combinaciones de lo que el dominio usa para decidir la salud (`healthReportOf`), con la
// función real: así, si la derivación cambia una causa, esta lectura deja de cuadrar y la prueba falla.
describe('la lectura de la causa cuadra con la derivación del dominio (pendiente 2 de F1.2)', () => {
  let domain: DomainHealth;

  beforeAll(async () => {
    if (!existsSync(DOMAIN_DIST)) {
      throw new Error(`Falta ${DOMAIN_DIST}: compila antes el dominio, con pnpm run build.`);
    }
    domain = (await import(DOMAIN_DIST)) as DomainHealth;
  });

  function subsets<T>(items: readonly T[]): T[][] {
    return items.reduce<T[][]>((all, item) => [...all, ...all.map((set) => [...set, item])], [[]]);
  }

  const CONDITION_TITLES: Record<ConditionType, string> = {
    connection_lost: 'Conexión perdida',
    event_gap_unresolved: 'Hueco sin resolver',
    persistence_unavailable: 'Persistencia no disponible',
    source_limit_exceeded: 'Límite de fuente superado',
  };
  const RECOVERING_TITLES = ['Conexión perdida', 'Reconectando', 'Continuidad pendiente'];

  it('la web usa los límites de la cola del dominio', () => {
    expect(QUEUE_LIMITS).toEqual({
      events: domain.SOURCE_LIMITS.in_memory_queue_events.maximum,
      bytes: domain.SOURCE_LIMITS.in_memory_queue_bytes.maximum,
    });
  });

  it('en cada combinación, la causa que lee la web es la que decidió el dominio', () => {
    const mismatches: string[] = [];
    let pendingCases = 0;
    let checked = 0;
    for (const connectedInLog of [true, false]) {
      for (const lastRaw of [null, RAW]) {
        for (const openConditionTypes of subsets<ConditionType>([
          'connection_lost',
          'event_gap_unresolved',
        ])) {
          for (const operational of subsets<ConditionType>([
            'persistence_unavailable',
            'source_limit_exceeded',
          ])) {
            for (const pending of [[], ['R_100']]) {
              for (const connection of [
                undefined,
                'connected',
                'connecting',
                'disconnected',
              ] as const) {
                for (const minimum of [undefined, 'paused'] as const) {
                  for (const [count, bytes] of [
                    [0, 0],
                    [1001, 10],
                    [1, 33_554_433],
                  ] as const) {
                    const derived = domain.deriveLiveHealthReport({
                      backlog_bytes: bytes,
                      backlog_count: count,
                      ...(connection === undefined ? {} : { connection_state: connection }),
                      last_published_dataset_id: null,
                      ...(minimum === undefined ? {} : { minimum_health: minimum }),
                      operational_condition_types: operational,
                      source: 'deriv_options',
                      view: {
                        connectedInLog,
                        lastEventTimeUtc: lastRaw === null ? null : '2026-11-04T21:26:04.000Z',
                        lastRaw,
                        openConditionTypes,
                        pendingContinuitySymbols: pending,
                      },
                    });
                    checked += 1;
                    const titles = titlesOf(ready(completed(derived)));
                    const label = JSON.stringify({
                      connectedInLog,
                      raw: lastRaw !== null,
                      openConditionTypes,
                      operational,
                      pending,
                      connection,
                      minimum,
                      count,
                      bytes,
                      health: derived.service_health,
                      titles,
                    });
                    const health: ServiceHealth = derived.service_health;
                    const lost = derived.open_condition_types.includes('connection_lost');
                    const overLimit =
                      domain.evaluateSourceLimit('in_memory_queue_events', count) !== null ||
                      domain.evaluateSourceLimit('in_memory_queue_bytes', bytes) !== null;
                    if (health !== 'healthy' && titles.length === 0) {
                      mismatches.push(`sin causa: ${label}`);
                    }
                    if (titles.includes('Continuidad pendiente') && pending.length === 0) {
                      mismatches.push(`continuidad pendiente sin hueco pendiente: ${label}`);
                    }
                    if (
                      health === 'recovering' &&
                      pending.length > 0 &&
                      derived.connection_state === 'connected' &&
                      !lost
                    ) {
                      pendingCases += 1;
                      if (!titles.includes('Continuidad pendiente')) {
                        mismatches.push(`falta la continuidad pendiente: ${label}`);
                      }
                    }
                    if (
                      health === 'recovering' &&
                      !titles.some((title) => RECOVERING_TITLES.includes(title))
                    ) {
                      mismatches.push(`recovering sin su causa: ${label}`);
                    }
                    if (
                      titles.includes('Reconectando') &&
                      derived.connection_state === 'connected'
                    ) {
                      mismatches.push(`reconectando con la conexión activa: ${label}`);
                    }
                    if (titles.includes('Cola sobre su límite') !== overLimit) {
                      mismatches.push(`cola: ${label}`);
                    }
                    for (const type of derived.open_condition_types) {
                      if (!titles.includes(CONDITION_TITLES[type])) {
                        mismatches.push(`falta ${type}: ${label}`);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(3072);
    // El caso del pendiente 2 existe en la derivación: si no, la prueba no probaría nada.
    expect(pendingCases).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});

/** Dependencias falsas del almacén: lecturas en cola, temporizadores a mano y una pestaña visible. */
function fakeStore(responses: (() => Promise<DataHealth>)[]) {
  let nowMs = OBSERVED_MS;
  let handle = 0;
  let visible = true;
  let onVisible: (() => void) | null = null;
  let calls = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly ms: number }>();
  const deps: DataHealthStoreDeps = {
    fetchHealth: () => {
      const respond = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (respond === undefined) throw new Error('sin respuesta');
      return respond();
    },
    now: () => nowMs,
    setTimer: (callback, ms) => {
      handle += 1;
      timers.set(handle, { callback, ms });
      return handle;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    visible: () => visible,
    watchVisibility: (listener) => {
      onVisible = listener;
      return () => {
        onVisible = null;
      };
    },
  };
  return {
    store: createDataHealthStore(deps),
    timers,
    calls: () => calls,
    /** Dispara los temporizadores pendientes, como si pasara su plazo. */
    elapse: (ms: number) => {
      nowMs += ms;
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.callback();
    },
    setVisible: (value: boolean) => {
      visible = value;
      if (value) onVisible?.();
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('el almacén de la salud: una lectura al abrir y otra cada minuto', () => {
  const answer = (health: DataHealth) => () => Promise.resolve(health);
  const fail = (code: 'network' | 'unauthenticated') => () =>
    Promise.reject(new ApiCallError({ code }));

  it('la primera suscripción lee en el acto, y después cada minuto', async () => {
    const fake = fakeStore([answer(completed(report()))]);
    fake.store.subscribe(() => undefined);
    expect(fake.calls()).toBe(1);
    expect(fake.store.snapshot()).toEqual({ kind: 'loading' });
    await flush();
    expect(fake.store.snapshot()).toMatchObject({ kind: 'ready', refreshFailure: null });
    expect([...fake.timers.values()].map((timer) => timer.ms)).toEqual([REFRESH_MS]);
    expect(REFRESH_MS).toBe(60_000);
    fake.elapse(REFRESH_MS);
    expect(fake.calls()).toBe(2);
  });

  it('dos suscriptores, la barra y el Observatorio, comparten la misma lectura', async () => {
    const fake = fakeStore([answer(completed(report()))]);
    fake.store.subscribe(() => undefined);
    fake.store.subscribe(() => undefined);
    await flush();
    expect(fake.calls()).toBe(1);
  });

  it('con la pestaña oculta no lee; al volver a ella lee en el acto', async () => {
    const fake = fakeStore([answer(completed(report()))]);
    fake.store.subscribe(() => undefined);
    await flush();
    fake.setVisible(false);
    fake.elapse(REFRESH_MS);
    await flush();
    expect(fake.calls()).toBe(1);
    expect(fake.timers.size).toBe(0);
    fake.setVisible(true);
    expect(fake.calls()).toBe(2);
  });

  it('un fallo después de una lectura buena conserva los datos; sin sesión, los quita', async () => {
    const fake = fakeStore([answer(completed(report())), fail('network'), fail('unauthenticated')]);
    fake.store.subscribe(() => undefined);
    await flush();
    fake.elapse(REFRESH_MS);
    await flush();
    expect(fake.store.snapshot()).toMatchObject({
      kind: 'ready',
      receivedAtMs: OBSERVED_MS,
      checkedAtMs: OBSERVED_MS + REFRESH_MS,
      refreshFailure: { code: 'network' },
    });
    fake.elapse(REFRESH_MS);
    await flush();
    expect(fake.store.snapshot()).toEqual({
      kind: 'failed',
      failure: { code: 'unauthenticated' },
    });
  });

  it('un error que no es de la API cuenta como respuesta inesperada', async () => {
    const fake = fakeStore([() => Promise.reject(new SyntaxError('no es JSON'))]);
    fake.store.subscribe(() => undefined);
    await flush();
    expect(fake.store.snapshot()).toEqual({ kind: 'failed', failure: { code: 'unexpected' } });
  });

  it('sin suscriptores para: no deja temporizadores ni vuelve a leer', async () => {
    const fake = fakeStore([answer(completed(report()))]);
    const unsubscribe = fake.store.subscribe(() => undefined);
    await flush();
    unsubscribe();
    expect(fake.timers.size).toBe(0);
    fake.setVisible(true);
    expect(fake.calls()).toBe(1);
  });

  it('avisa a cada suscriptor cuando cambia la salud', async () => {
    const fake = fakeStore([answer(completed(report()))]);
    const listener = vi.fn();
    fake.store.subscribe(listener);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('api.dataHealth: GET /api/v1/datos/salud', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown) {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return requests;
  }

  it('pide la salud sin el token CSRF: la actualización automática no renueva la sesión (ADR-0019 §2)', async () => {
    const body = completed(report({ service_health: 'recovering' }));
    const requests = stubFetch(200, body);
    await expect(api.dataHealth()).resolves.toEqual(body);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/v1/datos/salud');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/i);
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  it('una respuesta sin la forma de DataHealth es «unexpected»', async () => {
    stubFetch(200, { log: 'dos', observation: null });
    await expect(api.dataHealth()).rejects.toMatchObject({
      name: 'ApiCallError',
      failure: { code: 'unexpected' },
    });
  });

  it('sin sesión es «unauthenticated»', async () => {
    stubFetch(401, {
      error: { code: 'unauthenticated', request_id: '7c2a4f9e-1f5b-4c3d-9a8e-2b6d0f1e3a5c' },
    });
    await expect(api.dataHealth()).rejects.toMatchObject({ failure: { code: 'unauthenticated' } });
  });
});

describe('la marca «Datos ficticios» en la web servida por la API (concepto de interfaz §2)', () => {
  it.each([
    ['/', false],
    ['/auditoria', false],
    ['/auditoria/', false],
    ['/acceso/', false],
    ['/enlace', false],
    ['/mercados/', true],
    ['/datos', true],
    ['/laboratorio/', true],
    ['/senales/', true],
    ['/guia/', true],
    ['/_not-found', true],
    ['/auditoria/otra/', true],
  ] as const)('%s: %s', (pathname, fictitious) => {
    expect(showsFictitiousDataInApi(pathname)).toBe(fictitious);
  });
});
