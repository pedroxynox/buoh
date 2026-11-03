'use client';

import { Icon } from '@buoh/design-system/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiCallError, describeFailure } from './auth/api';

type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly csrfToken: string };

/** La misma insignia de usuario que la barra superior del escritorio, mientras se lee la sesión. */
function OwnerBadge() {
  return (
    <>
      <Icon name="user" />
      <span className="w-topbar__user-name">Propietario</span>
    </>
  );
}

/**
 * Menú de la sesión en la barra superior de la web servida por la API (ADR-0019 §2 y §9). Al abrir
 * la página lee la sesión con `GET /api/v1/sesion`, que además renueva su inactividad y devuelve el
 * token CSRF que necesitan los cierres. Con sesión, ofrece cerrarla y cerrar las demás; sin sesión,
 * un enlace para iniciarla. Mientras lee, muestra la misma insignia que el escritorio.
 */
export function SessionMenu() {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    let active = true;
    api
      .session()
      .then((info) => {
        if (active) setState({ kind: 'authenticated', csrfToken: info.csrf_token });
      })
      .catch(() => {
        if (active) setState({ kind: 'anonymous' });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const details = ref.current;
    if (details === null) return undefined;
    const close = () => {
      details.removeAttribute('open');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && details.open) {
        close();
        details.querySelector('summary')?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [state.kind]);

  if (state.kind === 'loading') {
    return (
      <span className="w-topbar__user">
        <OwnerBadge />
      </span>
    );
  }

  if (state.kind === 'anonymous') {
    return (
      <Link className="w-topbar__signin" href="/acceso">
        <Icon name="user" />
        <span>Iniciar sesión</span>
      </Link>
    );
  }

  const { csrfToken } = state;

  async function logout() {
    if (busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      await api.logout(csrfToken);
      window.location.assign('/acceso');
    } catch (caught) {
      setBusy(false);
      setNote(caught instanceof ApiCallError ? describeFailure(caught.failure) : 'No se pudo.');
    }
  }

  async function closeOthers() {
    if (busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const { closed } = await api.closeOthers(csrfToken);
      setNote(
        closed === 0
          ? 'No había otras sesiones.'
          : closed === 1
            ? 'Se cerró 1 sesión.'
            : `Se cerraron ${String(closed)} sesiones.`,
      );
    } catch (caught) {
      setNote(caught instanceof ApiCallError ? describeFailure(caught.failure) : 'No se pudo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details ref={ref} className="w-usermenu">
      <summary className="w-topbar__user w-usermenu__summary">
        <OwnerBadge />
      </summary>
      <div className="w-usermenu__menu" role="menu">
        {note === undefined ? null : <p className="w-usermenu__note">{note}</p>}
        <button
          type="button"
          className="w-usermenu__item"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            void logout();
          }}
        >
          <Icon name="power" />
          Cerrar sesión
        </button>
        <button
          type="button"
          className="w-usermenu__item"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            void closeOthers();
          }}
        >
          <Icon name="circleSlash" />
          Cerrar las demás sesiones
        </button>
      </div>
    </details>
  );
}
