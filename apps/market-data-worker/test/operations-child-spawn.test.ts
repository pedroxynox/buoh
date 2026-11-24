import { ChildProcess } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Lo que hace Node 24 cuando no puede lanzar un proceso por falta de descriptores (`EMFILE` o
 * `ENFILE`): `spawn` devuelve un `ChildProcess` sin `stdio`, `stdout` ni `stderr`, y emite `error`
 * después, en el `nextTick`. Se comprobó el 2026-11-24 con Node 24.22.0, agotando los descriptores
 * con `ulimit -n 256`: el código anterior fallaba al leer `child.stdio[3]` y el `error`, sin oyente,
 * terminaba el proceso (menor 8 de la revisión del PR #121).
 */
const spawnFailure = vi.hoisted(() => ({ code: null as string | null }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const code = spawnFailure.code;
      if (code === null) {
        return original.spawn(...args);
      }
      const child = new original.ChildProcess();
      process.nextTick(() => {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${args[0]} ${code}`), {
            code,
            errno: code === 'EMFILE' ? -24 : -23,
            syscall: 'spawn',
          }),
        );
      });
      return child;
    },
  };
});

const { runNodeScript } = await import('../src/operations/child.js');

afterEach(() => {
  spawnFailure.code = null;
  vi.useRealTimers();
});

describe('runNodeScript cuando Node no puede lanzar el proceso (menor 8 del PR #121)', () => {
  it.each([
    ['EMFILE', true],
    ['EMFILE', false],
    ['ENFILE', true],
  ] as const)(
    'con %s y reportMemory %s, se rechaza con el error de Node, sin un error sin escuchar ni el plazo pendiente',
    async (code, reportMemory) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      spawnFailure.code = code;
      const launched = runNodeScript({
        args: [],
        env: {},
        nodeFlags: [],
        reportMemory,
        script: '/no/importa.mjs',
        timeoutMs: 30_000,
      });
      await expect(launched).rejects.toMatchObject({ code, syscall: 'spawn' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('el proceso falso es el de Node: sin stdio', () => {
    expect(new ChildProcess().stdio).toBeUndefined();
  });
});
