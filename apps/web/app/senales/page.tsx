import { Badge, Card, ModeBadge, PhaseLock } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { SectionTitle, SignalCard } from '../../src/components/Pieces';
import { SIGNALS } from '@buoh/prototype-data';

/**
 * Señales (concepto de interfaz §3). Cada tarjeta enlaza a su evidencia en /laboratorio por un
 * ancla (`evidenceHref`); si cambia el id de la sección, el enlace se rompe.
 */
export const metadata: Metadata = { title: 'Señales' };

export default function SenalesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Señales"
        title="¿Qué propuso el bot y con qué evidencia?"
        summary="Cada señal dice qué estrategia y versión la emitió, cuándo vence, en qué modo está y con qué calidad de datos. Una señal no es una orden."
      />

      <div className="w-row" role="group" aria-label="Filtros de ejemplo">
        <span className="b-muted w-small">Mostrando:</span>
        <ModeBadge mode="shadow" showDescription />
        <Badge tone="niebla" icon="clock">
          Últimos 5 minutos
        </Badge>
        <Badge tone="niebla" icon="chart">
          R_75 y R_100
        </Badge>
      </div>

      <SectionTitle>Señales recientes</SectionTitle>
      <div className="w-grid w-grid--3">
        {SIGNALS.map((signal) => (
          <SignalCard key={signal.id} signal={signal} />
        ))}
      </div>

      <SectionTitle>Más adelante</SectionTitle>
      <div className="w-grid w-grid--2">
        <Card title="Alertas en el móvil" subtitle="Avisos de señales y de salud">
          <p className="b-secondary w-small">
            Llegan en la Fase 3, sin urgencia artificial ni contadores.
          </p>
        </Card>
        <PhaseLock
          phase="3B"
          title="Señales para suscriptores"
          description="Accesos, historial de entrega y restricciones por mercado. No se venden señales antes de cumplir sus puertas."
        />
      </div>
    </>
  );
}
