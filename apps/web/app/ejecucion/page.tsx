import { Card, ModeBadge, PhaseLock } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';

export const metadata: Metadata = { title: 'Ejecución' };

const STEPS = [
  ['Intención', 'La estrategia aprobada propone una operación; todavía no es una orden.'],
  [
    'Política de riesgo',
    'Se comprueban límites, modo, calidad de datos, vencimiento y kill switch.',
  ],
  [
    'Pasarela',
    'Solo execution-gateway, en el servidor, decide enviar una orden. Se registra antes de enviarla.',
  ],
  [
    'Envío al bróker',
    'La pasarela envía a Deriv. En MetaTrader 5, el puente ejecuta la intención aprobada en el servidor del bróker (Deriv MT5 o Vantage).',
  ],
  [
    'Reconciliación',
    'Se compara con el estado del bróker. Si la respuesta es ambigua, no se reintenta a ciegas.',
  ],
] as const;

export default function EjecucionPage() {
  return (
    <>
      <PageHeader
        eyebrow="Ejecución"
        title="¿Qué pidió la pasarela y qué respondió el bróker?"
        summary="Esta sección mostrará intenciones, órdenes y su reconciliación. Ninguna pantalla envía órdenes: solo las ve."
      />

      <PhaseLock
        phase="4"
        title="Ejecución en modo demo"
        description="Primero con dinero de práctica en Deriv y en el puente MT5. El modo real solo llega en la Fase 6, después de aprobarse en la Fase 5."
      />

      <Card
        title="Cómo viajará una orden"
        subtitle="Vista previa sin datos ni controles"
        headingLevel={2}
      >
        <ol className="w-flow" aria-label="Pasos de una orden">
          {STEPS.map(([title, text]) => (
            <li key={title} className="w-flow__step">
              <strong>{title}</strong>
              {text}
            </li>
          ))}
        </ol>
      </Card>

      <div className="w-grid w-grid--3">
        <Card title="Modo demo" subtitle="Fase 4">
          <ModeBadge mode="demo" showDescription />
        </Card>
        <Card title="Modo real" subtitle="Fase 6">
          <ModeBadge mode="real" showDescription />
        </Card>
        <Card title="Lo que nunca hará un cliente" subtitle="Web, móvil o escritorio">
          <p className="b-secondary w-small">
            Enviar una orden, guardar credenciales del bróker o saltarse la política de riesgo.
          </p>
        </Card>
      </div>
    </>
  );
}
