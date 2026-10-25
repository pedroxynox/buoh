import type { Metadata } from 'next';
import { ROADMAP } from '../../src/content';
import { PageIntro, Section } from '../../src/Frame';
import { PhaseStateBadge } from '../../src/Pieces';

export const metadata: Metadata = { title: 'Hoja de ruta' };

export default function HojaDeRutaPage() {
  return (
    <>
      <PageIntro
        eyebrow="Hoja de ruta"
        title="Por puertas de calidad, no por fechas"
        summary="Cada fase empieza cuando la anterior demuestra lo que prometía. Si la evidencia no alcanza, se espera; no hay fechas que obliguen a correr."
      />

      <Section title="Fases">
        <ol className="s-roadmap">
          {ROADMAP.map((phase) => (
            <li
              key={phase.id}
              className={`s-roadmap__item s-roadmap__item--${phase.state.replace(' ', '-')}`}
            >
              <div className="s-roadmap__marker" aria-hidden="true" />
              <div className="s-roadmap__body">
                <div className="s-row">
                  <span className="b-num b-muted">
                    {phase.id === 'V1' ? 'Línea V1' : `Fase ${phase.id}`}
                  </span>
                  <PhaseStateBadge state={phase.state} />
                </div>
                <h3 className="s-roadmap__title">{phase.title}</h3>
                <p className="b-secondary">{phase.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
