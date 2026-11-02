import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../src/config.js';
import type { ApiLogLine } from '../src/log.js';
import { serve, type StopSignal } from '../src/serve.js';

// Arranque y parada de la API (ADR-0019 §10): el SIGTERM de Render cierra el servidor.

const CONFIG: ApiConfig = { environment: 'production', host: '0.0.0.0', port: 10_000 };

function harness(close: () => Promise<unknown> = () => Promise.resolve()) {
  const lines: ApiLogLine[] = [];
  const listeners = new Map<StopSignal, () => void>();
  const exitCodes: number[] = [];
  const app = { listen: vi.fn(() => Promise.resolve('')), close: vi.fn(close) };
  const deps = {
    app,
    config: CONFIG,
    log: (line: ApiLogLine) => {
      lines.push(line);
    },
    onSignal: (signal: StopSignal, listener: () => void) => {
      listeners.set(signal, listener);
    },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
  };
  return { app, deps, exitCodes, lines, listeners };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('serve', () => {
  it('escucha en la dirección y el puerto de la configuración', async () => {
    const { app, deps, lines } = harness();
    await serve(deps);
    expect(app.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 10_000 });
    expect(lines).toEqual([{ event: 'api_listening', port: 10_000 }]);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('con %s cierra una sola vez', async (signal) => {
    const { app, deps, exitCodes, lines, listeners } = harness();
    await serve(deps);
    listeners.get(signal)?.();
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();
    await settle();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(lines.slice(1)).toEqual([{ event: 'api_stopping', signal }, { event: 'api_stopped' }]);
    expect(exitCodes).toEqual([]);
  });

  it('si el cierre falla, deja el nombre del error y la salida 1', async () => {
    const secret = 'detalle-del-cierre-4b2e';
    const { deps, exitCodes, lines, listeners } = harness(() =>
      Promise.reject(Object.assign(new Error(secret), { code: 'ERR_SERVER_NOT_RUNNING' })),
    );
    await serve(deps);
    listeners.get('SIGTERM')?.();
    await settle();
    expect(lines.slice(1)).toEqual([
      { event: 'api_stopping', signal: 'SIGTERM' },
      { event: 'api_stop_failed', error: 'ERR_SERVER_NOT_RUNNING' },
    ]);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(exitCodes).toEqual([1]);
  });
});
