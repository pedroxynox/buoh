import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WORKER_NODE_FLAGS } from '../node-flags.js';

/** Los comandos del worker que `buoh-operaciones` corre en un proceso aparte (ADR-0018 §11). */
export type WorkerChild = 'health' | 'migrate';

/** Cómo terminó un proceso: su código, su salida y si se cortó por su plazo. */
export interface ChildResult {
  /** El código de salida, o `null` si lo terminó una señal. */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Corre un comando del worker con esos argumentos y ese entorno, y nada más. */
export type RunChild = (
  child: WorkerChild,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<ChildResult>;

/**
 * El plazo de cada proceso. `data:health` responde en unos 35 s como mucho (`HEALTH_DEADLINE_MS` y
 * `HEALTH_CLOSE_DEADLINE_MS`); `db:migrate` aplica migraciones que solo añaden.
 */
export const CHILD_TIMEOUT_MS: Readonly<Record<WorkerChild, number>> = {
  health: 60_000,
  migrate: 120_000,
};

/** Lo que se guarda, como mucho, de stdout y de stderr de un proceso. */
export const CHILD_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * Corre `script` con Node, con `nodeFlags` delante, sus argumentos y exactamente `env`: el proceso
 * no hereda el entorno de quien lo lanza. Guarda stdout y stderr, cada uno hasta
 * `CHILD_OUTPUT_LIMIT_BYTES`, y si no termina en `timeoutMs` lo corta con `SIGKILL`. Se rechaza si
 * Node no arranca.
 */
export function runNodeScript(input: {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly nodeFlags: readonly string[];
  readonly script: string;
  readonly timeoutMs: number;
}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...input.nodeFlags, input.script, ...input.args], {
      env: { ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = () => {
      const chunks: Buffer[] = [];
      let size = 0;
      return {
        add: (chunk: Buffer) => {
          if (size < CHILD_OUTPUT_LIMIT_BYTES) {
            chunks.push(chunk.subarray(0, CHILD_OUTPUT_LIMIT_BYTES - size));
            size += chunk.length;
          }
        },
        text: () => Buffer.concat(chunks).toString('utf8'),
      };
    };
    const stdout = collect();
    const stderr = collect();
    child.stdout.on('data', stdout.add);
    child.stderr.on('data', stderr.add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr: stderr.text(), stdout: stdout.text(), timedOut });
    });
  });
}

/**
 * `data:health` (`dist/cli/health.js`) o `db:migrate` (`dist/cli/migrate.js`) en un proceso aparte,
 * con los tamaños de V8 de los procesos del worker (`WORKER_NODE_FLAGS`, ADR-0018 §3) y su plazo.
 */
export const runWorkerChild: RunChild = (child, args, env) =>
  runNodeScript({
    args,
    env,
    nodeFlags: WORKER_NODE_FLAGS,
    script: fileURLToPath(new URL(`../cli/${child}.js`, import.meta.url)),
    timeoutMs: CHILD_TIMEOUT_MS[child],
  });
