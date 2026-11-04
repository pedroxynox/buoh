import type { LiveDerivationView } from '@buoh/domain';

import type { Scheduler } from './deriv/ports.js';
import type { SessionLock } from './deriv/session.js';
import type { OperationalAlert } from './operational/registry.js';
import { failureReason } from './source-log/source-event-log.js';
import { logLocation, MAX_LOG_NUMBER, type LogLocation } from './successive-logs.js';

// El corte semanal de los logs de producción (ADR-0018 §6). La hora de corte de un log es el primer
// lunes a las 00:00 UTC posterior a su primera escritura. Desde esa hora, `ingest` corta en el
// primer momento en que el log está limpio (conectado, sin continuidad pendiente y sin
// `connection_lost` abierta) y, si en 24 horas no llega, corta igual. Cortar es parar la sesión del
// log n como una parada (ADR-0015 §3) y seguir, en el mismo proceso, con una sesión nueva sobre el
// log n+1. Si el log n+1 no está preparado, no corta: sigue en el n, con la alerta `log_cut_blocked`.

/** Un día, en milisegundos. */
const DAY_MS = 86_400_000;
/** Lo que se espera un momento limpio desde la hora de corte, antes de cortar igual (§6). */
export const LOG_CUT_FORCE_AFTER_MS = DAY_MS;
/**
 * Cada cuánto mira el corte, como mucho: antes de la hora de corte, el reloj; después, si el log
 * siguiente está preparado y si el log está limpio. Como la parada por retención, un ajuste del
 * reloj se nota en ese tiempo como mucho.
 */
export const LOG_CUT_CHECK_MS = 30_000;
/** Cada cuánto repite la alerta `log_cut_blocked` mientras el log siguiente no está preparado. */
export const LOG_CUT_ALERT_INTERVAL_MS = 60_000;

/**
 * La hora de corte de un log (ADR-0018 §6): el primer lunes a las 00:00 UTC posterior a su primera
 * escritura (`firstWriteOf`). Una escritura un lunes, también a las 00:00:00.000, da el lunes de la
 * semana siguiente. Lanza `TypeError` si la hora no es válida.
 */
export function cutTimeOf(firstWriteUtc: string): string {
  const at = Date.parse(firstWriteUtc);
  if (Number.isNaN(at)) {
    throw new TypeError('La primera escritura de un log es una hora UTC válida.');
  }
  const date = new Date(at);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // `getUTCDay`: 0 el domingo y 1 el lunes. Los días hasta el lunes siguiente, de 1 a 7.
  const days = (8 - date.getUTCDay()) % 7 || 7;
  return new Date(midnight + days * DAY_MS).toISOString();
}

/**
 * Si el log está limpio para cortarlo (ADR-0018 §6), según su estado vivo: conectado, sin
 * continuidad pendiente y sin `connection_lost` abierta. Una `event_gap_unresolved` abierta no lo
 * impide, porque F1.5 no vuelve a intentar una recuperación agotada y bloquearía el corte para
 * siempre.
 */
export function isCleanForCut(
  view: Pick<
    LiveDerivationView,
    'connectedInLog' | 'openConditionTypes' | 'pendingContinuitySymbols'
  >,
): boolean {
  return (
    view.connectedInLog &&
    view.pendingContinuitySymbols.length === 0 &&
    !view.openConditionTypes.includes('connection_lost')
  );
}

/** El log siguiente a `number`, o `null` después del último. */
function nextLog(number: number): LogLocation | null {
  return number >= MAX_LOG_NUMBER ? null : logLocation(number + 1);
}

/**
 * Cómo está un log para empezar a capturar en él (ADR-0018 §6): `ready` si está preparado, porque
 * existe, se puede leer, no tiene escrituras y tiene todas las migraciones del worker;
 * `migrations_pending` si solo le faltan migraciones, como tras un despliegue que trae una, hasta
 * que `buoh-operaciones` la aplica; y `not_prepared` si no existe, no se puede leer o ya tiene
 * escrituras.
 */
export type LogReadiness = 'migrations_pending' | 'not_prepared' | 'ready';

/** Las lecturas de PostgreSQL del corte, sin escribir nada: `openStartupReads` en `ingest`. */
export interface LogCutReads {
  /** El log activo de la fuente (`findActiveLog`), o `null` si no hay ninguno preparado. */
  locateLog(): Promise<LogLocation | null>;
  /** La primera escritura de la fuente en el log (`firstWriteOf`), o `null` si no tiene ninguna. */
  firstWrite(log: LogLocation): Promise<string | null>;
  /** Cómo está el log para empezar a capturar en él (`LogReadiness`). */
  readiness(log: LogLocation): Promise<LogReadiness>;
}

/**
 * El log en el que captura `ingest` en `production` y, si se salta el activo, cuál.
 * `skipped` es el log activo cuya hora de corte pasó hace 24 horas o más al arrancar.
 */
export interface CaptureTarget {
  readonly log: LogLocation;
  readonly skipped: LogLocation | null;
}

/**
 * El log en el que captura `ingest` en `production` (ADR-0018 §6), sin escribir nada:
 *
 * - con `after`, el número del log que el mismo proceso acaba de cortar, el siguiente a ese,
 *   mientras el activo no lo haya pasado;
 * - si no, el log activo, también si su hora de corte ya pasó: entonces la sesión retoma ese log para
 *   buscar el momento limpio, como si no se hubiera parado («Al arrancar»). Pasadas 24 horas desde
 *   la hora de corte, ya no vuelve a escribir en él: el log es el siguiente, y el activo queda en
 *   `skipped`.
 *
 * El log siguiente vale si está preparado o si solo le faltan migraciones: la espera del arranque las
 * comprueba después y espera con `migrations_pending` (ADR-0018 §4). `null` si no hay log activo o si
 * el siguiente no está preparado: la espera lo trata como `log_not_prepared`. La hora se toma después
 * de leer, como en `findActiveLog`. Rechaza si PostgreSQL no responde.
 */
export async function locateCaptureLog(
  reads: LogCutReads,
  input: { readonly after: number | null; readonly now: () => string },
): Promise<CaptureTarget | null> {
  const active = await reads.locateLog();
  if (active === null) {
    return null;
  }
  if (input.after !== null && active.number <= input.after) {
    const next = nextLog(input.after);
    return next !== null && (await usable(reads, next)) ? { log: next, skipped: null } : null;
  }
  const first = await reads.firstWrite(active);
  if (first === null) {
    return { log: active, skipped: null };
  }
  const forcedAt = Date.parse(cutTimeOf(first)) + LOG_CUT_FORCE_AFTER_MS;
  if (Date.parse(input.now()) < forcedAt) {
    return { log: active, skipped: null };
  }
  const next = nextLog(active.number);
  return next !== null && (await usable(reads, next)) ? { log: next, skipped: active } : null;
}

/** Si la espera del arranque puede ir al log: preparado o solo con migraciones pendientes. */
async function usable(reads: Pick<LogCutReads, 'readiness'>, log: LogLocation): Promise<boolean> {
  return (await reads.readiness(log)) !== 'not_prepared';
}

/** Lo que el corte necesita de la sesión del log: su estado vivo, si sigue y la parada. */
export interface LogCutSession {
  /** `DerivSession.liveView`. */
  liveView(): Promise<LiveDerivationView | null>;
  /** `DerivSession.running`: `false` desde que se pidió su parada o terminó. */
  running(): boolean;
  /** La parada pedida (ADR-0015 §3, «Parada»). */
  stop(): void;
}

/** Un corte decidido: el log que se corta, el siguiente y si fue forzado. */
export interface LogCutDecision {
  /** Sin un momento limpio, a las 24 horas de la hora de corte. */
  readonly forced: boolean;
  readonly log: LogLocation;
  readonly next: LogLocation;
}

export interface LogCutWatchInput {
  /** Recibe las alertas saneadas `log_cut`, `log_cut_forced`, `log_cut_blocked` y `log_cut_check_unavailable`. */
  readonly alert: OperationalAlert;
  /** El log de la sesión. */
  readonly log: LogLocation;
  /** La hora UTC con milisegundos (`toISOString()`). */
  readonly now: () => string;
  /** Justo antes de pedir la parada del corte: quien la llama retiene el bloqueo para la sesión siguiente. */
  readonly onCut: (decision: LogCutDecision) => void;
  readonly reads: Pick<LogCutReads, 'firstWrite' | 'readiness'>;
  readonly scheduler: Scheduler;
  readonly session: LogCutSession;
}

/**
 * La vigilancia del corte de un log mientras su sesión captura (ADR-0018 §6). Mira cada
 * `LOG_CUT_CHECK_MS` como mucho, y nunca dos veces a la vez:
 *
 * 1. la primera escritura del log, hasta que la tiene, y con ella la hora de corte (`cutTimeOf`),
 *    que no cambia con los reinicios;
 * 2. antes de esa hora, solo el reloj;
 * 3. desde ella, si el log siguiente está preparado (`readiness`): si no, deja `log_cut_blocked`,
 *    con `next_log_not_prepared` o, si solo le faltan migraciones, `next_log_migrations_pending`,
 *    al cambiar el motivo y, mientras no cambia, como mucho una vez cada
 *    `LOG_CUT_ALERT_INTERVAL_MS`, y sigue en este log;
 * 4. si lo está, si el log está limpio (`isCleanForCut`), salvo a partir de las 24 horas de la hora
 *    de corte, cuando corta igual, con la alerta `log_cut_forced` y lo que quedó abierto.
 *
 * Al cortar deja la alerta `log_cut`, llama a `onCut` y pide la parada a la sesión, sin esperar nada
 * entre las tres cosas. Si la sesión ya no sigue, porque una señal la paró o terminó por su cuenta,
 * no corta ni deja ninguna alerta. Una lectura que falla deja `log_cut_check_unavailable` con su
 * motivo saneado y se vuelve a intentar: la captura va antes que el corte. `stop` la detiene sin
 * cortar.
 */
export class LogCutWatch {
  readonly #input: LogCutWatchInput;
  /** La hora de corte en ms desde la época, cuando se conoce la primera escritura. */
  #cutAt: number | null = null;
  #decision: LogCutDecision | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #lastBlockedAlertMs: number | null = null;
  #lastBlockedReason: string | null = null;

  constructor(input: LogCutWatchInput) {
    this.#input = input;
  }

  /** El corte decidido, o `null` si no lo hubo. */
  get decision(): LogCutDecision | null {
    return this.#decision;
  }

  /** Empieza a mirar enseguida. */
  start(): void {
    this.#schedule(0);
  }

  /** Deja de mirar, sin cortar. */
  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
  }

  /** Si se detuvo: un método, porque la vigilancia puede detenerse mientras espera una lectura. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  #schedule(ms: number): void {
    if (this.#stopped) {
      return;
    }
    this.#cancel = this.#input.scheduler.schedule(Math.max(0, ms), () => {
      this.#cancel = null;
      void this.#check();
    });
  }

  async #check(): Promise<void> {
    const { alert, log, reads, session } = this.#input;
    try {
      if (this.#cutAt === null) {
        const first = await reads.firstWrite(log);
        if (this.#isStopped()) {
          return;
        }
        if (first === null) {
          this.#schedule(LOG_CUT_CHECK_MS);
          return;
        }
        this.#cutAt = Date.parse(cutTimeOf(first));
      }
      const nowMs = Date.parse(this.#input.now());
      if (nowMs < this.#cutAt) {
        this.#schedule(Math.min(LOG_CUT_CHECK_MS, this.#cutAt - nowMs));
        return;
      }
      const next = nextLog(log.number);
      if (next === null) {
        // Después del último log no hay a dónde cortar: la captura sigue en este.
        return;
      }
      const readiness = await reads.readiness(next);
      if (this.#isStopped()) {
        return;
      }
      if (readiness !== 'ready') {
        this.#blocked(
          nowMs,
          next,
          readiness === 'migrations_pending'
            ? 'next_log_migrations_pending'
            : 'next_log_not_prepared',
        );
        this.#schedule(LOG_CUT_CHECK_MS);
        return;
      }
      const forcedAt = this.#cutAt + LOG_CUT_FORCE_AFTER_MS;
      const forced = nowMs >= forcedAt;
      let view: LiveDerivationView | null = null;
      if (!forced) {
        view = await session.liveView();
        if (this.#isStopped()) {
          return;
        }
        if (view === null || !isCleanForCut(view)) {
          this.#schedule(Math.min(LOG_CUT_CHECK_MS, forcedAt - nowMs));
          return;
        }
      } else {
        // Lo que quedó abierto, para la alerta; sin él, la alerta lo dice con `null`.
        view = await session.liveView().catch(() => null);
        if (this.#isStopped() || !session.running()) {
          return;
        }
        alert({
          event: 'log_cut_forced',
          log: String(log.number),
          next: String(next.number),
          open_condition_types: view === null ? null : view.openConditionTypes.join(','),
          pending_continuity:
            view === null ? null : String(view.pendingContinuitySymbols.length > 0),
          reason: 'clean_moment_not_reached',
        });
      }
      // Una sesión que una señal paró, o que terminó, no se corta: lo que siga lo decide su fin.
      if (!session.running()) {
        return;
      }
      const decision: LogCutDecision = { forced, log, next };
      this.#decision = decision;
      this.#stopped = true;
      alert({
        event: 'log_cut',
        forced: String(forced),
        log: String(log.number),
        next: String(next.number),
      });
      this.#input.onCut(decision);
      session.stop();
    } catch (error) {
      if (this.#isStopped()) {
        return;
      }
      alert({
        event: 'log_cut_check_unavailable',
        log: String(log.number),
        reason: failureReason(error),
      });
      this.#schedule(LOG_CUT_CHECK_MS);
    }
  }

  /**
   * `log_cut_blocked` con su motivo: al cambiar el motivo y, mientras no cambia, como mucho una vez
   * cada `LOG_CUT_ALERT_INTERVAL_MS`, también si el reloj retrocede.
   */
  #blocked(nowMs: number, next: LogLocation, reason: string): void {
    const last = this.#lastBlockedAlertMs;
    const elapsed = last === null ? Number.POSITIVE_INFINITY : nowMs - last;
    if (reason !== this.#lastBlockedReason || elapsed >= LOG_CUT_ALERT_INTERVAL_MS || elapsed < 0) {
      this.#input.alert({
        event: 'log_cut_blocked',
        log: String(this.#input.log.number),
        next: String(next.number),
        reason,
      });
      this.#lastBlockedAlertMs = nowMs;
      this.#lastBlockedReason = reason;
    }
  }
}

/**
 * Cómo suelta la sesión de un log su bloqueo de la fuente, que no se suelta en un corte (ADR-0018 §6,
 * «Cortar»): es su `releaseLock`. Con `retain`, el bloqueo con el que termina la sesión, si todavía
 * está tomado, no se suelta, sino que se guarda para la sesión del log siguiente (`takeRetained`).
 * Así ningún otro proceso, como el de un despliegue que espera el bloqueo cada segundo, escribe
 * entre las dos sesiones. El bloqueo sigue siendo el mismo objeto, como el `SourceLock` que pide
 * `openLockedSourceLog`. Sin `retain`, lo suelta.
 */
export class LockRetention {
  #retain = false;
  #retained: SessionLock | null = null;

  /** El `releaseLock` de la sesión. */
  readonly release = async (lock: SessionLock): Promise<void> => {
    if (this.#retain && lock.held && this.#retained === null) {
      this.#retained = lock;
      return;
    }
    await lock.release();
  };

  /** Desde aquí, el bloqueo que suelta la sesión, si sigue tomado, se guarda en lugar de soltarse. */
  retain(): void {
    this.#retain = true;
  }

  /** El bloqueo guardado, que pasa a quien lo pide y deja de estar aquí, o `null`. */
  takeRetained(): SessionLock | null {
    const lock = this.#retained;
    this.#retained = null;
    return lock;
  }
}
