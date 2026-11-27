/**
 * La sección Datos de la web servida por la API (`F2-UI-001`; ADR-0020 §10; concepto de interfaz
 * §14): la forma de la respuesta, contrastada con el esquema de `@buoh/contracts`; sus textos; la
 * vista en cada estado, sin controles para cambiar nada; y la lectura de la API, sin el token CSRF.
 * Los datasets son sintéticos, con la forma de los que publicó producción.
 */
import {
  dataDatasetsSchema,
  type DataDataset,
  type DataDatasets,
  type DataDatasetsSequence,
} from '@buoh/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/components/auth/api';
import { DatosReal } from '../src/components/DatosReal';
import {
  DatasetsPublicadosView,
  type DatasetsState,
} from '../src/components/datos/DatasetsPublicados';
import {
  datasetEnd,
  datasetIncidents,
  datasetPeriod,
  datasetRecords,
  sequenceInterval,
  sequenceTitle,
  verificationText,
} from '../src/components/datos/datasets';
import { DATA_DATASETS_LIMIT, readDataDatasets } from '../src/components/datos/respuesta';

const hex = (digit: string) => digit.repeat(64);

const CLEAN = {
  dataset_id: `sha256:${hex('1')}`,
  publication_id: '019b76da-a800-7000-8000-000000000042',
  published_at_utc: '2026-11-14T12:21:23.290Z',
  source: 'deriv_options',
  symbols: ['R_100'],
  log: 1,
  first_segment: 0,
  last_segment: 71,
  event_time_from_utc: '2026-11-01T00:06:06.000Z',
  event_time_to_utc: '2026-11-01T05:59:58.000Z',
  source_event_count: 11_226,
  raw_frame_count: 11_200,
  normalized_tick_count: 11_190,
  incident_count: 3,
  condition_event_count: 2,
  quality_rule_version: '3.0.0',
  quality_profile_id: 'deriv_options-publication-v1-R_100',
  clean: true,
  pending_continuity_symbols: [],
  open_condition_types: [],
  incidents: [
    { incident_type: 'connection_lost', severity: 'warning', count: 1 },
    { incident_type: 'duplicate_exact', severity: 'info', count: 2 },
  ],
  verifications: {
    verify_only: {
      status: 'passed',
      verified_at_utc: '2026-11-14T12:21:33.759Z',
      error_code: null,
    },
    recompute: { status: 'passed', verified_at_utc: '2026-11-14T12:21:46.868Z', error_code: null },
  },
  batch: null,
} satisfies DataDataset;

const OPEN = {
  ...CLEAN,
  dataset_id: `sha256:${hex('2')}`,
  publication_id: '019b76da-a800-7000-8000-000000000041',
  published_at_utc: '2026-11-14T12:16:00.000Z',
  first_segment: 72,
  last_segment: 142,
  event_time_from_utc: null,
  event_time_to_utc: null,
  normalized_tick_count: 0,
  incident_count: 0,
  clean: false,
  pending_continuity_symbols: ['R_100'],
  open_condition_types: ['connection_lost'],
  incidents: [],
  verifications: {
    verify_only: {
      status: 'failed',
      verified_at_utc: '2026-11-14T12:16:10.000Z',
      error_code: 'STORAGE_OBJECT_MISMATCH',
    },
    recompute: null,
  },
} satisfies DataDataset;

/** Un día de velas de los lotes (core 1.1.0), con su horario y las incidencias de los lotes. */
const CANDLES = {
  ...CLEAN,
  dataset_id: `sha256:${hex('3')}`,
  publication_id: '019b76da-a800-7000-8000-000000000043',
  published_at_utc: '2026-11-27T00:05:00.000Z',
  symbols: ['frxEURUSD', 'frxXAUUSD'],
  first_segment: 0,
  last_segment: 4,
  event_time_from_utc: null,
  event_time_to_utc: null,
  source_event_count: 19,
  raw_frame_count: 15,
  normalized_tick_count: 0,
  incident_count: 4,
  condition_event_count: 0,
  quality_rule_version: '4.0.0',
  quality_profile_id: 'deriv_options-lotes-v1-velas',
  incidents: [
    { incident_type: 'candle_missing', severity: 'error', count: 2 },
    { incident_type: 'candle_repeated', severity: 'warning', count: 1 },
    { incident_type: 'contract_rejected', severity: 'warning', count: 1 },
  ],
  batch: {
    candle_time_from_utc: '2026-11-26T00:00:00.000Z',
    candle_time_to_utc: '2026-11-26T23:59:00.000Z',
    market_candle_count: 2879,
    trading_session_count: 1,
    contract_offer_count: 0,
    contract_quote_count: 0,
  },
} satisfies DataDataset;

/** Una secuencia con esos datasets y sin cortar. */
const group = (sequence: string, datasets: DataDataset[]): DataDatasetsSequence => ({
  sequence,
  datasets,
  truncated: false,
});
/** Solo R_100, con esos datasets. */
const inR100 = (...datasets: Record<string, unknown>[]) => ({
  sequences: [{ sequence: 'R_100', datasets, truncated: false }],
});

const LIVE = group('R_100', [CLEAN, OPEN]);
const DATASETS: DataDatasets = { sequences: [LIVE, group('lotes_velas', [CANDLES])] };
const FULL = {
  sequence: 'R_100',
  datasets: Array.from({ length: DATA_DATASETS_LIMIT }, (_, index) => ({
    ...CLEAN,
    dataset_id: `sha256:${index.toString(16).padStart(64, '0')}`,
  })),
  truncated: true,
};

describe('la respuesta de los datasets, como el contrato', () => {
  const samples: unknown[] = [
    DATASETS,
    { sequences: [] },
    { sequences: [FULL] },
    {
      sequences: [
        {
          sequence: 'lotes_cotizaciones',
          truncated: false,
          datasets: [
            {
              ...CANDLES,
              incident_count: 0,
              incidents: [],
              batch: {
                ...CANDLES.batch,
                candle_time_from_utc: null,
                candle_time_to_utc: null,
                market_candle_count: 0,
                trading_session_count: 0,
                contract_quote_count: 760,
              },
            },
          ],
        },
      ],
    },
    inR100({
      ...CLEAN,
      verifications: {
        verify_only: {
          status: 'incomplete',
          verified_at_utc: CLEAN.published_at_utc,
          error_code: null,
        },
        recompute: {
          status: 'incomplete',
          verified_at_utc: CLEAN.published_at_utc,
          error_code: 'CHILD_TIMEOUT',
        },
      },
    }),
  ];

  it('acepta lo que acepta el esquema', () => {
    for (const sample of samples) {
      expect(dataDatasetsSchema.safeParse(sample).success).toBe(true);
      expect(readDataDatasets(sample)).toEqual(sample);
    }
  });

  it('rechaza, como el esquema, cada regla entre campos', () => {
    const one = (value: Record<string, unknown>) => inR100(value);
    const invalid: unknown[] = [
      inR100(OPEN, CLEAN),
      { sequences: [{ ...LIVE, truncated: true }] },
      inR100(CLEAN, CLEAN),
      // Las secuencias por su nombre, sin repetir y sin vacías, y cada dataset una vez.
      { sequences: [...DATASETS.sequences].reverse() },
      { sequences: [LIVE, LIVE] },
      { sequences: [group('R_100', [])] },
      { sequences: [LIVE, group('lotes_velas', [{ ...CANDLES, dataset_id: CLEAN.dataset_id }])] },
      { sequences: [{ ...LIVE, sequence: 'lotes velas' }] },
      { sequences: [{ ...LIVE, extra: 1 }] },
      { datasets: [CLEAN], truncated: false },
      // El período de las velas, null exactamente sin velas y en orden.
      one({ ...CANDLES, batch: { ...CANDLES.batch, candle_time_to_utc: null } }),
      one({ ...CANDLES, batch: { ...CANDLES.batch, market_candle_count: 0 } }),
      one({
        ...CANDLES,
        batch: {
          ...CANDLES.batch,
          candle_time_from_utc: CANDLES.batch.candle_time_to_utc,
          candle_time_to_utc: CANDLES.batch.candle_time_from_utc,
        },
      }),
      one({ ...CANDLES, batch: { ...CANDLES.batch, extra: 1 } }),
      one({ ...CLEAN, batch: undefined }),
      one({ ...CLEAN, first_segment: 72 }),
      one({ ...CLEAN, event_time_to_utc: null }),
      one({ ...CLEAN, normalized_tick_count: 0 }),
      one({
        ...CLEAN,
        event_time_from_utc: CLEAN.event_time_to_utc,
        event_time_to_utc: CLEAN.event_time_from_utc,
      }),
      one({ ...CLEAN, raw_frame_count: CLEAN.source_event_count + 1 }),
      one({ ...CLEAN, incident_count: 4 }),
      one({ ...CLEAN, incidents: [...CLEAN.incidents].reverse() }),
      one({ ...CLEAN, incidents: [{ incident_type: 'otra', severity: 'info', count: 3 }] }),
      one({ ...CLEAN, pending_continuity_symbols: ['R_100'] }),
      one({ ...OPEN, clean: true }),
      one({ ...CLEAN, symbols: ['R_50', 'R_100'] }),
      one({ ...CLEAN, symbols: [] }),
      one({
        ...CLEAN,
        verifications: {
          ...CLEAN.verifications,
          verify_only: { ...CLEAN.verifications.verify_only, error_code: 'X' },
        },
      }),
      one({
        ...OPEN,
        verifications: {
          ...OPEN.verifications,
          verify_only: { ...OPEN.verifications.verify_only, error_code: null },
        },
      }),
      one({
        ...OPEN,
        verifications: {
          ...OPEN.verifications,
          verify_only: { ...OPEN.verifications.verify_only, error_code: 'con un mensaje' },
        },
      }),
      one({ ...CLEAN, quality_rule_version: '3' }),
      one({ ...CLEAN, publication_id: '00000000-0000-4000-8000-000000000001' }),
      one({ ...CLEAN, log: 1_000_000 }),
      one({ ...CLEAN, extra: 1 }),
      {
        sequences: [
          {
            ...FULL,
            datasets: Array.from({ length: DATA_DATASETS_LIMIT + 1 }, (_, index) => ({
              ...CLEAN,
              dataset_id: `sha256:${index.toString(16).padStart(64, '0')}`,
            })),
          },
        ],
      },
    ];
    for (const value of invalid) {
      expect(dataDatasetsSchema.safeParse(value).success, JSON.stringify(value).slice(0, 200)).toBe(
        false,
      );
      expect(readDataDatasets(value), JSON.stringify(value).slice(0, 200)).toBeNull();
    }
  });

  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const POOL: unknown[] = [
    null,
    0,
    1,
    3,
    -1,
    1.5,
    '',
    'x',
    'R_100',
    'R_50',
    true,
    false,
    [],
    {},
    '2026-11-01T00:06:06.000Z',
    '2026-11-14T12:21:23.290Z',
    '2026-11-14T12:21:23Z',
    'deriv_options',
    'passed',
    'failed',
    'incomplete',
    'connection_lost',
    'duplicate_exact',
    'event_gap_unresolved',
    'candle_missing',
    'lotes_velas',
    'info',
    'warning',
    'STORAGE_OBJECT_MISMATCH',
    '3.0.0',
    `sha256:${hex('e')}`,
    '01900000-0000-7000-8000-000000000099',
    999_999,
    1_000_000,
  ];

  /** Cambia una cosa al azar: borra, añade o reemplaza un campo, o reordena una lista. */
  function mutate(value: unknown, random: () => number): unknown {
    const copy = structuredClone(value);
    const holders: (Record<string, unknown> | unknown[])[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        holders.push(node);
        node.forEach(walk);
      } else if (typeof node === 'object' && node !== null) {
        holders.push(node as Record<string, unknown>);
        Object.values(node).forEach(walk);
      }
    };
    walk(copy);
    const holder = holders[Math.floor(random() * holders.length)];
    const pick = POOL[Math.floor(random() * POOL.length)];
    if (holder === undefined) {
      return pick;
    }
    if (Array.isArray(holder)) {
      const choice = random();
      if (holder.length > 0 && choice < 0.3) {
        holder.splice(Math.floor(random() * holder.length), 1);
      } else if (holder.length > 0 && choice < 0.6) {
        holder.push(structuredClone(holder[Math.floor(random() * holder.length)]));
      } else if (choice < 0.8) {
        holder.reverse();
      } else {
        holder[Math.floor(random() * Math.max(holder.length, 1))] = pick;
      }
      return copy;
    }
    const keys = Object.keys(holder);
    const choice = random();
    const key = keys[Math.floor(random() * keys.length)];
    if (key !== undefined && choice < 0.2) {
      Reflect.deleteProperty(holder, key);
    } else if (choice < 0.3) {
      holder.extra = pick;
    } else if (key !== undefined) {
      holder[key] = pick;
    }
    return copy;
  }

  it('da lo mismo que el esquema en miles de respuestas cambiadas al azar', () => {
    const small = samples.filter((sample) => sample !== samples[2]);
    const random = seeded(2027);
    let accepted = 0;
    for (let round = 0; round < 4000; round += 1) {
      const base = small[round % small.length];
      const value = mutate(round % 5 === 0 ? mutate(base, random) : base, random);
      const expected = dataDatasetsSchema.safeParse(value).success;
      expect(readDataDatasets(value) !== null, JSON.stringify(value).slice(0, 2000)).toBe(expected);
      accepted += expected ? 1 : 0;
    }
    // Las mutaciones no son todas inválidas: también prueban lo que se acepta.
    expect(accepted).toBeGreaterThan(100);
  }, 30_000);
});

describe('los textos de cada dataset', () => {
  it('el período, cómo terminó, sus incidencias y sus verificaciones', () => {
    expect(datasetPeriod(CLEAN)).toBe('1 nov 2026, 00:06:06 UTC – 1 nov 2026, 05:59:58 UTC');
    expect(datasetPeriod(OPEN)).toBe('Sin ticks');
    expect(datasetEnd(CLEAN)).toBe('Limpio');
    expect(datasetEnd(OPEN)).toBe(
      'Con algo abierto: continuidad pendiente de R_100 y conexión perdida abierta',
    );
    expect(
      datasetEnd({
        ...OPEN,
        pending_continuity_symbols: [],
        open_condition_types: ['connection_lost', 'event_gap_unresolved'],
      }),
    ).toBe('Con algo abierto: conexión perdida y hueco sin resolver abiertos');
    expect(datasetIncidents(CLEAN)).toBe('3: 1 conexión perdida, 2 duplicados exactos');
    expect(datasetIncidents(OPEN)).toBe('Ninguna');
    expect(verificationText(CLEAN.verifications.verify_only)).toBe('Pasó');
    expect(verificationText(OPEN.verifications.verify_only)).toBe('Falló: STORAGE_OBJECT_MISMATCH');
    expect(verificationText(OPEN.verifications.recompute)).toBe('Pendiente');
    expect(
      verificationText({
        status: 'incomplete',
        verified_at_utc: CLEAN.published_at_utc,
        error_code: 'CHILD_TIMEOUT',
      }),
    ).toBe('Sin resultado: CHILD_TIMEOUT');
    expect(
      verificationText({
        status: 'incomplete',
        verified_at_utc: CLEAN.published_at_utc,
        error_code: null,
      }),
    ).toBe('Sin resultado');
  });

  it('en un dataset de los lotes: el período de sus velas, sus registros y las incidencias de los lotes', () => {
    expect(datasetRecords(CLEAN)).toBe('11190 ticks');
    expect(datasetRecords({ ...OPEN, normalized_tick_count: 1 })).toBe('1 tick');
    expect(datasetPeriod(CANDLES)).toBe(
      'Velas de 26 nov 2026, 00:00:00 UTC – 26 nov 2026, 23:59:00 UTC',
    );
    expect(datasetRecords(CANDLES)).toBe('2879 velas y 1 horario');
    expect(datasetIncidents(CANDLES)).toBe(
      '4: 2 tramos sin velas, 1 vela repetida, 1 contrato rechazado',
    );
    // Los tramos sin ticks de la historia (PR 6b de ADR-0021).
    expect(
      datasetIncidents({
        ...CANDLES,
        incident_count: 3,
        incidents: [
          { incident_type: 'tick_gap', severity: 'error', count: 2 },
          { incident_type: 'duplicate_exact', severity: 'warning', count: 1 },
        ],
      }),
    ).toBe('3: 2 tramos sin ticks, 1 duplicado exacto');
    const schedules = {
      ...CANDLES,
      batch: {
        ...CANDLES.batch,
        candle_time_from_utc: null,
        candle_time_to_utc: null,
        market_candle_count: 0,
        trading_session_count: 16,
        contract_offer_count: 8,
      },
    };
    expect(datasetPeriod(schedules)).toBe('Sin ticks ni velas');
    expect(datasetRecords(schedules)).toBe('16 horarios y 8 ofertas de contratos');
    expect(
      datasetRecords({
        ...schedules,
        batch: { ...schedules.batch, trading_session_count: 0, contract_offer_count: 0 },
      }),
    ).toBe('Ninguno');
    expect(
      datasetRecords({
        ...schedules,
        batch: { ...schedules.batch, contract_offer_count: 1, contract_quote_count: 1 },
      }),
    ).toBe('16 horarios, 1 oferta de contratos y 1 cotización');
  });

  it('el nombre y el intervalo de cada secuencia; una que la web no conoce, con su nombre y sin intervalo', () => {
    expect(sequenceTitle('R_100')).toBe('R_100 en vivo');
    expect(sequenceTitle('lotes_velas')).toBe('Lotes: velas de 1 minuto');
    expect(sequenceTitle('lotes_nuevos')).toBe('lotes_nuevos');
    expect(sequenceTitle('toString')).toBe('toString');
    expect(sequenceInterval('lotes_cotizaciones')).toBe(
      'Cada dataset tiene unas 3 horas de cotizaciones, cortadas cada 3 horas desde la medianoche UTC.',
    );
    expect(sequenceTitle('lotes_historia_frxxauusd')).toBe(
      'Historia: oro (frxXAUUSD), un año de ticks',
    );
    expect(sequenceInterval('lotes_historia_r_100')).toBe(
      'Cada dataset tiene un bloque de hasta 6 horas de ticks del año anterior a la captura en vivo, con el horario de su día.',
    );
    expect(sequenceInterval('frxXAUUSD')).toBeNull();
    expect(sequenceInterval('lotes_nuevos')).toBeNull();
  });
});

describe('la vista de los datasets publicados', () => {
  const render = (state: DatasetsState) =>
    renderToStaticMarkup(<DatasetsPublicadosView state={state} />);

  const READ_AT = '2026-11-14T15:50:12.345Z';

  it('con datasets: una tabla por secuencia y una fila por dataset, con la fuente, los símbolos, las reglas, el intervalo, cuánto se guardan y la hora de la lectura', () => {
    const html = render({ kind: 'ready', data: DATASETS, readAtUtc: READ_AT });
    // Dos tablas, cada una con su cabecera: 2 + 1 filas de datasets.
    expect(html.match(/<tr>/gu)?.length).toBe(3 + 2);
    expect(html.match(/<table/gu)?.length).toBe(2);
    expect(html.indexOf('<h3>R_100 en vivo</h3>')).toBeGreaterThan(-1);
    expect(html.indexOf('<h3>Lotes: velas de 1 minuto</h3>')).toBeGreaterThan(
      html.indexOf('<h3>R_100 en vivo</h3>'),
    );
    expect(html).toContain('2879 velas y 1 horario');
    expect(html).toContain('2 tramos sin velas');
    expect(html).toContain(
      'Cada dataset tiene un día de velas de 1 minuto, cortado a la medianoche UTC, con el horario de ese día.',
    );
    expect(html).toContain('14 nov 2026, 12:21:23 UTC');
    expect(html).toContain('Log 1 · segmentos 0–71');
    expect(html).toContain('11190 ticks');
    expect(html).toContain('Limpio');
    expect(html).toContain('Falló: STORAGE_OBJECT_MISMATCH');
    // La hora de cada verificación, en texto a la vista, no en un atributo.
    expect(html).toContain('>14 nov 2026, 12:21:33 UTC<');
    expect(html).toContain('>14 nov 2026, 12:21:46 UTC<');
    expect(html).toContain('>14 nov 2026, 12:16:10 UTC<');
    expect(html).not.toMatch(/title="[^"]*UTC"/u);
    expect(html).toContain('sha256:111111111111');
    expect(html).toContain('Deriv');
    expect(html).toContain('R_100');
    expect(html).toContain('reglas 3.0.0, 4.0.0');
    expect(html).toContain('Símbolos: R_100, frxEURUSD, frxXAUUSD');
    expect(html).toContain(
      'Cada dataset tiene unas 6 horas de captura, cortadas cerca de las 00:00, 06:00, 12:00 o 18:00 UTC, y uno nuevo suele llegar poco después de esas horas.',
    );
    expect(html).toContain('Los datasets no vencen');
    // Con la fecha: la página no vuelve a leer, y una pestaña puede quedar abierta días.
    expect(html).toContain('Leído el 14 nov 2026, 15:50:12 UTC; la página no se actualiza sola.');
    expect(html).not.toContain('más recientes');
    // Solo muestra: ningún control para cambiar nada, y ningún dato ficticio.
    expect(html).not.toMatch(/<button|<input|<form/u);
    expect(html).not.toContain('Datos ficticios');
  });

  it('con la lista cortada, lo dice', () => {
    const html = render({
      kind: 'ready',
      data: { sequences: [FULL, group('lotes_velas', [CANDLES])] },
      readAtUtc: READ_AT,
    });
    // Solo en la secuencia cortada.
    expect(html.match(/más recientes: hay otros más viejos/gu)?.length).toBe(1);
    expect(
      html.indexOf(`Se muestran los ${String(DATA_DATASETS_LIMIT)} más recientes`),
    ).toBeLessThan(html.indexOf('<h3>Lotes: velas de 1 minuto</h3>'));
  });

  it('cargando, vacío y con un error, con el enlace para iniciar sesión si falta', () => {
    const loading = render({ kind: 'loading' });
    expect(loading).toContain('Cargando los datasets publicados…');
    expect(loading).not.toContain('Leído');
    // Vacío: por qué y qué hacer (concepto de interfaz §5).
    const empty = render({
      kind: 'ready',
      data: { sequences: [] },
      readAtUtc: READ_AT,
    });
    expect(empty).toContain(
      'Todavía no hay datasets publicados: buoh publica uno con cada 6 horas de captura. Vuelve a abrir la página más tarde.',
    );
    expect(empty).toContain('Leído el 14 nov 2026, 15:50:12 UTC');
    const unauthenticated = render({
      kind: 'error',
      message: 'Tu sesión no es válida. Vuelve a iniciar sesión.',
      unauthenticated: true,
    });
    expect(unauthenticated).toContain('Tu sesión no es válida');
    expect(unauthenticated).toContain('href="/acceso"');
    const failed = render({
      kind: 'error',
      message: 'Ocurrió un error inesperado.',
      unauthenticated: false,
    });
    expect(failed).toContain('Ocurrió un error inesperado.');
    expect(failed).not.toContain('href="/acceso"');
  });

  it('la página pide los datasets al abrirse, sin la tabla ficticia del escritorio', () => {
    const html = renderToStaticMarkup(<DatosReal />);
    expect(html).toContain('Datasets publicados');
    expect(html).toContain('Cargando los datasets publicados…');
    expect(html).not.toContain('Incidencias de calidad');
    // Lo que promete es lo que hay: los datasets no vencen, y las incidencias de cada uno, una por
    // una, no están en la Auditoría ni en ninguna otra pantalla.
    expect(html).toContain('Los datasets no vencen.');
    expect(html).not.toContain('no se borran');
    expect(html).toContain('La incidencia de un dataset no desaparece al resolverse');
    expect(html).toContain('la lista de cada una todavía no está en la web');
    expect(html).not.toContain('/auditoria');
  });
});

describe('la lectura de los datasets, sin el token CSRF', () => {
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

  it('GET al mismo origen, sin cuerpo ni token; sin la forma del contrato, «unexpected»', async () => {
    const requests = stubFetch(200, DATASETS);
    await expect(api.dataDatasets()).resolves.toEqual(DATASETS);
    expect(requests[0]?.path).toBe('/api/v2/datos/datasets');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.stringify(requests[0]?.init?.headers ?? {})).not.toMatch(/csrf/iu);
    expect(requests[0]?.init?.body).toBeUndefined();
    stubFetch(200, { sequences: [group('R_100', [OPEN, CLEAN])] });
    await expect(api.dataDatasets()).rejects.toMatchObject({ failure: { code: 'unexpected' } });
  });

  it('un error llega con su código', async () => {
    stubFetch(401, {
      error: { code: 'unauthenticated', request_id: '7c2a4f9e-1f5b-4c3d-9a8e-2b6d0f1e3a5c' },
    });
    await expect(api.dataDatasets()).rejects.toMatchObject({
      failure: { code: 'unauthenticated' },
    });
  });
});
