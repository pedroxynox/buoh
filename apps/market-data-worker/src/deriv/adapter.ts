import { createCatalogResponseSchema, type PipelineProfile } from '@buoh/domain';

import { RawFirstIngestor, type TickSink } from '../ingestion/raw-first-ingestor.js';
import {
  stderrAlert,
  type OperationalAlert,
  type OperationalRegistry,
} from '../operational/registry.js';
import { type SourceEventLog } from '../source-log/source-event-log.js';
import { DerivConnection, type DerivConnectionResult, type DerivSessionEnd } from './connection.js';
import { type CatalogStore, type RequestedResponseIncidentStore, type Scheduler } from './ports.js';
import { createDerivMeasurementProfile, DERIV_PUBLIC_ENDPOINT } from './profile.js';
import { encodeRequest, type DerivRequest } from './requests.js';
import {
  loadDerivSchemas,
  SCHEMA_DOWNLOAD_TIMEOUT_MS,
  type DerivSchemaSet,
  type ExpectedSchemaArchive,
  type SchemaLoadResult,
} from './schema-archive.js';
import { type SocketFactory } from './socket.js';

export interface DerivAdapterInput {
  /**
   * Alerta saneada, en stderr por defecto: si una incidencia de respuesta pedida no se puede
   * guardar, o si el reloj va por detrás del log (`clock_behind_log`).
   */
  readonly alert?: OperationalAlert;
  readonly catalog: CatalogStore;
  readonly connect: SocketFactory;
  /** Tiempo de escucha desde el primer tick hasta pedir `forget_all`, en milisegundos. */
  readonly durationMs: number;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  /** Log de la fuente, ya abierto. */
  readonly log: SourceEventLog;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly registry: OperationalRegistry;
  readonly reopenLog: () => Promise<SourceEventLog>;
  readonly requestedResponses: RequestedResponseIncidentStore;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
  /** Pide `time` una vez para medir el desfase con el servidor (lo usa el smoke). */
  readonly serverTime: boolean;
  /** Recibe los ticks normalizados y los frames inválidos, ya durables. */
  readonly sink: TickSink;
  readonly symbol: string;
}

/** Release y SHA-256 del `schemas.zip` cargado. */
export interface DerivSchemaSummary {
  readonly archive_sha256: string;
  readonly release: string;
}

export interface DerivAdapterResult extends DerivConnectionResult {
  /** Release cargada, o `null` si la carga falló. */
  readonly schemas: DerivSchemaSummary | null;
}

/** Lo que necesita la preparación: la descarga de los esquemas, el registro operativo y el símbolo. */
export type DerivPreparationInput = Pick<
  DerivAdapterInput,
  'expected' | 'fetch' | 'nextId' | 'now' | 'registry' | 'scheduler' | 'schemaUrl' | 'symbol'
> & {
  /**
   * Último source event durable de la fuente, o `[]` si no se conoce: lo cita la incidencia de un
   * límite de esquema.
   */
  readonly related_refs: readonly string[];
};

/**
 * Lo que la sesión prepara una vez (ADR-0015 §3): los esquemas de la release fijada, ya cargados y
 * con las seis peticiones comprobadas, su resumen y el perfil de medición del símbolo.
 */
export interface DerivPreparation {
  readonly profile: PipelineProfile;
  readonly schemas: DerivSchemaSet;
  readonly status: 'prepared';
  readonly summary: DerivSchemaSummary;
  readonly symbol: string;
}

/**
 * La preparación no pasó, así que no se conecta (salud `failed`): los esquemas no cargaron, y
 * entonces `summary` es `null`, o una petición no cumple su esquema (`request_invalid`).
 */
export interface DerivPreparationFailure {
  readonly end: {
    readonly detail: string | null;
    readonly reason: string;
    readonly status: 'failed';
  };
  readonly status: 'failed';
  readonly summary: DerivSchemaSummary | null;
}

/** Lo que necesita un intento: la preparación y el ingestor de la sesión, y los puertos de la conexión. */
export interface DerivAttemptInput {
  /**
   * Alerta saneada, en stderr por defecto: la del reloj por detrás del log, `{ event:
   * 'clock_behind_log', now_utc, previous_close_utc }`, y las de la conexión.
   */
  readonly alert?: OperationalAlert;
  readonly catalog: CatalogStore;
  readonly connect: SocketFactory;
  /**
   * Tiempo de escucha desde el primer tick hasta el cierre previsto, en milisegundos. Sin él, la
   * conexión no se cierra sola: la cierra quien la sigue.
   */
  readonly durationMs?: number;
  /** El ingestor de la sesión, el mismo en todos sus intentos: la conexión anterior sale de su log. */
  readonly ingestor: RawFirstIngestor;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly preparation: DerivPreparation;
  readonly requestedResponses: RequestedResponseIncidentStore;
  readonly scheduler: Scheduler;
  /** Pide `time` una vez, tras el primer tick, para medir el desfase con el servidor. */
  readonly serverTime: boolean;
}

/**
 * Cómo empezó un intento: no conectó, porque el cierre reparado no quedó durable o un almacén no
 * respondió al leer el log (fin `paused` con `persistence_unavailable` y la etapa), o ya corre su
 * conexión. `connection` es la instancia que corre, para pedirle `recoverHistory` o cerrarla con
 * `finish`, `stop` o `interrupt`; `result` es su `run()`, que se resuelve cuando la conexión termina
 * y se rechaza solo con un error inesperado.
 */
export type DerivAttempt =
  | { readonly end: DerivSessionEnd; readonly status: 'not_connected' }
  | {
      readonly connection: DerivConnection;
      readonly result: Promise<DerivConnectionResult>;
      readonly status: 'started';
    };

/**
 * Las seis peticiones que se comprueban antes de conectar. `ticks_history` lleva un rango
 * representativo (`start` y `end` en 0): se comprueban la forma de la petición y el símbolo, y el
 * rango se conoce después.
 */
function connectionRequests(symbol: string): DerivRequest[] {
  return [
    { operation: 'active_symbols' },
    { operation: 'ticks', symbol },
    { end: 0, operation: 'ticks_history', start: 0, symbol },
    { operation: 'ping' },
    { operation: 'time' },
    { operation: 'forget_all' },
  ];
}

function notConnected(
  schemas: DerivAdapterResult['schemas'],
  end: DerivSessionEnd,
): DerivAdapterResult {
  return {
    catalog: null,
    closure: null,
    connection_id: null,
    end,
    schemas,
    server_time_offset_ms: null,
    subscription_id: null,
  };
}

/** Carga de esquemas con el tiempo máximo de ADR-0004 §7, medido con el temporizador inyectado. */
async function loadSchemas(input: DerivPreparationInput): Promise<SchemaLoadResult> {
  const controller = new AbortController();
  const cancel = input.scheduler.schedule(SCHEMA_DOWNLOAD_TIMEOUT_MS, () => {
    controller.abort();
  });
  try {
    return await loadDerivSchemas({
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      fetch: input.fetch,
      nextId: input.nextId,
      now: input.now,
      registry: input.registry,
      related_refs: input.related_refs,
      signal: controller.signal,
      ...(input.schemaUrl === undefined ? {} : { url: input.schemaUrl }),
    });
  } finally {
    cancel();
  }
}

/**
 * La preparación de la sesión (ADR-0015 §3), una sola vez antes de sus intentos: carga los esquemas
 * de la release fijada (ver «Carga de los esquemas de Deriv» en el runbook), comprueba con ellos las
 * seis peticiones de la conexión y arma el perfil de medición del símbolo. Si algo falla, devuelve
 * el fin `failed`, y no hay que conectar.
 */
export async function prepareDerivAdapter(
  input: DerivPreparationInput,
): Promise<DerivPreparation | DerivPreparationFailure> {
  const loaded = await loadSchemas(input);
  if (loaded.status === 'failed') {
    return {
      end: { detail: loaded.detail, reason: loaded.reason, status: 'failed' },
      status: 'failed',
      summary: null,
    };
  }
  const { schemas } = loaded;
  const summary = { archive_sha256: schemas.archive_sha256, release: schemas.release };

  // Antes de conectar: si una petición propia no cumple su esquema (por ejemplo, un símbolo con
  // caracteres que `ticks` no admite), no tiene sentido abrir la conexión.
  const invalid = connectionRequests(input.symbol).find(
    (request) => encodeRequest(schemas, request, 1) === null,
  );
  if (invalid !== undefined) {
    return {
      end: { detail: invalid.operation, reason: 'request_invalid', status: 'failed' },
      status: 'failed',
      summary,
    };
  }
  return {
    profile: createDerivMeasurementProfile({ schemas, symbol: input.symbol }),
    schemas,
    status: 'prepared',
    summary,
    symbol: input.symbol,
  };
}

/**
 * Lo más que se espera de una vez antes de volver a mirar el reloj: un hueco enorme nunca llega
 * entero al temporizador (`setTimeout` admite hasta 2 147 483 647 ms), y un ajuste del reloj se nota
 * en un minuto como mucho.
 */
const WAIT_STEP_MS = 60_000;

/**
 * Espera, con el temporizador inyectado, a que el reloj pase de `instantUtc`, la hora del cierre de
 * la conexión anterior. El `ConnectionOpened` toma su hora al abrir el socket, así que queda
 * estrictamente después del cierre que supera: con la misma hora, las reglas podrían ordenar la
 * resolución de `connection_lost` antes de su apertura, y el log no se podría derivar. Espera en
 * tramos de 60 000 ms como mucho y vuelve a mirar el reloj después de cada uno: si saltó hacia
 * delante, deja de esperar; si retrocedió, espera otra vez. Si falta más de 60 000 ms, el reloj va
 * por detrás del log: avisa una vez con `clock_behind_log`, y sigue esperando.
 */
async function waitPast(
  input: Pick<DerivAttemptInput, 'now' | 'scheduler'> & { readonly alert: OperationalAlert },
  instantUtc: string,
): Promise<void> {
  const instant = Date.parse(instantUtc);
  let alerted = false;
  for (;;) {
    const now = input.now();
    // Hasta el primer milisegundo después del cierre.
    const wait = instant - Date.parse(now) + 1;
    if (wait <= 0) {
      return;
    }
    if (wait > WAIT_STEP_MS && !alerted) {
      alerted = true;
      input.alert({ event: 'clock_behind_log', now_utc: now, previous_close_utc: instantUtc });
    }
    await new Promise<void>((resolve) => {
      input.scheduler.schedule(Math.min(wait, WAIT_STEP_MS), resolve);
    });
  }
}

/**
 * Un intento de la sesión (ADR-0015 §3), con su ingestor: repara el cierre que le falte a la conexión
 * anterior del log, espera a que el reloj pase la hora del cierre de esa conexión y arranca una
 * `DerivConnection` que la supera (`supersedes_connection_id`). Devuelve la conexión que corre y la
 * promesa de su resultado, o el fin sin conectar (ver `DerivAttempt`). Si el log no pasa sus
 * comprobaciones, se rechaza con `LogIntegrityError`, sin conectar.
 */
export async function startDerivAttempt(input: DerivAttemptInput): Promise<DerivAttempt> {
  const { ingestor, preparation } = input;
  const { profile, schemas, symbol } = preparation;
  const alert = input.alert ?? stderrAlert;
  // Antes del socket: la conexión anterior sale del log, nunca de la memoria (ADR-0015 §3).
  const repair = await ingestor.repairUnrecordedClose({ affected_symbols: [symbol] });
  if (repair.status === 'not_durable') {
    return {
      end: { detail: repair.stage, reason: 'persistence_unavailable', status: 'paused' },
      status: 'not_connected',
    };
  }
  if (repair.closed_at_utc !== null) {
    await waitPast({ alert, now: input.now, scheduler: input.scheduler }, repair.closed_at_utc);
  }
  const connection = new DerivConnection({
    alert,
    catalog: input.catalog,
    catalogSchema: createCatalogResponseSchema({
      source_schema_bytes: schemas.schema('active_symbols', 'response').bytes,
      source_schema_release: schemas.release,
    }),
    connect: input.connect,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    // Siempre el canal público fijado en ADR-0004 §2: no hay forma de apuntar a otro host.
    endpoint: DERIV_PUBLIC_ENDPOINT,
    ingestor,
    nextId: input.nextId,
    now: input.now,
    profile,
    requestedResponses: input.requestedResponses,
    scheduler: input.scheduler,
    schemas,
    serverTime: input.serverTime,
    supersedes_connection_id: repair.connection_id,
    symbol,
  });
  return { connection, result: connection.run(), status: 'started' };
}

/**
 * Adaptador público de Deriv (`F1-SOURCE-001`, ADR-0012): una sesión de un solo intento. Prepara
 * los esquemas, las peticiones y el perfil (`prepareDerivAdapter`), arma el `RawFirstIngestor` sobre
 * el log y sigue un intento (`startDerivAttempt`) hasta el cierre de su conexión: repara el cierre
 * que le falte a la conexión anterior del log y, cuando el reloj pasa la hora de ese cierre, abre una
 * conexión que la supera (ADR-0015 §3). Si la preparación falla, nunca se conecta (salud `failed`);
 * si la reparación no queda durable o un almacén no responde al leer el log, tampoco (salud
 * `paused`). Si el log no pasa sus comprobaciones, se rechaza con `LogIntegrityError`, sin conectar.
 */
export async function runDerivAdapter(input: DerivAdapterInput): Promise<DerivAdapterResult> {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new TypeError('durationMs debe ser un entero positivo de milisegundos.');
  }
  const last = input.log.lastEventId;
  const preparation = await prepareDerivAdapter({
    ...input,
    related_refs: last === null ? [] : [last],
  });
  if (preparation.status === 'failed') {
    return notConnected(preparation.summary, preparation.end);
  }
  const ingestor = new RawFirstIngestor({
    log: input.log,
    nextId: input.nextId,
    now: input.now,
    profile: preparation.profile,
    registry: input.registry,
    reopenLog: input.reopenLog,
    sink: input.sink,
  });
  const attempt = await startDerivAttempt({ ...input, ingestor, preparation });
  if (attempt.status === 'not_connected') {
    return notConnected(preparation.summary, attempt.end);
  }
  return { ...(await attempt.result), schemas: preparation.summary };
}
