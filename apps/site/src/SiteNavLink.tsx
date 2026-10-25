'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Enlace del menú del sitio, de cliente porque necesita la ruta actual. A diferencia del de la web,
 * no trata `/` aparte: la cabecera nunca lo recibe (Frame.tsx filtra la portada).
 */
export function SiteNavLink({ href, label }: { readonly href: string; readonly label: string }) {
  const pathname = usePathname();
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return (
    <Link
      href={href}
      className="s-nav__link"
      aria-current={normalized.startsWith(href) ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}
