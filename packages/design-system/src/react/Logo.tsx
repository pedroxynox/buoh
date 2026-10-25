import { LOGO_LOCKUP, LOGO_SYMBOL, LOGO_WORDMARK } from '../logo.js';

export interface BuohMarkProps {
  /** Alto en píxeles. Mínimo de la guía: 16. */
  readonly size?: number;
  /** `mono` usa una sola tinta (`currentColor`), con los detalles separados por un hueco. */
  readonly variant?: 'color' | 'mono';
  /** Nombre accesible. Con `null`, el símbolo es decorativo (por ejemplo, junto a la palabra «buoh»). */
  readonly title?: string | null;
}

function a11y(title: string | null) {
  return title === null
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': title } as const);
}

const SYMBOL_RATIO = LOGO_SYMBOL.width / LOGO_SYMBOL.height;
const LOCKUP_RATIO = LOGO_LOCKUP.width / LOGO_LOCKUP.height;

function SymbolPaths({ variant }: { readonly variant: 'color' | 'mono' }) {
  if (variant === 'mono') {
    return <path d={LOGO_SYMBOL.mono} fill="currentColor" />;
  }
  return (
    <>
      <path d={LOGO_SYMBOL.primary} fill="var(--b-brand-mark)" />
      <path d={LOGO_SYMBOL.detail} fill="var(--b-brand-mark-detail)" />
    </>
  );
}

/** Símbolo de buoh: búho de orejas cruzadas, vectorizado del logo original (guía §4). */
export function BuohMark({ size = 32, variant = 'color', title = 'buoh' }: BuohMarkProps) {
  return (
    <svg
      width={Math.round(size * SYMBOL_RATIO * 100) / 100}
      height={size}
      viewBox={LOGO_SYMBOL.viewBox}
      {...a11y(title)}
    >
      <SymbolPaths variant={variant} />
    </svg>
  );
}

export interface BuohLogoProps {
  /** Alto en píxeles del conjunto (el del símbolo). Con 31 o más, el ancho cumple el mínimo de la guía. */
  readonly size?: number;
  readonly variant?: 'color' | 'mono';
}

/** Logotipo completo: símbolo y palabra «buoh» vectorizada, en la proporción del original. */
export function BuohLogo({ size = 32, variant = 'color' }: BuohLogoProps) {
  return (
    <svg
      width={Math.round(size * LOCKUP_RATIO * 100) / 100}
      height={size}
      viewBox={LOGO_LOCKUP.viewBox}
      role="img"
      aria-label="buoh"
    >
      <SymbolPaths variant={variant} />
      <path
        d={LOGO_WORDMARK.d}
        fill={variant === 'mono' ? 'currentColor' : 'var(--b-brand-mark-detail)'}
      />
    </svg>
  );
}
