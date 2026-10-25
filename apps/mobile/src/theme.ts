/**
 * Tema del prototipo móvil: los mismos tokens que la web (`@buoh/design-system`), convertidos a valores
 * de React Native. Solo tema noche, como el prototipo web.
 */
import { MIN_TOUCH_TARGET_PX, nightTheme, radius, typography } from '@buoh/design-system';

export const theme = nightTheme;

/** Familias cargadas con expo-font (Sen y JetBrains Mono, licencia OFL; ADR-0011). */
export const font = {
  regular: 'Sen_400Regular',
  medium: 'Sen_500Medium',
  semibold: 'Sen_600SemiBold',
  bold: 'Sen_700Bold',
  mono: 'JetBrainsMono_500Medium',
} as const;

const REM = 16;
const rem = (value: string) => Number.parseFloat(value) * REM;

export const size = {
  xs: rem(typography.size.xs),
  sm: rem(typography.size.sm),
  md: rem(typography.size.md),
  base: rem(typography.size.base),
  lg: rem(typography.size.lg),
  xl: rem(typography.size.xl),
  xxl: rem(typography.size['2xl']),
  xxxl: rem(typography.size['3xl']),
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const corner = {
  sm: Number.parseFloat(radius.sm),
  md: Number.parseFloat(radius.md),
  lg: Number.parseFloat(radius.lg),
  pill: 999,
} as const;

export const TOUCH = MIN_TOUCH_TARGET_PX;

/** Color con transparencia en formato `#RRGGBBAA`, que React Native acepta. */
export function withAlpha(hex: string, alpha: number): string {
  const channel = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${channel}`;
}
