import { BuohLogo, BuohMark, Icon } from '@buoh/design-system/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PAGES, RISK_SHORT, TAGLINE, TRADEMARK_NOTE } from './content';
import { SiteNavLink } from './SiteNavLink';

/**
 * Marco común del sitio oficial (docs/diseno/sitio-oficial.md §3): cabecera con el menú, y pie con el
 * aviso de riesgo, la nota de marcas de terceros y la declaración de privacidad en todas las páginas.
 */
export function SiteHeader() {
  return (
    <header className="s-header">
      <div className="s-container s-header__inner">
        <Link href="/" className="s-header__home" aria-label="buoh, inicio">
          <BuohLogo size={32} />
        </Link>
        <nav aria-label="Secciones del sitio" className="s-nav">
          {PAGES.filter((page) => page.href !== '/').map((page) => (
            <SiteNavLink key={page.href} href={page.href} label={page.label} />
          ))}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="s-footer">
      <div className="s-container s-footer__grid">
        <div className="s-footer__brand">
          <BuohMark size={40} title={null} />
          <p className="s-footer__tagline">{TAGLINE}</p>
          <p className="b-muted s-small">buoh está en desarrollo y por ahora es de uso propio.</p>
        </div>
        <div className="s-footer__notes">
          <p className="s-footer__risk" role="note">
            <Icon name="alertTriangle" />
            <span>
              <strong>Aviso de riesgo.</strong> {RISK_SHORT}{' '}
              <Link href="/aviso-de-riesgo/">Leer el aviso completo</Link>.
            </span>
          </p>
          <p className="b-muted s-small">{TRADEMARK_NOTE}</p>
          <p className="b-muted s-small">
            Este sitio no tiene formularios ni usa cookies, y buoh no recoge datos personales.
          </p>
        </div>
        <nav aria-label="Mapa del sitio" className="s-footer__nav">
          {PAGES.map((page) => (
            <Link key={page.href} href={page.href}>
              {page.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function SiteFrame({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <a className="s-skip" href="#contenido">
        Saltar al contenido
      </a>
      <SiteHeader />
      <main id="contenido" className="s-main">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

export function PageIntro({
  eyebrow,
  title,
  summary,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
}) {
  return (
    <section className="s-intro">
      <div className="s-container">
        <p className="b-eyebrow">{eyebrow}</p>
        <h1 className="s-intro__title">{title}</h1>
        <p className="s-intro__summary">{summary}</p>
      </div>
    </section>
  );
}

export function Section({
  title,
  lead,
  children,
  id,
}: {
  readonly title: string;
  readonly lead?: string;
  readonly children: ReactNode;
  readonly id?: string;
}) {
  return (
    <section className="s-section" id={id}>
      <div className="s-container">
        <h2 className="s-section__title">{title}</h2>
        {lead === undefined ? null : <p className="s-section__lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}
