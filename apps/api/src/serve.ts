import type { ApiConfig } from './config.js';
import { errorName, type ApiLog } from './log.js';

/** Las señales con las que Render y una terminal paran la API. */
export type StopSignal = 'SIGINT' | 'SIGTERM';

/** Lo que cambia en las pruebas: el servidor, las señales y el código de salida. */
export interface ServeDeps {
  readonly app: {
    readonly listen: (options: {
      readonly host: string;
      readonly port: number;
    }) => Promise<unknown>;
    readonly close: () => Promise<unknown>;
  };
  readonly config: ApiConfig;
  readonly log: ApiLog;
  readonly onSignal: (signal: StopSignal, listener: () => void) => void;
  readonly setExitCode: (code: number) => void;
}

/** Lo que `serve` necesita de `process` para escuchar las señales. */
export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
}

/**
 * El `onSignal` de `serve` sobre `process`. Usa `on`, no `once`: con `once`, una segunda `SIGTERM`
 * en plena parada ya no tendría oyente, y Node terminaría el proceso sin esperar a las peticiones
 * en curso. El oyente de `serve` ya ignora las repeticiones.
 */
export function signalsOf(source: SignalSource): ServeDeps['onSignal'] {
  return (signal, listener) => {
    source.on(signal, listener);
  };
}

/**
 * Arranca la API y la para con `SIGTERM` o `SIGINT` (ADR-0019 §10): deja de aceptar conexiones y
 * termina las peticiones en curso. Una segunda señal no hace nada más. Si el cierre falla, deja
 * `api_stop_failed` con el nombre del error y la salida 1.
 */
export async function serve(deps: ServeDeps): Promise<void> {
  await deps.app.listen({ host: deps.config.host, port: deps.config.port });
  deps.log({ event: 'api_listening', port: deps.config.port });

  let stopping = false;
  const stop = (signal: StopSignal) => () => {
    if (stopping) {
      return;
    }
    stopping = true;
    deps.log({ event: 'api_stopping', signal });
    deps.app.close().then(
      () => {
        deps.log({ event: 'api_stopped' });
      },
      (error: unknown) => {
        deps.log({ event: 'api_stop_failed', error: errorName(error) });
        deps.setExitCode(1);
      },
    );
  };
  deps.onSignal('SIGTERM', stop('SIGTERM'));
  deps.onSignal('SIGINT', stop('SIGINT'));
}
