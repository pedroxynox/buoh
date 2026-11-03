'use client';

import { Callout, Card, Field } from '@buoh/design-system/react';
import { useState } from 'react';
import { api, ApiCallError, describeFailure } from './api';

/**
 * Pantalla de inicio de sesión de la web servida por la API (ADR-0019 §1, §2 y §9): usuario,
 * contraseña y un código de 6 cifras, los tres en el mismo formulario, con los atributos que esperan
 * los gestores de contraseñas. La respuesta nunca dice cuál de los tres falló. Al entrar, recarga en
 * el Observatorio para que la barra superior recupere la sesión.
 */
export function AccesoForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.login({ username, password, code });
      window.location.assign('/');
    } catch (caught) {
      setError(
        caught instanceof ApiCallError
          ? describeFailure(caught.failure)
          : 'Ocurrió un error inesperado. Inténtalo de nuevo.',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="w-auth">
      <header className="w-auth__head">
        <p className="b-eyebrow">Tu cuenta</p>
        <h1 className="w-page-header__title">Iniciar sesión</h1>
        <p className="w-page-header__summary">
          Entra con tu usuario, tu contraseña y el código de tu app de autenticación.
        </p>
      </header>
      <Card raised>
        <form
          className="b-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            id="acceso-usuario"
            label="Usuario"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            required
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
          <Field
            id="acceso-contrasena"
            label="Contraseña"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <Field
            id="acceso-codigo"
            label="Código de 6 cifras"
            name="code"
            type="text"
            mono
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            hint="El código que muestra tu app de autenticación."
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, ''));
            }}
          />
          {error === undefined ? null : (
            <Callout tone="rojo" icon="alertTriangle" title="No se pudo iniciar sesión">
              {error}
            </Callout>
          )}
          <button
            type="submit"
            className="b-button b-button--primary w-auth__submit"
            disabled={submitting}
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </Card>
    </div>
  );
}
