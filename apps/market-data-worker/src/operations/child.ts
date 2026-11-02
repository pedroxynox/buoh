import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WORKER_NODE_FLAGS } from '../node-flags.js';

/**
 * Los comandos que `buoh-operaciones` corre en un proceso aparte (ADR-0018 §11): `data:health` y
 * `db:migrate` del worker, y `db:migrate` de la API (`api_migrate`, ADR-0019 §7).
 */
export type WorkerChild = 'api_migrate' | 'health' | 'migrate';

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
 * `HEALTH_CLOSE_DEADLINE_MS`); los dos `db:migrate` aplican migraciones que solo añaden.
 */
export const CHILD_TIMEOUT_MS: Readonly<Record<WorkerChild, number>> = {
  api_migrate: 120_000,
  health: 60_000,
  migrate: 120_000,
};

/**
 * El script de cada comando: los del worker en su `dist/cli/`, y el de la API en `apps/api/dist/cli/`,
 * que `buoh-operaciones` compila desde el PR 6 de ADR-0019 §14.
 */
const CHILD_SCRIPTS: Readonly<Record<WorkerChild, URL>> = {
  api_migrate: new URL('../../../api/dist/cli/migrate.js', import.meta.url),
  health: new URL('../cli/health.js', import.meta.url),
  migrate: new URL('../cli/migrate.js', import.meta.url),
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
 * Cómo corre `runWorkerChild` un comando: `data:health` (`dist/cli/health.js`), `db:migrate`
 * (`dist/cli/migrate.js`) o el `db:migrate` de la API (`apps/api/dist/cli/migrate.js`), con los
 * tamaños de V8 de los procesos del worker (`WORKER_NODE_FLAGS`, ADR-0018 §3), su plazo, sus
 * argumentos y el entorno dado.
 */
export function workerChildScript(
  child: WorkerChild,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Parameters<typeof runNodeScript>[0] {
  return {
    args,
    env,
    nodeFlags: WORKER_NODE_FLAGS,
    script: fileURLToPath(CHILD_SCRIPTS[child]),
    timeoutMs: CHILD_TIMEOUT_MS[child],
  };
}

/** Un comando de `WorkerChild` en un proceso aparte (`workerChildScript`). */
export const runWorkerChild: RunChild = (child, args, env) =>
  runNodeScript(workerChildScript(child, args, env));
