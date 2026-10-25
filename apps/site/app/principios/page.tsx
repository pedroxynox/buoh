import { Icon } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { NEVER, PRINCIPLES } from '../../src/content';
import { PageIntro, Section } from '../../src/Frame';

export const metadata: Metadata = { title: 'Principios' };

export default function PrincipiosPage() {
  return (
    <>
      <PageIntro
        eyebrow="Principios"
        title="Lo que buoh hace y lo que nunca hará"
        summary="Un búho observa con paciencia y actúa solo cuando ve con claridad. Estas reglas valen para el código, para las pantallas y para este sitio."
      />

      <Section title="Cómo trabajamos">
        <div className="s-grid s-grid--3">
          {PRINCIPLES.map((principle) => (
            <article key={principle.title} className="s-tile">
              <span className="s-tile__icon">
                <Icon name={principle.icon} />
              </span>
              <h3 className="s-tile__title">{principle.title}</h3>
              <p className="b-secondary">{principle.text}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="Lo que nunca hará">
        <ul className="s-never">
          {NEVER.map((item) => (
            <li key={item}>
              <Icon name="circleSlash" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Cómo se mostrará un resultado"
        lead="Cuando haya resultados, ninguna cifra irá sola. Esto es lo que acompañará a cada una."
      >
        <dl className="s-context">
          {[
            ['Modo', 'Backtest, shadow, demo o real.'],
            ['Período', 'Desde cuándo y hasta cuándo.'],
            ['Muestra', 'Cuántas operaciones o señales.'],
            ['Costes', 'Qué costes y retrasos se supusieron.'],
            ['Pérdidas', 'Cuántas salieron mal.'],
            ['Caída máxima', 'La peor racha desde un máximo.'],
            ['Versión', 'Qué estrategia exacta lo produjo.'],
            ['Limitaciones', 'Lo que la cifra no demuestra.'],
          ].map(([term, text]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
