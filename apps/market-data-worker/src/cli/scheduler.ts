import { type Scheduler } from '../deriv/ports.js';

/** Temporizador real; solo los comandos operativos lo usan (ADR-0004 §4): `smoke` e `ingest`. */
export const realScheduler: Scheduler = {
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
