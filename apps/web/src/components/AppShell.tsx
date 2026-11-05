import {
  BuohLogo,
  FictitiousDataNotice,
  HealthBadge,
  Icon,
  ModeBadge,
} from '@buoh/design-system/react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { GLOBAL_STATUS } from '@buoh/prototype-data';
import { NAV_ITEMS } from '../navigation';
import { API_EXECUTION_MODE } from './modo';
import { MoreMenu } from './MoreMenu';
import { NavLink } from './NavLink';

// La variante de la API muestra el menú de la sesión, la salud real de los datos y la marca de datos
// ficticios solo en las secciones que siguen con ellos; la del escritorio, la insignia estática del
// propietario, la salud ficticia y la marca en todas. La variable de compilación, que Next inlinea,
// deja que el empaquetador quite del escritorio el menú y todo lo que llama a la API (ADR-0019 §9;
// `F2-UI-001`). Cada condición la compara entera: con una constante intermedia, el empaquetador no la
// resolvería y dejaría en el escritorio los fragmentos de la API.
const SessionMenu =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() => import('./SessionMenu').then((module) => module.SessionMenu))
    : null;
const SaludBadge =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() => import('./salud/SaludBadge').then((module) => module.SaludBadge))
    : null;
const FictitiousDataMark =
  process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
    ? dynamic(() => import('./FictitiousDataMark').then((module) => module.FictitiousDataMark))
    : null;

/** Barra superior: marca, aviso de datos ficticios, modo y salud por separado (concepto §2 y §10). */
export function TopBar() {
  return (
    <header className="w-topbar">
      <div className="w-topbar__brand">
        <Link href="/" className="w-topbar__home" aria-label="buoh, ir al observatorio">
          <BuohLogo size={32} />
        </Link>
        {FictitiousDataMark === null ? <FictitiousDataNotice /> : <FictitiousDataMark />}
      </div>
      <div className="w-topbar__status" role="group" aria-label="Estado global">
        <ModeBadge
          mode={
            process.env.NEXT_PUBLIC_BUOH_WEB_TARGET === 'api'
              ? API_EXECUTION_MODE
              : GLOBAL_STATUS.mode
          }
          showDescription
        />
        {SaludBadge === null ? <HealthBadge health={GLOBAL_STATUS.health} /> : <SaludBadge />}
        {SessionMenu === null ? (
          <span className="w-topbar__user">
            <Icon name="user" />
            <span className="w-topbar__user-name">Propietario</span>
          </span>
        ) : (
          <SessionMenu />
        )}
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
