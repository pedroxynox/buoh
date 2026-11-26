import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WORKER_NODE_FLAGS } from '../node-flags.js';

/**
 * Los comandos que `buoh-operaciones` corre en un proceso aparte (ADR-0018 §11): `data:health` y
 * `db:migrate` del worker, `db:migrate` de la API (`api_migrate`, ADR-0019 §7) y, desde el PR 4
 * de ADR-0020 §13, las migraciones de `buoh_datasets` (`datasets_migrate`), `datasets:publish`
 * (`publish`) y `data:replay` (`replay`), y, desde el PR 5c2 de ADR-0021 §9, `batch`.
 */
export type WorkerChild =
  'api_migrate' | 'batch' | 'datasets_migrate' | 'health' | 'migrate' | 'publish' | 'replay';

/** Cómo terminó un proceso: su código, su salida y si se cortó por su plazo. */
export interface ChildResult {
  /** El código de salida, o `null` si lo terminó una señal. */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  /**
   * Con `reportMemory`, la memoria residente máxima del proceso, en bytes, como la escribió al
   * salir (`MEMORY_REPORT_MODULE`), o `null` si no llegó a escribirla, como uno cortado con
   * `SIGKILL`. Sin `reportMemory`, no está.
   */
  readonly maxRssBytes?: number | null;
}

/**
 * Corre un comando del worker con esos argumentos y ese entorno, y nada más. Con `timeoutMs`, su
 * plazo es el menor entre ese y el suyo (`CHILD_TIMEOUT_MS`).
 */
export type RunChild = (
  child: WorkerChild,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  options?: { readonly timeoutMs?: number },
) => Promise<ChildResult>;

/**
 * El plazo de cada proceso. `data:health` responde en unos 35 s como mucho (`HEALTH_DEADLINE_MS` y
 * `HEALTH_CLOSE_DEADLINE_MS`); los `db:migrate` aplican migraciones que solo añaden. La publicación
 * y la verificación tienen 60 s cada paso (ADR-0020 §8). `batch` no envía ni conecta después de
 * `BATCH_DEADLINE_MS` (70 s), y la última petición espera su respuesta 15 s y su cierre 5 s.
 */
export const CHILD_TIMEOUT_MS: Readonly<Record<WorkerChild, number>> = {
  api_migrate: 120_000,
  batch: 120_000,
  datasets_migrate: 120_000,
  health: 60_000,
  migrate: 120_000,
  publish: 60_000,
  replay: 60_000,
};

/**
 * El script de cada comando: los del worker en su `dist/cli/`, y el de la API en `apps/api/dist/cli/`,
 * que `buoh-operaciones` compila desde el PR 6 de ADR-0019 §14.
 */
const CHILD_SCRIPTS: Readonly<Record<WorkerChild, URL>> = {
  api_migrate: new URL('../../../api/dist/cli/migrate.js', import.meta.url),
  batch: new URL('../cli/batch.js', import.meta.url),
  datasets_migrate: new URL('../cli/migrate-datasets.js', import.meta.url),
  health: new URL('../cli/health.js', import.meta.url),
  migrate: new URL('../cli/migrate.js', import.meta.url),
  publish: new URL('../cli/publish-dataset.js', import.meta.url),
  replay: new URL('../cli/replay.js', import.meta.url),
};

/** Lo que se guarda, como mucho, de stdout y de stderr de un proceso. */
export const CHILD_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/** El descriptor por el que un proceso con `reportMemory` escribe su memoria al salir. */
const MEMORY_FD = 3;

/** Lo que se guarda, como mucho, de lo que llega por `MEMORY_FD`: una línea JSON corta. */
const MEMORY_OUTPUT_LIMIT_BYTES = 4096;

/**
 * El módulo que `runNodeScript` carga con `--import` en un proceso con `reportMemory`. Al salir,
 * también con `process.exit` o con un error que llega a salir, escribe por el descriptor 3 una línea
 * JSON con su memoria residente máxima en bytes: el `VmHWM` de `/proc/self/status`, que va en kB.
 * No usa `process.resourceUsage().maxRSS`, porque en Linux el de un proceso lanzado arrastra la
 * memoria residente que tenía su padre al lanzarlo, y el `VmHWM` es solo la suya desde que arrancó.
 * Solo escribe si ese descriptor es una tubería o un socket, como el que abre `runNodeScript`: en un
 * proceso de Node sin él, el descriptor 3 puede ser uno interno. Nunca toca stdout ni stderr, que
 * interpreta `buoh-operaciones`. No llega a escribirla un proceso cortado con `SIGKILL` o con
 * `SIGTERM`, ni uno que aborta al agotar su heap de V8, ni uno sin `/proc`. Es una URL `data:` para
 * que el módulo no dependa de dónde está compilado.
 */
export const MEMORY_REPORT_MODULE = `data:text/javascript,${encodeURIComponent(String.raw`import { fstatSync, readFileSync, writeSync } from "node:fs";
process.on("exit", () => {
  try {
    const target = fstatSync(${String(MEMORY_FD)});
    if (!target.isSocket() && !target.isFIFO()) {
      return;
    }
    const peak = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync("/proc/self/status", "utf8"));
    if (peak !== null) {
      writeSync(${String(MEMORY_FD)}, JSON.stringify({ max_rss_bytes: Number(peak[1]) * 1024 }) + "\n");
    }
  } catch {}
});`)}`;

/**
 * La memoria de lo que llegó por `MEMORY_FD`: el `max_rss_bytes` de su última línea, si es un entero
 * positivo, o `null` si esa línea no es una de las que escribe `MEMORY_REPORT_MODULE`.
 */
export function memoryReportOf(text: string): number | null {
  const line = text.trim().split('\n').at(-1) ?? '';
  try {
    const value: unknown = JSON.parse(line);
    const bytes =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)['max_rss_bytes']
        : undefined;
    return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * La memoria residente máxima de este proceso hasta ahora, en bytes: la del proceso principal de
 * `buoh-operaciones` en su paso `memory`. `process.resourceUsage().maxRSS` va en KiB.
 */
export function ownMaxRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

/**
 * Corre `script` con Node, con `nodeFlags` delante, sus argumentos y exactamente `env`: el proceso
 * no hereda el entorno de quien lo lanza. Guarda stdout y stderr, cada uno hasta
 * `CHILD_OUTPUT_LIMIT_BYTES`, y si no termina en `timeoutMs` lo corta con `SIGKILL`. Con
 * `reportMemory`, carga `MEMORY_REPORT_MODULE` y da la memoria residente máxima del proceso
 * (`maxRssBytes`). Se rechaza si Node no arranca, con el error de Node, también cuando no puede
 * lanzarlo por falta de descriptores (`EMFILE` o `ENFILE`), sin dejar un error sin escuchar.
 */
export function runNodeScript(input: {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly nodeFlags: readonly string[];
  readonly reportMemory?: boolean;
  readonly script: string;
  readonly timeoutMs: number;
}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const reportMemory = input.reportMemory === true;
    const memoryFlags = reportMemory ? ['--import', MEMORY_REPORT_MODULE] : [];
    const child = spawn(
      process.execPath,
      [...input.nodeFlags, ...memoryFlags, input.script, ...input.args],
      {
        env: { ...input.env },
        stdio: reportMemory ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    // Antes de tocar sus tuberías: si Node no pudo lanzarlo, como con `EMFILE` o `ENFILE`, el
    // proceso no tiene `stdio` y el error llega después, en el `nextTick`. Sin este oyente, ese
    // error terminaría `buoh-operaciones` entero, sin el paso `memory`.
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const collect = (limit: number) => {
      const chunks: Buffer[] = [];
      let size = 0;
      return {
        add: (chunk: Buffer) => {
          if (size < limit) {
            chunks.push(chunk.subarray(0, limit - size));
            size += chunk.length;
          }
        },
        text: () => Buffer.concat(chunks).toString('utf8'),
      };
    };
    const stdout = collect(CHILD_OUTPUT_LIMIT_BYTES);
    const stderr = collect(CHILD_OUTPUT_LIMIT_BYTES);
    const memory = collect(MEMORY_OUTPUT_LIMIT_BYTES);
    child.stdout?.on('data', stdout.add);
    child.stderr?.on('data', stderr.add);
    // `stdio` no existe en un proceso que Node no pudo lanzar (ver el oyente de `error`).
    (child.stdio as ChildProcess['stdio'] | undefined)?.[MEMORY_FD]?.on('data', memory.add);
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { exitCode: code, stderr: stderr.text(), stdout: stdout.text(), timedOut };
      resolve(reportMemory ? { ...result, maxRssBytes: memoryReportOf(memory.text()) } : result);
    });
  });
}

/**
 * Cómo corre `runWorkerChild` un comando: `data:health` (`dist/cli/health.js`), `db:migrate`
 * (`dist/cli/migrate.js`) o el `db:migrate` de la API (`apps/api/dist/cli/migrate.js`), con los
 * tamaños de V8 de los procesos del worker (`WORKER_NODE_FLAGS`, ADR-0018 §3), su plazo, sus
 * argumentos, el entorno dado y su memoria residente máxima (`reportMemory`; precisión del PR 9 de
 * ADR-0018 §13).
 */
export function workerChildScript(
  child: WorkerChild,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  options: { readonly timeoutMs?: number } = {},
): Parameters<typeof runNodeScript>[0] {
  const own = CHILD_TIMEOUT_MS[child];
  return {
    args,
    env,
    nodeFlags: WORKER_NODE_FLAGS,
    reportMemory: true,
    script: fileURLToPath(CHILD_SCRIPTS[child]),
    timeoutMs: Math.max(1, Math.min(own, options.timeoutMs ?? own)),
  };
}

/** Un comando de `WorkerChild` en un proceso aparte (`workerChildScript`). */
export const runWorkerChild: RunChild = (child, args, env, options) =>
  runNodeScript(workerChildScript(child, args, env, options));
