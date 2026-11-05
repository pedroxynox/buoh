/**
 * La salud de los datos en la web servida por la API (F2.4; concepto de interfaz §10): convierte lo
 * que responde `GET /api/v1/datos/salud` (`DataHealth`, ADR-0019 §8) en lo que dibujan la insignia de
 * la barra superior y el Observatorio: el estado, su causa y su frescura. Es puro: la hora llega con el
 * estado. Solo lo importan componentes de `out-api`, así que el escritorio no lo lleva (`F2-UI-001`).
 *
 * La causa se lee de los campos que ya trae el `HealthReport`, con las reglas que lo derivan
 * (`healthReportOf` en `packages/domain/src/health.ts`; contratos de dominio, «HealthReport»). En
 * `recovering` sin `connection_lost`, la conexión decide: si no está `connected`, la captura está
 * reconectando; si lo está, solo queda la continuidad pendiente, el caso en que `open_condition_types`
 * queda vacío (pendiente 2 de F1.2). La prueba de la web compara esta lectura con la derivación real
 * del dominio en todas sus combinaciones.
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

export interface HealthCause {
  readonly title: string;
  readonly detail: string;
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
  readonly causes: readonly HealthCause[];
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

const CONDITION_CAUSES = {
  connection_lost: {
    title: 'Conexión perdida',
    detail:
      'La conexión con Deriv se cortó sin pedirlo. Hasta que la captura vuelva a conectar y la historia de Deriv cubra el hueco, no se sabe si faltan ticks.',
  },
  event_gap_unresolved: {
    title: 'Hueco sin resolver',
    detail:
      'La historia de Deriv no cubrió todo un hueco de la captura: en ese tramo pueden faltar ticks.',
  },
  persistence_unavailable: {
    title: 'Persistencia no disponible',
    detail: 'La captura no pudo guardar un evento de Deriv (registro operativo).',
  },
  source_limit_exceeded: {
    title: 'Límite de fuente superado',
    detail: 'Un mensaje de Deriv o la cola de la captura pasó su límite (registro operativo).',
  },
} as const satisfies Record<ConditionType, HealthCause>;

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
  unexpected_error: 'un error inesperado',
};

/** Un SQLSTATE de PostgreSQL: cinco cifras o mayúsculas. */
const SQLSTATE = /^[0-9A-Z]{5}$/u;

const CONTINUITY_PENDING: HealthCause = {
  title: 'Continuidad pendiente',
  detail:
    'La captura está conectada, pero después de la última reconexión falta comprobar con la historia de Deriv que no se perdió ningún tick del hueco.',
};

const PAUSED_WITHOUT_CONDITION: HealthCause = {
  title: 'Entrada detenida',
  detail:
    'La captura no procesa la entrada y el informe no trae una condición abierta: se paró a pedido, o no hay un proceso que capture con un latido reciente.',
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

function alertCause(alert: {
  readonly event: string;
  readonly reason: string | null;
}): HealthCause {
  const reason = alert.reason;
  switch (alert.event) {
    case 'data_health_failed':
      return {
        title: 'Log incompatible',
        detail: `La observación encontró algo que no cuadra en el log: ${
          reason === null ? 'sin motivo' : (INCOMPATIBLE_REASONS[reason] ?? reason)
        }.`,
      };
    case 'data_health_storage_unavailable':
      return {
        title: 'Almacenes sin respuesta',
        detail: `No se pudo leer PostgreSQL o el almacenamiento de objetos${
          reason === null ? '' : ` (${reason})`
        }, así que la salud no se pudo observar.`,
      };
    case 'data_health_checkpoint_rebuild_incomplete':
      return {
        title: 'Reconstrucción sin terminar',
        detail:
          'La observación no terminó a tiempo de reconstruir el estado desde el último punto de control, así que la salud no se pudo observar.',
      };
    case 'checkpoint_rejected':
      return {
        title: 'Punto de control descartado',
        detail: `Se descartó un punto de control${
          reason === null ? '' : ` (${reason})`
        }, y la salud se calculó desde uno anterior o desde el principio del log.`,
      };
    case 'checkpoint_unavailable':
      return {
        title: 'Punto de control sin leer',
        detail: `No se pudo leer un punto de control${reason === null ? '' : ` (${reason})`}.`,
      };
    default:
      return {
        title: `Alerta ${alert.event}`,
        detail: reason === null ? 'Sin motivo.' : `Motivo: ${reason}.`,
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

/**
 * Las causas de un informe, en este orden: las alertas de `data:health`, las condiciones abiertas, la
 * de `recovering` sin `connection_lost`, la cola sobre su límite y, si nada lo explica, la del estado.
 */
export function reportCauses(
  report: HealthReport,
  alerts: readonly { readonly event: string; readonly reason: string | null }[],
): HealthCause[] {
  const causes: HealthCause[] = alerts.map(alertCause);
  for (const type of report.open_condition_types) {
    causes.push(CONDITION_CAUSES[type]);
  }
  if (
    report.service_health === 'recovering' &&
    !report.open_condition_types.includes('connection_lost')
  ) {
    causes.push(
      report.connection_state === 'connected'
        ? CONTINUITY_PENDING
        : {
            title: 'Reconectando',
            detail: `${
              report.connection_state === 'connecting'
                ? 'La captura se está conectando con Deriv.'
                : 'La captura está desconectada de Deriv.'
            } Al volver a conectar, comprueba con la historia de Deriv que no falte ningún tick.`,
          },
    );
  }
  if (overQueueLimit(report)) {
    causes.push({
      title: 'Cola sobre su límite',
      detail: `La captura tiene ${String(report.backlog_count)} eventos (${String(report.backlog_bytes)} bytes) sin guardar, más de lo que admite (${String(QUEUE_LIMITS.events)} eventos o ${String(QUEUE_LIMITS.bytes)} bytes), así que deja de aceptar entrada.`,
    });
  }
  if (causes.length === 0) {
    if (report.service_health === 'starting') {
      causes.push(STARTING);
    } else if (report.service_health === 'paused') {
      causes.push(PAUSED_WITHOUT_CONDITION);
    } else if (report.service_health === 'failed') {
      causes.push(FAILED_WITHOUT_ALERT);
    }
  }
  return causes;
}

const EMPTY: Omit<HealthView, 'badge' | 'summary'> = {
  causes: [],
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
  const causes = [...reportCauses(observed.report, observed.alerts), ...staleCause];
  return {
    ...base,
    badge: { kind: 'state', health: observed.report.service_health },
    summary: causes[0]?.title ?? 'Sin causas abiertas.',
    causes,
    observation,
    report: observed.report,
  };
}
