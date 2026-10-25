import { HealthBadge, Icon, ModeBadge } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { CYCLE, MODES } from '../../src/content';
import { PageIntro, Section } from '../../src/Frame';

export const metadata: Metadata = { title: 'Cómo funciona' };

export default function ComoFuncionaPage() {
  return (
    <>
      <PageIntro
        eyebrow="Cómo funciona"
        title="Del dato a la decisión, paso a paso"
        summary="Cada paso deja una huella que se puede revisar y ninguno se salta. Esta página describe el diseño: hoy existe la base de datos; lo demás llega por fases."
      />

      <Section title="El ciclo" lead="Seis pasos, con una puerta de calidad entre uno y otro.">
        <ol className="s-steps">
          {CYCLE.map((step) => (
            <li key={step.title} className="s-steps__item">
              <h3 className="s-steps__title">{step.title}</h3>
              <p className="b-secondary">{step.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title="Datos que se pueden comprobar"
        lead="La base de todo. Si los datos fallan, nada de lo que viene después vale."
      >
        <div className="s-grid s-grid--3">
          <article className="s-tile">
            <span className="s-tile__icon">
              <Icon name="database" />
            </span>
            <h3 className="s-tile__title">Crudo primero</h3>
            <p className="b-secondary">
              Cada mensaje de la fuente se guarda exactamente como llegó, antes de interpretarlo. Si
              el guardado falla, no se usa el dato.
            </p>
          </article>
          <article className="s-tile">
            <span className="s-tile__icon">
              <Icon name="gap" />
            </span>
            <h3 className="s-tile__title">Huecos a la vista</h3>
            <p className="b-secondary">
              Una desconexión deja un hueco. buoh intentará recuperarlo con la historia de la
              fuente; si no puede, lo marcará y el servicio pasará a degradado.
            </p>
          </article>
          <article className="s-tile">
            <span className="s-tile__icon">
              <Icon name="rotate" />
            </span>
            <h3 className="s-tile__title">Reproducible</h3>
            <p className="b-secondary">
              Cada lote publicado tiene un identificador. Volver a calcularlo desde los datos crudos
              debe dar exactamente el mismo identificador.
            </p>
          </article>
        </div>
      </Section>

      <Section
        title="Modo y salud: dos preguntas distintas"
        lead="El modo responde «¿qué puede hacer el bot?». La salud responde «¿están bien los datos?». Nunca se confunden."
      >
        <div className="s-grid s-grid--2">
          <article className="s-tile">
            <h3 className="s-tile__title">Modo de ejecución</h3>
            <ul className="s-list">
              {MODES.map((item) => (
                <li key={item.mode}>
                  <ModeBadge mode={item.mode} showDescription />
                  <span className="b-muted s-small">{item.phase}</span>
                </li>
              ))}
            </ul>
          </article>
          <article className="s-tile">
            <h3 className="s-tile__title">Salud del servicio</h3>
            <ul className="s-list">
              <li>
                <HealthBadge health="healthy" showDescription />
              </li>
              <li>
                <HealthBadge health="degraded" showDescription />
              </li>
              <li>
                <HealthBadge health="recovering" showDescription />
              </li>
              <li>
                <HealthBadge health="paused" showDescription />
              </li>
            </ul>
            <p className="b-muted s-small">
              Con datos degradados, las estrategias afectadas se pausarán solas.
            </p>
          </article>
        </div>
      </Section>

      <Section
        title="Quién puede enviar una orden"
        lead="Solo un servicio del servidor, y solo con todo en regla."
      >
        <div className="s-callout">
          <Icon name="shield" />
          <p>
            La futura pasarela de ejecución comprobará autorización, política de riesgo, calidad de
            datos, vencimiento de la señal, que la orden no esté repetida y que el interruptor de
            emergencia esté apagado. Si algo falla, no envía nada. Si la respuesta del bróker es
            dudosa, primero consulta y nunca reintenta a ciegas. La web, el móvil y el escritorio
            solo pueden ver, pedir al servidor y detener.
          </p>
        </div>
      </Section>
    </>
  );
}
