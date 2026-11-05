/**
 * La salud de los datos en la web servida por la API (F2.4; concepto de interfaz §10): convierte lo
 * que responde `GET /api/v1/datos/salud` (`DataHealth`, ADR-0019 §8) en lo que dibujan la insignia de
 * la barra superior y el Observatorio: el estado, su causa y su frescura. Es puro: la hora llega con el
 * estado. Solo lo importan componentes de `out-api`, así que el escritorio no lo lleva (`F2-UI-001`).
 *
 * La causa se lee de los campos que ya trae el `HealthReport`, con las reglas que lo derivan
 * (`healthReportOf` en `packages/domain/src/health.ts`; contratos de dominio, «HealthReport»): cada
 * causa impone una salud mínima y gana la más severa. En `recovering` sin `connection_lost`, la
 * conexión decide: si está `connected`, solo queda la continuidad pendiente, el caso en que
 * `open_condition_types` queda vacío (pendiente 2 de F1.2). Si ninguna causa del informe llega a la
 * gravedad de su estado, la vista suma la que la explica, como un `paused` sin un proceso que capture.
 * La prueba de la web compara esta lectura con la derivación real del dominio en todas sus
 * combinaciones.
 */
import type { ConditionType, DataHealth, HealthReport, ServiceHealth } from '@buoh/contracts';
import type { IconName } from '@buoh/design-system';
import { describeFailure, type ApiFailure } from '../auth/api';

/** Lo que sabe la web de la salud: leyendo, un fallo de la API o la última respuesta. */
export type DataHealthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure }
  | {
      readonly kind: 'ready';
      readonly health: DataHealth;
      /** La hora del navegador de la última respuesta buena, en ms. */
      readonly receivedAtMs: number;
      /** La hora del último intento, bueno o no: con ella envejece la observación. */
      readonly checkedAtMs: number;
      /** El fallo del último intento, si falló después de una respuesta buena. */
      readonly refreshFailure: ApiFailure | null;
    };

export const LOADING: DataHealthState = { kind: 'loading' };

/**
 * Una observación de hace más de 15 minutos es antigua: `buoh-operaciones` observa cada 5 (ADR-0018
 * §11), así que faltan al menos las dos siguientes. La insignia conserva su estado y suma la marca.
 */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * Los límites de la cola de la captura, los de `SOURCE_LIMITS` de `packages/domain` (ADR-0004 §7):
 * por encima de uno, la captura deja de aceptar entrada y la salud pasa a `paused`. La prueba de la
 * web los compara con los del dominio.
 */
export const QUEUE_LIMITS = { events: 1000, bytes: 33_554_432 } as const;

/** El símbolo que observa la salud: el de `data:health` por defecto, el único de la Fase 2. */
export const HEALTH_SYMBOL = 'R_100';

/** La gravedad de cada estado: gana la más severa (`SEVERITY_RANK` de `healthReportOf`). */
const SEVERITY = {
  starting: 0,
  healthy: 1,
  degraded: 2,
  recovering: 3,
  paused: 4,
  failed: 5,
} as const satisfies Record<ServiceHealth, number>;

export interface HealthCause {
  readonly title: string;
  readonly detail: string;
}

/** Una causa con la salud mínima que impone, como en `healthReportOf`. */
interface RatedCause {
  readonly cause: HealthCause;
  readonly imposes: ServiceHealth;
}

/** La insignia: uno de los seis estados del contrato, o una neutra cuando la web no lo sabe. */
export type HealthBadgeView =
  | { readonly kind: 'state'; readonly health: ServiceHealth }
  | { readonly kind: 'unknown'; readonly label: string; readonly icon: IconName };

export interface HealthObservationView {
  readonly log: number;
  readonly observedAtUtc: string;
  /** La edad de la observación en el último intento de lectura, en ms. */
  readonly ageMs: number;
  readonly stale: boolean;
}

export interface HealthView {
  readonly badge: HealthBadgeView;
  /** Una frase para el título de la insignia y la tarjeta de la salud. */
  readonly summary: string;
  /** Lo que explica el estado, en el orden de `reportCauses`. */
  readonly causes: readonly HealthCause[];
  /** Los avisos de la observación que no cambian la salud, como un punto de control descartado. */
  readonly notes: readonly HealthCause[];
  readonly log: number | null;
  readonly observation: HealthObservationView | null;
  readonly report: HealthReport | null;
  readonly loading: boolean;
  /** El texto de un fallo de la API cuando no hay ningún dato que mostrar. */
  readonly error: string | null;
  readonly unauthenticated: boolean;
  /** El texto del fallo de la última actualización; lo que se ve es de la anterior. */
  readonly refreshError: string | null;
  /** La hora UTC de la última respuesta buena. */
  readonly receivedAtUtc: string | null;
}

/** Cada condición abierta, con la salud mínima que impone (`CONDITION_HEALTH` del dominio). */
const CONDITION_CAUSES = {
  connection_lost: {
    imposes: 'recovering',
    cause: {
      title: 'Conexión perdida',
      detail:
        'La conexión con Deriv se cortó sin pedirlo. Hasta que la captura vuelva a conectar y la historia de Deriv cubra el hueco, no se sabe si faltan ticks.',
    },
  },
  event_gap_unresolved: {
    imposes: 'degraded',
    cause: {
      title: 'Hueco sin resolver',
      detail:
        'La historia de Deriv no cubrió todo un hueco de la captura: en ese tramo pueden faltar ticks.',
    },
  },
  persistence_unavailable: {
    imposes: 'paused',
    cause: {
      title: 'Persistencia no disponible',
      detail: 'La captura no pudo guardar un evento de Deriv (registro operativo).',
    },
  },
  source_limit_exceeded: {
    imposes: 'paused',
    cause: {
      title: 'Límite de fuente superado',
      detail: 'Un mensaje de Deriv o la cola de la captura pasó su límite (registro operativo).',
    },
  },
} as const satisfies Record<ConditionType, RatedCause>;

const CONNECTION_LABELS = {
  connected: 'Conectada',
  connecting: 'Conectando',
  disconnected: 'Desconectada',
} as const satisfies Record<HealthReport['connection_state'], string>;

/** El nombre de cada fuente; una que no está, con su código. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  deriv_options: 'Deriv · WebSocket público',
};

/** Lo incompatible que encuentra `data:health` (ADR-0015 §8, regla 2), en palabras. */
const INCOMPATIBLE_REASONS: Readonly<Record<string, string>> = {
  source_schema_missing: 'falta el esquema de la fuente guardado',
  source_schema_mismatch: 'el esquema de la fuente guardado no es el fijado',
  symbol_mismatch: 'el log tiene otro símbolo',
  cursor_ahead_of_log: 'el cursor apunta a un evento que no está en el log',
  connector_version_mismatch: 'el log es de otra versión del conector',
  log_not_derivable: 'el log no se puede derivar',
};

/** Un SQLSTATE de PostgreSQL: cinco cifras o mayúsculas. */
const SQLSTATE = /^[0-9A-Z]{5}$/u;

const CONTINUITY_PENDING: HealthCause = {
  title: 'Continuidad pendiente',
  detail:
    'La captura está conectada, pero después de la última reconexión falta comprobar con la historia de Deriv que no se perdió ningún tick del hueco.',
};

/** `paused` sin ninguna causa en el informe: lo da un cierre pedido o la salud mínima de quien observa. */
const PAUSED_WITHOUT_CONDITION: HealthCause = {
  title: 'Entrada detenida',
  detail:
    'La captura no procesa la entrada y el informe no trae una condición abierta: se paró a pedido, o no hay un proceso que capture con un latido reciente.',
};

/**
 * `paused` con causas que no llegan a esa gravedad: solo lo da la salud mínima de quien observa la
 * ingesta, sin escritor vivo o con su latido vencido (ADR-0015 §8, reglas 4 y 6).
 */
const PAUSED_WITHOUT_WRITER: HealthCause = {
  title: 'Sin captura activa',
  detail:
    'No hay un proceso que capture con un latido reciente, por ejemplo porque la captura se paró, se cayó o todavía no informa, así que la entrada no se procesa.',
};

const STARTING: HealthCause = {
  title: 'Sin datos todavía',
  detail: 'La captura todavía no guardó ningún mensaje de Deriv en este log.',
};

const FAILED_WITHOUT_ALERT: HealthCause = {
  title: 'Log incompatible',
  detail: 'La observación encontró algo que no cuadra en el log y necesita intervención.',
};

/** El nombre de una fuente para la vista, o su código si no se conoce. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function connectionLabel(state: HealthReport['connection_state']): string {
  return CONNECTION_LABELS[state];
}

/** Una edad en minutos y horas; una hora del futuro, por un reloj atrasado, cuenta como ahora. */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return 'menos de 1 min';
  }
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

const withReason = (reason: string | null) => (reason === null ? '' : ` (${reason})`);

/** La alerta `data_health_failed` (ADR-0015 §8, regla 2), que da `failed`, según su motivo. */
function failedAlertCause(reason: string | null): HealthCause {
  if (reason === 'unexpected_error') {
    return {
      title: 'Error de la observación',
      detail: 'La observación falló por un error inesperado suyo, no por el log.',
    };
  }
  if (reason === 'log_not_prepared') {
    return {
      title: 'Log sin preparar',
      detail: 'El log observado todavía no se puede leer: no existe o no está preparado.',
    };
  }
  if (reason === 'migrations_pending') {
    return {
      title: 'Migraciones pendientes',
      detail:
        'Al esquema del log le faltan migraciones del worker, o una de sus tablas, así que la salud no se pudo observar. buoh-operaciones las aplica antes de cada observación.',
    };
  }
  return {
    title: 'Log incompatible',
    detail: `La observación encontró algo que no cuadra en el log: ${
      reason === null ? 'sin motivo' : (INCOMPATIBLE_REASONS[reason] ?? reason)
    }.`,
  };
}

/**
 * La salud que impone cada alerta de `data:health` que la cambia: la del informe sin observación que
 * la acompaña (`evaluateDataHealth` del worker; ADR-0015 §8, reglas 2 y 3, y ADR-0017 §6). La prueba
 * de la web la compara con la evaluación real del worker.
 */
const ALERT_HEALTH: Readonly<Record<string, ServiceHealth>> = {
  data_health_failed: 'failed',
  data_health_storage_unavailable: 'paused',
  data_health_checkpoint_rebuild_incomplete: 'paused',
};

/** La salud que impone una alerta, o `null` si es un aviso que no la cambia. */
export function alertHealth(event: string): ServiceHealth | null {
  return ALERT_HEALTH[event] ?? null;
}

/**
 * Una alerta de `data:health` como causa, con la salud que impone, o como aviso (`null` en
 * `imposes`) si no la cambia. Una alerta que la web no conoce es un aviso, con su código.
 */
function alertEntry(alert: {
  readonly event: string;
  readonly reason: string | null;
}): RatedCause | { readonly cause: HealthCause; readonly imposes: null } {
  const { reason } = alert;
  const imposes = alertHealth(alert.event);
  switch (alert.event) {
    case 'data_health_failed':
      return { imposes, cause: failedAlertCause(reason) };
    case 'data_health_storage_unavailable':
      return {
        imposes,
        cause: {
          title: 'Almacenes sin respuesta',
          detail: `No se pudo leer PostgreSQL o el almacenamiento de objetos${withReason(reason)}, así que la salud no se pudo observar.`,
        },
      };
    case 'data_health_checkpoint_rebuild_incomplete':
      return {
        imposes,
        cause: {
          title: 'Reconstrucción sin terminar',
          detail:
            'La observación no terminó a tiempo de reconstruir el estado desde el último punto de control, así que la salud no se pudo observar.',
        },
      };
    case 'checkpoint_rejected':
      return {
        imposes: null,
        cause: {
          title: 'Punto de control descartado',
          detail: `Se descartó un punto de control${withReason(reason)}, y la salud se calculó desde uno anterior o desde el principio del log.`,
        },
      };
    case 'checkpoint_unavailable':
      return {
        imposes: null,
        cause: {
          title: 'Punto de control sin leer',
          detail: `No se pudo leer un punto de control${withReason(reason)}.`,
        },
      };
    default:
      return {
        imposes: null,
        cause: {
          title: `Alerta ${alert.event}`,
          detail: reason === null ? 'Sin motivo.' : `Motivo: ${reason}.`,
        },
      };
  }
}

function failedObservationCause(reason: string, code: string | null): HealthCause {
  let detail: string;
  if (reason === 'child_timeout') {
    detail = 'La observación no terminó en su plazo.';
  } else if (reason === 'health_command_failed') {
    detail = `La observación falló${code === null ? '' : ` con el código ${code}`}.`;
  } else if (reason === 'log_not_prepared') {
    detail = 'El log activo todavía no está preparado.';
  } else if (reason === 'unknown_error') {
    detail = 'La observación falló por un error desconocido.';
  } else if (SQLSTATE.test(reason)) {
    detail = `PostgreSQL respondió con el código ${reason}.`;
  } else {
    detail = `La observación falló con el motivo ${reason}.`;
  }
  return { title: 'Observación fallida', detail };
}

function overQueueLimit(report: HealthReport): boolean {
  return report.backlog_count > QUEUE_LIMITS.events || report.backlog_bytes > QUEUE_LIMITS.bytes;
}

/** La causa de `recovering` sin `connection_lost`, que el informe no nombra. */
function recoveringCause(report: HealthReport): HealthCause {
  if (report.connection_state === 'connected') {
    return CONTINUITY_PENDING;
  }
  // Sin la conexión, el informe no distingue la reconexión de un cierre pedido con la continuidad
  // de una reconexión anterior todavía pendiente: la causa dice las dos.
  return {
    title: 'Sin conexión con Deriv',
    detail: `${
      report.connection_state === 'connecting'
        ? 'La captura se está conectando con Deriv'
        : 'La captura está desconectada de Deriv'
    }: vuelve a conectar, o cerró la conexión a pedido con la comprobación de una reconexión anterior todavía pendiente. Al conectar, comprueba con la historia de Deriv que no falte ningún tick.`,
  };
}

/** La causa del propio estado, cuando ninguna de las del informe llega a su gravedad. */
function stateCause(health: ServiceHealth, others: number): HealthCause | null {
  switch (health) {
    case 'healthy':
      return null;
    case 'starting':
      return STARTING;
    case 'paused':
      return others === 0 ? PAUSED_WITHOUT_CONDITION : PAUSED_WITHOUT_WRITER;
    case 'failed':
      return FAILED_WITHOUT_ALERT;
    case 'degraded':
    case 'recovering':
      // La derivación no da estos estados sin su causa; si llegara uno, no se oculta.
      return {
        title: 'Causa sin nombrar',
        detail: 'El informe no trae ninguna condición que explique este estado.',
      };
  }
}

/**
 * Las causas de un informe, en este orden: las alertas de `data:health` que cambian la salud, las
 * condiciones abiertas, la de `recovering` sin `connection_lost`, la cola sobre su límite y, si
 * ninguna llega a la gravedad del estado, la del propio estado. Los avisos que no cambian la salud
 * van aparte.
 */
export function reportCauses(
  report: HealthReport,
  alerts: readonly { readonly event: string; readonly reason: string | null }[],
): { readonly causes: HealthCause[]; readonly notes: HealthCause[] } {
  const rated: RatedCause[] = [];
  const notes: HealthCause[] = [];
  for (const alert of alerts) {
    const entry = alertEntry(alert);
    if (entry.imposes === null) {
      notes.push(entry.cause);
    } else {
      rated.push({ cause: entry.cause, imposes: entry.imposes });
    }
  }
  for (const type of report.open_condition_types) {
    rated.push(CONDITION_CAUSES[type]);
  }
  if (
    report.service_health === 'recovering' &&
    !report.open_condition_types.includes('connection_lost')
  ) {
    rated.push({ cause: recoveringCause(report), imposes: 'recovering' });
  }
  if (overQueueLimit(report)) {
    rated.push({
      imposes: 'paused',
      cause: {
        title: 'Cola sobre su límite',
        detail: `La captura tiene ${String(report.backlog_count)} eventos (${String(report.backlog_bytes)} bytes) sin guardar, más de lo que admite (${String(QUEUE_LIMITS.events)} eventos o ${String(QUEUE_LIMITS.bytes)} bytes), así que deja de aceptar entrada.`,
      },
    });
  }
  const worst = Math.max(-1, ...rated.map((entry) => SEVERITY[entry.imposes]));
  const own =
    worst < SEVERITY[report.service_health]
      ? stateCause(report.service_health, rated.length)
      : null;
  const causes = rated.map((entry) => entry.cause);
  return { causes: own === null ? causes : [...causes, own], notes };
}

const EMPTY: Omit<HealthView, 'badge' | 'summary'> = {
  causes: [],
  notes: [],
  log: null,
  observation: null,
  report: null,
  loading: false,
  error: null,
  unauthenticated: false,
  refreshError: null,
  receivedAtUtc: null,
};

const UNOBSERVED: HealthBadgeView = { kind: 'unknown', label: 'Sin observar', icon: 'info' };

/** Lo que dibujan la insignia y el Observatorio para cada estado de la lectura. */
export function healthView(state: DataHealthState): HealthView {
  switch (state.kind) {
    case 'loading':
      return {
        ...EMPTY,
        badge: { kind: 'unknown', label: 'Leyendo…', icon: 'progress' },
        summary: 'Leyendo la salud de los datos.',
        loading: true,
      };
    case 'failed': {
      const unauthenticated = state.failure.code === 'unauthenticated';
      const error = describeFailure(state.failure);
      return {
        ...EMPTY,
        badge: {
          kind: 'unknown',
          label: unauthenticated ? 'Sin sesión' : 'No disponible',
          icon: 'info',
        },
        summary: unauthenticated ? 'Inicia sesión para ver la salud de los datos.' : error,
        error,
        unauthenticated,
      };
    }
    case 'ready':
      return readyView(state);
  }
}

function readyView(state: Extract<DataHealthState, { kind: 'ready' }>): HealthView {
  const { health } = state;
  const base = {
    ...EMPTY,
    log: health.log,
    refreshError: state.refreshFailure === null ? null : describeFailure(state.refreshFailure),
    receivedAtUtc: new Date(state.receivedAtMs).toISOString(),
  };
  if (health.log === null) {
    const cause = {
      title: 'Sin log activo',
      detail: 'Todavía no hay un log de la captura en el que observar la salud.',
    };
    return { ...base, badge: UNOBSERVED, summary: cause.detail, causes: [cause] };
  }
  const observed = health.observation;
  if (observed === null) {
    const cause = {
      title: 'Sin observaciones',
      detail: `El log ${String(health.log)} todavía no tiene ninguna observación de la salud, como justo después del corte semanal. buoh-operaciones observa cada 5 minutos.`,
    };
    return { ...base, badge: UNOBSERVED, summary: cause.detail, causes: [cause] };
  }
  const ageMs = state.checkedAtMs - Date.parse(observed.observed_at_utc);
  const stale = ageMs > STALE_AFTER_MS;
  const observation: HealthObservationView = {
    log: health.log,
    observedAtUtc: observed.observed_at_utc,
    ageMs,
    stale,
  };
  const staleCause: HealthCause[] = stale
    ? [
        {
          title: 'Observación antigua',
          detail: `La última observación es de hace ${ageText(ageMs)}, y buoh-operaciones observa cada 5 minutos: la salud puede haber cambiado desde entonces.`,
        },
      ]
    : [];
  if (observed.status === 'failed') {
    const causes = [failedObservationCause(observed.reason, observed.code), ...staleCause];
    return {
      ...base,
      badge: UNOBSERVED,
      summary: causes[0]?.detail ?? '',
      causes,
      observation,
    };
  }
  const { causes: reportCauseList, notes } = reportCauses(observed.report, observed.alerts);
  const causes = [...reportCauseList, ...staleCause];
  return {
    ...base,
    badge: { kind: 'state', health: observed.report.service_health },
    summary: causes[0]?.title ?? 'Sin causas abiertas.',
    causes,
    notes,
    observation,
    report: observed.report,
  };
}
