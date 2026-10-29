import { createHash } from 'node:crypto';

import { strToU8, zipSync } from 'fflate';

import { type Scheduler } from '../../src/deriv/ports.js';
import {
  DERIV_OPERATIONS,
  schemaEntryName,
  type DerivOperation,
  type ExpectedSchemaArchive,
  type SchemaEntryName,
} from '../../src/deriv/schema-archive.js';
import { type DerivSocket, type SocketSignal } from '../../src/deriv/socket.js';

/**
 * Esquemas draft-04 sintéticos de buoh, con la forma que lee el adaptador. No son los de Deriv: su
 * repositorio no tiene licencia (ADR-0012 §2). Siguen las reglas que importan aquí: `req_id` entero,
 * respuestas que exigen `echo_req` y `msg_type`, y un `msg_type` de un solo valor por operación.
 */
const DRAFT_04 = 'http://json-schema.org/draft-04/schema#';

const reqId = { type: 'integer' };
const echoReq = { type: 'object' };

function request(
  field: string,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    $schema: DRAFT_04,
    additionalProperties: false,
    properties: { [field]: value, req_id: reqId, ...extra },
    required: [field],
    type: 'object',
  };
}

function response(msgType: string, fields: Record<string, unknown>) {
  return {
    $schema: DRAFT_04,
    properties: {
      ...fields,
      echo_req: echoReq,
      msg_type: { enum: [msgType], type: 'string' },
      req_id: reqId,
    },
    required: ['echo_req', 'msg_type'],
    type: 'object',
  };
}

const CATALOG_ENTRY_FIELDS = {
  exchange_is_open: { enum: [0, 1], type: 'integer' },
  is_trading_suspended: { enum: [0, 1], type: 'integer' },
  market: { type: 'string' },
  pip_size: { type: 'number' },
  subgroup: { type: 'string' },
  submarket: { type: 'string' },
  trade_count: { type: 'integer' },
  underlying_symbol: { type: 'string' },
  underlying_symbol_name: { type: 'string' },
  underlying_symbol_type: { type: 'string' },
};

const SCHEMAS: Record<DerivOperation, { request: unknown; response: unknown }> = {
  active_symbols: {
    request: request('active_symbols', { enum: ['brief', 'full'], type: 'string' }),
    response: response('active_symbols', {
      active_symbols: {
        items: {
          additionalProperties: false,
          properties: CATALOG_ENTRY_FIELDS,
          required: Object.keys(CATALOG_ENTRY_FIELDS),
          type: 'object',
        },
        type: 'array',
      },
    }),
  },
  forget: {
    request: request('forget', { type: 'string' }),
    response: response('forget', { forget: { enum: [0, 1], type: 'integer' } }),
  },
  forget_all: {
    request: request('forget_all', { enum: ['candles', 'ticks'], type: 'string' }),
    response: response('forget_all', { forget_all: { type: 'array' } }),
  },
  ping: {
    request: request('ping', { enum: [1], type: 'integer' }),
    response: response('ping', { ping: { enum: ['pong'], type: 'string' } }),
  },
  ticks: {
    request: request(
      'ticks',
      { pattern: '^\\w{2,30}$', type: 'string' },
      { subscribe: { enum: [1], type: 'integer' } },
    ),
    response: response('tick', {
      subscription: {
        additionalProperties: false,
        properties: { id: { type: 'string' } },
        required: ['id'],
        type: 'object',
      },
      tick: {
        additionalProperties: false,
        properties: {
          epoch: { type: 'integer' },
          id: { type: 'string' },
          pip_size: { type: 'number' },
          quote: { type: 'number' },
          symbol: { type: 'string' },
        },
        required: ['pip_size'],
        type: 'object',
      },
    }),
  },
  // Con la forma de la petición real (ADR-0015, contexto): `end` es texto (`latest` o un epoch en
  // segundos) y `start`, un entero.
  ticks_history: {
    request: {
      ...request(
        'ticks_history',
        { type: 'string' },
        {
          count: { type: 'integer' },
          end: { pattern: '^(latest|[0-9]{1,10})$', type: 'string' },
          start: { maximum: 9_999_999_999, minimum: 0, type: 'integer' },
          style: { enum: ['candles', 'ticks'], type: 'string' },
        },
      ),
      required: ['end', 'ticks_history'],
    },
    response: response('history', {
      history: {
        properties: {
          prices: { items: { type: 'number' }, type: 'array' },
          times: { items: { type: 'integer' }, type: 'array' },
        },
        type: 'object',
      },
      pip_size: { type: 'number' },
    }),
  },
  time: {
    request: request('time', { enum: [1], type: 'integer' }),
    response: response('time', { time: { type: 'integer' } }),
  },
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * `schemas.zip` sintético con las 14 entradas, y lo que se espera de él. `overrides` cambia el
 * esquema de algunas entradas, para probar una release que rechaza algo.
 */
export function syntheticSchemaArchive(
  overrides: Readonly<Partial<Record<SchemaEntryName, unknown>>> = {},
): {
  readonly archive: Uint8Array;
  readonly entries: Readonly<Record<SchemaEntryName, Uint8Array>>;
  readonly expected: ExpectedSchemaArchive;
} {
  const entries = {} as Record<SchemaEntryName, Uint8Array>;
  for (const operation of DERIV_OPERATIONS) {
    for (const kind of ['request', 'response'] as const) {
      const name = schemaEntryName(operation, kind);
      entries[name] = strToU8(JSON.stringify(overrides[name] ?? SCHEMAS[operation][kind]));
    }
  }
  const archive = zipSync(entries, { level: 9, mtime: new Date('2026-01-01T00:00:00.000Z') });
  return {
    archive,
    entries,
    expected: {
      archive_sha256: sha256(archive),
      entries_sha256: Object.fromEntries(
        Object.entries(entries).map(([name, bytes]) => [name, sha256(bytes)]),
      ) as Record<SchemaEntryName, string>,
      release: 'synthetic-deriv-1',
    },
  };
}

/** Entrada sintética del catálogo, con los diez campos de la respuesta. */
export function catalogEntry(symbol: string, name: string, tradeCount = 7) {
  return {
    exchange_is_open: 1,
    is_trading_suspended: 0,
    market: 'synthetic_index',
    pip_size: 0.01,
    subgroup: 'synthetics',
    submarket: 'random_index',
    trade_count: tradeCount,
    underlying_symbol: symbol,
    underlying_symbol_name: name,
    underlying_symbol_type: 'stockindex',
  };
}

export const SYNTH_100 = catalogEntry('SYNTH_100', 'Synthetic 100 Index');
export const SYNTH_50 = catalogEntry('SYNTH_50', 'Synthetic 50 Index');

/** Eco de una petición `ticks_history`: solo los campos que no cambian de una página a otra. */
function historyEcho(id: number) {
  return { count: 1000, req_id: id, style: 'ticks', ticks_history: 'SYNTH_100' };
}

/** Mensajes sintéticos con la forma de las respuestas de Deriv. Ningún valor es de mercado real. */
export const derivMessages = {
  catalog: (id: number, entries: readonly unknown[] = [SYNTH_100, SYNTH_50]) =>
    JSON.stringify({
      active_symbols: entries,
      echo_req: { active_symbols: 'brief', req_id: id },
      msg_type: 'active_symbols',
      req_id: id,
    }),
  error: (id: number, msgType: string, echo: Record<string, unknown>) =>
    JSON.stringify({
      echo_req: { ...echo, req_id: id },
      error: { code: 'SyntheticError', message: 'sintético' },
      msg_type: msgType,
      req_id: id,
    }),
  forgetAll: (id: number) =>
    JSON.stringify({
      echo_req: { forget_all: 'ticks', req_id: id },
      forget_all: ['sub-1'],
      msg_type: 'forget_all',
      req_id: id,
    }),
  /**
   * Página de `ticks_history` con `style: ticks`. Los precios van como lexemas, igual que `quote` en
   * `tick`, para que conserven sus decimales, y un `pipSize` en texto también: `'2.0'`, como lo manda
   * el canal real en la historia.
   */
  history: (
    id: number,
    times: readonly number[],
    prices: readonly string[],
    pipSize: number | string = 2,
  ) =>
    `{"echo_req":${JSON.stringify(historyEcho(id))},"history":{"prices":[${prices.join(',')}],"times":[${times.map(String).join(',')}]},"msg_type":"history","pip_size":${String(pipSize)},"req_id":${String(id)}}`,
  /** Petición de historia rechazada: `msg_type` `ticks_history` con un objeto `error`. */
  historyError: (id: number, code: string) =>
    JSON.stringify({
      echo_req: historyEcho(id),
      error: { code, message: 'sintético' },
      msg_type: 'ticks_history',
      req_id: id,
    }),
  ping: (id: number) =>
    JSON.stringify({
      echo_req: { ping: 1, req_id: id },
      msg_type: 'ping',
      ping: 'pong',
      req_id: id,
    }),
  tick: (id: number, epoch: number, quote = '100.25', symbol = 'SYNTH_100') =>
    `{"echo_req":{"req_id":${String(id)},"subscribe":1,"ticks":"${symbol}"},"msg_type":"tick","req_id":${String(id)},"subscription":{"id":"sub-1"},"tick":{"epoch":${String(epoch)},"id":"sub-1","pip_size":2,"quote":${quote},"symbol":"${symbol}"}}`,
  time: (id: number, epoch: number) =>
    JSON.stringify({
      echo_req: { req_id: id, time: 1 },
      msg_type: 'time',
      req_id: id,
      time: epoch,
    }),
};

/** Deja correr el trabajo asíncrono pendiente (los almacenes en memoria responden enseguida). */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Reloj y temporizador manuales: el tiempo solo avanza con `advance`. */
export class ManualClock {
  #now: number;
  /** Lo que el reloj de pared se apartó del tiempo transcurrido con `jumpWallClock`. */
  #wallOffset = 0;
  #sequence = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  constructor(startUtc: string) {
    this.#now = Date.parse(startUtc);
  }

  readonly now = (): string => new Date(this.#now + this.#wallOffset).toISOString();

  /**
   * Salta el reloj de pared `ms` (negativo: hacia atrás), como un ajuste de NTP. Los temporizadores
   * no cambian: como `setTimeout`, cuentan el tiempo transcurrido.
   */
  jumpWallClock(ms: number): void {
    this.#wallOffset += ms;
  }

  readonly scheduler: Scheduler = {
    schedule: (ms, callback) => {
      this.#sequence += 1;
      const id = this.#sequence;
      this.#timers.set(id, { at: this.#now + ms, callback });
      return () => {
        this.#timers.delete(id);
      };
    },
  };

  /** Plazos de los temporizadores pendientes, en ms desde ahora, en orden. */
  pendingDelays(): number[] {
    return [...this.#timers.values()].map((timer) => timer.at - this.#now).sort((a, b) => a - b);
  }

  /** Avanza `ms`, ejecutando en orden cada temporizador vencido, y deja correr lo asíncrono. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const [next] = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId);
      if (next === undefined) {
        break;
      }
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.callback();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

/**
 * Socket falso: la prueba emite lo que «llega» y lee lo enviado. Por defecto, `close` y `terminate`
 * avisan del cierre enseguida. Con `deferClose`, el aviso espera a `finishClose`, como en `ws`, que
 * lo da más tarde.
 */
export class FakeDerivSocket implements DerivSocket {
  readonly sent: string[] = [];
  ended: 'close' | 'terminate' | null = null;
  readonly url: string;
  readonly #deferClose: boolean;
  readonly #onSignal: (signal: SocketSignal) => void;

  constructor(input: {
    readonly deferClose?: boolean;
    readonly onSignal: (signal: SocketSignal) => void;
    readonly url: string;
  }) {
    this.#deferClose = input.deferClose ?? false;
    this.#onSignal = input.onSignal;
    this.url = input.url;
  }

  /** Con `deferClose`: entrega el aviso de cierre pendiente. */
  finishClose(): void {
    if (this.ended === null) {
      throw new TypeError('El adaptador no cerró el socket.');
    }
    this.emit({ code: this.ended === 'close' ? 1000 : 1006, kind: 'closed' });
  }

  emit(signal: SocketSignal): void {
    this.#onSignal(signal);
  }

  open(): void {
    this.emit({ kind: 'open' });
  }

  text(payload: string): void {
    this.emit({ byte_length: Buffer.byteLength(payload, 'utf8'), kind: 'text', text: payload });
  }

  /** Peticiones enviadas, ya leídas como JSON. */
  requests(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  close(): void {
    this.ended ??= 'close';
    if (!this.#deferClose) {
      this.emit({ code: 1000, kind: 'closed' });
    }
  }

  send(text: string): void {
    this.sent.push(text);
  }

  terminate(): void {
    this.ended ??= 'terminate';
    if (!this.#deferClose) {
      this.emit({ code: 1006, kind: 'closed' });
    }
  }
}
