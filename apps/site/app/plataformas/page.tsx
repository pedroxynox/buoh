import { Badge, Icon } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { INTEGRATIONS, PLATFORMS, TRADEMARK_NOTE } from '../../src/content';
import { PageIntro, Section } from '../../src/Frame';

export const metadata: Metadata = { title: 'Plataformas' };

export default function PlataformasPage() {
  return (
    <>
      <PageIntro
        eyebrow="Plataformas"
        title="Dónde estará buoh"
        summary="Las mismas reglas en todas partes: ver, pedir y detener desde cualquier pantalla; operar, solo desde el servidor."
      />

      <Section title="Aplicaciones previstas">
        <div className="s-grid s-grid--3">
          {PLATFORMS.map((platform) => (
            <article key={platform.name} className="s-tile">
              <span className="s-tile__icon">
                <Icon name={platform.icon} />
              </span>
              <h3 className="s-tile__title">{platform.name}</h3>
              <p className="b-secondary">{platform.role}</p>
              <Badge tone="niebla" icon="clock">
                {platform.phase}
              </Badge>
            </article>
          ))}
        </div>
      </Section>

      <Section
        title="Integraciones previstas"
        lead="Cada fuente se guarda por separado: el mismo nombre en dos fuentes no se trata como el mismo instrumento."
      >
        <div className="s-grid s-grid--3">
          {INTEGRATIONS.map((integration) => (
            <article key={integration.name} className="s-tile">
              <h3 className="s-tile__title">{integration.name}</h3>
              <p className="b-secondary">{integration.what}</p>
              <Badge tone="niebla" icon="clock">
                {integration.phase}
              </Badge>
            </article>
          ))}
        </div>
        <p className="b-muted s-small s-more">{TRADEMARK_NOTE}</p>
      </Section>

      <Section title="Tus credenciales">
        <div className="s-callout">
          <Icon name="lock" />
          <p>
            buoh nunca pedirá la contraseña de tu cuenta Deriv: la futura conexión será por
            autorización delegada (OAuth), revocable cuando quieras. MetaTrader 5 no ofrece ese tipo
            de autorización; por eso, para MT5 solo se usarán cuentas propias del dueño del proyecto
            y su contraseña la guardará únicamente la terminal MT5. Los servicios de buoh nunca la
            recibirán.
          </p>
        </div>
      </Section>
    </>
  );
}
