import { Badge } from '@buoh/design-system/react';
import type { PhaseState } from './content';

/**
 * Las fases del producto no son estados del servicio: usan el tono neutro y sus propios iconos, para
 * no confundirse con `healthy` o `recovering` (guía de marca §7).
 */
const STATE = {
  hecha: { icon: 'flag', label: 'Hecha', strong: false },
  'en curso': { icon: 'progress', label: 'En curso', strong: true },
  prevista: { icon: 'clock', label: 'Prevista', strong: false },
} as const;

export function PhaseStateBadge({ state }: { readonly state: PhaseState }) {
  const s = STATE[state];
  return (
    <Badge tone="niebla" icon={s.icon} strong={s.strong}>
      {s.label}
    </Badge>
  );
}
