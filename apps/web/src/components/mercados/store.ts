/**
 * La lectura de Mercados con datos reales (concepto de interfaz §11): el gráfico de R_100 de la
 * ventana elegida, `GET /api/v1/datos/grafico?hours=<n>`, y el catálogo de Deriv, `GET
 * /api/v1/datos/catalogo` (ADR-0019 §8). Como la salud, las lecturas van sin el token CSRF, así que no
 * renuevan la inactividad de la sesión (ADR-0019 §2), y con la pestaña oculta no lee. Solo lo importan
 * componentes de `out-api` (`F2-UI-001`).
 */
import { useSyncExternalStore } from 'react';
import type { DataCatalog, DataChart } from '@buoh/contracts';
import { api, ApiCallError, type ApiFailure } from '../auth/api';

/** Las ventanas que se pueden elegir, en horas: la máxima es la de los contratos. */
export const CHART_HOURS = [1, 6, 24] as const;
export type ChartHours = (typeof CHART_HOURS)[number];

/** La ventana al abrir la página. */
export const DEFAULT_HOURS: ChartHours = 1;

/**
 * Cada cuánto se vuelve a leer el gráfico, según la ventana: la respuesta de 1 hora pesa unos 28 KB,
 * y la de 24, unos 0,8 MB (ADR-0019 §8).
 */
export const CHART_REFRESH_MS: Readonly<Record<ChartHours, number>> = {
  1: 60_000,
  6: 5 * 60_000,
  24: 5 * 60_000,
};

/** Cada cuánto se vuelve a leer el catálogo, que solo cambia cuando Deriv cambia sus instrumentos. */
export const CATALOG_REFRESH_MS = 30 * 60_000;

/** Una lectura: cargando, fallida sin datos, o lista, con lo último que llegó. */
export type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure }
  | {
      readonly kind: 'ready';
      readonly data: T;
      /** Cuándo llegó lo que se muestra, en milisegundos del navegador. */
      readonly receivedAtMs: number;
      /** Cuándo se intentó la última lectura, buena o fallida. */
      readonly checkedAtMs: number;
      /** El fallo de la última lectura, si falló después de una buena; si no, `null`. */
      readonly refreshFailure: ApiFailure | null;
    };

export const LOADING = { kind: 'loading' } as const;

export interface MercadosState {
  readonly hours: ChartHours;
  readonly chart: Load<DataChart>;
  readonly catalog: Load<DataCatalog>;
}

export interface MercadosStoreDeps {
  readonly fetchChart: (hours: ChartHours) => Promise<DataChart>;
  readonly fetchCatalog: () => Promise<DataCatalog>;
  /** Milisegundos de pared del navegador. */
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (handle: number) => void;
  /** Si la pestaña está a la vista. */
  readonly visible: () => boolean;
  /** Avisa cuando la pestaña vuelve a estar a la vista; devuelve cómo dejar de avisar. */
  readonly watchVisibility: (listener: () => void) => () => void;
}

export interface MercadosStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => MercadosState;
  /** Cambia la ventana: la de antes deja de mostrarse y se lee la nueva en el acto. */
  readonly setHours: (hours: ChartHours) => void;
}

function failureOf(caught: unknown): ApiFailure {
  return caught instanceof ApiCallError ? caught.failure : { code: 'unexpected' };
}

/**
 * El estado y sus suscriptores. Al llegar el primero lee el gráfico y el catálogo, y después vuelve a
 * leer el gráfico `CHART_REFRESH_MS` después de terminar cada lectura, y al volver a la pestaña; con
 * ella oculta, o sin suscriptores, no lee. El catálogo se vuelve a leer con el gráfico cuando pasaron
 * `CATALOG_REFRESH_MS` o falló. Un fallo después de una lectura buena la conserva y lo anota, salvo
 * sin sesión, que la quita. Una respuesta de una ventana que ya no está elegida no se muestra.
 */
export function createMercadosStore(deps: MercadosStoreDeps): MercadosStore {
  let state: MercadosState = { catalog: LOADING, chart: LOADING, hours: DEFAULT_HOURS };
  const listeners = new Set<() => void>();
  let timer: number | null = null;
  /** La lectura del gráfico en curso, o 0 si no hay ninguna. */
  let reading = 0;
  let lastId = 0;
  let catalogReading = false;
  let stopWatching: (() => void) | null = null;

  function publish(next: MercadosState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function afterFailure<T>(load: Load<T>, failure: ApiFailure): Load<T> {
    return load.kind === 'ready' && failure.code !== 'unauthenticated'
      ? { ...load, checkedAtMs: deps.now(), refreshFailure: failure }
      : { kind: 'failed', failure };
  }

  function schedule() {
    if (listeners.size === 0 || timer !== null || reading !== 0) {
      return;
    }
    timer = deps.setTimer(() => {
      timer = null;
      if (deps.visible()) {
        void refresh();
      }
    }, CHART_REFRESH_MS[state.hours]);
  }

  function catalogDue(): boolean {
    const { catalog } = state;
    return (
      catalog.kind !== 'ready' ||
      catalog.refreshFailure !== null ||
      deps.now() - catalog.receivedAtMs >= CATALOG_REFRESH_MS
    );
  }

  async function refreshCatalog() {
    catalogReading = true;
    try {
      const data = await deps.fetchCatalog();
      const now = deps.now();
      publish({
        ...state,
        catalog: { checkedAtMs: now, data, kind: 'ready', receivedAtMs: now, refreshFailure: null },
      });
    } catch (caught) {
      publish({ ...state, catalog: afterFailure(state.catalog, failureOf(caught)) });
    } finally {
      catalogReading = false;
    }
  }

  async function refresh() {
    if (reading !== 0) {
      return;
    }
    if (!catalogReading && catalogDue()) {
      void refreshCatalog();
    }
    lastId += 1;
    const id = lastId;
    reading = id;
    const { hours } = state;
    try {
      const data = await deps.fetchChart(hours);
      if (reading === id) {
        const now = deps.now();
        publish({
          ...state,
          chart: { checkedAtMs: now, data, kind: 'ready', receivedAtMs: now, refreshFailure: null },
        });
      }
    } catch (caught) {
      if (reading === id) {
        publish({ ...state, chart: afterFailure(state.chart, failureOf(caught)) });
      }
    } finally {
      if (reading === id) {
        reading = 0;
        schedule();
      }
    }
  }

  function onVisible() {
    // Al volver a la pestaña, lee en el acto si no hay una lectura en curso ni otra programada.
    if (reading === 0 && timer === null) {
      void refresh();
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stopWatching = deps.watchVisibility(onVisible);
        if (deps.visible()) {
          void refresh();
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) {
          return;
        }
        if (timer !== null) {
          deps.clearTimer(timer);
          timer = null;
        }
        stopWatching?.();
        stopWatching = null;
      };
    },
    snapshot: () => state,
    setHours(hours) {
      if (hours === state.hours) {
        return;
      }
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
      // La lectura de la ventana anterior, si sigue en curso, ya no se muestra.
      reading = 0;
      publish({ ...state, chart: LOADING, hours });
      if (listeners.size > 0 && deps.visible()) {
        void refresh();
      }
    },
  };
}

let shared: MercadosStore | null = null;

/** El almacén del navegador, creado al primer uso: en la exportación estática no se crea. */
function sharedStore(): MercadosStore {
  shared ??= createMercadosStore({
    fetchChart: api.dataChart,
    fetchCatalog: api.dataCatalog,
    now: () => Date.now(),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
    visible: () => document.visibilityState === 'visible',
    watchVisibility: (listener) => {
      const onChange = () => {
        if (document.visibilityState === 'visible') {
          listener();
        }
      };
      document.addEventListener('visibilitychange', onChange);
      return () => {
        document.removeEventListener('visibilitychange', onChange);
      };
    },
  });
  return shared;
}

// Funciones estables: con otras en cada render, React volvería a suscribirse cada vez.
const subscribeShared = (listener: () => void) => sharedStore().subscribe(listener);
const snapshotShared = () => sharedStore().snapshot();
const SERVER_STATE: MercadosState = { catalog: LOADING, chart: LOADING, hours: DEFAULT_HOURS };
const serverSnapshot = () => SERVER_STATE;
const setHoursShared = (hours: ChartHours) => {
  sharedStore().setHours(hours);
};

/** Mercados para un componente de `out-api`, y cómo cambiar la ventana. En la exportación, leyendo. */
export function useMercados(): readonly [MercadosState, (hours: ChartHours) => void] {
  return [useSyncExternalStore(subscribeShared, snapshotShared, serverSnapshot), setHoursShared];
}
