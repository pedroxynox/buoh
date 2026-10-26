import { randomBytes } from 'node:crypto';

import { type Scheduler } from '../deriv/ports.js';
import { openWsSocket } from '../deriv/socket.js';
import { createUuidV7Generator } from '../ids.js';
import { UsageError } from '../replay-args.js';
import { runSmoke } from '../smoke.js';
import { parseSmokeArgs } from '../smoke-args.js';

/** Temporizador real; solo los comandos operativos lo usan (ADR-0004 §4). */
const realScheduler: Scheduler = {
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * `pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120]` (ADR-0012 §10).
 * Escribe una sola línea JSON saneada en stdout. Salida 0: pasa; 1: falla; 2: error de uso.
 */
async function main(): Promise<number> {
  let options;
  try {
    options = parseSmokeArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.log(JSON.stringify({ code: error.name, message: error.message, status: 'failed' }));
      return 2;
    }
    throw error;
  }
  try {
    const report = await runSmoke({
      connect: openWsSocket,
      durationSeconds: options.durationSeconds,
      fetch: globalThis.fetch,
      nextId: createUuidV7Generator({ now: () => Date.now(), randomBytes }),
      now: () => new Date().toISOString(),
      scheduler: realScheduler,
      symbol: options.symbol,
      zlibVersion: process.versions.zlib,
    });
    console.log(JSON.stringify(report));
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        code: 'UNEXPECTED',
        message: error instanceof Error ? error.name : 'Error',
        status: 'failed',
      }),
    );
    return 1;
  }
}

process.exitCode = await main();
