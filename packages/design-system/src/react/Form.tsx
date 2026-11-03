import type { InputHTMLAttributes, ReactNode } from 'react';
import type { IconName } from '../icons.js';
import type { Tone } from '../tokens.js';
import { Icon } from './Icon.js';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** Obligatorio: une la etiqueta con el campo y nombra sus pistas y su error. */
  readonly id: string;
  readonly label: ReactNode;
  /** Pista bajo la etiqueta; se anuncia con `aria-describedby`. */
  readonly hint?: ReactNode;
  /** Mensaje de error; marca el campo inválido y se anuncia como alerta. */
  readonly error?: ReactNode;
  /** Cifras y tokens en la tipografía monoespaciada, como el resto del producto. */
  readonly mono?: boolean;
}

/**
 * Un campo de formulario accesible: etiqueta, campo y, si hacen falta, una pista y un error, unidos
 * por su `id` (guía de marca; concepto de interfaz §4). No fija el tipo ni los atributos para los
 * gestores de contraseñas: los pone quien lo usa (`autoComplete`, `inputMode`, `pattern`…).
 */
export function Field({ id, label, hint, error, mono = false, className, ...input }: FieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value): value is string => value !== undefined);
  const classes = [mono ? 'b-input b-input--mono' : 'b-input', className].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return (
    <div className="b-field">
      <label className="b-field__label" htmlFor={id}>
        {label}
      </label>
      {hint === undefined ? null : (
        <span className="b-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      <input
        id={id}
        className={classes.join(' ')}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy.join(' ')}
        {...input}
      />
      {error === undefined ? null : (
        <span className="b-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Un mensaje en bloque para el resultado de una acción: éxito, aviso o error de un formulario, con un
 * icono y un texto. El tono es semántico (nunca solo color); sin tono usa el neutro de la superficie.
 */
export function Callout({
  tone,
  icon,
  title,
  children,
}: {
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="b-callout" data-tone={tone} role="note">
      {title === undefined ? null : (
        <p className="b-callout__title">
          {icon === undefined ? null : <Icon name={icon} />}
          {title}
        </p>
      )}
      {children === undefined ? null : <div>{children}</div>}
    </div>
  );
}
