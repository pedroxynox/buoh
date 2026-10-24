import { Badge, Card, HealthBadge, Icon, PhaseLock } from '@buoh/design-system/react';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { SOURCES } from '../../src/fixtures';
import { formatUtc } from '../../src/format';

export const metadata: Metadata = { title: 'Conexiones' };

export default function ConexionesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Conexiones"
        title="¿Están conectadas mis fuentes?"
        summary="Estado de cada fuente y de cada puente. buoh no guarda contraseñas: las de MetaTrader 5 se quedan dentro de su terminal."
      />

      <div className="w-grid w-grid--3">
        {SOURCES.map((source) => (
          <Card
            key={source.id}
            title={source.name}
            subtitle={source.kind}
            actions={
              source.phase === '1' ? undefined : <Badge tone="niebla">Fase {source.phase}</Badge>
            }
            headingLevel={2}
          >
            <div className="w-stack">
              <HealthBadge health={source.health} showDescription />
              <p className="b-secondary w-small">{source.note}</p>
              <p className="b-muted w-small">
                Último dato: <span className="b-num">{formatUtc(source.lastDataUtc)}</span>
              </p>
              {source.phase === '1' ? (
                <p className="w-row b-muted w-small">
                  <Icon name="check" /> Canal público, sin cuenta ni contraseña.
                </p>
              ) : (
                <p className="w-row b-muted w-small">
                  <Icon name="lock" /> Contraseña de inversor (solo lectura), guardada solo en la
                  terminal MT5.
                </p>
              )}
            </div>
          </Card>
        ))}
      </div>

      <PhaseLock
        phase="4"
        title="Autorizaciones de cuenta"
        description="Conectar una cuenta Deriv por OAuth en modo demo, revisar su alcance y revocarla. En MT5, el sustituto lo fijará su propia ADR."
      />
    </>
  );
}
