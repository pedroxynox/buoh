import { describe, expect, it } from 'vitest';

import {
  BATCH_PENDING_FRAMES_LIMIT,
  runBatchExchange,
  type BatchExchangeInput,
  type BatchExchangeRequest,
} from '../src/deriv/batch-client.js';
import { LogPersistenceError } from '../src/source-log/source-event-log.js';
import { uuid } from './support/connection-harness.js';
import { FakeDerivSocket, flush, ManualClock } from './support/deriv-fixtures.js';

// El cliente de los lotes (ADR-0021 §3, «Ritmo con Deriv»; precisión del PR 5c1 de su §9), sin red:
// un socket falso y un reloj manual. Los vectores salen de §3: una petición a la vez, por una sola
// conexión, a una cada 1,5 s como mucho; raw primero; y ante un límite de peticiones, para.

const START = '2026-11-26T10:00:00.000Z';

function proposal(reqId: number): BatchExchangeRequest {
  return { operation: 'proposal', reqId, text: JSON.stringify({ proposal: 1, req_id: reqId }) };
}

/** Una ejecución del cliente con el socket falso; `writes` anota lo que se escribió, en orden. */
function harness(
  options: {
    readonly closedFails?: boolean;
    readonly deadlineMs?: number;
    readonly frame?: (payload: string) => Promise<void>;
    readonly previousSentUtc?: string | null;
    readonly requests?: number;
  } = {},
) {
  const clock = new ManualClock(START);
  const writes: string[] = [];
  const sockets: FakeDerivSocket[] = [];
  let id = 0;
  const input: BatchExchangeInput = {
    closeTimeoutMs: 5_000,
    closed: (closure) => {
      if (options.closedFails === true) {
        return Promise.reject(new LogPersistenceError('source_event_index', 'source_lock_lost'));
      }
      writes.push(`closed:${closure.closure_type}:${closure.reason}`);
      return Promise.resolve();
    },
    connect: (socket) => {
      const created = new FakeDerivSocket(socket);
      sockets.push(created);
      return created;
    },
    connectTimeoutMs: 10_000,
    deadlineUtc: new Date(Date.parse(START) + (options.deadlineMs ?? 60_000)).toISOString(),
    endpoint: 'wss://deriv.invalid/ws',
    frame: async (frame) => {
      await options.frame?.(frame.payload_utf8);
      writes.push(`frame:${frame.payload_utf8}`);
    },
    nextId: () => uuid((id += 1)),
    now: clock.now,
    opened: (opened) => {
      writes.push(`opened:${opened.connection_id}`);
      return Promise.resolve();
    },
    pacingMs: 1_500,
    previousSentUtc: options.previousSentUtc ?? null,
    requestTimeoutMs: 15_000,
    requests: Array.from({ length: options.requests ?? 3 }, (_, index) => proposal(index + 1)),
    scheduler: clock.scheduler,
  };
  const result = runBatchExchange(input);
  const socket = (): FakeDerivSocket => {
    const [first] = sockets;
    if (first === undefined) {
      throw new TypeError('Sin socket.');
    }
    return first;
  };
  const sent = () =>
    socket()
      .requests()
      .map((request) => request['req_id']);
  const answer = async (reqId: number, extra: Record<string, unknown> = {}) => {
    socket().text(JSON.stringify({ msg_type: 'proposal', req_id: reqId, ...extra }));
    await flush();
  };
  return { answer, clock, result, sent, socket, writes };
}

describe('runBatchExchange: una petición a la vez, al ritmo de Deriv', () => {
  it('escribe la apertura, cada respuesta antes de contarla y el cierre, y espera 1,5 s entre envíos', async () => {
    const run = harness();
    run.socket().open();
    await flush();
    expect(run.sent()).toEqual([1]);
    await run.answer(1);
    // La respuesta llegó, pero el ritmo manda: la segunda espera a que pasen 1,5 s del primer envío.
    expect(run.sent()).toEqual([1]);
    await run.clock.advance(1_499);
    expect(run.sent()).toEqual([1]);
    await run.clock.advance(1);
    expect(run.sent()).toEqual([1, 2]);
    // Si la respuesta tarda más que el ritmo, la siguiente sale en cuanto llega.
    await run.clock.advance(4_000);
    await run.answer(2);
    expect(run.sent()).toEqual([1, 2, 3]);
    await run.answer(3);
    await expect(run.result).resolves.toEqual({
      answered: 3,
      connection_id: uuid(1),
      last_sent_utc: '2026-11-26T10:00:05.500Z',
      rate_limited: false,
      sent: 3,
      stopped: null,
      write_failure: null,
    });
    expect(run.writes).toEqual([
      `opened:${uuid(1)}`,
      'frame:{"msg_type":"proposal","req_id":1}',
      'frame:{"msg_type":"proposal","req_id":2}',
      'frame:{"msg_type":"proposal","req_id":3}',
      'closed:requested:batch_completed',
    ]);
    expect(run.socket().ended).toBe('close');
  });

  it('el ritmo cuenta desde el último envío de otra conexión de la misma ejecución', async () => {
    const run = harness({ previousSentUtc: '2026-11-26T09:59:59.500Z', requests: 1 });
    run.socket().open();
    await flush();
    expect(run.sent()).toEqual([]);
    await run.clock.advance(1_000);
    expect(run.sent()).toEqual([1]);
    await run.answer(1);
    await expect(run.result).resolves.toMatchObject({ answered: 1, stopped: null });
  });

  it('raw primero: una respuesta solo cuenta cuando su frame es durable', async () => {
    let release: (() => void) | null = null;
    const run = harness({
      frame: (payload) =>
        payload.includes('"req_id":1')
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
      requests: 2,
    });
    run.socket().open();
    await flush();
    await run.answer(1);
    await run.clock.advance(5_000);
    expect(run.sent()).toEqual([1]);
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    await flush();
    expect(run.sent()).toEqual([1, 2]);
    await run.answer(2);
    await expect(run.result).resolves.toMatchObject({ answered: 2, stopped: null });
  });

  it('un frame sin req_id, o de otra petición, se escribe y no cuenta como respuesta', async () => {
    const run = harness({ requests: 1 });
    run.socket().open();
    await flush();
    run.socket().text('{"msg_type":"tick"}');
    await flush();
    await run.answer(7);
    expect(run.writes).toContain('frame:{"msg_type":"tick"}');
    expect(run.writes).toContain('frame:{"msg_type":"proposal","req_id":7}');
    await run.answer(1);
    await expect(run.result).resolves.toMatchObject({ answered: 1, sent: 1, stopped: null });
  });
});

describe('runBatchExchange: lo que la para, sin fallar', () => {
  it('RateLimit: escribe la respuesta, no la cuenta y no pide nada más; cierra como pedido', async () => {
    const run = harness();
    run.socket().open();
    await flush();
    await run.answer(1);
    await run.clock.advance(1_500);
    await run.answer(2, { error: { code: 'RateLimit', message: 'Demasiadas peticiones' } });
    await expect(run.result).resolves.toEqual({
      answered: 1,
      connection_id: uuid(1),
      last_sent_utc: '2026-11-26T10:00:01.500Z',
      rate_limited: true,
      sent: 2,
      stopped: { detail: 'proposal', reason: 'rate_limit' },
      write_failure: null,
    });
    expect(run.sent()).toEqual([1, 2]);
    expect(run.writes.at(-2)).toContain('RateLimit');
    expect(run.writes.at(-1)).toBe('closed:requested:rate_limit');
    expect(run.socket().ended).toBe('close');
  });

  it('otro error de Deriv es una respuesta más', async () => {
    const run = harness({ requests: 2 });
    run.socket().open();
    await flush();
    await run.answer(1, { error: { code: 'ContractBuyValidationError', message: 'No' } });
    await run.clock.advance(1_500);
    await run.answer(2);
    await expect(run.result).resolves.toMatchObject({ answered: 2, stopped: null });
  });

  it('sin respuesta en 15 s: request_timeout, y la conexión se corta con el cierre timeout', async () => {
    const run = harness();
    run.socket().open();
    await flush();
    await run.clock.advance(14_999);
    expect(run.writes).toEqual([`opened:${uuid(1)}`]);
    await run.clock.advance(1);
    await expect(run.result).resolves.toMatchObject({
      answered: 0,
      sent: 1,
      stopped: { detail: 'proposal', reason: 'request_timeout' },
    });
    expect(run.writes.at(-1)).toBe('closed:timeout:request_timeout');
    expect(run.socket().ended).toBe('terminate');
  });

  it('el plazo de la ejecución se mira antes de cada envío', async () => {
    const run = harness({ deadlineMs: 1_000 });
    run.socket().open();
    await flush();
    await run.answer(1);
    await run.clock.advance(1_500);
    await expect(run.result).resolves.toMatchObject({
      answered: 1,
      sent: 1,
      stopped: { detail: null, reason: 'deadline' },
    });
    expect(run.writes.at(-1)).toBe('closed:requested:deadline');
  });

  it('un cierre de Deriv o de la red: disconnected, con el cierre remote o transport_error', async () => {
    for (const [code, closure] of [
      [1001, 'remote'],
      [1006, 'transport_error'],
    ] as const) {
      const run = harness();
      run.socket().open();
      await flush();
      run.socket().emit({ code, kind: 'closed' });
      await expect(run.result).resolves.toMatchObject({
        answered: 0,
        stopped: { detail: `close_code_${String(code)}`, reason: 'disconnected' },
      });
      expect(run.writes.at(-1)).toBe(`closed:${closure}:close_code_${String(code)}`);
      expect(run.socket().ended).toBeNull();
    }
  });

  it('un frame binario o demasiado grande corta la conexión', async () => {
    for (const [signal, reason] of [
      [{ kind: 'binary' }, 'binary_frame'],
      [{ kind: 'frame_too_large', observed_value: 2_000_000 }, 'frame_too_large'],
    ] as const) {
      const run = harness();
      run.socket().open();
      await flush();
      run.socket().emit(signal);
      await expect(run.result).resolves.toMatchObject({ stopped: { reason } });
      expect(run.writes.at(-1)).toBe(`closed:requested:${reason}`);
      expect(run.socket().ended).toBe('terminate');
    }
  });

  it('demasiados frames esperando a escribirse: queue_full, sin escribir el que no cabe', async () => {
    const waiting: (() => void)[] = [];
    const run = harness({
      frame: () =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
        }),
    });
    run.socket().open();
    await flush();
    for (let index = 0; index <= BATCH_PENDING_FRAMES_LIMIT; index += 1) {
      run.socket().text(`{"msg_type":"tick","n":${String(index)}}`);
    }
    await flush();
    expect(run.socket().ended).toBe('terminate');
    // El cierre espera a que se escriba lo que ya estaba en la cola, en orden.
    while (waiting.length > 0) {
      waiting.shift()?.();
      await flush();
    }
    await expect(run.result).resolves.toMatchObject({
      answered: 0,
      stopped: { detail: null, reason: 'queue_full' },
    });
    const frames = run.writes.filter((text) => text.startsWith('frame:'));
    expect(frames).toHaveLength(BATCH_PENDING_FRAMES_LIMIT);
    expect(frames.at(-1)).toContain(`"n":${String(BATCH_PENDING_FRAMES_LIMIT - 1)}`);
    expect(run.writes.at(-1)).toBe('closed:requested:queue_full');
  });
});

describe('runBatchExchange: lo respondido es lo durable', () => {
  it('una respuesta que se hace durable después de un corte cuenta: la ejecución siguiente no la vuelve a pedir', async () => {
    let release: (() => void) | null = null;
    const run = harness({
      frame: (payload) =>
        payload.includes('"req_id":1')
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
    });
    run.socket().open();
    await flush();
    await run.answer(1);
    run.socket().emit({ code: 1006, kind: 'closed' });
    await flush();
    (release as unknown as () => void)();
    await expect(run.result).resolves.toMatchObject({
      answered: 1,
      sent: 1,
      stopped: { detail: 'close_code_1006', reason: 'disconnected' },
      write_failure: null,
    });
  });

  it('un RateLimit que se hace durable después del plazo de la respuesta no cuenta, y lo dice rate_limited', async () => {
    let release: (() => void) | null = null;
    const run = harness({
      frame: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    run.socket().open();
    await flush();
    await run.answer(1, { error: { code: 'RateLimit', message: 'x' } });
    await run.clock.advance(15_000);
    (release as unknown as () => void)();
    await expect(run.result).resolves.toMatchObject({
      answered: 0,
      rate_limited: true,
      stopped: { reason: 'request_timeout' },
    });
  });
});

describe('runBatchExchange: un fallo al escribir o al conectar', () => {
  it('si un frame no se puede escribir, no escribe nada más, ni el cierre, y corta la conexión', async () => {
    const run = harness({
      frame: () => Promise.reject(Object.assign(new Error('secreto'), { code: 'XX01' })),
    });
    run.socket().open();
    await flush();
    await run.answer(1);
    await expect(run.result).resolves.toMatchObject({
      answered: 0,
      sent: 1,
      stopped: { detail: 'XX01', reason: 'persistence_failed' },
    });
    expect(run.writes).toEqual([`opened:${uuid(1)}`]);
    expect(run.socket().ended).toBe('terminate');
  });

  it('un fallo de LogPersistenceError da su etapa y su motivo, y no borra la parada anterior', async () => {
    const run = harness({ closedFails: true });
    run.socket().open();
    await flush();
    await run.answer(1);
    await run.clock.advance(1_500);
    await run.answer(2, { error: { code: 'RateLimit', message: 'x' } });
    await expect(run.result).resolves.toMatchObject({
      answered: 1,
      stopped: { detail: 'proposal', reason: 'rate_limit' },
      write_failure: 'source_event_index:source_lock_lost',
    });
  });

  it('una conexión que no se abre no escribe nada: connect_timeout o connect_failed', async () => {
    const late = harness();
    await late.clock.advance(10_000);
    await expect(late.result).resolves.toEqual({
      answered: 0,
      connection_id: null,
      last_sent_utc: null,
      rate_limited: false,
      sent: 0,
      stopped: { detail: null, reason: 'connect_timeout' },
      write_failure: null,
    });
    expect(late.writes).toEqual([]);
    const refused = harness();
    refused.socket().emit({ code: 1006, kind: 'closed' });
    await expect(refused.result).resolves.toMatchObject({
      connection_id: null,
      stopped: { detail: 'close_code_1006', reason: 'connect_failed' },
    });
    expect(refused.writes).toEqual([]);
  });
});
