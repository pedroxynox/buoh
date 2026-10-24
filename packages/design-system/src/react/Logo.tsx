export interface BuohMarkProps {
  /** Lado en píxeles. Mínimo de la guía: 16. */
  readonly size?: number;
  /** `mono` dibuja solo contornos con `currentColor`. */
  readonly variant?: 'color' | 'mono';
  /** Nombre accesible. Con `null`, el símbolo es decorativo (por ejemplo, junto a la palabra «buoh»). */
  readonly title?: string | null;
}

function a11y(title: string | null) {
  return title === null
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': title } as const);
}

const HEAD = 'M10 14 13 5l7 6q4-1 8 0l7-6 3 9q4 8 1.5 17Q36 43 24 44 12 43 8.5 31 6 22 10 14Z';
const BEAK = 'M24 31.2 26 34l-2 3.2-2-3.2Z';

/** Símbolo de buoh: cara de búho geométrica con ojos ámbar (guía §4). */
export function BuohMark({ size = 32, variant = 'color', title = 'buoh' }: BuohMarkProps) {
  if (variant === 'mono') {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" {...a11y(title)}>
        <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
          <path d={HEAD} />
          <circle cx="18" cy="25" r="5.6" />
          <circle cx="30" cy="25" r="5.6" />
          <path d={BEAK} />
        </g>
        <circle cx="18.6" cy="25.4" r="1.8" fill="currentColor" />
        <circle cx="30.6" cy="25.4" r="1.8" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" {...a11y(title)}>
      <path d={HEAD} fill="var(--b-brand-head)" />
      <circle cx="18" cy="25" r="6.6" fill="var(--b-brand-eye-ring)" />
      <circle cx="30" cy="25" r="6.6" fill="var(--b-brand-eye-ring)" />
      <circle cx="18" cy="25" r="4.6" fill="var(--b-brand-iris)" />
      <circle cx="30" cy="25" r="4.6" fill="var(--b-brand-iris)" />
      <circle cx="18.6" cy="25.4" r="2" fill="var(--b-brand-eye-ring)" />
      <circle cx="30.6" cy="25.4" r="2" fill="var(--b-brand-eye-ring)" />
      <path d={BEAK} fill="var(--b-brand-iris)" />
    </svg>
  );
}

export interface BuohLogoProps {
  readonly size?: number;
  readonly variant?: 'color' | 'mono';
}

/** Logotipo completo: símbolo y palabra «buoh» en Manrope 700. */
export function BuohLogo({ size = 32, variant = 'color' }: BuohLogoProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${String(Math.round(size * 0.3))}px`,
        fontWeight: 700,
        fontSize: `${String(Math.round(size * 0.82))}px`,
        letterSpacing: '-0.02em',
        lineHeight: 1,
      }}
    >
      <BuohMark size={size} variant={variant} title={null} />
      <span>buoh</span>
    </span>
  );
}
