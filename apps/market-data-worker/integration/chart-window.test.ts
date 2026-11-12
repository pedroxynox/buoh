import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, loadConfig, migrate, openStores, type WorkerConfig } from '../src/index.js';
import { PostgresSourceLogStore } from '../src/postgres/source-log-store.js';
import { readChartWindow } from '../src/source-log/chart-window.js';
import { LiveCheckpointLookup } from '../src/source-log/live-checkpoint.js';
import { SourceEventLog } from '../src/source-log/source-event-log.js';
import { T0 } from '../../../packages/domain/test/support/live-corpus.js';
import {
  captureEvents,
  ms,
  twoStopsEvents,
  wholeLogChart,
  writeCapture,
} from '../test/support/chart-capture.js';
import { checkpointRowsOf } from '../test/support/live-checkpoint-rows.js';
import { measurement, SYMBOL } from '../test/support/live-corpus.js';

/**
 * El gráfico de una ventana (ADR-0019 §8) contra PostgreSQL y S3-compatible locales, como lo lee la
 * API: con un pool cuyas sesiones empiezan sin el esquema del log en el `search_path`
 * (`pg_catalog`), así que `PostgresSourceLogStore` nombra sus tablas con él. Esquema PostgreSQL
 * propio, recreado en cada ejecución; el bucket es el de las pruebas, con claves de contenido.
 */
const SCHEMA = 'buoh_integration_chart';
const environment = {
  ...process.env,
  BUOH_DEPLOYMENT_ENVIRONMENT: 'test',
  BUOH_POSTGRES_SCHEMA: SCHEMA,
};
const events = captureEvents();
let config: WorkerConfig;
let stores: ReturnType<typeof openStores>;
let admin: Pool;
let reader: Pool;

beforeAll(async () => {
  config = loadConfig(environment);
  admin = createPool({ ...config.postgres, schema: 'public' });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  stores = openStores(config);
  await migrate(stores.pool);
  const writer = await SourceEventLog.open({
    objects: stores.objects,
    source: measurement.source,
    store: stores.sourceLog,
    zlibVersion: process.versions.zlib,
  });
  await writeCapture(writer, events);
  const rows = await checkpointRowsOf({
    log: writer,
    profile: measurement,
    symbol: SYMBOL,
    writtenAt: '2026-01-02T00:00:00.000Z',
  });
  for (const row of rows) {
    await stores.sourceLog.insertLiveCheckpoint(row);
  }
  reader = new pg.Pool({
    database: config.postgres.database,
    host: config.postgres.host,
    max: 3,
    options: '-c search_path=pg_catalog -c default_transaction_read_only=on',
    password: config.postgres.password,
    port: config.postgres.port,
    user: config.postgres.user,
  });
});

afterAll(async () => {
  await reader.end();
  await stores.close();
  await admin.end();
});

describe('PostgresSourceLogStore con el esquema del log', () => {
  it('lee lo mismo que con el esquema en el search_path, y sin él la tabla no existe', async () => {
    const qualified = new PostgresSourceLogStore(reader, { schema: SCHEMA });
    const source = measurement.source;
    expect(await qualified.readLogState(source)).toEqual(
      await stores.sourceLog.readLogState(source),
    );
    expect(await qualified.listClosedSegments(source, 0, 100)).toEqual(
      await stores.sourceLog.listClosedSegments(source, 0, 100),
    );
    const versions = new LiveCheckpointLookup({
      alert: () => undefined,
      profile: measurement,
      symbol: SYMBOL,
    }).versionsSha256;
    for (const below of [null, 3]) {
      expect(await qualified.readLiveCheckpoint(source, versions, below)).toEqual(
        await stores.sourceLog.readLiveCheckpoint(source, versions, below),
      );
    }
    const state = await stores.sourceLog.readLogState(source);
    const last = state.lastEventId;
    expect(last).not.toBeNull();
    expect(await qualified.hasSourceEvent(source, last ?? '')).toBe(true);

    const code = await new PostgresSourceLogStore(reader).readLogState(source).then(
      () => 'sin error',
      (error: unknown) => (error as { code?: unknown }).code,
    );
    expect(code).toBe('42P01');
    expect(() => new PostgresSourceLogStore(reader, { schema: 'buoh-log' })).toThrow(TypeError);
  });

  it('da los segmentos desde el primero que termina a esa hora o después, como el almacén en memoria', async () => {
    const qualified = new PostgresSourceLogStore(reader, { schema: SCHEMA });
    const source = measurement.source;
    const closed = await stores.sourceLog.listClosedSegments(source, 0, 1000);
    expect(closed.length).toBeGreaterThan(10);
    const instants = [
      '2025-12-31T00:00:00.000Z',
      ...closed.flatMap((segment) => [
        segment.last_event_time_utc,
        new Date(Date.parse(segment.last_event_time_utc) + 1).toISOString(),
      ]),
      '2026-02-01T00:00:00.000Z',
    ];
    for (const since of instants) {
      const first = closed.find((segment) => segment.last_event_time_utc >= since);
      const expected =
        first === undefined
          ? []
          : closed.filter((segment) => segment.segment_index >= first.segment_index);
      expect(await qualified.listClosedSegmentsSince(source, since), since).toEqual(expected);
    }
  });

  it('da el último segmento que cerró una parada por debajo de cada índice, con dos paradas', async () => {
    const schema = `${SCHEMA}_paradas`;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const twoStops = openStores(loadConfig({ ...environment, BUOH_POSTGRES_SCHEMA: schema }));
    try {
      await migrate(twoStops.pool);
      const writer = await SourceEventLog.open({
        objects: twoStops.objects,
        source: measurement.source,
        store: twoStops.sourceLog,
        zlibVersion: process.versions.zlib,
      });
      await writeCapture(writer, twoStopsEvents());
      const qualified = new PostgresSourceLogStore(reader, { schema });
      const source = measurement.source;
      const closed = await twoStops.sourceLog.listClosedSegments(source, 0, 1000);
      const stops = closed.filter((segment) => segment.close_reason === 'requested');
      expect(stops.map((segment) => segment.segment_index)).toEqual([0, 1]);
      for (let below = 0; below <= closed.length + 1; below += 1) {
        const expected = stops.filter((segment) => segment.segment_index < below).at(-1) ?? null;
        expect(await qualified.lastRequestedSegmentBelow(source, below), String(below)).toEqual(
          expected,
        );
      }
      expect(await qualified.lastRequestedSegmentBelow('otra_fuente', 1000)).toBeNull();
    } finally {
      await twoStops.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});

describe('readChartWindow contra PostgreSQL y S3-compatible', () => {
  it('da lo mismo que el log entero, con el pool de lectura y el esquema del log', async () => {
    const qualified = new PostgresSourceLogStore(reader, { schema: SCHEMA });
    const log = await SourceEventLog.open({
      objects: stores.objects,
      source: measurement.source,
      store: qualified,
      zlibVersion: 'api-read-only',
    });
    for (const [from, to] of [
      [ms(T0 + 800), ms(T0 + 2500)],
      [ms(T0 - 60), ms(T0 + 2540)],
      [ms(T0 + 2300), ms(T0 + 2500)],
    ] as const) {
      const window = await readChartWindow({
        fromUtc: new Date(from).toISOString(),
        log,
        lookup: new LiveCheckpointLookup({
          alert: () => undefined,
          profile: measurement,
          symbol: SYMBOL,
        }),
        segments: qualified,
        toUtc: new Date(to).toISOString(),
      });
      expect(window).toEqual(wholeLogChart(events, from, to));
      expect(window.gaps.length).toBeGreaterThan(0);
    }
  });
});
