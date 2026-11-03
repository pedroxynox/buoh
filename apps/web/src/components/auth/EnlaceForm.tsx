'use client';

import type { LinkSecret, LinkUse } from '@buoh/contracts';
import { Callout, Card, Field } from '@buoh/design-system/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiCallError, describeFailure } from './api';
import { Qr } from './Qr';

/** Un token de enlace es 43 caracteres base64url (ADR-0019 §3); el servidor lo valida de verdad. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function messageOf(caught: unknown): string {
  return caught instanceof ApiCallError
    ? describeFailure(caught.failure)
    : 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

/**
 * Pantalla del enlace de alta y de restablecimiento (ADR-0019 §3 y §9). El token viaja en el
 * fragmento de la dirección (`/enlace/#…`), que el navegador no envía al servidor; la página lo lee
 * y pide el secreto TOTP, muestra su QR y su texto, y termina con la contraseña nueva y un código.
 * Recargar pide otro secreto: vale el último.
 */
export function EnlaceForm() {
  const [token, setToken] = useState<string | undefined>(undefined);
  const [secret, setSecret] = useState<LinkSecret | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<LinkUse['result'] | undefined>(undefined);
  const started = useRef(false);

  async function loadSecret(linkToken: string) {
    if (!LINK_TOKEN.test(linkToken)) {
      setToken(undefined);
      setSecret(undefined);
      setLoading(false);
      setLoadError('El enlace no es válido. Pide uno nuevo.');
      return;
    }
    setToken(linkToken);
    setLoading(true);
    setLoadError(undefined);
    try {
      setSecret(await api.linkSecret(linkToken));
    } catch (caught) {
      setSecret(undefined);
      setLoadError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadSecret(window.location.hash.replace(/^#/, ''));
  }, []);

  async function submit() {
    if (submitting || token === undefined) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const result = await api.useLink({ token, password, code });
      setDone(result.result);
    } catch (caught) {
      setSubmitError(messageOf(caught));
      setSubmitting(false);
      // Un enlace que dejó de valer: deja de mostrar el formulario.
      if (caught instanceof ApiCallError && caught.failure.code === 'invalid_link') {
        setSecret(undefined);
        setLoadError(describeFailure(caught.failure));
      }
    }
  }

  const isReset = secret?.purpose === 'reset';
  const title = isReset ? 'Restablece tu credencial' : 'Da de alta tu cuenta';

  return (
    <div className="w-auth">
      <header className="w-auth__head">
        <p className="b-eyebrow">Tu cuenta</p>
        <h1 className="w-page-header__title">{title}</h1>
        <p className="w-page-header__summary">
          Escanea el código con tu app de autenticación, elige una contraseña y confirma con un
          código.
        </p>
      </header>

      {done !== undefined ? (
        <Card raised>
          <Callout
            tone="aurora"
            icon="check"
            title={
              done === 'credential_reset'
                ? 'Tu credencial quedó restablecida'
                : 'Tu cuenta quedó dada de alta'
            }
          >
            Ya puedes iniciar sesión con tu usuario, tu contraseña y un código.
          </Callout>
          <div className="w-auth__foot">
            <Link className="b-button b-button--primary w-auth__submit" href="/acceso">
              Ir a iniciar sesión
            </Link>
          </div>
        </Card>
      ) : loading ? (
        <Card raised>
          <p className="b-secondary">Leyendo el enlace…</p>
        </Card>
      ) : loadError !== undefined ? (
        <Card raised>
          <Callout tone="rojo" icon="alertTriangle" title="No se pudo usar el enlace">
            {loadError}
          </Callout>
        </Card>
      ) : secret === undefined ? null : (
        <Card raised>
          <p className="b-secondary w-small">
            Cuenta: <strong>{secret.username}</strong>
          </p>
          <div className="w-qr-wrap">
            <Qr
              value={secret.totp.uri}
              label="Código QR del secreto para tu app de autenticación"
            />
          </div>
          <p className="b-muted w-small">Si no puedes escanear, escribe este código en tu app:</p>
          <p className="w-secret" aria-label="Secreto en texto">
            {secret.totp.secret}
          </p>
          <form
            className="b-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field
              id="enlace-contrasena"
              label="Contraseña nueva"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              hint="Al menos 15 caracteres."
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <Field
              id="enlace-codigo"
              label="Código de 6 cifras"
              name="code"
              type="text"
              mono
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, ''));
              }}
            />
            {submitError === undefined ? null : (
              <Callout tone="rojo" icon="alertTriangle" title="No se pudo terminar">
                {submitError}
              </Callout>
            )}
            <button
              type="submit"
              className="b-button b-button--primary w-auth__submit"
              disabled={submitting}
            >
              {submitting ? 'Guardando…' : isReset ? 'Restablecer' : 'Dar de alta'}
            </button>
            <button
              type="button"
              className="b-button b-button--quiet"
              disabled={submitting || token === undefined}
              onClick={() => {
                if (token !== undefined) void loadSecret(token);
              }}
            >
              Mostrar otro código
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
