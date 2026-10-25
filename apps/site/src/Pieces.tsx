import { Badge } from '@buoh/design-system/react';
import type { PhaseState } from './content';

const STATE = {
  hecha: { tone: 'aurora', icon: 'check', label: 'Hecha' },
  'en curso': { tone: 'cielo', icon: 'rotate', label: 'En curso' },
  prevista: { tone: 'niebla', icon: 'clock', label: 'Prevista' },
} as const;

export function PhaseStateBadge({ state }: { readonly state: PhaseState }) {
  const s = STATE[state];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}
