import type { Metadata } from 'next';
import { TRADEMARK_NOTE } from '../../src/content';
import { PageIntro, Section } from '../../src/Frame';

export const metadata: Metadata = { title: 'Aviso de riesgo' };

export default function AvisoDeRiesgoPage() {
  return (
    <>
      <PageIntro
        eyebrow="Aviso de riesgo"
        title="Antes de seguir, lee esto"
        summary="Operar en los mercados puede hacerte perder dinero. buoh existe para medir ese riesgo con honestidad, no para eliminarlo."
      />

      <Section title="Riesgo de pérdida">
        <div className="s-prose">
          <p>
            Operar opciones y CFD implica un riesgo alto de perder dinero. En una opción puedes
            perder todo lo que pagas por cada contrato. Los CFD usan apalancamiento: una variación
            pequeña del precio puede producir una pérdida grande y rápida.
          </p>
          <p>
            Los índices sintéticos se generan con un algoritmo y pueden moverse con fuerza en poco
            tiempo, a cualquier hora.
          </p>
          <p>
            Ningún resultado pasado asegura resultados futuros, y tampoco los de una prueba
            histórica (backtest), de un bot en modo shadow o de una cuenta de práctica (demo). Una
            estrategia que funcionó puede dejar de funcionar.
          </p>
          <p>Si operas, hazlo solo con dinero que puedas permitirte perder.</p>
        </div>
      </Section>

      <Section title="Qué es y qué no es buoh">
        <div className="s-prose">
          <p>
            buoh es un proyecto en desarrollo, por ahora de uso propio. No ofrece señales, cuentas,
            ejecución ni suscripciones.
          </p>
          <p>
            Nada de este sitio es asesoramiento financiero, de inversión, legal ni fiscal, ni una
            recomendación de comprar o vender.
          </p>
          <p>buoh no recibe depósitos, no hace retiros y no custodia dinero de nadie.</p>
          <p>
            La disponibilidad de los productos de cada bróker depende de tu país y de sus
            condiciones. Antes de ofrecer señales o ejecución a otras personas, buoh pasará por una
            evaluación legal y de cumplimiento.
          </p>
        </div>
      </Section>

      <Section title="Marcas y datos de terceros">
        <div className="s-prose">
          <p>{TRADEMARK_NOTE}</p>
          <p>
            Los datos de mercado pertenecen a sus fuentes. buoh no los redistribuye: en esta etapa
            los usa solo para validación interna.
          </p>
        </div>
      </Section>

      <Section title="Este sitio">
        <div className="s-prose">
          <p>
            No tiene formularios, no usa cookies y no carga recursos de terceros: las tipografías se
            sirven desde el propio sitio. buoh no recoge datos personales.
          </p>
          <p>
            Lo aloja Render, que lo entrega a través de la red de Cloudflare. Como en cualquier
            sitio web, esos servidores reciben la dirección IP de cada visita para poder entregar
            las páginas. buoh no recibe esos datos.
          </p>
        </div>
      </Section>
    </>
  );
}
