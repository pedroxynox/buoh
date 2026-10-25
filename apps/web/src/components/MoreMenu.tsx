'use client';

import { Icon } from '@buoh/design-system/react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { NavItem } from '../navigation';
import { NavLink } from './NavLink';

/**
 * Menú «Más» de la barra inferior (móvil y tablet). Usa `<details>`, que funciona con teclado y sin
 * JavaScript. Se cierra al cambiar de página, con Escape y al tocar fuera.
 */
export function MoreMenu({ items }: { readonly items: readonly NavItem[] }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    ref.current?.removeAttribute('open');
  }, [pathname]);
  useEffect(() => {
    const details = ref.current;
    if (details === null) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && details.open) {
        details.open = false;
        details.querySelector('summary')?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  const current = items.some((item) => item.href !== '/' && normalized.startsWith(item.href));
  return (
    <details ref={ref} className="w-more">
      <summary
        className="w-nav__link w-nav__link--compact"
        aria-current={current ? 'page' : undefined}
      >
        <Icon name="layers" />
        <span className="w-nav__label">Más</span>
      </summary>
      <div className="w-more__menu">
        {items.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            lockedUntil={item.lockedUntil}
          />
        ))}
      </div>
    </details>
  );
}
