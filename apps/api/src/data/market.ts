import { DATA_CHART_MAX_HOURS, type DataCatalog, type DataChart } from '@buoh/contracts';
import {
  createDerivMeasurementProfileFromSourceSchema,
  DERIV_SCHEMA_RELEASE,
  DERIV_SOURCE,
  failureReason,
  LiveCheckpointLookup,
  LogReadError,
  ObjectReadError,
  PostgresCatalogStore,
  PostgresSourceLogStore,
  readChartWindow,
  readStoredSourceSchema,
  SourceEventLog,
  type ChartItem,
  type ChartSegmentCache,
  type ExpectedSchemaArchive,
  type LogLocation,
  type ObjectStore,
  type SourceLogStore,
} from '@buoh/market-data-worker/lectura';
import type { Pool } from 'pg';

import { StorageUnavailableError } from '../errors.js';
import { activeCaptureLog } from './reader.js';

/**
 * Las lecturas de R2 del sistema de datos (ADR-0019 §8), con el pool de `buoh_api_lectura` y el
 * token `api` de R2: el catálogo de Deriv y el gráfico de R_100 del log activo. Ninguna escribe ni
 * deriva el log entero: el gráfico lee solo los segmentos de su ventana y parte de los puntos de
 * control (`readChartWindow`).
 */
export interface MarketDataReader {
  /**
   * La última versión del catálogo de Deriv en el log activo (`DataCatalog`). Rechaza con el error
   * de PostgreSQL si no responde, con `StorageUnavailableError` si R2 no responde, con
   * `LogsUnreadableError` si hay logs y el rol no puede leer ninguno, y con el error de la lectura si
   * el documento no es el de su fila.
   */
  catalog(): Promise<DataCatalog>;
  /**
   * El gráfico de R_100 de las últimas `hours` horas del log activo (`DataChart`), hasta la hora de
   * la lectura. Rechaza como `catalog`, y además con `LogIntegrityError`, `LogNotDerivableError` o
   * `ChartCheckpointError` del log, y con `SourceSchemaMissingError` si el log tiene eventos y no su
   * esquema de fuente. Lee un gráfico a la vez: una petición que llega con otro en curso lo espera.
   */
  chart(hours: number): Promise<DataChart>;
}

export interface MarketDataReaderDeps {
  /** El pool de lectura (`createReaderPool`). */
  readonly pool: Pool;
  /** El almacenamiento de objetos de la captura, con el prefijo del log (`logs/<n>/`). */
  readonly objects: (log: LogLocation) => Pick<ObjectStore, 'bucket' | 'get'>;
  /** Milisegundos de pared: la hora con que se busca el log activo y el final de la ventana. */
  readonly clock: () => number;
  /**
   * La release de los esquemas de Deriv cuyo esquema de fuente guardó `ingest`: la fijada
   * (`DERIV_SCHEMA_RELEASE`), salvo en las pruebas, que no tienen los esquemas de Deriv.
   */
  readonly schemaRelease?: ExpectedSchemaArchive;
}

/** El único símbolo de la Fase 2, el que captura `ingest` (plan de Fase 2, «Alcance ya decidido»). */
export const CHART_SYMBOL = 'R_100';

const HOUR_MS = 3_600_000;

/**
 * Los segmentos cerrados cuyo gráfico guarda la API, entre todos los logs: los de la ventana más
 * larga, en segmentos de 5 minutos, y dos horas más.
 */
export const CHART_CACHE_SEGMENTS = DATA_CHART_MAX_HOURS * 12 + 24;

/**
 * Los objetos pequeños que guarda la API, hasta 2 MiB entre todos: los source events del segmento
 * abierto, que cada lectura del gráfico vuelve a pedir (`SourceEventLog.open`). Un frame de R_100
 * ocupa unos 700 bytes, así que caben unos 18 segmentos.
 */
export const OBJECT_CACHE_BYTES = 2 * 1024 * 1024;
/** El mayor objeto que se guarda: los source events, no los segmentos cerrados ni el catálogo. */
export const OBJECT_CACHE_MAX_OBJECT_BYTES = 8 * 1024;

/** Un log con eventos sin el esquema de fuente que guarda `ingest` al empezar (ADR-0015 §7). */
export class SourceSchemaMissingError extends Error {
  constructor() {
    super('El log tiene eventos y no tiene su esquema de fuente.');
    this.name = 'SourceSchemaMissingError';
  }
}

/** El esquema de fuente del log tiene otros bytes que los de la release fijada. */
export class SourceSchemaMismatchError extends Error {
  constructor() {
    super('El esquema de fuente del log no es el de la release fijada.');
    this.name = 'SourceSchemaMismatchError';
  }
}

/** Un mapa con un tope de entradas: al pasarlo, sale la que hace más que no se usa. */
export class LruCache<V> {
  readonly #entries = new Map<string, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }
}

/**
 * Objetos guardados por su clave, con un tope de bytes entre todos: al pasarlo, salen los que hace
 * más que no se usan. Solo para claves de contenido (`sha256/…`), cuyos bytes no cambian, y que quien
 * lee vuelve a comprobar contra su hash.
 */
export class ObjectBytesCache {
  readonly #entries = new Map<string, Uint8Array>();
  readonly #limit: number;
  readonly #maxObject: number;
  #bytes = 0;

  constructor(limit: number, maxObject: number) {
    this.#limit = limit;
    this.#maxObject = maxObject;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): Uint8Array | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.#maxObject || this.#entries.has(key)) {
      return;
    }
    this.#entries.set(key, value);
    this.#bytes += value.byteLength;
    for (const [oldest, bytes] of this.#entries) {
      if (this.#bytes <= this.#limit) {
        break;
      }
      this.#entries.delete(oldest);
      this.#bytes -= bytes.byteLength;
    }
  }
}

/** Una escritura que estas lecturas nunca hacen: si un error de programación la pidiera, falla. */
function refuseWrite(): Promise<never> {
  return Promise.reject(new TypeError('Las lecturas de la API no escriben en ningún almacén.'));
}

/** Solo las claves de contenido se guardan: las demás no son de un log ni del catálogo. */
const CONTENT_KEY = /^sha256\/[0-9a-f]{64}$/u;

/**
 * El almacenamiento de objetos de un log para estas lecturas: sin escribir, con los objetos pequeños
 * guardados en `cache` (`prefix` los separa por log), y con cada fallo que no es un objeto ausente o
 * mayor que su fila (`ObjectReadError`) como `StorageUnavailableError`: R2 no respondió.
 */
export function readOnlyObjects(
  objects: Pick<ObjectStore, 'bucket' | 'get'>,
  cache: ObjectBytesCache,
  prefix: string,
): ObjectStore {
  return {
    bucket: objects.bucket,
    get: async (key, maxBytes) => {
      const cacheable = CONTENT_KEY.test(key);
      const cached = cacheable ? cache.get(prefix + key) : undefined;
      if (cached !== undefined) {
        if (cached.byteLength > maxBytes) {
          throw new ObjectReadError('too_large', key);
        }
        return cached;
      }
      let bytes: Uint8Array;
      try {
        bytes = await objects.get(key, maxBytes);
      } catch (error) {
        if (error instanceof ObjectReadError) {
          throw error;
        }
        throw new StorageUnavailableError(failureReason(error), { cause: error });
      }
      if (cacheable) {
        cache.set(prefix + key, bytes);
      }
      return bytes;
    },
    putIfAbsent: refuseWrite,
  };
}

/** El índice del log en solo lectura, para `SourceEventLog.open`. */
function readOnlyLogStore(store: PostgresSourceLogStore): SourceLogStore {
  return {
    hasSourceEvent: (source, eventId) => store.hasSourceEvent(source, eventId),
    insertClosedSegment: refuseWrite,
    insertIndexRow: refuseWrite,
    insertLiveCheckpoint: refuseWrite,
    listClosedSegments: (source, from, to) => store.listClosedSegments(source, from, to),
    readLiveCheckpoint: (source, versionsSha256, below) =>
      store.readLiveCheckpoint(source, versionsSha256, below),
    readLogState: (source) => store.readLogState(source),
  };
}

/**
 * Lo que rechaza una lectura del log, sin el envoltorio de `LogReadError`: el
 * `StorageUnavailableError` de R2 o el error de PostgreSQL, que la API clasifica con su código. Lo
 * demás, tal cual.
 */
async function unwrapped<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof LogReadError && error.cause instanceof Error) {
      throw error.cause;
    }
    throw error;
  }
}

/** Para `SourceEventLog.open`: estas lecturas nunca cierran un segmento, así que no comprimen. */
const UNUSED_WRITER_VERSION = 'api-read-only';

type MeasurementProfile = ReturnType<typeof createDerivMeasurementProfileFromSourceSchema>;

export function createMarketDataReader(deps: MarketDataReaderDeps): MarketDataReader {
  const release = deps.schemaRelease ?? DERIV_SCHEMA_RELEASE;
  const objectsCache = new ObjectBytesCache(OBJECT_CACHE_BYTES, OBJECT_CACHE_MAX_OBJECT_BYTES);
  const segments = new LruCache<readonly ChartItem[]>(CHART_CACHE_SEGMENTS);
  /** El perfil de medición sale del esquema fijado en la release: es el mismo en todos los logs. */
  let profile: MeasurementProfile | null = null;
  /** El último log en el que se comprobó que `ingest` guardó ese esquema. */
  let verifiedLog: number | null = null;
  /** La cola de los gráficos: uno a la vez. */
  let queue: Promise<unknown> = Promise.resolve();

  const objectsOf = (log: LogLocation) =>
    readOnlyObjects(deps.objects(log), objectsCache, log.prefix);

  const segmentCache = (log: LogLocation): ChartSegmentCache => ({
    get: (key) => segments.get(`${String(log.number)}:${key}`),
    set: (key, items) => {
      segments.set(`${String(log.number)}:${key}`, items);
    },
  });

  /**
   * El perfil de medición, si `ingest` guardó en el log el esquema de fuente de la release (ADR-0015
   * §7), o `null` si no lo guardó. Se comprueba en cada log nuevo: uno escrito con otra release no
   * tiene ese esquema.
   */
  const profileOf = async (
    log: LogLocation,
    objects: ObjectStore,
  ): Promise<MeasurementProfile | null> => {
    if (profile !== null && verifiedLog === log.number) {
      return profile;
    }
    const stored = await readStoredSourceSchema(objects, release);
    switch (stored.status) {
      case 'missing':
        return null;
      case 'mismatch':
        throw new SourceSchemaMismatchError();
      case 'found':
        profile ??= createDerivMeasurementProfileFromSourceSchema({
          source_schema_bytes: stored.bytes,
          source_schema_release: release.release,
          symbol: CHART_SYMBOL,
        });
        verifiedLog = log.number;
        return profile;
    }
  };

  const readChart = async (hours: number): Promise<DataChart> => {
    const { log, now } = await activeCaptureLog(deps);
    const from = now - hours * HOUR_MS;
    const base = {
      source: DERIV_SOURCE,
      symbol: CHART_SYMBOL,
      from_utc: new Date(from).toISOString(),
      to_utc: new Date(now).toISOString(),
    };
    const empty = { offsets_ms: [], quotes: [] };
    if (log === null) {
      return { ...base, log: null, log_started_at_utc: null, ticks: empty, gaps: [] };
    }
    const objects = objectsOf(log);
    const store = new PostgresSourceLogStore(deps.pool, { schema: log.schema });
    const sourceLog = await unwrapped(() =>
      SourceEventLog.open({
        objects,
        source: DERIV_SOURCE,
        store: readOnlyLogStore(store),
        zlibVersion: UNUSED_WRITER_VERSION,
      }),
    );
    const started = sourceLog.firstEventTimeUtc;
    if (started === null) {
      return { ...base, log: log.number, log_started_at_utc: null, ticks: empty, gaps: [] };
    }
    const measurement = await profileOf(log, objects);
    if (measurement === null) {
      throw new SourceSchemaMissingError();
    }
    const window = await unwrapped(() =>
      readChartWindow({
        cache: segmentCache(log),
        fromUtc: base.from_utc,
        log: sourceLog,
        lookup: new LiveCheckpointLookup({
          // Un punto de control rechazado lo avisa `data:health` (`checkpoint_rejected`).
          alert: () => undefined,
          profile: measurement,
          symbol: CHART_SYMBOL,
        }),
        segments: store,
        toUtc: base.to_utc,
      }),
    );
    return {
      ...base,
      log: log.number,
      log_started_at_utc: started,
      ticks: {
        offsets_ms: window.ticks.map((tick) => tick.time_ms - from),
        quotes: window.ticks.map((tick) => tick.quote_decimal),
      },
      gaps: window.gaps.map((gap) => ({
        from_utc: new Date(gap.from_ms).toISOString(),
        to_utc: gap.to_ms === null ? null : new Date(gap.to_ms).toISOString(),
        cause: gap.cause,
        history: gap.history,
        reason: gap.reason,
        recovered_ticks: gap.recovered_ticks,
      })),
    };
  };

  return {
    catalog: async () => {
      const { log } = await activeCaptureLog(deps);
      if (log === null) {
        return { log: null, catalog: null };
      }
      const latest = await new PostgresCatalogStore(deps.pool, objectsOf(log), {
        schema: log.schema,
      }).latest(DERIV_SOURCE, 'deriv_active_symbols');
      if (latest === null) {
        return { log: log.number, catalog: null };
      }
      const { snapshot, version } = latest;
      return {
        log: log.number,
        catalog: {
          source: snapshot.source,
          version,
          received_at_utc: snapshot.received_at_utc,
          source_schema_release: snapshot.source_schema_release,
          content_sha256: snapshot.content_sha256,
          entries: snapshot.entries,
        },
      };
    },
    chart: (hours) => {
      const result = queue.then(() => readChart(hours));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
