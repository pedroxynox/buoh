import {
  apiErrorSchema,
  dataCatalogSchema,
  dataChartSchema,
  type DataCatalog,
  type DataChart,
} from '@buoh/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedSession, SessionService } from '../src/accounts/sessions.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import type { MarketDataReader } from '../src/data/market.js';
import { StorageUnavailableError } from '../src/errors.js';
import { apiRoutes } from '../src/routes.js';
import {
  EXPECTED_JSON_HEADERS,
  routeDeps,
  testApp,
  testRequestId,
  useDeterminismGuards,
} from './support.js';

// Las lecturas de R2 (ADR-0019 §8): `GET /api/v1/datos/grafico` y `GET /api/v1/datos/catalogo`,
// con un lector y un servicio de sesiones falsos. Necesitan una sesión, renuevan su inactividad solo
// con el token CSRF, responden `not_ready` sin el token `api` o sin la credencial de lectura, y
// validan su salida con `DataChart` y `DataCatalog`. La lectura contra PostgreSQL y el almacenamiento
// de objetos está en integration/market.test.ts.
useDeterminismGuards();

const SID = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const CSRF = 'a'.repeat(64);
const ACCOUNT = '01900000-0000-7000-8000-00000000a001';
const SESSION: AuthenticatedSession = {
  sessionId: '01900000-0000-7000-8000-00000000b001',
  sessionSecret: SID,
  accountId: ACCOUNT,
  lastActivityMs: 0,
};
const COOKIE = { cookie: `${SESSION_COOKIE_NAME}=${SID}` };
const CHART_URL = '/api/v1/datos/grafico';
const CATALOG_URL = '/api/v1/datos/catalogo';

const CHART: DataChart = {
  log: 3,
  source: 'deriv_options',
  symbol: 'R_100',
  from_utc: '2026-11-08T06:00:00.000Z',
  to_utc: '2026-11-08T12:00:00.000Z',
  log_started_at_utc: '2026-11-08T00:00:04.646Z',
  ticks: { offsets_ms: [0, 2000, 4000], quotes: ['1234.56', '1234.60', '1234.11'] },
  gaps: [
    {
      from_utc: '2026-11-08T07:00:00.001Z',
      to_utc: '2026-11-08T07:00:05.999Z',
      cause: 'connection_lost',
      history: 'recovered',
      reason: null,
      recovered_ticks: 2,
    },
  ],
};

const CATALOG: DataCatalog = {
  log: 3,
  catalog: {
    source: 'deriv_options',
    version: 4,
    received_at_utc: '2026-11-08T00:00:09.338Z',
    source_schema_release: 'deriv-api-2026-10-20',
    content_sha256: 'b'.repeat(64),
    entries: [
      {
        underlying_symbol: 'R_100',
        underlying_symbol_name: 'Volatility 100 Index',
        underlying_symbol_type: 'stockindex',
        market: 'synthetic_index',
        submarket: 'random_index',
        subgroup: 'synthetics',
        pip_size: '0.01',
        exchange_is_open: 1,
        is_trading_suspended: 0,
      },
    ],
  },
};

/** Las sesiones falsas: solo vale la cookie `SID`; anotan cada llamada. */
function fakeSessions(calls: string[]): SessionService {
  return {
    login: () => Promise.reject(new Error('sin inicio de sesión en esta prueba')),
    authenticate: (secret) => {
      calls.push('authenticate');
      return Promise.resolve(secret === SID ? SESSION : null);
    },
    renewActivity: () => {
      calls.push('renewActivity');
      return Promise.resolve();
    },
    logout: () => Promise.resolve(0),
    closeOthers: () => Promise.resolve(0),
    listAudit: () => Promise.resolve([]),
    csrfToken: () => CSRF,
    validateCsrf: (_secret, token) => token === CSRF,
    flushPendingFailures: () => Promise.resolve(),
  };
}

/** Una API con el lector de R2 `reader`, o sin él (`null`), y si tiene sus migraciones. */
function appWith(reader: Partial<MarketDataReader> | null, ready = true) {
  const calls: string[] = [];
  const market: MarketDataReader | null =
    reader === null
      ? null
      : {
          chart: (hours) => {
            calls.push(`chart:${String(hours)}`);
            return reader.chart?.(hours) ?? Promise.reject(new Error('sin gráfico'));
          },
          catalog: () => {
            calls.push('catalog');
            return reader.catalog?.() ?? Promise.reject(new Error('sin catálogo'));
          },
        };
  const built = testApp(
    apiRoutes(
      routeDeps({ readiness: { isReady: () => ready }, sessions: fakeSessions(calls), market }),
    ),
  );
  return { ...built, calls };
}

function expectError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
  for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
    expect(response.headers[name], name).toBe(value);
  }
}

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

describe('GET /api/v1/datos/grafico (ADR-0019 §8)', () => {
  it('con sesión da el gráfico de las horas pedidas, con las cabeceras del JSON y la cuenta en el registro', async () => {
    const { app, calls, lines } = appWith({ chart: () => Promise.resolve(CHART) });
    const response = await app.inject({
      method: 'GET',
      url: `${CHART_URL}?hours=6`,
      headers: COOKIE,
    });
    expect(response.statusCode).toBe(200);
    expect(dataChartSchema.parse(response.json())).toEqual(CHART);
    for (const [name, value] of Object.entries(EXPECTED_JSON_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
    expect(calls).toEqual(['authenticate', 'chart:6']);
    expect(lines).toEqual([
      {
        event: 'api_request',
        method: 'GET',
        route: CHART_URL,
        status: 200,
        duration_ms: 5,
        request_id: testRequestId(1),
        account_id: ACCOUNT,
      },
    ]);
  });

  it('las horas son un entero de 1 a 24, y cualquier otra consulta es invalid_request sin leer nada', async () => {
    for (const query of [
      '',
      '?hours=0',
      '?hours=25',
      '?hours=6.0',
      '?hours=06',
      '?hours=-1',
      '?hours=seis',
      '?hours=6&hours=7',
      '?hours=6&log=1',
      '?horas=6',
    ]) {
      const { app, calls } = appWith({ chart: () => Promise.resolve(CHART) });
      expectError(
        await app.inject({ method: 'GET', url: `${CHART_URL}${query}`, headers: COOKIE }),
        400,
        'invalid_request',
      );
      expect(calls, query).toEqual([]);
    }
    for (const hours of [1, 24]) {
      const { app, calls } = appWith({ chart: () => Promise.resolve(CHART) });
      await app.inject({
        method: 'GET',
        url: `${CHART_URL}?hours=${String(hours)}`,
        headers: COOKIE,
      });
      expect(calls).toEqual(['authenticate', `chart:${String(hours)}`]);
    }
  });

  it('renueva la inactividad solo con el token CSRF: una actualización automática no', async () => {
    const plain = appWith({ chart: () => Promise.resolve(CHART) });
    await plain.app.inject({ method: 'GET', url: `${CHART_URL}?hours=6`, headers: COOKIE });
    expect(plain.calls).toEqual(['authenticate', 'chart:6']);

    const owner = appWith({ chart: () => Promise.resolve(CHART) });
    await owner.app.inject({
      method: 'GET',
      url: `${CHART_URL}?hours=6`,
      headers: { ...COOKIE, 'x-csrf-token': CSRF },
    });
    expect(owner.calls).toEqual(['authenticate', 'renewActivity', 'chart:6']);
  });

  it('sin sesión responde unauthenticated sin leer nada, también sin el token api', async () => {
    for (const reader of [{ chart: () => Promise.resolve(CHART) }, null]) {
      const { app, calls } = appWith(reader);
      expectError(
        await app.inject({ method: 'GET', url: `${CHART_URL}?hours=6` }),
        401,
        'unauthenticated',
      );
      expect(calls).not.toContain('chart:6');
    }
  });

  it('sin el token api o la credencial de lectura responde not_ready, con la sesión ya comprobada', async () => {
    const { app, calls } = appWith(null);
    expectError(
      await app.inject({ method: 'GET', url: `${CHART_URL}?hours=6`, headers: COOKIE }),
      503,
      'not_ready',
    );
    expect(calls).toEqual(['authenticate']);
  });

  it('sin las migraciones de la API responde not_ready sin mirar la sesión', async () => {
    const { app, calls } = appWith({ chart: () => Promise.resolve(CHART) }, false);
    expectError(
      await app.inject({ method: 'GET', url: `${CHART_URL}?hours=6`, headers: COOKIE }),
      503,
      'not_ready',
    );
    expect(calls).toEqual([]);
  });

  it('si R2 no responde, storage_unavailable con el motivo en el registro y nunca el mensaje', async () => {
    const failure = new StorageUnavailableError('AccessDenied', {
      cause: new Error('https://cuenta-sintetica.r2.cloudflarestorage.com denegado'),
    });
    const { app, lines } = appWith({ chart: () => Promise.reject(failure) });
    const response = await app.inject({
      method: 'GET',
      url: `${CHART_URL}?hours=6`,
      headers: COOKIE,
    });
    expectError(response, 503, 'storage_unavailable');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'AccessDenied',
    });
    expect(JSON.stringify(lines)).not.toContain('cuenta-sintetica');
    expect(response.body).not.toContain('cuenta-sintetica');
  });

  it('un motivo de R2 que no está saneado deja el nombre del error, nunca el texto', async () => {
    const { app, lines } = appWith({
      chart: () => Promise.reject(new StorageUnavailableError('connect a cuenta-sintetica')),
    });
    expectError(
      await app.inject({ method: 'GET', url: `${CHART_URL}?hours=6`, headers: COOKIE }),
      503,
      'storage_unavailable',
    );
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'StorageUnavailableError',
    });
  });

  it('si PostgreSQL no responde, postgres_unavailable con el código en el registro', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED dpg-sintetico:5432'), {
      code: 'ECONNREFUSED',
    });
    const { app, lines } = appWith({ chart: () => Promise.reject(failure) });
    const response = await app.inject({
      method: 'GET',
      url: `${CHART_URL}?hours=6`,
      headers: COOKIE,
    });
    expectError(response, 503, 'postgres_unavailable');
    expect(lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'ECONNREFUSED',
    });
    expect(response.body).not.toContain('dpg-sintetico');
  });

  it('un log que no pasa sus comprobaciones o sin punto de control cerca es internal, con su nombre y sin su mensaje', async () => {
    for (const name of [
      'LogIntegrityError',
      'LogNotDerivableError',
      'ChartCheckpointError',
      'SourceSchemaMissingError',
    ]) {
      const { app, lines } = appWith({
        chart: () => Promise.reject(new NamedError(name, 'segmento-12-alterado')),
      });
      const response = await app.inject({
        method: 'GET',
        url: `${CHART_URL}?hours=6`,
        headers: COOKIE,
      });
      expectError(response, 500, 'internal');
      expect(lines).toContainEqual({
        event: 'api_error',
        request_id: testRequestId(1),
        error: name,
      });
      expect(JSON.stringify(lines) + response.body).not.toContain('segmento-12-alterado');
    }
  });

  it('una salida que no cumple DataChart es internal', async () => {
    for (const invalid of [
      { ...CHART, ticks: { offsets_ms: [0, 0], quotes: ['1', '2'] } },
      { ...CHART, log: null },
      { ...CHART, gaps: [{ ...CHART.gaps[0], reason: 'history_page_limit' }] },
    ]) {
      const { app } = appWith({ chart: () => Promise.resolve(invalid as DataChart) });
      expectError(
        await app.inject({ method: 'GET', url: `${CHART_URL}?hours=6`, headers: COOKIE }),
        500,
        'internal',
      );
    }
  });
});

describe('GET /api/v1/datos/catalogo (ADR-0019 §8)', () => {
  it('con sesión da la última versión del catálogo del log activo, o ninguna', async () => {
    for (const catalog of [CATALOG, { log: 3, catalog: null }, { log: null, catalog: null }]) {
      const { app, calls, lines } = appWith({ catalog: () => Promise.resolve(catalog) });
      const response = await app.inject({ method: 'GET', url: CATALOG_URL, headers: COOKIE });
      expect(response.statusCode).toBe(200);
      expect(dataCatalogSchema.parse(response.json())).toEqual(catalog);
      expect(calls).toEqual(['authenticate', 'catalog']);
      expect(lines).toMatchObject([{ route: CATALOG_URL, status: 200, account_id: ACCOUNT }]);
    }
  });

  it('sin sesión, sin el token api o con una consulta, no lee nada', async () => {
    const anonymous = appWith({ catalog: () => Promise.resolve(CATALOG) });
    expectError(
      await anonymous.app.inject({ method: 'GET', url: CATALOG_URL }),
      401,
      'unauthenticated',
    );
    expect(anonymous.calls).toEqual(['authenticate']);

    const missing = appWith(null);
    expectError(
      await missing.app.inject({ method: 'GET', url: CATALOG_URL, headers: COOKIE }),
      503,
      'not_ready',
    );

    const query = appWith({ catalog: () => Promise.resolve(CATALOG) });
    expectError(
      await query.app.inject({ method: 'GET', url: `${CATALOG_URL}?version=1`, headers: COOKIE }),
      400,
      'invalid_request',
    );
    expect(query.calls).toEqual([]);
  });

  it('renueva la inactividad solo con el token CSRF', async () => {
    const owner = appWith({ catalog: () => Promise.resolve(CATALOG) });
    await owner.app.inject({
      method: 'GET',
      url: CATALOG_URL,
      headers: { ...COOKIE, 'x-csrf-token': CSRF },
    });
    expect(owner.calls).toEqual(['authenticate', 'renewActivity', 'catalog']);
  });

  it('si R2 no responde, storage_unavailable; un documento que no es el de su fila, internal', async () => {
    const storage = appWith({
      catalog: () => Promise.reject(new StorageUnavailableError('TimeoutError')),
    });
    expectError(
      await storage.app.inject({ method: 'GET', url: CATALOG_URL, headers: COOKIE }),
      503,
      'storage_unavailable',
    );
    expect(storage.lines).toContainEqual({
      event: 'api_error',
      request_id: testRequestId(1),
      error: 'TimeoutError',
    });

    const altered = appWith({
      catalog: () => Promise.reject(new TypeError('El documento de la versión 4 no coincide')),
    });
    const response = await altered.app.inject({ method: 'GET', url: CATALOG_URL, headers: COOKIE });
    expectError(response, 500, 'internal');
    expect(response.body).not.toContain('versión 4');
  });
});
