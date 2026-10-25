import { Badge, BuohMark, Icon, ModeBadge } from '@buoh/design-system/react';
import Link from 'next/link';
import { FAQ, MODES, PLANES, ROADMAP, TAGLINE } from '../src/content';
import { Section } from '../src/Frame';
import { PhaseStateBadge } from '../src/Pieces';

export default function InicioPage() {
  const now = ROADMAP.filter((phase) => phase.state === 'en curso');
  return (
    <>
      <section className="s-hero">
        <div className="s-hero__sky" aria-hidden="true" />
        <div className="s-container s-hero__inner">
          <div className="s-hero__text">
            <p className="b-eyebrow">Investigación · Señales · Ejecución controlada</p>
            <h1 className="s-hero__title">{TAGLINE}</h1>
            <p className="s-hero__summary">
              buoh es un sistema para estudiar el trading con datos fiables: investiga estrategias,
              emite señales que explican de dónde vienen y, solo si una puerta de calidad lo
              aprueba, ejecuta con límites de riesgo. Mide los resultados, incluidas las pérdidas.
              No promete ganancias.
            </p>
            <div className="s-hero__actions">
              <Link className="b-button b-button--primary" href="/como-funciona/">
                Cómo funciona
              </Link>
              <Link className="b-button b-button--secondary" href="/hoja-de-ruta/">
                Ver la hoja de ruta
              </Link>
            </div>
            <p className="s-hero__status">
              <Badge tone="cielo" icon="info">
                En desarrollo
              </Badge>
              <span className="b-muted s-small">
                Por ahora es de uso propio: no ofrece señales, cuentas ni ejecución.
              </span>
            </p>
          </div>
          <div className="s-hero__owl">
            <BuohMark size={220} title="El búho de buoh" />
          </div>
        </div>
      </section>

      <Section
        title="Tres planos que nunca se mezclan"
        lead="Investigar, avisar y operar son trabajos distintos. Pasar de uno a otro exige una puerta explícita."
      >
        <div className="s-grid s-grid--3">
          {PLANES.map((plane) => (
            <article key={plane.name} className="s-tile">
              <span className="s-tile__icon">
                <Icon name={plane.icon} />
              </span>
              <h3 className="s-tile__title">{plane.name}</h3>
              <p className="b-secondary">{plane.summary}</p>
              <p className="s-tile__never">{plane.never}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section
        title="Cuatro modos, siempre a la vista"
        lead="El modo dice qué puede hacer el bot. Se muestra en todas las pantallas, separado del estado del servicio."
      >
        <div className="s-grid s-grid--4">
          {MODES.map((item) => (
            <article key={item.mode} className="s-tile s-tile--compact">
              <ModeBadge mode={item.mode} />
              <p className="b-secondary">{item.meaning}</p>
              <p className="b-muted s-small">{item.phase}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="En qué estamos" lead="El estado real, sin adornos.">
        <div className="s-grid s-grid--2">
          {now.map((phase) => (
            <article key={phase.id} className="s-tile">
              <div className="s-row">
                <span className="b-num b-muted">
                  {phase.id === 'V1' ? 'Línea V1' : `Fase ${phase.id}`}
                </span>
                <PhaseStateBadge state={phase.state} />
              </div>
              <h3 className="s-tile__title">{phase.title}</h3>
              <p className="b-secondary">{phase.text}</p>
            </article>
          ))}
        </div>
        <p className="s-more">
          <Link className="s-link" href="/hoja-de-ruta/">
            Toda la hoja de ruta <Icon name="arrowUpRight" />
          </Link>
        </p>
      </Section>

      <Section title="Preguntas frecuentes">
        <dl className="s-faq">
          {FAQ.map((item) => (
            <div key={item.q} className="s-faq__item">
              <dt>{item.q}</dt>
              <dd>{item.a}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
