import { ICONS, type IconName } from '../icons.js';

export interface IconProps {
  readonly name: IconName;
  /** Texto para lectores de pantalla. Sin él, el icono es decorativo. */
  readonly label?: string;
  readonly className?: string;
}

export function Icon({ name, label, className }: IconProps) {
  const classes = className === undefined ? 'b-icon' : `b-icon ${className}`;
  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      focusable="false"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
