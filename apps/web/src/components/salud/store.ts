/**
 * La lectura compartida de la salud de los datos (concepto de interfaz §10): la insignia de la barra
 * superior y el Observatorio leen el mismo estado, con una sola petición a `GET /api/v1/datos/salud`
 * al abrir la web y otra cada minuto mientras la pestaña está a la vista. Las lecturas van sin el
 * token CSRF: son la actualización automática, que no renueva la inactividad de la sesión (ADR-0019
 * §2). Solo lo importan componentes de `out-api` (`F2-UI-001`).
 */
import { useSyncExternalStore } from 'react';
import type { DataHealth } from '@buoh/contracts';
import { api, ApiCallError, type ApiFailure } from '../auth/api';
import { LOADING, type DataHealthState } from './salud';

/** Cada cuánto se vuelve a leer: `buoh-operaciones` guarda una observación cada 5 minutos. */
export const REFRESH_MS = 60_000;

export interface DataHealthStoreDeps {
  readonly fetchHealth: () => Promise<DataHealth>;
  /** Milisegundos de pared del navegador. */
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (handle: number) => void;
  /** Si la pestaña está a la vista. */
  readonly visible: () => boolean;
  /** Avisa cuando la pestaña vuelve a estar a la vista; devuelve cómo dejar de avisar. */
  readonly watchVisibility: (listener: () => void) => () => void;
}

export interface DataHealthStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => DataHealthState;
}

/**
 * El estado de la lectura y sus suscriptores. Lee al llegar el primero, cada `REFRESH_MS` después de
 * terminar la lectura anterior y al volver a la pestaña; con ella oculta, o sin suscriptores, no lee.
 * Un fallo después de una respuesta buena la conserva y lo anota, salvo sin sesión, que la quita.
 */
export function createDataHealthStore(deps: DataHealthStoreDeps): DataHealthStore {
  let state: DataHealthState = LOADING;
  const listeners = new Set<() => void>();
  let timer: number | null = null;
  let fetching = false;
  let stopWatching: (() => void) | null = null;

  function publish(next: DataHealthState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function schedule() {
    if (listeners.size === 0 || timer !== null) {
      return;
    }
    timer = deps.setTimer(() => {
      timer = null;
      if (deps.visible()) {
        void refresh();
      }
    }, REFRESH_MS);
  }

  async function refresh() {
    if (fetching) {
      return;
    }
    fetching = true;
    try {
      const health = await deps.fetchHealth();
      const now = deps.now();
      publish({ kind: 'ready', health, receivedAtMs: now, checkedAtMs: now, refreshFailure: null });
    } catch (caught) {
      const failure: ApiFailure =
        caught instanceof ApiCallError ? caught.failure : { code: 'unexpected' };
      publish(
        state.kind === 'ready' && failure.code !== 'unauthenticated'
          ? { ...state, checkedAtMs: deps.now(), refreshFailure: failure }
          : { kind: 'failed', failure },
      );
    } finally {
      fetching = false;
      schedule();
    }
  }

  function onVisible() {
    // Al volver a la pestaña, lee en el acto si no hay una lectura en curso ni otra programada.
    if (!fetching && timer === null) {
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
  };
}

let shared: DataHealthStore | null = null;

/** El almacén del navegador, creado al primer uso: en la exportación estática no se crea. */
function sharedStore(): DataHealthStore {
  shared ??= createDataHealthStore({
    fetchHealth: api.dataHealth,
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
const serverSnapshot = () => LOADING;

/** La salud de los datos para un componente de `out-api`. En la exportación estática, leyendo. */
export function useDataHealth(): DataHealthState {
  return useSyncExternalStore(subscribeShared, snapshotShared, serverSnapshot);
}
