import {
  BuohLogo,
  FictitiousDataNotice,
  HealthBadge,
  Icon,
  ModeBadge,
} from '@buoh/design-system/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { GLOBAL_STATUS } from '@buoh/prototype-data';
import { NAV_ITEMS } from '../navigation';
import { MoreMenu } from './MoreMenu';
import { NavLink } from './NavLink';

/** Barra superior: marca, aviso de datos ficticios, modo y salud por separado (concepto §2). */
export function TopBar() {
  return (
    <header className="w-topbar">
      <div className="w-topbar__brand">
        <Link href="/" className="w-topbar__home" aria-label="buoh, ir al observatorio">
          <BuohLogo size={32} />
        </Link>
        <FictitiousDataNotice />
      </div>
      <div className="w-topbar__status" role="group" aria-label="Estado global">
        <ModeBadge mode={GLOBAL_STATUS.mode} showDescription />
        <HealthBadge health={GLOBAL_STATUS.health} />
        <span className="w-topbar__user">
          <Icon name="user" />
          <span className="w-topbar__user-name">Propietario</span>
        </span>
      </div>
    </header>
  );
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="w-shell">
      <a className="w-skip" href="#contenido">
        Saltar al contenido
      </a>
      <TopBar />
      <nav className="w-nav" aria-label="Secciones">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            lockedUntil={item.lockedUntil}
          />
        ))}
      </nav>
      <main id="contenido" className="w-main">
        {children}
      </main>
      <nav className="w-bottomnav" aria-label="Secciones principales">
        {NAV_ITEMS.filter((item) => item.primary).map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.shortLabel ?? item.label}
            icon={item.icon}
            compact
          />
        ))}
        <MoreMenu items={NAV_ITEMS.filter((item) => !item.primary)} />
      </nav>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  summary,
  actions,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="w-page-header">
      <div>
        <p className="b-eyebrow">{eyebrow}</p>
        <h1 className="w-page-header__title">{title}</h1>
        <p className="w-page-header__summary">{summary}</p>
      </div>
      {actions === undefined ? null : <div className="w-page-header__actions">{actions}</div>}
    </div>
  );
}
