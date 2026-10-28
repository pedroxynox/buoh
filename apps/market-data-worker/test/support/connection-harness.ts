import { type SourceEvent } from '@buoh/contracts';
import {
  createCatalogResponseSchema,
  type InvalidFrameReason,
  type UnflaggedTick,
} from '@buoh/domain';

import { DerivConnection } from '../../src/deriv/connection.js';
import {
  createDerivMeasurementProfile,
  DERIV_PUBLIC_ENDPOINT,
  DERIV_SOURCE,
} from '../../src/deriv/profile.js';
import {
  openSchemaArchive,
  type DerivSchemaSet,
  type SchemaEntryName,
} from '../../src/deriv/schema-archive.js';
import { RawFirstIngestor } from '../../src/ingestion/raw-first-ingestor.js';
import { OperationalRegistry, type OperationalAlert } from '../../src/operational/registry.js';
import { SourceEventLog } from '../../src/source-log/source-event-log.js';
import {
  derivMessages,
  FakeDerivSocket,
  flush,
  ManualClock,
  syntheticSchemaArchive,
} from './deriv-fixtures.js';
import {
  MemoryCatalogStore,
  MemoryObjectStore,
  MemoryOperationalStore,
  MemoryRequestedResponseIncidentStore,
  MemorySourceLogStore,
} from './memory-stores.js';

/** Hora de inicio del reloj manual por defecto. */
export const START = '2026-03-02T10:00:00.000Z';
export const START_EPOCH = Date.parse(START) / 1000;

/** UUIDv7 secuencial: los IDs de una prueba salen en orden desde 1. */
export function uuid(sequence: number): string {
  return `019b76da-a800-7000-8000-${sequence.toString().padStart(12, '0')}`;
}

/** Varias vueltas del bucle: cada frame pasa por la cola, el log y su interpretación. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flush();
  }
}

let openedSchemas: DerivSchemaSet | null = null;

function openSynthetic(
  overrides: Readonly<Partial<Record<SchemaEntryName, unknown>>> = {},
): DerivSchemaSet {
  const fixture = syntheticSchemaArchive(overrides);
  const result = openSchemaArchive(fixture.archive, fixture.expected);
  if (result.status !== 'loaded') {
    throw new TypeError(`Esquemas sintéticos inválidos: ${result.reason}`);
  }
  return result.schemas;
}

/**
 * El conjunto de esquemas sintético ya abierto. Se arma y se abre una vez por archivo de pruebas:
 * comprimir y abrir el archivo es lo más lento de cada prueba, y el conjunto no cambia.
 */
export function syntheticSchemas(): DerivSchemaSet {
  openedSchemas ??= openSynthetic();
  return openedSchemas;
}

/** Socket falso cuyo servidor responde enseguida cada `ping` del keepalive. */
export class PongingSocket extends FakeDerivSocket {
  override send(text: string): void {
    super.send(text);
    const body = JSON.parse(text) as { readonly ping?: unknown; readonly req_id?: unknown };
    const reqId = body.req_id;
    if (body.ping !== undefined && typeof reqId === 'number') {
      queueMicrotask(() => {
        this.text(derivMessages.ping(reqId));
      });
    }
  }
}

export interface ConnectionHarnessOptions {
  /** El servidor responde enseguida cada `ping`: para pruebas que pasan de 45 000 ms. */
  readonly answerPings?: boolean;
  /** El socket falso avisa del cierre solo con `finishClose`, como `ws`. */
  readonly deferClose?: boolean;
  /**
   * Tiempo de escucha hasta `forget_all`; por defecto, 600 000 ms, fuera de las pruebas. Con `null`,
   * la conexión no lo tiene, como en la sesión: nunca pide el cierre previsto por su cuenta.
   */
  readonly durationMs?: number | null;
  /** Source events que el log ya tiene, de ejecuciones anteriores; por defecto, ninguno. */
  readonly events?: readonly SourceEvent[];
  /** Esquemas que cambian en el archivo sintético (`syntheticSchemaArchive`); por defecto, ninguno. */
  readonly schemaOverrides?: Readonly<Partial<Record<SchemaEntryName, unknown>>>;
  /** Conexión anterior que supera el `ConnectionOpened`; por defecto, `null`. */
  readonly supersedes?: string | null;
}

/**
 * Una `DerivConnection` armada sin el adaptador, sobre el símbolo `SYNTH_100`: almacenes en memoria,
 * reloj y temporizador manuales, socket falso, IDs secuenciales desde 1, esquemas sintéticos y el
 * perfil de medición. La conexión ya corre; su socket se abre con `socket().open()`.
 */
export async function connectionHarness(options: ConnectionHarnessOptions = {}) {
  const clock = new ManualClock(START);
  let sequence = 0;
  const nextId = () => uuid((sequence += 1));
  const objects = new MemoryObjectStore();
  const sourceLog = new MemorySourceLogStore();
  const operational = new MemoryOperationalStore();
  const requested = new MemoryRequestedResponseIncidentStore();
  const alerts: Parameters<OperationalAlert>[0][] = [];
  const ticks: UnflaggedTick[] = [];
  const invalid: { observation_id: string; reason: InvalidFrameReason }[] = [];
  const nonTick: { msg_type: string; observation_id: string }[] = [];
  const sockets: FakeDerivSocket[] = [];
  const schemas =
    options.schemaOverrides === undefined
      ? syntheticSchemas()
      : openSynthetic(options.schemaOverrides);
  const symbol = 'SYNTH_100';
  const profile = createDerivMeasurementProfile({ schemas, symbol });
  const openLog = () =>
    SourceEventLog.open({ objects, source: DERIV_SOURCE, store: sourceLog, zlibVersion: 'test' });
  const log = await openLog();
  for (const event of options.events ?? []) {
    await log.append(event);
  }
  const registry = await OperationalRegistry.open({
    alert: (payload) => alerts.push(payload),
    source: DERIV_SOURCE,
    store: operational,
  });
  const ingestor = new RawFirstIngestor({
    log,
    nextId,
    now: clock.now,
    profile,
    registry,
    reopenLog: openLog,
    sink: {
      invalidFrame: (item) => invalid.push(item),
      nonTickFrame: (item) => nonTick.push(item),
      tick: (tick) => ticks.push(tick),
    },
  });
  const connection = new DerivConnection({
    alert: (payload) => alerts.push(payload),
    catalog: new MemoryCatalogStore(),
    catalogSchema: createCatalogResponseSchema({
      source_schema_bytes: schemas.schema('active_symbols', 'response').bytes,
      source_schema_release: schemas.release,
    }),
    connect: (input) => {
      const Socket = options.answerPings === true ? PongingSocket : FakeDerivSocket;
      const socket = new Socket({ ...input, deferClose: options.deferClose ?? false });
      sockets.push(socket);
      return socket;
    },
    ...(options.durationMs === null ? {} : { durationMs: options.durationMs ?? 600_000 }),
    endpoint: DERIV_PUBLIC_ENDPOINT,
    ingestor,
    nextId,
    now: clock.now,
    profile,
    requestedResponses: requested,
    scheduler: clock.scheduler,
    schemas,
    serverTime: false,
    supersedes_connection_id: options.supersedes ?? null,
    symbol,
  });
  const run = connection.run();
  await settle();

  /** Socket de la conexión; falla si no hay exactamente uno. */
  const socket = (): FakeDerivSocket => {
    const [only] = sockets;
    if (only === undefined || sockets.length !== 1) {
      throw new TypeError(`Se esperaba un socket, hay ${String(sockets.length)}.`);
    }
    return only;
  };

  /** Segmentos durables, leídos de los almacenes con un log reabierto. */
  const segments = async (): Promise<SourceEvent[][]> => (await openLog()).readDurableSegments();

  /** Source events durables, en orden. */
  const events = async (): Promise<SourceEvent[]> => (await segments()).flat();

  /**
   * Abre el socket, responde el catálogo (`req_id` 1) y entrega `firstTick`, la respuesta a la
   * suscripción (`req_id` 2). Deja la conexión suscrita, con su primer tick durable.
   */
  const subscribe = async (firstTick: string) => {
    socket().open();
    await settle();
    socket().text(derivMessages.catalog(1));
    await settle();
    socket().text(firstTick);
    await settle();
  };

  return {
    alerts,
    clock,
    connection,
    events,
    invalid,
    nonTick,
    objects,
    operational,
    profile,
    requested,
    run,
    segments,
    socket,
    sourceLog,
    subscribe,
    ticks,
  };
}
