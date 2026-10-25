'use client';

import type { IconName } from '@buoh/design-system';
import { Icon } from '@buoh/design-system/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  label,
  icon,
  lockedUntil,
  compact = false,
}: {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly lockedUntil?: string | undefined;
  readonly compact?: boolean;
}) {
  const pathname = usePathname();
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  const active = href === '/' ? normalized === '/' : normalized.startsWith(href);
  return (
    <Link
      href={href}
      className={compact ? 'w-nav__link w-nav__link--compact' : 'w-nav__link'}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={icon} />
      <span className="w-nav__label">{label}</span>
      {lockedUntil === undefined || compact ? null : (
        <span className="w-nav__phase" title={`Disponible en Fase ${lockedUntil}`}>
          <span className="b-visually-hidden">Disponible en Fase </span>
          {lockedUntil}
        </span>
      )}
    </Link>
  );
}
